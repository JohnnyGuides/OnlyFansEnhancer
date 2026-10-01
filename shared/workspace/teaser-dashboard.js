(function attachTeaserDashboard(global) {
  "use strict";

  // One-page X teaser dashboard shared by the desktop workspace's Twitter view
  // and the extension's teaser-dashboard page. It reads the desktop teaser
  // overview and the owner-local plan; it never posts or schedules on X.
  const DAY_MS = 86400000;
  const ABOVE_USUAL = 1.15;
  const BELOW_USUAL = 0.8;
  const PICK_WINDOW_DAYS = 7;
  const HISTORY_PERIODS = [
    ["30", "30 days"],
    ["90", "90 days"],
    ["all", "All"],
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
  const ICONS = {
    views:
      "M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    likes:
      "M12 20s-7.5-4.6-9.3-9.2A5 5 0 0 1 12 6.6a5 5 0 0 1 9.3 4.2C19.5 15.4 12 20 12 20Z",
    reposts:
      "M17 3l3.5 3.5L17 10 M3.5 11V9.5a3 3 0 0 1 3-3h14 M7 21l-3.5-3.5L7 14 M20.5 13v1.5a3 3 0 0 1-3 3h-14",
    rate: "M19 5 5 19 M7 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M17 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    scissors:
      "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M20 4 8.1 15.9 M14.5 14.5 20 20 M8.1 8.1 12 12",
  };
  const METRICS = [
    ["views", "views"],
    ["likes", "likes"],
    ["reposts", "reposts"],
    ["rate", "engagement rate"],
  ];
  const POSTER_PATTERN = /^https:\/\/pbs\.twimg\.com\//;

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

  function compact(value) {
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
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
    const state = {
      phase: "loading",
      active: true,
      overview: null,
      slots: [],
      period: "30",
      worstFirst: false,
      picking: null,
      detail: "",
      message: "",
      busy: false,
    };
    let generation = 0;

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

    async function load() {
      const current = ++generation;
      state.phase = state.overview ? state.phase : "loading";
      render();
      try {
        const [overview, plan] = await Promise.all([
          request("getTeaserOverview", {}),
          request("getTeaserPlan", {}),
        ]);
        if (current !== generation) return;
        state.active = overview?.active !== false;
        state.overview = overview?.overview || {
          episodes: [],
          posts: [],
          recentMoves: [],
        };
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
        const overview = await request("getTeaserOverview", {});
        state.active = overview?.active !== false;
        state.overview = overview?.overview || state.overview;
      } catch (error) {
        state.message = `Undo was refused (${error?.message || "unknown"}).`;
      } finally {
        state.busy = false;
      }
      render("history-period");
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
      const episode = slot ? episodeByKey(slot.episodeKey) : null;
      const title = episode?.title || slot?.episodeKey || "";
      const kind = slot ? (slot.scheduled ? "scheduled" : "planned") : "empty";
      const tile = button(
        "xt-tile",
        slot
          ? `${longDayLabel(date)}: ${kind} ${title}${
              slot.reEdit ? " (re-edit)" : ""
            }. Pick another episode`
          : `${longDayLabel(date)}: nothing planned. Pick an episode`,
      );
      tile.dataset.kind = kind;
      tile.dataset.key = `day-${date}`;
      tile.dataset.date = date;
      if (state.picking?.date === date) tile.dataset.target = "true";
      if (slot) {
        tile.append(element("span", "xt-tile-label", title));
        if (slot.reEdit) {
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

    function renderStrip() {
      const strip = element("div", "xt-strip");
      const key = element("div", "xt-key");
      key.setAttribute("role", "note");
      key.setAttribute(
        "aria-label",
        "Numbers under each teaser: views, likes, reposts, engagement rate",
      );
      for (const [name, label] of METRICS) {
        const item = element("span", "xt-key-item");
        item.append(icon(name), element("span", "xt-key-text", label));
        key.append(item);
      }
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
      strip.append(key, past, next);
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

    function renderFlow() {
      const flow = element("div", "xt-flow");
      flow.setAttribute("role", "list");
      flow.setAttribute("aria-label", "Catalogue coverage");
      if (state.picking) flow.dataset.picking = "true";
      const ordered = orderEpisodes(episodes());
      const context = state.picking ? pickContext(state.picking.date) : null;
      const colours = new Map();
      ordered.forEach((episode, index) => {
        const category = episode.category || "Uncategorised";
        if (!colours.has(category))
          colours.set(
            category,
            CATEGORY_COLOURS[colours.size % CATEGORY_COLOURS.length],
          );
        const previous = ordered[index - 1];
        const following = ordered[index + 1];
        const cell = element("div", "xt-cell");
        cell.setAttribute("role", "listitem");
        cell.dataset.category = category;
        cell.style.setProperty("--xt-category", colours.get(category));
        if (!previous || (previous.category || "Uncategorised") !== category) {
          cell.dataset.categoryStart = "true";
          cell.append(element("span", "xt-category-name", category));
        }
        if (!following || seasonKey(following) !== seasonKey(episode))
          cell.dataset.seasonEnd = "true";
        const cover =
          episode.usedCount > 0
            ? "used"
            : episode.readyClips > 0
              ? "ready"
              : "empty";
        const square = button("xt-episode", describeEpisode(episode));
        square.dataset.key = `episode-${episode.itemId}`;
        square.dataset.itemId = episode.itemId;
        square.dataset.cover = cover;
        if (cover === "used")
          square.append(element("span", "xt-used", String(episode.usedCount)));
        if (episode.readyClips > 0)
          square.append(
            element("span", "xt-ready", String(episode.readyClips)),
          );
        if (context) {
          const pick = pickState(episode, context);
          square.dataset.pick = pick;
          if (pick === "hidden") {
            square.setAttribute("aria-disabled", "true");
            square.tabIndex = -1;
          }
        }
        square.addEventListener("click", () => {
          if (state.picking) {
            if (square.dataset.pick === "hidden") return;
            void plan(state.picking.date, episode);
            return;
          }
          state.detail = describeEpisode(episode);
          render(square.dataset.key);
        });
        cell.append(square);
        flow.append(cell);
      });
      if (!ordered.length)
        flow.append(
          element(
            "p",
            "xt-empty",
            "No catalogue episodes yet. Import the catalogue first.",
          ),
        );
      return flow;
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
          remake.append(icon("scissors"), element("span", "", "Remake"));
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
