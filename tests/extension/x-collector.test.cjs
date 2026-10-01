"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const OWNER_ID = "1000000000000000001";
const OTHER_ID = "2000000000000000002";

function run(context, relative) {
  vm.runInContext(
    fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
    context,
    { filename: relative },
  );
}

function loadContract(extra = {}) {
  const context = vm.createContext({ URL, ...extra });
  run(context, "workflows/x-collector-contract.js");
  return context.CreatorXCollectorContract;
}

// Synthetic fixtures shaped like X GraphQL; benign text and fake ids only.
function user(id, handle, { modern = true } = {}) {
  return {
    result: {
      __typename: "User",
      rest_id: id,
      ...(modern
        ? { core: { screen_name: handle } }
        : { legacy: { screen_name: handle } }),
    },
  };
}

function tweet(
  id,
  { authorId = OWNER_ID, handle = "Owner_Handle", ...over } = {},
) {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: { user_results: user(authorId, handle) },
    views: { count: "1234", state: "EnabledWithCount" },
    legacy: {
      created_at: "Sat Sep 27 18:04:11 +0000 2026",
      full_text: `benign teaser ${id}`,
      conversation_id_str: id,
      favorite_count: 12,
      retweet_count: 3,
      reply_count: 4,
      quote_count: 1,
      bookmark_count: 5,
      entities: {
        urls: [{ expanded_url: "https://onlyfans.com/123/example" }],
      },
      extended_entities: {
        media: [
          {
            type: "video",
            media_key: "7_1900000000000000001",
            media_url_https:
              "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
            video_info: { duration_millis: 15000 },
          },
        ],
      },
      ...over,
    },
  };
}

function item(result) {
  return {
    entryType: "TimelineTimelineItem",
    itemContent: { itemType: "TimelineTweet", tweet_results: { result } },
  };
}

