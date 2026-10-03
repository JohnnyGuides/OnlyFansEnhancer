"use strict";

// Live-shaped parsing (visibility wrappers without an inner __typename,
// profile-timeline modules, cursors, scheduled posts) and the page-side
// replay used by background scans. Synthetic fixtures: fake ids, benign text.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const OWNER_ID = "1000000000000000001";
const OTHER_ID = "2000000000000000002";
const EXTENSION_ID = "extension-under-test";

function run(context, relative) {
  vm.runInContext(
    fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
    context,
    { filename: relative },
  );
}

function loadContract() {
  const context = vm.createContext({ URL });
  run(context, "workflows/x-collector-contract.js");
  return context.CreatorXCollectorContract;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function user(id, handle) {
  return {
    result: { __typename: "User", rest_id: id, core: { screen_name: handle } },
  };
}

// The inner object of a TweetWithVisibilityResults as X sends it today: no
// __typename, but rest_id, core, legacy and views.
function bareTweet(id, { authorId = OWNER_ID, handle = "Owner_Handle" } = {}) {
  return {
    rest_id: id,
    core: { user_results: user(authorId, handle) },
    views: { count: "250", state: "EnabledWithCount" },
    legacy: {
      created_at: "Mon Sep 29 10:00:00 +0000 2026",
      full_text: `benign wrapped ${id}`,
      conversation_id_str: id,
      favorite_count: 9,
      retweet_count: 2,
      reply_count: 1,
      quote_count: 0,
      bookmark_count: 4,
    },
  };
}

function wrapped(inner) {
  return { __typename: "TweetWithVisibilityResults", tweet: inner };
}

function moduleEntry(id, results) {
  return {
    entryId: `profile-conversation-${id}`,
    content: {
      entryType: "TimelineTimelineModule",
      items: results.map((result, index) => ({
        entryId: `profile-conversation-${id}-tweet-${index}`,
        item: {
          itemContent: {
            itemType: "TimelineTweet",
            tweet_results: { result },
          },
        },
      })),
    },
  };
}

function itemEntry(result) {
  return {
    entryId: `tweet-${result.rest_id || result.tweet?.rest_id}`,
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: { itemType: "TimelineTweet", tweet_results: { result } },
    },
  };
}

function cursorEntry(type, value) {
  return {
    entryId: `cursor-${type.toLowerCase()}-1`,
    content: {
      entryType: "TimelineTimelineCursor",
      cursorType: type,
      value,
    },
  };
}

// data.user.result.timeline.timeline.instructions[] as on x.com (Oct 2026).
function repliesTimeline(entries) {
  return {
    data: {
      user: {
        result: {
          __typename: "User",
          timeline: {
            timeline: {
              instructions: [
                { type: "TimelineClearCache" },
                { type: "TimelineAddEntries", entries },
              ],
            },
          },
        },
      },
    },
  };
}

test("visibility-wrapped posts without an inner __typename parse from items and modules", () => {
  const contract = loadContract();
  const quoting = bareTweet("203");
  quoting.quoted_status_result = {
    result: wrapped(
      bareTweet("903", { authorId: OTHER_ID, handle: "Someone_Else" }),
    ),
  };
  const payload = repliesTimeline([
    itemEntry(wrapped(bareTweet("201"))),
    moduleEntry("a", [
      wrapped(bareTweet("902", { authorId: OTHER_ID, handle: "Someone_Else" })),
      wrapped(bareTweet("202")),
    ]),
    itemEntry(wrapped(quoting)),
    // A wrapper around nothing usable is skipped like a tombstone.
    itemEntry(wrapped({ rest_id: "204" })),
    cursorEntry("Top", "top-cursor"),
    cursorEntry("Bottom", "bottom-cursor"),
  ]);
  const result = contract.extractOwnerTweets(payload, OWNER_ID);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(plain(result.tweets.map((row) => row.statusId)), [
    "201",
    "202",
    "203",
  ]);
  assert.equal(result.tweets[0].text, "benign wrapped 201");
  assert.deepEqual(plain(result.tweets[0].metrics), {
    views: 250,
    likes: 9,
    reposts: 2,
    replies: 1,
    quotes: 0,
    bookmarks: 4,
  });
  assert.doesNotMatch(JSON.stringify(result), /Someone_Else|90[23]/);
  assert.equal(
    contract.validateBatch(
      plain({
        owner: { accountId: OWNER_ID, handle: "Owner_Handle" },
        observations: result.tweets,
      }),
    ).observations.length,
    3,
  );
});

