"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { chromium } = require("../support/browser.cjs");
const root = path.resolve(__dirname, "../../extensions/personal");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
const canonical = "https://pornhub.mainhub.com/upload/uploader?site=ph";
const entry = "https://www.pornhub.com/upload/videodata";
function span(start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  const to = source.indexOf(end, from);
  assert.ok(to > from, end);
  return source.slice(from, to);
}
const definitions = span(
  "const CREATOR_UPLOAD_TARGETS =",
  "const CREATOR_UPLOAD_PROBE_FILE",
);
const prepare = span(
  "async function prepareCreatorUploadPlatform(",
  "async function verifyCreatorManyVidsEditor(",
);
const helperStart = source.indexOf("function creatorPornhubUploaderRoute(");
const helpers =
  helperStart < 0
    ? ""
    : source.slice(
        helperStart,
        source.indexOf(
          "async function prepareCreatorUploadPlatform(",
          helperStart,
        ),
      );
// Contract fixtures: no live network, authentication, file assignment, or publication.
async function fixture(
  page,
  {
    url = canonical,
    body = '<section aria-label="Video upload"><button type="button" class="uploadButton">Upload from Device</button><input class="dz-hidden-input" type="file" hidden></section>',
    replaceDocument = false,
  } = {},
) {
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
  await page.goto(url);
  // Advance only the bounded DOM-readiness deadline after its first probe.
  await page.evaluate(() => {
    const now = Date.now.bind(Date);
    let reads = 0;
    Date.now = () => now() + Math.max(0, ++reads - 2) * 31000;
  });
  let frame = { frameId: 0, documentId: "uploader-document", url };
  const events = [];
  const session = {
    id: "fixture-session",
    draft: { hasTeaser: false },
    platforms: new Map(),
  };
  const bridge = function installCreatorUploadFileBridge() {};
  const context = vm.createContext({
    URL,
    Date,
    Map,
    setTimeout,
    clearTimeout,
    creatorUploadRandomToken: () => "fixture-role-token",
    checkpointCreatorUploadSession: async () => events.push("checkpoint"),
    waitForCreatorTab: async () => {},
    creatorUrlMatches: (value, definition) =>
      new URL(value).origin === definition.origin,
    CREATOR_UPLOAD_FILE_BRIDGE: "workflows/upload-file-bridge.js",
    CREATOR_UPLOAD_ADAPTERS: "workflows/upload-platform-adapters.js",
    markCreatorToolkitMasterRun: function markCreatorToolkitMasterRun() {
      globalThis.CreatorToolkitMasterRun = true;
    },
    installCreatorUploadFileBridge: bridge,
    chrome: {
      tabs: {
        query: async () => [],
        create: async ({ url: requested }) => {
          events.push("navigate:" + requested);
          return { id: 77, url: requested };
        },
        get: async () => ({ id: 77, url: frame.url, status: "complete" }),
      },
      webNavigation: { getAllFrames: async () => [{ ...frame }] },
      runtime: {
        getURL: (relative) => "chrome-extension://fixture/" + relative,
      },
      scripting: {
        executeScript: async (details) => {
          assert.deepEqual(Array.from(details.target.documentIds), [
            frame.documentId,
          ]);
          if (details.files) {
            await page.addScriptTag({
              path: path.join(root, "workflows/upload-platform-adapters.js"),
            });
            return [{ frameId: 0, documentId: frame.documentId }];
          }
          if (details.func === bridge) {
            events.push("bridge");
            return [{ frameId: 0, documentId: frame.documentId }];
          }
          const result = await page.evaluate(
            ({ code, args }) => (0, eval)("(" + code + ")")(...args),
            { code: details.func.toString(), args: details.args || [] },
          );
          const returned = [
            { result, frameId: 0, documentId: frame.documentId },
          ];
          if (details.func.toString().includes("inspectPornhubUploader")) {
            events.push("capability");
            if (replaceDocument)
              frame = { ...frame, documentId: "replacement-document" };
          }
          return returned;
        },
      },
    },
  });
  vm.runInContext(definitions + helpers + prepare, context);
  return {
    events,
    session,
    run: () => context.prepareCreatorUploadPlatform(session, "pornhub"),
    context,
    changeFrame: (changes) => {
      frame = { ...frame, ...changes };
    },
  };
}
for (const url of [canonical, "https://pornhub.mainhub.com/upload/uploader"]) {
  test(
    "Pornhub acquisition binds the exact capable resolved route: " +
      new URL(url).search,
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const f = await fixture(await browser.newPage(), { url });
        const target = await f.run();
        assert.equal(f.events[0], "navigate:" + entry);
        assert.equal(target.boundUrl, url);
        assert.equal(target.documentId, "uploader-document");
        assert.ok(f.events.indexOf("capability") >= 0);
        assert.ok(f.events.indexOf("bridge") > f.events.indexOf("capability"));
        assert.equal(f.session.platforms.get("pornhub"), target);
      } finally {
        await browser.close();
      }
    },
  );
}
for (const scenario of [
  {
    name: "ordinary MainHub page",
    url: "https://pornhub.mainhub.com/dashboard",
    error: /uploader.*route|uploader.*page/i,
  },
  {
    name: "non-uploader at uploader URL",
    body: "<h1>Dashboard</h1>",
    error: /device.*upload|uploader.*capability/i,
  },
  {
    name: "login document",
    url: "https://pornhub.mainhub.com/login",
    body: '<input type="password">',
    error: /authenticat|sign in/i,
  },
  {
    name: "login surface on uploader route",
    body: '<input type="password"><button class="uploadButton">Upload from Device</button>',
    error: /authenticat|sign in/i,
  },
  {
    name: "untrusted redirect",
    url: "https://untrusted.example/upload/uploader",
    error: /origin|untrusted/i,
  },
  {
    name: "ambiguous device actions",
    body: '<button class="uploadButton">Upload from Device</button><button class="uploadButton">Select video</button>',
    error: /candidates|ambiguous/i,
  },
  {
    name: "document replaced during capability validation",
    replaceDocument: true,
    error: /document.*changed|binding.*changed/i,
  },
  {
    name: "unexpected query",
    url: canonical + "&foreign=1",
    error: /uploader.*route|uploader.*page/i,
  },
]) {
  test(
    "Pornhub acquisition rejects " +
      scenario.name +
      " before bridge installation",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const f = await fixture(await browser.newPage(), scenario);
        await assert.rejects(f.run(), scenario.error);
        assert.equal(f.events.includes("bridge"), false);
        assert.equal(f.session.platforms.size, 0);
      } finally {
        await browser.close();
      }
    },
  );
}

