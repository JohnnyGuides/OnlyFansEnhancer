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
  for (const name of [
    "UserOriginalsTimeline",
    "UserRepliesTimeline",
    "UserVideoTimeline",
  ])
    assert.equal(contract.operationKind(name), "tweets");
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

test("metric labels and the owner profile link parse without page access", () => {
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
  const link = { getAttribute: () => "/Owner_Handle" };
  assert.equal(
    contract.ownerHandleFromDocument({ querySelector: () => link }),
    "Owner_Handle",
  );
});

test("metric labels yield exact counts only, never approximations", () => {
  const contract = loadContract();
  const parse = (label) =>
    JSON.parse(JSON.stringify(contract.parseMetricLabel(label)));
  assert.deepEqual(parse("1,234 likes, 12,345,678 views"), {
    views: 12345678,
    likes: 1234,
    reposts: null,
    replies: null,
    quotes: null,
    bookmarks: null,
  });
  // Abbreviated or decimal figures stay unknown instead of becoming numbers.
  assert.deepEqual(parse("1.2K likes, 12.5 views, 3 replies"), {
    views: null,
    likes: null,
    reposts: null,
    replies: 3,
    quotes: null,
    bookmarks: null,
  });
  assert.equal(contract.parseMetricLabel("12,5 views"), null);
  assert.equal(contract.parseMetricLabel("4 K views"), null);
});

test("scan previews mirror the parsed post and the worker keeps only exact, safe ones", () => {
  const contract = loadContract();
  const tweet = {
    statusId: "501",
    createdAt: "2026-09-30T10:00:00.000Z",
    text: "benign   preview\ntext",
    inReplyToStatusId: null,
    isRetweet: false,
    media: [
      {
        type: "photo",
        mediaKey: null,
        durationMs: null,
        posterUrl: "https://pbs.twimg.com/media/photo.jpg",
      },
      {
        type: "video",
        mediaKey: null,
        durationMs: 1000,
        posterUrl: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg",
      },
    ],
    metrics: {
      views: 4321,
      likes: 21,
      reposts: 3,
      replies: 2,
      quotes: 0,
      bookmarks: null,
    },
  };
  const preview = JSON.parse(JSON.stringify(contract.scanPreview(tweet)));
  assert.deepEqual(preview, {
    statusId: "501",
    postedUtc: "2026-09-30T10:00:00.000Z",
    kind: "post",
    text: "benign preview text",
    mediaType: "video",
    posterUrl: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg",
    metrics: tweet.metrics,
  });
  assert.equal(
    contract.scanPreview({ ...tweet, inReplyToStatusId: "1" }).kind,
    "reply",
  );
  assert.equal(
    contract.scanPreview({ ...tweet, isRetweet: true, metrics: null }).kind,
    "repost",
  );
  const kept = (rows) =>
    JSON.parse(JSON.stringify(contract.validScanPreviews(rows)));
  assert.deepEqual(kept([preview]), [preview]);
  for (const bad of [
    { ...preview, posterUrl: "https://example.com/a.jpg" },
    { ...preview, posterUrl: "http://pbs.twimg.com/a.jpg" },
    { ...preview, metrics: { ...preview.metrics, views: 12.5 } },
    { ...preview, metrics: { ...preview.metrics, views: "4321" } },
    { ...preview, metrics: { views: 1 } },
    { ...preview, statusId: "x1" },
    { ...preview, postedUtc: "yesterday" },
    { ...preview, kind: "ad" },
    { ...preview, extra: true },
    { ...preview, text: "x".repeat(contract.MAX_PREVIEW_TEXT + 1) },
  ])
    assert.deepEqual(kept([bad]), []);
  // Duplicates and anything past the cap are dropped; non-arrays give none.
  assert.equal(kept([preview, preview]).length, 1);
  assert.equal(
    kept(
      Array.from({ length: contract.MAX_SCAN_PREVIEWS + 5 }, (_, index) => ({
        ...preview,
        statusId: String(1000 + index),
      })),
    ).length,
    contract.MAX_SCAN_PREVIEWS,
  );
  assert.deepEqual(kept(null), []);
});

