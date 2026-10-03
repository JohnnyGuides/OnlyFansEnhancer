"use strict";

// The worker-side background scan scheduler with fake storage, desktop and
// tab runner: scheduling (periodic, checkpoints, requests), single flight,
// stop conditions, the page cap, error and owner-mismatch aborts, and tab
// cleanup. No real X traffic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const OWNER = { accountId: "1000000000000000001", handle: "Owner_Handle" };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.parse("2026-10-01T12:00:00Z");
const MARKER = "0123456789abcdef0123456789abcdef";

function loadScanner({ contract = false } = {}) {
  const context = vm.createContext({ URL, setTimeout, Promise, Date, crypto });
  if (contract)
    vm.runInContext(
      fs.readFileSync(
        path.join(repositoryRoot, "workflows/x-collector-contract.js"),
        "utf8",
      ),
      context,
      { filename: "x-collector-contract.js" },
    );
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/x-collector-scanner.js"),
      "utf8",
    ),
    context,
    { filename: "x-collector-scanner.js" },
  );
  return context.CreatorXCollectorScanner;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(values) {
      for (const [key, value] of Object.entries(values))
        data[key] = structuredClone(value);
    },
  };
}

function ids(from, count) {
  return Array.from({ length: count }, (_, index) => String(from + index));
}

// A page source: each reply is { ok, ownerId, cursor, statusIds, newestUtc }.
function harness({
  plan = { owner: OWNER, requestedUtc: null, recentPostsUtc: [] },
  status,
  pages = () => null,
  storage = memoryStorage(),
  takeover = () => false,
  contract = false,
} = {}) {
  const Scanner = loadScanner({ contract });
  const activity = [];
  const clock = { now: START };
  const log = [];
  const delays = [];
  const recorded = [];
  let pageCount = 0;
  const runner = {
    async open(handle, onTab, marker) {
      log.push(["open", handle, marker]);
      pageCount = 0;
      await onTab(77);
      return { tabId: 77 };
    },
    async command(_handle, name) {
      log.push(["command", name]);
      if (name === "status")
        return (
          status?.() || {
            ok: true,
            ownerId: OWNER.accountId,
            ready: true,
            cursor: true,
            statusIds: ids(100, 20),
            newestUtc: new Date(clock.now - HOUR).toISOString(),
          }
        );
      pageCount += 1;
      return (
        pages(pageCount, clock) || {
          ok: true,
          ownerId: OWNER.accountId,
          cursor: true,
          statusIds: ids(1000 + pageCount * 20, 20),
          newestUtc: new Date(clock.now - pageCount * DAY).toISOString(),
        }
      );
    },
    async scheduled() {
      log.push(["scheduled"]);
      return 2;
    },
    async close(handle) {
      log.push(["close", handle.tabId]);
    },
    async closeStale(tabId, marker) {
      log.push(["closeStale", tabId, marker]);
    },
    async takenOver() {
      return takeover(log);
    },
  };
  const desktop = {
    plan: async () => structuredClone(plan),
    record: async (result) => recorded.push(plain(result)),
  };
  const scanner = Scanner.create({
    storage,
    desktop,
    runner,
    now: () => clock.now,
    random: () => 0.5,
    marker: () => MARKER,
    onActivity: (snapshot) => activity.push(plain(snapshot)),
    sleep: async (ms) => {
      delays.push(ms);
      clock.now += ms;
    },
  });
  return {
    Scanner,
    scanner,
    clock,
    log,
    delays,
    recorded,
    storage,
    runner,
    desktop,
    activity,
    planRef: plan,
    pageCommands: () => log.filter((entry) => entry[1] === "page").length,
  };
}