function userTweets(results) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: "TimelinePinEntry",
                  entry: { entryId: "pin", content: item(results[0]) },
                },
                {
                  type: "TimelineAddEntries",
                  entries: [
                    ...results.slice(1).map((result, index) => ({
                      entryId: `tweet-${index}`,
                      content: item(result),
                    })),
                    {
                      entryId: "profile-conversation-1",
                      content: {
                        entryType: "TimelineTimelineModule",
                        items: [
                          {
                            item: {
                              itemContent: {
                                itemType: "TimelineTweet",
                                tweet_results: {
                                  result: tweet("900", {
                                    authorId: OTHER_ID,
                                    handle: "Someone_Else",
                                  }),
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                    { entryId: "cursor-bottom", content: { value: "x" } },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

test("the GraphQL allowlist is one constant and unknown operations are ignored", () => {
  const contract = loadContract();
  assert.equal(
    contract.operationName(
      "https://x.com/i/api/graphql/AbC-12_x/UserTweets?variables=%7B%7D",
    ),
    "UserTweets",
  );
  assert.equal(contract.operationKind("UserTweets"), "tweets");
  assert.equal(contract.operationKind("TweetDetail"), "tweets");
  assert.equal(contract.operationKind("Viewer"), "viewer");
  for (const name of ["HomeTimeline", "SearchTimeline", "Followers", ""])
    assert.equal(contract.operationKind(name), null);
  for (const url of [
    "https://evil.example/i/api/graphql/abc/UserTweets",
    "https://x.com/i/api/1.1/UserTweets",
    "/i/api/graphql/abc/UserTweets/extra",
  ])
    assert.equal(contract.operationName(url), null);
  assert.ok(Object.isFrozen(contract.TWEET_OPERATIONS));
});

test("owner posts parse from timeline, module and visibility-wrapped results; foreign authors drop", () => {
  const contract = loadContract();
  const wrapped = {
    __typename: "TweetWithVisibilityResults",
    tweet: tweet("102", { in_reply_to_status_id_str: "101" }),
  };
  const quote = tweet("103");
  quote.quoted_status_result = {
    result: tweet("901", { authorId: OTHER_ID, handle: "Someone_Else" }),
  };
  const repost = tweet("104", {
    full_text: "RT @Someone_Else: their words",
    retweeted_status_result: {
      result: tweet("902", { authorId: OTHER_ID, handle: "Someone_Else" }),
    },
  });
  const note = tweet("105");
  note.note_tweet = {
    note_tweet_results: { result: { text: "long ".repeat(600) } },
  };
  const result = contract.extractOwnerTweets(
    userTweets([
      tweet("101"),
      wrapped,
      { __typename: "TweetTombstone" },
      quote,
      repost,
      note,
      tweet("101"),
    ]),
    OWNER_ID,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    [...result.tweets.map((row) => row.statusId)],
    ["101", "102", "103", "104", "105"],
  );
  const first = result.tweets[0];
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    statusId: "101",
    authorId: OWNER_ID,
    authorHandle: "Owner_Handle",
    createdAt: "2026-09-27T18:04:11.000Z",
    text: "benign teaser 101",
    inReplyToStatusId: null,
    conversationId: "101",
    isRetweet: false,
    media: [
      {
        type: "video",
        mediaKey: "7_1900000000000000001",
        durationMs: 15000,
        posterUrl: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
      },
    ],
    urls: ["https://onlyfans.com/123/example"],
    metrics: {
      views: 1234,
      likes: 12,
      reposts: 3,
      replies: 4,
      quotes: 1,
      bookmarks: 5,
    },
    source: "network",
  });
  assert.equal(result.tweets[1].inReplyToStatusId, "101");
  const sanitizedRepost = result.tweets[3];
  assert.equal(sanitizedRepost.isRetweet, true);
  assert.equal(sanitizedRepost.text, "");
  assert.equal(sanitizedRepost.metrics, null);
  assert.equal(sanitizedRepost.media.length, 0);
  assert.equal(result.tweets[4].text.length, contract.MAX_TEXT);
  assert.doesNotMatch(JSON.stringify(result), /Someone_Else|their words/);
  for (const row of result.tweets)
    assert.equal(
      contract.validateBatch({
        owner: { accountId: OWNER_ID, handle: "Owner_Handle" },
        observations: [row],
      }).observations.length,
      1,
    );
});

test("TweetDetail keeps only the owner's posts from a conversation", () => {
  const contract = loadContract();
  const detail = {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              { content: item(tweet("201")) },
              {
                content: item(
                  tweet("202", { authorId: OTHER_ID, handle: "Someone_Else" }),
                ),
              },
              {
                content: item(
                  tweet("203", {
                    in_reply_to_status_id_str: "201",
                    full_text: "full vid -> onlyfans.com/123/example",
                  }),
                ),
              },
            ],
          },
        ],
      },
    },
  };
  const result = contract.extractOwnerTweets(detail, OWNER_ID);
  assert.deepEqual(
    [...result.tweets.map((row) => row.statusId)],
    ["201", "203"],
  );
  assert.deepEqual(
    [
      ...contract
        .extractOwnerTweets(detail, OTHER_ID)
        .tweets.map((row) => row.statusId),
    ],
    ["202"],
  );
});

test("schema drift and unknown owner store nothing for the response", () => {
  const contract = loadContract();
  const broken = tweet("301");
  delete broken.legacy.created_at;
  const drifted = contract.extractOwnerTweets(
    userTweets([tweet("300"), broken]),
    OWNER_ID,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(drifted)), {
    ok: false,
    reason: "schema-drift",
    tweets: [],
  });
  const badMedia = tweet("302");
  badMedia.legacy.extended_entities.media[0].type = "hologram";
  assert.equal(
    contract.extractOwnerTweets(userTweets([badMedia]), OWNER_ID).reason,
    "schema-drift",
  );
  assert.equal(
    contract.extractOwnerTweets({ data: null, errors: [{}] }, OWNER_ID).reason,
    "error-response",
  );
  assert.equal(
    contract.extractOwnerTweets([], OWNER_ID).reason,
    "schema-drift",
  );
  assert.equal(
    contract.extractOwnerTweets(userTweets([tweet("303")]), null).reason,
    "owner-unknown",
  );
  const empty = contract.extractOwnerTweets({ data: { user: {} } }, OWNER_ID);
  assert.equal(empty.ok, true);
  assert.equal(empty.tweets.length, 0);
});

test("owner identity comes from X's own cookie or viewer response", () => {
  const contract = loadContract();
  assert.equal(
    contract.ownerIdFromCookie(`lang=en; twid=u%3D${OWNER_ID}; ct0=abc`),
    OWNER_ID,
  );
  assert.equal(contract.ownerIdFromCookie(`twid="u=${OWNER_ID}"`), OWNER_ID);
  assert.equal(contract.ownerIdFromCookie("twid=u%3Dabc"), null);
  assert.equal(contract.ownerIdFromCookie("lang=en"), null);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        contract.viewerIdentity({
          data: {
            viewer: {
              user_results: user(OWNER_ID, "Owner_Handle", { modern: false }),
            },
          },
        }),
      ),
    ),
    { id: OWNER_ID, handle: "Owner_Handle" },
  );
});

