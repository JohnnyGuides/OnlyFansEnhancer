const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const cleanupScript = path.join(
  root,
  "scripts",
  "remove-stale-release-output.ps1",
);

function runCleanup(outputRoot, family, currentVersion) {
  return spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      cleanupScript,
      "-OutputRoot",
      outputRoot,
      "-Family",
      family,
      "-CurrentVersion",
      currentVersion,
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

function createFile(outputRoot, name) {
  fs.writeFileSync(path.join(outputRoot, name), name);
}

function createDirectory(outputRoot, name) {
  const directory = path.join(outputRoot, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "proof.txt"), name);
}

test("release cleanup removes only older artifacts from the selected family", () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-release-cleanup-"),
  );
  try {
    const fixtures = [
      {
        family: "PersonalExtension",
        version: "0.20.4",
        current: ["creator-workflow-toolkit-personal-v0.20.4.zip"],
        stale: ["creator-workflow-toolkit-personal-v0.20.3.zip"],
      },
      {
        family: "StoreExtension",
        version: "0.7.0",
        current: ["fan-identity-mask-store-v0.7.0.zip"],
        stale: ["fan-identity-mask-store-v0.6.0.zip"],
      },
      {
        family: "DesktopStage",
        version: "0.20.4",
        current: ["ofenhancer-desktop-v0.20.4"],
        stale: ["ofenhancer-desktop-v0.20.3"],
        directories: true,
      },
      {
        family: "DesktopInstaller",
        version: "0.20.4",
        current: ["OFEnhancer-Setup-0.20.4.exe"],
        stale: ["OFEnhancer-Setup-0.20.3.exe"],
      },
      {
        family: "TeaserHost",
        version: "0.20.4",
        current: [
          "x-teaser-native-host-v0.20.4",
          "x-teaser-native-host-v0.20.4.zip",
        ],
        stale: [
          "x-teaser-native-host-v0.20.3",
          "x-teaser-native-host-v0.20.3.zip",
        ],
        mixed: true,
      },
    ];

    for (const fixture of fixtures) {
      for (const name of [...fixture.current, ...fixture.stale]) {
        if (
          fixture.directories ||
          (fixture.mixed && !name.toLowerCase().endsWith(".zip"))
        ) {
          createDirectory(outputRoot, name);
        } else {
          createFile(outputRoot, name);
        }
      }
    }
    createFile(outputRoot, "creator-workflow-toolkit-personal-vlatest.zip");
    createFile(outputRoot, "notes.txt");

    for (const fixture of fixtures) {
      const result = runCleanup(outputRoot, fixture.family, fixture.version);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const name of fixture.current) {
        assert.equal(fs.existsSync(path.join(outputRoot, name)), true, name);
      }
      for (const name of fixture.stale) {
        assert.equal(fs.existsSync(path.join(outputRoot, name)), false, name);
      }
    }

    assert.equal(
      fs.existsSync(
        path.join(outputRoot, "creator-workflow-toolkit-personal-vlatest.zip"),
      ),
      true,
    );
    assert.equal(fs.existsSync(path.join(outputRoot, "notes.txt")), true);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("release cleanup rejects invalid versions before deleting anything", () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-release-cleanup-invalid-"),
  );
  try {
    const stale = "OFEnhancer-Setup-0.20.3.exe";
    createFile(outputRoot, stale);

    const result = runCleanup(outputRoot, "DesktopInstaller", "latest");

    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(outputRoot, stale)), true);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
