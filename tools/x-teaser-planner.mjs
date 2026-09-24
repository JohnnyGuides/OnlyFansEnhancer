const STATUS =
  /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/(\d+)/g;
const WINDOWS = [
  { label: "24h", hours: 24, tolerance: 6 },
  { label: "72h", hours: 72, tolerance: 12 },
  { label: "7d", hours: 168, tolerance: 24 },
  { label: "30d", hours: 720, tolerance: 72 },
];

export function statusIds(value) {
  return [...String(value || "").matchAll(STATUS)].map((match) => match[1]);
}

export function catalogueFromSheet(values) {
  if (!Array.isArray(values) || !Array.isArray(values[0]))
    throw new Error("A Sheet rows export is required.");
  const headers = values[0].map((value) =>
    String(value || "")
      .trim()
      .toLowerCase(),
  );
  const column = (name) => headers.indexOf(name);
  for (const name of ["id", "title", "season / arc", "twitter teaser(s)"])
    if (column(name) < 0) throw new Error(`Sheet column ${name} is missing.`);
  return values.slice(1).flatMap((row, index) => {
    const id = String(row[column("id")] || "").trim();
    if (!id) return [];
    return [
      {
        row: index + 2,
        id,
        title: String(row[column("title")] || "").trim(),
        season: String(row[column("season / arc")] || "Unspecified").trim(),
        links: statusIds(row[column("twitter teaser(s)")]),
        unposted: Math.max(
          0,
          Number(row[column("# teasers unposted")] || 0) || 0,
        ),
      },
    ];
  });
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function observedAtWindow(post, snapshots, window) {
  const published = Date.parse(post.publishedAt);
  if (!Number.isFinite(published)) return null;
  const eligible = snapshots.filter((snapshot) => {
    if (snapshot.statusId !== post.statusId || !Number.isFinite(snapshot.views))
      return false;
    const age = (Date.parse(snapshot.observedAt) - published) / 3_600_000;
    return Math.abs(age - window.hours) <= window.tolerance;
  });
  eligible.sort(
    (left, right) =>
      Math.abs(
        Date.parse(left.observedAt) - published - window.hours * 3_600_000,
      ) -
      Math.abs(
        Date.parse(right.observedAt) - published - window.hours * 3_600_000,
      ),
  );
  return eligible[0] || null;
}

export function performanceReview(posts, snapshots) {
  const results = [];
  for (const window of WINDOWS) {
    const cohort = posts.flatMap((post) => {
      const sample = observedAtWindow(post, snapshots, window);
      return sample ? [{ post, sample }] : [];
    });
    if (cohort.length < 10) {
      results.push({
        window: window.label,
        comparablePosts: cohort.length,
        status: "insufficient-cohort",
      });
      continue;
    }
    const typicalViews = median(cohort.map(({ sample }) => sample.views));
    for (const { post, sample } of cohort) {
      if (sample.views < typicalViews * 0.5)
        results.push({
          window: window.label,
          statusId: post.statusId,
          status: "review-revamp",
          views: sample.views,
          medianViews: typicalViews,
          comparablePosts: cohort.length,
        });
    }
  }
  return results;
}

function newestFirst(left, right) {
  return Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0);
}

