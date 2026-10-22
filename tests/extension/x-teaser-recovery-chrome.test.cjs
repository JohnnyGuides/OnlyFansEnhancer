"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { chromium } = require("../support/browser.cjs");
const { tweet, payload } = require("../support/x-network-fixture.cjs");
const extensionRoot = require("../support/paths.cjs").personalRoot;
const id = "chrome-restart-publication-0001";
const caption = "Benign teaser & caption";

test(
  "real Chrome restarts the worker after tab and session-state loss, then replies once",
  { timeout: 120_000 },
  async () => {
    const profile = fs.mkdtempSync(
      path.join(os.tmpdir(), "x-teaser-recovery-"),
    );
    let context;
    let replyClicks = 0;
    const publishedAt = Math.floor(Date.now() / 1000) * 1000;
    const main = tweet("101", caption, {
      media: true,
      createdAt: new Date(publishedAt).toUTCString(),
    });
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: false,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          `--disable-extensions-except=${extensionRoot}`,
          `--load-extension=${extensionRoot}`,
          "--window-position=-32000,-32000",
          "--window-size=1,1",
        ],
      });
      await context.addCookies([
        {
          name: "twid",
          value: "u%3D123",
          domain: ".x.com",
          path: "/",
          secure: true,
        },
      ]);
      await context.route("https://x.com/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("CreateTweet")) {
          const variables = JSON.parse(route.request().postData()).variables;
          if (variables.reply) replyClicks++;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              variables.reply
                ? payload(
                    tweet("150", variables.tweet_text, {
                      parent: "101",
                      createdAt: new Date(publishedAt + 900_000).toUTCString(),
                    }),
                  )
                : payload(main),
            ),
          });
        } else if (url.pathname.endsWith("TweetDetail")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              payload(
                main,
                tweet("999", "Recommended own post", { media: true }),
              ),
            ),
          });
        } else if (url.pathname === "/compose/post") {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<button id="post">Post manually</button><script>
          document.querySelector('#post').onclick = () => fetch('/i/api/graphql/fixture/CreateTweet', { method: 'POST', body: JSON.stringify({variables:{tweet_text:${JSON.stringify(caption)},media:{media_entities:[{media_id:'77'}]}}}) });
        </script>`,
          });
        } else if (url.pathname === "/Owner_Handle/status/101") {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<nav><a data-testid="AppTabBar_Profile_Link" href="/Owner_Handle">Profile</a></nav>
          <article><a href="/Owner_Handle/status/101"><time>main</time></a></article>
          <div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="white-space:pre-wrap"></div><button data-testid="tweetButtonInline">Reply</button></div>
          <script>void fetch('/i/api/graphql/fixture/TweetDetail');
          const editor=document.querySelector('[contenteditable]');
          editor.onpaste=e=>{e.preventDefault();editor.textContent=e.clipboardData.getData('text/plain')};
          document.querySelector('button').onclick=()=>fetch('/i/api/graphql/fixture/CreateTweet',{method:'POST',body:JSON.stringify({variables:{tweet_text:editor.innerText,reply:{in_reply_to_tweet_id:'101'}}})});</script>`,
          });
        } else await route.fulfill({ status: 404, body: "" });
      });
      let [worker] = context.serviceWorkers();
      worker ||= await context.waitForEvent("serviceworker");
      await worker.evaluate(async () => {
        // No test request reaches the user's desktop, catalogue, or provider.
        globalThis.__observations = [];
        sendDesktopRequest = async (operation, payload) => {
          globalThis.__observations.push({ operation, payload });
          return {};
        };
        for (let i = 0; i < 100; i++) {
          if (
            (await chrome.scripting.getRegisteredContentScripts()).some(
              (x) => x.id === "creator-x-collector-relay",
            )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("collector not registered");
      });
      return worker;
    }
    try {
      let worker = await launch();
      const page = await context.newPage();
      await page.goto("https://x.com/compose/post");
      await worker.evaluate(
        async ({ id, caption, publishedAt }) => {
          const hash = [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(caption),
              ),
            ),
          ]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
          const tab = (
            await chrome.tabs.query({ url: "https://x.com/compose/post" })
          )[0];
          const [document] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => true,
          });
          await CREATOR_SOCIAL_SESSION_STORE.create({
            id,
            mode: "manual",
            catalogue: {
              row: 125,
              id: "benign-episode",
              title: "Benign episode",
              fingerprint: "1234abcd",
            },
            socialFile: {
              basename: "benign.mp4",
              size: 6,
              lastModified: publishedAt,
              sha256: "a".repeat(64),
            },
            caption: { state: "nonempty", sha256: hash },
            paidUrl: "https://onlyfans.com/123/johnny_guides",
            targets: { x: true, reddit: [] },
            evidence: { x: "f".repeat(64) },
            authorization: { at: publishedAt - 1000, sha256: "a".repeat(64) },
            xOptions: {
              sensitive: true,
              scheduledUtc: "",
              timeZone: "Europe/Zurich",
              replyDelayMinutes: 15,
              autoReply: true,
            },
          });
          await CREATOR_SOCIAL_SESSION_STORE.checkpoint(id, "x", {
            stage: "prepared",
            preparedComposerSha256: hash,
            replyLine: "Full video\n-> {link}",
            publicationContext: {
              accountId: "123",
              handle: "Owner_Handle",
              preparedUtc: new Date(publishedAt - 1000).toISOString(),
              latestStatusId: "100",
            },
          });
          await chrome.storage.session.set({
            [`creatorSocialChromeBindingV1:${id}`]: {
              tabId: tab.id,
              documentId: document.documentId,
            },
          });
        },
        { id, caption, publishedAt },
      );
      await page.click("#post");
      for (let i = 0; i < 100; i++) {
        if (
          await worker.evaluate(
            async (id) =>
              Boolean(
                (await CREATOR_SOCIAL_SESSION_STORE.load(id)).jobs.x.resultUrl,
              ),
            id,
          )
        )
          break;
        if (i === 99)
          throw new Error(
            "publish response was not persisted: " +
              JSON.stringify(
                await worker.evaluate(
                  async (id) => ({
                    job: (await CREATOR_SOCIAL_SESSION_STORE.load(id)).jobs.x,
                    session: await chrome.storage.session.get(null),
                    requests: globalThis.__observations,
                  }),
                  id,
                ),
              ),
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(page.url(), "https://x.com/compose/post");
      assert.equal(replyClicks, 0);
      await page.close();
      // This exercises a real worker restart plus explicit Chrome-session loss.
      // Command-line test extensions are temporary installs on browser relaunch;
      // this is not evidence of a normal installed browser process restart.
      await worker.evaluate(() => chrome.storage.session.clear());
      const control = await context.browser().newBrowserCDPSession();
      const target = (await control.send("Target.getTargets")).targetInfos.find(
        (target) =>
          target.type === "service_worker" && target.url === worker.url(),
      );
      assert.ok(target, "The extension worker has a real Chrome target.");
      const extensionId = new URL(worker.url()).host;
      await worker.evaluate(() => {
        globalThis.__restartMarker = true;
      });
      await control.send("Target.closeTarget", { targetId: target.targetId });
      await assert.rejects(
        worker.evaluate(() => globalThis.__restartMarker),
        /Service worker restarted|closed/i,
      );
      const wake = await context.newPage();
      await wake.goto(`chrome-extension://${extensionId}/options.html`);
      await wake.evaluate(() =>
        chrome.runtime.sendMessage({ type: "GET_X_FIRST_REPLY_STATUS" }),
      );
      const restarted = (
        await control.send("Target.getTargets")
      ).targetInfos.find(
        (target) =>
          target.type === "service_worker" &&
          target.url.endsWith("/background.js"),
      );
      assert.ok(restarted, "An actual new service-worker target started.");
      const { sessionId } = await control.send("Target.attachToTarget", {
        targetId: restarted.targetId,
        flatten: false,
      });
      let commandId = 0;
      worker = {
        async evaluate(fn, arg) {
          const id = ++commandId;
          const reply = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              control.off("Target.receivedMessageFromTarget", receive);
              reject(new Error("Worker CDP response timed out"));
            }, 30_000);
            function receive(event) {
              if (event.sessionId !== sessionId) return;
              const message = JSON.parse(event.message);
              if (message.id !== id) return;
              clearTimeout(timer);
              control.off("Target.receivedMessageFromTarget", receive);
              if (message.error || message.result?.exceptionDetails)
                reject(
                  new Error(
                    JSON.stringify(
                      message.error || message.result.exceptionDetails,
                    ),
                  ),
                );
              else resolve(message.result.result.value);
            }
            control.on("Target.receivedMessageFromTarget", receive);
          });
          await control.send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({
              id,
              method: "Runtime.evaluate",
              params: {
                expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
                awaitPromise: true,
                returnByValue: true,
              },
            }),
          });
          return reply;
        },
      };
      assert.equal(
        await worker.evaluate(() => globalThis.__restartMarker === undefined),
        true,
        "Worker memory really was reset.",
      );
      await worker.evaluate(() => {
        sendDesktopRequest = async () => ({});
      });
      async function resume(at) {
        return worker.evaluate(
          async ({ id, at }) => {
            const runtime = CreatorSocialChromeRuntime.create({
              chrome,
              contract: CREATOR_SOCIAL_CONTRACT,
              store: CREATOR_SOCIAL_SESSION_STORE,
              orchestratorFactory: CREATOR_SOCIAL_ORCHESTRATOR,
              fileRequest: async () => {},
              now: () => at,
              catalogueClient: {
                appendDistributionLedger: async () => ({ status: "updated" }),
                appendTwitterTeaser: async () => ({ status: "updated" }),
              },
              resolvePublication: async () => {
                throw new Error("publication already durable");
              },
            });
            await runtime.resume(id);
            return {
              job: (await CREATOR_SOCIAL_SESSION_STORE.load(id)).jobs.x,
              binding: (
                await chrome.storage.session.get(
                  `creatorSocialChromeBindingV1:${id}`,
                )
              )[`creatorSocialChromeBindingV1:${id}`],
            };
          },
          { id, at },
        );
      }
      const early = await resume(publishedAt + 899_999);
      assert.equal(
        early.binding,
        undefined,
        "Chrome session storage was explicitly cleared.",
      );
      assert.equal(early.job.replyDueAt, publishedAt + 900_000);
      assert.equal(replyClicks, 0);
      const due = await resume(publishedAt + 900_000);
      assert.equal(due.job.stage, "sheet-complete", due.job.error);
      assert.equal(
        due.job.replyResultUrl,
        "https://x.com/Owner_Handle/status/150",
      );
      await resume(publishedAt + 960_000);
      assert.equal(replyClicks, 1);
    } finally {
      await context?.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  },
);
