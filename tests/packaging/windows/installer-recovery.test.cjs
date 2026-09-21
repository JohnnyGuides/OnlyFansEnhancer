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
    const env = {
      ...process.env,
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