test("Pornhub execution stays bound after a capable uploader has been acquired", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const f = await fixture(await browser.newPage());
    const target = await f.run();
    const port = {};
    f.session.executionPort = port;
    f.context.creatorUploadPort = () => port;
    vm.runInContext(
      span(
        "async function assertCreatorUploadPageBinding(",
        "function creatorUploadSessionRecord(",
      ),
      f.context,
    );
    const sender = {
      frameId: 0,
      documentId: target.documentId,
      tab: { id: target.tabId },
      url: target.boundUrl,
    };
    const check = (candidate) =>
      f.context.assertCreatorUploadPageBinding(
        f.session,
        target,
        candidate || sender,
      );
    await check();
    f.changeFrame({ documentId: "foreign-document" });
    await assert.rejects(check(), /binding-changed/);
    f.changeFrame({
      documentId: target.documentId,
      url: "https://pornhub.mainhub.com/upload/uploader",
    });
    await assert.rejects(check(), /binding-changed/);
    await assert.rejects(
      check({ ...sender, url: "https://pornhub.mainhub.com/upload/uploader" }),
      /route-mismatch/,
    );
    f.changeFrame({ url: target.boundUrl });
    await assert.rejects(check({ ...sender, frameId: 1 }), /unauthorized/);
    await assert.rejects(check({ ...sender, tab: { id: 88 } }), /unauthorized/);
    f.session.executionPort = {};
    await assert.rejects(check(), /connection-changed/);
    f.session.executionPort = port;
    f.session.cancelled = true;
    await assert.rejects(check(), /unauthorized/);
    assert.equal(target.boundUrl, canonical);
  } finally {
    await browser.close();
  }
});

for (const scenario of [
  {
    name: "disabled device control",
    body: '<section><button class="uploadButton" disabled>Upload from Device</button><input class="dz-hidden-input" type="file" hidden></section>',
  },
  {
    name: "conflicting source identity",
    body: '<section><button class="uploadButton" aria-label="Upload from Device" title="From Vault">Upload from Device</button><input class="dz-hidden-input" type="file" hidden></section>',
  },
]) {
  test(`Pornhub never binds an uploader with ${scenario.name}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const f = await fixture(await browser.newPage(), scenario);
      await assert.rejects(f.run(), /unavailable|candidates|conflict/i);
      assert.equal(f.events.includes("bridge"), false);
      assert.equal(f.session.platforms.size, 0);
    } finally {
      await browser.close();
    }
  });
}

test("Pornhub waits through the session entry before injecting into the exact uploader document", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const f = await fixture(await browser.newPage());
    const getFrames = f.context.chrome.webNavigation.getAllFrames;
    let polls = 0;
    f.context.chrome.webNavigation.getAllFrames = async () => {
      if (++polls <= 2) {
        assert.equal(f.events.includes("capability"), false);
        assert.equal(f.events.includes("bridge"), false);
        return [
          { frameId: 0, documentId: "session-entry-document", url: entry },
        ];
      }
      return getFrames();
    };
    const target = await f.run();
    assert.ok(polls >= 3);
    assert.equal(target.documentId, "uploader-document");
    assert.equal(target.boundUrl, canonical);
    assert.equal(
      f.events.filter((event) => event.startsWith("navigate:")).length,
      1,
    );
  } finally {
    await browser.close();
  }
});