test("scans are due every 6 hours, at checkpoint ages and on request, never closer than 30 minutes", () => {
  const { dueReason, CHECKPOINT_AGES_MS } = loadScanner();
  assert.deepEqual(plain(CHECKPOINT_AGES_MS), [
    DAY,
    3 * DAY,
    7 * DAY,
    30 * DAY,
  ]);
  const plan = { recentPostsUtc: [], requestedUtc: null };
  assert.equal(dueReason({ lastAttemptAt: 0 }, plan, START), "routine");
  const last = START - 2 * HOUR;
  assert.equal(dueReason({ lastAttemptAt: last }, plan, START), "");
  assert.equal(
    dueReason({ lastAttemptAt: START - 6 * HOUR }, plan, START),
    "routine",
  );
  for (const age of [DAY, 3 * DAY, 7 * DAY, 30 * DAY]) {
    const posted = new Date(START - age + 10 * MINUTE).toISOString();
    const withPost = { ...plan, recentPostsUtc: [posted] };
    // Not yet at the checkpoint, then just past it.
    assert.equal(dueReason({ lastAttemptAt: last }, withPost, START), "");
    assert.equal(
      dueReason({ lastAttemptAt: last }, withPost, START + 20 * MINUTE),
      "checkpoint",
    );
  }
  // A checkpoint already covered by the last attempt is not due again.
  const covered = new Date(START - DAY - 3 * HOUR).toISOString();
  assert.equal(
    dueReason(
      { lastAttemptAt: last },
      { ...plan, recentPostsUtc: [covered] },
      START,
    ),
    "",
  );
  // A checkpoint inside the 30-minute gap waits.
  assert.equal(
    dueReason(
      { lastAttemptAt: START - 10 * MINUTE },
      {
        ...plan,
        recentPostsUtc: [new Date(START - DAY - MINUTE).toISOString()],
      },
      START,
    ),
    "",
  );
  const requested = {
    ...plan,
    requestedUtc: new Date(START - MINUTE).toISOString(),
  };
  assert.equal(
    dueReason({ lastAttemptAt: START - 10 * MINUTE }, requested, START),
    "requested",
  );
  assert.equal(
    dueReason({ lastAttemptAt: START - 30_000 }, requested, START),
    "",
  );
  assert.equal(
    dueReason(
      { lastAttemptAt: START - 30_000 },
      { ...requested, requestedUtc: new Date(START - HOUR).toISOString() },
      START,
    ),
    "",
    "A request older than the last attempt was already answered.",
  );
});

test("the first scan is a capped full backfill, later scans a capped 35-day window", async () => {
  const h = harness();
  const first = plain(await h.scanner.tick());
  assert.equal(first.mode, "backfill");
  assert.equal(first.trigger, "routine");
  assert.equal(first.outcome, "page-cap");
  assert.equal(first.pages, h.Scanner.BACKFILL_PAGE_CAP);
  assert.equal(h.pageCommands(), h.Scanner.BACKFILL_PAGE_CAP - 1);
  assert.equal(first.rows, 20 * h.Scanner.BACKFILL_PAGE_CAP);
  assert.equal(first.scheduled, 2);
  // Every replayed page waited 2-4 s first.
  assert.equal(h.delays.length, h.Scanner.BACKFILL_PAGE_CAP - 1);
  assert.ok(h.delays.every((ms) => ms >= 2000 && ms <= 4000));
  assert.deepEqual(h.log.at(-1), ["close", 77]);
  assert.deepEqual(
    h.recorded.map((result) => result.outcome),
    ["page-cap"],
  );

  // Within 6 hours nothing is due.
  h.clock.now += HOUR;
  assert.deepEqual(plain(await h.scanner.tick()), {
    ran: false,
    reason: "not-due",
  });
  h.clock.now += 6 * HOUR;
  h.log.length = 0;
  const routine = plain(await h.scanner.tick());
  assert.equal(routine.mode, "routine");
  // Pages are 1, 2, 3... days old; the window is 35 days but the cap is 10.
  assert.equal(routine.outcome, "page-cap");
  assert.equal(routine.pages, h.Scanner.ROUTINE_PAGE_CAP);
  assert.equal(h.pageCommands(), h.Scanner.ROUTINE_PAGE_CAP - 1);
  const stored = h.storage.data[h.Scanner.STORAGE_KEY];
  assert.equal(stored.backfillDone, true);
  assert.equal(stored.running, null);
});

