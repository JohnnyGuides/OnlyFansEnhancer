(function attachTeaserDashboard(global) {
  "use strict";

  // One-page X teaser dashboard shared by the desktop workspace's Twitter view
  // and the extension's teaser-dashboard page. It reads the desktop teaser
  // overview (including the owner's X scheduled posts and the background
  // scan status) and the owner-local plan; it never posts or schedules on X.
  // "Scan now" only asks Chrome's background scanner to read the owner's
  // own profile.
  const DAY_MS = 86400000;
  const ABOVE_USUAL = 1.15;
  const BELOW_USUAL = 0.8;
  const PICK_WINDOW_DAYS = 7;
  const HISTORY_ROW_DAYS = 14;
  const HISTORY_MAX_ROWS = 26;
  const TREND_PERIODS = [
    [3, "3 days"],
    [7, "7 days"],
    [14, "14 days"],
    [30, "30 days"],
  ];
  const HISTORY_PERIODS = [
    ["30", "30 days"],
    ["90", "90 days"],
    ["all", "All"],
  ];
  const ICONS = {
    scissors:
      "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M20 4 8.1 15.9 M14.5 14.5 20 20 M8.1 8.1 12 12",
  };
  const METRICS = [
    ["views", "views"],
    ["likes", "likes"],
    ["reposts", "reposts"],
    ["rate", "engagement rate"],
  ];
  const CATEGORY_COLOURS = [
    "#00aff0",
    "#c58cff",
    "#ff8fb1",
    "#7bd88f",
    "#ffd166",
    "#5ec8c8",
    "#ff9f5a",
    "#9aa8ff",
  ];
  const COVERAGE_FILTERS = [
    ["needs", "Needs teasers"],
    ["ready", "Ready to post"],
    ["posted", "Posted"],
    ["all", "All"],
  ];
  const POSTER_PATTERN = /^https:\/\/pbs\.twimg\.com\//;
  const SCAN_FINISHED = [
    "complete",
    "window-reached",
    "no-new-posts",
    "page-cap",
  ];
  const SCAN_PROBLEMS = {
    "owner-unknown": "waiting for your own X posts",
    "owner-mismatch": "another X account is signed in",
    "signed-out": "signed out of X",
    "no-timeline": "profile did not load",
    timeout: "took too long",
    "user-took-over": "stopped, you opened the scan tab",
    error: "X error",
  };

  // Live background-scan panel: polled quickly while a scan runs, slowly
  // otherwise so a scan started by OFEnhancer itself shows up on its own.
  const LIVE_POLL_RUNNING_MS = 1_500;
  const LIVE_POLL_IDLE_MS = 10_000;
  // A running log that has not moved for this long means Chrome stopped
  // reporting; it is never shown as an active scan.
  const LIVE_STALE_MS = 90_000;
  const STATUS_ID = /^\d{1,25}$/;
  const LIVE_TRIGGERS = {
    startup: "Startup",
    routine: "Every 6 h",
    checkpoint: "Checkpoint",
    requested: "Scan now",
    manual: "Scan now",
  };
  const LIVE_COUNTS = [
    ["views", "Views"],
    ["likes", "Likes"],
    ["reposts", "Reposts"],
    ["replies", "Replies"],
    ["bookmarks", "Bookmarks"],
    ["quotes", "Quotes"],
  ];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, label, text) {
    const node = element("button", className, text);
    node.type = "button";
    if (label) node.setAttribute("aria-label", label);
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("xt-icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function localDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function addDays(value, days) {
    const date = parseDate(value);
    date.setDate(date.getDate() + days);
    return localDate(date);
  }

  function dayLabel(value) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
    }).format(parseDate(value));
  }

  function longDayLabel(value) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(parseDate(value));
  }

  function timeLabel(value) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function stampLabel(value) {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function exact(value) {
    return new Intl.NumberFormat(undefined).format(value);
  }

  function clockLabel(value) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  }

  function durationLabel(ms) {
    const seconds = Math.max(Math.round(ms / 1000), 0);
    return seconds < 60
      ? `${seconds} s`
      : `${Math.floor(seconds / 60)} m ${pad(seconds % 60)} s`;
  }

  function compact(value) {
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      // Three significant digits keep every cell at "999K"/"1.25M" width.
      maximumSignificantDigits: 3,
    }).format(value);
  }

  function engagementRate(metrics) {
    if (!metrics || !(metrics.views > 0)) return null;
    const parts = [
      metrics.likes,
      metrics.reposts,
      metrics.replies,
      metrics.bookmarks,
    ];
    if (parts.some((part) => typeof part !== "number")) return null;
    return parts.reduce((sum, part) => sum + part, 0) / metrics.views;
  }

  function metricValue(post, name) {
    if (!post.latest) return null;
    if (name === "rate") return engagementRate(post.latest);
    const value = post.latest[name];
    return typeof value === "number" ? value : null;
  }

  function usualValue(post, name) {
    const usual = post.usual;
    if (!usual) return null;
    const value = name === "rate" ? usual.engagementRate : usual[name];
    return typeof value === "number" ? value : null;
  }

  // Green at least 15% above the usual at the same age, red at least 20% below.
  function tone(value, usual) {
    if (value === null || usual === null || !(usual > 0)) return "neutral";
    if (value >= usual * ABOVE_USUAL) return "good";
    if (value <= usual * BELOW_USUAL) return "bad";
    return "neutral";
  }

  function formatMetric(name, value) {
    if (value === null) return "–";
    return name === "rate"
      ? `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`
      : compact(value);
  }

  function seasonKey(episode) {
    return `${episode.category || ""}\u0000${episode.series || episode.itemId}`;
  }

  function naturalCompare(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function orderEpisodes(episodes) {
    return [...episodes].sort(
      (left, right) =>
        Number(!left.category) - Number(!right.category) ||
        naturalCompare(left.category, right.category) ||
        naturalCompare(left.series, right.series) ||
        naturalCompare(left.episode, right.episode) ||
        naturalCompare(left.title, right.title),
    );
  }

  function create(root, options = {}) {
    const request =
      options.request ||
      ((operation, payload) =>
        global.OFEnhancerHost.request(operation, payload));
    const now = options.now || (() => new Date());
    const thumbnailUrl =
      options.thumbnailUrl ||
      ((assetId) =>
        `https://thumbs.ofenhancer.local/${encodeURIComponent(assetId)}`);
    const state = {
      phase: "loading",
      active: true,
      overview: null,
      slots: [],
      scanMessage: "",
      period: "30",
      worstFirst: false,
      coverage: "all",
      picking: null,
      detail: "",
      message: "",
      busy: false,
    };
    let generation = 0;
    let wallObserver = null;
    const live = {
      activity: null,
      timer: null,
      polling: false,
      wasRunning: false,
      selected: "",
      open: null,
      drawn: "",
      panel: element("section", "xt-live"),
    };
    live.panel.hidden = true;
    live.panel.setAttribute("aria-label", "Background scan");

    root.classList.add("xt");
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.picking) {
        state.picking = null;
        render("picking-start");
      }
    });

    function episodes() {
      return state.overview?.episodes || [];
    }

    function posts() {
      return state.overview?.posts || [];
    }

    function episodeByItem(itemId) {
      return episodes().find((episode) => episode.itemId === itemId);
    }

    function episodeByKey(key) {
      const wanted = String(key || "").toLowerCase();
      return episodes().find(
        (episode) => episode.sourceKey.toLowerCase() === wanted,
      );
    }

    function postLabel(post) {
      return episodeByItem(post.itemId)?.title || "Unpaired teaser";
    }

    function today() {
      return localDate(now());
    }

    function postsOn(date) {
      return posts().filter(
        (post) => localDate(new Date(post.postedUtc)) === date,
      );
    }

    function slotOn(date) {
      return state.slots.find((slot) => slot.date === date);
    }

    // The owner's X scheduled posts falling on a local calendar day.
    function scheduledOn(date) {
      return (state.overview?.scheduled || []).filter(
        (post) => localDate(new Date(post.scheduledUtc)) === date,
      );
    }

    function applyOverview(overview, fallback) {
      state.active = overview?.active !== false;
      state.overview = overview?.overview || fallback;
    }

    // Today joins the plan while nothing was posted today.
    function plannableDates() {
      const first = today();
      const dates = postsOn(first).length ? [] : [first];
      for (let offset = 1; offset <= PICK_WINDOW_DAYS; offset++)
        dates.push(addDays(first, offset));
      return dates;
    }

    function nextEmptyDate(after) {
      return plannableDates().find(
        (date) => (!after || date > after) && !slotOn(date),
      );
    }

    // Seasons posted in the last 7 days or planned for another day in the week
    // are nearly hidden; categories with two or more of those are dimmed.
    function pickContext(target) {
      const since = now().getTime() - PICK_WINDOW_DAYS * DAY_MS;
      const used = [];
      for (const post of posts()) {
        if (Date.parse(post.postedUtc) < since) continue;
        const episode = episodeByItem(post.itemId);
        if (episode) used.push(episode);
      }
      const upcoming = new Set(plannableDates());
      for (const slot of state.slots) {
        if (slot.date === target || !upcoming.has(slot.date)) continue;
        const episode = episodeByKey(slot.episodeKey);
        if (episode) used.push(episode);
      }
      const seasons = new Set(used.map(seasonKey));
      const categories = new Map();
      for (const episode of used) {
        const category = episode.category || "";
        categories.set(category, (categories.get(category) || 0) + 1);
      }
      return { seasons, categories };
    }

    function pickState(episode, context) {
      if (context.seasons.has(seasonKey(episode))) return "hidden";
      if ((context.categories.get(episode.category || "") || 0) >= 2)
        return "dimmed";
      if (episode.usedCount === 0 && episode.readyClips > 0)
        return "recommended";
      return "neutral";
    }

    function scheduleLive(ms) {
      clearTimeout(live.timer);
      live.timer = setTimeout(() => void pollLive(), ms);
    }

    function liveRunning(activity) {
      if (!activity?.running) return false;
      const updated = Date.parse(String(activity.updatedUtc || ""));
      return (
        Number.isFinite(updated) && now().getTime() - updated <= LIVE_STALE_MS
      );
    }

    async function pollLive() {
      live.timer = null;
      live.polling = true;
      let next = LIVE_POLL_IDLE_MS;
      try {
        const result = await request("getXScanActivity", {});
        const activity = result?.activity;
        live.activity =
          activity && typeof activity === "object" && activity.version === 1
            ? activity
            : null;
        const running = liveRunning(live.activity);
        const was = live.wasRunning;
        live.wasRunning = running;
        // A scan just finished: reload so every number on the page is the
        // freshly recorded one. A scan starting updates the scan line.
        if (was && !running) void load();
        else if (!was && running && state.phase === "ready") render();
        if (running) next = LIVE_POLL_RUNNING_MS;
      } catch {
        // An older desktop or a disconnected extension: keep the last view.
      } finally {
        live.polling = false;
      }
      renderLive();
      if (root.isConnected) scheduleLive(next);
    }

    async function load() {
      const current = ++generation;
      if (live.timer === null && !live.polling) scheduleLive(0);
      state.phase = state.overview ? state.phase : "loading";
      render();
      try {
        const [overview, plan] = await Promise.all([
          request("getTeaserOverview", {}),
          request("getTeaserPlan", {}),
        ]);
        if (current !== generation) return;
        applyOverview(overview, {
          episodes: [],
          posts: [],
          recentMoves: [],
        });
        state.slots = plan?.slots || [];
        state.phase = "ready";
      } catch (error) {
        if (current !== generation) return;
        state.phase = "error";
        state.message = `Teaser data could not load (${error?.message || "unknown"}).`;
      }
      render();
    }

    async function reloadPlan() {
      const plan = await request("getTeaserPlan", {});
      state.slots = plan?.slots || [];
    }

    async function plan(date, episode, clipId) {
      if (state.busy) return;
      state.busy = true;
      try {
        const payload = { date, episodeKey: episode.sourceKey };
        if (clipId) payload.clipId = clipId;
        await request("setTeaserPlanSlot", payload);
        await reloadPlan();
        state.message = `Planned ${episode.title} for ${longDayLabel(date)}.`;
        if (state.picking) {
          const next = nextEmptyDate(date);
          state.picking = next ? { date: next } : null;
        }
      } catch (error) {
        state.message = `Could not plan ${episode.title} (${error?.message || "unknown"}).`;
      } finally {
        state.busy = false;
      }
      render(state.picking ? "picking-start" : `day-${date}`);
    }

    async function clearDay(date) {
      if (state.busy) return;
      state.busy = true;
      try {
        await request("clearTeaserPlanSlot", { date });
        await reloadPlan();
        state.message = `Cleared ${longDayLabel(date)}.`;
      } catch (error) {
        state.message = `Could not clear the day (${error?.message || "unknown"}).`;
      } finally {
        state.busy = false;
      }
      render(`day-${date}`);
    }

    async function undo(move) {
      if (state.busy) return;
      state.busy = true;
      try {
        await request("undoTeaserClipMove", { moveId: move.moveId });
        state.message = "Clip moved back.";
        applyOverview(await request("getTeaserOverview", {}), state.overview);
      } catch (error) {
        state.message = `Undo was refused (${error?.message || "unknown"}).`;
      } finally {
        state.busy = false;
      }
      render("history-period");
    }

    async function scanNow() {
      if (state.busy) return;
      state.busy = true;
      try {
        const result = await request("requestXScan", {});
        state.scanMessage = result?.started
          ? "Scan started…"
          : result?.reason === "busy"
            ? "A scan is already running…"
            : result?.reason === "too-soon"
              ? "A scan just ran…"
              : "";
        if (result?.requestedUtc && state.overview)
          state.overview.scan = {
            ...(state.overview.scan || { last: null }),
            requestedUtc: result.requestedUtc,
          };
      } catch (error) {
        state.scanMessage = `Scan could not be requested (${error?.message || "unknown"}).`;
      } finally {
        state.busy = false;
      }
      render("scan-now");
      scheduleLive(300);
    }

    function livePhase(activity, running) {
      const next = activity.pages + 1;
      if (!running && activity.phase !== "done")
        return "Interrupted: Chrome stopped reporting";
      return (
        {
          starting: "Starting",
          opening: "Opening a background tab",
          loading: "Waiting for X to load your timeline",
          reading: `Reading page ${activity.pages}`,
          waiting: `Pausing before page ${next}`,
          paging: `Requesting page ${next}`,
          scheduled: "Reading scheduled posts",
          closing: "Closing the background tab",
          done: SCAN_FINISHED.includes(activity.outcome)
            ? "Finished"
            : `Stopped: ${SCAN_PROBLEMS[activity.outcome] || activity.outcome}`,
        }[activity.phase] || "Idle"
      );
    }

    function livePost(activity) {
      const posts = activity.posts || [];
      const chosen = posts.find((post) => post.statusId === live.selected);
      if (chosen) return chosen;
      for (let index = activity.events.length - 1; index >= 0; index -= 1)
        if (activity.events[index].post) return activity.events[index].post;
      return null;
    }

    function postKind(post) {
      if (post.kind === "repost") return "Repost";
      if (post.kind === "reply") return "Reply";
      if (post.mediaType === "video") return "Video post";
      return post.mediaType ? "Image post" : "Text post";
    }

    function renderNow(post) {
      const card = element("figure", "xt-live-now");
      if (!post) {
        card.append(
          element("span", "xt-live-poster xt-fallback"),
          element(
            "figcaption",
            "xt-live-caption",
            "Posts appear here as each page is read.",
          ),
        );
        return card;
      }
      card.append(poster(post, "xt-live-poster"));
      const caption = element("figcaption", "xt-live-caption");
      const head = element("p", "xt-live-kind");
      head.append(
        element("strong", "", postKind(post)),
        element("span", "", ` · posted ${stampLabel(post.postedUtc)}`),
      );
      caption.append(head);
      if (post.text) caption.append(element("p", "xt-live-excerpt", post.text));
      const counts = element("dl", "xt-live-counts");
      if (post.metrics)
        for (const [key, label] of LIVE_COUNTS) {
          if (post.metrics[key] === null || post.metrics[key] === undefined)
            continue;
          const cell = element("div", "xt-live-count");
          cell.append(
            element("dt", "", label),
            element("dd", "", exact(post.metrics[key])),
          );
          counts.append(cell);
        }
      if (counts.children.length) caption.append(counts);
      else
        caption.append(
          element("p", "xt-live-excerpt", "X sent no counters for this post."),
        );
      if (STATUS_ID.test(post.statusId)) {
        const link = element("a", "xt-live-link", "Open on X");
        link.href = `https://x.com/i/status/${post.statusId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        caption.append(link);
      }
      card.append(caption);
      return card;
    }

    function renderLiveStrip(activity, current) {
      const strip = element("div", "xt-live-strip");
      strip.setAttribute("aria-label", `Posts on page ${activity.pages}`);
      for (const post of activity.posts || []) {
        const thumb = button(
          "xt-live-thumb",
          `${postKind(post)} posted ${stampLabel(post.postedUtc)}`,
        );
        thumb.dataset.key = `live-${post.statusId}`;
        thumb.setAttribute(
          "aria-pressed",
          String(post.statusId === current?.statusId),
        );
        thumb.append(poster(post, "xt-live-thumb-image"));
        if (post.metrics?.views !== null && post.metrics?.views !== undefined)
          thumb.append(
            element("span", "xt-live-thumb-views", compact(post.metrics.views)),
          );
        thumb.addEventListener("click", () => {
          live.selected = post.statusId;
          renderLive(true);
          live.panel
            .querySelector(`[data-key="live-${CSS.escape(post.statusId)}"]`)
            ?.focus();
        });
        strip.append(thumb);
      }
      return strip;
    }

    function renderLiveLog(activity) {
      const log = element("ol", "xt-live-log");
      log.setAttribute("role", "log");
      log.setAttribute("aria-label", "Scan steps, newest first");
      for (const entry of [...activity.events].reverse()) {
        const line = element("li", "xt-live-line");
        line.dataset.kind = entry.kind;
        line.append(element("time", "xt-live-time", clockLabel(entry.at)));
        if (entry.post) line.append(poster(entry.post, "xt-live-mini"));
        line.append(element("span", "xt-live-text", entry.text));
        log.append(line);
      }
      return log;
    }

    // Redraws only the live panel, and only when the log moved.
    function renderLive(force = false) {
      const activity = live.activity;
      const panel = live.panel;
      if (!activity || !activity.startedUtc) {
        panel.hidden = true;
        panel.replaceChildren();
        live.drawn = "none";
        return;
      }
      const running = liveRunning(activity);
      const key = `${activity.runId}|${activity.updatedUtc}|${running}|${live.selected}|${live.open}`;
      if (!force && key === live.drawn) return;
      live.drawn = key;
      const previousLog = panel.querySelector(".xt-live-log");
      const scrollTop = previousLog?.scrollTop || 0;
      panel.hidden = false;
      panel.dataset.running = String(running);
      panel.dataset.tone =
        activity.phase === "done"
          ? SCAN_FINISHED.includes(activity.outcome)
            ? "good"
            : "warn"
          : !running
            ? "warn"
            : "live";
      const head = element("header", "xt-live-head");
      head.append(element("span", "xt-live-dot"));
      const title = element("div", "xt-live-title");
      title.append(
        element(
          "strong",
          "",
          running ? "Scanning your X profile" : "Last background scan",
        ),
      );
      const started = Date.parse(activity.startedUtc);
      const ended = running ? now().getTime() : Date.parse(activity.updatedUtc);
      const phaseLine = element(
        "span",
        "xt-live-phase",
        `${livePhase(activity, running)} · ${
          running
            ? `${durationLabel(ended - started)} so far`
            : `${stampLabel(started)}, took ${durationLabel(ended - started)}`
        }`,
      );
      phaseLine.setAttribute("role", "status");
      title.append(phaseLine);
      const stats = element("div", "xt-live-stats");
      stats.append(
        element(
          "span",
          "xt-live-chip",
          `${exact(activity.pages)} ${activity.pages === 1 ? "page" : "pages"}`,
        ),
        element(
          "span",
          "xt-live-chip",
          `${exact(activity.rows)} ${activity.rows === 1 ? "post" : "posts"}`,
        ),
      );
      if (LIVE_TRIGGERS[activity.trigger])
        stats.append(
          element("span", "xt-live-chip", LIVE_TRIGGERS[activity.trigger]),
        );
      const open = live.open ?? running;
      const toggle = button(
        "xt-live-toggle",
        "",
        open ? "Hide steps" : "Show steps",
      );
      toggle.dataset.key = "live-toggle";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.addEventListener("click", () => {
        live.open = !open;
        renderLive(true);
        live.panel.querySelector('[data-key="live-toggle"]')?.focus();
      });
      head.append(title, stats, toggle);
      const current = livePost(activity);
      const body = element("div", "xt-live-body");
      body.append(renderNow(current));
      if ((activity.posts || []).length)
        body.append(renderLiveStrip(activity, current));
      panel.replaceChildren(head, body);
      if (open) {
        const log = renderLiveLog(activity);
        panel.append(log);
        log.scrollTop = scrollTop;
      }
    }

    function renderScan() {
      const bar = element("div", "xt-scan");
      const scan = state.overview?.scan;
      const last = scan?.last;
      // One line: when, then the counts, or what stopped it.
      const parts = [];
      const finished = last && SCAN_FINISHED.includes(last.outcome);
      if (live.wasRunning) parts.push("Scan running now");
      if (last) {
        parts.push(
          `Last scan ${stampLabel(last.finishedUtc || last.startedUtc)}`,
        );
        if (finished) {
          parts.push(`${last.rows} posts`);
          if (typeof last.scheduled === "number")
            parts.push(`${last.scheduled} scheduled`);
        } else
          parts.push(
            `${SCAN_PROBLEMS[last.outcome] || last.outcome}${
              last.detail ? ` (${last.detail})` : ""
            }`,
          );
        const backoff = Date.parse(String(last.backoffUntilUtc || ""));
        if (Number.isFinite(backoff) && backoff > now().getTime())
          parts.push(`automatic scans paused until ${stampLabel(backoff)}`);
      } else if (!live.wasRunning) parts.push("No scan yet");
      const text = element("p", "xt-scan-text", parts.join(" · "));
      text.setAttribute("role", "status");
      if (last && !finished) text.dataset.tone = "warn";
      const pending = element(
        "span",
        "xt-scan-state",
        state.scanMessage || (scan?.requestedUtc ? "Scan requested…" : ""),
      );
      pending.setAttribute("role", "status");
      pending.hidden = !pending.textContent;
      const action = button("xt-action", "", "Scan now");
      action.dataset.key = "scan-now";
      action.addEventListener("click", () => void scanNow());
      bar.append(text, pending, action);
      const wrap = element("div", "xt-scan-wrap");
      wrap.append(bar, live.panel);
      return wrap;
    }

    function numbers(post) {
      const line = element("div", "xt-numbers");
      for (const [name, label] of METRICS) {
        const value = metricValue(post, name);
        const result = tone(value, usualValue(post, name));
        const cell = element("span", "xt-number", formatMetric(name, value));
        cell.dataset.metric = name;
        cell.dataset.tone = result;
        cell.setAttribute("role", "img");
        cell.setAttribute(
          "aria-label",
          value === null
            ? `${label} not collected`
            : `${formatMetric(name, value)} ${label}${
                result === "good"
                  ? ", above usual"
                  : result === "bad"
                    ? ", below usual"
                    : ""
              }`,
        );
        line.append(cell);
      }
      return line;
    }

    function poster(post, className) {
      if (post.posterUrl && POSTER_PATTERN.test(post.posterUrl)) {
        const image = element("img", className);
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.src = post.posterUrl;
        image.addEventListener("error", () =>
          image.replaceWith(element("span", `${className} xt-fallback`)),
        );
        return image;
      }
      return element("span", `${className} xt-fallback`);
    }

    function describePost(post) {
      const verdict = post.verdict
        ? ` · ${post.verdict.verdict === "good" ? "Good" : "Failed"}`
        : "";
      const metrics = METRICS.map(
        ([name, label]) =>
          `${formatMetric(name, metricValue(post, name))} ${label}`,
      ).join(" · ");
      return `${postLabel(post)} · posted ${longDayLabel(
        localDate(new Date(post.postedUtc)),
      )} · ${metrics}${verdict}`;
    }

    function pastDay(date) {
      const day = element("li", "xt-day");
      day.dataset.date = date;
      day.append(element("span", "xt-date", dayLabel(date)));
      const post = postsOn(date)[0];
      if (post) {
        const tile = button(
          "xt-tile",
          `${postLabel(post)}, posted ${longDayLabel(date)}`,
        );
        tile.dataset.kind = "posted";
        tile.dataset.key = `post-${post.statusId}`;
        tile.dataset.statusId = post.statusId;
        tile.append(poster(post, "xt-poster"));
        if (post.verdict) tile.append(verdictBadge(post.verdict.verdict));
        tile.addEventListener("click", () => {
          state.detail = describePost(post);
          render(tile.dataset.key);
        });
        day.append(tile, numbers(post));
      } else if (plannableDates().includes(date)) {
        day.append(planTile(date));
        day.append(element("div", "xt-numbers xt-numbers-empty"));
      } else {
        const tile = element("span", "xt-tile");
        tile.dataset.kind = "none";
        tile.setAttribute("aria-label", `${longDayLabel(date)}: no teaser`);
        tile.setAttribute("role", "img");
        day.append(tile, element("div", "xt-numbers xt-numbers-empty"));
      }
      return day;
    }

    function planTile(date) {
      const slot = slotOn(date);
      const scheduled = scheduledOn(date);
      const episode = slot ? episodeByKey(slot.episodeKey) : null;
      // A post already scheduled on X outlines the day; the plan's episode
      // title, else the post's own text, labels it.
      const title =
        episode?.title ||
        slot?.episodeKey ||
        scheduled[0]?.text ||
        (scheduled.length ? "Scheduled post" : "");
      const kind = scheduled.length ? "scheduled" : slot ? "planned" : "empty";
      const times = scheduled
        .map((post) => timeLabel(post.scheduledUtc))
        .join(", ");
      const reEdit = slot?.reEdit ? " (re-edit)" : "";
      const tile = button(
        "xt-tile",
        scheduled.length
          ? `${longDayLabel(date)}: scheduled on X at ${times}, ${title}${reEdit}. Pick another episode`
          : slot
            ? `${longDayLabel(date)}: ${kind} ${title}${reEdit}. Pick another episode`
            : `${longDayLabel(date)}: nothing planned. Pick an episode`,
      );
      tile.dataset.kind = kind;
      tile.dataset.key = `day-${date}`;
      tile.dataset.date = date;
      if (state.picking?.date === date) tile.dataset.target = "true";
      if (scheduled.length)
        tile.append(
          element("span", "xt-tile-time", timeLabel(scheduled[0].scheduledUtc)),
        );
      if (slot || scheduled.length) {
        tile.append(element("span", "xt-tile-label", title));
        if (slot?.reEdit) {
          const mark = element("span", "xt-scissors");
          mark.append(icon("scissors"));
          tile.dataset.reEdit = "true";
          tile.append(mark);
        }
      } else tile.append(element("span", "xt-plus", "+"));
      tile.addEventListener("click", () => {
        state.picking = { date };
        state.detail = "";
        render("picking-start");
      });
      return tile;
    }

    function nextDay(date) {
      const day = element("li", "xt-day");
      day.dataset.date = date;
      day.append(element("span", "xt-date", dayLabel(date)), planTile(date));
      return day;
    }

    function verdictBadge(verdict) {
      const badge = element(
        "span",
        "xt-verdict",
        verdict === "good" ? "Good" : "Failed",
      );
      badge.dataset.verdict = verdict;
      return badge;
    }

    function shortDayLabel(value) {
      return new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
      }).format(parseDate(value));
    }

    function average(list, name) {
      const values = list
        .map((post) => metricValue(post, name))
        .filter((value) => value !== null);
      return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
    }

    // Each post's number set against what teasers usually had at the same
    // age, so a young teaser is not judged against fully grown ones.
    function averageAgainstUsual(list, name) {
      let value = 0;
      let usual = 0;
      let count = 0;
      for (const post of list) {
        const own = metricValue(post, name);
        const typical = usualValue(post, name);
        if (own === null || typical === null) continue;
        value += own;
        usual += typical;
        count++;
      }
      return count ? { value: value / count, usual: usual / count } : null;
    }

    function postsBetween(fromMs, toMs) {
      return posts().filter((post) => {
        const at = Date.parse(post.postedUtc);
        return at > fromMs && at <= toMs;
      });
    }

    // Same colours as the tiles: green 15% above the usual, red 20% below.
    function trendBadge(pair, name, label) {
      const badge = element("span", "xt-trend");
      if (!pair || !(pair.usual > 0)) {
        badge.dataset.tone = "none";
        return badge;
      }
      const result = tone(pair.value, pair.usual);
      badge.dataset.tone = result;
      // Views change in percent; engagement in percentage points.
      const change =
        name === "rate"
          ? (pair.value - pair.usual) * 100
          : (pair.value / pair.usual - 1) * 100;
      const sign = change >= 0 ? "+" : "\u2212";
      badge.textContent =
        name === "rate"
          ? `${sign}${Math.abs(change).toFixed(1)} pts`
          : `${sign}${Math.abs(Math.round(change))}%`;
      badge.title = `Usual ${label} at the same age: ${formatMetric(
        name,
        pair.usual,
      )}`;
      return badge;
    }

    function trendMetric(list, name, label, compare) {
      const block = element("div", "xt-trend-metric");
      const value = average(list, name);
      const line = element("div", "xt-trend-line");
      line.append(element("span", "xt-trend-value", formatMetric(name, value)));
      const pair = compare ? averageAgainstUsual(list, name) : null;
      if (compare) line.append(trendBadge(pair, name, label));
      const caption = element("div", "xt-trend-unit");
      caption.append(element("span", "", label));
      if (pair && pair.usual > 0)
        caption.append(
          element(
            "span",
            "xt-trend-usual",
            `usual ${formatMetric(name, pair.usual)}`,
          ),
        );
      block.append(line, caption);
      return block;
    }

    // Your average teaser first, then recent periods, each compared with
    // what teasers usually had at the same age.
    function renderTrends() {
      const row = element("ul", "xt-trends");
      row.setAttribute("aria-label", "Average numbers per teaser");
      const at = now().getTime();
      const periods = [[null, "Overall"], ...TREND_PERIODS];
      for (const [days, label] of periods) {
        const list =
          days === null ? posts() : postsBetween(at - days * DAY_MS, at);
        const card = element("li", "xt-trend-card");
        if (days === null) card.dataset.baseline = "true";
        const head = element("div", "xt-trend-head");
        head.append(
          element("span", "xt-trend-label", label),
          element(
            "span",
            "xt-trend-count",
            `${list.length} ${list.length === 1 ? "teaser" : "teasers"}`,
          ),
        );
        card.append(
          head,
          trendMetric(list, "views", "views", days !== null),
          trendMetric(list, "rate", "engagement", days !== null),
        );
        row.append(card);
      }
      return row;
    }

    function historyTile(date) {
      const list = postsOn(date);
      const post = list[0];
      if (!post) {
        const empty = element("span", "xt-past-tile");
        empty.dataset.kind = "none";
        empty.setAttribute("role", "img");
        empty.setAttribute("aria-label", `${longDayLabel(date)}: no teaser`);
        empty.title = longDayLabel(date);
        return empty;
      }
      const tile = button(
        "xt-past-tile",
        `${postLabel(post)}, posted ${longDayLabel(date)}`,
      );
      tile.title = list.map(describePost).join("\n");
      tile.dataset.key = `past-${post.statusId}`;
      if (post.verdict) tile.dataset.verdict = post.verdict.verdict;
      tile.append(poster(post, "xt-past-poster"));
      if (list.length > 1)
        tile.append(element("span", "xt-past-more", `+${list.length - 1}`));
      const views = metricValue(post, "views");
      const rate = metricValue(post, "rate");
      const viewCell = element(
        "span",
        "xt-past-views",
        formatMetric("views", views),
      );
      viewCell.dataset.tone = tone(views, usualValue(post, "views"));
      const rateCell = element(
        "span",
        "xt-past-rate",
        formatMetric("rate", rate),
      );
      rateCell.dataset.tone = tone(rate, usualValue(post, "rate"));
      tile.append(viewCell, rateCell);
      tile.addEventListener("click", () => {
        state.detail = list.map(describePost).join(" | ");
        render(tile.dataset.key);
      });
      return tile;
    }

    // Every day before the 7-day row, empty days included, in rows of two
    // weeks whose weekdays line up with the 7-day row; newest row at the
    // bottom, older rows scroll up.
    function renderHistoryStrip() {
      const end = addDays(today(), -7);
      const earlier = posts().filter(
        (post) => localDate(new Date(post.postedUtc)) <= end,
      );
      const section = element("div", "xt-past");
      const head = element("div", "xt-past-head");
      head.append(
        element("span", "xt-past-title", "History"),
        element(
          "span",
          "xt-past-range",
          "Average per teaser; usual is what teasers had at the same age.",
        ),
      );
      section.append(head, renderTrends());
      if (!earlier.length) return section;
      const first = earlier.reduce((oldest, post) => {
        const date = localDate(new Date(post.postedUtc));
        return date < oldest ? date : oldest;
      }, end);
      const total =
        Math.round((parseDate(end) - parseDate(first)) / DAY_MS) + 1;
      const rows = Math.min(
        HISTORY_MAX_ROWS,
        Math.ceil(total / HISTORY_ROW_DAYS),
      );
      const start = addDays(end, -(rows * HISTORY_ROW_DAYS - 1));
      head.append(
        element(
          "span",
          "xt-past-range",
          `${earlier.length} earlier ${
            earlier.length === 1 ? "teaser" : "teasers"
          } since ${longDayLabel(first)}`,
        ),
      );
      const scroller = element("div", "xt-past-scroll");
      const grid = element("ol", "xt-past-list");
      grid.setAttribute("aria-label", "Earlier days");
      let column = 0;
      for (let date = start; date <= end; date = addDays(date, 1)) {
        const item = element("li", "xt-past-day");
        // The day sits above the picture; the month starts each row and
        // marks the 1st.
        const rowStart = column++ % HISTORY_ROW_DAYS === 0;
        const caption = element(
          "span",
          "xt-past-date",
          rowStart || date.endsWith("-01")
            ? shortDayLabel(date)
            : String(parseDate(date).getDate()),
        );
        caption.setAttribute("aria-hidden", "true");
        if (date.endsWith("-01")) caption.dataset.month = "true";
        item.append(caption, historyTile(date));
        grid.append(item);
      }
      scroller.append(grid);
      section.append(scroller);
      return section;
    }

    function renderStrip() {
      const strip = element("div", "xt-strip");
      const first = today();
      const past = element("ol", "xt-row");
      past.dataset.row = "past";
      past.setAttribute("aria-label", "Last 7 days");
      for (let offset = -6; offset <= 0; offset++)
        past.append(pastDay(addDays(first, offset)));
      const next = element("ol", "xt-row");
      next.dataset.row = "next";
      next.setAttribute("aria-label", "Next 7 days");
      for (let offset = 1; offset <= PICK_WINDOW_DAYS; offset++)
        next.append(nextDay(addDays(first, offset)));
      strip.append(renderHistoryStrip());
      strip.append(past, next);
      return strip;
    }

    function renderPicking() {
      const bar = element("div", "xt-picking");
      bar.setAttribute("role", "status");
      if (!state.picking) {
        bar.hidden = true;
        return bar;
      }
      const date = state.picking.date;
      const text = element(
        "span",
        "xt-picking-text",
        `Picking for ${longDayLabel(date)}`,
      );
      text.tabIndex = -1;
      text.dataset.key = "picking-start";
      bar.append(text);
      if (slotOn(date)) {
        const clear = button("xt-action", "", "Clear day");
        clear.dataset.key = "picking-clear";
        clear.addEventListener("click", () => clearDay(date));
        bar.append(clear);
      }
      const done = button("xt-action", "", "Done");
      done.dataset.key = "picking-done";
      done.addEventListener("click", () => {
        state.picking = null;
        render(`day-${date}`);
      });
      bar.append(done);
      return bar;
    }

    function describeEpisode(episode) {
      const parts = [
        episode.category || "Uncategorised",
        episode.series || episode.title,
      ];
      if (episode.episode) parts.push(`E${episode.episode}`);
      parts.push(`${episode.usedCount} used`, `${episode.readyClips} ready`);
      if (episode.goodClips) parts.push(`${episode.goodClips} good`);
      if (episode.failedCount || episode.failedClips)
        parts.push(
          `${Math.max(episode.failedCount, episode.failedClips)} failed`,
        );
      return parts.join(" · ");
    }

    // Catalogue gallery: every video with its thumbnail and a plain teaser
    // status, grouped by category and season, filterable by what needs work.
    function coverOf(episode) {
      if (episode.usedCount > 0) return "used";
      if (episode.readyClips > 0) return "ready";
      return "empty";
    }

    function matchesCoverage(episode, filter) {
      if (filter === "needs")
        return episode.usedCount === 0 && episode.readyClips === 0;
      if (filter === "ready") return episode.readyClips > 0;
      if (filter === "posted") return episode.usedCount > 0;
      return true;
    }

    function bestRate(episode) {
      let best = null;
      for (const post of posts()) {
        if (post.itemId !== episode.itemId) continue;
        const rate = metricValue(post, "rate");
        if (rate !== null && (best === null || rate > best)) best = rate;
      }
      return best;
    }

    function thumbnail(episode) {
      const frame = element("span", "xt-thumb");
      if (episode.thumbnailAssetId) {
        const image = element("img", "xt-thumb-image");
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.src = thumbnailUrl(episode.thumbnailAssetId);
        image.addEventListener("error", () => image.remove());
        frame.append(image);
      }
      return frame;
    }

    // Posted, ready and failed counts as small badges on the thumbnail.
    function badges(episode) {
      const row = element("span", "xt-badges");
      const badge = (tone, text) => {
        const node = element("span", "xt-badge", text);
        node.dataset.tone = tone;
        row.append(node);
      };
      if (episode.usedCount > 0) badge("posted", `✓${episode.usedCount}`);
      if (episode.readyClips > 0) badge("ready", String(episode.readyClips));
      const failed = Math.max(episode.failedCount, episode.failedClips);
      if (failed > 0) badge("failed", `✕${failed}`);
      return row;
    }

    function cardTooltip(episode) {
      const parts = [episode.title];
      if (episode.series)
        parts.unshift(
          episode.episode
            ? `${episode.series} E${episode.episode}`
            : episode.series,
        );
      const named = parts.length;
      if (episode.usedCount > 0) parts.push(`${episode.usedCount} posted`);
      if (episode.readyClips > 0) parts.push(`${episode.readyClips} ready`);
      const failed = Math.max(episode.failedCount, episode.failedClips);
      if (failed > 0) parts.push(`${failed} failed`);
      if (parts.length === named) parts.push("no teasers");
      const best = bestRate(episode);
      if (best !== null) parts.push(`best ${formatMetric("rate", best)}`);
      return parts.join(" · ");
    }

    function renderCoverageBar(all) {
      const bar = element("div", "xt-flow-bar");
      bar.append(element("h2", "xt-flow-title", "Catalogue"));
      const filters = element("div", "xt-segments");
      filters.setAttribute("role", "group");
      filters.setAttribute("aria-label", "Show videos");
      for (const [value, label] of COVERAGE_FILTERS) {
        const count = all.filter((episode) =>
          matchesCoverage(episode, value),
        ).length;
        const choice = button("xt-segment", "", `${label} `);
        choice.append(element("span", "xt-segment-count", String(count)));
        choice.dataset.coverage = value;
        choice.dataset.key = `coverage-${value}`;
        choice.setAttribute("aria-pressed", String(value === state.coverage));
        choice.addEventListener("click", () => {
          state.coverage = value;
          render(choice.dataset.key);
        });
        filters.append(choice);
      }
      bar.append(filters);
      return bar;
    }

    function episodeCard(episode, context) {
      const item = element("li", "xt-card");
      const card = button("xt-episode", describeEpisode(episode));
      card.dataset.key = `episode-${episode.itemId}`;
      card.dataset.itemId = episode.itemId;
      card.dataset.cover = coverOf(episode);
      card.title = cardTooltip(episode);
      const frame = thumbnail(episode);
      frame.append(badges(episode));
      card.append(frame);
      if (context) {
        const pick = pickState(episode, context);
        card.dataset.pick = pick;
        if (pick === "hidden") {
          card.setAttribute("aria-disabled", "true");
          card.tabIndex = -1;
        }
      }
      card.addEventListener("click", () => {
        if (state.picking) {
          if (card.dataset.pick === "hidden") return;
          void plan(state.picking.date, episode);
          return;
        }
        state.detail = describeEpisode(episode);
        render(card.dataset.key);
      });
      item.append(card);
      return item;
    }

    function renderFlow() {
      const flow = element("div", "xt-flow");
      flow.setAttribute("aria-label", "Catalogue coverage");
      if (state.picking) flow.dataset.picking = "true";
      const ordered = orderEpisodes(episodes());
      if (!ordered.length) {
        flow.append(
          element(
            "p",
            "xt-empty",
            "No catalogue episodes yet. Import the catalogue first.",
          ),
        );
        return flow;
      }
      flow.append(renderCoverageBar(ordered));
      const context = state.picking ? pickContext(state.picking.date) : null;
      // Seasons pack side by side, each under one small label tinted with
      // its category colour.
      const colours = new Map();
      const seasons = [];
      for (const episode of ordered) {
        const category = episode.category || "Uncategorised";
        if (!colours.has(category))
          colours.set(
            category,
            CATEGORY_COLOURS[colours.size % CATEGORY_COLOURS.length],
          );
        if (!matchesCoverage(episode, state.coverage)) continue;
        const last = seasons[seasons.length - 1];
        if (last && seasonKey(last[0]) === seasonKey(episode))
          last.push(episode);
        else seasons.push([episode]);
      }
      // One aligned grid of tiles: a season's title sits on the line over its
      // first tile, never wider than the season; every tile carries a line in
      // its category colour.
      const wall = element("ul", "xt-cards");
      for (const season of seasons) {
        const first = season[0];
        const category = first.category || "Uncategorised";
        season.forEach((episode, position) => {
          const card = episodeCard(episode, context);
          card.dataset.category = category;
          card.dataset.season = seasonKey(first);
          if (position === season.length - 1) card.dataset.seasonEnd = "true";
          card.style.setProperty("--xt-category", colours.get(category));
          if (position === 0) {
            const label = element(
              "span",
              "xt-season-name",
              first.series || category,
            );
            label.title = first.series
              ? `${category} · ${first.series}`
              : category;
            label.style.setProperty("--xt-span", String(season.length));
            card.dataset.seasonStart = "true";
            card.prepend(label);
          }
          wall.append(card);
        });
      }
      flow.append(
        wall.children.length
          ? wall
          : element("p", "xt-empty", "No videos match this filter."),
      );
      wallObserver?.disconnect();
      wallObserver = null;
      if (wall.children.length && global.ResizeObserver) {
        wallObserver = new ResizeObserver(() => joinSeasonLines(wall));
        wallObserver.observe(wall);
      }
      return flow;
    }

    // A season's line bridges the gap to its next tile unless the row ends
    // there; the grid has fixed 96px columns with 6px gaps.
    function joinSeasonLines(wall) {
      const columns = Math.max(1, Math.floor((wall.clientWidth + 6) / 102));
      const cards = Array.from(wall.children);
      cards.forEach((card, index) => {
        const next = cards[index + 1];
        card.dataset.join = String(
          Boolean(next) &&
            next.dataset.season === card.dataset.season &&
            (index + 1) % columns !== 0,
        );
      });
    }

    function performance(post) {
      const value = metricValue(post, "rate");
      const usual = usualValue(post, "rate");
      return value === null || usual === null || !(usual > 0)
        ? null
        : value / usual;
    }

    function historyPosts() {
      const since =
        state.period === "all"
          ? -Infinity
          : now().getTime() - Number(state.period) * DAY_MS;
      const list = posts().filter(
        (post) => Date.parse(post.postedUtc) >= since,
      );
      if (!state.worstFirst) return list;
      return [...list].sort((left, right) => {
        const a = performance(left);
        const b = performance(right);
        if (a === null) return b === null ? 0 : 1;
        if (b === null) return -1;
        return a - b;
      });
    }

    function renderHistory() {
      const history = element("div", "xt-history");
      const bar = element("div", "xt-history-bar");
      const periods = element("div", "xt-segments");
      periods.setAttribute("role", "group");
      periods.setAttribute("aria-label", "History period");
      for (const [value, label] of HISTORY_PERIODS) {
        const choice = button("xt-segment", "", label);
        choice.dataset.period = value;
        choice.dataset.key = value === state.period ? "history-period" : "";
        choice.setAttribute("aria-pressed", String(value === state.period));
        choice.addEventListener("click", () => {
          state.period = value;
          render("history-period");
        });
        periods.append(choice);
      }
      const worst = button("xt-segment", "", "Worst first");
      worst.dataset.key = "history-worst";
      worst.setAttribute("aria-pressed", String(state.worstFirst));
      worst.addEventListener("click", () => {
        state.worstFirst = !state.worstFirst;
        render("history-worst");
      });
      bar.append(periods, worst);

      const list = element("ol", "xt-history-list");
      list.setAttribute("aria-label", "Past teasers");
      for (const post of historyPosts()) {
        const item = element("li", "xt-history-item");
        item.dataset.statusId = post.statusId;
        if (post.verdict) item.dataset.verdict = post.verdict.verdict;
        const tile = button(
          "xt-history-tile",
          `${postLabel(post)}, posted ${longDayLabel(
            localDate(new Date(post.postedUtc)),
          )}`,
        );
        tile.dataset.key = `history-${post.statusId}`;
        tile.append(poster(post, "xt-poster"));
        if (post.verdict) tile.append(verdictBadge(post.verdict.verdict));
        tile.addEventListener("click", () => {
          state.detail = describePost(post);
          render(tile.dataset.key);
        });
        item.append(tile, numbers(post));
        const episode = episodeByItem(post.itemId);
        if (post.verdict?.verdict === "failed" && post.clipId && episode) {
          const remake = button(
            "xt-remake",
            `Plan a re-edit of ${episode.title} on the next free day`,
          );
          remake.dataset.key = `remake-${post.statusId}`;
          remake.append(
            icon("scissors"),
            element("span", "xt-remake-label", "Remake"),
          );
          remake.addEventListener("click", () => {
            const date = nextEmptyDate();
            if (!date) {
              state.message = "The next 7 days are already planned.";
              render(remake.dataset.key);
              return;
            }
            void plan(date, episode, post.clipId);
          });
          item.append(remake);
        }
        list.append(item);
      }
      if (!list.children.length)
        list.append(
          element("li", "xt-empty", "No teasers posted in this period."),
        );

      const moves = element("ul", "xt-moves");
      moves.setAttribute("aria-label", "Recent verdict moves");
      for (const move of (state.overview?.recentMoves || [])
        .filter(
          (entry) =>
            entry.outcome === "moved" &&
            String(entry.reason).startsWith("verdict-") &&
            !entry.undoneUtc,
        )
        .slice(0, 5)) {
        const line = element("li", "xt-move");
        const name = move.fromRelPath.split("\\").pop();
        line.append(
          element(
            "span",
            "xt-move-text",
            `${name} → ${move.reason === "verdict-good" ? "Good" : "Failed"}`,
          ),
        );
        const back = button("xt-action", `Undo move of ${name}`, "Undo");
        back.dataset.key = `undo-${move.moveId}`;
        back.dataset.moveId = String(move.moveId);
        back.addEventListener("click", () => undo(move));
        line.append(back);
        moves.append(line);
      }
      history.append(bar, list);
      if (moves.children.length) history.append(moves);
      return history;
    }

    function render(focusKey) {
      const activeKey =
        focusKey ||
        (root.contains(document.activeElement)
          ? document.activeElement?.dataset?.key
          : "");
      root.replaceChildren();
      root.dataset.state = state.phase;
      const status = element("p", "xt-status", "");
      status.setAttribute("role", "status");
      if (state.phase === "loading") status.textContent = "Loading teasers…";
      else if (state.phase === "error") status.textContent = state.message;
      else {
        const notes = [];
        if (!state.active)
          notes.push(
            "Set the teaser folder in desktop settings to count local clips.",
          );
        if (state.overview?.truncated) notes.push("Showing the newest items.");
        if (state.message) notes.push(state.message);
        status.textContent = notes.join(" ");
      }
      root.append(status);
      if (state.phase === "error") {
        const retry = button("xt-action", "", "Try again");
        retry.dataset.key = "retry";
        retry.addEventListener("click", () => void load());
        root.append(retry);
        return;
      }
      if (state.phase === "loading") return;
      const detail = element("p", "xt-detail", state.detail);
      detail.setAttribute("role", "status");
      root.append(
        renderScan(),
        renderStrip(),
        renderPicking(),
        renderFlow(),
        detail,
        renderHistory(),
      );
      if (activeKey) {
        const target = root.querySelector(
          `[data-key="${CSS.escape(activeKey)}"]`,
        );
        target?.focus?.({ preventScroll: focusKey !== "picking-start" });
      }
    }

    return { load, state };
  }

  const mounted = new WeakMap();

  function mount(root, options) {
    if (!root) return null;
    let dashboard = mounted.get(root);
    if (!dashboard) {
      dashboard = create(root, options);
      mounted.set(root, dashboard);
    }
    void dashboard.load();
    return dashboard;
  }

  global.OFEnhancerTeaserDashboard = Object.freeze({ mount });

  function autostart() {
    for (const root of document.querySelectorAll(
      '[data-teaser-dashboard="auto"]',
    ))
      mount(root);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", autostart, { once: true });
  else autostart();
})(globalThis);
