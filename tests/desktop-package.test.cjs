"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

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
      { cwd: root, encoding: "utf8", timeout: 240000, windowsHide: true },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const stageLine = build.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("STAGE="));
    assert.ok(stageLine, build.stdout);
    const stage = stageLine.slice("STAGE=".length);
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
      productVersion: "0.19.0",
      protocolVersion: 1,
      capabilities: ["desktop-shell", "local-file-attach", "native-bridge"],
    });

    desktopProcess = spawn(desktopExe, ["--extension-id", "a".repeat(32)], {
      cwd: path.dirname(desktopExe),
      env: {
        ...process.env,
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
          ...process.env,
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
    assert.equal(manifest.productVersion, "0.19.0");
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
    const catalogueBridge = fs.readFileSync(
      path.join(root, "apps-script", "catalogue-bridge.gs"),
      "utf8",
    );
    const workbookId = catalogueBridge.match(
      /CREATOR_UPLOAD_SPREADSHEET_ID\s*=\s*"([^"]+)"/,
    )?.[1];
    assert.ok(workbookId, "the source workbook ID could not be identified");
    const stagedText = filesBelow(stage)
      .filter((filePath) =>
        /\.(?:css|gs|html|js|json|md|ps1|txt)$/i.test(filePath),
      )
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    assert.equal(
      stagedText.includes(workbookId),
      false,
      "the staged package exposes the configured workbook ID",
    );
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
