(() => {
  "use strict";

  if (globalThis.CreatorSocialChromeRuntime) return;

  const X_COMPOSE_URL = "https://x.com/compose/post";
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
        xOptions: args.xOptions,
        fileName: args.fileName,
        ownerHandle: args.ownerHandle,
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
      return adapter.submit({
        captionSha256: args.captionSha256,
        xOptions: args.xOptions,
        ownerHandle: args.ownerHandle,
        beforeCommit: async () => ({ armed: true }),
      });
    }
    if (args.action === "main-identity") return adapter.mainIdentity();
    if (args.action === "prepare-reply") {
      return adapter.prepareReply({ paidUrl: args.paidUrl, text: args.text });
    }
    if (args.action === "submit-reply") {
      return adapter.submitReply({
        resultId: args.resultId,
        paidUrl: args.paidUrl,
        text: args.text,
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
    resolveScheduledResult = null,
    getPublicationContext = null,
    resolvePublication = null,
    refreshPublications = null,
    replyRunner = null,
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
    let publicationObservations = Promise.resolve();
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
        [bindingKey(binding.id)]: {
          tabId: binding.tabId,
          documentId: binding.documentId || "",
        },
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
      const execution = await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          ...(includeBridge ? ["workflows/upload-file-bridge.js"] : []),
          "workflows/x-publisher-adapter.js",
        ],
      });
      return execution?.[0]?.documentId || "";
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
      const session = await store.load(sessionId);
      if (!session?.jobs?.x)
        throw new Error("The X distribution session was not found.");
      const resultUrl = session.jobs.x.resultUrl || "";
      async function restoreCapturedTab() {
        const tab = await chrome.tabs.create({ url: resultUrl, active: false });
        const restored = {
          id: sessionId,
          tabId: tab.id,
          caption: "",
          token: "",
        };
        bindings.set(sessionId, restored);
        await saveBinding(restored);
        return restored;
      }
      const mayRestoreCaptured = Boolean(
        session.plan.xOptions && resultUrl && session.jobs.x.replyDueAt,
      );
      if (current) {
        if (
          mayRestoreCaptured &&
          !(await chrome.tabs.get(current.tabId).catch(() => null))
        )
          return restoreCapturedTab();
        return current;
      }
      const saved = await savedBinding(sessionId);
      if (saved) {
        const tab = await chrome.tabs.get(saved.tabId).catch(() => null);
        if (!tab && mayRestoreCaptured) return restoreCapturedTab();
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
      if (!candidates.length && mayRestoreCaptured) return restoreCapturedTab();
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

    async function capturePublishedTeaser(input) {
      const options = input.plan.xOptions || {
        replyDelayMinutes: 15,
        autoReply: input.mode === "autonomous",
      };
      let session = await store.load(input.plan.id);
      let job = session.jobs.x;
      let context = job.publicationContext;
      if (!context && job.resultUrl && getPublicationContext) {
        const owner = await getPublicationContext();
        if (
          canonicalXStatus(job.resultUrl)?.split("/")[3].toLowerCase() ===
          owner.handle.toLowerCase()
        ) {
          session = await store.checkpoint(session.id, "x", {
            publicationContext: owner,
          });
          job = session.jobs.x;
          context = owner;
        }
      }
      if (!context)
        throw new Error(
          "This older draft needs review before automatic publication detection can resume.",
        );
      if (job.resultUrl && !job.replyDueAt && options.autoReply)
        throw new Error(
          "This older post has no verified reply timing. Review it before replying.",
        );
      const pending = () => ({
        status: "reply-prepared",
        resultId: job.resultId,
        resultUrl: job.resultUrl,
        error: job.error || "",
      });
      if (!job.resultUrl) {
        const publicationDeadline =
          Date.parse(options.scheduledUtc || context.preparedUtc) +
          24 * 60 * 60_000;
        if (now() > publicationDeadline) {
          await store.checkpoint(session.id, "x", {
            stage: "blocked",
            error:
              "Publication was not confirmed within 24 hours. Review the X post.",
          });
          throw new Error(
            "Publication was not confirmed within 24 hours. Review the X post.",
          );
        }
        // A profile caption alone cannot prove which prepared video was posted.
        if (!job.publicationMediaIds) return null;
        if (options.scheduledUtc && Date.parse(options.scheduledUtc) > now())
          return null;
        const query = {
          context,
          captionSha256: input.plan.caption.sha256,
          episodeKey: input.plan.catalogue?.id || "",
          scheduledUtc: options.scheduledUtc || null,
          mediaIds: job.publicationMediaIds || [],
        };
        let found = await resolvePublication(query);
        if (!found?.matched && refreshPublications) {
          await refreshPublications(context);
          found = await resolvePublication(query);
        }
        if (!found?.matched) return null;
        const url = canonicalXStatus(found.resultUrl);
        const postedAt = Date.parse(found.postedUtc);
        if (
          !url ||
          url.split("/").pop() !== found.resultId ||
          url.split("/")[3].toLowerCase() !== context.handle.toLowerCase() ||
          !Number.isFinite(postedAt) ||
          postedAt < Date.parse(context.preparedUtc) - 1000 ||
          postedAt > now() + 90_000
        )
          throw new Error(
            "The observed X publication does not match this run.",
          );
        for (const other of await store.list()) {
          if (other.id === session.id || !other.jobs?.x) continue;
          if (
            other.jobs.x.resultUrl === url ||
            (!other.jobs.x.resultUrl &&
              !["failed", "blocked", "sheet-complete"].includes(
                other.jobs.x.stage,
              ) &&
              other.jobs.x.publicationContext?.accountId ===
                context.accountId &&
              other.plan.caption.sha256 === query.captionSha256 &&
              JSON.stringify(other.jobs.x.publicationMediaIds) ===
                JSON.stringify(job.publicationMediaIds) &&
              Date.parse(other.jobs.x.publicationContext.preparedUtc) <=
                postedAt)
          )
            throw new Error(
              "This X post matches more than one prepared run. Review the drafts before replying.",
            );
        }
        session = await store.checkpoint(session.id, "x", {
          resultId: found.resultId,
          resultUrl: url,
          replyDueAt: postedAt + options.replyDelayMinutes * 60_000,
        });
        job = session.jobs.x;
      }
      const policy = globalThis.CreatorXReplyPolicy.forStorage(
        chrome.storage.local,
      );
      const reply = await policy.reserve(job.resultId, input.paidUrl, {
        line: job.replyLine,
        owner: "editor",
      });
      if (reply.owner !== "editor")
        throw new Error(
          "This post already has another automatic reply queued.",
        );
      if (!(options.autoReply ?? input.mode === "autonomous"))
        return {
          resultId: job.resultId,
          resultUrl: job.resultUrl,
          replyOutcome: "manual",
        };
      if (
        now() >
        job.replyDueAt - options.replyDelayMinutes * 60_000 + 24 * 60 * 60_000
      )
        return {
          resultId: job.resultId,
          resultUrl: job.resultUrl,
          replyOutcome: "expired",
        };
      if (now() < job.replyDueAt) return pending();
      if (job.replyCheckAfter > now()) return pending();
      const item = {
        statusId: job.resultId,
        statusUrl: job.resultUrl,
        ownerHandle: context.handle,
        ownerId: context.accountId,
        text: reply.text,
        paidUrl: input.paidUrl,
        linkPolicy: "approved",
      };
      const runner =
        replyRunner ||
        globalThis.CreatorXFirstReply.createChromeRunner({ chrome });
      const tabKey = `creatorSocialReplyTabV1:${session.id}`;
      const stale = (await bindingStorage.get(tabKey))[tabKey];
      if (stale?.tabId)
        await runner.closeStale?.(stale.tabId, job.resultUrl).catch(() => {});
      let handle;
      try {
        handle = await runner.open(item, async (tabId) => {
          await bindingStorage.set({ [tabKey]: { tabId } });
        });
        let result;
        if (input.allowReplySubmit === false || reply.attempted) {
          result = await runner.capture(handle, item);
        } else {
          const prepared = await runner.prepare(handle, item);
          if (prepared.status === "existing-reply") {
            // An owner reply already exists; never add another one automatically.
            return {
              resultId: job.resultId,
              resultUrl: job.resultUrl,
              replyOutcome: "existing-reply",
              replyResultId: prepared.replyId,
              replyResultUrl: `https://x.com/${context.handle}/status/${prepared.replyId}`,
            };
          }
          if ((await input.beforeReplyCommit(job))?.armed !== true)
            throw new Error("The X reply was not durably armed.");
          if (!(await policy.claim(job.resultId, reply.text)))
            throw new Error(
              "An X reply was already attempted; review the post.",
            );
          result = await runner.submit(handle, item);
        }
        return {
          resultId: job.resultId,
          resultUrl: job.resultUrl,
          replyResultId: result.replyId,
          replyResultUrl: result.replyUrl,
          replyOutcome: "posted",
        };
      } catch (error) {
        const attempts = (job.replyCheckAttempts || 0) + 1;
        await store.checkpoint(session.id, "x", {
          replyCheckAttempts: attempts,
          replyCheckAfter: now() + 5 * 60_000,
        });
        if (attempts >= 3)
          return {
            resultId: job.resultId,
            resultUrl: job.resultUrl,
            replyOutcome:
              input.allowReplySubmit === false || reply.attempted
                ? "unconfirmed"
                : "failed",
          };
        throw error;
      } finally {
        if (handle) await runner.close(handle).catch(() => {});
        await bindingStorage.remove(tabKey);
      }
    }

    async function observePublication(message, sender) {
      if (!sender?.documentId || !Number.isInteger(sender.tab?.id)) return;
      for (const session of await store.list()) {
        const job = session.jobs?.x;
        if (
          !job?.publicationContext ||
          job.resultUrl ||
          ["failed", "blocked", "sheet-complete"].includes(job.stage)
        )
          continue;
        const binding = await savedBinding(session.id);
        const preparedDocument =
          binding?.tabId === sender.tab.id &&
          binding.documentId === sender.documentId;
        const context = job.publicationContext;
        const expectedHash = session.plan.caption.sha256;
        if (message.publicationAttempt) {
          if (!preparedDocument) continue;
          const attempt = message.publicationAttempt;
          if (
            attempt.accountId !== context.accountId ||
            typeof attempt.text !== "string" ||
            (await sha256Text(attempt.text)) !== expectedHash ||
            (attempt.scheduledUtc &&
              attempt.scheduledUtc !== session.plan.xOptions?.scheduledUtc)
          )
            continue;
          await store.checkpoint(session.id, "x", {
            publicationMediaIds: attempt.mediaIds,
          });
          return;
        }
        const directReceipt =
          preparedDocument && message.operation === "CreateTweet";
        if (!job.publicationMediaIds) continue;
        const batch = globalThis.CreatorXCollectorContract.validateBatch(
          message.batch,
        );
        const rows = [];
        for (const row of batch.observations) {
          if (
            row.source !== "network" ||
            row.authorId !== context.accountId ||
            row.inReplyToStatusId ||
            row.isRetweet ||
            !row.media.some((media) => media.type === "video") ||
            BigInt(row.statusId) <= BigInt(context.latestStatusId) ||
            Date.parse(row.createdAt) <
              Date.parse(context.preparedUtc) - 1000 ||
            Date.parse(row.createdAt) > now() + 90_000 ||
            JSON.stringify(
              row.media
                .filter((media) => media.type === "video")
                .map((media) => media.mediaKey?.split("_").pop())
                .sort(),
            ) !== JSON.stringify(job.publicationMediaIds) ||
            (await sha256Text(row.text)) !== expectedHash
          )
            continue;
          rows.push(row);
        }
        if (rows.length !== 1) continue;
        const row = rows[0];
        if (
          !directReceipt &&
          (await store.list()).some(
            (other) =>
              other.id !== session.id &&
              other.jobs?.x?.publicationContext?.accountId ===
                context.accountId &&
              !other.jobs.x.resultUrl &&
              other.plan.caption.sha256 === expectedHash &&
              JSON.stringify(other.jobs.x.publicationMediaIds) ===
                JSON.stringify(job.publicationMediaIds),
          )
        )
          throw new Error(
            "More than one prepared run matches this X video. Review the drafts.",
          );
        const resultUrl = `https://x.com/${context.handle}/status/${row.statusId}`;
        if (
          (await store.list()).some(
            (other) =>
              other.id !== session.id && other.jobs?.x?.resultUrl === resultUrl,
          )
        )
          throw new Error("Another run already owns this X publication.");
        const paidUrl = job.resolvedPaidUrl || session.plan.paidUrl;
        if (paidUrl)
          await globalThis.CreatorXReplyPolicy.forStorage(
            chrome.storage.local,
          ).reserve(row.statusId, paidUrl, {
            line: job.replyLine,
            owner: "editor",
          });
        await store.checkpoint(session.id, "x", {
          resultId: row.statusId,
          resultUrl,
          replyDueAt:
            Date.parse(row.createdAt) +
            (session.plan.xOptions?.replyDelayMinutes || 15) * 60_000,
        });
        return;
      }
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
          const session = await store.load(input.plan.id);
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
          return execute(binding, "prepare", {
            caption: binding.caption,
            xOptions: input.plan.xOptions,
            fileName: input.plan.socialFile.basename,
            ownerHandle: session.jobs.x.publicationContext?.handle,
          });
        },
        async submit(input) {
          const session = await store.load(input.plan.id);
          const preparedCaptionSha256 =
            session?.jobs?.x?.preparedComposerSha256;
          if (!/^[0-9a-f]{64}$/.test(preparedCaptionSha256 || "")) {
            throw new Error(
              "The prepared X caption was not recorded. Prepare the draft again.",
            );
          }
          const authorization = await input.beforeCommit();
          if (authorization?.armed !== true) {
            throw new Error("The X main post was not durably armed.");
          }
          const binding = await bindingFor(input.plan.id);
          return execute(binding, "submit", {
            captionSha256: preparedCaptionSha256,
            xOptions: input.plan.xOptions,
            ownerHandle: session.jobs.x.publicationContext?.handle,
          });
        },
        async captureResult(input) {
          if (resolvePublication) return capturePublishedTeaser(input);
          let scheduled = await store.load(input.plan.id);
          if (
            input.plan.xOptions?.scheduledUtc &&
            !scheduled.jobs.x.resultUrl &&
            Date.parse(input.plan.xOptions.scheduledUtc) <= now() &&
            resolveScheduledResult
          ) {
            const found = await resolveScheduledResult({
              captionSha256: input.plan.caption.sha256,
              scheduledUtc: input.plan.xOptions.scheduledUtc,
              episodeKey: input.plan.catalogue?.id || "",
            });
            if (!found || found.matched === false) return null;
            const verifiedUrl = canonicalXStatus(found.resultUrl);
            if (!verifiedUrl || verifiedUrl.split("/").pop() !== found.resultId)
              throw new Error("The scheduled X result identity is invalid.");
            const postedAt = Date.parse(found.postedUtc);
            if (
              !Number.isFinite(postedAt) ||
              Math.abs(
                postedAt - Date.parse(input.plan.xOptions.scheduledUtc),
              ) > 90_000
            )
              throw new Error("The scheduled X publication time is invalid.");
            await store.checkpoint(input.plan.id, "x", {
              resultId: found.resultId,
              resultUrl: verifiedUrl,
              replyDueAt:
                postedAt + input.plan.xOptions.replyDelayMinutes * 60_000,
            });
            const saved = await savedBinding(input.plan.id);
            let tab;
            try {
              tab = saved && (await chrome.tabs.get(saved.tabId));
            } catch {
              /* Closed scheduled composer. */
            }
            if (
              tab &&
              (!canonicalXStatus(tab.url) ||
                canonicalXStatus(tab.url) === verifiedUrl)
            )
              tab = await chrome.tabs.update(tab.id, {
                url: verifiedUrl,
                active: false,
              });
            else
              tab = await chrome.tabs.create({
                url: verifiedUrl,
                active: false,
              });
            const restored = {
              id: input.plan.id,
              tabId: tab.id,
              caption: "",
              token: "",
            };
            bindings.set(input.plan.id, restored);
            await saveBinding(restored);
          }
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
          const replyPolicy = globalThis.CreatorXReplyPolicy.forStorage(
            chrome.storage.local,
          );
          // Old sessions acquire wording once; new sessions freeze it at preparation.
          const line =
            session.jobs.x.replyLine ?? (await replyPolicy.allocate());
          if (session.jobs.x.replyLine === undefined)
            await store.checkpoint(input.plan.id, "x", { replyLine: line });
          const reply = await replyPolicy.reserve(
            currentUrl.split("/").pop(),
            input.paidUrl,
            { line, owner: "editor" },
          );
          if (reply.owner !== "editor")
            throw new Error(
              "This post already has an automatic reply queued. Review it before replying again.",
            );
          if (input.plan.xOptions?.replyDelayMinutes) {
            const job = session.jobs.x;
            let due = job.replyDueAt;
            if (!due) {
              due = now() + input.plan.xOptions.replyDelayMinutes * 60_000;
              await store.checkpoint(input.plan.id, "x", {
                resultId: currentUrl.split("/").pop(),
                resultUrl: currentUrl,
                replyDueAt: due,
              });
            }
            if (now() < due)
              return {
                status: "reply-prepared",
                resultId: currentUrl.split("/").pop(),
                resultUrl: currentUrl,
              };
          }
          const prepared = await execute(binding, "prepare-reply", {
            paidUrl: input.paidUrl,
            text: reply.text,
          });
          const autoReply =
            input.plan.xOptions?.autoReply ?? input.mode === "autonomous";
          if (prepared.replyResultId || !autoReply) return prepared;
          const authorization = await input.beforeReplyCommit(prepared);
          if (authorization?.armed !== true) {
            throw new Error("The X first reply was not durably armed.");
          }
          const statusId = currentUrl.split("/").pop();
          if (!(await replyPolicy.claim(statusId, reply.text)))
            throw new Error(
              "A reply was already attempted for this X post. Check the post before retrying.",
            );
          return execute(binding, "submit-reply", {
            resultId: prepared.resultId,
            paidUrl: input.paidUrl,
            text: reply.text,
          });
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
      let publicationContext = null;
      if (frozen.targets.x && getPublicationContext) {
        try {
          publicationContext = await getPublicationContext();
        } catch {
          throw new Error(
            "Connect Chrome and scan your X profile before preparing this teaser.",
          );
        }
      }
      await store.create(frozen);
      if (frozen.targets.x) {
        const replyLine = await globalThis.CreatorXReplyPolicy.forStorage(
          chrome.storage.local,
        ).allocate();
        await store.checkpoint(frozen.id, "x", {
          replyLine,
          ...(publicationContext ? { publicationContext } : {}),
        });
      }
      const targets = {};
      if (frozen.targets.x) {
        const tab = await chrome.tabs.create({
          url: X_COMPOSE_URL,
          active: true,
        });
        for (let attempt = 0; attempt < 300; attempt++) {
          const current = await chrome.tabs.get(tab.id);
          if (current?.status === "complete" && current.url === X_COMPOSE_URL)
            break;
          if (attempt === 299)
            throw new Error("The X composer did not finish loading.");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const documentId = await inject(tab.id, true);
        const binding = {
          id: frozen.id,
          tabId: tab.id,
          documentId,
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
      observePublication(message, sender) {
        const next = publicationObservations
          .catch(() => {})
          .then(() => observePublication(message, sender));
        publicationObservations = next;
        return next;
      },
      prepareRedditLinks,
      associateCatalogue: orchestrator.associateCatalogue,
      resume: orchestrator.resumeSocialDistribution,
      start: orchestrator.startSocialDistribution,
    });
  }

  globalThis.CreatorSocialChromeRuntime = Object.freeze({ create });
})();
