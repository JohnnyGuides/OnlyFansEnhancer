"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = require("../support/paths.cjs").repositoryRoot;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
function files(directory) {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((item) => {
      const name = `${directory}/${item.name}`;
      return ["bin", "obj", "node_modules", "_metadata"].includes(item.name)
        ? []
        : item.isDirectory()
          ? files(name)
          : [name];
    });
}

test("each .NET project and test project belongs to the solution; project references resolve", () => {
  const projects = [...files("desktop"), ...files("native-host")].filter(
    (name) => name.endsWith(".csproj"),
  );
  const solution = read("desktop/OFEnhancer.sln");
  const members = [
    ...solution.matchAll(/Project\("[^"\n]+"\) = "[^"]+", "([^"]+\.csproj)"/g),
  ].map((match) =>
    path.resolve(root, "desktop", match[1].replaceAll("\\", "/")),
  );
  for (const project of projects) {
    assert.ok(
      members.includes(path.join(root, project)),
      `${project} must not be omitted from solution build/test`,
    );
    for (const match of read(project).matchAll(
      /<ProjectReference Include="([^"]+)"/g,
    )) {
      const destination = path.resolve(
        root,
        path.dirname(project),
        match[1].replaceAll("\\", "/"),
      );
      assert.ok(fs.existsSync(destination), `${project}: missing ${match[1]}`);
    }
    for (const match of read(project).matchAll(
      /<InternalsVisibleTo Include="([^"]+)"/g,
    )) {
      assert.ok(
        members.some((member) => path.basename(member, ".csproj") === match[1]),
        `${project}: missing friend assembly ${match[1]}`,
      );
    }
  }
  for (const member of members) assert.ok(fs.existsSync(member), member);
});

test("every canonical Chrome/shared file has a deliberate composition owner", async () => {
  const { extensionEntries, validateExtension } =
    await import("../../tools/build-extensions.mjs");
  const used = new Set();
  for (const edition of ["personal", "store"]) {
    const entries = extensionEntries(edition);
    validateExtension(edition, entries);
    for (const entry of entries) used.add(entry.source);
  }
  for (const name of [...files("extensions"), ...files("shared")]) {
    assert.ok(used.has(name), `Unpackaged canonical runtime source: ${name}`);
  }
});

test("current documentation links and referenced npm commands resolve", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  for (const name of [
    "README.md",
    ...files("docs"),
    ...files("packaging/store"),
  ].filter((name) => /\.(md|html)$/.test(name))) {
    const content = read(name);
    for (const match of content.matchAll(
      /\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:href|src)=["']([^"']+)["']/g,
    )) {
      const target = match[1] || match[2];
      if (/^[a-z][a-z\d+.-]*:|^#/i.test(target)) continue;
      const filename = decodeURIComponent(target.split(/[?#]/)[0]);
      assert.ok(
        fs.existsSync(path.resolve(root, path.dirname(name), filename)),
        `${name}: missing link ${target}`,
      );
    }
    for (const match of content.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      assert.ok(
        Object.hasOwn(scripts, match[1]),
        `${name}: missing npm command ${match[1]}`,
      );
    }
  }
});

test("Windows staging resolves literal repository inputs and shares the extension recipe", () => {
  for (const name of files("tools").filter((name) => name.endsWith(".ps1"))) {
    for (const match of read(name).matchAll(
      /Join-Path \$(?:repositoryRoot|PSScriptRoot) "([^"$]+)"/g,
    )) {
      if (match[1].startsWith(".local")) continue; // Deliberately user-supplied optional configuration.
      const base = match[0].includes("$PSScriptRoot") ? "tools" : ".";
      assert.ok(
        fs.existsSync(path.resolve(root, base, match[1].replaceAll("\\", "/"))),
        `${name}: missing ${match[1]}`,
      );
    }
  }
  const stage = read("tools/build-desktop-package.ps1");
  assert.match(stage, /build-extensions\.mjs"\) personal --output-root/);
  assert.match(stage, /build-extensions\.mjs"\) personal --list/);
  const version = JSON.parse(read("extensions/personal/manifest.json")).version;
  assert.match(
    read("desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj"),
    new RegExp(`<Version>${version.replaceAll(".", "\\.")}</Version>`),
  );
  assert.match(
    read("packaging/windows/OFEnhancer.iss"),
    new RegExp(`AppVersion=${version.replaceAll(".", "\\.")}`),
  );
});