test("text is capped on a code-point boundary", () => {
  const contract = loadContract();
  const emoji = "\u{1F600}";
  const note = tweet("106");
  note.note_tweet = {
    note_tweet_results: { result: { text: "a".repeat(1999) + emoji + "b" } },
  };
  const [row] = contract.extractOwnerTweets(
    userTweets([note]),
    OWNER_ID,
  ).tweets;
  assert.equal(row.text, "a".repeat(1999));
  assert.doesNotMatch(row.text, /[\uD800-\uDFFF]/);
  const exact = tweet("107", { full_text: "a".repeat(1998) + emoji + "b" });
  const [kept] = contract.extractOwnerTweets(
    userTweets([exact]),
    OWNER_ID,
  ).tweets;
  assert.equal(kept.text, "a".repeat(1998) + emoji);
  assert.equal(kept.text.length, contract.MAX_TEXT);
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

function pageWorld({ document, fetchImpl, XMLHttpRequest }) {
  const context = vm.createContext({
    URL,
    crypto,
    document,
    CustomEvent,
    MessageEvent,
    MessageChannel: TrackedChannel,
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

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
  // A reused object first opened for an unwatched URL is still observed on a
  // later watched open, and each load is read once.
  const reused = new page.XMLHttpRequest();
  reused.open("GET", "https://x.com/i/api/graphql/q/SearchTimeline");
  reused.open("GET", "https://x.com/i/api/graphql/q/UserTweets");
  reused.open("GET", "https://x.com/i/api/graphql/q/UserTweets");
  Object.assign(reused, {
    status: 200,
    responseType: "json",
    response: userTweets([tweet("705")]),
  });
  reused.dispatchEvent(new Event("load"));
  reused.dispatchEvent(new Event("load"));
  await flush();
  assert.deepEqual(
    sent
      .filter((message) => message.batch)
      .map((message) => message.batch.observations[0].statusId),
    ["701", "702", "705"],
  );
  assert.deepEqual(
    sent
      .filter((message) => message.diagnostic)
      .map((message) => message.diagnostic),
    [{ operation: "UserTweets", reason: "schema-drift" }],
  );
});

test("relay takes exactly one private port and ignores page-visible events", async () => {
  const document = fakeDocument();
  const sent = [];
  relayWorld({ document, sent });
  const batch = {
    owner: { accountId: OWNER_ID, handle: "Owner_Handle" },
    observations: [JSON.parse(JSON.stringify(validRow()))],
  };
  const locked = [];
  document.addEventListener("creator-x-collector", (event) => {
    if (event.detail && JSON.parse(event.detail).kind === "locked")
      locked.push(true);
  });
  const offer = () => {
    const channel = new TrackedChannel();
    document.dispatchEvent(
      new MessageEvent("creator-x-collector", {
        data: JSON.stringify({ kind: "hello" }),
        ports: [channel.port2],
      }),
    );
    return channel.port1;
  };
  // Page-visible events never carry batches any more.
  document.dispatchEvent(
    new CustomEvent("creator-x-collector", {
      detail: JSON.stringify({ kind: "batch", batch }),
    }),
  );
  const first = offer();
  const second = offer();
  assert.equal(locked.length, 1);
  second.postMessage({ kind: "batch", batch });
  await flush();
  assert.equal(sent.length, 0, "A later port cannot replace the first.");
  first.postMessage({ kind: "batch", batch });
  first.postMessage({
    kind: "diagnostic",
    operation: "UserTweets",
    reason: "schema-drift",
  });
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].batch.observations[0].statusId, "501");
  assert.deepEqual(sent[1].diagnostic, {
    operation: "UserTweets",
    reason: "schema-drift",
  });
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
    // A late spoofed "ready" cannot make the page offer its port again.
    const hellos = [];
    document.addEventListener("creator-x-collector", (event) => {
      if (event.ports?.length) hellos.push(event);
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
        const code = failNext === true ? "desktop-unavailable" : failNext;
        failNext = false;
        throw new Error(code);
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
  failNext = "x-owner-mismatch";
  forwarder.accept({ batch: { owner, observations: rows.slice(0, 2) } });
  await forwarder.flush();
  const diagnostics = forwarder.diagnostics();
  assert.equal(diagnostics.ownerMismatchRows, 2);
  assert.equal(diagnostics.lastOwnerMismatchHandle, "Owner_Handle");
  assert.match(diagnostics.lastOwnerMismatchUtc, /^\d{4}-/);
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
