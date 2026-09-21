"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = require("../support/paths.cjs").repositoryRoot;
const desktopExe = path.join(
  root,
  "desktop",
  "OFEnhancer.Desktop",
  "bin",
  "Release",
  "net8.0-windows",
  "OFEnhancer.Desktop.exe",
);
const bridgeExe = path.join(
  root,
  "native-host",
  "OFEnhancerNativeBridge",
  "bin",
  "Release",
  "net8.0-windows",
  "OFEnhancerNativeBridge.exe",
);

function runBridge(pipeName, requestPath) {
  return spawnSync(bridgeExe, ["--request", pipeName, requestPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function parseFrame(value) {
  assert.ok(value.length >= 4, "native response frame is incomplete");
  const length = value.readUInt32LE(0);
  assert.equal(
    value.length,
    length + 4,
    "native response frame has the wrong length",
  );
  return JSON.parse(value.subarray(4).toString("utf8"));
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

async function main() {
  const build = spawnSync(
    "dotnet",
    ["build", "desktop/OFEnhancer.sln", "-c", "Release"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
    },
  );
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.equal(
    fs.existsSync(desktopExe),
    true,
    "desktop executable is missing",
  );
  assert.equal(
    fs.existsSync(bridgeExe),
    true,
    "native bridge executable is missing",
  );

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-bridge-"),
  );
  let desktop;
  let nativeDesktop;
  try {
    const request = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      operation: "getStatus",
    };
    const requestPath = path.join(temporary, "request.json");
    fs.writeFileSync(requestPath, JSON.stringify(request));
    const pipeName = `ofenhancer-integration-${crypto.randomUUID().replaceAll("-", "")}`;
    desktop = spawn(desktopExe, ["--agent-once", "--pipe-name", pipeName], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
    });

    let bridge;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      bridge = runBridge(pipeName, requestPath);
      if (bridge.status === 0) break;
      await delay(100);
    }
    assert.equal(bridge.status, 0, bridge.stdout + bridge.stderr);
    assert.deepEqual(JSON.parse(bridge.stdout), {
      ok: true,
      requestId: request.requestId,
      status: {
        productVersion: "0.20.35",
        protocolVersion: 1,
        capabilities: ["desktop-shell", "local-file-attach", "native-bridge"],
      },
    });
    assert.equal(await waitForExit(desktop), 0);
    desktop = null;

    nativeDesktop = spawn(desktopExe, ["--agent-once"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
    });
    let nativeBridge;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      nativeBridge = spawnSync(bridgeExe, [], {
        cwd: root,
        input: frame(request),
        timeout: 5000,
        windowsHide: true,
      });
      if (nativeBridge.status === 0) break;
      await delay(100);
    }
    assert.equal(nativeBridge.status, 0, nativeBridge.stderr?.toString("utf8"));
    const nativeResponse = parseFrame(nativeBridge.stdout);
    assert.deepEqual(
      {
        ok: nativeResponse.ok,
        requestId: nativeResponse.requestId,
        protocolVersion: nativeResponse.status?.protocolVersion,
        capabilities: nativeResponse.status?.capabilities,
      },
      {
        ok: true,
        requestId: request.requestId,
        protocolVersion: 1,
        capabilities: ["desktop-shell", "local-file-attach", "native-bridge"],
      },
    );
    const nativeDesktopExit = await waitForExit(nativeDesktop);
    if (nativeDesktopExit === 0) {
      assert.equal(nativeResponse.status.productVersion, "0.20.35");
    } else {
      assert.equal(
        nativeDesktopExit,
        1,
        "the disposable default-pipe agent failed unexpectedly",
      );
      assert.match(
        nativeResponse.status.productVersion,
        /^\d+\.\d+\.\d+$/,
        "the already-running desktop authority returned an invalid version",
      );
    }
    nativeDesktop = null;

    const absentPipe = `ofenhancer-absent-${crypto.randomUUID().replaceAll("-", "")}`;
    const unavailable = runBridge(absentPipe, requestPath);
    assert.notEqual(unavailable.status, 0);
    assert.equal(
      JSON.parse(unavailable.stdout).error.code,
      "desktop-unavailable",
    );
    assert.equal(
      `${unavailable.stdout}${unavailable.stderr}`.includes(requestPath),
      false,
    );
    assert.equal(
      `${unavailable.stdout}${unavailable.stderr}`.includes(
        JSON.stringify(request),
      ),
      false,
    );

    const malformedPath = path.join(
      temporary,
      "private-malformed-request.json",
    );
    const malformedText = '{"private":"do not echo"';
    fs.writeFileSync(malformedPath, malformedText);
    const malformed = runBridge(absentPipe, malformedPath);
    assert.notEqual(malformed.status, 0);
    assert.equal(JSON.parse(malformed.stdout).error.code, "invalid-request");
    assert.equal(
      `${malformed.stdout}${malformed.stderr}`.includes(malformedPath),
      false,
    );
    assert.equal(
      `${malformed.stdout}${malformed.stderr}`.includes(malformedText),
      false,
    );

    const unsupportedPath = path.join(temporary, "unsupported.json");
    const unsupportedText = JSON.stringify({
      ...request,
      requestId: "05a56db0-6510-4e8b-9173-5e6fb1cb197f",
      operation: "deleteEverything",
    });
    fs.writeFileSync(unsupportedPath, unsupportedText);
    const unsupported = runBridge(absentPipe, unsupportedPath);
    assert.notEqual(unsupported.status, 0);
    assert.equal(
      JSON.parse(unsupported.stdout).error.code,
      "unsupported-operation",
    );
    assert.equal(
      `${unsupported.stdout}${unsupported.stderr}`.includes(unsupportedText),
      false,
    );

    const webViewOnlyPath = path.join(temporary, "webview-only.json");
    const webViewOnlyText = JSON.stringify({
      ...request,
      requestId: "a028726b-2e7b-468f-90e3-4f512f0dc2be",
      operation: "getGoogleCatalogueStatus",
    });
    fs.writeFileSync(webViewOnlyPath, webViewOnlyText);
    const webViewOnly = runBridge(absentPipe, webViewOnlyPath);
    assert.notEqual(webViewOnly.status, 0);
    assert.equal(
      JSON.parse(webViewOnly.stdout).error.code,
      "unsupported-operation",
      "Google catalogue controls must stay on the desktop WebView boundary",
    );
    assert.equal(
      `${webViewOnly.stdout}${webViewOnly.stderr}`.includes(webViewOnlyText),
      false,
    );
  } finally {
    if (desktop?.exitCode === null) desktop.kill();
    if (nativeDesktop?.exitCode === null) nativeDesktop.kill();
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log(
    "PASS: the stateless native bridge relayed one bounded desktop status request",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
