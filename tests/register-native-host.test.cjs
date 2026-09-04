"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const registrationScript = path.join(
  root,
  "scripts",
  "register-native-host.ps1",
);
const extensionId = "a".repeat(32);

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createInstallRoot(parent) {
  const installRoot = path.join(parent, "install");
  const nativeDirectory = path.join(installRoot, "native");
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(nativeDirectory, "OFEnhancerNativeBridge.exe"),
    "fixture",
  );
  return installRoot;
}

function runRegistration({
  installRoot,
  localAppData,
  dataRoot,
  registryProbe,
}) {
  const command = `
$writer = {
  param([string]$Path, [string]$Value)
  [System.IO.File]::WriteAllText(
    ${powershellQuote(registryProbe)},
    ($Path + [Environment]::NewLine + $Value),
    [System.Text.UTF8Encoding]::new($false)
  )
}
& ${powershellQuote(registrationScript)} -InstallRoot ${powershellQuote(installRoot)} -ExtensionId ${powershellQuote(extensionId)} -RegistryWriter $writer
`;
  const environment = { ...process.env, LOCALAPPDATA: localAppData };
  delete environment.OFENHANCER_DATA_ROOT;
  if (dataRoot !== undefined) environment.OFENHANCER_DATA_ROOT = dataRoot;
  return spawnSync("powershell", ["-NoProfile", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout: 30000,
    windowsHide: true,
  });
}

test("package test never resolves or enumerates the real user data root", () => {
  const source = fs.readFileSync(
    path.join(root, "tests", "desktop-package.test.cjs"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /dotNetLocalApplicationData|directoryMetadata|LocalApplicationData|Environment\+SpecialFolder|GetFolderPath|realUserRoot/,
  );
});

test("registration writes settings under the explicit bounded data root", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    const installRoot = createInstallRoot(temporary);
    const explicitRoot = path.join(temporary, "explicit", "OFEnhancer");
    const fakeLocalAppData = path.join(temporary, "default-local-app-data");
    const registryProbe = path.join(temporary, "registry-probe.txt");

    const result = runRegistration({
      installRoot,
      localAppData: fakeLocalAppData,
      dataRoot: explicitRoot,
      registryProbe,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(explicitRoot, "settings.json"), "utf8"),
      ),
      { extensionId },
    );
    assert.equal(
      fs.existsSync(path.join(fakeLocalAppData, "OFEnhancer")),
      false,
    );
    assert.equal(fs.existsSync(registryProbe), true);
    assert.match(result.stdout, /REGISTERED=com\.johnnyguides\.ofenhancer/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("registration keeps the existing local app-data default", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    const installRoot = createInstallRoot(temporary);
    const fakeLocalAppData = path.join(temporary, "default-local-app-data");
    const registryProbe = path.join(temporary, "registry-probe.txt");

    const result = runRegistration({
      installRoot,
      localAppData: fakeLocalAppData,
      registryProbe,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(fakeLocalAppData, "OFEnhancer", "settings.json"),
          "utf8",
        ),
      ),
      { extensionId },
    );
    assert.equal(fs.existsSync(registryProbe), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("invalid explicit data roots fail before any file or registry write", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    const existingFile = path.join(temporary, "not-a-directory");
    fs.writeFileSync(existingFile, "fixture");
    const invalidRoots = [
      "relative-data-root",
      "   ",
      existingFile,
      path.parse(temporary).root,
      path.join(temporary, "x".repeat(1100)),
    ];

    for (const [index, dataRoot] of invalidRoots.entries()) {
      const caseRoot = path.join(temporary, `case-${index}`);
      const installRoot = createInstallRoot(caseRoot);
      const fakeLocalAppData = path.join(caseRoot, "default-local-app-data");
      const registryProbe = path.join(caseRoot, "registry-probe.txt");
      const nativeManifest = path.join(
        installRoot,
        "native",
        "com.johnnyguides.ofenhancer.json",
      );

      const result = runRegistration({
        installRoot,
        localAppData: fakeLocalAppData,
        dataRoot,
        registryProbe,
      });

      assert.notEqual(result.status, 0, dataRoot);
      assert.match(result.stdout + result.stderr, /OFENHANCER_DATA_ROOT/);
      assert.equal(fs.existsSync(nativeManifest), false, dataRoot);
      assert.equal(fs.existsSync(registryProbe), false, dataRoot);
      assert.equal(
        fs.existsSync(path.join(fakeLocalAppData, "OFEnhancer")),
        false,
        dataRoot,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