function fakeElement({ attrs = {}, text = "", children = {}, closest = null }) {
  return {
    textContent: text,
    getAttribute: (name) => attrs[name] ?? null,
    querySelector: (selector) => children[selector] || null,
    closest: () => closest,
  };
}

function fakeArticle({
  href,
  datetime = "2026-09-27T18:04:11.000Z",
  label,
  video = true,
  social = false,
}) {
  const anchor = fakeElement({ attrs: { href } });
  const time = fakeElement({ attrs: { datetime }, closest: anchor });
  return fakeElement({
    children: {
      "time[datetime]": time,
      'div[role="group"][aria-label]': fakeElement({
        attrs: { "aria-label": label },
      }),
      'div[data-testid="tweetText"]': fakeElement({
        text: "benign dom teaser",
      }),
      ...(video
        ? { 'div[data-testid="videoPlayer"], video': fakeElement({}) }
        : {}),
      ...(social
        ? {
            '[data-testid="socialContext"]': fakeElement({
              text: "You reposted",
            }),
          }
        : {}),
    },
  });
}

test("DOM fallback reads metrics labels from owner articles only", () => {
  const contract = loadContract();
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        contract.parseMetricLabel(
          "12 replies, 3 reposts, 1,045 likes, 6 bookmarks, 7890 views",
        ),
      ),
    ),
    {
      views: 7890,
      likes: 1045,
      reposts: 3,
      replies: 12,
      quotes: null,
      bookmarks: 6,
    },
  );
  assert.equal(contract.parseMetricLabel("Reply"), null);
  const row = contract.extractDomArticle(
    fakeArticle({
      href: "/owner_handle/status/401",
      label: "1 reply, 0 reposts, 2 likes, 0 bookmarks, 30 views",
    }),
    "Owner_Handle",
  );
  assert.equal(row.statusId, "401");
  assert.equal(row.source, "dom");
  assert.equal(row.authorId, null);
  assert.equal(row.metrics.views, 30);
  assert.equal(row.media[0].type, "video");
  assert.equal(
    contract.validateBatch({
      owner: { accountId: null, handle: "Owner_Handle" },
      observations: [row],
    }).observations.length,
    1,
  );
  assert.equal(
    contract.extractDomArticle(
      fakeArticle({ href: "/Someone_Else/status/402", label: "1 reply" }),
      "Owner_Handle",
    ),
    null,
  );
  assert.equal(
    contract.extractDomArticle(
      fakeArticle({
        href: "/Owner_Handle/status/403",
        label: "1 reply",
        social: true,
      }),
      "Owner_Handle",
    ),
    null,
  );
  const doc = fakeElement({
    children: {
      'a[data-testid="AppTabBar_Profile_Link"]': fakeElement({
        attrs: { href: "/Owner_Handle" },
      }),
    },
  });
  assert.equal(contract.ownerHandleFromDocument(doc), "Owner_Handle");
});