test("the Bottom cursor is read beside the entries, never from inside posts", () => {
  const contract = loadContract();
  const decoy = bareTweet("205");
  decoy.legacy.cursorType = "Bottom";
  decoy.legacy.value = "decoy";
  assert.equal(
    contract.bottomCursor(
      repliesTimeline([
        itemEntry(wrapped(decoy)),
        cursorEntry("Top", "top-cursor"),
        cursorEntry("Bottom", "DAABCgABG-older"),
      ]),
    ),
    "DAABCgABG-older",
  );
  // TimelineReplaceEntry form.
  assert.equal(
    contract.bottomCursor({
      data: {
        instructions: [
          {
            type: "TimelineReplaceEntry",
            entry: cursorEntry("Bottom", "replaced"),
          },
        ],
      },
    }),
    "replaced",
  );
  assert.equal(
    contract.bottomCursor(repliesTimeline([cursorEntry("Top", "t")])),
    null,
  );
  assert.equal(
    contract.bottomCursor(repliesTimeline([cursorEntry("Bottom", "")])),
    null,
  );
});

test("a replay URL keeps X's own request and only swaps in the cursor for the owner's timeline", () => {
  const contract = loadContract();
  const variables = { userId: OWNER_ID, count: 20, includePromotedContent: 1 };
  const template = `https://x.com/i/api/graphql/AbC-12/UserRepliesTimeline?variables=${encodeURIComponent(
    JSON.stringify(variables),
  )}&features=${encodeURIComponent('{"flag":true}')}`;
  const replay = new URL(contract.replayUrl(template, "c-1", OWNER_ID));
  assert.equal(replay.pathname, "/i/api/graphql/AbC-12/UserRepliesTimeline");
  assert.deepEqual(JSON.parse(replay.searchParams.get("variables")), {
    ...variables,
    cursor: "c-1",
  });
  assert.equal(replay.searchParams.get("features"), '{"flag":true}');
  // Another account's timeline, an unlisted operation, another host or a
  // missing cursor are refused.
  assert.equal(
    contract.replayUrl(template.replace(OWNER_ID, OTHER_ID), "c", OWNER_ID),
    null,
  );
  assert.equal(
    contract.replayUrl(
      template.replace("UserRepliesTimeline", "SearchTimeline"),
      "c",
      OWNER_ID,
    ),
    null,
  );
  assert.equal(
    contract.replayUrl(
      template.replace("x.com", "evil.example"),
      "c",
      OWNER_ID,
    ),
    null,
  );
  assert.equal(contract.replayUrl(template, "", OWNER_ID), null);
  assert.equal(contract.replayUrl(template, "c", null), null);
  assert.deepEqual(
    plain(
      contract.replayHeaders({
        Authorization: "Bearer a",
        "x-csrf-token": "t",
        "X-Client-Transaction-Id": "tx",
        cookie: "never",
        "x-other": "no",
      }),
    ),
    {
      authorization: "Bearer a",
      "x-csrf-token": "t",
      "x-client-transaction-id": "tx",
    },
  );
});

function scheduledResponse(list) {
  return { data: { viewer: { scheduled_tweet_list: list } } };
}

function scheduledItem(id, extra = {}) {
  return {
    rest_id: id,
    scheduling_info: { execute_at: 1759600800000, state: "Scheduled" },
    tweet_create_request: {
      type: "schedule",
      status: `benign scheduled ${id}`,
      media_ids: ["1", "2"],
    },
    media_entities: [
      { media_key: "7_1", media_info: { __typename: "ApiVideo" } },
      { media_key: "3_2", media_info: { __typename: "ApiImage" } },
    ],
    ...extra,
  };
}

