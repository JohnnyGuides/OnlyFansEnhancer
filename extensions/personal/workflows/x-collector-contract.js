(() => {
  "use strict";

  // Pure parsing and validation for the passive X collector. The same file
  // runs in X's main world (network parsing), the isolated relay (DOM
  // fallback) and the extension worker (strict batch validation).
  if (globalThis.CreatorXCollectorContract) return;

  // GraphQL operations whose responses may carry the owner's own posts. Any
  // other operation name is ignored without inspection.
  const TWEET_OPERATIONS = Object.freeze([
    "UserTweets",
    "UserTweetsAndReplies",
    "UserMedia",
    "UserHighlightsTweets",
    "TweetDetail",
    "TweetResultByRestId",
    "TweetResultsByRestIds",
  ]);
  const VIEWER_OPERATIONS = Object.freeze(["Viewer"]);
  const MESSAGE_TYPE = "CREATOR_X_COLLECTOR_BATCH";
  const PAGE_EVENT = "creator-x-collector";
  const MAX_TEXT = 2000;
  const MAX_MEDIA = 4;
  const MAX_URLS = 5;
  const MAX_URL_LENGTH = 1024;
  const MAX_BATCH = 100;
  const MAX_METRIC = 1e12;
  const MAX_DURATION_MS = 24 * 60 * 60_000;
  const MAX_WALK = 5000;
  const METRIC_KEYS = Object.freeze([
    "views",
    "likes",
    "reposts",
    "replies",
    "quotes",
    "bookmarks",
  ]);
  const MEDIA_TYPES = new Set(["video", "photo", "animated_gif"]);
  const ID = /^\d{1,25}$/;
  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const OBSERVATION_KEYS = Object.freeze([
    "statusId",
    "authorId",
    "authorHandle",
    "createdAt",
    "text",
    "inReplyToStatusId",
    "conversationId",
    "isRetweet",
    "media",
    "urls",
    "metrics",
    "source",
  ]);

  class SchemaDriftError extends Error {}

  function drift(message) {
    return new SchemaDriftError(message);
  }

  function operationName(url) {
    try {
      const parsed = new URL(String(url || ""), "https://x.com/");
      const match = parsed.pathname.match(
        /^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,64}\/([A-Za-z0-9_]{1,64})$/,
      );
      if (!match || parsed.origin !== "https://x.com") return null;
      return match[1];
    } catch {
      return null;
    }
  }

  function operationKind(name) {
    if (TWEET_OPERATIONS.includes(name)) return "tweets";
    if (VIEWER_OPERATIONS.includes(name)) return "viewer";
    return null;
  }

  function idOrNull(value) {
    const text = value === undefined || value === null ? "" : String(value);
    return ID.test(text) ? text : null;
  }

  function count(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = typeof value === "number" ? value : Number(String(value));
    return Number.isSafeInteger(number) && number >= 0 && number <= MAX_METRIC
      ? number
      : null;
  }

  function isoDate(value) {
    const time = Date.parse(String(value || ""));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  // Cut at MAX_TEXT UTF-16 units without leaving half a surrogate pair.
  function capText(value) {
    const text = String(value || "");
    if (text.length <= MAX_TEXT) return text;
    const cut = text.slice(0, MAX_TEXT);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  }

  function safeUrl(value, hosts = null) {
    try {
      const url = new URL(String(value || ""));
      if (!new Set(["https:", "http:"]).has(url.protocol)) return null;
      if (hosts && (url.protocol !== "https:" || !hosts.has(url.hostname)))
        return null;
      const text = url.href;
      return text.length <= MAX_URL_LENGTH ? text : null;
    } catch {
      return null;
    }
  }

  function unwrapTweet(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "TweetWithVisibilityResults")
      return unwrapTweet(result.tweet);
    if (result.__typename === "Tweet") return result;
    // Tombstones and unavailable posts carry no owner data.
    return null;
  }

  function userIdentity(userResult) {
    const user = userResult?.result;
    if (!user || typeof user !== "object") return null;
    const id = idOrNull(user.rest_id);
    const handle = String(
      user.core?.screen_name || user.legacy?.screen_name || "",
    );
    return id && HANDLE.test(handle) ? { id, handle } : null;
  }

  function parseMedia(legacy) {
    const items = legacy?.extended_entities?.media || legacy?.entities?.media;
    if (items === undefined) return [];
    if (!Array.isArray(items)) throw drift("media is not a list");
    return items.slice(0, MAX_MEDIA).map((item) => {
      if (!item || !MEDIA_TYPES.has(item.type))
        throw drift("unknown media type");
      const duration = count(item.video_info?.duration_millis);
      return {
        type: item.type,
        mediaKey: /^[0-9]{1,4}_[0-9]{1,25}$/.test(String(item.media_key || ""))
          ? String(item.media_key)
          : null,
        durationMs:
          duration !== null && duration <= MAX_DURATION_MS ? duration : null,
        posterUrl: safeUrl(item.media_url_https, new Set(["pbs.twimg.com"])),
      };
    });
  }

  function parseUrls(legacy) {
    const items = legacy?.entities?.urls;
    if (items === undefined) return [];
    if (!Array.isArray(items)) throw drift("urls is not a list");
    return items
      .map((item) => safeUrl(item?.expanded_url))
      .filter(Boolean)
      .slice(0, MAX_URLS);
  }

  // Parse one tweet_results.result value. Returns null for tombstones;
  // throws SchemaDriftError when a Tweet lacks the fields we rely on.
  function parseTweetResult(result) {
    const tweet = unwrapTweet(result);
    if (!tweet) return null;
    const legacy = tweet.legacy;
    const statusId = idOrNull(tweet.rest_id);
    const author = userIdentity(tweet.core?.user_results);
    const createdAt = isoDate(legacy?.created_at);
    if (!legacy || typeof legacy !== "object" || !statusId || !author)
      throw drift("tweet identity fields missing");
    if (!createdAt) throw drift("tweet created_at missing");
    if (typeof legacy.full_text !== "string") throw drift("tweet text missing");
    const isRetweet = Boolean(legacy.retweeted_status_result);
    // A repost's text, media, links and counters belong to someone else.
    if (isRetweet) {
      return {
        statusId,
        authorId: author.id,
        authorHandle: author.handle,
        createdAt,
        text: "",
        inReplyToStatusId: null,
        conversationId: idOrNull(legacy.conversation_id_str),
        isRetweet: true,
        media: [],
        urls: [],
        metrics: null,
        source: "network",
      };
    }
    const noteText = tweet.note_tweet?.note_tweet_results?.result?.text;
    return {
      statusId,
      authorId: author.id,
      authorHandle: author.handle,
      createdAt,
      text: capText(typeof noteText === "string" ? noteText : legacy.full_text),
      inReplyToStatusId: idOrNull(legacy.in_reply_to_status_id_str),
      conversationId: idOrNull(legacy.conversation_id_str),
      isRetweet: false,
      media: parseMedia(legacy),
      urls: parseUrls(legacy),
      metrics: {
        views: count(tweet.views?.count),
        likes: count(legacy.favorite_count),
        reposts: count(legacy.retweet_count),
        replies: count(legacy.reply_count),
        quotes: count(legacy.quote_count),
        bookmarks: count(legacy.bookmark_count),
      },
      source: "network",
    };
  }

  // Collect every tweet_results.result reachable from the response, without
  // descending into quoted or reposted posts (those belong to other people).
  function collectTweetResults(payload) {
    const found = [];
    const stack = [payload];
    let visited = 0;
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      if (++visited > MAX_WALK) throw drift("response too large");
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1)
          stack.push(value[index]);
        continue;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "quoted_status_result" || key === "retweeted_status_result")
          continue;
        if (key === "tweet_results" || key === "tweetResult") {
          if (child && typeof child === "object" && "result" in child)
            found.push(child.result);
          continue;
        }
        if (child && typeof child === "object") stack.push(child);
      }
    }
    return found;
  }

  // Parse an allowlisted tweet-bearing response. Owner-authored posts only;
  // any drift discards the whole response.
  function extractOwnerTweets(payload, ownerId) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return { ok: false, reason: "schema-drift", tweets: [] };
    if (!payload.data || typeof payload.data !== "object")
      return {
        ok: false,
        reason: payload.errors ? "error-response" : "schema-drift",
        tweets: [],
      };
    if (!idOrNull(ownerId))
      return { ok: false, reason: "owner-unknown", tweets: [] };
    try {
      const tweets = [];
      const seen = new Set();
      for (const result of collectTweetResults(payload.data)) {
        const tweet = parseTweetResult(result);
        if (!tweet || tweet.authorId !== ownerId || seen.has(tweet.statusId))
          continue;
        seen.add(tweet.statusId);
        tweets.push(tweet);
      }
      return { ok: true, reason: "", tweets };
    } catch (error) {
      if (error instanceof SchemaDriftError)
        return { ok: false, reason: "schema-drift", tweets: [] };
      throw error;
    }
  }

  function viewerIdentity(payload) {
    return userIdentity(payload?.data?.viewer?.user_results);
  }

  // X keeps the signed-in account id in the readable `twid` cookie (u=<id>).
  function ownerIdFromCookie(cookie) {
    const match = String(cookie || "").match(/(?:^|;\s*)twid=([^;]*)/);
    if (!match) return null;
    let value;
    try {
      value = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    const id = value.match(/^"?u=(\d{1,25})"?$/);
    return id ? id[1] : null;
  }

  // "12 replies, 3 reposts, 45 likes, 6 bookmarks, 7890 views"
  function parseMetricLabel(label) {
    const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, null]));
    const names = {
      reply: "replies",
      replies: "replies",
      repost: "reposts",
      reposts: "reposts",
      like: "likes",
      likes: "likes",
      bookmark: "bookmarks",
      bookmarks: "bookmarks",
      view: "views",
      views: "views",
      quote: "quotes",
      quotes: "quotes",
    };
    let matched = 0;
    for (const match of String(label || "").matchAll(
      /(\d[\d.,]*)\s+([A-Za-z]+)/g,
    )) {
      const key = names[match[2].toLowerCase()];
      const value = count(match[1].replace(/[.,]/g, ""));
      if (!key || value === null) continue;
      metrics[key] = value;
      matched += 1;
    }
    return matched ? metrics : null;
  }

  function statusFromHref(href) {
    try {
      const url = new URL(String(href || ""), "https://x.com/");
      const match = url.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})$/,
      );
      return url.origin === "https://x.com" && match
        ? { handle: match[1], statusId: match[2] }
        : null;
    } catch {
      return null;
    }
  }

  function ownerHandleFromDocument(document) {
    const link = document?.querySelector?.(
      'a[data-testid="AppTabBar_Profile_Link"]',
    );
    const match = String(link?.getAttribute?.("href") || "").match(
      /^\/([A-Za-z0-9_]{1,15})$/,
    );
    return match ? match[1] : null;
  }

  // Quoted posts render inside the article as their own block; anything in
  // such a block belongs to another post (usually another author).
  const NESTED_POST = 'article, div[role="link"], [data-testid="quoteTweet"]';

  function ownElements(article, selector) {
    return [...article.querySelectorAll(selector)].filter(
      (element) => element.closest(NESTED_POST) === article,
    );
  }

  // DOM fallback: read one rendered article. Returns null unless it is a
  // post authored by the owner handle. Text and media come only from the
  // outer post; when they cannot be isolated from an embedded quote, none
  // are kept.
  function extractDomArticle(article, ownerHandle) {
    if (!article || !HANDLE.test(String(ownerHandle || ""))) return null;
    if (ownElements(article, '[data-testid="socialContext"]').length)
      return null;
    const times = ownElements(article, "time[datetime]");
    const time = times[0];
    const anchor = time?.closest("a[href]");
    const status = statusFromHref(anchor?.getAttribute("href"));
    const createdAt = isoDate(time?.getAttribute("datetime"));
    if (
      !status ||
      !createdAt ||
      status.handle.toLowerCase() !== String(ownerHandle).toLowerCase()
    )
      return null;
    const texts = ownElements(article, 'div[data-testid="tweetText"]');
    const isolated = times.length === 1 && texts.length <= 1;
    const hasVideo =
      isolated &&
      ownElements(article, 'div[data-testid="videoPlayer"], video').length > 0;
    const group = ownElements(article, 'div[role="group"][aria-label]')[0];
    return {
      statusId: status.statusId,
      authorId: null,
      authorHandle: status.handle,
      createdAt,
      text: isolated && texts.length ? capText(texts[0].textContent) : "",
      inReplyToStatusId: null,
      conversationId: null,
      isRetweet: false,
      media: hasVideo
        ? [{ type: "video", mediaKey: null, durationMs: null, posterUrl: null }]
        : [],
      urls: [],
      metrics: parseMetricLabel(group?.getAttribute("aria-label")),
      source: "dom",
    };
  }

  function exactKeys(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const actual = Object.keys(value);
    return (
      actual.length === keys.length && actual.every((key) => keys.includes(key))
    );
  }

  function validMetric(value) {
    return (
      value === null ||
      (Number.isSafeInteger(value) && value >= 0 && value <= MAX_METRIC)
    );
  }

  function validObservation(row) {
    if (!exactKeys(row, OBSERVATION_KEYS)) return false;
    if (!ID.test(String(row.statusId)) || typeof row.statusId !== "string")
      return false;
    if (!new Set(["network", "dom"]).has(row.source)) return false;
    if (
      row.source === "network"
        ? !ID.test(String(row.authorId))
        : row.authorId !== null
    )
      return false;
    if (typeof row.authorHandle !== "string" || !HANDLE.test(row.authorHandle))
      return false;
    if (typeof row.createdAt !== "string" || isoDate(row.createdAt) === null)
      return false;
    if (typeof row.text !== "string" || row.text.length > MAX_TEXT)
      return false;
    for (const key of ["inReplyToStatusId", "conversationId"]) {
      if (
        row[key] !== null &&
        (typeof row[key] !== "string" || !ID.test(row[key]))
      )
        return false;
    }
    if (typeof row.isRetweet !== "boolean") return false;
    if (!Array.isArray(row.media) || row.media.length > MAX_MEDIA) return false;
    for (const item of row.media) {
      if (!exactKeys(item, ["type", "mediaKey", "durationMs", "posterUrl"]))
        return false;
      if (!MEDIA_TYPES.has(item.type)) return false;
      if (
        item.mediaKey !== null &&
        !/^[0-9]{1,4}_[0-9]{1,25}$/.test(String(item.mediaKey))
      )
        return false;
      if (
        item.durationMs !== null &&
        (!Number.isSafeInteger(item.durationMs) ||
          item.durationMs < 0 ||
          item.durationMs > MAX_DURATION_MS)
      )
        return false;
      if (
        item.posterUrl !== null &&
        safeUrl(item.posterUrl, new Set(["pbs.twimg.com"])) !== item.posterUrl
      )
        return false;
    }
    if (!Array.isArray(row.urls) || row.urls.length > MAX_URLS) return false;
    if (row.urls.some((url) => typeof url !== "string" || safeUrl(url) !== url))
      return false;
    if (row.metrics !== null) {
      if (!exactKeys(row.metrics, METRIC_KEYS)) return false;
      if (!METRIC_KEYS.every((key) => validMetric(row.metrics[key])))
        return false;
    }
    if (
      row.isRetweet &&
      (row.text || row.media.length || row.urls.length || row.metrics)
    )
      return false;
    return true;
  }

  function isOwnerRow(row, owner) {
    if (row.source === "network")
      return Boolean(owner.accountId) && row.authorId === owner.accountId;
    return row.authorHandle.toLowerCase() === owner.handle.toLowerCase();
  }

  // Strict validation of one relay batch in the extension worker. Malformed
  // batches throw; well-formed rows not authored by the owner are dropped.
  function validateBatch(batch) {
    if (!exactKeys(batch, ["owner", "observations"]))
      throw new Error("invalid-x-batch");
    const owner = batch.owner;
    if (
      !exactKeys(owner, ["accountId", "handle"]) ||
      (owner.accountId !== null &&
        (typeof owner.accountId !== "string" || !ID.test(owner.accountId))) ||
      typeof owner.handle !== "string" ||
      !HANDLE.test(owner.handle)
    )
      throw new Error("invalid-x-batch");
    if (
      !Array.isArray(batch.observations) ||
      batch.observations.length === 0 ||
      batch.observations.length > MAX_BATCH
    )
      throw new Error("invalid-x-batch");
    if (!batch.observations.every(validObservation))
      throw new Error("invalid-x-batch");
    const observations = batch.observations.filter((row) =>
      isOwnerRow(row, owner),
    );
    return {
      owner: { accountId: owner.accountId, handle: owner.handle },
      observations: JSON.parse(JSON.stringify(observations)),
      dropped: batch.observations.length - observations.length,
    };
  }

  globalThis.CreatorXCollectorContract = Object.freeze({
    TWEET_OPERATIONS,
    VIEWER_OPERATIONS,
    MESSAGE_TYPE,
    PAGE_EVENT,
    MAX_BATCH,
    MAX_TEXT,
    operationName,
    operationKind,
    parseTweetResult,
    extractOwnerTweets,
    viewerIdentity,
    ownerIdFromCookie,
    parseMetricLabel,
    ownerHandleFromDocument,
    extractDomArticle,
    validateBatch,
  });
})();
