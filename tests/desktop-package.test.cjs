"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function main() {
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
  for (const source of [register, unregister, installer]) {
    assert.doesNotMatch(
      source,
      /HKLM:|Enterprise|Chrome\\Policies|Secure Preferences|User Data/i,
    );
  }

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-package-"),
  );
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
      productVersion: "0.18.0",
      protocolVersion: 1,
      capabilities: ["desktop-shell", "local-file-attach", "native-bridge"],
    });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(stage, "package-manifest.json"), "utf8"),
    );
    assert.equal(manifest.productVersion, "0.18.0");
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
    ]) {
      assert.equal(
        relativeFiles.some((file) => forbidden.test(file)),
        false,
        `forbidden staged file matched ${forbidden}`,
      );
    }
    assert.match(build.stdout, /MANIFEST_SHA256=[A-F0-9]{64}/);
    console.log(`PASS: staged desktop package ${stage}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
