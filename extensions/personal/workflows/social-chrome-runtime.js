(() => {
  "use strict";

  if (globalThis.CreatorSocialChromeRuntime) return;

  const X_COMPOSE_URL = "https://x.com/compose/post";
  const X_MATCH = "https://x.com/*";
  const FILE_SELECTOR = "input[data-testid='fileInput'][type='file']";
  const REDGIFS_URL = "https://studio.redgifs.com/upload";
  const REDGIFS_FILE_SELECTOR = "input[type='file'][accept='video/*']";
  const BINDING_PREFIX = "creatorSocialChromeBindingV1:";

  function installCreatorSocialFileBridge(config) {
    return globalThis.CreatorUploadFileBridge.install(config);
  }

  function invokeCreatorSocialPreparationAdapter(args) {
    const adapter = globalThis.CreatorSocialPreparationAdapter;
    if (!adapter)
      throw new Error("The social preparation adapter is unavailable.");
    return adapter.run(args);
  }

  function invokeCreatorSocialXAdapter(args) {
    const adapter = globalThis.CreatorXPublisherAdapter;
    if (!adapter) throw new Error("The X publisher adapter is unavailable.");
    if (args.action === "prepare") {
      return adapter.prepare({
        caption: args.caption,
        async attachFile(role, selector) {
          if (role !== "social" || selector !== args.fileSelector) {
            throw new Error(
              "The X adapter requested an unexpected file control.",
            );
          }
          return globalThis.CreatorUploadFileBridge.waitFor(
            args.sessionId,
            "social",
          );
        },
      });
    }
    if (args.action === "submit") {
      return adapter.submit({ beforeCommit: async () => ({ armed: true }) });
    }
    if (args.action === "main-identity") return adapter.mainIdentity();
    if (args.action === "prepare-reply") {
      return adapter.prepareReply({ paidUrl: args.paidUrl });
    }
    if (args.action === "submit-reply") {
      return adapter.submitReply({
        beforeCommit: async () => ({ armed: true }),
      });
    }
    if (args.action === "capture-only") {
      return adapter.captureResult({
        mode: args.mode,
        paidUrl: args.paidUrl,
        allowReplySubmit: false,
      });
    }
    throw new Error("Unknown X publisher action.");
  }

  function create({
    chrome,
    contract,
    store,
    orchestratorFactory,
    catalogueClient,
    fileRequest,
    resolvePaidLink = null,
    now = Date.now,
  }) {
    if (
      !chrome?.tabs ||
      !chrome?.scripting ||
      !contract ||
      !store ||
      !orchestratorFactory ||
      !catalogueClient ||
      typeof fileRequest !== "function"
    ) {
      throw new Error(
        "The social Chrome runtime dependencies are unavailable.",
      );
    }
    const bindings = new Map();
    const manualBindings = new Map();
    const bindingStorage = chrome.storage?.session;
    if (!bindingStorage) {
      throw new Error("Chrome session storage is unavailable.");
    }

    function bindingKey(sessionId) {
      return `${BINDING_PREFIX}${sessionId}`;
    }

    async function savedBinding(sessionId) {
      const key = bindingKey(sessionId);
      const stored = (await bindingStorage.get(key))[key];
      return Number.isInteger(stored?.tabId) && stored.tabId > 0
        ? stored
        : null;
    }

    async function saveBinding(binding) {
      await bindingStorage.set({
        [bindingKey(binding.id)]: { tabId: binding.tabId },
      });
    }

    function randomToken() {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      return [...bytes]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    }

    async function sha256Text(value) {
      const bytes = new TextEncoder().encode(String(value || ""));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)]
        .map((item) => item.toString(16).padStart(2, "0"))
        .join("");
    }

    function canonicalXStatus(url) {
      try {
        const parsed = new URL(url);
        return parsed.origin === "https://x.com" &&
          /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(parsed.pathname) &&
          !parsed.search &&
          !parsed.hash
          ? `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`
          : "";
      } catch {
        return "";
      }
    }

    async function inject(tabId, includeBridge = false) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          ...(includeBridge ? ["workflows/upload-file-bridge.js"] : []),
          "workflows/x-publisher-adapter.js",
        ],
      });
    }

    async function installBridge(binding) {
      const bridgeBase = chrome.runtime.getURL("file-bridge.html");
      const platform = binding.platform || "x";
      const parentOrigin =
        platform === "redgifs" ? "https://studio.redgifs.com" : "https://x.com";
      await chrome.scripting.executeScript({
        target: { tabId: binding.tabId },
        func: installCreatorSocialFileBridge,
        args: [
          {
            sessionId: binding.id,
            platform,
            bridgeUrl: `${bridgeBase}?session=${encodeURIComponent(binding.id)}&platform=${platform}&parentOrigin=${encodeURIComponent(parentOrigin)}`,
            bridgeOrigin: new URL(bridgeBase).origin,
            roles: {
              social: {
                selector:
                  platform === "redgifs"
                    ? REDGIFS_FILE_SELECTOR
                    : FILE_SELECTOR,
                token: binding.token,
              },
            },
          },
        ],
      });
    }

    async function bindingFor(sessionId) {
      const current = bindings.get(sessionId);
      if (current) return current;
      const session = await store.load(sessionId);
      if (!session?.jobs?.x)
        throw new Error("The X distribution session was not found.");
      const resultUrl = session.jobs.x.resultUrl || "";
      const saved = await savedBinding(sessionId);
      if (saved) {
        const tab = await chrome.tabs.get(saved.tabId).catch(() => null);
        const canonical = canonicalXStatus(tab?.url);
        const expectedResult = resultUrl && canonical === resultUrl;
        const recoverableUncheckpointedTab =
          !resultUrl &&
          new Set(["prepared", "submit-attempted"]).has(session.jobs.x.stage) &&
          (tab?.url === X_COMPOSE_URL || Boolean(canonical));
        if (!expectedResult && !recoverableUncheckpointedTab) {
          throw new Error("The saved X tab no longer matches this run.");
        }
        const restored = {
          id: sessionId,
          tabId: saved.tabId,
          caption: "",
          token: "",
        };
        bindings.set(sessionId, restored);
        return restored;
      }
      if (!resultUrl) {
        throw new Error("The exact X result tab has not been checkpointed.");
      }
      const candidates = (
        await chrome.tabs.query({ url: `${resultUrl}*` })
      ).filter((tab) => canonicalXStatus(tab.url) === resultUrl);
      if (candidates.length !== 1) {
        throw new Error("The exact X result tab could not be restored safely.");
      }
      const restored = {
        id: sessionId,
        tabId: candidates[0].id,
        caption: "",
        token: "",
      };
      bindings.set(sessionId, restored);
      return restored;
    }

    async function execute(binding, action, extra = {}) {
      const execution = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId },
        func: invokeCreatorSocialXAdapter,
        args: [
          {
            action,
            sessionId: binding.id,
            fileSelector: FILE_SELECTOR,
            ...extra,
          },
        ],
      });
      const result = execution?.[0]?.result;
      if (!result) throw new Error(`The X ${action} step returned no result.`);
      return result;
    }

    function adapterFor(jobId) {
      if (jobId !== "x") {
        if (jobId !== "redgifs" && !jobId.startsWith("reddit:"))
          throw new Error("Unknown social target.");
        return {
          async prepare(input) {
            if (input.mode !== "manual")
              throw new Error("Reddit and Redgifs require manual publication.");
            const binding = manualBindings.get(`${input.plan.id}:${jobId}`);
            if (!binding)
              throw new Error(
                "The prepared social tab is unavailable. Prepare the draft again.",
              );
            if (jobId === "redgifs") {
              await fileRequest({
                sessionId: binding.id,
                platform: "redgifs",
                role: "social",
                token: binding.token,
                tabId: binding.tabId,
              });
            }
            return executeManual(binding, "prepare", {
              ...binding.copy,
              caption: binding.caption,
            });
          },
          async submit() {
            throw new Error(
              "Publish this prepared post yourself in its browser tab.",
            );
          },
          async captureResult() {
            return null;
          },
        };
      }
      return {
        async prepare(input) {
          const binding = await bindingFor(input.plan.id);
          if (!binding.caption || !binding.token) {
            throw new Error(
              "The social teaser copy or file authorization was lost before submission.",
            );
          }
          await fileRequest({
            sessionId: binding.id,
            tabId: binding.tabId,
            platform: "x",
            role: "social",
            token: binding.token,
          });
          return execute(binding, "prepare", { caption: binding.caption });
        },
        async submit(input) {
          const authorization = await input.beforeCommit();
          if (authorization?.armed !== true) {
            throw new Error("The X main post was not durably armed.");
          }
          return execute(await bindingFor(input.plan.id), "submit");
        },
        async captureResult(input) {
          const binding = await bindingFor(input.plan.id);
          const tab = await chrome.tabs.get(binding.tabId);
          const currentUrl = canonicalXStatus(tab?.url);
          if (!currentUrl) return null;
          await inject(binding.tabId);
          const session = await store.load(input.plan.id);
          const checkpointedUrl = session?.jobs?.x?.resultUrl || "";
          if (checkpointedUrl) {
            if (currentUrl !== checkpointedUrl) {
              throw new Error(
                "The current X status no longer matches this run.",
              );
            }
          } else {
            const identity = await execute(binding, "main-identity");
            if (identity.resultUrl !== currentUrl) {
              throw new Error("The observed X status does not match this run.");
            }
          }
          if (input.allowReplySubmit === false) {
            return execute(binding, "capture-only", {
              mode: input.mode,
              paidUrl: input.paidUrl,
            });
          }
          const prepared = await execute(binding, "prepare-reply", {
            paidUrl: input.paidUrl,
          });
          if (prepared.replyResultId || input.mode === "manual")
            return prepared;
          const authorization = await input.beforeReplyCommit(prepared);
          if (authorization?.armed !== true) {
            throw new Error("The X first reply was not durably armed.");
          }
          return execute(binding, "submit-reply");
        },
      };
    }

    const orchestrator = orchestratorFactory.create({
      store,
      catalogueClient,
      adapterFor,
      resolvePaidLink,
      now,
    });

    async function executeManual(binding, action, extra = {}) {
      const tab = await chrome.tabs.get(binding.tabId);
      if (!sameDraftUrl(tab?.url, binding.url))
        throw new Error("The prepared social draft tab changed.");
      const execution = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId },
        func: invokeCreatorSocialPreparationAdapter,
        args: [
          {
            platform: binding.platform,
            action,
            sessionId: binding.id,
            ...extra,
          },
        ],
      });
      if (!execution?.[0]?.result)
        throw new Error("The social preparation step returned no result.");
      return execution[0].result;
    }

    function sameDraftUrl(actual, expected) {
      try {
        const left = new URL(actual);
        const right = new URL(expected);
        return (
          left.origin === right.origin &&
          !left.username &&
          !left.password &&
          !left.hash &&
          left.pathname.replace(/\/$/, "").toLowerCase() ===
            right.pathname.replace(/\/$/, "").toLowerCase() &&
          left.search === right.search
        );
      } catch {
        return false;
      }
    }

    async function createManualTab(binding) {
      const tab = await chrome.tabs.create({ url: binding.url, active: true });
      binding.tabId = tab.id;
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await chrome.tabs.get(tab.id))?.status === "complete") break;
        if (attempt === 299)
          throw new Error("The social preparation page did not load.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          ...(binding.platform === "redgifs"
            ? ["workflows/upload-file-bridge.js"]
            : []),
          "workflows/social-preparation-adapter.js",
        ],
      });
      await executeManual(binding, "inspect", binding.copy || {});
      if (binding.platform === "redgifs") await installBridge(binding);
      manualBindings.set(`${binding.id}:${binding.jobId}`, binding);
      await bindingStorage.set({
        [`${bindingKey(binding.id)}:${binding.jobId}`]: {
          tabId: binding.tabId,
          url: binding.url,
        },
      });
      return binding;
    }

    async function prepareRedditLinks(sessionId, redgifsUrl) {
      let url;
      try {
        url = new URL(redgifsUrl);
      } catch {
        throw new Error("Enter a canonical Redgifs URL.");
      }
      if (
        url.origin !== "https://www.redgifs.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/watch\/[A-Za-z0-9-]{2,100}$/.test(url.pathname)
      )
        throw new Error("Enter a canonical Redgifs URL.");
      const session = await store.load(sessionId);
      if (
        session?.plan?.mode !== "manual" ||
        !session.plan.targets.reddit.length
      )
        throw new Error("The manual Reddit session was not found.");
      const drafts = [];
      for (const target of session.plan.targets.reddit) {
        const jobId = `reddit:${target.subreddit.toLowerCase()}`;
        const saved = (
          await bindingStorage.get(`${bindingKey(sessionId)}:${jobId}`)
        )[`${bindingKey(sessionId)}:${jobId}`];
        const expectedUrl = `https://www.reddit.com/r/${target.subreddit}/submit?type=LINK`;
        if (
          !saved ||
          !sameDraftUrl(saved.url, expectedUrl) ||
          !sameDraftUrl((await chrome.tabs.get(saved.tabId))?.url, expectedUrl)
        )
          throw new Error("The prepared Reddit draft tab changed.");
        drafts.push({
          id: sessionId,
          jobId,
          platform: "reddit",
          tabId: saved.tabId,
          url: expectedUrl,
          target,
        });
      }
      const targets = {};
      for (const draft of drafts) {
        await chrome.scripting.executeScript({
          target: { tabId: draft.tabId },
          files: ["workflows/social-preparation-adapter.js"],
        });
        const result = await executeManual(draft, "link", {
          subreddit: draft.target.subreddit,
          titleHash: draft.target.title.sha256,
          redgifsUrl: url.href,
        });
        targets[draft.jobId] = {
          ...result,
          tabId: draft.tabId,
          manualFields: [
            ...(draft.target.body.state === "nonempty" ? ["body"] : []),
            ...(draft.target.flair ? ["flair"] : []),
            ...(draft.target.nsfw ? ["nsfw"] : []),
            "publish",
          ],
        };
      }
      return { sessionId, targets };
    }

    async function prepare({ plan, caption, subreddits = [] }) {
      const frozen = contract.freezeDistributionPlan(plan);
      if (frozen.targets.reddit.length && frozen.mode !== "manual")
        throw new Error("Reddit and Redgifs require manual publication.");
      if ((await sha256Text(caption)) !== frozen.caption.sha256) {
        throw new Error(
          "The social caption no longer matches the authorized plan.",
        );
      }
      const copies = new Map();
      for (const target of frozen.targets.reddit) {
        const matching = subreddits.filter(
          (copy) =>
            String(copy.subreddit).toLowerCase() ===
            target.subreddit.toLowerCase(),
        );
        const copy = matching[0];
        if (
          matching.length !== 1 ||
          typeof copy.title !== "string" ||
          typeof copy.body !== "string" ||
          !copy.title.trim() ||
          copy.title.length > 300 ||
          copy.body.length > 10000 ||
          (await sha256Text(copy.title)) !== target.title.sha256 ||
          (await sha256Text(copy.body)) !== target.body.sha256
        )
          throw new Error(
            `The Reddit copy for r/${target.subreddit} no longer matches the authorized plan.`,
          );
        copies.set(target.subreddit.toLowerCase(), {
          subreddit: target.subreddit,
          title: copy.title,
          body: copy.body,
          flair: target.flair || "",
          nsfw: target.nsfw === true,
        });
      }
      await store.create(frozen);
      const targets = {};
      if (frozen.targets.x) {
        const existing = await chrome.tabs.query({ url: X_MATCH });
        const tab =
          existing.length === 1
            ? await chrome.tabs.update(existing[0].id, {
                active: true,
                url: X_COMPOSE_URL,
              })
            : await chrome.tabs.create({ url: X_COMPOSE_URL, active: true });
        await inject(tab.id, true);
        const binding = {
          id: frozen.id,
          tabId: tab.id,
          caption: String(caption),
          token: randomToken(),
        };
        await installBridge(binding);
        bindings.set(frozen.id, binding);
        await saveBinding(binding);
        targets.x = { platform: "x", status: "ready", tabId: tab.id };
      }
      if (frozen.targets.reddit.length) {
        const host = await createManualTab({
          id: frozen.id,
          jobId: "redgifs",
          platform: "redgifs",
          url: REDGIFS_URL,
          caption: String(caption),
          token: randomToken(),
        });
        targets.redgifs = {
          platform: "redgifs",
          status: "review-required",
          tabId: host.tabId,
          manualFields: ["caption", "tags", "publish"],
        };
        for (const target of frozen.targets.reddit) {
          const copy = copies.get(target.subreddit.toLowerCase());
          const jobId = `reddit:${target.subreddit.toLowerCase()}`;
          const draft = await createManualTab({
            id: frozen.id,
            jobId,
            platform: "reddit",
            url: `https://www.reddit.com/r/${target.subreddit}/submit?type=LINK`,
            copy,
          });
          const result = await executeManual(draft, "prepare", copy);
          targets[jobId] = {
            ...result,
            platform: "reddit",
            status: "waiting-for-redgifs",
            tabId: draft.tabId,
          };
        }
      }
      const prepared = await orchestrator.prepareSocialDistribution(frozen.id);
      for (const jobId of ["x", "redgifs"].filter(
        (job) => prepared.jobs[job],
      )) {
        if (prepared.jobs[jobId]?.stage !== "prepared") {
          throw new Error(
            prepared.jobs[jobId]?.error ||
              "The social composer could not be prepared.",
          );
        }
      }
      return {
        sessionId: frozen.id,
        targets,
      };
    }

    return Object.freeze({
      prepare,
      prepareRedditLinks,
      associateCatalogue: orchestrator.associateCatalogue,
      resume: orchestrator.resumeSocialDistribution,
      start: orchestrator.startSocialDistribution,
    });
  }

  globalThis.CreatorSocialChromeRuntime = Object.freeze({ create });
})();
