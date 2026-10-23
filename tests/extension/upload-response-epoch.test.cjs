const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  let timers = 0;
  const events = [];
  class Xhr {
    listeners = [];
    addEventListener(_name, listener) {
      this.listeners.push(listener);
    }
    open() {}
    complete(payload) {
      this.status = 201;
      this.responseType = "json";
      this.response = payload;
      this.listeners.forEach((listener) => listener());
    }
  }
  const context = vm.createContext({
    URL,
    location: { href: "https://fansly.com/home" },
    XMLHttpRequest: Xhr,
    document: {
      dispatchEvent: (event) => events.push(JSON.parse(event.detail)),
    },
    CustomEvent: class {
      constructor(_name, options) {
        this.detail = options.detail;
      }
    },
    setTimeout() {
      timers++;
      return timers;
    },
    clearTimeout() {},
  });
  for (const file of ["catalogue-contract.js", "upload-response-observer.js"])
    vm.runInContext(
      fs.readFileSync(
        path.resolve(__dirname, "../../extensions/personal/workflows", file),
        "utf8",
      ),
      context,
    );
  return {
    api: context.CreatorUploadResponseObserver,
    Xhr,
    timers: () => timers,
    events,
  };
}

test("only requests opened after final arming can produce a receipt", async () => {
  const { api, Xhr, timers } = load();
  const sessionId = "epoch-session-123456";
  let settled = false;
  const result = api
    .install({ sessionId, platform: "fansly", deferred: true })
    .then((value) => {
      settled = true;
      return value;
    });
  assert.equal(
    timers(),
    0,
    "long preparation must not consume the final response timeout",
  );
  const old = new Xhr();
  old.open("POST", "https://apiv3.fansly.com/api/v1/post");
  assert.equal(api.arm(sessionId, "fansly"), true);
  assert.equal(
    api.arm(sessionId, "fansly"),
    false,
    "the final epoch cannot be rearmed",
  );
  old.complete({ response: { id: "111111111" } });
  await Promise.resolve();
  assert.equal(settled, false);
  const current = new Xhr();
  current.open("POST", "https://apiv3.fansly.com/api/v1/post");
  current.complete({ response: { id: "987654321" } });
  assert.equal((await result).postUrl, "https://fansly.com/post/987654321");
});

// Sanitized shape observed from Fansly's post API, including the account-media
// indirection. The attachment's contentId is not the player's mediaId.
function fanslyPayload() {
  return {
    success: true,
    response: {
      posts: [
        {
          id: "956588460972449792",
          attachments: [
            {
              postId: "956588460972449792",
              pos: 0,
              contentType: 1,
              contentId: "956588460381073408",
            },
          ],
        },
      ],
      accountMedia: [
        {
          id: "956588460381073408",
          mediaId: "956574905413943296",
          previewId: "956367201055547392",
          media: { id: "956574905413943296", type: 2, mimetype: "video/mp4" },
        },
      ],
    },
  };
}

async function receipt(payload) {
  const { api, Xhr } = load();
  const observed = api.install({
    sessionId: "media-session-123456",
    platform: "fansly",
  });
  const xhr = new Xhr();
  xhr.open("POST", "https://apiv3.fansly.com/api/v1/post");
  xhr.complete(payload);
  return observed;
}

test("Fansly receipt binds the attached video through accountMedia, not previews or unrelated media", async () => {
  const payload = fanslyPayload();
  payload.response.accountMedia.push({
    id: "111111111",
    mediaId: "222222222",
    media: { id: "222222222", type: 2, mimetype: "video/mp4" },
  });
  const result = await receipt(payload);
  assert.equal(result.postUrl, "https://fansly.com/post/956588460972449792");
  assert.equal(result.fanslyMediaId, "956574905413943296");
});

test("Fansly self-contained post response shapes preserve the attachment binding", async () => {
  for (const shape of ["post", "root"]) {
    const payload = fanslyPayload();
    const post = payload.response.posts[0];
    delete payload.response.posts;
    if (shape === "post") payload.response.post = post;
    else Object.assign(payload.response, post);
    assert.equal((await receipt(payload)).fanslyMediaId, "956574905413943296");
  }
});

