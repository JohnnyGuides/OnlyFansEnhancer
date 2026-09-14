const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  let timers = 0;
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
