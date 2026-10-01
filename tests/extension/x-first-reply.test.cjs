"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const PAID = "https://onlyfans.com/123456789/johnny_guides";
const EVIDENCE = { liveCheck: "a".repeat(64) };

function load() {
  const context = vm.createContext({ URL, console });
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/x-first-reply.js"),
      "utf8",
    ),
    context,
    { filename: "workflows/x-first-reply.js" },
  );
  return context.CreatorXFirstReply;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage(initial = {}) {
  const data = plain(initial);
  return {
    data,
    async get(key) {
      return Object.hasOwn(data, key) ? { [key]: plain(data[key]) } : {};
    },
    async set(values) {
      Object.assign(data, plain(values));
    },
  };
}

function candidate(statusId, postedAt, over = {}) {
  return {
    statusId,
    postedUtc: new Date(postedAt).toISOString(),
    itemId: `item-${statusId}`,
    sourceKey: `ep-${statusId}`,
    paidUrl: PAID,
    hasVideo: true,
    isReply: false,
    isRepost: false,
    ownerReplyExists: false,
    ...over,
  };
}

function fakeRunner({ prepare, submit } = {}) {
  const calls = [];
  return {
    calls,
    async open(item) {
      calls.push(["open", item.statusId]);
      return { tabId: 7 };
    },
    async prepare(handle, item) {
      calls.push(["prepare", item.statusId]);
      return prepare ? prepare(item) : { status: "ready" };
    },
    async submit(handle, item) {
      calls.push(["submit", item.statusId]);
      return submit ? submit(item) : { replyId: "9" + item.statusId };
    },
    async close() {
      calls.push(["close"]);
    },
  };
}

function scheduler({
  storage = memoryStorage(),
  items = [],
  runner = fakeRunner(),
  clock = { now: T0 },
  random = () => 0.5,
  evidence = EVIDENCE,
  owner = "Owner_Handle",
} = {}) {
  const api = load();
  const queue = { ownerHandle: owner, items };
  const instance = api.create({
    storage,
    fetchQueue: async () => queue,
    runner,
    evidence,
    now: () => clock.now,
    random,
  });
  return { api, instance, storage, runner, clock, queue };
}

const state = (storage) => storage.data.creatorXFirstReplyV1;

test("the reply is scheduled once 15-60 minutes after the teaser and persisted", async () => {
  for (const [unit, minutes] of [
    [0, 15],
    [0.5, 37.5],
    [0.999999, 60],
  ]) {
    const { instance, storage } = scheduler({
      items: [candidate("101", T0)],
      random: () => unit,
    });
    const result = await instance.tick();
    assert.equal(result.executed, "");
    const item = state(storage).items["101"];
    assert.equal(item.state, "pending");
    assert.ok(
      Math.abs(item.notBefore - (T0 + minutes * MINUTE)) < 100,
      `random ${unit} -> ${minutes} min`,
    );
    assert.equal(item.deadline, T0 + 24 * HOUR);
    assert.equal(item.statusUrl, "https://x.com/Owner_Handle/status/101");
    assert.equal(item.text, `full vid (no ppv)\n-> ${PAID}`);
  }
});

test("a pending reply survives a worker restart and runs once when due", async () => {
  const storage = memoryStorage();
  const first = scheduler({ storage, items: [candidate("101", T0)] });
  await first.instance.tick();
  const runner = fakeRunner();
  const clock = { now: T0 + 61 * MINUTE };
  const second = scheduler({ storage, runner, clock, items: [] });
  const result = await second.instance.tick();
  assert.equal(result.executed, "101");
  assert.equal(result.outcome, "posted");
  assert.deepEqual(runner.calls, [
    ["open", "101"],
    ["prepare", "101"],
    ["submit", "101"],
    ["close"],
  ]);
  assert.equal(state(storage).log[0].outcome, "posted");
  assert.equal(state(storage).log[0].replyId, "9101");
  assert.equal(state(storage).counters.posted, 1);
});

test("variants rotate across scheduled teasers", async () => {
  const { instance, storage, api } = scheduler({
    items: [1, 2, 3, 4].map((n) => candidate(`10${n}`, T0 + n * MINUTE)),
  });
  await instance.tick();
  const variants = ["101", "102", "103", "104"].map(
    (id) => state(storage).items[id].variant,
  );
  assert.deepEqual(variants, [
    api.VARIANTS[0],
    api.VARIANTS[1],
    api.VARIANTS[2],
    api.VARIANTS[0],
  ]);
  assert.equal(new Set(variants).size, 3);
});