function validRow(overrides = {}) {
  const contract = loadContract();
  return {
    ...contract.extractOwnerTweets(userTweets([tweet("501")]), OWNER_ID)
      .tweets[0],
    ...overrides,
  };
}

test("worker batch validation is strict and drops foreign authors", () => {
  const contract = loadContract();
  const owner = { accountId: OWNER_ID, handle: "Owner_Handle" };
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const accepted = contract.validateBatch({
    owner,
    observations: [
      plain(validRow()),
      plain(
        validRow({
          statusId: "502",
          authorId: OTHER_ID,
          authorHandle: "Owner_Handle",
        }),
      ),
      plain(
        validRow({
          statusId: "503",
          authorId: null,
          authorHandle: "Someone_Else",
          source: "dom",
        }),
      ),
    ],
  });
  assert.deepEqual(
    [...accepted.observations.map((row) => row.statusId)],
    ["501"],
  );
  assert.equal(accepted.dropped, 2);
  const invalid = [
    null,
    { owner, observations: [] },
    { owner, observations: [plain(validRow())], extra: 1 },
    {
      owner: { ...owner, handle: "bad handle" },
      observations: [plain(validRow())],
    },
    {
      owner: { accountId: 5, handle: "Owner_Handle" },
      observations: [plain(validRow())],
    },
    {
      owner,
      observations: Array.from({ length: 101 }, () => plain(validRow())),
    },
    { owner, observations: [{ ...plain(validRow()), scraped: true }] },
    { owner, observations: [plain(validRow({ authorId: null }))] },
    { owner, observations: [plain(validRow({ statusId: 501 }))] },
    { owner, observations: [plain(validRow({ text: "a".repeat(2001) }))] },
    { owner, observations: [plain(validRow({ source: "scrape" }))] },
    {
      owner,
      observations: [plain(validRow({ urls: ["javascript:alert(1)"] }))],
    },
    { owner, observations: [plain(validRow({ isRetweet: true }))] },
    {
      owner,
      observations: [
        plain(validRow({ metrics: { ...validRow().metrics, views: -1 } })),
      ],
    },
    {
      owner,
      observations: [
        plain(
          validRow({
            media: [
              {
                type: "video",
                mediaKey: null,
                durationMs: null,
                posterUrl: "https://evil.example/a.jpg",
              },
            ],
          }),
        ),
      ],
    },
  ];
  for (const batch of invalid)
    assert.throws(() => contract.validateBatch(batch), /invalid-x-batch/);
});

function pageWorld({ document, fetchImpl, XMLHttpRequest }) {
  const context = vm.createContext({
    URL,
    crypto,
    document,
    CustomEvent,
    fetch: fetchImpl,
    XMLHttpRequest,
    Symbol,
  });
  run(context, "workflows/x-collector-contract.js");
  run(context, "workflows/x-collector-page.js");
  return context;
}

function relayWorld({ document, sent }) {
  const context = vm.createContext({
    URL,
    document,
    CustomEvent,
    setTimeout: () => 0,
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          sent.push(JSON.parse(JSON.stringify(message)));
          callback?.();
        },
      },
    },
  });
  run(context, "workflows/x-collector-contract.js");
  run(context, "workflows/x-collector-relay.js");
  return context;
}

