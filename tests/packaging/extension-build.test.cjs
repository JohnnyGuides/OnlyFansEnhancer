"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../..");
const builder = path.join(root, "tools/build-extensions.mjs");

test("fresh keyed identity is deterministic and legacy runtime stays keyless at its original output path", async () => {
  const { extensionEntries } = await import("../../tools/build-extensions.mjs");
  const { createHash } = require("node:crypto");
  const legacy = extensionEntries("personal");
  const keyed = extensionEntries("personal-keyed");
  const manifest = JSON.parse(
    keyed.find((entry) => entry.name === "manifest.json").bytes,
  );
  const identity = JSON.parse(
    fs.readFileSync(
      path.join(root, "packaging/personal-identity.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.key, identity.key);
  const id = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode(97 + parseInt(digit, 16)),
    );
  assert.equal(id, identity.extensionId);
  for (const entry of legacy) {
    const newEntry = keyed.find((candidate) => candidate.name === entry.name);
    if (entry.name === "manifest.json") {
      assert.equal(JSON.parse(entry.bytes).key, undefined);
      const withoutKey = { ...manifest };
      delete withoutKey.key;
      assert.deepEqual(withoutKey, JSON.parse(entry.bytes));
    } else assert.deepEqual(newEntry.bytes, entry.bytes, entry.name);
  }
  assert.match(
    fs.readFileSync(
      path.join(root, "desktop/OFEnhancer.Desktop/ChromeIntegration.cs"),
      "utf8",
    ),
    new RegExp(identity.extensionId),
  );
});

function build(edition, output) {
  const result = spawnSync(
    process.execPath,
    [builder, edition, "--output-root", output],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const packageLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("PACKAGE="));
  assert.ok(packageLine, "Build must report its verified archive.");
  return packageLine.slice("PACKAGE=".length);
}

for (const edition of ["personal", "store"]) {
  test(`${edition} is composed from canonical source and builds reproducibly`, () => {
    assert.ok(
      fs.existsSync(builder),
      "A cross-platform canonical extension builder is required.",
    );
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ofenhancer-build-"));
    try {
      const first = build(edition, output);
      const bytes = fs.readFileSync(first);
      assert.equal(
        fs.readFileSync(build(edition, output)).equals(bytes),
        true,
        "Equal source must produce equal ZIP bytes.",
      );
      const staged = path.join(output, "extensions", edition);
      for (const name of ["core.js", "content.js", "content.css"]) {
        assert.deepEqual(
          fs.readFileSync(path.join(staged, name)),
          fs.readFileSync(path.join(root, "shared/identity-mask", name)),
        );
      }
      const manifest = JSON.parse(
        fs.readFileSync(path.join(staged, "manifest.json"), "utf8"),
      );
      assert.deepEqual(manifest.content_scripts[0].js, [
        "identity-settings.js",
        "core.js",
        "content.js",
      ]);
      const defaults = fs.readFileSync(
        path.join(staged, "identity-settings.js"),
        "utf8",
      );
      assert.match(
        defaults,
        edition === "store" ? /enabled:\s*false/ : /enabled:\s*true/,
      );
      assert.equal(
        fs.existsSync(path.join(staged, "workflows")),
        edition === "personal",
      );
      assert.equal(fs.existsSync(path.join(staged, "apps-script")), false);
      if (edition === "store") {
        assert.deepEqual(manifest.permissions, ["storage"]);
        assert.deepEqual(manifest.host_permissions, ["https://onlyfans.com/*"]);
        assert.deepEqual(
          fs.readFileSync(path.join(staged, "privacy.html")),
          fs.readFileSync(path.join(root, "docs/privacy.html")),
        );
      }
      const inventory = spawnSync(
        process.execPath,
        [builder, edition, "--list"],
        { encoding: "utf8" },
      );
      assert.equal(inventory.status, 0, inventory.stderr);
      assert.ok(inventory.stdout.split(/\r?\n/).includes("manifest.json"));
      assert.doesNotMatch(
        inventory.stdout,
        /(?:^|\/)(?:node_modules|tests|\.local|\.git)(?:\/|$)|\.gs$/m,
      );
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });
}

test("build output cannot replace source or traverse a symbolic-link ancestor", async () => {
  const { buildExtension } = await import("../../tools/build-extensions.mjs");
  assert.throws(() => buildExtension("personal", root), /canonical source/);
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-output-safety-"),
  );
  try {
    const actual = path.join(output, "actual");
    fs.mkdirSync(actual);
    const link = path.join(output, "linked");
    fs.symlinkSync(
      actual,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => buildExtension("personal", path.join(link, "child")),
      /symbolic-link/,
    );
    assert.deepEqual(
      fs.readdirSync(actual),
      [],
      "an unsafe output must not create files before validation",
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("ZIP writer rejects duplicate and unsafe paths and emits a known CRC", async () => {
  const { createZip, crc32 } = await import("../../tools/lib/zip.mjs");
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  for (const name of [
    "../escape",
    "/absolute",
    "a/../../escape",
    "a\\b",
    "C:/data",
    "a//b",
  ]) {
    assert.throws(
      () => createZip([{ name, bytes: Buffer.from("fixture") }]),
      /Unsafe archive path/,
    );
  }
  assert.throws(
    () =>
      createZip([
        { name: "same", bytes: Buffer.alloc(0) },
        { name: "same", bytes: Buffer.alloc(0) },
      ]),
    /Duplicate/,
  );
  assert.throws(
    () => createZip([{ name: "file", bytes: "not a buffer" }]),
    /Buffer/,
  );
});

test("extension cleanup preserves other product families and unrelated output", async () => {
  const { buildExtension } = await import("../../tools/build-extensions.mjs");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "ofenhancer-cleanup-"));
  try {
    const stale = "creator-workflow-toolkit-personal-v0.1.0.zip";
    const protectedNames = [
      "fan-identity-mask-store-v0.1.0.zip",
      "creator-workflow-toolkit-personal-vlatest.zip",
      "notes.txt",
    ];
    for (const name of [stale, ...protectedNames]) {
      fs.writeFileSync(path.join(output, name), `fixture:${name}`);
    }
    const result = buildExtension("personal", output);
    assert.equal(fs.existsSync(result.packagePath), true);
    assert.equal(fs.existsSync(path.join(output, stale)), false);
    for (const name of protectedNames) {
      assert.equal(
        fs.readFileSync(path.join(output, name), "utf8"),
        `fixture:${name}`,
      );
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("unexpected release objects prevent cleanup of any existing release", async () => {
  const { buildExtension } = await import("../../tools/build-extensions.mjs");
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-cleanup-safety-"),
  );
  try {
    const stale = path.join(output, "fan-identity-mask-store-v0.1.0.zip");
    const unexpected = path.join(output, "fan-identity-mask-store-v0.2.0.zip");
    fs.writeFileSync(stale, "existing release");
    fs.mkdirSync(unexpected);
    fs.writeFileSync(path.join(unexpected, "unrelated.txt"), "preserve");
    assert.throws(
      () => buildExtension("store", output),
      /unexpected release artifact/,
    );
    assert.equal(fs.readFileSync(stale, "utf8"), "existing release");
    assert.equal(
      fs.readFileSync(path.join(unexpected, "unrelated.txt"), "utf8"),
      "preserve",
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