export function recommendQueue(catalogue, assets, posts, count = 10) {
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const postedIds = new Set(posts.map((post) => post.assetId).filter(Boolean));
  const ready = assets.filter(
    (asset) =>
      asset.catalogueId &&
      byId.has(asset.catalogueId) &&
      asset.state === "pending" &&
      (byId.get(asset.catalogueId).unposted > 0 ||
        !byId.get(asset.catalogueId).links?.length) &&
      !postedIds.has(asset.assetId),
  );
  const recent = posts
    .filter((post) => byId.has(post.catalogueId))
    .sort(newestFirst);
  const recentSeasons = recent
    .slice(0, 3)
    .map((post) => byId.get(post.catalogueId)?.season);
  let lastSeason = recentSeasons[0] || null;
  let streak = 0;
  for (const season of recentSeasons) {
    if (!lastSeason || season !== lastSeason) break;
    streak++;
  }
  const queue = [];
  const used = new Set();
  while (queue.length < count) {
    const candidates = ready.filter((asset) => !used.has(asset.assetId));
    if (!candidates.length) break;
    const alternative = candidates.some(
      (asset) => byId.get(asset.catalogueId).season !== lastSeason,
    );
    const permitted = candidates.filter(
      (asset) =>
        !(
          streak >= 3 &&
          alternative &&
          byId.get(asset.catalogueId).season === lastSeason
        ),
    );
    permitted.sort((left, right) => {
      const a = byId.get(left.catalogueId),
        b = byId.get(right.catalogueId);
      const aRecent = recent.findIndex((post) => post.catalogueId === a.id);
      const bRecent = recent.findIndex((post) => post.catalogueId === b.id);
      const aScore =
        (a.season === lastSeason ? 100 : 0) +
        (aRecent < 0 ? 0 : 20 - Math.min(aRecent, 20));
      const bScore =
        (b.season === lastSeason ? 100 : 0) +
        (bRecent < 0 ? 0 : 20 - Math.min(bRecent, 20));
      return (
        aScore - bScore ||
        a.id.localeCompare(b.id) ||
        left.assetId.localeCompare(right.assetId)
      );
    });
    const asset = permitted[0],
      item = byId.get(asset.catalogueId);
    queue.push({
      assetId: asset.assetId,
      basename: asset.basename,
      catalogueId: item.id,
      season: item.season,
    });
    used.add(asset.assetId);
    if (item.season === lastSeason) streak++;
    else {
      lastSeason = item.season;
      streak = 1;
    }
  }
  return queue;
}

export function preparationQueue(assets, count = 30) {
  const pending = assets.filter(
    (asset) => asset.state === "pending" && !asset.catalogueId,
  );
  const groups = new Map();
  for (const asset of pending) {
    const match = asset.basename.match(/\bs(\d{1,2})e(\d{1,3})\b/i);
    const season = match ? `Season ${Number(match[1])}` : "Needs season";
    const episode = match
      ? `${season} episode ${Number(match[2])}`
      : asset.basename;
    const key = episode.toLowerCase();
    if (!groups.has(key)) groups.set(key, { season, episode, variants: [] });
    groups.get(key).variants.push(asset.basename);
  }
  const queue = [],
    remaining = [...groups.values()].sort(
      (a, b) =>
        Number(a.season === "Needs season") -
          Number(b.season === "Needs season") ||
        a.season.localeCompare(b.season) ||
        a.episode.localeCompare(b.episode),
    );
  let lastSeason = null,
    streak = 0;
  while (remaining.length && queue.length < count) {
    const hasOther = remaining.some((item) => item.season !== lastSeason);
    const index = remaining.findIndex(
      (item) => !(streak >= 3 && hasOther && item.season === lastSeason),
    );
    const [next] = remaining.splice(index, 1);
    queue.push({ ...next, status: "pair-with-catalogue-before-posting" });
    if (next.season === lastSeason) streak++;
    else {
      lastSeason = next.season;
      streak = 1;
    }
  }
  return queue;
}

export function pairingSuggestions(catalogue, assets) {
  const terms = (value) =>
    new Set(
      String(value)
        .toLowerCase()
        .replace(/\.(?:mp4|mov|m4v|webm)$/i, "")
        .match(/[a-z0-9]+/g)
        ?.filter(
          (term) =>
            term.length >= 3 &&
            !/^\d+$/.test(term) &&
            !new Set(["twitter", "teaser", "video", "short", "mp4"]).has(term),
        ) || [],
    );
  return assets
    .filter((asset) => asset.state === "pending" && !asset.catalogueId)
    .flatMap((asset) => {
      const words = terms(asset.basename);
      if (!words.size) return [];
      const candidates = catalogue
        .map((item) => {
          const itemWords = terms(`${item.id} ${item.title}`);
          const shared = [...words].filter((word) =>
            itemWords.has(word),
          ).length;
          return {
            catalogueId: item.id,
            title: item.title,
            score: Math.round((100 * shared) / words.size),
          };
        })
        .filter((item) => item.score >= 50)
        .sort(
          (a, b) =>
            b.score - a.score || a.catalogueId.localeCompare(b.catalogueId),
        )
        .slice(0, 3);
      return candidates.length
        ? [{ basename: asset.basename, candidates }]
        : [];
    });
}