test("a routine scan stops at the window, the end, or when a page brings nothing new", async () => {
  const done = {
    creatorXScanV1: {
      version: 1,
      backfillDone: true,
      lastFullAt: START - DAY,
      lastAttemptAt: START - 7 * HOUR,
      log: [],
    },
  };
  const windowed = harness({
    storage: memoryStorage(structuredClone(done)),
    pages: (n, clock) => ({
      ok: true,
      ownerId: OWNER.accountId,
      cursor: true,
      statusIds: ids(5000 + n * 20, 20),
      newestUtc: new Date(clock.now - n * 20 * DAY).toISOString(),
    }),
  });
  const reached = plain(await windowed.scanner.tick());
  assert.equal(reached.outcome, "window-reached");
  assert.equal(reached.pages, 3, "20 d, then 40 d > 35 d stops");

  const ended = harness({
    storage: memoryStorage(structuredClone(done)),
    pages: (n) =>
      n === 2
        ? {
            ok: true,
            ownerId: OWNER.accountId,
            cursor: false,
            statusIds: ["9"],
            newestUtc: null,
          }
        : null,
  });
  const complete = plain(await ended.scanner.tick());
  assert.equal(complete.outcome, "complete");
  assert.equal(complete.pages, 3);

  const stale = harness({
    storage: memoryStorage(structuredClone(done)),
    pages: () => ({
      ok: true,
      ownerId: OWNER.accountId,
      cursor: true,
      statusIds: ids(100, 20),
      newestUtc: null,
    }),
  });
  const nothing = plain(await stale.scanner.tick());
  assert.equal(nothing.outcome, "no-new-posts");
  assert.equal(nothing.pages, 2);

  // The captured first page alone can end the scan.
  const short = harness({
    storage: memoryStorage(structuredClone(done)),
    status: () => ({
      ok: true,
      ownerId: OWNER.accountId,
      ready: true,
      cursor: false,
      statusIds: ["1"],
      newestUtc: null,
    }),
  });
  const single = plain(await short.scanner.tick());
  assert.equal(single.outcome, "complete");
  assert.equal(short.pageCommands(), 0);
});

test("an X error aborts at once, closes the tab and skips the scheduled list", async () => {
  const h = harness({
    pages: (n) =>
      n === 2
        ? { ok: false, reason: "http-429", ownerId: OWNER.accountId }
        : null,
  });
  const result = plain(await h.scanner.tick());
  assert.equal(result.outcome, "error");
  assert.equal(result.detail, "http-429");
  assert.equal(result.pages, 2);
  assert.equal(h.pageCommands(), 2, "No retry after the failing page.");
  assert.equal(h.log.filter((entry) => entry[0] === "scheduled").length, 0);
  assert.deepEqual(h.log.at(-1), ["close", 77]);
  assert.equal(h.recorded.length, 1);
  const stored = h.storage.data.creatorXScanV1;
  assert.equal(stored.backfillDone, false);
  assert.equal(stored.lastAttemptAt, START);
  // The failed attempt counts: no immediate retry storm.
  h.clock.now += 5 * MINUTE;
  assert.equal((await h.scanner.tick()).reason, "not-due");

  const thrown = harness({
    pages: () => {
      throw new Error("tab crashed");
    },
  });
  const crashed = plain(await thrown.scanner.tick());
  assert.equal(crashed.outcome, "error");
  assert.deepEqual(thrown.log.at(-1), ["close", 77]);
  assert.match(thrown.storage.data.creatorXScanV1.lastError, /tab crashed/);
});

test("a different signed-in account aborts before any replay; an unknown owner opens nothing", async () => {
  const other = harness({
    status: () => ({
      ok: true,
      ownerId: "2000000000000000002",
      ready: false,
      cursor: false,
      statusIds: [],
      newestUtc: null,
    }),
  });
  const mismatch = plain(await other.scanner.tick());
  assert.equal(mismatch.outcome, "owner-mismatch");
  assert.equal(other.pageCommands(), 0);
  assert.equal(other.log.filter((entry) => entry[0] === "scheduled").length, 0);
  assert.deepEqual(other.log.at(-1), ["close", 77]);

  const switched = harness({
    pages: (n) =>
      n === 3
        ? {
            ok: true,
            ownerId: "2000000000000000002",
            cursor: true,
            statusIds: ["5"],
            newestUtc: null,
          }
        : null,
  });
  const later = plain(await switched.scanner.tick());
  assert.equal(later.outcome, "owner-mismatch");
  assert.equal(switched.pageCommands(), 3);
  assert.equal(later.rows, 20 + 40, "The other account's page is not counted.");

  const signedOut = harness({
    status: () => ({
      ok: true,
      ownerId: null,
      ready: true,
      cursor: true,
      statusIds: [],
      newestUtc: null,
    }),
  });
  assert.equal((await signedOut.scanner.tick()).outcome, "signed-out");
  assert.equal(signedOut.pageCommands(), 0);

  const unknown = harness({
    plan: { owner: null, requestedUtc: null, recentPostsUtc: [] },
  });
  const result = plain(await unknown.scanner.tick());
  assert.equal(result.outcome, "owner-unknown");
  assert.equal(
    unknown.log.length,
    0,
    "No tab is opened without a known owner.",
  );
  assert.equal(unknown.recorded[0].outcome, "owner-unknown");
});

