"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
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
  configuredClientId,
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
    "app",
    "apps-script",
    "creator-tools",
    "desktop/OFEnhancer.Catalogue",
    "desktop/OFEnhancer.Desktop",
    "desktop/OFEnhancer.Protocol",
    "installer",
    "native-host/OFEnhancerNativeBridge",
    "scripts",
    "store",
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
  const register = fs.readFileSync(
    path.join(root, "scripts", "register-native-host.ps1"),
    "utf8",
  );
  const unregister = fs.readFileSync(
    path.join(root, "scripts", "unregister-native-host.ps1"),
    "utf8",
  );
  const installer = fs.readFileSync(
    path.join(root, "installer", "OFEnhancer.iss"),
    "utf8",
  );
  assert.match(register, /\^\[a-p\]\{32\}\$/);
  assert.match(
    register,
    /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/,
  );
  assert.match(register, /chrome-extension:\/\/\$ExtensionId\//);
  assert.match(unregister, /StartsWith\(\$rootPrefix/);
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /Update or reinstall/);
  assert.match(installer, /Uninstall/);
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
    const configuredLocalAppData = path.join(
      temporary,
      "configured-local-app-data",
    );
    const configuredData = path.join(configuredLocalAppData, "OFEnhancer");
    fs.mkdirSync(path.join(configuredData, "data", "Fixtures"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(configuredData, "settings.json"),
      JSON.stringify({ googleOAuthClientId: configuredClientId }),
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
      OFENHANCER_DATA_FOLDER: path.join(configuredData, "data"),
    };
    const build = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/build-desktop-package.ps1",
        "-OutputRoot",
        temporary,
        "-StageOnly",
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
    const stageLine = build.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("STAGE="));
    assert.ok(stageLine, build.stdout);
    const stage = stageLine.slice("STAGE=".length);
    const personalVersion = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    ).version;
    const storeVersion = JSON.parse(
      fs.readFileSync(path.join(root, "store", "manifest.json"), "utf8"),
    ).version;
    const personalArchive = path.join(
      root,
      "dist",
      `creator-workflow-toolkit-personal-v${personalVersion}.zip`,
    );
    const storeBuild = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/build-store-package.ps1",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: buildEnvironment,
        timeout: 60000,
        windowsHide: true,
      },
    );
    assert.equal(storeBuild.status, 0, storeBuild.stdout + storeBuild.stderr);
    const storeArchive = path.join(
      root,
      "dist",
      `fan-identity-mask-store-v${storeVersion}.zip`,
    );
    const personalOutput = path.join(temporary, "personal-output");
    const storeOutput = path.join(temporary, "store-output");
    expandArchive(personalArchive, personalOutput);
    expandArchive(storeArchive, storeOutput);

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
      path.join(stage, "package-manifest.json"),
      path.join(stage, "desktop", "Microsoft.Data.Sqlite.dll"),
    ]) {
      assert.equal(
        fs.existsSync(required),
        true,
        `missing staged file: ${required}`,
      );
    }

    const status = spawnSync(desktopExe, ["--status-json"], {
      cwd: path.dirname(desktopExe),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), {
      productVersion: "0.20.0",
      protocolVersion: 1,
      capabilities: ["desktop-shell", "local-file-attach", "native-bridge"],
    });

    desktopProcess = spawn(desktopExe, ["--extension-id", "a".repeat(32)], {
      cwd: path.dirname(desktopExe),
      env: {
        ...buildEnvironment,
        OFENHANCER_WEBVIEW2_USER_DATA_FOLDER: path.join(
          temporary,
          "webview-profile",
        ),
        OFENHANCER_DATA_FOLDER: path.join(temporary, "catalogue-data"),
      },
      windowsHide: true,
      stdio: "ignore",
    });
    await delay(2000);
    assert.equal(
      desktopProcess.exitCode,
      null,
      "the staged desktop shell crashed on launch",
    );
    const secondInstance = spawn(
      desktopExe,
      ["--extension-id", "a".repeat(32)],
      {
        cwd: path.dirname(desktopExe),
        env: {
          ...buildEnvironment,
          OFENHANCER_WEBVIEW2_USER_DATA_FOLDER: path.join(
            temporary,
            "webview-profile",
          ),
          OFENHANCER_DATA_FOLDER: path.join(temporary, "catalogue-data"),
        },
        windowsHide: true,
        stdio: "ignore",
      },
    );
    await Promise.race([
      new Promise((resolve) => secondInstance.once("exit", resolve)),
      delay(3000),
    ]);
    assert.notEqual(
      secondInstance.exitCode,
      null,
      "a second desktop authority remained running",
    );
    assert.equal(
      desktopProcess.exitCode,
      null,
      "the first desktop authority stopped unexpectedly",
    );
    assert.equal(
      fs.existsSync(path.join(temporary, "catalogue-data", "catalogue.db")),
      true,
      "the isolated desktop catalogue was not created",
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

    const manifest = JSON.parse(
      fs.readFileSync(path.join(stage, "package-manifest.json"), "utf8"),
    );
    assert.equal(manifest.productVersion, "0.20.0");
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
