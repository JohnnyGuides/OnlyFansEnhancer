(() => {
  "use strict";

  if (globalThis.CreatorSubredditPresets) return;

  const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{2,21}$/;
  const STATUSES = new Set(["Approved", "Needs review", "Rejected"]);

  function clean(value, maximum = 5000) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maximum);
  }

  function revision(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function normalizeSnapshot(rows) {
    const presets = [];
    const names = new Set();
    for (const row of Array.isArray(rows) ? rows.slice(0, 500) : []) {
      const subreddit = clean(row?.subreddit, 23).replace(/^r\//i, "");
      if (!subreddit && !clean(row?.status) && !clean(row?.notes)) continue;
      if (!SUBREDDIT_PATTERN.test(subreddit)) {
        throw new Error("Invalid subreddit preset row.");
      }
      const key = subreddit.toLowerCase();
      if (names.has(key)) throw new Error("Duplicate subreddit preset.");
      names.add(key);
      const rawStatus = clean(row?.status, 30);
      const status = STATUSES.has(rawStatus) ? rawStatus : "Needs review";
      const notes = clean(row?.notes, 5000);
      presets.push({
        id: key,
        subreddit,
        status,
        notes,
        revision: revision([key, status, notes].join("\u001f")),
      });
    }
    return Object.freeze({
      status: "snapshot",
      presets: Object.freeze(presets.map(Object.freeze)),
    });
  }

  function forMode(snapshot, mode) {
    const allowed =
      mode === "autonomous"
        ? new Set(["Approved"])
        : new Set(["Approved", "Needs review"]);
    return Object.freeze(
      (Array.isArray(snapshot?.presets) ? snapshot.presets : []).filter(
        (preset) => allowed.has(preset.status),
      ),
    );
  }

  globalThis.CreatorSubredditPresets = Object.freeze({
    forMode,
    normalizeSnapshot,
  });
})();
