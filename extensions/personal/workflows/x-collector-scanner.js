(() => {
  "use strict";

  // Automatic background scans of the owner's own X profile, so posts and
  // metrics stay fresh without the owner browsing. A periodic alarm asks the
  // desktop for the owner, recent post times, when OFEnhancer was started and
  // any "Scan now" request; a scan is due once after every OFEnhancer start,
  // every 6 hours, when a recent post reaches a checkpoint age (24 h, 72 h,
  // 7 d, 30 d) or on request. One scan at a time opens one
  // inactive tab on the owner's with_replies page, lets the passive
  // collector read the first page, then asks the page for older pages one at
  // a time with a 2-4 s pause, stops at the window, the page cap, the end or
  // on the first error, reads the scheduled-post list and closes the tab.
  // Nothing is clicked, typed or posted, and no other account is opened.
  //
  // Every step is written to a live activity log (what the scan is doing,
  // the page and the posts it just read, with X's exact counters) for
  // the dashboards; the log only describes what happened.
  if (globalThis.CreatorXCollectorScanner) return;

  const STORAGE_KEY = "creatorXScanV1";
  const ALARM_NAME = "creator-x-scan";
  // Short enough that the scan after an OFEnhancer start begins within about
  // a minute; a tick that finds nothing due only asks the desktop.
  const ALARM_PERIOD_MINUTES = 1;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const ROUTINE_INTERVAL_MS = 6 * HOUR;
  const CHECKPOINT_AGES_MS = Object.freeze([
    1 * DAY,
    3 * DAY,
    7 * DAY,
    30 * DAY,
  ]);
  // Automatic scans never run closer together than this; a request may run
  // sooner, but never twice within a couple of minutes.
  const MIN_GAP_MS = 30 * MINUTE;
  const MANUAL_MIN_GAP_MS = 2 * MINUTE;
  const ROUTINE_WINDOW_MS = 35 * DAY;
  const ROUTINE_PAGE_CAP = 10;
  // A full scan reads the whole profile timeline until X has no older page;
  // this cap (about 10,000 posts) only guards against a cursor that never ends.
  const BACKFILL_PAGE_CAP = 500;
  // The whole history is read again weekly so older posts' counters refresh.
  const FULL_INTERVAL_MS = 7 * DAY;
  const PAGE_DELAY_MIN_MS = 2_000;
  const PAGE_DELAY_MAX_MS = 4_000;
  const READY_TIMEOUT_MS = 30_000;
  const READY_POLL_MS = 1_000;
  const MAX_SCAN_MS = 8 * MINUTE;
  const FULL_MAX_SCAN_MS = 75 * MINUTE;
  const LOG_LIMIT = 20;
  const ACTIVITY_LIMIT = 150;
  const ACTIVITY_TEXT = 240;
  const SCHEDULED_URL = "https://x.com/compose/post/unsent/scheduled";
  // Rate-limit and authorization answers pause automatic scans: 6 h after
  // the first, doubling per consecutive one up to 48 h. "Scan now" still runs.
  const BACKOFF_BASE_MS = 6 * HOUR;
  const BACKOFF_MAX_MS = 48 * HOUR;
  const BACKOFF_DETAILS = Object.freeze(["http-401", "http-403", "http-429"]);
  // The scan tab's URL carries this run's marker so a restarted worker can
  // recognise its own leftover tab and nothing else.
  const MARKER_PREFIX = "#creator-scan=";
  const MARKER = /^[0-9a-f]{32}$/;
  const SUCCESS = Object.freeze([
    "complete",
    "window-reached",
    "no-new-posts",
    "page-cap",
  ]);
  const OUTCOMES = Object.freeze([
    ...SUCCESS,
    "owner-unknown",
    "owner-mismatch",
    "signed-out",
    "no-timeline",
    "timeout",
    "user-took-over",
    "error",
  ]);
  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const ID = /^\d{1,25}$/;
  const TRIGGER_LABELS = Object.freeze({
    startup: "OFEnhancer was started",
    routine: "six hours since the last scan",
    checkpoint: "a recent post reached a 24 h / 72 h / 7 d / 30 d checkpoint",
    requested: "Scan now was requested in OFEnhancer",
    manual: "Scan now was pressed on the dashboard",
  });
  const OUTCOME_LABELS = Object.freeze({
    complete: "reached the end of your timeline",
    "window-reached": "reached posts older than the scan window",
    "no-new-posts": "the last page brought no new posts",
    "page-cap": "read the maximum number of pages for this scan",
    "owner-unknown":
      "your X account is not known yet; open x.com once while signed in",
    "owner-mismatch":
      "Chrome is signed in to a different X account than the recorded one",
    "signed-out": "Chrome is not signed in to X",
    "no-timeline": "X did not show your timeline",
    timeout: "the scan ran out of time (8 minutes, 75 for a full scan)",
    "user-took-over": "you opened the scan tab, so the scan stepped aside",
    error: "X gave an answer the scan could not use",
  });
  const DETAIL = /^[a-z0-9-]{1,40}$/;

  const contract = globalThis.CreatorXCollectorContract;

  class ScanStop extends Error {
    constructor(code, detail = "") {
      super(code);
      this.code = code;
      this.detail = detail;
    }
  }

  function emptyState() {
    return {
      version: 1,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      backfillDone: false,
      lastFullAt: 0,
      running: null,
      last: null,
      log: [],
      lastError: "",
      backoffErrors: 0,
      backoffUntil: 0,
    };
  }

  function makeMarker() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function backoffMs(errors) {
    return Math.min(
      BACKOFF_BASE_MS * 2 ** Math.max(errors - 1, 0),
      BACKOFF_MAX_MS,
    );
  }

  function validOwner(plan) {
    const owner = plan?.owner;
    return owner &&
      typeof owner.accountId === "string" &&
      ID.test(owner.accountId) &&
      typeof owner.handle === "string" &&
      HANDLE.test(owner.handle)
      ? { accountId: owner.accountId, handle: owner.handle }
      : null;
  }

  // Why an automatic scan is due now, or "" when it is not.
  function dueReason(state, plan, at) {
    const requested = Date.parse(String(plan?.requestedUtc || ""));
    const last = Number(state.lastAttemptAt) || 0;
    if (Number.isFinite(requested) && requested > last) {
      return at - last >= MANUAL_MIN_GAP_MS ? "requested" : "";
    }
    if ((Number(state.backoffUntil) || 0) > at) return "";
    // Once per OFEnhancer start: the first tick after the desktop started.
    const started = Date.parse(String(plan?.desktopStartedUtc || ""));
    if (Number.isFinite(started) && started > last && started <= at)
      return at - last >= MANUAL_MIN_GAP_MS ? "startup" : "";
    if (last && at - last < MIN_GAP_MS) return "";
    if (!last || at - last >= ROUTINE_INTERVAL_MS) return "routine";
    const posts = Array.isArray(plan?.recentPostsUtc)
      ? plan.recentPostsUtc
      : [];
    for (const value of posts) {
      const posted = Date.parse(String(value || ""));
      if (!Number.isFinite(posted)) continue;
      if (
        CHECKPOINT_AGES_MS.some((age) => {
          const checkpoint = posted + age;
          return checkpoint > last && checkpoint <= at;
        })
      )
        return "checkpoint";
    }
    return "";
  }

  function create({
    storage,
    desktop,
    runner,
    now = Date.now,
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    marker = makeMarker,
    onActivity = (_snapshot) => {},
  }) {
    if (
      !storage ||
      typeof desktop?.plan !== "function" ||
      typeof desktop?.record !== "function" ||
      typeof runner?.open !== "function"
    )
      throw new Error("The X scan dependencies are unavailable.");
    /** @type {Promise<any> | null} */
    let active = null;
    let activity = emptyActivity();

    function emptyActivity() {
      return {
        version: 1,
        runId: "",
        running: false,
        trigger: "",
        mode: "",
        phase: "idle",
        startedUtc: "",
        updatedUtc: "",
        pages: 0,
        rows: 0,
        // Owner posts the catalogue already holds for this scan's range
        // (0 when unknown): the progress total shown beside "Scan".
        expected: 0,
        outcome: "",
        posts: [],
        events: [],
      };
    }

    function knownCount(value) {
      const count = Number(value);
      return Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000
        ? count
        : 0;
    }

    function iso(value = now()) {
      return new Date(value).toISOString();
    }

    function publish() {
      activity.updatedUtc = iso();
      try {
        void Promise.resolve(onActivity(snapshot())).catch(() => {});
      } catch {
        // The log is informative only; a failing listener never stops a scan.
      }
    }

    function snapshot() {
      return JSON.parse(JSON.stringify(activity));
    }

    // One line of the live log; kind is step, post, warn or done.
    function note(kind, text, extra = {}) {
      activity.events.push({
        at: iso(),
        kind,
        text: String(text).slice(0, ACTIVITY_TEXT),
        ...extra,
      });
      if (activity.events.length > ACTIVITY_LIMIT)
        activity.events.splice(0, activity.events.length - ACTIVITY_LIMIT);
      publish();
    }

    function phase(name, text) {
      activity.phase = name;
      note("step", text);
    }

    // Local, readable time for log lines ("Oct 1, 11:00 AM" in en-US).
    function when(value) {
      const time = Date.parse(String(value || ""));
      return Number.isFinite(time)
        ? new Date(time).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
    }

    function number(value) {
      return Number(value).toLocaleString("en-US");
    }

    function plural(count, one, many = `${one}s`) {
      return `${number(count)} ${count === 1 ? one : many}`;
    }

    function countsText(metrics) {
      if (!metrics) return "no counters (X sends none for reposts)";
      const parts = [
        ["views", "view"],
        ["likes", "like"],
        ["reposts", "repost"],
        ["replies", "reply", "replies"],
        ["bookmarks", "bookmark"],
      ]
        .filter(([key]) => metrics[key] !== null && metrics[key] !== undefined)
        .map(([key, one, many]) => plural(metrics[key], one, many));
      return parts.length ? parts.join(" · ") : "X sent no counters";
    }

    // One "post" line per post the page brought, newest first, with the
    // counters exactly as X sent them.
    function notePosts(label, posts, fresh) {
      activity.posts = posts;
      for (const post of posts) {
        const what =
          post.kind === "repost"
            ? "Repost"
            : post.kind === "reply"
              ? "Reply"
              : post.mediaType === "video"
                ? "Video post"
                : post.mediaType
                  ? "Image post"
                  : "Text post";
        note(
          "post",
          `${label}: ${what} ${post.statusId}${fresh.has(post.statusId) ? "" : " (already seen in this scan)"} — ${countsText(post.metrics)}`,
          { post },
        );
      }
    }

    async function load() {
      const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      const state = emptyState();
      if (stored?.version !== 1) return state;
      return { ...state, ...stored, log: [...(stored.log || [])] };
    }

    const save = (state) => storage.set({ [STORAGE_KEY]: state });

    function pageDelay() {
      const unit = Math.min(Math.max(Number(random()) || 0, 0), 1);
      return Math.round(
        PAGE_DELAY_MIN_MS + unit * (PAGE_DELAY_MAX_MS - PAGE_DELAY_MIN_MS),
      );
    }

    function checkOwner(reply, owner) {
      if (reply?.ownerId && reply.ownerId !== owner.accountId)
        throw new ScanStop("owner-mismatch");
    }

    // The owner switched to the scan tab (or closed it): stop at once and
    // leave the tab alone.
    async function guard(handle) {
      if (await runner.takenOver?.(handle))
        throw new ScanStop("user-took-over");
    }

    async function waitReady(handle, owner) {
      const startedAt = now();
      let lastReason = "";
      phase(
        "loading",
        "Waiting for X to load your timeline in the background tab (up to 30 s)",
      );
      for (;;) {
        await guard(handle);
        const status = await runner.command(handle, "status");
        if (status?.ok) {
          checkOwner(status, owner);
          if (status.ready) {
            if (!status.ownerId) throw new ScanStop("signed-out");
            return status;
          }
        } else lastReason = String(status?.reason || "");
        if (now() - startedAt >= READY_TIMEOUT_MS)
          throw new ScanStop("no-timeline", lastReason);
        await sleep(READY_POLL_MS);
      }
    }

    // The page's own stop signals: the end of the timeline, or a page whose
    // newest post is already older than the window (pinned and thread posts
    // are older than the page they sit on, so the newest is the safe bound).
    function pageStop(page, cutoff) {
      if (!page.cursor) return "complete";
      const newest = Date.parse(String(page.newestUtc || ""));
      if (Number.isFinite(newest) && newest < cutoff) return "window-reached";
      return "";
    }

    function cleanDetail(value) {
      const text = String(value || "");
      return DETAIL.test(text) ? text : "";
    }

    // Only this worker scans; with no scan active here, a run record is from
    // a stopped worker, so its tab is closed and the record cleared.
    async function clearStaleRun(state, ownRun = false) {
      if (!state.running || (!ownRun && active !== null)) return;
      if (state.running.tabId && state.running.marker)
        await Promise.resolve()
          .then(() =>
            runner.closeStale?.(state.running.tabId, state.running.marker),
          )
          .catch(() => {});
      state.running = null;
      await save(state);
    }

    async function execute(trigger, plan) {
      const state = await load();
      await clearStaleRun(state, true);
      const at = now();
      if (!plan) {
        try {
          plan = await desktop.plan();
        } catch (error) {
          state.lastError = String(error?.message || error).slice(0, 200);
          await save(state);
          return { ran: false, reason: "desktop-unavailable" };
        }
      }
      const owner = validOwner(plan);
      // Every desktop opening refreshes the entire history. Background ticks
      // keep the shorter window, with a weekly full pass and interrupted retry.
      const backfill =
        trigger === "startup" ||
        trigger === "requested" ||
        trigger === "manual" ||
        !state.backfillDone ||
        at - (Number(state.lastFullAt) || 0) >= FULL_INTERVAL_MS;
      activity = {
        ...emptyActivity(),
        running: true,
        trigger,
        mode: backfill ? "backfill" : "routine",
        phase: "starting",
        startedUtc: iso(at),
        expected: knownCount(
          backfill ? plan?.knownPosts : plan?.knownPostsInWindow,
        ),
      };
      note(
        "step",
        `Scan started because ${TRIGGER_LABELS[trigger] || trigger}${
          backfill
            ? state.backfillDone
              ? trigger === "startup" ||
                trigger === "requested" ||
                trigger === "manual"
                ? " — full read of your whole history to refresh every post's counters"
                : " — weekly full read of your whole history to refresh every post's counters"
              : " — first full read of your whole history"
            : " — reading the last 35 days (up to 10 pages)"
        }`,
      );
      const result = {
        trigger,
        mode: backfill ? "backfill" : "routine",
        startedUtc: new Date(at).toISOString(),
        finishedUtc: "",
        outcome: "error",
        detail: "",
        pages: 0,
        rows: 0,
        scheduled: null,
        backoffUntilUtc: "",
      };
      state.lastAttemptAt = at;
      state.lastError = "";
      let handle = null;
      let leaveTab = false;
      try {
        if (!owner) throw new ScanStop("owner-unknown");
        const runMarker = marker();
        activity.runId = runMarker;
        phase(
          "opening",
          `Opening an inactive background tab on x.com/${owner.handle}/with_replies using your existing Chrome sign-in`,
        );
        state.running = {
          startedAt: at,
          trigger,
          tabId: null,
          marker: runMarker,
        };
        await save(state);
        const cutoff = backfill ? -Infinity : at - ROUTINE_WINDOW_MS;
        const cap = backfill ? BACKFILL_PAGE_CAP : ROUTINE_PAGE_CAP;
        handle = await runner.open(
          owner.handle,
          async (tabId) => {
            state.running.tabId = tabId;
            await save(state);
          },
          runMarker,
        );
        const first = await waitReady(handle, owner);
        note(
          "step",
          `Signed in as account ${first.ownerId}, the recorded owner @${owner.handle} — reading page 1 from X's own timeline answer`,
        );
        const seen = new Set(first.statusIds || []);
        result.pages = 1;
        result.rows = seen.size;
        activity.pages = 1;
        activity.rows = seen.size;
        activity.phase = "reading";
        note(
          "step",
          `Page 1: read ${plural(seen.size, "post")} of yours${when(first.newestUtc) ? `, newest from ${when(first.newestUtc)}` : ""}`,
        );
        notePosts(
          "Page 1",
          contract?.validScanPreviews(first.posts) || [],
          seen,
        );
        let stop = pageStop(first, cutoff);
        while (!stop) {
          if (result.pages >= cap) {
            stop = "page-cap";
            break;
          }
          if (now() - at >= (backfill ? FULL_MAX_SCAN_MS : MAX_SCAN_MS))
            throw new ScanStop("timeout");
          await guard(handle);
          const delay = pageDelay();
          phase(
            "waiting",
            `Pausing ${(delay / 1000).toFixed(1)} s before page ${result.pages + 1} so requests stay gentle`,
          );
          await sleep(delay);
          await guard(handle);
          phase(
            "paging",
            `Asking X for page ${result.pages + 1} with the same timeline request X itself made`,
          );
          const page = await runner.command(handle, "page");
          if (!page?.ok)
            throw new ScanStop(
              page?.reason === "signed-out" ? "signed-out" : "error",
              page?.reason,
            );
          checkOwner(page, owner);
          if (!page.ownerId) throw new ScanStop("signed-out");
          result.pages += 1;
          const fresh = (page.statusIds || []).filter((id) => !seen.has(id));
          for (const id of fresh) seen.add(id);
          result.rows += fresh.length;
          activity.pages = result.pages;
          activity.rows = result.rows;
          activity.phase = "reading";
          note(
            "step",
            `Page ${result.pages}: read ${plural((page.statusIds || []).length, "post")}, ${number(fresh.length)} new in this scan${when(page.newestUtc) ? `, newest from ${when(page.newestUtc)}` : ""}`,
          );
          notePosts(
            `Page ${result.pages}`,
            contract?.validScanPreviews(page.posts) || [],
            new Set(fresh),
          );
          // Duplicate/empty owner pages do not establish the end of history.
          // X's next cursor can still lead to older posts during a full scan.
          stop =
            backfill || fresh.length ? pageStop(page, cutoff) : "no-new-posts";
        }
        result.outcome = stop;
        note("step", `Stopped paging: ${OUTCOME_LABELS[stop] || stop}`);
        if (typeof runner.scheduled === "function") {
          await guard(handle);
          phase(
            "scheduled",
            "Opening your scheduled-posts list in the same tab (up to 25 s)",
          );
          const count = await Promise.resolve()
            .then(() => runner.scheduled(handle))
            .catch((error) => {
              if (error instanceof ScanStop && error.code === "user-took-over")
                throw error;
              return null;
            });
          result.scheduled = Number.isSafeInteger(count) ? count : null;
          note(
            result.scheduled === null ? "warn" : "step",
            result.scheduled === null
              ? "The scheduled-posts list did not arrive in time; it stays as last recorded"
              : `Read ${plural(result.scheduled, "scheduled post")}`,
          );
        }
      } catch (error) {
        result.outcome =
          error instanceof ScanStop && OUTCOMES.includes(error.code)
            ? error.code
            : "error";
        result.detail = cleanDetail(
          error instanceof ScanStop ? error.detail : "",
        );
        if (!(error instanceof ScanStop))
          state.lastError = String(error?.message || error).slice(0, 200);
        leaveTab = result.outcome === "user-took-over";
        note(
          "warn",
          `Scan stopped: ${OUTCOME_LABELS[result.outcome] || result.outcome}${result.detail ? ` (${result.detail})` : ""}`,
        );
      } finally {
        if (handle && !leaveTab) {
          activity.phase = "closing";
          note("step", "Closing the background tab");
          await Promise.resolve()
            .then(() => runner.close(handle))
            .catch(() => {});
        }
        state.running = null;
        result.finishedUtc = new Date(now()).toISOString();
        if (backfill) state.backfillDone = result.outcome === "complete";
        if (SUCCESS.includes(result.outcome)) {
          state.lastSuccessAt = at;
          if (backfill && state.backfillDone) {
            state.lastFullAt = at;
          }
          state.backoffErrors = 0;
          state.backoffUntil = 0;
        } else if (
          result.outcome === "error" &&
          BACKOFF_DETAILS.includes(result.detail)
        ) {
          state.backoffErrors = (Number(state.backoffErrors) || 0) + 1;
          state.backoffUntil = now() + backoffMs(state.backoffErrors);
        }
        if ((Number(state.backoffUntil) || 0) > now())
          result.backoffUntilUtc = new Date(state.backoffUntil).toISOString();
        state.last = result;
        state.log.unshift(result);
        state.log.length = Math.min(state.log.length, LOG_LIMIT);
        await save(state);
        const seconds = Math.max(
          Math.round((Date.parse(result.finishedUtc) - at) / 1000),
          0,
        );
        activity.running = false;
        activity.phase = "done";
        activity.outcome = result.outcome;
        note(
          SUCCESS.includes(result.outcome) ? "done" : "warn",
          `${SUCCESS.includes(result.outcome) ? "Finished" : "Ended"}: ${plural(result.pages, "page")}, ${plural(result.rows, "post")} recorded with fresh counters in ${seconds} s${
            result.backoffUntilUtc
              ? ` — automatic scans paused until ${when(result.backoffUntilUtc)} after X's ${result.detail.replace("http-", "HTTP ")} answer`
              : ""
          }`,
        );
      }
      try {
        await desktop.record(result);
      } catch (error) {
        state.lastError = String(error?.message || error).slice(0, 200);
        await save(state);
      }
      return { ran: true, ...result };
    }

    // One scan at a time; a second start while one runs is refused.
    function run(trigger, plan = null) {
      if (active !== null)
        return Promise.resolve({ ran: false, reason: "busy" });
      const job = execute(trigger, plan).finally(() => {
        if (active === job) active = null;
      });
      active = job;
      return job;
    }

    async function tick() {
      if (active !== null) return { ran: false, reason: "busy" };
      const state = await load();
      await clearStaleRun(state);
      let plan;
      try {
        plan = await desktop.plan();
      } catch (error) {
        state.lastError = String(error?.message || error).slice(0, 200);
        await save(state);
        return { ran: false, reason: "desktop-unavailable" };
      }
      const reason = dueReason(state, plan, now());
      if (!reason) return { ran: false, reason: "not-due" };
      return run(reason, plan);
    }

    // "Scan now" from an extension page: starts at once unless a scan is
    // running or one started within the last couple of minutes.
    async function requestNow() {
      if (active !== null)
        return { requested: true, started: false, reason: "busy" };
      const state = await load();
      if (
        state.lastAttemptAt &&
        now() - state.lastAttemptAt < MANUAL_MIN_GAP_MS
      )
        return { requested: true, started: false, reason: "too-soon" };
      void run("manual").catch(() => {});
      return { requested: true, started: true, reason: "" };
    }

    async function status() {
      const state = await load();
      return {
        running: active !== null,
        backfillDone: state.backfillDone,
        lastFullUtc: state.lastFullAt
          ? new Date(state.lastFullAt).toISOString()
          : "",
        lastAttemptUtc: state.lastAttemptAt
          ? new Date(state.lastAttemptAt).toISOString()
          : "",
        last: state.last,
        log: state.log,
        lastError: state.lastError,
        backoffUntilUtc:
          (Number(state.backoffUntil) || 0) > now()
            ? new Date(state.backoffUntil).toISOString()
            : "",
        activity: snapshot(),
      };
    }

    function noteScheduled(tabId, count) {
      runner.noteScheduled?.(tabId, count);
    }

    return Object.freeze({
      tick,
      run,
      requestNow,
      status,
      activity: snapshot,
      noteScheduled,
      idle: () => active ?? Promise.resolve(),
    });
  }

  function profileMatches(value, handle) {
    try {
      const url = new URL(String(value || ""));
      return (
        url.origin === "https://x.com" &&
        url.pathname.toLowerCase().replace(/\/$/, "") ===
          `/${handle.toLowerCase()}/with_replies`
      );
    } catch {
      return false;
    }
  }

  function createChromeRunner({
    chrome,
    loadTimeoutMs = 45_000,
    scheduledTimeoutMs = 25_000,
    pollMs = 250,
  }) {
    const scheduledWaiters = new Map();
    const activated = new Set();
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Any activation of a scan tab, even a brief one, hands it to the owner.
    chrome.tabs.onActivated?.addListener(({ tabId }) => activated.add(tabId));

    async function takenOver(tabId) {
      if (activated.has(tabId)) return true;
      try {
        return Boolean((await chrome.tabs.get(tabId)).active);
      } catch {
        // The owner closed it.
        return true;
      }
    }

    async function waitLoaded(tabId, handle) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < loadTimeoutMs) {
        if (await takenOver(tabId)) throw new ScanStop("user-took-over");
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" && tab.url && tab.url !== "about:blank") {
          if (profileMatches(tab.url, handle)) return;
          // X sent the tab elsewhere (signed out, suspended, renamed).
          throw new ScanStop("no-timeline", "redirected");
        }
        await wait(pollMs);
      }
      throw new ScanStop("no-timeline", "load-timeout");
    }

    return Object.freeze({
      async open(handle, onTab = async (_tabId) => {}, marker = "") {
        // A blank background tab first, then an ordinary navigation of it,
        // so observers attached to the new tab also see the profile load.
        const tab = await chrome.tabs.create({
          url: "about:blank",
          active: false,
        });
        // A full scan can take a while; Chrome must not unload the tab.
        await Promise.resolve()
          .then(() => chrome.tabs.update(tab.id, { autoDiscardable: false }))
          .catch(() => {});
        const suffix = MARKER.test(marker) ? `${MARKER_PREFIX}${marker}` : "";
        try {
          await onTab(tab.id);
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if ((await chrome.tabs.get(tab.id)).status === "complete") break;
            await wait(50);
          }
          if (await takenOver(tab.id)) throw new ScanStop("user-took-over");
          await chrome.tabs.update(tab.id, {
            url: `https://x.com/${handle}/with_replies${suffix}`,
          });
          await waitLoaded(tab.id, handle);
        } catch (error) {
          if (!(error instanceof ScanStop && error.code === "user-took-over"))
            await chrome.tabs.remove(tab.id).catch(() => {});
          throw error;
        }
        return { tabId: tab.id, suffix };
      },
      async command(handle, command) {
        try {
          const reply = await chrome.tabs.sendMessage(
            handle.tabId,
            { type: "CREATOR_X_SCAN_COMMAND", command },
            { frameId: 0 },
          );
          return reply && typeof reply === "object"
            ? reply
            : { ok: false, reason: "no-reply" };
        } catch {
          return { ok: false, reason: "no-relay" };
        }
      },
      // Opens the scheduled-post list in the same tab and waits for the
      // collector to report it; null when nothing arrived in time.
      async scheduled(handle) {
        let received = null;
        let done = false;
        scheduledWaiters.set(handle.tabId, (count) => {
          received = count;
          done = true;
        });
        try {
          if (await takenOver(handle.tabId))
            throw new ScanStop("user-took-over");
          await chrome.tabs.update(handle.tabId, {
            url: `${SCHEDULED_URL}${handle.suffix || ""}`,
          });
          const startedAt = Date.now();
          while (!done && Date.now() - startedAt < scheduledTimeoutMs) {
            await wait(pollMs);
            if (await takenOver(handle.tabId))
              throw new ScanStop("user-took-over");
          }
          return received;
        } finally {
          scheduledWaiters.delete(handle.tabId);
        }
      },
      noteScheduled(tabId, count) {
        scheduledWaiters.get(tabId)?.(count);
      },
      takenOver: (handle) => takenOver(handle.tabId),
      close: (handle) => chrome.tabs.remove(handle.tabId),
      // After a worker restart, close the scan tab left behind only while it
      // is still inactive and its x.com URL carries that run's marker.
      async closeStale(tabId, marker) {
        if (!MARKER.test(String(marker || ""))) return;
        const tab = await chrome.tabs.get(tabId);
        let url;
        try {
          url = new URL(String(tab.url || tab.pendingUrl || ""));
        } catch {
          return;
        }
        if (
          !tab.active &&
          url.origin === "https://x.com" &&
          url.hash === `${MARKER_PREFIX}${marker}`
        )
          await chrome.tabs.remove(tabId);
      },
    });
  }

  globalThis.CreatorXCollectorScanner = Object.freeze({
    STORAGE_KEY,
    ALARM_NAME,
    ALARM_PERIOD_MINUTES,
    CHECKPOINT_AGES_MS,
    ROUTINE_INTERVAL_MS,
    ROUTINE_WINDOW_MS,
    ROUTINE_PAGE_CAP,
    BACKFILL_PAGE_CAP,
    FULL_INTERVAL_MS,
    FULL_MAX_SCAN_MS,
    PAGE_DELAY_MIN_MS,
    PAGE_DELAY_MAX_MS,
    MIN_GAP_MS,
    MANUAL_MIN_GAP_MS,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    SCHEDULED_URL,
    OUTCOMES,
    ACTIVITY_LIMIT,
    dueReason,
    create,
    createChromeRunner,
  });
})();