test("Fansly media capture rejects missing, ambiguous, unsafe and incorrectly owned IDs", async () => {
  const variants = [
    (p) => {
      p.response.accountMedia = [];
    },
    (p) => {
      p.response.accountMedia.push(structuredClone(p.response.accountMedia[0]));
    },
    (p) => {
      p.response.posts[0].attachments[0].postId = "111111111";
    },
    (p) => {
      p.response.accountMedia[0].mediaId = 956574905413943296;
    },
    (p) => {
      p.response.accountMedia[0].media.id = "111111111";
    },
    (p) => {
      p.response.accountMedia[0].media.type = 1;
    },
    (p) => {
      p.response.accountMedia[0].media.mimetype = "image/jpeg";
    },
    (p) => {
      p.response.posts[0].attachments.push({
        postId: p.response.posts[0].id,
        contentType: 1,
        contentId: "111111111",
      });
      p.response.accountMedia.push({
        id: "111111111",
        mediaId: "222222222",
        media: { id: "222222222", type: 2, mimetype: "video/mp4" },
      });
    },
  ];
  for (const mutate of variants) {
    const payload = fanslyPayload();
    mutate(payload);
    assert.equal((await receipt(payload)).fanslyMediaId, undefined);
  }
});

test("Fansly post arrays reject errors and multiple posts without harvesting attachment postIds", async () => {
  for (const mutate of [
    (p) => {
      p.success = false;
    },
    (p) => {
      p.response.error = "failed";
    },
    (p) => {
      p.response.posts.push({ id: "111111111" });
    },
    (p) => {
      p.response.posts[0].id = 956588460972449792;
    },
  ]) {
    const payload = fanslyPayload();
    mutate(payload);
    const result = await receipt(payload);
    assert.equal(result.postUrl, null);
    assert.equal(result.fanslyMediaId, undefined);
  }
});

test("an unresolved second attachment cannot make the first video appear unique", async () => {
  for (const media of [
    undefined,
    { type: 2 },
    { type: 2, mimetype: "image/jpeg" },
  ]) {
    const payload = fanslyPayload();
    payload.response.posts[0].attachments.push({
      postId: "956588460972449792",
      contentType: 1,
      contentId: "111111111",
    });
    payload.response.accountMedia.push({
      id: "111111111",
      mediaId: "222222222",
      media,
    });
    assert.equal((await receipt(payload)).fanslyMediaId, undefined);
  }
});

test("Fansly manual watch forwards media identity only from its armed request", async () => {
  const { api, Xhr, events } = load();
  const stale = new Xhr();
  stale.open("POST", "https://apiv3.fansly.com/api/v1/post");
  api.watch({
    sessionId: "media-session-123456",
    platform: "fansly",
    watchId: "a".repeat(32),
    expectedMediaIds: ["956574905413943296"],
  });
  stale.complete(fanslyPayload());
  await Promise.resolve();
  assert.equal(events.length, 0);
  const current = new Xhr();
  current.open("POST", "https://apiv3.fansly.com/api/v1/post");
  current.complete(fanslyPayload());
  await Promise.resolve();
  assert.equal(events.length, 1);
  assert.equal(events[0].fanslyMediaId, "956574905413943296");
  assert.equal(events[0].outcome, "captured");
});

test("application errors and conflicting contextual identities cannot authorize a link", () => {
  const { api } = load();
  assert.equal(
    api.extractPostUrl("fansly", {
      response: { success: false, id: "987654321" },
    }),
    null,
  );
  assert.equal(
    api.extractPostUrl("fansly", {
      postId: "987654321",
      response: { id: "111111111" },
    }),
    null,
  );
  assert.equal(
    api.extractPostUrl("fansly", {
      postId: "987654321",
      media: { id: "111111111" },
    }),
    "https://fansly.com/post/987654321",
  );
});
