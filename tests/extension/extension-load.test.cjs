"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;
const chromePath = require("../support/browser.cjs").browserExecutable();
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "fim-load-test-"));

(async () => {
  assert.ok(chromePath, "Google Chrome was not found.");
  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath: chromePath,
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--window-position=-32000,-32000",
      "--window-size=1,1",
    ],
  });

  try {
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 10000 });
      workers = context.serviceWorkers();
    }
    assert.equal(
      workers.length,
      1,
      "The extension service worker did not load.",
    );
    assert.match(workers[0].url(), /^chrome-extension:\/\//);
    const extensionId = new URL(workers[0].url()).host;
    const realAccountKey = "user:real-onlyfans-account";
    await workers[0].evaluate(async (primaryKey) => {
      let initialized = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const stored = await chrome.storage.local.get("fimStateV1");
        if (stored.fimStateV1) {
          initialized = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!initialized) throw new Error("Extension state did not initialize.");
      const currentUrl =
        "https://img.example/current-current-current-current.jpg";
      const retiredUrl =
        "https://img.example/retired-retired-retired-retired.jpg";
      await chrome.storage.local.set({
        fimStateV1: {
          version: 3,
          identities: {
            [primaryKey]: {
              displayName: "Maya Quinn",
              handle: "maya_quinn",
              avatarUrl:
                "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' fill='%2300aff0'/%3E%3C/svg%3E",
              avatarKind: "gelbooru",
              avatarId: "current-1",
              avatarPostUrl:
                "https://gelbooru.com/index.php?page=post&s=view&id=current-1",
              avatarSourceUrl: currentUrl,
              avatarFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
          aliasToPrimary: {},
          usedAvatarIds: { "current-1": true, "retired-1": true },
          usedRealbooruIds: {},
          usedAvatarUrls: { [currentUrl]: true, [retiredUrl]: true },
          usedAvatarFingerprints: {
            aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: true,
            bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: true,
          },
          gelbooruHistory: [
            {
              source: "gelbooru",
              id: "current-1",
              sourceUrl: currentUrl,
              fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              action: "initial-assignment",
              usedAt: Date.now(),
            },
            {
              source: "gelbooru",
              id: "retired-1",
              sourceUrl: retiredUrl,
              fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              action: "manual-reroll",
              usedAt: Date.now() - 1000,
            },
          ],
        },
      });
    }, realAccountKey);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForFunction(
      () => document.querySelector("#realbooruDebug")?.textContent,
    );
    await page.locator("#currentAvatarGrid .avatar-tile").waitFor();
    assert.equal(
      await page.locator("#currentAvatarGrid .avatar-tile").count(),
      1,
    );
    assert.equal(
      await page.locator("#retiredAvatarGrid .avatar-tile").count(),
      1,
    );
    const currentTileText = await page
      .locator("#currentAvatarGrid .avatar-tile")
      .innerText();
    assert.match(currentTileText, /Maya Quinn/);
    assert.match(currentTileText, /@maya_quinn/);
    assert.match(currentTileText, /Regenerate/);
    assert.equal(
      await page.evaluate(
        (privateKey) => document.documentElement.outerHTML.includes(privateKey),
        realAccountKey,
      ),
      false,
      "The real OnlyFans account key must not be rendered in text or attributes.",
    );
    const currentImage = await page
      .locator("#currentAvatarGrid img")
      .getAttribute("src");
    await page.locator("#currentAvatarGrid .avatar-tile").click();
    await page
      .locator("#status")
      .filter({ hasText: "Click-to-change pictures" })
      .waitFor();
    assert.equal(
      await page.locator("#currentAvatarGrid img").getAttribute("src"),
      currentImage,
      "A failed regeneration must preserve the current picture.",
    );
    await page.locator("#retiredAvatarGrid .avatar-tile").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#retiredAvatarGrid .avatar-tile").length ===
        0,
    );
    const workflowPage = await context.newPage();
    workflowPage.on("pageerror", (error) => pageErrors.push(error.message));
    await workflowPage.goto(
      `chrome-extension://${extensionId}/upload-console.html`,
    );
    await workflowPage.getByRole("tab", { name: "Settings" }).click();
    await workflowPage.locator("#toolC4sUpload").waitFor();
    await workflowPage.waitForFunction(
      () => document.querySelector("#workflowProfiles")?.value,
    );
    for (const toolId of [
      "toolC4sUpload",
      "toolOnlyfansAutoSelect",
      "toolOnlyfansAutoFollow",
      "toolRedditBannerCensor",
      "toolUploadTraceRecorder",
    ]) {
      assert.equal(await workflowPage.locator(`#${toolId}`).isChecked(), true);
    }
    await workflowPage.locator("#toolC4sUpload").uncheck();
    await workflowPage.locator("#toolRedditBannerCensor").uncheck();
    await workflowPage.locator("#toolUploadTraceRecorder").uncheck();
    await workflowPage.locator("#toolOnlyfansAutoFollow").uncheck();
    await workflowPage.locator("#saveWorkflowSettings").click();
    await workflowPage
      .locator("#workflowSettingsStatus")
      .filter({ hasText: "Helper settings saved" })
      .waitFor({ timeout: 60000 });

    const toolkitState = await workers[0].evaluate(async () => {
      const result = await chrome.storage.local.get("creatorToolkitV2");
      const registrations =
        await chrome.scripting.getRegisteredContentScripts();
      await ensureRealbooruParser();
      const parser = await chrome.runtime.sendMessage({
        target: "realbooru-offscreen-parser",
        kind: "listing",
        html: `
          <div class="col thumb">
            <a href="https://realbooru.com/index.php?page=post&s=view&id=321">
              <img
                src="https://realbooru.com/thumbnails/aa/bb/thumbnail_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"
                title="1girl, selfie, solo"
              >
            </a>
          </div>
        `,
      });
      await closeRealbooruParser();
      return {
        settings: result.creatorToolkitV2,
        registrations: registrations.map((entry) => entry.id).sort(),
        parsedRealbooruId: parser?.result?.posts?.[0]?.id || "",
        hasUploadSessionStore:
          typeof CreatorUploadSessionStore?.save === "function",
      };
    });
    assert.equal(toolkitState.settings.schemaVersion, 3);
    assert.equal(toolkitState.settings.tools.c4sUpload.enabled, false);
    assert.equal(toolkitState.settings.tools.onlyfansAutoSelect.enabled, true);
    assert.equal(toolkitState.settings.tools.onlyfansAutoSelect.autorun, false);
    assert.equal(toolkitState.settings.tools.onlyfansAutoFollow.enabled, false);
    assert.deepEqual(toolkitState.registrations, [
      "creator-toolkit-fansly",
      "creator-toolkit-manyvids",
      "creator-toolkit-onlyfans-lists",
      "creator-toolkit-pornhub",
      "creator-toolkit-sheer",
    ]);
    assert.equal(toolkitState.parsedRealbooruId, "321");
    assert.equal(toolkitState.hasUploadSessionStore, true);
    assert.equal(
      JSON.parse(await workflowPage.locator("#workflowProfiles").inputValue())
        .sheerTags.mode,
      "append",
    );
    await workflowPage.close();

    await workers[0].evaluate(async () => {
      const result = await chrome.storage.local.get("creatorToolkitV2");
      result.creatorToolkitV2.tools.uploadTraceRecorder.enabled = true;
      await chrome.storage.local.set({
        creatorToolkitV2: result.creatorToolkitV2,
      });
      await syncCreatorToolRegistrations(result.creatorToolkitV2);
    });

    await context.route("https://onlyfans.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `
          <!doctype html>
          <html>
            <body>
              <h1>Expired users</h1>
              <form id="upload-form" data-testid="upload-composer">
                <input type="file" name="mediaUpload" accept="video/*" hidden>
                <label for="audience">Audience</label>
                <select id="audience" name="audience">
                  <option>Bisexual</option>
                  <option>Gay</option>
                </select>
                <label for="caption">Caption</label>
                <textarea id="caption" name="caption"></textarea>
                <button type="submit">Publish test</button>
              </form>
              <div id="result"></div>
            </body>
          </html>
        `,
      });
    });
    const uploadPage = await context.newPage();
    uploadPage.on("pageerror", (error) => pageErrors.push(error.message));
    await uploadPage.goto(
      "https://onlyfans.com/my/collections/user-lists/expired?private=remove-me",
    );
    assert.equal(
      await uploadPage.locator("#creator-upload-trace-recorder-host").count(),
      0,
      "The recorder must stay hidden until the extension popup requests it.",
    );
    const popup = await context.newPage();
    popup.on("pageerror", (error) => pageErrors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(
      () => document.querySelector("#sourceMix")?.value,
    );
    await workers[0].evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.update(tab.id, { active: true });
    }, uploadPage.url());
    await popup.locator("#showTraceRecorder").click();
    await uploadPage.locator("#creator-upload-trace-recorder-host").waitFor();
    const recorderPosition = await uploadPage
      .locator("#creator-upload-trace-recorder-host")
      .evaluate((host) => ({ left: host.style.left, right: host.style.right }));
    assert.equal(recorderPosition.left, "16px");
    assert.notEqual(
      recorderPosition.right,
      "16px",
      "The recorder must not overlap the bottom-right helper stack.",
    );
    await uploadPage.evaluate(() => {
      document
        .querySelector("#upload-form")
        .addEventListener("submit", (event) => event.preventDefault());
    });
    await uploadPage.getByRole("button", { name: "Start trace" }).click();
    await uploadPage.getByRole("button", { name: "Preview visible" }).click();
    await uploadPage.getByRole("button", { name: "Select 0 visible" }).click();
    await uploadPage
      .getByRole("status")
      .filter({ hasText: "No visible unselected users required a change." })
      .waitFor();
    await uploadPage.locator("#audience").selectOption("Gay");
    await uploadPage
      .locator("#caption")
      .fill("private controlled caption creator@example.com");
    await uploadPage.getByRole("button", { name: "Publish test" }).click();
    await uploadPage.evaluate(() => {
      document.querySelector("#result").innerHTML = `
        <div role="status">Upload complete for creator@example.com</div>
        <a href="/posts/987?token=remove-me">View published post</a>
      `;
      history.pushState({}, "", "/posts/987?token=remove-me");
    });
    await uploadPage.waitForTimeout(700);
    await uploadPage.reload();
    await uploadPage
      .getByRole("status")
      .filter({ hasText: "Recording" })
      .waitFor();
    const traceDownloadPromise = uploadPage.waitForEvent("download");
    await uploadPage.getByRole("button", { name: "Stop and download" }).click();
    const traceDownload = await traceDownloadPromise;
    const tracePath = await traceDownload.path();
    const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
    const traceTypes = new Set(trace.events.map((event) => event.type));
    for (const expectedType of [
      "session-start",
      "control-change",
      "click",
      "submit",
      "semantic-snapshot",
      "route",
      "toolkit-panel-action",
      "toolkit-run-start",
      "toolkit-run-result",
      "session-stop",
    ]) {
      assert.ok(
        traceTypes.has(expectedType),
        `Full-extension trace is missing ${expectedType}.`,
      );
    }
    const serializedTrace = JSON.stringify(trace);
    const firstEventIndex = (type) =>
      trace.events.findIndex((event) => event.type === type);
    assert.equal(trace.platform, "OnlyFans");
    assert.equal(trace.events[0].type, "session-start");
    assert.equal(trace.events.at(-1).type, "session-stop");
    assert.ok(
      firstEventIndex("toolkit-panel-action") <
        firstEventIndex("toolkit-run-start"),
    );
    assert.ok(
      firstEventIndex("toolkit-run-start") <
        firstEventIndex("toolkit-run-result"),
    );
    assert.ok(firstEventIndex("control-change") < firstEventIndex("submit"));
    assert.ok(firstEventIndex("submit") < firstEventIndex("route"));
    assert.match(serializedTrace, /"actor":"user"/);
    assert.match(serializedTrace, /"selectedLabels":\["Gay"\]/);
    assert.match(serializedTrace, /"toolId":"onlyfansAutoSelect"/);
    assert.match(serializedTrace, /"status":"success"/);
    assert.match(serializedTrace, /https:\/\/onlyfans\.com\/posts\/987/);
    assert.doesNotMatch(serializedTrace, /private controlled caption/);
    assert.doesNotMatch(serializedTrace, /creator@example\.com/);
    assert.doesNotMatch(serializedTrace, /token=remove-me|private=remove-me/);
    await uploadPage
      .getByRole("button", { name: "Hide trace recorder" })
      .click();
    assert.equal(
      await uploadPage.locator("#creator-upload-trace-recorder-host").count(),
      0,
    );

    const formBeforeProbe = await uploadPage
      .locator("#upload-form")
      .evaluate((form) => form.outerHTML);
    const capabilityResponse = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "PROBE_CREATOR_UPLOAD_TARGETS",
        targets: ["onlyfans"],
      }),
    );
    assert.equal(capabilityResponse.ok, true);
    assert.equal(capabilityResponse.results[0].status, "composer-detected");
    assert.equal(capabilityResponse.results[0].tabAction, "reused");
    assert.equal(
      await uploadPage
        .locator("#upload-form")
        .evaluate((form) => form.outerHTML),
      formBeforeProbe,
      "The injected capability probe must not mutate the platform form.",
    );
    console.log(
      `PASS: full-extension recorder captured ${trace.events.length} sanitized events across ${traceTypes.size} event types`,
    );

    await page.locator("#save").click();
    await page
      .locator("#status")
      .filter({ hasText: "Identity-mask settings saved." })
      .waitFor();

    const modes = await page
      .locator("#avatarMode option")
      .evaluateAll((options) => options.map((option) => option.value));
    assert.ok(modes.includes("realbooru"));
    assert.ok(modes.includes("mixed"));

    const popupView = await popup.evaluate(() => {
      const slider = document.querySelector("#sourceMix");
      slider.value = "30";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        minimum: slider.min,
        maximum: slider.max,
        step: slider.step,
        value: document.querySelector("#mixValue").textContent,
        gelbooru: document.querySelector("#gelbooruChance").textContent,
        realbooru: document.querySelector("#realbooruChance").textContent,
        resetNames: Boolean(document.querySelector("#resetNames")),
        resetPictures: Boolean(document.querySelector("#resetPictures")),
        showTraceRecorder: Boolean(
          document.querySelector("#showTraceRecorder"),
        ),
        legacyXRecorder: Boolean(document.querySelector("#xTeaserRecorder")),
        noteLive: document.querySelector("#note").getAttribute("aria-live"),
      };
    });
    assert.deepEqual(popupView, {
      minimum: "0",
      maximum: "100",
      step: "10",
      value: "70 / 30",
      gelbooru: "70% anime",
      realbooru: "30% real",
      resetNames: true,
      resetPictures: true,
      showTraceRecorder: true,
      legacyXRecorder: false,
      noteLive: "polite",
    });
    await workers[0].evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.update(tab.id, { active: true });
    }, uploadPage.url());
    await popup.locator("#showTraceRecorder").click();
    await uploadPage.locator("#creator-upload-trace-recorder-host").waitFor();
    const uploadConsolePromise = context.waitForEvent("page");
    const sequentialConsoleIds = await popup.evaluate(async () => {
      const first = await chrome.runtime.sendMessage({
        type: "OPEN_UPLOAD_CONSOLE",
      });
      const second = await chrome.runtime.sendMessage({
        type: "OPEN_UPLOAD_CONSOLE",
      });
      return [first.uploadConsole.tabId, second.uploadConsole.tabId];
    });
    const uploadConsole = await uploadConsolePromise;
    uploadConsole.on("pageerror", (error) => pageErrors.push(error.message));
    await uploadConsole.waitForLoadState();
    assert.equal(
      uploadConsole.url(),
      `chrome-extension://${extensionId}/upload-console.html`,
    );
    await uploadConsole.locator("#uploadFullVideo").waitFor();
    assert.equal(
      await uploadConsole.locator("#targetOnlyfans").isChecked(),
      true,
    );
    assert.equal(
      await uploadConsole.locator("#targetFansly").isChecked(),
      true,
    );
    assert.equal(await uploadConsole.locator("#confirmation").isHidden(), true);
    const tabsBeforePreview = context.pages().map((tab) => tab.url());
    await uploadConsole.locator("#uploadFullVideo").setInputFiles({
      name: "Upload-only smoke fixture.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("harmless preview fixture"),
    });
    await uploadConsole
      .locator("#uploadDescription")
      .fill("Preview only; never submit.");
    await uploadConsole.locator("#confirmation").waitFor();
    assert.equal(
      await uploadConsole.locator("#confirmUpload").isEnabled(),
      true,
    );
    assert.match(
      await uploadConsole.locator("#matchBadge").textContent(),
      /without sheet/i,
    );
    assert.equal(
      await uploadConsole.locator("#continueWithoutSheet").isHidden(),
      true,
    );
    // Moving focus must not dismiss the preview while the user clicks a button.
    await uploadConsole.locator("#confirmUpload").focus();
    assert.equal(
      await uploadConsole.locator("#confirmation").isVisible(),
      true,
    );
    assert.deepEqual(
      context.pages().map((tab) => tab.url()),
      tabsBeforePreview,
      "An upload preview must not open any platform tab before Yes.",
    );
    await uploadConsole.locator("#rejectMatch").click();
    assert.equal(await uploadConsole.locator("#confirmation").isHidden(), true);
    assert.deepEqual(
      context.pages().map((tab) => tab.url()),
      tabsBeforePreview,
    );
    assert.equal(
      sequentialConsoleIds[0],
      sequentialConsoleIds[1],
      "Immediate sequential requests must reuse the console tab before its context is registered.",
    );

    const bridgeSession = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const bridgeToken = "abcdef0123456789abcdef0123456789";
    await uploadConsole.evaluate((sessionId) => {
      globalThis.__fileBridgeChannel = new BroadcastChannel(
        `creator-upload:${sessionId}`,
      );
      globalThis.__fileBridgeReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(new Error("Extension file bridge did not become ready.")),
          15000,
        );
        globalThis.__fileBridgeChannel.addEventListener("message", (event) => {
          if (
            event.data?.source === "creator-upload-bridge" &&
            event.data.direction === "ready" &&
            event.data.sessionId === sessionId
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }, bridgeSession);
    await workers[0].evaluate(
      async ({ sessionId, token }) => {
        const tabs = await chrome.tabs.query({ url: "https://onlyfans.com/*" });
        if (tabs.length !== 1)
          throw new Error("Expected one OnlyFans fixture tab.");
        const tabId = tabs[0].id;
        const files = await chrome.scripting.executeScript({
          target: { tabId },
          files: ["workflows/upload-file-bridge.js"],
        });
        const bridgeBase = chrome.runtime.getURL("file-bridge.html");
        const installBridge = (config) =>
          globalThis.CreatorUploadFileBridge.install(config);
        const install = await chrome.scripting.executeScript({
          target: { tabId },
          func: installBridge,
          args: [
            {
              sessionId,
              platform: "onlyfans",
              bridgeUrl:
                `${bridgeBase}?session=${sessionId}&platform=onlyfans&parentOrigin=` +
                encodeURIComponent("https://onlyfans.com"),
              bridgeOrigin: new URL(bridgeBase).origin,
              roles: {
                full: {
                  selector: 'input[type="file"]',
                  token,
                },
              },
            },
          ],
        });
        return { files, install };
      },
      { sessionId: bridgeSession, token: bridgeToken },
    );
    await uploadConsole.evaluate(() => globalThis.__fileBridgeReady);
    const bridgeAck = await uploadConsole.evaluate(
      ({ sessionId, token }) =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Extension file bridge did not acknowledge the File.",
                ),
              ),
            15000,
          );
          const listener = (event) => {
            if (
              event.data?.source === "creator-upload-bridge" &&
              event.data.direction === "ack" &&
              event.data.sessionId === sessionId &&
              event.data.role === "full"
            ) {
              clearTimeout(timeout);
              globalThis.__fileBridgeChannel.removeEventListener(
                "message",
                listener,
              );
              resolve(event.data);
            }
          };
          globalThis.__fileBridgeChannel.addEventListener("message", listener);
          globalThis.__fileBridgeChannel.postMessage({
            source: "creator-upload-console",
            sessionId,
            platform: "onlyfans",
            role: "full",
            token,
            file: new File(["synthetic-video"], "synthetic-full.mp4", {
              type: "video/mp4",
            }),
          });
        }),
      { sessionId: bridgeSession, token: bridgeToken },
    );
    assert.equal(bridgeAck.ok, true);
    assert.deepEqual(
      await uploadPage.locator('input[type="file"]').evaluate((input) => ({
        name: input.files[0]?.name,
        size: input.files[0]?.size,
        type: input.files[0]?.type,
      })),
      { name: "synthetic-full.mp4", size: 15, type: "video/mp4" },
    );
    await uploadConsole.evaluate(() => globalThis.__fileBridgeChannel.close());
    await popup.locator("#uploadConsole").click();
    await popup.waitForTimeout(100);
    assert.equal(
      context
        .pages()
        .filter((candidate) => candidate.url() === uploadConsole.url()).length,
      1,
      "The popup must focus the existing upload console instead of opening duplicates.",
    );
    await context.route("https://example.com/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Not the console</title>",
      });
    });
    await uploadConsole.goto("https://example.com/");
    const replacementConsolePromise = context.waitForEvent("page");
    const replacementResponse = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: "OPEN_UPLOAD_CONSOLE" }),
    );
    const replacementConsole = await replacementConsolePromise;
    await replacementConsole.waitForLoadState();
    assert.notEqual(
      replacementResponse.uploadConsole.tabId,
      sequentialConsoleIds[0],
      "A navigated tab with an inaccessible URL must not be reused as the console.",
    );
    assert.equal(
      replacementConsole.url(),
      `chrome-extension://${extensionId}/upload-console.html`,
    );
    await replacementConsole.close();
    await uploadConsole.close();
    assert.deepEqual(pageErrors, []);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"),
    );
    console.log(
      `PASS: Chrome loaded the unpacked v${manifest.version} extension and options`,
    );
  } finally {
    await context.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(profilePath, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