test("a timeline that never loads stops after the ready timeout", async () => {
  const h = harness({ status: () => ({ ok: false, reason: "no-relay" }) });
  const result = plain(await h.scanner.tick());
  assert.equal(result.outcome, "no-timeline");
  assert.equal(result.detail, "no-relay");
  assert.equal(h.pageCommands(), 0);
  assert.deepEqual(h.log.at(-1), ["close", 77]);
});

test("one scan at a time, and a run left by a stopped worker has its tab closed", async () => {
  const h = harness();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const open = h.runner.open;
  h.runner.open = async (...args) => {
    await gate;
    return open(...args);
  };
  const first = h.scanner.run("manual");
  const second = await Promise.race([
    h.scanner.run("manual"),
    new Promise((resolve) => setTimeout(() => resolve("still running"), 200)),
  ]);
  assert.deepEqual(plain(second), { ran: false, reason: "busy" });
  assert.deepEqual(plain(await h.scanner.tick()), {
    ran: false,
    reason: "busy",
  });
  assert.equal((await h.scanner.requestNow()).reason, "busy");
  release();
  await first;
  assert.equal(h.log.filter((entry) => entry[0] === "open").length, 1);

  const restarted = harness({
    storage: memoryStorage({
      creatorXScanV1: {
        version: 1,
        lastAttemptAt: START - 7 * HOUR,
        running: {
          startedAt: START - 7 * HOUR,
          trigger: "routine",
          tabId: 55,
          marker: MARKER,
        },
        log: [],
      },
    }),
  });
  await restarted.scanner.tick();
  assert.deepEqual(restarted.log[0], ["closeStale", 55, MARKER]);

  // Even when no scan is due, the next tick closes the leftover tab.
  const idle = harness({
    storage: memoryStorage({
      creatorXScanV1: {
        version: 1,
        lastAttemptAt: START - HOUR,
        running: {
          startedAt: START - HOUR,
          trigger: "routine",
          tabId: 56,
          marker: MARKER,
        },
        log: [],
      },
    }),
  });
  assert.equal((await idle.scanner.tick()).reason, "not-due");
  assert.deepEqual(idle.log, [["closeStale", 56, MARKER]]);
  assert.equal(idle.storage.data.creatorXScanV1.running, null);
});

test("Scan now starts at once unless a scan just ran", async () => {
  const h = harness({
    pages: (n, clock) => ({
      ok: true,
      ownerId: OWNER.accountId,
      cursor: false,
      statusIds: ids(9000 + n * 20, 20),
      newestUtc: new Date(clock.now - DAY).toISOString(),
    }),
  });
  assert.deepEqual(plain(await h.scanner.requestNow()), {
    requested: true,
    started: true,
    reason: "",
  });
  await h.scanner.idle();
  assert.equal(h.recorded[0].trigger, "manual");
  assert.deepEqual(plain(await h.scanner.requestNow()), {
    requested: true,
    started: false,
    reason: "too-soon",
  });
  h.clock.now += 3 * MINUTE;
  assert.equal((await h.scanner.requestNow()).started, true);
  await h.scanner.idle();
  const status = plain(await h.scanner.status());
  assert.equal(status.running, false);
  assert.equal(status.log.length, 2);
});

test("a desktop request is answered by the next tick", async () => {
  const h = harness({
    storage: memoryStorage({
      creatorXScanV1: {
        version: 1,
        backfillDone: true,
        lastFullAt: START - DAY,
        lastFullAt: START - DAY,
        lastAttemptAt: START - HOUR,
        log: [],
      },
    }),
    plan: {
      owner: OWNER,
      requestedUtc: new Date(START - MINUTE).toISOString(),
      recentPostsUtc: [],
    },
  });
  const result = plain(await h.scanner.tick());
  assert.equal(result.trigger, "requested");
  assert.equal(h.recorded.length, 1);
});