test("scheduled posts parse whole or not at all", () => {
  const contract = loadContract();
  assert.equal(contract.operationKind("FetchScheduledTweets"), "scheduled");
  const parsed = contract.extractScheduled(
    scheduledResponse([
      scheduledItem("7001"),
      scheduledItem("7002", {
        scheduling_info: { execute_at: 1759687200 },
        tweet_create_request: { status: "x".repeat(400) },
        media_entities: undefined,
      }),
    ]),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(plain(parsed.posts), [
    {
      scheduledId: "7001",
      scheduledUtc: "2025-10-04T18:00:00.000Z",
      text: "benign scheduled 7001",
      mediaCount: 2,
      mediaTypes: ["video", "photo"],
    },
    {
      scheduledId: "7002",
      scheduledUtc: "2025-10-05T18:00:00.000Z",
      text: "x".repeat(280),
      mediaCount: 0,
      mediaTypes: [],
    },
  ]);
  assert.deepEqual(plain(contract.extractScheduled(scheduledResponse([]))), {
    ok: true,
    reason: "",
    posts: [],
  });
  for (const drifted of [
    { data: { viewer: {} } },
    scheduledResponse([scheduledItem("7003", { rest_id: undefined })]),
    scheduledResponse([scheduledItem("7004", { scheduling_info: {} })]),
    scheduledResponse([
      scheduledItem("7005", { tweet_create_request: { status: 5 } }),
    ]),
    scheduledResponse([scheduledItem("7006", { media_entities: {} })]),
    scheduledResponse(
      Array.from({ length: 101 }, (_, i) => scheduledItem(`${i + 1}`)),
    ),
  ])
    assert.equal(contract.extractScheduled(drifted).reason, "schema-drift");
  assert.equal(
    contract.extractScheduled({ errors: [{ message: "x" }] }).reason,
    "error-response",
  );

  const owner = { accountId: OWNER_ID, handle: null };
  assert.equal(
    contract.validateScheduledBatch(plain({ owner, scheduled: parsed.posts }))
      .scheduled.length,
    2,
  );
  for (const bad of [
    { owner: { accountId: null, handle: null }, scheduled: [] },
    { owner, scheduled: [], extra: 1 },
    { owner, scheduled: [{ ...plain(parsed.posts[0]), extra: 1 }] },
    { owner, scheduled: [plain(parsed.posts[0]), plain(parsed.posts[0])] },
    {
      owner,
      scheduled: [{ ...plain(parsed.posts[0]), scheduledUtc: "tomorrow" }],
    },
    { owner, scheduled: [{ ...plain(parsed.posts[0]), mediaCount: 1 }] },
    {
      owner,
      scheduled: [{ ...plain(parsed.posts[0]), mediaTypes: ["video", "evil"] }],
    },
  ])
    assert.throws(
      () => contract.validateScheduledBatch(bad),
      /invalid-x-scheduled/,
    );
});

test("the forwarder sends a scheduled list at once and drops it when undeliverable", async () => {
  const contract = loadContract();
  const context = vm.createContext({
    setTimeout,
    JSON,
    Object,
    Map,
    Promise,
    Error,
    String,
    Date,
  });
  run(context, "workflows/x-collector-forwarder.js");
  const sent = [];
  let fail = false;
  const forwarder = context.CreatorXCollectorForwarder.create({
    contract,
    send: async () => ({}),
    sendScheduled: async (batch) => {
      if (fail) throw new Error("desktop-unavailable");
      sent.push(plain(batch));
    },
    setTimer: () => 1,
  });
  const batch = {
    owner: { accountId: OWNER_ID, handle: "Owner_Handle" },
    scheduled: [],
  };
  assert.deepEqual(plain(forwarder.accept({ scheduled: batch })), {
    scheduled: 0,
  });
  await forwarder.flush();
  assert.deepEqual(sent, [batch]);
  assert.throws(
    () => forwarder.accept({ scheduled: { ...batch, owner: null } }),
    /invalid-x-scheduled/,
  );
  fail = true;
  forwarder.accept({ scheduled: batch });
  await forwarder.flush();
  const diagnostics = forwarder.diagnostics();
  assert.equal(diagnostics.scheduledListsReceived, 2);
  assert.equal(diagnostics.scheduledListsForwarded, 1);
  assert.equal(diagnostics.desktopFailures, 1);
  assert.equal(diagnostics.batchesRejected, 1);
  assert.equal(sent.length, 1, "An undeliverable list is not retried.");
});

// --- Page replay through the relay, with a fake XMLHttpRequest ------------

const channels = [];
class TrackedChannel extends MessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
}
test.afterEach(() => {
  for (const channel of channels.splice(0)) channel.port1.close();
});

