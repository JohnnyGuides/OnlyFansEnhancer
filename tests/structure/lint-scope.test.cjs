"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ESLint } = require("eslint");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");

async function lintText(file, text) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(text, {
    filePath: path.join(root, file),
  });
  return result.messages;
}

test("the store service worker has no DOM globals and the personal one keeps them", async () => {
  const probe = "void document.title;\nvoid localStorage;\nvoid window;\n";
  const store = await lintText("extensions/store/background.js", probe);
  assert.deepEqual(
    store.map((message) => message.ruleId),
    ["no-undef", "no-undef", "no-undef"],
  );
  const personal = await lintText("extensions/personal/background.js", probe);
  assert.deepEqual(personal, []);
  const worker = await lintText(
    "extensions/store/background.js",
    "void chrome.runtime;\nvoid self;\nvoid fetch;\n",
  );
  assert.deepEqual(worker, []);
});

function globToRegExp(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${source}$`);
}

function walk(directory) {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${directory}/${entry.name}`;
      if (entry.name === "node_modules" || entry.name === "dist") return [];
      return entry.isDirectory() ? walk(name) : [name];
    });
}

test("the lint script names every file the eslint config covers", async () => {
  const { default: config } = await import("../../eslint.config.mjs");
  const patterns = [
    ...new Set(config.flatMap((block) => block.files ?? [])),
  ].filter((pattern) => typeof pattern === "string");
  assert.ok(patterns.length > 0);
  const script = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).scripts.lint;
  const targets = script
    .replace(/^eslint\s+/, "")
    .split(/\s+/)
    .map((target) => target.replace(/\/$/, ""));
  const covered = (file) =>
    targets.some((target) => file === target || file.startsWith(`${target}/`));
  for (const pattern of patterns) {
    const segments = pattern.split("/");
    const literal = segments.findIndex((segment) => segment.includes("*"));
    const base = segments.slice(0, literal === -1 ? -1 : literal).join("/");
    const matcher = globToRegExp(pattern);
    const files = walk(base).filter((file) => matcher.test(file));
    assert.ok(files.length > 0, `Config pattern matches no file: ${pattern}`);
    for (const file of files) {
      assert.ok(covered(file), `npm run lint does not name ${file}`);
    }
  }
});