test("the Chrome runner opens one inactive with_replies tab and closes only its own stale tab", async () => {
  const Scanner = loadScanner();
  const calls = [];
  const tabs = new Map();
  let redirect = "";
  let activate = null;
  const chrome = {
    tabs: {
      onActivated: {
        addListener(callback) {
          activate = callback;
        },
      },
      async create(options) {
        calls.push(["create", options]);
        tabs.set(9, {
          id: 9,
          status: "complete",
          url: options.url,
          active: false,
        });
        return { id: 9 };
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        return tabs.get(id);
      },
      async update(id, options) {
        calls.push(["update", id, options]);
        tabs.get(id).url = redirect || options.url;
        return tabs.get(id);
      },
      async remove(id) {
        calls.push(["remove", id]);
        tabs.delete(id);
      },
      async sendMessage(id, message, options) {
        calls.push(["send", id, message, options]);
        return { ok: true, ready: true };
      },
    },
  };
  const runner = Scanner.createChromeRunner({
    chrome,
    pollMs: 1,
    scheduledTimeoutMs: 50,
  });
  const handle = await runner.open("Owner_Handle", async () => {}, MARKER);
  // A blank background tab first, then the owner's with_replies page
  // carrying this run's marker.
  // The tab is kept from being discarded during a long full scan.
  assert.deepEqual(plain(calls.slice(0, 3)), [
    ["create", { url: "about:blank", active: false }],
    ["update", 9, { autoDiscardable: false }],
    [
      "update",
      9,
      { url: `https://x.com/Owner_Handle/with_replies#creator-scan=${MARKER}` },
    ],
  ]);
  assert.equal(await runner.takenOver(handle), false);
  await runner.command(handle, "page");
  assert.deepEqual(plain(calls.at(-1)), [
    "send",
    9,
    { type: "CREATOR_X_SCAN_COMMAND", command: "page" },
    { frameId: 0 },
  ]);
  const scheduled = runner.scheduled(handle);
  setTimeout(() => runner.noteScheduled(9, 3), 5);
  assert.equal(await scheduled, 3);
  assert.deepEqual(plain(calls.filter((call) => call[0] === "update")[2]), [
    "update",
    9,
    {
      url: `https://x.com/compose/post/unsent/scheduled#creator-scan=${MARKER}`,
    },
  ]);
  assert.equal(
    await runner.scheduled(handle),
    null,
    "Times out without a list.",
  );
  await runner.close(handle);
  assert.deepEqual(calls.at(-1), ["remove", 9]);

  // X redirected the tab (signed out): it is closed and the scan stops.
  redirect = "https://x.com/i/flow/login";
  chrome.tabs.create = async (options) => {
    tabs.set(10, {
      id: 10,
      status: "complete",
      url: options.url,
      active: false,
    });
    calls.push(["create", options]);
    return { id: 10 };
  };
  await assert.rejects(runner.open("Owner_Handle"), /no-timeline/);
  assert.deepEqual(calls.at(-1), ["remove", 10]);

  // Only an inactive x.com tab whose URL still carries this run's marker is
  // closed after a restart; any other inactive x.com tab is left alone.
  const marked = `https://x.com/Owner_Handle/with_replies#creator-scan=${MARKER}`;
  tabs.set(11, { id: 11, url: marked, active: true });
  tabs.set(12, {
    id: 12,
    url: `https://example.com/#creator-scan=${MARKER}`,
    active: false,
  });
  tabs.set(13, {
    id: 13,
    url: "https://x.com/Owner_Handle/with_replies",
    active: false,
  });
  tabs.set(14, { id: 14, url: marked, active: false });
  tabs.set(15, { id: 15, url: marked.replace("0123", "9999"), active: false });
  for (const id of [11, 12, 13, 15]) await runner.closeStale(id, MARKER);
  await runner.closeStale(14, "");
  await runner.closeStale(14, MARKER);
  assert.deepEqual(
    calls.filter((call) => call[0] === "remove").map((call) => call[1]),
    [9, 10, 14],
  );

  // The owner activates the tab: open stops and leaves the tab in place.
  redirect = "";
  chrome.tabs.create = async (options) => {
    tabs.set(20, {
      id: 20,
      status: "complete",
      url: options.url,
      active: true,
    });
    return { id: 20 };
  };
  await assert.rejects(
    runner.open("Owner_Handle", async () => {}, MARKER),
    /user-took-over/,
  );
  assert.ok(tabs.has(20), "A tab the owner took over is not closed.");
  // A brief activation during the scheduled step also hands the tab over.
  chrome.tabs.create = async (options) => {
    tabs.set(21, {
      id: 21,
      status: "complete",
      url: options.url,
      active: false,
    });
    return { id: 21 };
  };
  const later = await runner.open("Owner_Handle", async () => {}, MARKER);
  const updatesBefore = calls.filter((call) => call[0] === "update").length;
  const pending = runner.scheduled(later);
  setTimeout(() => activate({ tabId: 21, windowId: 1 }), 5);
  await assert.rejects(pending, /user-took-over/);
  assert.equal(await runner.takenOver(later), true);
  assert.equal(
    calls.filter((call) => call[0] === "update").length,
    updatesBefore + 1,
  );
  await assert.rejects(runner.scheduled(later), /user-took-over/);
  assert.equal(
    calls.filter((call) => call[0] === "update").length,
    updatesBefore + 1,
    "No navigation after the owner took over.",
  );
});

