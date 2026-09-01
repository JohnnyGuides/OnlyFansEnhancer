(() => {
  "use strict";

  if (globalThis.CreatorSocialChromeRuntime) return;

  const X_COMPOSE_URL = "https://x.com/compose/post";
  const X_MATCH = "https://x.com/*";
  const FILE_SELECTOR = "input[data-testid='fileInput'][type='file']";
  const BINDING_PREFIX = "creatorSocialChromeBindingV1:";

  function installCreatorSocialFileBridge(config) {
    return globalThis.CreatorUploadFileBridge.install(config);
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
          ...(includeBridge ? ["creator-tools/upload-file-bridge.js"] : []),
          "creator-tools/x-publisher-adapter.js",
        ],
      });
    }

    async function installBridge(binding) {
      const bridgeBase = chrome.runtime.getURL("file-bridge.html");
      await chrome.scripting.executeScript({
        target: { tabId: binding.tabId },
        func: installCreatorSocialFileBridge,
        args: [
          {
            sessionId: binding.id,
            platform: "x",
            bridgeUrl: `${bridgeBase}?session=${encodeURIComponent(binding.id)}&platform=x&parentOrigin=https%3A%2F%2Fx.com`,
            bridgeOrigin: new URL(bridgeBase).origin,
            roles: {
              social: {
                selector: FILE_SELECTOR,
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
        throw new Error("This milestone has no trace-approved Reddit adapter.");
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

    async function prepare({ plan, caption }) {
      const frozen = contract.freezeDistributionPlan(plan);
      if (!frozen.targets.x || frozen.targets.reddit.length) {
        throw new Error("Only the trace-approved X destination is available.");
      }
      if ((await sha256Text(caption)) !== frozen.caption.sha256) {
        throw new Error("The X caption no longer matches the authorized plan.");
      }
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
      await store.create(frozen);
      bindings.set(frozen.id, binding);
      const prepared = await orchestrator.prepareSocialDistribution(frozen.id);
      if (prepared.jobs.x?.stage !== "prepared") {
        throw new Error(
          prepared.jobs.x?.error || "The X composer could not be prepared.",
        );
      }
      await saveBinding(binding);
      return {
        sessionId: frozen.id,
        targets: { x: { platform: "x", status: "ready", tabId: tab.id } },
      };
    }

    return Object.freeze({
      prepare,
      resume: orchestrator.resumeSocialDistribution,
      start: orchestrator.startSocialDistribution,
    });
  }

  globalThis.CreatorSocialChromeRuntime = Object.freeze({ create });
})();
