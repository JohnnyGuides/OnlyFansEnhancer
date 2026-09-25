"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const adapter = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-platform-adapters.js",
);

test("reconstructed Device/Vault surface resolves Device and rejects duplicate intended actions", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<section aria-label="Video Upload"><button class="uploadButton">Upload from Device</button><button class="uploadButton">Upload from Vault</button></section><button class="uploadButton">Upload avatar</button>',
    );
    await page.addScriptTag({ path: adapter });
    assert.deepEqual(
      await page.evaluate(async () => {
        let clicks = 0;
        document.querySelector("button").onclick = () => {
          clicks++;
          const input = document.createElement("input");
          input.type = "file";
          input.hidden = true;
          input.className = "dz-hidden-input";
          document.body.append(input);
          input.click();
        };
        const input =
          await CreatorUploadPlatformAdapters.activatePornhubUploader();
        document
          .querySelector("section")
          .insertAdjacentHTML(
            "beforeend",
            '<button class="uploadButton">Upload from Device</button>',
          );
        let error;
        try {
          await CreatorUploadPlatformAdapters.activatePornhubUploader();
        } catch (e) {
          error = e.message;
        }
        return { clicks, connected: input.isConnected, error };
      }),
      {
        clicks: 1,
        connected: true,
        error: "Pornhub device upload candidates: 2.",
      },
    );
  } finally {
    await browser.close();
  }
});