test("the owner opening the scan tab stops the scan at once and leaves the tab alone", async () => {
  let takeAfter = 2;
  const h = harness({
    takeover: (log) =>
      log.filter((entry) => entry[1] === "page").length >= takeAfter,
  });
  const result = plain(await h.scanner.tick());
  assert.equal(result.outcome, "user-took-over");
  assert.equal(h.pageCommands(), 2, "No page after the takeover.");
  assert.equal(h.log.filter((entry) => entry[0] === "close").length, 0);
  assert.equal(h.log.filter((entry) => entry[0] === "scheduled").length, 0);
  assert.equal(h.storage.data.creatorXScanV1.running, null);
  assert.equal(h.recorded[0].outcome, "user-took-over");

  // Taken over while the profile is still loading: nothing is commanded.
  takeAfter = 0;
  const early = harness({ takeover: () => true });
  assert.equal((await early.scanner.run("manual")).outcome, "user-took-over");
  assert.equal(early.log.filter((entry) => entry[0] === "command").length, 0);
  assert.equal(early.log.filter((entry) => entry[0] === "close").length, 0);
  assert.equal(early.log[0][2], MARKER, "The scan tab carries its marker.");
});

test("rate-limit and authorization errors pause automatic scans 6 h, doubling to 48 h; Scan now still runs", async () => {
  const { BACKOFF_BASE_MS, BACKOFF_MAX_MS } = loadScanner();
  assert.equal(BACKOFF_BASE_MS, 6 * HOUR);
  assert.equal(BACKOFF_MAX_MS, 48 * HOUR);
  let reason = "http-429";
  const h = harness({
    pages: (n) =>
      reason ? { ok: false, reason, ownerId: OWNER.accountId } : null,
  });
  const expected = [6, 12, 24, 48, 48];
  for (const [index, hours] of expected.entries()) {
    reason = ["http-429", "http-403", "http-401"][index % 3];
    const result = plain(await h.scanner.run("manual"));
    assert.equal(result.outcome, "error");
    const until = Date.parse(result.backoffUntilUtc);
    assert.equal(
      until - Date.parse(result.finishedUtc),
      hours * HOUR,
      `error ${index + 1}`,
    );
    // Neither the 6-hourly nor a checkpoint scan runs inside the pause.
    h.clock.now = until - MINUTE;
    h.planRef.recentPostsUtc = [
      new Date(h.clock.now - DAY + 30_000).toISOString(),
    ];
    assert.equal((await h.scanner.tick()).reason, "not-due");
    assert.equal(
      (await h.scanner.status()).backoffUntilUtc,
      result.backoffUntilUtc,
    );
    // A desktop "Scan now" request is still answered.
    h.planRef.recentPostsUtc = [];
    h.clock.now += 30_000;
  }
  // Other errors leave the pause as it is; a finished scan clears it.
  reason = "http-500";
  const other = plain(await h.scanner.run("manual"));
  assert.equal(other.detail, "http-500");
  assert.equal(h.storage.data.creatorXScanV1.backoffErrors, 5);
  reason = "";
  const ok = plain(await h.scanner.run("manual"));
  assert.equal(ok.backoffUntilUtc, "");
  assert.equal(h.storage.data.creatorXScanV1.backoffErrors, 0);
  h.clock.now += 7 * HOUR;
  assert.notEqual((await h.scanner.tick()).reason, "not-due");

  const requested = harness({
    storage: memoryStorage({
      creatorXScanV1: {
        version: 1,
        backfillDone: true,
        lastFullAt: START - DAY,
        lastFullAt: START - DAY,
        lastAttemptAt: START - HOUR,
        backoffErrors: 1,
        backoffUntil: START + 5 * HOUR,
        log: [],
      },
    }),
    plan: {
      owner: OWNER,
      requestedUtc: new Date(START - MINUTE).toISOString(),
      recentPostsUtc: [],
    },
  });
  assert.equal((await requested.scanner.tick()).trigger, "requested");
});

