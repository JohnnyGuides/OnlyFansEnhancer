(() => {
  "use strict";

  if (globalThis.CreatorSocialDistributionSessionStore) return;

  const contract = globalThis.CreatorSocialDistributionContract;
  if (!contract) {
    throw new Error("CreatorSocialDistributionContract is unavailable.");
  }
  const api = globalThis.browser || globalThis.chrome;
  const storage = api?.storage?.local;
  if (!storage) throw new Error("Extension local storage is unavailable.");

  const KEY_PREFIX = "creatorSocialDistributionSessionV1:";
  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  const LINEAR_STAGES = Object.freeze([
    "planned",
    "prepared",
    "submit-attempted",
    "result-captured",
    "sheet-complete",
  ]);
  const TERMINAL_STAGES = new Set([
    "failed",
    "blocked",
    "posted-link-unresolved",
  ]);
  let writeChain = Promise.resolve();

  function clean(value, maximum = 5000) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maximum);
  }

  function key(id) {
    const normalized = clean(id, 64);
    if (!ID_PATTERN.test(normalized)) {
      throw new Error("Invalid social distribution session ID.");
    }
    return `${KEY_PREFIX}${normalized}`;
  }

  function stage(value) {
    const normalized = clean(value, 30);
    if (
      !LINEAR_STAGES.includes(normalized) &&
      !TERMINAL_STAGES.has(normalized)
    ) {
      throw new Error("Invalid social distribution stage.");
    }
    return normalized;
  }

  function canonicalResultUrl(value) {
    try {
      const url = new URL(clean(value, 1000));
      return url.protocol === "https:" &&
        url.hostname &&
        !url.username &&
        !url.search &&
        !url.hash
        ? url.href
        : "";
    } catch {
      return "";
    }
  }

  function validateResultIdentity(jobId, patch) {
    if (!patch.resultId && !patch.resultUrl) return;
    if (!patch.resultId || !patch.resultUrl) {
      throw new Error("A canonical result requires both ID and URL.");
    }
    const url = new URL(patch.resultUrl);
    let pathIdentity = "";
    if (jobId === "x") {
      const match = url.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})\/?$/,
      );
      if (url.hostname === "x.com" && match) pathIdentity = match[2];
    } else if (jobId === "redgifs") {
      const match = url.pathname.match(/^\/watch\/([A-Za-z0-9-]{2,100})\/?$/);
      if (url.hostname === "www.redgifs.com" && match) pathIdentity = match[1];
    } else if (jobId.startsWith("reddit:")) {
      const match = url.pathname.match(
        /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})\/[A-Za-z0-9_-]+\/?$/i,
      );
      if (
        url.hostname === "www.reddit.com" &&
        match &&
        match[1].toLowerCase() === jobId.slice(7)
      ) {
        pathIdentity = match[2].toLowerCase();
      }
    }
    if (!pathIdentity || pathIdentity !== patch.resultId) {
      throw new Error("Invalid canonical result for this distribution job.");
    }
  }

  function initialJobs(plan) {
    const jobs = {};
    if (plan.targets.x) {
      jobs.x = { stage: "planned", submitAttempted: false };
    }
    if (plan.targets.reddit.length) {
      jobs.redgifs = { stage: "planned", submitAttempted: false };
      for (const target of plan.targets.reddit) {
        jobs[`reddit:${target.subreddit.toLowerCase()}`] = {
          stage: "planned",
          submitAttempted: false,
        };
      }
    }
    return jobs;
  }

  function checkpointPatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid distribution checkpoint.");
    }
    const output = {};
    if (Object.hasOwn(value, "stage")) output.stage = stage(value.stage);
    if (Object.hasOwn(value, "submitAttempted")) {
      output.submitAttempted = value.submitAttempted === true;
    }
    if (Object.hasOwn(value, "resultId")) {
      const resultId = clean(value.resultId, 200);
      if (!resultId) throw new Error("Invalid distribution result identity.");
      output.resultId = resultId;
    }
    if (Object.hasOwn(value, "resultUrl")) {
      const resultUrl = canonicalResultUrl(value.resultUrl);
      if (!resultUrl) throw new Error("Invalid distribution result URL.");
      output.resultUrl = resultUrl;
    }
    if (Object.hasOwn(value, "error")) output.error = clean(value.error, 500);
    if (Object.hasOwn(value, "updatedAt")) {
      const timestamp = Number(value.updatedAt);
      if (Number.isSafeInteger(timestamp) && timestamp >= 0) {
        output.updatedAt = timestamp;
      }
    }
    return output;
  }

  function mergeStage(previous, next) {
    if (!next || previous === next) return previous;
    if (previous === "posted-link-unresolved" && next === "result-captured") {
      return next;
    }
    if (TERMINAL_STAGES.has(previous)) return previous;
    if (previous === "sheet-complete") return previous;
    if (TERMINAL_STAGES.has(next)) return next;
    return LINEAR_STAGES[
      Math.max(LINEAR_STAGES.indexOf(previous), LINEAR_STAGES.indexOf(next))
    ];
  }

  function mergeJob(previous, patch) {
    const output = { ...previous, ...patch };
    output.stage = mergeStage(previous.stage, patch.stage);
    if (previous.submitAttempted === true) output.submitAttempted = true;
    if (
      LINEAR_STAGES.indexOf(output.stage) >=
        LINEAR_STAGES.indexOf("submit-attempted") ||
      output.stage === "posted-link-unresolved"
    ) {
      output.submitAttempted = true;
    }
    for (const field of ["resultId", "resultUrl"]) {
      if (previous[field] && patch[field] && previous[field] !== patch[field]) {
        throw new Error("Captured distribution result identity cannot change.");
      }
      if (previous[field]) output[field] = previous[field];
    }
    if (
      LINEAR_STAGES.indexOf(output.stage) >=
        LINEAR_STAGES.indexOf("result-captured") &&
      (!output.resultId || !output.resultUrl)
    ) {
      throw new Error("Captured result identity is required at this stage.");
    }
    return output;
  }

  async function load(id) {
    const storageKey = key(id);
    const result = await storage.get(storageKey);
    return result[storageKey] || null;
  }

  function enqueue(operation) {
    const current = writeChain.catch(() => {}).then(operation);
    writeChain = current;
    return current;
  }

  async function create(input) {
    const plan = contract.freezeDistributionPlan(input);
    return enqueue(async () => {
      if (await load(plan.id)) {
        throw new Error("This authorized distribution session already exists.");
      }
      const value = {
        id: plan.id,
        plan,
        jobs: initialJobs(plan),
        createdAt: plan.authorization.at,
        updatedAt: plan.authorization.at,
      };
      await storage.set({ [key(plan.id)]: value });
      return value;
    });
  }

  async function checkpoint(id, jobId, value) {
    const normalizedJobId = clean(jobId, 100);
    const patch = checkpointPatch(value);
    return enqueue(async () => {
      const previous = await load(id);
      if (!previous) throw new Error("Distribution session was not found.");
      if (!Object.hasOwn(previous.jobs, normalizedJobId)) {
        throw new Error("Unknown distribution job.");
      }
      validateResultIdentity(normalizedJobId, patch);
      const next = {
        ...previous,
        jobs: {
          ...previous.jobs,
          [normalizedJobId]: mergeJob(previous.jobs[normalizedJobId], patch),
        },
        updatedAt: patch.updatedAt || previous.updatedAt,
      };
      await storage.set({ [key(id)]: next });
      return next;
    });
  }

  async function unblock(id, jobId) {
    const normalizedJobId = clean(jobId, 100);
    return enqueue(async () => {
      const previous = await load(id);
      if (!previous) throw new Error("Distribution session was not found.");
      const job = previous.jobs?.[normalizedJobId];
      if (!job) throw new Error("Unknown distribution job.");
      if (job.stage !== "blocked" || job.submitAttempted) {
        throw new Error(
          "Only an unsubmitted dependency-blocked job can reopen.",
        );
      }
      const next = {
        ...previous,
        jobs: {
          ...previous.jobs,
          [normalizedJobId]: {
            stage: "planned",
            submitAttempted: false,
          },
        },
      };
      await storage.set({ [key(id)]: next });
      return next;
    });
  }

  async function list() {
    const result = await storage.get(null);
    return Object.entries(result)
      .filter(([storageKey]) => storageKey.startsWith(KEY_PREFIX))
      .map(([, record]) => record)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  globalThis.CreatorSocialDistributionSessionStore = Object.freeze({
    KEY_PREFIX,
    checkpoint,
    create,
    list,
    load,
    unblock,
  });
})();
