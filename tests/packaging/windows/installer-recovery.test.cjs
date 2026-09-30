"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const root = require("../../support/paths.cjs").repositoryRoot;
const version = require("../../../package.json").version;

// Execute the actual Pascal installer flow under an isolated AppId. Strip only
// external integration declarations, never maintenance code or wizard logic.
// No production registry key, shortcut, native host, or Chrome profile is used.
test(
  "compiled Setup recovers missing uninstaller, resumes copied package, and preserves an ordinary update",
  { timeout: 240_000 },
  (t) => {
    if (process.platform !== "win32")
      return t.skip("Windows installer integration");
    const stage = path.join(root, "dist", `ofenhancer-desktop-v${version}`);
    const compiler = [
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Programs"),
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles,
    ]
      .filter(Boolean)
      .map((base) => path.join(base, "Inno Setup 6", "ISCC.exe"))
      .find(fs.existsSync);
    if (!compiler || !fs.existsSync(path.join(stage, "package-manifest.json")))
      return t.skip(
        "Build the desktop package and install Inno Setup before this integration gate.",
      );
    const base = fs.mkdtempSync(
      path.join(root, ".local", "installer-recovery-"),
    );
    const install = path.join(base, "installed");
    const data = path.join(base, "data");
    const webview = path.join(base, "webview");
    const maintenance = path.join(base, "OFEnhancer-Maintenance");
    const transaction = path.join(maintenance, "fresh-reinstall.json");
    const appId = crypto.randomUUID().toUpperCase();
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${appId}}_is1`;
    // Setup resolves {localappdata} from USERPROFILE, which keeps the update
    // pause marker away from the running application's real one.
    const profile = path.join(base, "profile");
    const pauseData = path.join(
      profile,
      "AppData",
      "Local",
      "OFEnhancer",
      "data",
    );
    const realMarker = path.join(
      process.env.LOCALAPPDATA,
      "OFEnhancer",
      "data",
      "agent-paused",
    );
    const markerBefore = fs.existsSync(realMarker);
    fs.mkdirSync(profile);
    const env = {
      ...process.env,
      USERPROFILE: profile,
      OFENHANCER_DATA_ROOT: data,
      OFENHANCER_WEBVIEW2_USER_DATA_FOLDER: webview,
    };
    function run(executable, args, timeout = 120_000) {
      const result = spawnSync(executable, args, {
        cwd: base,
        env,
        encoding: "utf8",
        timeout,
        windowsHide: true,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(
        result.status,
        0,
        `${executable}: ${result.stdout}\n${result.stderr}\nEvidence: ${base}`,
      );
      return result.stdout;
    }
    function journal(phase, packageVersion = version) {
      fs.mkdirSync(maintenance, { recursive: true });
      fs.writeFileSync(
        transaction,
        JSON.stringify({
          Schema: 2,
          Generation: crypto.randomUUID(),
          StartedAt: Date.now(),
          PackageVersion: packageVersion,
          Phase: phase,
          InstallRoot: install,
          DataRoot: data,
          WebViewRoot: webview,
          DataRootExclusive: true,
          WebViewRootExclusive: true,
          ExtensionIds: ["aocoaajmhccmefmfebgiiogfdojciild"],
          Observations: [],
        }),
      );
    }
    const source = fs
      .readFileSync(path.join(root, "packaging/windows/OFEnhancer.iss"), "utf8")
      .replaceAll("D4702E08-310F-477A-91DA-DC45603DD6AF", appId)
      .replace(/^Compression=.*$/m, "Compression=none")
      .replace(/^SolidCompression=.*$/m, "SolidCompression=no")
      .replace(/\[(?:Icons|Registry|Run|UninstallRun)\][\s\S]*?(?=\[|$)/g, "");
    const script = path.join(base, "Fixture.iss");
    fs.writeFileSync(script, source);
    try {
      run(compiler, [`/DStageSource=${stage}`, `/DOutputRoot=${base}`, script]);
      const setup = path.join(base, `OFEnhancer-Setup-${version}.exe`);
      for (const dir of [install, data, webview])
        fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(
        path.join(stage, "package-manifest.json"),
        path.join(install, "package-manifest.json"),
      );
      fs.writeFileSync(path.join(install, "obsolete.txt"), "old");
      fs.writeFileSync(path.join(data, "old-data.txt"), "old");
      fs.writeFileSync(
        path.join(webview, ".ofenhancer-webview-owned.json"),
        JSON.stringify({ schema: 1, owner: "OFEnhancer" }),
      );
      run("reg.exe", [
        "add",
        key,
        "/v",
        "InstallLocation",
        "/t",
        "REG_SZ",
        "/d",
        install + "\\",
        "/f",
      ]);
      run("reg.exe", [
        "add",
        key,
        "/v",
        "UninstallString",
        "/t",
        "REG_SZ",
        "/d",
        `"${path.join(install, "unins000.exe")}"`,
        "/f",
      ]);
      journal("Preflight", "0.20.35");
      // Deliberately supply a different directory: durable recovery must use the
      // approved root even when the old Inno install-location discovery is lost.
      run(setup, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        `/DIR=${path.join(base, "wrong-root")}`,
        `/LOG=${path.join(base, "missing-uninstaller.log")}`,
      ]);
      assert.ok(fs.existsSync(path.join(install, "unins000.exe")));
      assert.ok(!fs.existsSync(path.join(install, "obsolete.txt")));
      assert.ok(!fs.existsSync(path.join(data, "old-data.txt")));
      assert.ok(!fs.existsSync(transaction));
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(maintenance, "chrome-reset.json")))
          .Pending,
        true,
      );
      assert.match(
        fs.readFileSync(path.join(base, "missing-uninstaller.log"), "utf8"),
        /Previous uninstaller is missing/,
      );
      const cleanupLog = fs.readFileSync(
        path.join(base, "missing-uninstaller.log"),
        "utf8",
      );
      const closeStep = cleanupLog.indexOf(
        "--fresh-reinstall-stop-applications: exit 0",
      );
      assert.ok(closeStep >= 0);
      assert.ok(
        closeStep < cleanupLog.indexOf("--fresh-reinstall-needs-uninstall:"),
      );
      assert.ok(closeStep < cleanupLog.indexOf("--fresh-reinstall-clean:"));

      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(
        path.join(data, "keep.txt"),
        "preserve data written after cleanup",
      );
      fs.writeFileSync(
        path.join(install, "keep.txt"),
        "preserve files written after cleanup",
      );
      journal("OwnedStatePurged", "0.20.35");
      run(setup, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        `/DIR=${install}`,
        `/LOG=${path.join(base, "resume-copied.log")}`,
      ]);
      assert.ok(!fs.existsSync(transaction));
      assert.ok(
        fs.existsSync(path.join(install, "keep.txt")),
        "resuming must not run the newly installed uninstaller or purge again",
      );
      assert.ok(fs.existsSync(path.join(data, "keep.txt")));
      assert.match(
        fs.readFileSync(path.join(base, "resume-copied.log"), "utf8"),
        /--fresh-reinstall-needs-uninstall: exit 1/,
      );

      run(setup, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        `/DIR=${install}`,
        `/LOG=${path.join(base, "update.log")}`,
      ]);
      assert.ok(
        fs.existsSync(path.join(data, "keep.txt")),
        "normal updates preserve data",
      );
      assert.ok(
        fs.existsSync(pauseData),
        "update paused under the test profile",
      );
      assert.ok(!fs.existsSync(path.join(pauseData, "agent-paused")));
      assert.equal(fs.existsSync(realMarker), markerBefore);
      assert.ok(!fs.existsSync(transaction));
      journal("Preflight");
      run(setup, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        `/DIR=${install}`,
        `/LOG=${path.join(base, "existing-uninstaller.log")}`,
      ]);
      assert.ok(!fs.existsSync(transaction));
      assert.ok(!fs.existsSync(path.join(install, "keep.txt")));
      assert.ok(!fs.existsSync(path.join(data, "keep.txt")));
      assert.ok(fs.existsSync(path.join(install, "unins000.exe")));
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, "keep.txt"), "keep on uninstall");
      run(path.join(install, "unins000.exe"), [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
      ]);
      assert.ok(
        fs.existsSync(path.join(data, "keep.txt")),
        "silent uninstall keeps data",
      );
      t.diagnostic(`Compiled installer evidence: ${base}`);
    } finally {
      // Only our random test AppId can be removed. Keep logs and fixture files
      // inside the repository for diagnosis rather than deleting broad roots.
      spawnSync("reg.exe", ["delete", key, "/f"], { windowsHide: true });
    }
  },
);

// A genuine first installation has no previous package to stop, guard or
// pause. Every other target keeps the manifest verification and fails closed.
test(
  "compiled Setup installs first into an absent or empty folder and fails closed on unverified targets",
  { timeout: 360_000 },
  (t) => {
    if (process.platform !== "win32")
      return t.skip("Windows installer integration");
    const stage = path.join(root, "dist", `ofenhancer-desktop-v${version}`);
    const compiler = [
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Programs"),
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles,
    ]
      .filter(Boolean)
      .map((base) => path.join(base, "Inno Setup 6", "ISCC.exe"))
      .find(fs.existsSync);
    if (!compiler || !fs.existsSync(path.join(stage, "package-manifest.json")))
      return t.skip(
        "Build the desktop package and install Inno Setup before this integration gate.",
      );
    const base = fs.mkdtempSync(path.join(root, ".local", "installer-first-"));
    const data = path.join(base, "data");
    const webview = path.join(base, "webview");
    const appId = crypto.randomUUID().toUpperCase();
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${appId}}_is1`;
    const realMarker = path.join(
      process.env.LOCALAPPDATA,
      "OFEnhancer",
      "data",
      "agent-paused",
    );
    const profile = path.join(base, "profile");
    const pauseData = path.join(
      profile,
      "AppData",
      "Local",
      "OFEnhancer",
      "data",
    );
    fs.mkdirSync(profile);
    const env = {
      ...process.env,
      USERPROFILE: profile,
      OFENHANCER_DATA_ROOT: data,
      OFENHANCER_WEBVIEW2_USER_DATA_FOLDER: webview,
    };
    function exec(executable, args) {
      const result = spawnSync(executable, args, {
        cwd: base,
        env,
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      assert.equal(result.error, undefined, result.error?.message);
      return result;
    }
    function run(executable, args) {
      const result = exec(executable, args);
      assert.equal(
        result.status,
        0,
        `${executable}: ${result.stdout}\n${result.stderr}\nEvidence: ${base}`,
      );
    }
    function listing(dir) {
      return fs
        .readdirSync(dir, { recursive: true })
        .sort()
        .map((name) => {
          const full = path.join(dir, name);
          return `${name}:${fs.statSync(full).isFile() ? fs.readFileSync(full, "utf8") : ""}`;
        });
    }
    function args(dir, log) {
      return [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        `/DIR=${dir}`,
        `/LOG=${path.join(base, log)}`,
      ];
    }
    const source = fs
      .readFileSync(path.join(root, "packaging/windows/OFEnhancer.iss"), "utf8")
      .replaceAll("D4702E08-310F-477A-91DA-DC45603DD6AF", appId)
      .replace(/^Compression=.*$/m, "Compression=none")
      .replace(/^SolidCompression=.*$/m, "SolidCompression=no")
      .replace(/\[(?:Icons|Registry|Run|UninstallRun)\][\s\S]*?(?=\[|$)/g, "");
    fs.writeFileSync(path.join(base, "Fixture.iss"), source);
    const markerBefore = fs.existsSync(realMarker);
    try {
      run(compiler, [
        `/DStageSource=${stage}`,
        `/DOutputRoot=${base}`,
        path.join(base, "Fixture.iss"),
      ]);
      const setup = path.join(base, `OFEnhancer-Setup-${version}.exe`);
      for (const dir of [data, webview]) fs.mkdirSync(dir, { recursive: true });

      for (const [name, prepare] of [
        ["absent", () => {}],
        ["empty", (dir) => fs.mkdirSync(dir, { recursive: true })],
      ]) {
        const dir = path.join(base, `first-${name}`);
        prepare(dir);
        run(setup, args(dir, `first-${name}.log`));
        assert.ok(
          fs.existsSync(path.join(dir, "package-manifest.json")),
          `${name}: first install must lay down the package`,
        );
        assert.equal(fs.existsSync(realMarker), markerBefore, name);
        const log = fs.readFileSync(
          path.join(base, `first-${name}.log`),
          "utf8",
        );
        assert.doesNotMatch(log, /--update-stop-applications|--update-guard/);
        run(path.join(dir, "unins000.exe"), [
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
        ]);
      }

      const foreign = path.join(base, "foreign");
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, "user-file.txt"), "not ours");
      const foreignBefore = listing(foreign);
      const refused = exec(setup, args(foreign, "foreign.log"));
      assert.notEqual(refused.status, 0, "non-empty unverified folder");
      assert.deepEqual(listing(foreign), foreignBefore);
      assert.equal(fs.existsSync(realMarker), markerBefore);
      assert.ok(
        fs.existsSync(pauseData),
        "update paused under the test profile",
      );
      assert.ok(!fs.existsSync(path.join(pauseData, "agent-paused")));

      // A folder that exists but cannot be listed is not known to be empty.
      const unlistable = path.join(base, "unlistable");
      fs.mkdirSync(unlistable);
      const deny = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
      run("icacls.exe", [unlistable, "/deny", `${deny}:(RD)`]);
      let unlisted;
      try {
        assert.throws(() => fs.readdirSync(unlistable), /EPERM|EACCES/);
        unlisted = exec(setup, args(unlistable, "unlistable.log"));
      } finally {
        spawnSync("icacls.exe", [unlistable, "/remove:d", deny], {
          windowsHide: true,
        });
      }
      assert.notEqual(unlisted.status, 0, "unlistable folder");
      assert.deepEqual(fs.readdirSync(unlistable), []);
      assert.equal(fs.existsSync(realMarker), markerBefore);

      const damaged = path.join(base, "damaged");
      fs.mkdirSync(damaged, { recursive: true });
      fs.writeFileSync(path.join(damaged, "package-manifest.json"), "{ nope");
      fs.writeFileSync(path.join(damaged, "app.txt"), "keep");
      for (const [name, value] of [
        ["InstallLocation", damaged + "\\"],
        ["UninstallString", `"${path.join(damaged, "unins000.exe")}"`],
      ])
        run("reg.exe", [
          "add",
          key,
          "/v",
          name,
          "/t",
          "REG_SZ",
          "/d",
          value,
          "/f",
        ]);
      const damagedBefore = listing(damaged);
      const failed = exec(setup, args(damaged, "damaged.log"));
      assert.notEqual(failed.status, 0, "registered corrupt manifest");
      assert.deepEqual(listing(damaged), damagedBefore);
      assert.equal(fs.existsSync(realMarker), markerBefore);
      t.diagnostic(`Compiled installer evidence: ${base}`);
    } finally {
      spawnSync("reg.exe", ["delete", key, "/f"], { windowsHide: true });
    }
  },
);