test("one scan runs after every OFEnhancer start, but not during a pause or right after another scan", () => {
  const { dueReason } = loadScanner();
  const started = new Date(START - 5 * MINUTE).toISOString();
  const plan = {
    recentPostsUtc: [],
    requestedUtc: null,
    desktopStartedUtc: started,
  };
  // The last scan was an hour ago, before this start: due now.
  assert.equal(
    dueReason({ lastAttemptAt: START - HOUR }, plan, START),
    "startup",
  );
  // A scan already ran after this start: nothing more for the start.
  assert.equal(
    dueReason({ lastAttemptAt: START - 4 * MINUTE }, plan, START),
    "",
  );
  // A scan that ran just before the start waits the two-minute gap.
  assert.equal(
    dueReason(
      { lastAttemptAt: START - 6 * MINUTE },
      { ...plan, desktopStartedUtc: new Date(START - MINUTE).toISOString() },
      START - 5 * MINUTE,
    ),
    "",
  );
  // Rate-limit pauses still hold.
  assert.equal(
    dueReason(
      { lastAttemptAt: START - HOUR, backoffUntil: START + HOUR },
      plan,
      START,
    ),
    "",
  );
  // A start time in the future (clock skew) or missing is ignored.
  assert.equal(
    dueReason(
      { lastAttemptAt: START - HOUR },
      { ...plan, desktopStartedUtc: new Date(START + HOUR).toISOString() },
      START,
    ),
    "",
  );
  assert.equal(
    dueReason(
      { lastAttemptAt: START - HOUR },
      { ...plan, desktopStartedUtc: "" },
      START,
    ),
    "",
  );
});

test("a startup tick runs the scan and records the startup trigger", async () => {
  const { scanner, recorded } = harness({
    plan: {
      owner: OWNER,
      requestedUtc: null,
      recentPostsUtc: [],
      desktopStartedUtc: new Date(START - MINUTE).toISOString(),
    },
    storage: memoryStorage({
      creatorXScanV1: {
        version: 1,
        lastAttemptAt: START - HOUR,
        lastSuccessAt: START - HOUR,
        backfillDone: true,
        lastFullAt: START - DAY,
        lastFullAt: START - DAY,
        running: null,
        last: null,
        log: [],
      },
    }),
  });
  const result = await scanner.tick();
  assert.equal(result.ran, true);
  assert.equal(recorded[0].trigger, "startup");
});

test("the live log says what the scan does and lists every post read with X's exact counters", async () => {
  const preview = (id, views, mediaType = "video") => ({
    statusId: id,
    postedUtc: new Date(START - HOUR).toISOString(),
    kind: "post",
    text: `benign ${id}`,
    mediaType,
    posterUrl: mediaType
      ? `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/a.jpg`
      : "",
    metrics: {
      views,
      likes: 7,
      reposts: 1,
      replies: 0,
      quotes: 0,
      bookmarks: null,
    },
  });
  const { scanner, activity } = harness({
    contract: true,
    status: () => ({
      ok: true,
      ownerId: OWNER.accountId,
      ready: true,
      cursor: true,
      statusIds: ["101", "102"],
      newestUtc: new Date(START - HOUR).toISOString(),
      posts: [
        preview("101", 12345),
        preview("102", 9, ""),
        // A forged poster host and a non-integer counter are dropped.
        { ...preview("103", 5), posterUrl: "https://evil.example/a.jpg" },
        {
          ...preview("104", 5),
          metrics: { ...preview("104", 5).metrics, views: 1.5 },
        },
      ],
    }),
    pages: () => ({
      ok: true,
      ownerId: OWNER.accountId,
      cursor: false,
      statusIds: ["201"],
      newestUtc: new Date(START - 2 * HOUR).toISOString(),
      posts: [preview("201", 1000000)],
    }),
  });
  await scanner.run("startup");
  const last = activity.at(-1);
  assert.equal(last.running, false);
  assert.equal(last.phase, "done");
  assert.equal(last.trigger, "startup");
  assert.equal(last.outcome, "complete");
  assert.equal(last.pages, 2);
  assert.equal(last.rows, 3);
  const lines = last.events.map((event) => `${event.kind}: ${event.text}`);
  const expected = [
    /^step: Scan started because OFEnhancer was started/,
    /^step: Opening an inactive background tab on x\.com\/Owner_Handle\/with_replies/,
    /^step: Waiting for X to load your timeline/,
    /^step: Signed in as account 1000000000000000001, the recorded owner @Owner_Handle/,
    /^step: Page 1: read 2 posts of yours/,
    /^post: Page 1: Video post 101 — 12,345 views · 7 likes · 1 repost · 0 replies$/,
    /^post: Page 1: Text post 102 — 9 views · 7 likes · 1 repost · 0 replies$/,
    /^step: Pausing 3\.0 s before page 2/,
    /^step: Asking X for page 2/,
    /^step: Page 2: read 1 post, 1 new in this scan/,
    /^post: Page 2: Video post 201 — 1,000,000 views/,
    /^step: Stopped paging: reached the end of your timeline/,
    /^step: Opening your scheduled-posts list/,
    /^step: Read 2 scheduled posts/,
    /^step: Closing the background tab/,
    /^done: Finished: 2 pages, 3 posts recorded with fresh counters/,
  ];
  assert.equal(lines.length, expected.length, lines.join("\n"));
  expected.forEach((pattern, index) => assert.match(lines[index], pattern));
  // The image the log shows is the post's own poster, counters untouched.
  const post = last.events.find((event) => event.post?.statusId === "101").post;
  assert.equal(
    post.posterUrl,
    "https://pbs.twimg.com/ext_tw_video_thumb/101/pu/img/a.jpg",
  );
  assert.deepEqual(post.metrics, preview("101", 12345).metrics);
  assert.deepEqual(
    last.posts.map((item) => item.statusId),
    ["201"],
  );
  // The live state was published while the scan was still running.
  assert.ok(
    activity.some(
      (snapshot) => snapshot.running && snapshot.phase === "waiting",
    ),
  );
  assert.deepEqual(plain((await scanner.status()).activity), last);
});

