"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = require("../../support/paths.cjs").repositoryRoot;
const registrationScript = path.join(root, "tools", "register-native-host.ps1");
const extensionId = "a".repeat(32);
const previousExtensionId = "b".repeat(32);
const googleOAuthClientId =
  "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
const secondGoogleOAuthClientId =
  "987654321098-zyxwvutsrqponmlkjihgfedcba654321.apps.googleusercontent.com";

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
  googleOAuthClientId: configuredGoogleOAuthClientId,
  registryProbe,
  settingsCommitFailure,
}) {
  const settingsCommit =
    settingsCommitFailure === undefined
      ? { declaration: "", argument: "" }
      : {
          declaration: `
$settingsCommit = {
  param([string]$Source, [string]$Destination, [bool]$DestinationExists)
  if (${settingsCommitFailure === "after" ? "$true" : "$false"}) {
    if ($DestinationExists) {
      [System.IO.File]::Replace(
        $Source,
        $Destination,
        [System.Management.Automation.Language.NullString]::Value
      )
    } else {
      [System.IO.File]::Move($Source, $Destination)
    }
  }
  throw "injected settings commit failure"
}
`,
          argument: " -SettingsCommit $settingsCommit",
        };
  const command = `
$writer = {
  param([string]$Path, [string]$Value)
  [System.IO.File]::WriteAllText(
    ${powershellQuote(registryProbe)},
    ($Path + [Environment]::NewLine + $Value),
    [System.Text.UTF8Encoding]::new($false)
  )
}
${settingsCommit.declaration}
& ${powershellQuote(registrationScript)} -InstallRoot ${powershellQuote(installRoot)} -ExtensionId ${powershellQuote(extensionId)}${configuredGoogleOAuthClientId === undefined ? "" : ` -GoogleOAuthClientId ${powershellQuote(configuredGoogleOAuthClientId)}`} -RegistryReader { @() } -RegistryWriter $writer${settingsCommit.argument}
`;
  const environment = { ...process.env, LOCALAPPDATA: localAppData };
  delete environment.OFENHANCER_DATA_ROOT;
  if (dataRoot !== undefined) environment.OFENHANCER_DATA_ROOT = dataRoot;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

test("package test never resolves or enumerates the real user data root", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "desktop-package.test.cjs"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /dotNetLocalApplicationData|directoryMetadata|LocalApplicationData|Environment\+SpecialFolder|GetFolderPath|realUserRoot/,
  );
});