function fakeDocument() {
  const document = new EventTarget();
  document.cookie = `twid=u%3D${OWNER_ID}`;
  document.documentElement = null;
  return document;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("main-world fetch wrapper returns X's own response untouched and relays owner posts", async () => {
  const document = fakeDocument();
  const sent = [];
  relayWorld({ document, sent });
  const payload = userTweets([tweet("601"), tweet("602")]);
  const calls = [];
  let bodyReads = 0;
  const response = {
    ok: true,
    status: 200,
    json: async () => {
      bodyReads += 1;
      return payload;
    },
    clone: () => ({ json: async () => structuredClone(payload) }),
  };
  const fetchImpl = function (...args) {
    calls.push({ self: this, args });
    if (String(args[0]).includes("fail"))
      return Promise.reject(new TypeError("network down"));
    return Promise.resolve(response);
  };
  const page = pageWorld({ document, fetchImpl, XMLHttpRequest: undefined });
  const url = "https://x.com/i/api/graphql/q1/UserTweets?variables=%7B%7D";
  const init = { method: "GET", headers: { a: "b" } };
  const receiver = { marker: true };
  const returned = await page.fetch.call(receiver, url, init);
  assert.equal(
    returned,
    response,
    "X must receive the original response object.",
  );
  assert.equal(calls[0].self, receiver);
  assert.equal(calls[0].args[0], url);
  assert.equal(calls[0].args[1], init);
  assert.equal(bodyReads, 0, "The observer must read a clone, never X's body.");
  await assert.rejects(
    page.fetch("https://x.com/i/api/graphql/q1/UserTweets?fail=1"),
    /network down/,
  );
  await page.fetch("https://x.com/i/api/graphql/q2/HomeTimeline");
  await flush();
  await flush();
  const batches = sent.filter((message) => message.batch);
  assert.equal(batches.length, 1, "Only the allowlisted operation is relayed.");
  assert.equal(batches[0].type, "CREATOR_X_COLLECTOR_BATCH");
  assert.deepEqual(
    batches[0].batch.observations.map((row) => row.statusId),
    ["601", "602"],
  );
  assert.deepEqual(batches[0].batch.owner, {
    accountId: OWNER_ID,
    handle: "Owner_Handle",
  });
});

test("main-world XHR wrapper reads json and text responses without altering them", async () => {
  const document = fakeDocument();
  const sent = [];
  relayWorld({ document, sent });
  class FakeXhr extends EventTarget {
    open(method, url) {
      this.opened = [method, url];
      return "native-open";
    }
  }
  const page = pageWorld({
    document,
    fetchImpl: undefined,
    XMLHttpRequest: FakeXhr,
  });
  const jsonXhr = new page.XMLHttpRequest();
  assert.equal(
    jsonXhr.open("GET", "https://x.com/i/api/graphql/q/UserMedia?v=1"),
    "native-open",
  );
  assert.deepEqual(jsonXhr.opened, [
    "GET",
    "https://x.com/i/api/graphql/q/UserMedia?v=1",
  ]);
  Object.assign(jsonXhr, {
    status: 200,
    responseType: "json",
    response: userTweets([tweet("701")]),
  });
  jsonXhr.dispatchEvent(new Event("load"));
  const textXhr = new page.XMLHttpRequest();
  textXhr.open("GET", "https://x.com/i/api/graphql/q/TweetDetail?v=1");
  Object.assign(textXhr, {
    status: 200,
    responseType: "",
    responseText: JSON.stringify(userTweets([tweet("702")])),
  });
  textXhr.dispatchEvent(new Event("load"));
  const ignored = new page.XMLHttpRequest();
  ignored.open("GET", "https://x.com/i/api/graphql/q/SearchTimeline");
  Object.assign(ignored, {
    status: 200,
    responseType: "json",
    response: userTweets([tweet("703")]),
  });
  ignored.dispatchEvent(new Event("load"));
  const drifted = new page.XMLHttpRequest();
  drifted.open("GET", "https://x.com/i/api/graphql/q/UserTweets");
  const broken = tweet("704");
  delete broken.rest_id;
  Object.assign(drifted, {
    status: 200,
    responseType: "json",
    response: userTweets([broken]),
  });
  drifted.dispatchEvent(new Event("load"));
  await flush();
  assert.deepEqual(
    sent
      .filter((message) => message.batch)
      .map((message) => message.batch.observations[0].statusId),
    ["701", "702"],
  );
  assert.deepEqual(
    sent
      .filter((message) => message.diagnostic)
      .map((message) => message.diagnostic),
    [{ operation: "UserTweets", reason: "schema-drift" }],
  );
});

test("relay locks onto one nonce and ignores spoofed page events", () => {
  const document = fakeDocument();
  const sent = [];
  relayWorld({ document, sent });
  const emit = (detail) =>
    document.dispatchEvent(
      new CustomEvent("creator-x-collector", {
        detail: JSON.stringify(detail),
      }),
    );
  const batch = {
    owner: { accountId: OWNER_ID, handle: "Owner_Handle" },
    observations: [JSON.parse(JSON.stringify(validRow()))],
  };
  emit({ kind: "batch", nonce: "a".repeat(32), batch });
  assert.equal(sent.length, 0, "No batch is relayed before the handshake.");
  emit({ kind: "hello", nonce: "a".repeat(32) });
  emit({ kind: "hello", nonce: "b".repeat(32) });
  emit({ kind: "batch", nonce: "b".repeat(32), batch });
  emit({ kind: "batch", batch });
  assert.equal(sent.length, 0, "A second hello cannot replace the nonce.");
  emit({ kind: "batch", nonce: "a".repeat(32), batch });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].batch.observations[0].statusId, "501");
});