test("a stopped scan says why in the live log", async () => {
  const { scanner, activity } = harness({
    pages: () => ({ ok: false, reason: "http-429", ownerId: OWNER.accountId }),
  });
  await scanner.run("routine");
  const lines = activity.at(-1).events.map((event) => event.text);
  assert.ok(
    lines.includes(
      "Scan stopped: X gave an answer the scan could not use (http-429)",
    ),
    lines.join("\n"),
  );
  assert.match(
    lines.at(-1),
    /^Ended: 1 page, 20 posts recorded with fresh counters in \d+ s — automatic scans paused until .+ after X's HTTP 429 answer$/,
  );
});

test("the first scan reads the whole history until X has no older page, then again weekly", async () => {
  const total = 120;
  const pages = (n, clock) => ({
    ok: true,
    ownerId: OWNER.accountId,
    cursor: n < total - 1,
    statusIds: ids(100_000 + n * 20, 20),
    newestUtc: new Date(clock.now - n * 30 * DAY).toISOString(),
  });
  const storage = memoryStorage();
  const h = harness({ pages, storage });
  const first = plain(await h.scanner.run("startup"));
  assert.equal(first.mode, "backfill");
  assert.equal(first.outcome, "complete");
  // Page 1 from the profile load, then every older page to the end, far
  // beyond both the 35-day window and the old 30-page cap.
  assert.equal(first.pages, total);
  assert.equal(first.rows, 20 + (total - 1) * 20);
  const state = storage.data.creatorXScanV1;
  assert.equal(state.backfillDone, true);
  assert.equal(state.lastFullAt, START);

  // Within the week, scans read the recent window only.
  h.clock.now = START + 6 * HOUR + MINUTE;
  assert.equal(plain(await h.scanner.run("routine")).mode, "routine");
  // A week after the last full read, the whole history is read again.
  h.clock.now = START + 7 * DAY;
  const weekly = plain(await h.scanner.run("routine"));
  assert.equal(weekly.mode, "backfill");
  assert.equal(weekly.outcome, "complete");
  // The log keeps its newest lines; the run's first snapshot names why.
  const opening = h.activity.find(
    (snapshot) => snapshot.startedUtc === weekly.startedUtc,
  );
  assert.match(
    opening.events[0].text,
    /weekly full read of your whole history/,
  );
});

test("a full scan that does not finish is retried as a full scan", async () => {
  const storage = memoryStorage();
  const h = harness({
    storage,
    pages: (n) =>
      n === 3
        ? { ok: false, reason: "http-500", ownerId: OWNER.accountId }
        : null,
  });
  const broken = plain(await h.scanner.run("startup"));
  assert.equal(broken.outcome, "error");
  assert.equal(storage.data.creatorXScanV1.backfillDone, false);
  h.clock.now += 6 * HOUR;
  const retried = plain(await h.scanner.run("routine"));
  assert.equal(retried.mode, "backfill");
});