export function scheduleQueue(queue, posts, now = new Date()) {
  const recentHours = posts
    .map((post) => new Date(post.publishedAt))
    .filter((date) => Number.isFinite(date.getTime()) && date <= now)
    .sort((a, b) => b - a)
    .slice(0, 20)
    .map((date) => date.getUTCHours());
  const hour = recentHours.length >= 5 ? Math.round(median(recentHours)) : 19;
  const latest =
    posts
      .map((post) => Date.parse(post.publishedAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0] || 0;
  const anchor = Math.max(now.getTime(), latest + 48 * 3_600_000);
  const first = new Date(anchor);
  first.setUTCHours(hour, 0, 0, 0);
  if (first.getTime() < anchor) first.setUTCDate(first.getUTCDate() + 1);
  return queue.map((item, index) => ({
    ...item,
    suggestedAtUtc: new Date(
      first.getTime() + index * 48 * 3_600_000,
    ).toISOString(),
    reason:
      index === 0
        ? "Next available slot; season streaks are balanced."
        : "48-hour spacing; review before posting.",
  }));
}

export function reconcileTeasers({
  catalogue,
  xPosts,
  assets,
  receipts,
  snapshots = [],
}) {
  const sheetLinks = new Map();
  for (const item of catalogue)
    for (const statusId of item.links)
      sheetLinks.set(statusId, [...(sheetLinks.get(statusId) || []), item.id]);
  const xIds = new Set(xPosts.map((post) => post.statusId));
  const receiptIds = new Set(receipts.map((receipt) => receipt.statusId));
  const receiptBasenames = new Set(
    receipts.map((receipt) => receipt.basename.toLowerCase()).filter(Boolean),
  );
  return {
    counts: {
      catalogueEntries: catalogue.length,
      sheetLinks: sheetLinks.size,
      xPostsObserved: xIds.size,
      pendingAssets: assets.filter((asset) => asset.state === "pending").length,
      completedAssets: assets.filter((asset) => asset.state === "done").length,
      receipts: receipts.length,
    },
    xWithoutSheet: xPosts
      .filter((post) => post.teaser === true && !sheetLinks.has(post.statusId))
      .map((post) => post.statusId),
    xNeedsClassification: xPosts
      .filter(
        (post) =>
          post.teaser !== false &&
          post.teaser !== true &&
          !sheetLinks.has(post.statusId),
      )
      .map((post) => post.statusId),
    sheetNotObservedOnX: [...sheetLinks.keys()].filter((id) => !xIds.has(id)),
    duplicateSheetBindings: [...sheetLinks]
      .filter(([, ids]) => new Set(ids).size > 1)
      .map(([statusId, ids]) => ({ statusId, catalogueIds: ids })),
    receiptsWithoutSheet: receipts
      .filter((receipt) => !sheetLinks.has(receipt.statusId))
      .map((receipt) => receipt.statusId),
    sheetWithoutReceipt: [...sheetLinks.keys()].filter(
      (id) => !receiptIds.has(id),
    ),
    unpairedAssets: assets
      .filter((asset) => asset.state === "pending" && !asset.catalogueId)
      .map((asset) => asset.basename),
    doneWithoutReceipt: assets
      .filter(
        (asset) =>
          asset.state === "done" &&
          !receiptBasenames.has(asset.basename.toLowerCase()),
      )
      .map((asset) => asset.basename),
    performance: performanceReview(xPosts, snapshots),
    queue: scheduleQueue(recommendQueue(catalogue, assets, xPosts), xPosts),
    preparationQueue: preparationQueue(assets),
    pairingSuggestions: pairingSuggestions(catalogue, assets),
  };
}