function fakeXhrClass(server) {
  return class FakeXhr extends EventTarget {
    constructor() {
      super();
      this.headers = {};
      this.status = 0;
      this.responseType = "";
      this.responseText = "";
      this.withCredentials = false;
      server.instances.push(this);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send() {
      this.sent = true;
      server.onSend?.(this);
    }
  };
}

function worlds() {
  const document = new EventTarget();
  document.cookie = `twid=u%3D${OWNER_ID}`;
  document.documentElement = null;
  const server = { instances: [], onSend: null };
  const XhrClass = fakeXhrClass(server);
  const page = vm.createContext({
    URL,
    document,
    CustomEvent,
    MessageEvent,
    MessageChannel: TrackedChannel,
    XMLHttpRequest: XhrClass,
    Symbol,
    Promise,
  });
  run(page, "workflows/x-collector-contract.js");
  run(page, "workflows/x-collector-page.js");
  const sent = [];
  let listener = null;
  const relay = vm.createContext({
    URL,
    document,
    CustomEvent,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        id: EXTENSION_ID,
        lastError: undefined,
        sendMessage(message, callback) {
          sent.push(plain(message));
          callback?.();
        },
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
    },
  });
  run(relay, "workflows/x-collector-contract.js");
  run(relay, "workflows/x-collector-relay.js");
  const command = (name, sender = { id: EXTENSION_ID }) =>
    new Promise((resolve) => {
      const handled = listener(
        { type: "CREATOR_X_SCAN_COMMAND", command: name },
        sender,
        resolve,
      );
      if (!handled) resolve("not-handled");
    });
  return { page, server, sent, command, XhrClass };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test("detail status acknowledges only the requested owner's post with counters", async () => {
  const { page, command } = worlds();
  page.location = { pathname: "/Owner_Handle/status/390" };
  const url = "https://x.com/i/api/graphql/q/TweetDetail?variables=%7B%7D";
  xOwnRequest(
    page,
    url,
    repliesTimeline([
      itemEntry(wrapped(bareTweet("391"))),
      itemEntry(
        wrapped(bareTweet("390", { authorId: OTHER_ID, handle: "Other" })),
      ),
    ]),
  );
  assert.equal((await command("detail-status")).ready, false);
  xOwnRequest(
    page,
    url,
    repliesTimeline([itemEntry(wrapped(bareTweet("390")))]),
  );
  const reply = plain(await command("detail-status"));
  assert.equal(reply.ready, true);
  assert.equal(reply.statusId, "390");
  assert.equal(reply.posts[0].metrics.views, 250);
});

test("detail status exposes X's rate-limit response instead of claiming an observation", async () => {
  const { page, command } = worlds();
  page.location = { pathname: "/Owner_Handle/status/390" };
  const xhr = new page.XMLHttpRequest();
  xhr.open("GET", "https://x.com/i/api/graphql/q/TweetDetail?variables=%7B%7D");
  Object.assign(xhr, { status: 429 });
  xhr.dispatchEvent(new Event("load"));
  assert.equal((await command("detail-status")).reason, "http-429");
});

function timelineUrl(userId, extra = {}) {
  return `https://x.com/i/api/graphql/q9/UserRepliesTimeline?variables=${encodeURIComponent(
    JSON.stringify({ userId, count: 20, ...extra }),
  )}&features=%7B%7D`;
}

// X's own first request on the with_replies page, observed by the wrapper.
function xOwnRequest(page, url, body) {
  const xhr = new page.XMLHttpRequest();
  xhr.open("GET", url);
  xhr.setRequestHeader("authorization", "Bearer public-app-token");
  xhr.setRequestHeader("x-csrf-token", "csrf-1");
  xhr.setRequestHeader("x-twitter-auth-type", "OAuth2Session");
  xhr.setRequestHeader("x-twitter-active-user", "yes");
  xhr.setRequestHeader("x-twitter-client-language", "en");
  xhr.setRequestHeader("x-client-transaction-id", "tx-1");
  xhr.setRequestHeader("content-type", "application/json");
  xhr.setRequestHeader("x-unlisted", "not copied");
  xhr.withCredentials = true;
  xhr.send();
  Object.assign(xhr, {
    status: 200,
    responseType: "",
    responseText: JSON.stringify(body),
  });
  xhr.dispatchEvent(new Event("load"));
}

test("the page replays X's own timeline request with the next cursor and allowlisted headers", async () => {
  const { page, server, sent, command } = worlds();
  assert.deepEqual(plain(await command("status")), {
    ok: true,
    ownerId: OWNER_ID,
    ready: false,
    operation: "",
    cursor: false,
    statusIds: [],
    newestUtc: null,
    posts: [],
  });
  // Another account's timeline never becomes the template.
  xOwnRequest(
    page,
    timelineUrl(OTHER_ID),
    repliesTimeline([cursorEntry("Bottom", "foreign")]),
  );
  assert.equal((await command("status")).ready, false);
  xOwnRequest(
    page,
    timelineUrl(OWNER_ID),
    repliesTimeline([
      itemEntry(wrapped(bareTweet("301"))),
      cursorEntry("Bottom", "cursor-1"),
    ]),
  );
  const status = plain(await command("status"));
  assert.equal(status.ready, true);
  assert.equal(status.operation, "UserRepliesTimeline");
  assert.equal(status.cursor, true);
  assert.deepEqual(status.statusIds, ["301"]);

  let pages = 0;
  server.onSend = (xhr) => {
    if (!xhr.url.includes("UserRepliesTimeline") || xhr.headers["x-unlisted"])
      return;
    pages += 1;
    setTimeout(() => {
      Object.assign(xhr, {
        status: 200,
        responseText: JSON.stringify(
          repliesTimeline([
            itemEntry(wrapped(bareTweet(String(310 + pages)))),
            ...(pages === 1 ? [cursorEntry("Bottom", "cursor-2")] : []),
          ]),
        ),
      });
      xhr.dispatchEvent(new Event("load"));
    }, 5);
  };
  const first = plain(await command("page"));
  // The preview for the live scan log carries X's counters unchanged.
  const preview = {
    statusId: "311",
    postedUtc: "2026-09-29T10:00:00.000Z",
    kind: "post",
    text: "benign wrapped 311",
    mediaType: "",
    posterUrl: "",
    metrics: {
      views: 250,
      likes: 9,
      reposts: 2,
      replies: 1,
      quotes: 0,
      bookmarks: 4,
    },
  };
  assert.deepEqual(first, {
    ok: true,
    ownerId: OWNER_ID,
    cursor: true,
    statusIds: ["311"],
    newestUtc: "2026-09-29T10:00:00.000Z",
    posts: [preview],
  });
  const replay = server.instances.at(-1);
  assert.equal(replay.method, "GET");
  assert.equal(replay.withCredentials, true);
  assert.deepEqual(
    JSON.parse(new URL(replay.url).searchParams.get("variables")),
    { userId: OWNER_ID, count: 20, cursor: "cursor-1" },
  );
  assert.deepEqual(replay.headers, {
    authorization: "Bearer public-app-token",
    "x-csrf-token": "csrf-1",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "x-client-transaction-id": "tx-1",
    "content-type": "application/json",
  });
  const second = plain(await command("page"));
  assert.equal(second.cursor, false);
  assert.equal(
    JSON.parse(
      new URL(server.instances.at(-1).url).searchParams.get("variables"),
    ).cursor,
    "cursor-2",
  );
  assert.deepEqual(plain(await command("page")), {
    ok: false,
    reason: "no-cursor",
    ownerId: OWNER_ID,
  });
  await flush();
  // Replayed pages reach the worker through the ordinary batch path.
  assert.deepEqual(
    sent
      .filter((message) => message.batch)
      .map((message) => message.batch.observations[0].statusId),
    ["301", "311", "312"],
  );
});

test("a repeated pagination cursor reports an incomplete scan instead of replaying indefinitely", async () => {
  const { page, server, command } = worlds();
  xOwnRequest(
    page,
    timelineUrl(OWNER_ID),
    repliesTimeline([
      itemEntry(wrapped(bareTweet("390"))),
      cursorEntry("Bottom", "cursor-1"),
    ]),
  );
  server.onSend = (xhr) =>
    setTimeout(() => {
      Object.assign(xhr, {
        status: 200,
        responseText: JSON.stringify(
          repliesTimeline([cursorEntry("Bottom", "cursor-1")]),
        ),
      });
      xhr.dispatchEvent(new Event("load"));
    }, 1);
  assert.deepEqual(plain(await command("page")), {
    ok: false,
    reason: "cursor-stalled",
    ownerId: OWNER_ID,
  });
});

test("a replay stops on a non-200 answer and commands come only from the worker", async () => {
  const { page, server, command } = worlds();
  xOwnRequest(
    page,
    timelineUrl(OWNER_ID),
    repliesTimeline([
      itemEntry(wrapped(bareTweet("401"))),
      cursorEntry("Bottom", "cursor-1"),
    ]),
  );
  assert.equal(
    await command("status", { id: EXTENSION_ID, tab: { id: 4 } }),
    "not-handled",
  );
  assert.equal(await command("status", { id: "other" }), "not-handled");
  assert.equal(await command("click"), "not-handled");
  server.onSend = (xhr) =>
    setTimeout(() => {
      xhr.status = 429;
      xhr.dispatchEvent(new Event("load"));
    }, 1);
  assert.deepEqual(plain(await command("page")), {
    ok: false,
    reason: "http-429",
    ownerId: OWNER_ID,
  });
  server.onSend = (xhr) =>
    setTimeout(() => xhr.dispatchEvent(new Event("error")), 1);
  assert.equal((await command("page")).reason, "http-0");
});

test("the scheduled list observed on X's page is relayed for the owner", async () => {
  const { page, sent } = worlds();
  const xhr = new page.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://x.com/i/api/graphql/s1/FetchScheduledTweets?variables=%7B%7D",
  );
  xhr.send();
  Object.assign(xhr, {
    status: 200,
    responseType: "",
    responseText: JSON.stringify(scheduledResponse([scheduledItem("7001")])),
  });
  xhr.dispatchEvent(new Event("load"));
  await flush();
  const scheduled = sent.filter((message) => message.scheduled);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0].scheduled.owner, {
    accountId: OWNER_ID,
    handle: null,
  });
  assert.equal(scheduled[0].scheduled.scheduled[0].scheduledId, "7001");
  assert.equal(scheduled[0].type, "CREATOR_X_COLLECTOR_BATCH");
});

test("the worker wires the scanner, its alarm, Scan now and the scheduled operations", () => {
  const background = fs.readFileSync(
    path.join(repositoryRoot, "background.js"),
    "utf8",
  );
  assert.match(
    background,
    /"workflows\/x-collector-forwarder\.js",\s*"workflows\/x-collector-scanner\.js"/,
  );
  assert.match(background, /sendDesktopRequest\("getXScanPlan"\)/);
  assert.match(background, /sendDesktopRequest\("recordXScanResult", result\)/);
  assert.match(
    background,
    /sendDesktopRequest\("recordXScheduledPosts", scheduled\)/,
  );
  assert.match(
    background,
    /if \(operation === "requestXScan"\) return xScanner\(\)\.requestNow\(\);/,
  );
  assert.match(background, /xScanner\(\)\.noteScheduled\(sender\.tab\.id/);
  assert.match(background, /alarm\.name !== X_SCANNER\?\.ALARM_NAME/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8"),
  );
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.host_permissions.includes("https://x.com/*"));
  assert.ok(
    fs.existsSync(
      path.join(repositoryRoot, "workflows/x-collector-scanner.js"),
    ),
  );
});