test("registration creates extension-only settings when no settings exist", () => {
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

test("registration seeds the personalized Google OAuth client ID", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    const installRoot = createInstallRoot(temporary);
    const explicitRoot = path.join(temporary, "explicit", "OFEnhancer");
    const registryProbe = path.join(temporary, "registry-probe.txt");

    const result = runRegistration({
      installRoot,
      localAppData: path.join(temporary, "default-local-app-data"),
      dataRoot: explicitRoot,
      googleOAuthClientId,
      registryProbe,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(explicitRoot, "settings.json"), "utf8"),
      ),
      { extensionId, googleOAuthClientId },
    );
    assert.equal(fs.existsSync(registryProbe), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("registration preserves an existing valid Google OAuth client ID", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    const installRoot = createInstallRoot(temporary);
    const explicitRoot = path.join(temporary, "explicit", "OFEnhancer");
    const settingsPath = path.join(explicitRoot, "settings.json");
    const registryProbe = path.join(temporary, "registry-probe.txt");
    fs.mkdirSync(explicitRoot, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        extensionId: previousExtensionId,
        googleOAuthClientId,
      }),
    );

    const result = runRegistration({
      installRoot,
      localAppData: path.join(temporary, "default-local-app-data"),
      dataRoot: explicitRoot,
      googleOAuthClientId: secondGoogleOAuthClientId,
      registryProbe,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
      extensionId,
      googleOAuthClientId,
    });
    assert.equal(fs.existsSync(registryProbe), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("registration preserves every supported browser preference and existing Google client", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-browser-register-"),
  );
  try {
    for (const [index, browserId] of [
      "system",
      "chrome",
      "edge",
      "firefox",
      "brave",
      "opera",
      "vivaldi",
      "  ChRoMe  ",
      null,
      undefined,
    ].entries()) {
      const caseRoot = path.join(temporary, `case-${index}`);
      const installRoot = createInstallRoot(caseRoot);
      const dataRoot = path.join(caseRoot, "data");
      const settingsPath = path.join(dataRoot, "settings.json");
      const registryProbe = path.join(caseRoot, "registry.txt");
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          extensionId: previousExtensionId,
          googleOAuthClientId,
          browserId,
          googleSheetUrl:
            "https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=2126708696",
        }),
      );
      const result = runRegistration({
        installRoot,
        localAppData: path.join(caseRoot, "local"),
        dataRoot,
        googleOAuthClientId: secondGoogleOAuthClientId,
        registryProbe,
      });
      assert.equal(
        result.status,
        0,
        `browser ${browserId}: ${result.stdout}${result.stderr}`,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
        extensionId,
        googleOAuthClientId,
        googleSheetUrl:
          "https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=2126708696",
        ...(browserId == null
          ? {}
          : { browserId: browserId.trim().toLowerCase() }),
      });
      assert.equal(fs.existsSync(registryProbe), true);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("registration rejects malformed or unknown settings before mutation", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    const invalidSettings = [
      "not-json",
      JSON.stringify({
        extensionId: previousExtensionId,
        googleOAuthClientId,
        unknown: true,
      }),
      "[]",
      JSON.stringify({ googleOAuthClientId: "invalid" }),
      JSON.stringify({ googleSheetUrl: "https://example.com/not-a-sheet" }),
      ...[
        "safari",
        "",
        "   ",
        "chrome.exe",
        "chrome --argument",
        42,
        true,
        {},
        [],
      ].map((browserId) =>
        JSON.stringify({
          extensionId: previousExtensionId,
          googleOAuthClientId,
          browserId,
        }),
      ),
      `${JSON.stringify({ googleOAuthClientId })}${" ".repeat(64 * 1024)}`,
    ];

    for (const [index, originalSettings] of invalidSettings.entries()) {
      const caseRoot = path.join(temporary, `case-${index}`);
      const installRoot = createInstallRoot(caseRoot);
      const explicitRoot = path.join(caseRoot, "explicit", "OFEnhancer");
      const settingsPath = path.join(explicitRoot, "settings.json");
      const registryProbe = path.join(caseRoot, "registry-probe.txt");
      const nativeManifest = path.join(
        installRoot,
        "native",
        "com.johnnyguides.ofenhancer.json",
      );
      fs.mkdirSync(explicitRoot, { recursive: true });
      fs.writeFileSync(settingsPath, originalSettings);

      const result = runRegistration({
        installRoot,
        localAppData: path.join(caseRoot, "default-local-app-data"),
        dataRoot: explicitRoot,
        registryProbe,
      });

      assert.notEqual(result.status, 0, `case ${index}`);
      assert.match(result.stdout + result.stderr, /settings/i);
      assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
      assert.equal(fs.existsSync(nativeManifest), false);
      assert.equal(fs.existsSync(registryProbe), false);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("failed atomic settings commit leaves valid old or new settings including browser preference", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-register-"),
  );
  try {
    for (const settingsCommitFailure of ["before", "after"]) {
      const caseRoot = path.join(temporary, settingsCommitFailure);
      const installRoot = createInstallRoot(caseRoot);
      const explicitRoot = path.join(caseRoot, "explicit", "OFEnhancer");
      const settingsPath = path.join(explicitRoot, "settings.json");
      const registryProbe = path.join(caseRoot, "registry-probe.txt");
      const nativeManifest = path.join(
        installRoot,
        "native",
        "com.johnnyguides.ofenhancer.json",
      );
      fs.mkdirSync(explicitRoot, { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          extensionId: previousExtensionId,
          googleOAuthClientId,
          browserId: "firefox",
        }),
      );

      const result = runRegistration({
        installRoot,
        localAppData: path.join(caseRoot, "default-local-app-data"),
        dataRoot: explicitRoot,
        registryProbe,
        settingsCommitFailure,
      });

      assert.notEqual(result.status, 0, settingsCommitFailure);
      assert.match(result.stdout + result.stderr, /settings/i);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
        extensionId:
          settingsCommitFailure === "before"
            ? previousExtensionId
            : extensionId,
        googleOAuthClientId,
        browserId: "firefox",
      });
      assert.deepEqual(
        fs.readdirSync(explicitRoot).filter((entry) => entry.endsWith(".tmp")),
        [],
      );
      assert.equal(fs.existsSync(nativeManifest), false);
      assert.equal(fs.existsSync(registryProbe), false);
    }
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