for (const relationship of ["form", "aria-controls"])
  test(`reconstructed OnlyFans delayed external toolbar: ${relationship}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<form id="new-post"><div id="caption" role="textbox" contenteditable="true" class="tiptap ProseMirror"></div></form><input id="file_upload_input" type="file" hidden>',
      );
      await page.addScriptTag({ path: adapter });
      const result = await page.evaluate(async (relationship) => {
        let attached = 0;
        const timer = setTimeout(
          () =>
            document.body.insertAdjacentHTML(
              "beforeend",
              '<button id="attach_file_photo" aria-label="Add media" ' +
                (relationship === "form"
                  ? 'form="new-post"'
                  : 'aria-controls="caption"') +
                ">Media</button>",
            ),
          150,
        );
        try {
          await CreatorUploadPlatformAdapters.runOnlyFans({
            draft: {},
            attachFile: async () => {
              attached++;
              throw new Error("fixture-stop-after-owned-toolbar");
            },
          });
        } catch (e) {
          return { attached, error: e.message };
        } finally {
          clearTimeout(timer);
        }
      }, relationship);
      assert.deepEqual(result, {
        attached: 1,
        error: "fixture-stop-after-owned-toolbar",
      });
    } finally {
      await browser.close();
    }
  });

test("OnlyFans foreign/duplicate editors fail before attachment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<form><div role="textbox" class="tiptap ProseMirror">one</div></form><form><div role="textbox" class="tiptap ProseMirror">two</div></form>',
    );
    await page.addScriptTag({ path: adapter });
    assert.match(
      await page.evaluate(() => {
        try {
          CreatorUploadPlatformAdapters.resolveOnlyFansComposer();
        } catch (e) {
          return e.message;
        }
      }),
      /candidates: 2/,
    );
  } finally {
    await browser.close();
  }
});

test("Fansly alias authorization retains exact composer, frame, document and connection", async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../extensions/personal/background.js"),
    "utf8",
  );
  const start = source.indexOf(
    "async function assertCreatorUploadPageBinding(",
  );
  const end = source.indexOf("\nfunction creatorUploadSessionRecord", start);
  const port = {};
  let currentPort = port;
  let owned = true;
  const documentId = "11111111-1111-4111-8111-111111111111";
  let frame = { frameId: 0, documentId, url: "https://fansly.com/home" };
  const context = vm.createContext({
    creatorUploadPort: () => currentPort,
    chrome: {
      webNavigation: { getAllFrames: async () => [frame] },
      scripting: {
        executeScript: async (request) => {
          assert.deepEqual(Array.from(request.target.documentIds), [
            documentId,
          ]);
          return [
            { frameId: 0, documentId, result: { owned, url: frame.url } },
          ];
        },
      },
    },
  });
  vm.runInContext(source.slice(start, end), context);
  const target = {
    platform: "fansly",
    tabId: 42,
    documentId,
    boundUrl: "https://fansly.com/",
  };
  const session = { id: "session", executionPort: port };
  const sender = { tab: { id: 42 }, frameId: 0, documentId, url: frame.url };
  await context.assertCreatorUploadPageBinding(session, target, sender);
  assert.equal(target.boundUrl, frame.url);
  await context.assertCreatorUploadPageBinding(session, target, sender);
  target.boundUrl = "https://fansly.com/";
  owned = false;
  await assert.rejects(
    context.assertCreatorUploadPageBinding(session, target, sender),
    /composer-changed/,
  );
  owned = true;
  currentPort = {};
  await assert.rejects(
    context.assertCreatorUploadPageBinding(session, target, sender),
    /connection-changed/,
  );
  currentPort = port;
  frame = { ...frame, documentId: "replacement" };
  await assert.rejects(
    context.assertCreatorUploadPageBinding(session, target, sender),
    /binding-changed/,
  );
});
for (const pornhubMode of ["paid", "free"])
  test(`console file request delivers approved Pornhub ${pornhubMode} role`, async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../extensions/personal/upload-console.js"),
      "utf8",
    );
    let receive;
    let bridgeReceive;
    const delivered = [];
    const replies = [];
    const channel = {
      addEventListener: (_type, fn) => {
        bridgeReceive = fn;
      },
      removeEventListener() {},
      postMessage(message) {
        if (message.direction === "probe")
          queueMicrotask(() =>
            bridgeReceive({
              data: {
                ...message,
                source: "creator-upload-bridge",
                direction: "ready",
              },
            }),
          );
        else {
          delivered.push(structuredClone(message));
          queueMicrotask(() =>
            bridgeReceive({
              data: {
                ...message,
                file: undefined,
                source: "creator-upload-bridge",
                direction: "ack",
                ok: true,
              },
            }),
          );
        }
      },
    };
    const fullFile = new File(["full bytes"], "full.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });
    const pornhubFile =
      pornhubMode === "free"
        ? new File(["optional bytes"], "optional.mp4", {
            type: "video/mp4",
            lastModified: 2,
          })
        : null;
    const context = vm.createContext({
      fullFile,
      pornhubFile,
      value: { pornhubMode },
      teaserFile: new File(["teaser"], "teaser.mp4"),
      thumbnailFile: null,
      socialFile: null,
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      channelFor: () => channel,
      setPlatformState() {},
      updateUploadAction() {},
      chrome: {
        runtime: {
          connect: () => ({
            onMessage: {
              addListener: (fn) => {
                receive = fn;
              },
            },
            onDisconnect: { addListener() {} },
            postMessage: (message) => replies.push(message),
          }),
        },
      },
    });
    const start = source.indexOf("    function fileIdentity(");
    const end = source.indexOf("    async function retryPlatform", start);
    vm.runInContext(source.slice(start, end), context);
    const pornhubFileStart = source.indexOf(
      "    function selectedPornhubFile(",
    );
    const pornhubFileEnd = source.indexOf(
      "    function selectedSocialTargets(",
      pornhubFileStart,
    );
    vm.runInContext(source.slice(pornhubFileStart, pornhubFileEnd), context);
    const filesStart = source.indexOf("const selectedFiles = {");
    const filesEnd = source.indexOf(";", filesStart);
    vm.runInContext(
      source.slice(filesStart, filesEnd + 1) +
        '\nglobalThis.session = connectSession("file-session", { files: selectedFiles, proof: {} });',
      context,
    );
    receive({ type: "session-bound", sessionId: "file-session" });
    await context.session.whenBound;
    receive({
      type: "file-request",
      sessionId: "file-session",
      platform: "pornhub",
      role: "pornhub",
      requestId: "request",
      token: "role-token",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered.length, 1);
    assert.equal(
      delivered[0].file.name,
      pornhubMode === "free" ? "optional.mp4" : "full.mp4",
    );
    assert.equal(
      await delivered[0].file.text(),
      pornhubMode === "free" ? "optional bytes" : "full bytes",
    );
    assert.equal(replies.at(-1).ok, true);
  });
for (const scenario of ["foreign-edit", "duplicate-cards", "replaced-card"])
  test(`ManyVids refuses ${scenario} as completion`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="uppy-Dashboard"><input class="uppy-Dashboard-input" type="file" hidden></div>',
      );
      await page.addScriptTag({ path: adapter });
      const result = await page.evaluate(async (scenario) => {
        let edits = 0;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 700);
        try {
          await CreatorUploadPlatformAdapters.runManyVidsUpload({
            draft: { fullFilename: "fixture.mp4" },
            signal: controller.signal,
            attachFile: async () => {
              const dashboard = document.querySelector(".uppy-Dashboard");
              dashboard.insertAdjacentHTML(
                "beforeend",
                '<article class="uppy-Dashboard-Item is-uploading"><span class="uppy-Dashboard-Item-name">fixture.mp4</span></article>',
              );
              const card = dashboard.querySelector("article");
              const edit = document.createElement("button");
              edit.setAttribute(
                "aria-label",
                "Button edit video : fixture.mp4",
              );
              edit.textContent = "Edit";
              edit.onclick = () => edits++;
              document.body.append(edit);
              if (scenario === "duplicate-cards")
                dashboard.append(card.cloneNode(true));
              if (scenario === "replaced-card")
                setTimeout(() => {
                  const replacement = card.cloneNode(true);
                  replacement.dataset.state = "upload-complete";
                  replacement.append(edit);
                  card.replaceWith(replacement);
                }, 100);
              return { role: "full", name: "fixture.mp4", size: 10 };
            },
          });
        } catch (e) {
          return { error: e.message, edits };
        } finally {
          clearTimeout(timeout);
        }
      }, scenario);
      assert.equal(result.edits, 0);
      assert.match(result.error, /cancel|ambiguous|identity changed/i);
    } finally {
      await browser.close();
    }
  });
