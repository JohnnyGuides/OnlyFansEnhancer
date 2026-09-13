"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = require("../support/paths.cjs").repositoryRoot;
const exe = path.join(
  root,
  "native-host/OFEnhancerNativeBridge/bin/Release/net8.0-windows/OFEnhancerNativeBridge.exe",
);
const origin = `chrome-extension://${"a".repeat(32)}/`;
test("Chrome Windows invocation accepts handles and clean EOF", () => {
  for (const args of [
    [],
    [origin],
    [origin, "--parent-window=0"],
    [origin, "--parent-window=4294967296"],
  ]) {
    const result = spawnSync(exe, args, {
      input: Buffer.alloc(0),
      windowsHide: true,
      timeout: 5000,
    });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout.length, 0);
  }
});
test("native invocation rejects malformed authority and flags with framed errors", () => {
  for (const args of [
    [origin, "--parent-window=-1"],
    [origin, "--parent-window=18446744073709551616"],
    [origin, "--parent-window=+1"],
    [origin, "--parent-window=1", "--parent-window=2"],
    [origin, "--other=0"],
    ["chrome-extension://evil/"],
    ["--parent-window=0"],
  ]) {
    const result = spawnSync(exe, args, {
      input: Buffer.alloc(0),
      windowsHide: true,
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
    assert.equal(
      JSON.parse(result.stdout.subarray(4)).error.code,
      "invalid-request",
    );
    assert.equal(result.stderr.length, 0);
  }
});

test("realistic framed relay preserves correlation for repeated requests and EOF", () => {
  const requests = Array.from({ length: 3 }, () => ({
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    operation: "getStatus",
  }));
  const frames = requests.map((request) => {
    const bytes = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    return Buffer.concat([header, bytes]);
  });
  const result = spawnSync(exe, [origin, "--parent-window=0"], {
    input: Buffer.concat(frames),
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(result.status, 0);
  let offset = 0;
  for (const request of requests) {
    const size = result.stdout.readUInt32LE(offset);
    offset += 4;
    const reply = JSON.parse(result.stdout.subarray(offset, offset + size));
    offset += size;
    assert.equal(reply.requestId, request.requestId);
    assert.ok(reply.ok || reply.error.code === "desktop-unavailable");
  }
  assert.equal(offset, result.stdout.length);
  assert.equal(result.stderr.length, 0);
  const truncated = spawnSync(exe, [origin, "--parent-window=0"], {
    input: Buffer.from([4, 0]),
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(truncated.status, 2);
  assert.equal(
    JSON.parse(truncated.stdout.subarray(4)).error.code,
    "incomplete-frame",
  );
});
