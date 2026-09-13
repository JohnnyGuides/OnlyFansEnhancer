const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = require("../../support/paths.cjs").repositoryRoot;
const cleanupScript = path.join(
  root,
  "tools",
  "remove-stale-release-output.ps1",
);

function runCleanup(outputRoot, family, currentVersion) {
  const result = spawnSync(
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
  if (result.error) throw result.error;
  return result;
}

function createFile(outputRoot, name) {
  fs.writeFileSync(path.join(outputRoot, name), name);
}

function createDirectory(outputRoot, name) {
  const directory = path.join(outputRoot, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "proof.txt"), name);
}

test("failed desktop publish preserves the last current deliverable", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofe-failed-publish-"),
  );
  createDirectory(temporary, "ofenhancer-desktop-v0.20.9");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = `function dotnet { $global:LASTEXITCODE = 1 }; & ${quote(path.join(root, "tools/build-desktop-package.ps1"))} -StageOnly -OutputRoot ${quote(temporary)} -PersonalProfilePath ${quote(path.join(temporary, "absent-profile.json"))}`;
  try {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /desktop publish failed/);
    assert.equal(
      fs.readFileSync(
        path.join(temporary, "ofenhancer-desktop-v0.20.9/proof.txt"),
        "utf8",
      ),
      "ofenhancer-desktop-v0.20.9",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("cleanup rejects a linked current release before deleting any stale release", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofe-linked-current-"),
  );
  const output = path.join(temporary, "output");
  const foreign = path.join(temporary, "foreign");
  fs.mkdirSync(output);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "keep.txt"), "foreign");
  createDirectory(output, "ofenhancer-desktop-v0.20.3");
  const link = path.join(output, "ofenhancer-desktop-v0.20.9");
  fs.symlinkSync(foreign, link, "junction");
  try {
    const result = runCleanup(output, "DesktopStage", "0.20.9");
    assert.notEqual(result.status, 0);
    assert.ok(
      fs.existsSync(path.join(output, "ofenhancer-desktop-v0.20.3/proof.txt")),
    );
    assert.equal(
      fs.readFileSync(path.join(foreign, "keep.txt"), "utf8"),
      "foreign",
    );
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("release cleanup removes only older artifacts from the selected family", () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-release-cleanup-"),
  );
  try {
    const fixtures = [
      {
        family: "DesktopStage",
        version: "0.20.9",
        current: ["ofenhancer-desktop-v0.20.9"],
        stale: ["ofenhancer-desktop-v0.20.3"],
        directories: true,
      },
      {
        family: "DesktopInstaller",
        version: "0.20.9",
        current: ["OFEnhancer-Setup-0.20.9.exe"],
        stale: ["OFEnhancer-Setup-0.20.3.exe"],
      },
      {
        family: "TeaserHost",
        version: "0.20.9",
        current: [
          "x-teaser-native-host-v0.20.9",
          "x-teaser-native-host-v0.20.9.zip",
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
