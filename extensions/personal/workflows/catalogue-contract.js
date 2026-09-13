(() => {
  "use strict";

  if (globalThis.CreatorCatalogueContract) return;

  const PLATFORM_FIELDS = Object.freeze({
    pornhub: "pornhubLink",
    onlyfans: "onlyfansLink",
    fansly: "fanslyLink",
    manyvids: "manyvidsLink",
  });

  function clean(value) {
    return String(value || "").trim();
  }

  function normalizedText(value) {
    return clean(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\.(?:mp4|m4v|mov|webm|avi|mkv)$/i, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(?:full|limited|final|vr)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(value) {
    return new Set(
      normalizedText(value)
        .split(/\s+/)
        .filter((token) => token.length > 1),
    );
  }

  function similarity(left, right) {
    const a = tokens(left);
    const b = tokens(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap += 1;
    return (2 * overlap) / (a.size + b.size);
  }

  function parseDay(value) {
    const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match
      ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : Number.NaN;
  }

  function scoreRow(draft, row) {
    const titleScore = Math.max(
      similarity(draft.title, row.title),
      similarity(draft.filename, row.title),
    );
    const descriptionScore = similarity(draft.description, row.description);
    const targetDay = parseDay(draft.releaseDate);
    const rowDay = parseDay(row.releaseDate);
    const dayDistance =
      Number.isNaN(targetDay) || Number.isNaN(rowDay)
        ? 99
        : Math.abs(targetDay - rowDay) / 86_400_000;
    const dateScore =
      dayDistance === 0 ? 45 : Math.max(0, 14 - dayDistance * 2);
    const emptyTargetBonus = (draft.targets || []).reduce(
      (score, platform) =>
        score + (!clean(row[PLATFORM_FIELDS[platform]]) ? 3 : 0),
      0,
    );
    return Math.round(
      titleScore * 40 + descriptionScore * 14 + dateScore + emptyTargetBonus,
    );
  }

  function slugify(value) {
    return normalizedText(value).replace(/\s+/g, "-") || "untitled-video";
  }

  function canonicalPostUrl(platform, value) {
    const raw = clean(value);
    if (!raw || !Object.hasOwn(PLATFORM_FIELDS, platform)) return null;
    if (platform === "fansly" && /^\d+$/.test(raw)) {
      return `https://fansly.com/post/${raw}`;
    }
    if (platform === "onlyfans" && /^\d+$/.test(raw)) {
      return `https://onlyfans.com/${raw}/johnny_guides`;
    }
    if (platform === "manyvids" && /^\d+$/.test(raw)) {
      return `https://www.manyvids.com/Video/${raw}`;
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.port)
        return null;
      // Preserve the legacy creator-specific OnlyFans response normalization.
      if (platform !== "onlyfans" && url.hash) return null;
      if (platform !== "pornhub" && platform !== "onlyfans" && url.search)
        return null;
      if (platform === "pornhub") {
        const query = url.search.match(/^\?viewkey=([A-Za-z0-9_-]{1,100})$/);
        const viewkey = query?.[1] || "";
        return url.origin === "https://www.pornhub.com" &&
          ["/view_video.php", "/video/show"].includes(url.pathname) &&
          query &&
          /^[A-Za-z0-9_-]{1,100}$/.test(viewkey)
          ? `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`
          : null;
      }
      if (platform === "fansly") {
        const match = url.pathname.match(/^\/post\/(\d+)\/?$/);
        return url.origin === "https://fansly.com" && match
          ? `https://fansly.com/post/${match[1]}`
          : null;
      }
      if (platform === "manyvids") {
        const match = url.pathname.match(/^\/Video\/(\d+)\/?$/i);
        return url.origin === "https://www.manyvids.com" && match
          ? `https://www.manyvids.com/Video/${match[1]}`
          : null;
      }
      const match = url.pathname.match(/^\/(\d+)(?:\/johnny_guides)?\/?$/);
      return url.origin === "https://onlyfans.com" && match
        ? `https://onlyfans.com/${match[1]}/johnny_guides`
        : null;
    } catch {
      return null;
    }
  }

  function canonicalXStatusUrl(value) {
    try {
      const url = new URL(clean(value));
      const match = url.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})$/,
      );
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.hostname === "x.com" &&
        !url.search &&
        !url.hash &&
        match &&
        match[1].toLowerCase() !== "i"
        ? `https://x.com/${match[1]}/status/${match[2]}`
        : null;
    } catch {
      return null;
    }
  }

  function canonicalRedditPostUrl(value) {
    try {
      const url = new URL(clean(value));
      const match = url.pathname.match(
        /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})\/([A-Za-z0-9_-]+)\/?$/i,
      );
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        url.hostname === "www.reddit.com" &&
        match
        ? `https://www.reddit.com/r/${match[1]}/comments/${match[2].toLowerCase()}/${match[3]}`
        : null;
    } catch {
      return null;
    }
  }

  function safeLinkCommit(existing, incoming) {
    const current = clean(existing);
    const next = clean(incoming);
    if (!next) return { status: "invalid", value: current };
    if (!current) return { status: "updated", value: next };
    if (current === next) return { status: "idempotent", value: current };
    return { status: "conflict", value: current };
  }

  function fingerprint(row) {
    const serialized = [
      row.row,
      row.id,
      row.releaseDate,
      row.title,
      row.description,
      row.seasonArc,
      row.episode,
      row.pornhubLink,
      row.onlyfansLink,
      row.fanslyLink,
      row.manyvidsLink,
      row.twitterTeasers,
      row.redditPosts,
    ]
      .map(clean)
      .join("\u001f");
    let hash = 0x811c9dc5;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  globalThis.CreatorCatalogueContract = Object.freeze({
    canonicalPostUrl,
    canonicalRedditPostUrl,
    canonicalXStatusUrl,
    fingerprint,
    normalizedText,
    safeLinkCommit,
    scoreRow,
    similarity,
    slugify,
    tokens,
  });
})();
