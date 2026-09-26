"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("./browser.cjs");
const { repositoryRoot, personalRoot } = require("./paths.cjs");

// The complete extension worker and shared uploader run here. Only external
// platform UI and the native WebView transport are fixtures, never publications.
async function createUploadFixture({ desktop = false } = {}) {
  fs.mkdirSync(path.join(repositoryRoot, ".local"), { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(repositoryRoot, ".local/upload-action-"),
  );
  const extension = path.join(directory, "extension");
  fs.cpSync(personalRoot, extension, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extension, "manifest.json")),
  );
  manifest.permissions = manifest.permissions.filter(
    (permission) => permission !== "nativeMessaging",
  );
  delete manifest.key;
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
  const context = await chromium.launchPersistentContext(
    path.join(directory, "profile"),
    {
      headless: true,
      args: [
        "--disable-extensions-except=" + extension,
        "--load-extension=" + extension,
      ],
    },
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() => {
    globalThis.fixtureCommands = [];
    globalThis.fixtureEvents = [];
    globalThis.fixtureFinish = new Map();
    const prepare = prepareCreatorUpload;
    prepareCreatorUpload = async (...args) => {
      fixtureCommands.push({
        type: "PREPARE_CREATOR_UPLOAD",
        request: args[0],
        launcher: args[1],
      });
      if (globalThis.fixturePrepareError)
        throw Object.assign(new Error(fixturePrepareError), {
          uploadAdmission: "not-started",
        });
      return prepare(...args);
    };
    const start = startCreatorUpload;
    startCreatorUpload = async (...args) => {
      fixtureCommands.push({
        type: "START_CREATOR_UPLOAD",
        sessionId: args[0],
      });
      if (globalThis.fixtureStartError) throw new Error(fixtureStartError);
      return start(...args);
    };
    prepareCreatorUploadPlatform = async (session, platform) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const target = {
        platform,
        status: "prepared",
        stage: "prepared",
        tabId: 700,
        documentId: "11111111-1111-4111-8111-111111111111",
        boundUrl: "https://onlyfans.com/my/posts/create",
        tokens: { full: "b".repeat(48) },
      };
      session.platforms.set(platform, target);
      await checkpointCreatorUploadSession(session);
      return target;
    };
    runCreatorUploadPlatform = async (session, platform) => {
      const target = session.platforms.get(platform);
      target.status = "uploading-full";
      creatorUploadPost(session.id, {
        type: "platform-progress",
        platform,
        status: target.status,
      });
      if (globalThis.fixtureRequestFile)
        await creatorUploadRequestFile(session, platform, "full");
      await new Promise((resolve) => fixtureFinish.set(platform, resolve));
      target.status = "manual-submit-required";
      creatorUploadPost(session.id, {
        type: "platform-result",
        platform,
        result: target,
      });
      return target;
    };
    globalThis.fixtureDesktopRuntime = CreatorDesktopUploadRuntime.create({
      chrome,
      handleMessage: handleExtensionMessage,
      bindPort(port, message) {
        if (!port.fixtureId) {
          port.fixtureId = globalThis.fixtureCurrentPortId;
          const post = port.postMessage.bind(port);
          port.postMessage = (value) => {
            fixtureEvents.push({ portId: port.fixtureId, message: value });
            post(value);
          };
          creatorUploadConsolePorts.add(port);
        }
        creatorUploadHandlePortMessage(port, message);
      },
      unbindPort(port) {
        creatorUploadConsolePorts.delete(port);
      },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const generatedChunks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let eventPoll;
  if (desktop) {
    await page.exposeFunction("fixtureNativeRequest", async (request) => {
      if (request.operation === "getUploadBrowsers")
        return {
          connected: true,
          selected: "fixture-browser",
          browsers: ["fixture-browser"],
          expiresInMilliseconds: 10000,
        };
      if (request.operation === "getChromeReadiness")
        return { state: "connected", message: "Fixture transport connected." };
      if (request.operation === "browserRequest")
        return worker.evaluate(async (command) => {
          globalThis.fixtureCurrentPortId = command.portId;
          return fixtureDesktopRuntime.execute(command);
        }, request.payload);
      if (request.operation === "stageGeneratedMediaChunk") {
        generatedChunks.push(request.payload);
        return { staged: request.payload.final };
      }
      if (request.operation === "deliverGeneratedMedia") {
        generatedChunks.push({ delivered: request.payload });
        return { delivered: true };
      }
      if (request.operation === "deliverUploadFile") {
        await worker.evaluate((payload) => {
          const pending = creatorUploadFileRequests.get(payload.requestId);
          if (
            !pending ||
            pending.sessionId !== payload.sessionId ||
            pending.token !== payload.token
          )
            throw new Error("fixture-file-binding-mismatch");
          creatorUploadHandlePortMessage(pending.port, {
            type: "file-response",
            requestId: payload.requestId,
            ok: true,
          });
        }, request.payload);
        return { delivered: true };
      }
      throw new Error(
        "Unsupported fixture native operation: " + request.operation,
      );
    });
    await page.addInitScript(() => {
      globalThis.fixtureNativeFiles = [];
      const listeners = [];
      globalThis.fixtureReceive = (data) =>
        listeners.forEach((listener) => listener({ data }));
      const post = async (raw, files) => {
        const request = JSON.parse(raw);
        try {
          if (files)
            fixtureNativeFiles.push({
              sessionId: request.payload.sessionId,
              name: files[0].name,
              size: files[0].size,
              text: await files[0].text(),
            });
          if (
            globalThis.fixtureOffline &&
            request.operation === "getUploadBrowsers"
          ) {
            fixtureReceive({
              requestId: request.requestId,
              ok: true,
              result: { connected: false, browsers: [] },
            });
            return;
          }
          const result = await fixtureNativeRequest(request);
          fixtureReceive({ requestId: request.requestId, ok: true, result });
        } catch (error) {
          fixtureReceive({
            requestId: request.requestId,
            ok: false,
            error: { code: error.message },
          });
        }
      };
      globalThis.chrome = {
        webview: {
          addEventListener(_type, listener) {
            listeners.push(listener);
          },
          postMessage: post,
          postMessageWithAdditionalObjects: post,
        },
      };
    });
    await context.route("https://uploader.test/**", (route) => {
      const relative = new URL(route.request().url()).pathname.slice(1);
      const file =
        relative === "app/upload-host.js"
          ? path.join(repositoryRoot, "shared/workspace/upload-host.js")
          : path.join(personalRoot, relative);
      return fs.existsSync(file)
        ? route.fulfill({ path: file })
        : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("https://uploader.test/upload-console.html");
    let polling = false;
    eventPoll = setInterval(async () => {
      if (polling || page.isClosed()) return;
      polling = true;
      try {
        const events = await worker.evaluate(() => fixtureEvents.splice(0));
        if (events.length)
          await page.evaluate(
            (items) =>
              items.forEach((item) => fixtureReceive({ uploadEvent: item })),
            events,
          );
      } catch (error) {
        if (!page.isClosed()) errors.push(error.message);
      } finally {
        polling = false;
      }
    }, 25);
  } else {
    await page.goto(
      worker.url().replace("background.js", "upload-console.html"),
    );
  }
  await page.waitForFunction(() => globalThis.CreatorUploadConsole);
  return {
    page,
    worker,
    errors,
    generatedChunks,
    context,
    async ready(name = "benign-new-clip.mp4") {
      await page.locator("#uploadFullVideo").setInputFiles({
        name,
        mimeType: "video/mp4",
        buffer: Buffer.from("benign generated fixture bytes"),
      });
      await page.locator("#uploadTitle").fill("Benign upload verification");
      await page
        .locator("#uploadDescription")
        .fill("Unpublished development draft.");
      for (const id of ["targetFansly", "targetManyvids", "targetPornhub"]) {
        const target = page.locator(`#${id}`);
        if (await target.isChecked()) await target.locator("..").click();
      }
      const onlyfans = page.locator("#targetOnlyfans");
      if (!(await onlyfans.isChecked())) await onlyfans.locator("..").click();
      assert.equal(await page.locator("#mainPublishMode").isChecked(), false);
      await page.waitForFunction(
        () => !document.querySelector("#uploadButton").disabled,
      );
    },
    async seedPreparation(name = "benign-new-clip.mp4") {
      return worker.evaluate(
        async ({ name, desktop }) => {
          const work = await CreatorUploadSessionStore.workIdentity({
            draft: { fullFilename: name },
            launcher: desktop ? "desktop" : "extension",
          });
          await CreatorUploadSessionStore.recordStep(
            "previous-unpublished-run",
            {
              launcher: desktop ? "desktop" : "extension",
              actionId: "select-full",
              platform: "onlyfans",
              outcome: "intent",
              work,
              commandId: "11111111-1111-4111-8111-111111111111",
              documentId: "22222222-2222-4222-8222-222222222222",
              signature: "c".repeat(64),
              tabId: 700,
              frameId: 0,
            },
          );
          return CreatorUploadSessionStore.listRecovery();
        },
        { name, desktop },
      );
    },
    async commands() {
      return worker.evaluate(() => fixtureCommands);
    },
    async close() {
      clearInterval(eventPoll);
      await context.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
module.exports = { createUploadFixture };
