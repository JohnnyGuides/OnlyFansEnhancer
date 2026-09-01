(() => {
  "use strict";

  if (globalThis.CreatorSocialDistributionContract) return;

  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  const HASH_PATTERN = /^[a-f0-9]{64}$/;
  const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{2,21}$/;
  const PRESET_ID_PATTERN = /^[A-Za-z0-9_-]{2,100}$/;
  const PRESET_REVISION_PATTERN = /^[a-f0-9]{8,64}$/;
  const PAID_HOSTS = new Set([
    "onlyfans.com",
    "fansly.com",
    "www.manyvids.com",
  ]);

  function clean(value, maximum = 5000) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maximum);
  }

  function hash(value, label) {
    const normalized = clean(value, 64).toLowerCase();
    if (!HASH_PATTERN.test(normalized)) throw new Error(`Invalid ${label}.`);
    return normalized;
  }

  function finiteNumber(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum
      ? number
      : null;
  }

  function fileProof(value) {
    const basename = clean(value?.basename, 255);
    const size = finiteNumber(value?.size, 1, Number.MAX_SAFE_INTEGER);
    const lastModified = finiteNumber(
      value?.lastModified,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const duration = Object.hasOwn(value || {}, "duration")
      ? finiteNumber(value.duration, 0.001, 8 * 60 * 60)
      : null;
    const sha256 = clean(value?.sha256, 64).toLowerCase();
    if (
      !basename ||
      /[\\/]/.test(basename) ||
      basename === "." ||
      basename === ".." ||
      size === null ||
      lastModified === null ||
      (Object.hasOwn(value || {}, "duration") && duration === null) ||
      !HASH_PATTERN.test(sha256)
    ) {
      throw new Error("Invalid social teaser file proof.");
    }
    return {
      basename,
      size,
      lastModified,
      ...(duration === null ? {} : { duration }),
      sha256,
    };
  }

  function catalogue(value) {
    const row = Number(value?.row);
    const id = clean(value?.id, 500);
    const title = clean(value?.title, 500);
    const fingerprint = clean(value?.fingerprint, 64).toLowerCase();
    if (
      !Number.isInteger(row) ||
      row < 2 ||
      row > 5000 ||
      !id ||
      !title ||
      !/^[a-f0-9]{8,64}$/.test(fingerprint)
    ) {
      throw new Error("Choose one explicit catalogue row.");
    }
    return { row, id, title, fingerprint };
  }

  function copyProof(value, label) {
    const state = clean(value?.state, 20);
    if (!new Set(["empty", "nonempty"]).has(state)) {
      throw new Error(`Invalid ${label} state.`);
    }
    return { state, sha256: hash(value?.sha256, `${label} hash`) };
  }

  function publicHttpsUrl(value) {
    try {
      const url = new URL(clean(value, 1000));
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !url.hostname ||
        !PAID_HOSTS.has(url.hostname)
      ) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function redditTarget(value) {
    const rawSubreddit = clean(value?.subreddit, 23).replace(/^r\//i, "");
    if (!SUBREDDIT_PATTERN.test(rawSubreddit)) {
      throw new Error("Invalid subreddit.");
    }
    const presetId = clean(value?.presetId, 100);
    if (!PRESET_ID_PATTERN.test(presetId))
      throw new Error("Invalid Reddit preset ID.");
    const presetRevision = clean(value?.presetRevision, 64).toLowerCase();
    if (!PRESET_REVISION_PATTERN.test(presetRevision)) {
      throw new Error("Invalid Reddit preset revision.");
    }
    const output = {
      subreddit: rawSubreddit,
      presetId,
      presetRevision,
      title: copyProof(value?.title, "Reddit title"),
      body: copyProof(value?.body, "Reddit body"),
    };
    if (Object.hasOwn(value || {}, "flair")) {
      output.flair = clean(value.flair, 100);
    }
    if (Object.hasOwn(value || {}, "nsfw")) output.nsfw = value.nsfw === true;
    return output;
  }

  function evidence(value, targets) {
    const output = {};
    if (targets.x) output.x = hash(value?.x, "X trace evidence");
    if (targets.reddit.length) {
      output.redgifs = hash(value?.redgifs, "Redgifs trace evidence");
      output.reddit = hash(value?.reddit, "Reddit trace evidence");
    }
    return output;
  }

  function deepFreeze(value) {
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") deepFreeze(child);
    }
    return Object.freeze(value);
  }

  function freezeDistributionPlan(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid social distribution plan.");
    }
    const id = clean(value.id, 64);
    if (!ID_PATTERN.test(id)) throw new Error("Invalid distribution plan ID.");
    const mode = clean(value.mode, 20);
    if (!new Set(["manual", "autonomous"]).has(mode)) {
      throw new Error("Invalid distribution mode.");
    }
    const x = value.targets?.x === true;
    const reddit = (
      Array.isArray(value.targets?.reddit) ? value.targets.reddit : []
    ).map(redditTarget);
    const names = reddit.map((item) => item.subreddit.toLowerCase());
    if (new Set(names).size !== names.length) {
      throw new Error("Duplicate subreddit target.");
    }
    if (!x && reddit.length === 0) {
      throw new Error("Choose at least one social target.");
    }
    const targets = { x, reddit };
    const paidLinkSource = clean(value.paidLinkSource, 20);
    if (
      paidLinkSource &&
      (!x || !new Set(["onlyfans", "fansly", "manyvids"]).has(paidLinkSource))
    ) {
      throw new Error("Invalid paid-link source.");
    }
    const paidUrl = paidLinkSource ? "" : publicHttpsUrl(value.paidUrl) || "";
    if (x && !paidUrl && !paidLinkSource) {
      throw new Error("Invalid paid URL.");
    }
    let paidLinkDependency = null;
    if (paidLinkSource) {
      const uploadSessionId = clean(value.paidUploadSessionId, 64);
      if (!ID_PATTERN.test(uploadSessionId)) {
        throw new Error("Invalid paid upload session.");
      }
      paidLinkDependency = {
        platform: paidLinkSource,
        uploadSessionId,
      };
    }
    const authorizationAt = finiteNumber(
      value.authorization?.at,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (authorizationAt === null) {
      throw new Error("Invalid distribution authorization time.");
    }
    return deepFreeze({
      id,
      mode,
      catalogue: catalogue(value.catalogue),
      socialFile: fileProof(value.socialFile),
      caption: copyProof(value.caption, "caption"),
      paidUrl,
      ...(paidLinkDependency ? { paidLinkDependency } : {}),
      targets,
      evidence: evidence(value.evidence, targets),
      authorization: {
        at: authorizationAt,
        sha256: hash(
          value.authorization?.sha256,
          "distribution authorization hash",
        ),
      },
    });
  }

  function validateDistributionPlan(value) {
    return freezeDistributionPlan(value);
  }

  globalThis.CreatorSocialDistributionContract = Object.freeze({
    freezeDistributionPlan,
    validateDistributionPlan,
  });
})();