test("page and relay complete the handshake in either load order", async () => {
  for (const pageFirst of [true, false]) {
    const document = fakeDocument();
    const sent = [];
    const response = {
      ok: true,
      clone: () => ({ json: async () => userTweets([tweet("801")]) }),
    };
    const fetchImpl = async () => response;
    let page;
    if (pageFirst) {
      page = pageWorld({ document, fetchImpl, XMLHttpRequest: undefined });
      relayWorld({ document, sent });
    } else {
      relayWorld({ document, sent });
      page = pageWorld({ document, fetchImpl, XMLHttpRequest: undefined });
    }
    // A late spoofed "ready" cannot make the page reveal its nonce again.
    const hellos = [];
    document.addEventListener("creator-x-collector", (event) => {
      if (JSON.parse(event.detail).kind === "hello") hellos.push(event);
    });
    document.dispatchEvent(
      new CustomEvent("creator-x-collector", {
        detail: JSON.stringify({ kind: "ready" }),
      }),
    );
    assert.equal(hellos.length, 0);
    await page.fetch("https://x.com/i/api/graphql/q/UserTweets");
    await flush();
    await flush();
    assert.equal(
      sent.filter((message) => message.batch).length,
      1,
      `pageFirst=${pageFirst}`,
    );
  }
});

test("worker forwarder validates, bounds and forwards small desktop batches", async () => {
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
  const forwarded = [];
  let failNext = false;
  let timer = null;
  const forwarder = context.CreatorXCollectorForwarder.create({
    contract,
    send: async (batch) => {
      if (failNext) {
        failNext = false;
        throw new Error("desktop-unavailable");
      }
      forwarded.push(JSON.parse(JSON.stringify(batch)));
      return {};
    },
    setTimer: (callback) => {
      timer = callback;
      return 1;
    },
  });
  const owner = { accountId: OWNER_ID, handle: "Owner_Handle" };
  const rows = Array.from({ length: 60 }, (_, index) =>
    JSON.parse(
      JSON.stringify(
        validRow({ statusId: String(1000 + index), conversationId: null }),
      ),
    ),
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        forwarder.accept({ batch: { owner, observations: rows } }),
      ),
    ),
    { queued: 60 },
  );
  forwarder.accept({ batch: { owner, observations: rows.slice(0, 5) } });
  assert.equal(forwarder.size(), 60, "Repeat sightings replace queued rows.");
  assert.throws(
    () => forwarder.accept({ batch: { owner, observations: [{}] } }),
    /invalid-x-batch/,
  );
  assert.throws(
    () =>
      forwarder.accept({
        diagnostic: { operation: "HomeTimeline", reason: "schema-drift" },
      }),
    /invalid-x-diagnostic/,
  );
  forwarder.accept({
    diagnostic: { operation: "UserTweets", reason: "schema-drift" },
  });
  assert.equal(typeof timer, "function");
  timer();
  await forwarder.flush();
  assert.deepEqual(
    forwarded.map((batch) => batch.observations.length),
    [25, 25, 10],
  );
  assert.ok(forwarded.every((batch) => batch.owner.accountId === OWNER_ID));
  failNext = true;
  forwarder.accept({ batch: { owner, observations: rows.slice(0, 1) } });
  await forwarder.flush();
  const diagnostics = forwarder.diagnostics();
  assert.equal(diagnostics.rowsForwarded, 60);
  assert.equal(diagnostics.desktopFailures, 1);
  assert.equal(diagnostics.batchesRejected, 1);
  assert.equal(diagnostics.pageReasons["UserTweets:schema-drift"], 1);
  assert.equal(
    forwarder.size(),
    0,
    "Undeliverable rows are dropped, not retried in a loop.",
  );
});