test("duplicate guard: a status already scheduled or finished is never scheduled again", async () => {
  const items = [candidate("101", T0)];
  const runner = fakeRunner();
  const clock = { now: T0 + 70 * MINUTE };
  const { instance, storage } = scheduler({ items, runner, clock });
  await instance.tick();
  assert.equal(state(storage).items["101"].outcome, "posted");
  // The desktop has not seen the reply yet and lists the teaser again.
  clock.now += 10 * MINUTE;
  const again = await instance.tick();
  assert.equal(again.executed, "");
  assert.equal(runner.calls.filter(([name]) => name === "submit").length, 1);
  assert.equal(state(storage).rotation, 1);
});

test("eligibility accepts only bound owner teasers with a canonical OnlyFans link", () => {
  const api = load();
  const ok = candidate("101", T0);
  assert.deepEqual(plain(api.eligibility(ok, "Owner_Handle")), {
    ok: true,
    reason: "",
  });
  for (const [over, reason, owner = "Owner_Handle"] of [
    [{ hasVideo: false }, "not-teaser"],
    [{ isReply: true }, "not-teaser"],
    [{ isRepost: true }, "not-teaser"],
    [{ itemId: "" }, "unbound"],
    [{ ownerReplyExists: true }, "existing-reply"],
    [{ paidUrl: undefined }, "no-link"],
    [{ paidUrl: "https://onlyfans.com/123456789/someone_else" }, "no-link"],
    [{ paidUrl: "https://onlyfans.com/123456789" }, "no-link"],
    [{ paidUrl: `${PAID}?ref=1` }, "no-link"],
    [{ statusId: "12a" }, "invalid"],
    [{}, "no-owner", "bad handle!"],
  ]) {
    assert.equal(
      api.eligibility({ ...ok, ...over }, owner).reason,
      reason,
      JSON.stringify(over),
    );
  }
});

test("ineligible teasers are not scheduled and a missing link is recorded once", async () => {
  const runner = fakeRunner();
  const { instance, storage } = scheduler({
    runner,
    clock: { now: T0 + 2 * HOUR },
    items: [
      candidate("101", T0, { paidUrl: undefined }),
      candidate("102", T0, { isReply: true }),
      candidate("103", T0, { ownerReplyExists: true }),
    ],
  });
  await instance.tick();
  await instance.tick();
  assert.deepEqual(Object.keys(state(storage).items), ["101"]);
  assert.equal(state(storage).items["101"].outcome, "no-link");
  assert.equal(state(storage).counters["no-link"], 1);
  assert.deepEqual(runner.calls, []);
});

test("the durable checkpoint is written before the click and nothing is retried after it", async () => {
  const storage = memoryStorage();
  let checkpointAtSubmit = null;
  const runner = fakeRunner({
    submit() {
      checkpointAtSubmit = plain(state(storage).items["101"]);
      throw new Error("unconfirmed: The posted X reply was not observed.");
    },
  });
  const clock = { now: T0 + 70 * MINUTE };
  const { instance } = scheduler({
    storage,
    runner,
    clock,
    items: [candidate("101", T0)],
  });
  await instance.tick();
  assert.equal(checkpointAtSubmit.state, "submit-attempted");
  assert.equal(checkpointAtSubmit.submitAttemptedAt, clock.now);
  assert.equal(state(storage).items["101"].outcome, "unconfirmed");
  clock.now += 20 * MINUTE;
  await instance.tick();
  assert.equal(runner.calls.filter(([name]) => name === "submit").length, 1);
});

test("a worker that stopped after the checkpoint never clicks again", async () => {
  const storage = memoryStorage();
  const first = scheduler({ storage, items: [candidate("101", T0)] });
  await first.instance.tick();
  storage.data.creatorXFirstReplyV1.items["101"].state = "submit-attempted";
  const runner = fakeRunner();
  const { instance } = scheduler({
    storage,
    runner,
    clock: { now: T0 + 2 * HOUR },
    items: [candidate("101", T0)],
  });
  await instance.tick();
  assert.deepEqual(runner.calls, []);
  assert.equal(state(storage).items["101"].outcome, "unconfirmed");
});

test("an existing owner reply found on the page skips the teaser", async () => {
  const runner = fakeRunner({
    prepare: () => ({ status: "existing-reply", replyId: "555" }),
  });
  const { instance, storage } = scheduler({
    runner,
    clock: { now: T0 + 2 * HOUR },
    items: [candidate("101", T0)],
  });
  await instance.tick();
  assert.equal(state(storage).items["101"].outcome, "skipped-existing-reply");
  assert.equal(runner.calls.filter(([name]) => name === "submit").length, 0);
});

