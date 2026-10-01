(() => {
  "use strict";

  // Automatic delayed first reply under the owner's X teasers. The desktop
  // lists recent bound teasers without an owner reply; each one is scheduled
  // once in chrome.storage.local for a random time 15-60 minutes after it was
  // posted and replied to at most once: the record is durably marked
  // submit-attempted before Reply is clicked and is never retried afterwards.
  if (globalThis.CreatorXFirstReply) return;

  const STORAGE_KEY = "creatorXFirstReplyV1";
  const SETTINGS_KEY = "creatorXFirstReplySettingsV1";
  const ALARM_NAME = "creator-x-first-reply";
  const ALARM_PERIOD_MINUTES = 5;
  const VARIANTS = Object.freeze([
    "full vid (no ppv)",
    "full session",
    "full vid :)",
  ]);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const MIN_DELAY_MINUTES = 15;
  const MAX_DELAY_MINUTES = 60;
  const LATE_AFTER_MS = 2 * HOUR;
  const GIVE_UP_AFTER_MS = 24 * HOUR;
  const PRUNE_AFTER_MS = 48 * HOUR;
  const RETRY_DELAY_MS = 10 * MINUTE;
  const MAX_ATTEMPTS = 3;
  const LOG_LIMIT = 50;
  const OUTCOMES = Object.freeze([
    "posted",
    "skipped-existing-reply",
    "no-link",
    "card-not-removed",
    "mismatch",
    "late-given-up",
    "unconfirmed",
    "wrong-account",
    "binding-changed",
    "no-longer-eligible",
    "error",
  ]);
  const FAILURE_CODES = new Set([
    "card-not-removed",
    "mismatch",
    "existing-reply",
    "not-owner-teaser",
    "composer-missing",
    "unconfirmed",
    "wrong-account",
  ]);
  const PAID_URL = /^https:\/\/onlyfans\.com\/\d{1,30}\/johnny_guides$/;
  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const STATUS_ID = /^\d{1,25}$/;
  const EVIDENCE = /^[0-9a-f]{64}$/;

  function canonicalPaidUrl(value) {
    return typeof value === "string" && PAID_URL.test(value) ? value : "";
  }

  function replyText(variant, paidUrl) {
    return `${variant}\n-> ${paidUrl}`;
  }

  function evidencePresent(registry) {
    return EVIDENCE.test(String(registry?.liveCheck || ""));
  }

  // Only the owner's own teaser (video, not a reply, not a repost) bound to
  // one episode, with no owner reply yet and a canonical OnlyFans link.
  function eligibility(candidate, ownerHandle) {
    if (!HANDLE.test(String(ownerHandle || "")))
      return { ok: false, reason: "no-owner" };
    if (!STATUS_ID.test(String(candidate?.statusId || "")))
      return { ok: false, reason: "invalid" };
    if (!Number.isFinite(Date.parse(String(candidate.postedUtc || ""))))
      return { ok: false, reason: "invalid" };
    if (
      candidate.hasVideo !== true ||
      candidate.isReply !== false ||
      candidate.isRepost !== false
    )
      return { ok: false, reason: "not-teaser" };
    if (typeof candidate.itemId !== "string" || !candidate.itemId)
      return { ok: false, reason: "unbound" };
    if (candidate.ownerReplyExists !== false)
      return { ok: false, reason: "existing-reply" };
    if (!canonicalPaidUrl(candidate.paidUrl))
      return { ok: false, reason: "no-link" };
    return { ok: true, reason: "" };
  }

  function planItem(candidate, ownerHandle, { now, random, rotation }) {
    const postedAt = Date.parse(candidate.postedUtc);
    const unit = Math.min(Math.max(Number(random()) || 0, 0), 1);
    const delayMinutes =
      MIN_DELAY_MINUTES + unit * (MAX_DELAY_MINUTES - MIN_DELAY_MINUTES);
    const variant = VARIANTS[rotation % VARIANTS.length];
    return {
      statusId: candidate.statusId,
      statusUrl: `https://x.com/${ownerHandle}/status/${candidate.statusId}`,
      ownerHandle,
      itemId: candidate.itemId,
      paidUrl: candidate.paidUrl,
      variant,
      text: replyText(variant, candidate.paidUrl),
      postedAt,
      notBefore: postedAt + Math.round(delayMinutes * MINUTE),
      dueAt: postedAt + Math.round(delayMinutes * MINUTE),
      deadline: postedAt + GIVE_UP_AFTER_MS,
      scheduledAt: now,
      state: "pending",
      attempts: 0,
      late: false,
      outcome: "",
    };
  }

  function failureCode(error) {
    const match = String(error?.message || error || "").match(/^([a-z-]+):/);
    return match && FAILURE_CODES.has(match[1]) ? match[1] : "error";
  }

  function emptyState() {
    return {
      version: 1,
      rotation: 0,
      items: {},
      log: [],
      counters: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
      lastPollUtc: "",
      lastError: "",
    };
  }

  function create({
    storage,
    fetchQueue,
    runner,
    evidence = {},
    now = Date.now,
    random = Math.random,
  }) {
    if (
      !storage ||
      typeof fetchQueue !== "function" ||
      !runner ||
      typeof runner.open !== "function"
    )
      throw new Error("The X first-reply dependencies are unavailable.");
    // Overlapping alarm callbacks run one after another, never together.
    /** @type {Promise<unknown>} */
    let chain = Promise.resolve();

    async function load() {
      const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      const state = emptyState();
      if (stored?.version !== 1) return state;
      return {
        ...state,
        ...stored,
        items: { ...(stored.items || {}) },
        log: [...(stored.log || [])],
        counters: { ...state.counters, ...(stored.counters || {}) },
      };
    }

    const save = (state) => storage.set({ [STORAGE_KEY]: state });
    const closeQuietly = (handle) =>
      Promise.resolve()
        .then(() => runner.close(handle))
        .catch(() => {});

    async function settings() {
      const stored = (await storage.get(SETTINGS_KEY))[SETTINGS_KEY];
      const hasEvidence = evidencePresent(evidence);
      const explicit = typeof stored?.enabled === "boolean";
      return {
        evidence: hasEvidence,
        explicit,
        enabled: explicit ? stored.enabled : hasEvidence,
      };
    }

    function log(state, item, outcome, at, detail = "") {
      state.counters[outcome] = (state.counters[outcome] || 0) + 1;
      state.log.unshift({
        statusId: item.statusId,
        outcome,
        late: Boolean(item.late),
        attempts: item.attempts,
        at: new Date(at).toISOString(),
        ...(item.replyId ? { replyId: item.replyId } : {}),
        ...(detail ? { detail } : {}),
      });
      state.log.length = Math.min(state.log.length, LOG_LIMIT);
    }

    function finish(state, item, outcome, at, extra = {}) {
      Object.assign(item, extra, {
        state: "finished",
        outcome,
        finishedAt: at,
      });
      delete item.tabId;
      log(state, item, outcome, at, extra.detail);
    }

    // Returns the current eligible candidates by status, or null when the
    // desktop could not be asked; nothing runs without a fresh answer.
    async function poll(state, at) {
      let queue;
      try {
        queue = await fetchQueue();
      } catch (error) {
        state.lastError = String(error?.message || error).slice(0, 200);
        return null;
      }
      state.lastPollUtc = new Date(at).toISOString();
      state.lastError = "";
      const owner = String(queue?.ownerHandle || "");
      const current = new Map();
      for (const candidate of Array.isArray(queue?.items) ? queue.items : []) {
        const statusId = String(candidate?.statusId || "");
        const verdict = eligibility(candidate, owner);
        if (verdict.ok) current.set(statusId, { candidate, owner });
        const existing = state.items[statusId];
        // A teaser without a link is revisited while it is inside 24 hours.
        if (existing?.state === "waiting-link" && verdict.ok) {
          delete state.items[statusId];
        }
        // Duplicate guard: a status is scheduled once, whatever its state.
        if (!statusId || Object.hasOwn(state.items, statusId)) continue;
        if (verdict.reason === "no-link" && STATUS_ID.test(statusId)) {
          const postedAt = Date.parse(candidate.postedUtc) || at;
          const item = {
            statusId,
            postedAt,
            deadline: postedAt + GIVE_UP_AFTER_MS,
            attempts: 0,
            state: "waiting-link",
            outcome: "no-link",
          };
          state.items[statusId] = item;
          log(state, item, "no-link", at);
          continue;
        }
        if (!verdict.ok) continue;
        state.items[statusId] = planItem(candidate, owner, {
          now: at,
          random,
          rotation: state.rotation,
        });
        state.rotation += 1;
      }
      return current;
    }

    // The item must still be listed now, for the same owner and link.
    function revalidate(item, current) {
      const listed = current.get(item.statusId);
      if (!listed || listed.owner !== item.ownerHandle)
        return "no-longer-eligible";
      if (
        listed.candidate.paidUrl !== item.paidUrl ||
        item.text !== replyText(item.variant, item.paidUrl)
      )
        return "binding-changed";
      return "";
    }

    async function execute(state, item, at) {
      item.state = "preparing";
      item.attempts += 1;
      item.late = at - item.dueAt > LATE_AFTER_MS;
      await save(state);
      let handle = null;
      try {
        try {
          handle = await runner.open(item, async (tabId) => {
            item.tabId = tabId;
            await save(state);
          });
          const prepared = await runner.prepare(handle, item);
          if (prepared?.status === "existing-reply") {
            finish(state, item, "skipped-existing-reply", now());
            return;
          }
          if (prepared?.status !== "ready")
            throw new Error("mismatch: the reply was not prepared.");
        } catch (error) {
          const code = failureCode(error);
          const detail = String(error?.message || error).slice(0, 200);
          const retryAt = now() + RETRY_DELAY_MS;
          if (code === "existing-reply") {
            finish(state, item, "skipped-existing-reply", now(), { detail });
          } else if (code === "wrong-account") {
            finish(state, item, "wrong-account", now(), { detail });
          } else if (item.attempts < MAX_ATTEMPTS && retryAt < item.deadline) {
            Object.assign(item, {
              state: "pending",
              notBefore: retryAt,
              lastFailure: code,
              detail,
            });
          } else {
            finish(
              state,
              item,
              OUTCOMES.includes(code) ? code : "error",
              now(),
              { detail },
            );
          }
          return;
        }
        // Turning the setting off stops a run that has not clicked yet.
        if (!(await settings()).enabled) {
          item.state = "pending";
          item.attempts -= 1;
          return;
        }
        // Durable checkpoint before the click; from here on nothing is retried.
        item.state = "submit-attempted";
        item.submitAttemptedAt = now();
        await save(state);
        if (!(await settings()).enabled) {
          item.state = "pending";
          item.attempts -= 1;
          delete item.submitAttemptedAt;
          return;
        }
        try {
          const posted = await runner.submit(handle, item);
          finish(state, item, "posted", now(), {
            replyId: String(posted?.replyId || ""),
          });
        } catch (error) {
          const code = failureCode(error);
          finish(
            state,
            item,
            code === "existing-reply"
              ? "skipped-existing-reply"
              : new Set(["card-not-removed", "mismatch", "wrong-account"]).has(
                    code,
                  )
                ? code
                : "unconfirmed",
            now(),
            { detail: String(error?.message || error).slice(0, 200) },
          );
        }
      } finally {
        delete item.tabId;
        await save(state);
        if (handle) await closeQuietly(handle);
      }
    }

    async function runTick() {
      const current = await settings();
      if (!current.enabled) return { ran: false, reason: "disabled" };
      const at = now();
      const state = await load();
      const listed = await poll(state, at);
      for (const item of Object.values(state.items)) {
        // A run interrupted by a worker restart leaves its tab behind.
        if (item.tabId && item.state !== "finished") {
          await Promise.resolve()
            .then(() => runner.closeStale?.(item.tabId, item.statusUrl))
            .catch(() => {});
          delete item.tabId;
        }
        if (item.state === "submit-attempted") {
          // A worker stopped after the checkpoint: the click may have happened.
          finish(state, item, "unconfirmed", at, {
            detail: "The worker stopped after the reply was armed.",
          });
        } else if (item.state === "preparing") {
          item.state = "pending";
        }
        if (item.state === "pending" && at > item.deadline)
          finish(state, item, "late-given-up", at);
        if (item.state === "waiting-link" && at > item.deadline)
          item.state = "finished";
        if (item.state === "finished" && at - item.postedAt > PRUNE_AFTER_MS)
          delete state.items[item.statusId];
      }
      const due = listed
        ? Object.values(state.items)
            .filter((item) => item.state === "pending" && at >= item.notBefore)
            .sort((a, b) => a.notBefore - b.notBefore)[0]
        : null;
      const changed = due ? revalidate(due, listed) : "";
      if (changed) finish(state, due, changed, at);
      await save(state);
      if (!due || changed)
        return { ran: true, executed: "", ...(changed ? { changed } : {}) };
      await execute(state, due, at);
      return { ran: true, executed: due.statusId, outcome: due.outcome };
    }

    function tick() {
      const run = chain.then(runTick);
      chain = run.catch(() => {});
      return run;
    }

    async function status() {
      const current = await settings();
      const state = await load();
      const items = Object.values(state.items);
      return {
        ...current,
        label: current.evidence
          ? current.enabled
            ? "on"
            : "off"
          : current.enabled
            ? "needs one live check (enabled by owner)"
            : "needs one live check",
        pending: items.filter((item) =>
          ["pending", "preparing", "submit-attempted"].includes(item.state),
        ).length,
        next:
          items
            .filter((item) => item.state === "pending")
            .map((item) => item.notBefore)
            .sort((a, b) => a - b)[0] || null,
        counters: state.counters,
        log: state.log,
        lastPollUtc: state.lastPollUtc,
        lastError: state.lastError,
      };
    }

    async function setEnabled(enabled) {
      if (typeof enabled !== "boolean")
        throw new Error("The auto first reply setting must be a boolean.");
      await storage.set({ [SETTINGS_KEY]: { enabled } });
      return status();
    }

    return Object.freeze({ tick, status, setEnabled });
  }

  // Runs one item in a background tab in the owner's profile; the page side
  // lives in the X publisher adapter.
  function invokeCreatorXFirstReply(args) {
    const adapter = globalThis.CreatorXPublisherAdapter;
    const action =
      args.action === "prepare"
        ? adapter?.prepareFirstReply
        : args.action === "submit"
          ? adapter?.submitFirstReply
          : null;
    if (!action)
      return { error: "not-owner-teaser: the X adapter is unavailable." };
    return Promise.resolve(action(args)).then(
      (result) => ({ result }),
      (error) => ({ error: String(error?.message || error) }),
    );
  }

  function createChromeRunner({ chrome, timing = {}, loadTimeoutMs = 30_000 }) {
    function tabStatusUrl(value) {
      try {
        const url = new URL(value || "");
        return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
      } catch {
        return "";
      }
    }

    async function waitForBlank(tabId) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await chrome.tabs.get(tabId)).status === "complete") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async function waitForTab(tabId, statusUrl) {
      const startedAt = Date.now();
      let opened = false;
      while (Date.now() - startedAt < loadTimeoutMs) {
        const tab = await chrome.tabs.get(tabId);
        opened =
          tabStatusUrl(tab.url).toLowerCase() === statusUrl.toLowerCase();
        if (tab.status === "complete" && opened) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        opened
          ? "The X status tab did not finish loading."
          : "not-owner-teaser: the X status did not open.",
      );
    }

    async function run(handle, item, action) {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: handle.tabId },
        func: invokeCreatorXFirstReply,
        args: [
          {
            action,
            statusId: item.statusId,
            ownerHandle: item.ownerHandle,
            text: item.text,
            paidUrl: item.paidUrl,
            timing,
          },
        ],
      });
      const value = execution?.result;
      if (value?.error) throw new Error(value.error);
      if (!value?.result)
        throw new Error(`The X first-reply ${action} returned no result.`);
      return value.result;
    }

    return Object.freeze({
      async open(item, onTab = async (_tabId) => {}) {
        // A blank background tab first, then an ordinary navigation of it to
        // the status, so observers attached to the tab also see the load.
        const tab = await chrome.tabs.create({
          url: "about:blank",
          active: false,
        });
        const handle = { tabId: tab.id };
        try {
          await onTab(tab.id);
          await waitForBlank(tab.id);
          await chrome.tabs.update(tab.id, { url: item.statusUrl });
          await waitForTab(tab.id, item.statusUrl);
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["workflows/x-publisher-adapter.js"],
          });
        } catch (error) {
          await chrome.tabs.remove(tab.id).catch(() => {});
          throw error;
        }
        return handle;
      },
      prepare: (handle, item) => run(handle, item, "prepare"),
      submit: (handle, item) => run(handle, item, "submit"),
      close: (handle) => chrome.tabs.remove(handle.tabId),
      // After a worker restart, close the tab a run left behind only while it
      // still shows that run's status or is still a blank background tab.
      async closeStale(tabId, statusUrl) {
        const tab = await chrome.tabs.get(tabId);
        const url = tabStatusUrl(tab.url || tab.pendingUrl);
        if (
          url.toLowerCase() === String(statusUrl || "").toLowerCase() ||
          (tab.url === "about:blank" && !tab.active)
        )
          await chrome.tabs.remove(tabId);
      },
    });
  }

  globalThis.CreatorXFirstReply = Object.freeze({
    STORAGE_KEY,
    SETTINGS_KEY,
    ALARM_NAME,
    ALARM_PERIOD_MINUTES,
    VARIANTS,
    OUTCOMES,
    canonicalPaidUrl,
    replyText,
    evidencePresent,
    eligibility,
    planItem,
    create,
    createChromeRunner,
  });
})();
