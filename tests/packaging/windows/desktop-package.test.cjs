"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("../../support/browser.cjs");

const root = require("../../support/paths.cjs").repositoryRoot;
const formerPersonalWorkbookId = [
  "1Ninkxbv1SOvatcJ3AP4z",
  "wKWxdc32imlIkP_IMUSTR9E",
].join("");
const configuredClientId = [
  "123456789012-",
  "packagefixture1234567890.apps.googleusercontent.com",
].join("");
const fakeAccessToken = ["ya29.", "package_access_token_fixture_123456"].join(
  "",
);
const fakeRefreshToken = ["1//", "package_refresh_token_fixture_123456"].join(
  "",
);
const fakeClientSecret = ["GOCSPX-", "package_client_secret_fixture"].join("");
const sensitiveValues = [
  formerPersonalWorkbookId,
  fakeAccessToken,
  fakeRefreshToken,
  fakeClientSecret,
];
const credentialValuePatterns = [
  /\bya29\.[A-Za-z0-9_-]{16,}\b/,
  /\b1\/\/[A-Za-z0-9_-]{16,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/,
  /["'](?:access_token|refresh_token|client_secret)["']\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
];
const textFilePattern =
  /\.(?:config|cs|csproj|css|gs|html|iss|js|json|md|ps1|props|targets|txt|xml)$/i;

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(fullPath) : [fullPath];
  });
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function expandArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${powershellQuote(archivePath)} -DestinationPath ${powershellQuote(destination)} -Force`,
    ],
    { encoding: "utf8", timeout: 60000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function assertNoSensitiveContent(label, filePaths) {
  for (const filePath of filePaths) {
    const bytes = fs.readFileSync(filePath);
    for (const value of sensitiveValues) {
      assert.equal(
        bytes.includes(Buffer.from(value, "utf8")) ||
          bytes.includes(Buffer.from(value, "utf16le")),
        false,
        `${label} contains a configured or private value in ${filePath}`,
      );
    }
    if (!textFilePattern.test(filePath)) continue;
    const text = bytes.toString("utf8");
    for (const pattern of credentialValuePatterns) {
      assert.doesNotMatch(
        text,
        pattern,
        `${label} contains a credential value matching ${pattern} in ${filePath}`,
      );
    }
  }
}

function assertNoPrivateFiles(label, directory) {
  const relativeFiles = filesBelow(directory).map((filePath) =>
    path.relative(directory, filePath).replaceAll("\\", "/"),
  );
  for (const pattern of [
    /(^|\/)tests?(\/|$)/i,
    /(^|\/)fixtures?(\/|$)|google-workbook-(?:legacy|ambiguous)\.json$/i,
    /(^|\/)settings\.json$/i,
    /(^|\/)[^/]*(?:access|refresh)?[-_.]?token[^/]*$/i,
    /(^|\/)[^/]*client[-_.]?secret[^/]*$/i,
    /\.(?:db|sqlite)$/i,
    /\.(?:db|sqlite)(?:\.|-)?backup/i,
    /backup-v\d+/i,
  ]) {
    assert.equal(
      relativeFiles.some((file) => pattern.test(file)),
      false,
      `${label} contains a forbidden file matching ${pattern}`,
    );
  }
}

function shippedSourceFiles() {
  const roots = [
    "shared",
    "integrations",
    "extensions/personal",
    "desktop/OFEnhancer.Catalogue",
    "desktop/OFEnhancer.Desktop",
    "desktop/OFEnhancer.Protocol",
    "packaging/windows",
    "native-host/OFEnhancerNativeBridge",
    "tools",
    "extensions/store",
  ];
  const files = roots.flatMap((relativePath) =>
    filesBelow(path.join(root, ...relativePath.split("/"))),
  );
  return files.filter(
    (filePath) =>
      !/[\\/](?:bin|obj)[\\/]/i.test(filePath) &&
      textFilePattern.test(filePath),
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const legacyBridgeSetup = fs.readFileSync(
    path.join(root, "docs/google-catalogue.md"),
    "utf8",
  );
  assert.match(legacyBridgeSetup, /`CREATOR_UPLOAD_SECRET`/);
  assert.match(legacyBridgeSetup, /`CREATOR_UPLOAD_SPREADSHEET_ID`/);
  assert.match(legacyBridgeSetup, /target catalogue/i);
  assert.match(legacyBridgeSetup, /deploy it as a web app/i);

  const register = fs.readFileSync(
    path.join(root, "tools", "register-native-host.ps1"),
    "utf8",
  );
  const unregister = fs.readFileSync(
    path.join(root, "tools", "unregister-native-host.ps1"),
    "utf8",
  );
  const installer = fs.readFileSync(
    path.join(root, "packaging/windows", "OFEnhancer.iss"),
    "utf8",
  );
  assert.match(register, /\^\[a-p\]\{32\}\$/);
  assert.match(
    register,
    /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/,
  );
  assert.match(register, /chrome-extension:\/\/\$ExtensionId\//);
  assert.match(unregister, /GetFullPath\(\$target\)\.Equals\(\$manifest/);
  assert.match(unregister, /Registry32/);
  assert.match(unregister, /Registry64/);
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(
    installer,
    /^CloseApplications=force$/m,
    "updates must close legacy desktop builds that predate cooperative Restart Manager handling",
  );
  assert.match(installer, /Update or reinstall/);
  assert.match(installer, /Uninstall/);
  assert.match(
    installer,
    /Fresh reinstall - remove extension and all OFEnhancer desktop state/,
  );
  assert.match(installer, /CurStep = ssPostInstall\) and IsFreshReset\(\)/);
  assert.match(
    installer,
    /--fresh-reinstall-installed.*ewWaitUntilTerminated/s,
  );
  assert.match(
    installer,
    /function PrepareToInstall[\s\S]*--fresh-reinstall-remove[\s\S]*ExistingUninstaller[\s\S]*--fresh-reinstall-clean/,
  );
  assert.match(
    installer,
    /ofenhancer-maintenance.*dontcopy noencryption recursesubdirs/i,
  );
  assert.doesNotMatch(installer, /--mark-chrome-reset/);
  assert.match(installer, /SelectedValueIndex <> 2/);
  assert.doesNotMatch(
    installer.slice(
      installer.indexOf("[Run]"),
      installer.indexOf("[UninstallRun]"),
    ),
    /register-native-host|CreateSubKey|NativeMessagingHosts/,
    "The installer may mark an explicit reset, but cannot implicitly register Chrome or edit its profile",
  );
  assert.match(
    installer,
    /Keep settings, catalogue, and history/,
    "uninstall must default to preserving user data",
  );
  assert.match(
    installer,
    /Exec\(\s*'>'\s*,\s*ExistingUninstaller \+ ' \/SILENT \/NORESTART'/s,
    "Setup must execute the registered uninstall command without reparsing it",
  );
  assert.match(
    installer,
    /\[UninstallDelete\][\s\S]*Name:\s*"\{localappdata\}\\OFEnhancer";\s*Check:\s*ShouldDeleteUserData/,
    "direct uninstall must target only the dedicated user-data directory",
  );
  assert.match(
    installer,
    /UninstallSilent[\s\S]*Keep my data \(recommended\)[\s\S]*Remove my data[\s\S]*TaskDialogMsgBox/,
    "interactive uninstall must offer a native keep-or-remove choice",
  );
  assert.match(
    installer,
    /Connect Chrome.*OFEnhancer\.Desktop\.exe.*--chrome-setup/,
  );
  const guideLauncher = fs.readFileSync(
    path.join(root, "tools/open-chrome-guide.ps1"),
    "utf8",
  );
  assert.match(
    guideLauncher,
    /Start-Process -FilePath \$desktop.*--chrome-setup/,
  );
  assert.doesNotMatch(
    guideLauncher,
    /chrome\.exe/,
    "Start-menu and guide entry points must use the desktop's common setup controller",
  );
  assert.doesNotMatch(
    installer,
    /Filename:\s*"\{app\}\\extension-(?:reload|setup)\.html";.*postinstall/i,
    "the installer must not delegate either Chrome guide to the Windows file association",
  );
  assert.match(
    installer,
    /Root:\s*HKCU;\s*Subkey:\s*"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/,
  );
  assert.match(installer, /ValueName:\s*"OFEnhancer".*uninsdeletevalue/);
  for (const source of [register, unregister, installer]) {
    assert.doesNotMatch(
      source,
      /HKLM:|Enterprise|Chrome\\Policies|Secure Preferences|User Data/i,
    );
  }

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-package-"),
  );
  let desktopProcess;
  try {
    const configuredLocalAppData = path.join(temporary, "fake-local-app-data");
    const configuredData = path.join(temporary, "explicit-data-root");
    const seededSettings = JSON.stringify({
      extensionId: "a".repeat(32),
      googleOAuthClientId: configuredClientId,
    });
    fs.mkdirSync(path.join(configuredData, "data", "Fixtures"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(configuredData, "settings.json"),
      seededSettings,
    );
    fs.writeFileSync(
      path.join(configuredData, "data", "google-oauth-token.dat"),
      `${fakeAccessToken}\n${fakeRefreshToken}\n${fakeClientSecret}`,
    );
    fs.writeFileSync(path.join(configuredData, "data", "catalogue.db"), "db");
    fs.writeFileSync(
      path.join(configuredData, "data", "catalogue.db.backup-v2"),
      "backup",
    );
    fs.writeFileSync(
      path.join(
        configuredData,
        "data",
        "Fixtures",
        "google-workbook-legacy.json",
      ),
      "{}",
    );
    const buildEnvironment = {
      ...process.env,
      LOCALAPPDATA: configuredLocalAppData,
      OFENHANCER_DATA_ROOT: configuredData,
    };
    delete buildEnvironment.OFENHANCER_DATA_FOLDER;
    const invalidProfileBuild = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "tools/build-desktop-package.ps1",
        "-OutputRoot",
        path.join(temporary, "invalid-profile"),
        "-StageOnly",
        "-ExtensionId",
        "q".repeat(32),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: buildEnvironment,
        timeout: 30000,
        windowsHide: true,
      },
    );
    assert.notEqual(invalidProfileBuild.status, 0);
    assert.match(
      invalidProfileBuild.stdout + invalidProfileBuild.stderr,
      /32 letters from a to p/i,
    );

    const invalidGoogleBuild = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "tools/build-desktop-package.ps1",
        "-OutputRoot",
        path.join(temporary, "invalid-google-profile"),
        "-StageOnly",
        "-ExtensionId",
        "a".repeat(32),
        "-GoogleOAuthClientId",
        "not-a-client-id",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: buildEnvironment,
        timeout: 30000,
        windowsHide: true,
      },
    );
    assert.notEqual(invalidGoogleBuild.status, 0);
    assert.match(
      invalidGoogleBuild.stdout + invalidGoogleBuild.stderr,
      /Google OAuth client ID is invalid/i,
    );

    const invalidProfileTypePath = path.join(
      temporary,
      "invalid-profile-type.json",
    );
    fs.writeFileSync(
      invalidProfileTypePath,
      JSON.stringify({ extensionId: ["a".repeat(32)] }),
    );
    const invalidProfileTypeBuild = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "tools/build-desktop-package.ps1",
        "-OutputRoot",
        path.join(temporary, "invalid-profile-type"),
        "-StageOnly",
        "-PersonalProfilePath",
        invalidProfileTypePath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: buildEnvironment,
        timeout: 30000,
        windowsHide: true,
      },
    );
    assert.notEqual(invalidProfileTypeBuild.status, 0);
    assert.match(
      invalidProfileTypeBuild.stdout + invalidProfileTypeBuild.stderr,
      /extensionId must be a string/i,
    );

    const staleDesktopStage = path.join(temporary, "ofenhancer-desktop-v0.0.1");
    fs.mkdirSync(staleDesktopStage);
    fs.writeFileSync(path.join(staleDesktopStage, "stale.txt"), "stale");
    const stalePersonalArchive = path.join(
      temporary,
      "creator-workflow-toolkit-personal-v0.0.1.zip",
    );
    fs.writeFileSync(stalePersonalArchive, "stale");

    const personalProfilePath = path.join(temporary, "personal-profile.json");
    fs.writeFileSync(
      personalProfilePath,
      JSON.stringify({
        extensionId: "a".repeat(32),
        googleOAuthClientId: configuredClientId,
      }),
    );

    const build = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "tools/build-desktop-package.ps1",
        "-OutputRoot",
        temporary,
        "-StageOnly",
        "-PersonalProfilePath",
        personalProfilePath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: buildEnvironment,
        timeout: 240000,
        windowsHide: true,
      },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    assert.match(build.stdout, /INSTALL_PROFILE=personal/);
    assert.match(build.stdout, /GOOGLE_PROFILE=configured/);
    assert.equal(fs.existsSync(staleDesktopStage), false);
    assert.equal(fs.existsSync(stalePersonalArchive), false);
    const stageLine = build.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("STAGE="));
    assert.ok(stageLine, build.stdout);
    const stage = stageLine.slice("STAGE=".length);
    const personalVersion = JSON.parse(
      fs.readFileSync(
        path.join(root, "extensions/personal/manifest.json"),
        "utf8",
      ),
    ).version;
    const storeVersion = JSON.parse(
      fs.readFileSync(
        path.join(root, "extensions/store/manifest.json"),
        "utf8",
      ),
    ).version;
    const personalArchive = path.join(
      temporary,
      `creator-workflow-toolkit-personal-v${personalVersion}.zip`,
    );
    const staleStoreArchive = path.join(
      temporary,
      "fan-identity-mask-store-v0.0.1.zip",
    );
    fs.writeFileSync(staleStoreArchive, "stale");
    const storeBuild = spawnSync(
      process.execPath,
      ["tools/build-extensions.mjs", "store", "--output-root", temporary],
      {
        cwd: root,
        encoding: "utf8",
        env: buildEnvironment,
        timeout: 60000,
        windowsHide: true,
      },
    );
    assert.equal(storeBuild.status, 0, storeBuild.stdout + storeBuild.stderr);
    assert.equal(fs.existsSync(staleStoreArchive), false);
    const storeArchive = path.join(
      temporary,
      `fan-identity-mask-store-v${storeVersion}.zip`,
    );
    const personalOutput = path.join(temporary, "personal-output");
    const storeOutput = path.join(temporary, "store-output");
    expandArchive(personalArchive, personalOutput);
    expandArchive(storeArchive, storeOutput);

    sensitiveValues.push(configuredData, configuredData.replaceAll("\\", "/"));

    assertNoSensitiveContent("shipped source", shippedSourceFiles());
    assertNoSensitiveContent("personal package", filesBelow(personalOutput));
    assertNoPrivateFiles("personal package", personalOutput);
    assertNoSensitiveContent("store package", filesBelow(storeOutput));
    assertNoPrivateFiles("store package", storeOutput);
    assertNoSensitiveContent("staged package", filesBelow(stage));
    assertNoPrivateFiles("staged package", stage);
    assertNoSensitiveContent(
      "desktop output",
      filesBelow(path.join(stage, "desktop")),
    );
    assertNoPrivateFiles("desktop output", path.join(stage, "desktop"));
    const desktopExe = path.join(stage, "desktop", "OFEnhancer.Desktop.exe");
    const bridgeExe = path.join(stage, "native", "OFEnhancerNativeBridge.exe");
    for (const required of [
      desktopExe,
      bridgeExe,
      path.join(stage, "extension", "manifest.json"),
      path.join(stage, "extension", "app", "index.html"),
      path.join(stage, "extension", "app", "finalLogo.png"),
      path.join(stage, "assets", "finalLogo.png"),
      path.join(stage, "native", "ofenhancer-native-host.json.template"),
      path.join(stage, "extension-setup.html"),
      path.join(stage, "extension-reload.html"),
      path.join(stage, "fresh-reinstall.html"),
      path.join(stage, "fresh-verifier", "manifest.json"),
      path.join(stage, "fresh-verifier", "background.js"),
      path.join(stage, "package-manifest.json"),
      path.join(stage, "desktop", "Microsoft.Data.Sqlite.dll"),
    ]) {
      assert.equal(
        fs.existsSync(required),
        true,
        `missing staged file: ${required}`,
      );
    }

    const reloadGuide = fs.readFileSync(
      path.join(stage, "extension-reload.html"),
      "utf8",
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(reloadGuide);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            async writeText(value) {
              globalThis.__copiedChromeUrl = value;
            },
          },
        });
      });
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 800, height: 700 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        assert.equal(
          await page
            .getByRole("heading", {
              name: "Update your Chrome extension",
            })
            .isVisible(),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth),
          viewport.width,
        );
      }
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      assert.equal(
        await page.evaluate(() => globalThis.__copiedChromeUrl),
        "chrome://extensions",
      );
      assert.match(await page.getByRole("status").innerText(), /Copied/i);
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            async writeText(value) {
              globalThis.__copiedChromeUrl = value;
            },
          },
        }),
      );
      const folder = path.join(stage, "extension-keyed");
      await page.goto(
        require("node:url").pathToFileURL(
          path.join(stage, "extension-setup.html"),
        ).href +
          "#folder=" +
          encodeURIComponent(folder),
      );
      assert.equal(
        await page.locator("#extension-folder").textContent(),
        folder,
      );
      assert.deepEqual(await page.locator("ol li h2").allTextContents(), [
        "Open Chrome extensions",
        "Turn on Developer mode",
        "Click Load unpacked",
        "Select the OFEnhancer extension folder",
        "Check connection",
      ]);
      await page.locator("#copy-address").click();
      assert.equal(
        await page.evaluate(() => globalThis.__copiedChromeUrl),
        "chrome://extensions",
      );
      await page.locator("#copy-folder").click();
      assert.equal(
        await page.evaluate(() => globalThis.__copiedChromeUrl),
        folder,
      );
      assert.equal(await page.locator("details[open]").count(), 0);
      assert.equal(
        await page.locator('a[href="ofenhancer://chrome-setup"]').count(),
        1,
      );
      for (const width of [1280, 800, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        if (process.env.OFENHANCER_REVIEW_DIR)
          await page.screenshot({
            path: path.join(
              process.env.OFENHANCER_REVIEW_DIR,
              "chrome-setup-" + width + ".png",
            ),
            fullPage: true,
          });
      }
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            async writeText() {
              throw new Error("clipboard-unavailable");
            },
          },
        }),
      );
      await page.locator("#copy-address").click();
      assert.equal(
        await page.evaluate(() => getSelection().toString()),
        "chrome://extensions",
      );
      assert.match(await page.getByRole("status").textContent(), /Ctrl\+C/);
    } finally {
      await browser.close();
    }

    fs.rmSync(path.join(configuredData, "data"), {
      recursive: true,
      force: true,
    });
    const status = spawnSync(desktopExe, ["--status-json"], {
      cwd: path.dirname(desktopExe),
      encoding: "utf8",
      env: buildEnvironment,
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), {
      productVersion: "0.20.27",
      protocolVersion: 1,
      capabilities: ["desktop-shell", "local-file-attach", "native-bridge"],
    });

    desktopProcess = spawn(desktopExe, [], {
      cwd: path.dirname(desktopExe),
      env: {
        ...buildEnvironment,
        OFENHANCER_WEBVIEW2_USER_DATA_FOLDER: path.join(
          temporary,
          "webview-profile",
        ),
      },
      windowsHide: true,
      stdio: "ignore",
    });
    await delay(2000);
    if (desktopProcess.exitCode === 0) {
      desktopProcess = null;
      console.log(
        "SKIP: packaged GUI launch already has a live OFEnhancer authority",
      );
    } else {
      assert.equal(
        desktopProcess.exitCode,
        null,
        "the staged desktop shell crashed on launch",
      );
      const secondInstance = spawn(desktopExe, [], {
        cwd: path.dirname(desktopExe),
        env: {
          ...buildEnvironment,
          OFENHANCER_WEBVIEW2_USER_DATA_FOLDER: path.join(
            temporary,
            "webview-profile",
          ),
        },
        windowsHide: true,
        stdio: "ignore",
      });
      await Promise.race([
        new Promise((resolve) => secondInstance.once("exit", resolve)),
        delay(3000),
      ]);
      assert.equal(
        secondInstance.exitCode,
        0,
        "a second desktop authority did not exit cleanly",
      );
      assert.equal(
        desktopProcess.exitCode,
        null,
        "the first desktop authority stopped unexpectedly",
      );
      assert.equal(
        fs.existsSync(path.join(configuredData, "data", "catalogue.db")),
        true,
        "the isolated desktop catalogue was not created",
      );
      assert.equal(
        fs.readFileSync(path.join(configuredData, "settings.json"), "utf8"),
        seededSettings,
        "the staged desktop did not preserve settings at its explicit data root",
      );
      assert.equal(
        fs.existsSync(path.join(configuredLocalAppData, "OFEnhancer")),
        false,
        "the staged desktop used the fake default local app-data root",
      );

      const closeWindow = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${desktopProcess.pid}).CloseMainWindow()`,
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true },
      );
      assert.equal(
        closeWindow.status,
        0,
        closeWindow.stdout + closeWindow.stderr,
      );
      assert.match(
        closeWindow.stdout,
        /True/i,
        "the desktop window did not accept a close request",
      );
      await delay(500);
      assert.equal(
        desktopProcess.exitCode,
        null,
        "closing the window stopped the tray authority",
      );
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(stage, "package-manifest.json"), "utf8"),
    );
    assert.equal(manifest.productVersion, "0.20.27");
    assert.equal(manifest.files.length > 10, true);
    for (const entry of manifest.files) {
      const filePath = path.join(stage, ...entry.path.split("/"));
      assert.equal(fs.existsSync(filePath), true, entry.path);
      assert.equal(sha256(filePath), entry.sha256.toLowerCase(), entry.path);
    }

    const relativeFiles = filesBelow(stage).map((filePath) =>
      path.relative(stage, filePath).replaceAll("\\", "/"),
    );
    for (const forbidden of [
      /(^|\/)\.git(\/|$)/i,
      /(^|\/)tests?(\/|$)/i,
      /(^|\/)(?:fixtures?|private)(\/|$)|creator-upload-trace.*\.json$/i,
      /node_modules/i,
      /\.env/i,
      /settings\.json$/i,
      /token|secret/i,
      /media.*selfmade|\.thumbs/i,
      /(?:^|\/)(?:catalogue|ofenhancer)[^/]*\.(?:db|sqlite)(?:$|[.-])/i,
      /backup-v\d+/i,
    ]) {
      assert.equal(
        relativeFiles.some((file) => forbidden.test(file)),
        false,
        `forbidden staged file matched ${forbidden}`,
      );
    }
    const stagedText = filesBelow(stage)
      .filter((filePath) =>
        /\.(?:css|gs|html|js|json|md|ps1|txt)$/i.test(filePath),
      )
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    assert.equal(
      stagedText.includes(formerPersonalWorkbookId),
      false,
      "the staged package exposes the former personal workbook ID",
    );
    const creatorThumbnailRoot =
      "D:\\MEDIA - SELFMADE\\Youtube2\\.DONE_DEEDS\\.thumbs";
    for (const filePath of filesBelow(stage)) {
      const bytes = fs.readFileSync(filePath);
      assert.equal(
        bytes.includes(Buffer.from(creatorThumbnailRoot, "utf8")) ||
          bytes.includes(Buffer.from(creatorThumbnailRoot, "utf16le")),
        false,
        `the staged package embeds the creator thumbnail root in ${path.relative(stage, filePath)}`,
      );
    }
    assert.equal(
      relativeFiles.some((file) => /(?:^|\/)e_sqlite3\.dll$/i.test(file)),
      true,
      "the staged desktop package is missing the SQLite native runtime",
    );
    assert.match(build.stdout, /MANIFEST_SHA256=[A-F0-9]{64}/);
    console.log(`PASS: staged desktop package ${stage}`);
  } finally {
    if (desktopProcess?.exitCode === null) {
      spawnSync("taskkill", ["/pid", String(desktopProcess.pid), "/t", "/f"], {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });
      await Promise.race([
        new Promise((resolve) => desktopProcess.once("exit", resolve)),
        delay(3000),
      ]);
    }
    fs.rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