test("pre-click failures retry at most three times and record the reason", async () => {
  const runner = fakeRunner({
    prepare() {
      throw new Error("card-not-removed: the link card could not be removed.");
    },
  });
  const clock = { now: T0 + 70 * MINUTE };
  const { instance, storage } = scheduler({
    runner,
    clock,
    items: [candidate("101", T0)],
  });
  for (let index = 0; index < 5; index += 1) {
    await instance.tick();
    clock.now += 11 * MINUTE;
  }
  const item = state(storage).items["101"];
  assert.equal(item.attempts, 3);
  assert.equal(item.outcome, "card-not-removed");
  assert.equal(runner.calls.filter(([name]) => name === "submit").length, 0);
  assert.equal(runner.calls.filter(([name]) => name === "close").length, 3);
});

test("a late reply is still posted once and marked late", async () => {
  const { instance, storage } = scheduler({
    clock: { now: T0 + 5 * HOUR },
    items: [candidate("101", T0)],
  });
  await instance.tick();
  const item = state(storage).items["101"];
  assert.equal(item.outcome, "posted");
  assert.equal(item.late, true);
  assert.equal(state(storage).log[0].late, true);
});

test("a reply not posted within 24 hours of the teaser is given up and recorded", async () => {
  const storage = memoryStorage();
  const first = scheduler({ storage, items: [candidate("101", T0)] });
  await first.instance.tick();
  const runner = fakeRunner();
  const { instance } = scheduler({
    storage,
    runner,
    clock: { now: T0 + 24 * HOUR + MINUTE },
    items: [],
  });
  await instance.tick();
  assert.equal(state(storage).items["101"].outcome, "late-given-up");
  assert.deepEqual(runner.calls, []);
  // Finished records are pruned only after the desktop window has passed.
  const later = scheduler({
    storage,
    runner,
    clock: { now: T0 + 49 * HOUR },
  });
  await later.instance.tick();
  assert.equal(state(storage).items["101"], undefined);
});

test("the setting defaults to off without live-check evidence and on with it", async () => {
  const runner = fakeRunner();
  const without = scheduler({
    runner,
    evidence: { liveCheck: "" },
    items: [candidate("101", T0)],
    clock: { now: T0 + 2 * HOUR },
  });
  assert.deepEqual(plain(await without.instance.tick()), {
    ran: false,
    reason: "disabled",
  });
  const status = await without.instance.status();
  assert.equal(status.enabled, false);
  assert.equal(status.label, "needs one live check");
  assert.deepEqual(runner.calls, []);
  const enabled = await without.instance.setEnabled(true);
  assert.equal(enabled.label, "needs one live check (enabled by owner)");
  await without.instance.tick();
  assert.equal(runner.calls.filter(([name]) => name === "submit").length, 1);

  const withEvidence = scheduler({ items: [] });
  assert.equal((await withEvidence.instance.status()).enabled, true);
  assert.equal((await withEvidence.instance.status()).label, "on");
  await assert.rejects(() => withEvidence.instance.setEnabled("yes"));
});

test("desktop failures are recorded without dropping pending replies", async () => {
  const storage = memoryStorage();
  const first = scheduler({ storage, items: [candidate("101", T0)] });
  await first.instance.tick();
  const api = load();
  const runner = fakeRunner();
  const instance = api.create({
    storage,
    fetchQueue: async () => {
      throw new Error("desktop-unavailable");
    },
    runner,
    evidence: EVIDENCE,
    now: () => T0 + 2 * HOUR,
  });
  const result = await instance.tick();
  assert.equal(result.executed, "101");
  assert.equal(state(storage).lastError, "desktop-unavailable");
});

test("the live-check evidence is empty or the SHA-256 of the committed live-check record", () => {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/social-trace-evidence.js"),
      "utf8",
    ),
    context,
  );
  const liveCheck = context.CreatorXFirstReplyEvidence.liveCheck;
  const record = path.join(
    require("../support/paths.cjs").fixturesRoot,
    "social-traces/x-first-reply.json",
  );
  if (!liveCheck) {
    assert.equal(fs.existsSync(record), false);
    return;
  }
  const bytes = fs.readFileSync(record);
  assert.equal(
    require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
    liveCheck,
  );
  assert.equal(JSON.parse(bytes.toString("utf8")).outcome, "posted");
});