test("the collector is registered dynamically: main world at document_start plus an isolated relay", () => {
  const background = fs.readFileSync(
    path.join(repositoryRoot, "background.js"),
    "utf8",
  );
  assert.match(
    background,
    /"workflows\/x-collector-contract\.js",\s*"workflows\/x-collector-forwarder\.js"/,
  );
  assert.match(background, /case "CREATOR_X_COLLECTOR_BATCH":/);
  assert.match(
    background,
    /sendDesktopRequest\("recordXObservations", batch\)/,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8"),
  );
  assert.equal(JSON.stringify(manifest).includes("x-collector"), false);
});

test("relay DOM fallback reports owner articles once and stops after network data", () => {
  const document = fakeDocument();
  const articles = [
    fakeArticle({
      href: "/Owner_Handle/status/901",
      label: "1 reply, 0 reposts, 2 likes, 0 bookmarks, 30 views",
    }),
    fakeArticle({ href: "/Someone_Else/status/902", label: "5 likes" }),
  ];
  document.documentElement = {};
  document.querySelector = (selector) =>
    selector === 'a[data-testid="AppTabBar_Profile_Link"]'
      ? fakeElement({ attrs: { href: "/Owner_Handle" } })
      : null;
  document.querySelectorAll = (selector) =>
    selector === "article" ? articles : [];
  const timers = [];
  let mutationCallback = null;
  const sent = [];
  const context = vm.createContext({
    URL,
    document,
    CustomEvent,
    setTimeout: (callback) => timers.push(callback),
    MutationObserver: class {
      constructor(callback) {
        mutationCallback = callback;
      }
      observe() {}
    },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          sent.push(JSON.parse(JSON.stringify(message)));
          callback?.();
        },
      },
    },
  });
  run(context, "workflows/x-collector-relay-contract.js");
  run(context, "workflows/x-collector-relay.js");
  mutationCallback();
  assert.equal(timers.length, 1, "No DOM scan before the fallback delay.");
  timers.shift()();
  timers.shift()();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].batch.owner, {
    accountId: null,
    handle: "Owner_Handle",
  });
  assert.deepEqual(
    sent[0].batch.observations.map((row) => [
      row.statusId,
      row.source,
      row.metrics.likes,
    ]),
    [["901", "dom", 2]],
  );
  mutationCallback();
  timers.shift()();
  assert.equal(sent.length, 1, "Unchanged articles are not re-sent.");
  const nonce = "c".repeat(32);
  const emit = (detail) =>
    document.dispatchEvent(
      new CustomEvent("creator-x-collector", {
        detail: JSON.stringify(detail),
      }),
    );
  emit({ kind: "hello", nonce });
  emit({
    kind: "batch",
    nonce,
    batch: {
      owner: { accountId: OWNER_ID, handle: "Owner_Handle" },
      observations: [],
    },
  });
  articles[0] = fakeArticle({
    href: "/Owner_Handle/status/901",
    label: "9 likes",
  });
  mutationCallback();
  assert.equal(timers.length, 0, "Network data disables the DOM fallback.");
  assert.equal(sent.length, 2);
});
