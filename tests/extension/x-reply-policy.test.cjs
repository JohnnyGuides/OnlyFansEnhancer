"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { repositoryRoot } = require("../support/paths.cjs");
function load() {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "extensions/personal/workflows/x-reply-policy.js",
      ),
      "utf8",
    ),
    context,
  );
  return context.CreatorXReplyPolicy;
}
function storage() {
  const data = {};
  return {
    async get(key) {
      return structuredClone({ [key]: data[key] });
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
  };
}
test("an explicit editor reservation supersedes an unattempted scanner job but never a claimed reply", async () => {
  const policy = load().forStorage(storage());
  const scan = await policy.reserve("401", "https://onlyfans.com/old");
  const editor = await policy.reserve("401", "https://fansly.com/chosen", {
    line: "Chosen",
    owner: "editor",
  });
  assert.equal(editor.owner, "editor");
  await assert.rejects(policy.claim("401", scan.text), /text changed/);
  assert.equal(await policy.claim("401", editor.text), true);
  const attempted = await policy.reserve("402", "https://onlyfans.com/old");
  assert.equal(await policy.claim("402", attempted.text), true);
  const unchanged = await policy.reserve("402", "https://onlyfans.com/old", {
    line: "Chosen",
    owner: "editor",
  });
  assert.equal(unchanged.owner, "scanner");
  assert.equal(unchanged.attempted, true);
});
test("both entry points share rotation, frozen wording and a durable one-attempt claim", async () => {
  const disk = storage(),
    policy = load(),
    editor = policy.forStorage(disk),
    scanner = policy.forStorage(disk);
  assert.equal(editor, scanner);
  await editor.save({ mode: "rotate", variants: ["First", "Second"] });
  const line = await editor.allocate();
  await editor.save({ mode: "rotate", variants: ["Changed"] });
  const reply = await editor.reserve("101", "https://onlyfans.com/example", {
    line,
    owner: "editor",
  });
  assert.equal(reply.text, "First\n-> https://onlyfans.com/example");
  assert.equal(
    (await scanner.reserve("102", "https://fansly.com/example")).text,
    "Changed\n-> https://fansly.com/example",
  );
  const claims = await Promise.all([
    editor.claim("101", reply.text),
    scanner.claim("101", reply.text),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const restarted = load().forStorage(disk);
  assert.equal(await restarted.claim("101", reply.text), false);
  assert.equal((await restarted.lookup("101")).owner, "editor");
  await assert.rejects(
    restarted.reserve("101", "https://fansly.com/different"),
    /link changed/,
  );
});
test("link-only and single-line settings apply to every newly reserved reply", async () => {
  const policy = load().forStorage(storage());
  await policy.save({ mode: "link", variants: ["Kept for later"] });
  assert.equal(
    (await policy.reserve("201", "https://fansly.com/example")).text,
    "https://fansly.com/example",
  );
  await policy.save({ variants: ["Always this line"] });
  assert.equal(await policy.allocate(), "Always this line");
  assert.equal(await policy.allocate(), "Always this line");
  await policy.save({ variants: ["First line\r\nSecond line\n\nFourth line"] });
  const reply = await policy.reserve("202", "https://fansly.com/example");
  assert.equal(
    reply.text,
    "First line\nSecond line\n\nFourth line\n-> https://fansly.com/example",
  );
  await assert.rejects(policy.save({ variants: [" "] }), /saved replies/);
  await assert.rejects(
    policy.save({ variants: ["x".repeat(201)] }),
    /200 characters/,
  );
  await assert.rejects(policy.claim("201", "changed text"), /text changed/);
});

test("editable link labels and placement use the selected URL without adding an arrow", async () => {
  const api = load(),
    policy = api.forStorage(storage());
  const template = "Full video\nOnlyFans: {link}\nEnjoy";
  await policy.save({ variants: [template] });
  const reply = await policy.reserve("301", "https://onlyfans.com/example");
  assert.equal(
    reply.text,
    "Full video\nOnlyFans: https://onlyfans.com/example\nEnjoy",
  );
  assert.equal(api.template("Legacy wording"), "Legacy wording\n-> {link}");
  assert.equal(
    api.format("{link}", "https://example.com/?x=$&"),
    "https://example.com/?x=$&",
  );
  await assert.rejects(policy.save({ variants: ["{link}\n{link}"] }), /once/);
});

test("reply text files round-trip multiline messages, blank lines and placeholders", () => {
  const api = load(),
    variants = [
      "First line\n\nSecond line\nOnlyFans: {link}",
      "Watch here: {link}",
    ];
  const text = api.toText(variants);
  assert.deepEqual(
    Array.from(api.fromText(`\uFEFF${text.replaceAll("\n", "\r\n")}`)),
    variants,
  );
  assert.equal(variants.length, 2);
  assert.deepEqual(Array.from(api.fromText("Old wording")), [
    "Old wording\n-> {link}",
  ]);
  assert.throws(() => api.fromText("Valid {link}\n---\n"), /saved replies/);
  assert.throws(() => api.fromText("x".repeat(201)), /200 characters/);
  assert.throws(
    () => api.toText(["One\n---\nTwo\n{link}"]),
    /separates replies/,
  );
});
