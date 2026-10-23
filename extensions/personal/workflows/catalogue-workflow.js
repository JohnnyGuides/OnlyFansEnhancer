(() => {
  "use strict";

  if (globalThis.CreatorCatalogueWorkflow) return;

  const KEY_PREFIX = "creatorCatalogueWorkflowOutboxV1:";
  const REVISION_PREFIX = "creatorCatalogueWorkflowRevisionV1:";
  const SIGNATURE_PREFIX = "creatorCatalogueWorkflowSignatureV1:";
  const MAX_BATCH = 50;
  const PLATFORM_MAP = Object.freeze({
    onlyfans: "onlyfans",
    fansly: "fansly",
    manyvids: "manyvids",
    pornhub: "pornhub",
    x: "x",
    reddit: "reddit",
    redgifs: "redgifs",
  });
  const ASSET_ROLE_MAP = Object.freeze({
    full: "video",
    teaser: "video",
    pornhub: "video",
    video: "video",
    thumbnail: "thumbnail",
    poster: "poster",
    script: "script",
    subtitle: "subtitle",
    audio: "audio",
  });
  let queue = Promise.resolve();

  function text(value, maximum = 500) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
  }

  function safeError(value) {
    const code = text(value, 64).toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : undefined;
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`;
    return JSON.stringify(value);
  }

  async function contentSignature(snapshot) {
    const content = { ...snapshot };
    delete content.revision;
    const encoded = canonicalJson(content);
    if (globalThis.crypto?.subtle?.digest) {
      try {
        const bytes = new TextEncoder().encode(encoded);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")}`;
      } catch {
        /* Keep deduplication available in older extension runtimes. */
      }
    }
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < encoded.length; index++) {
      const code = encoded.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    return `hash:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  }

  function sourceKey(value) {
    const key = text(value, 200);
    return key || null;
  }

  function catalogueContractDestination(value) {
    return value == null
      ? null
      : globalThis.CreatorCatalogueContract.catalogueDestination(value);
  }

  function isoTime(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    const date = new Date(number);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }

  function basename(value) {
    const name = text(value, 255);
    return name && !/[\\/]/.test(name) && name !== "." && name !== ".."
      ? name
      : "";
  }

  function hash(value) {
    const normalized = text(value, 64).toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
  }

  function canonicalUrl(platform, value) {
    const raw = text(value, 2048);
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        (url.search && platform !== "pornhub") ||
        url.hash
      )
        return undefined;
      if (platform === "x") {
        const match = url.pathname.match(
          /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})\/?$/,
        );
        return url.hostname === "x.com" &&
          match &&
          match[1].toLowerCase() !== "i"
          ? `https://x.com/${match[1]}/status/${match[2]}`
          : undefined;
      }
      if (platform === "reddit") {
        const match = url.pathname.match(
          /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([A-Za-z0-9]{3,12})\/([A-Za-z0-9_-]+)\/?$/i,
        );
        return url.hostname === "www.reddit.com" && match
          ? `https://www.reddit.com/r/${match[1]}/comments/${match[2].toLowerCase()}/${match[3]}`
          : undefined;
      }
      if (platform === "redgifs") {
        const match = url.pathname.match(/^\/watch\/([A-Za-z0-9-]{2,100})\/?$/);
        return ["redgifs.com", "www.redgifs.com"].includes(url.hostname) &&
          match
          ? `https://www.redgifs.com/watch/${match[1]}`
          : undefined;
      }
      if (platform === "script") {
        const match = url.pathname.match(
          /^\/sync\/scripts\/([A-Za-z0-9._-]{1,200}\.funscript)$/i,
        );
        return ["johnnyguides.com", "www.johnnyguides.com"].includes(
          url.hostname,
        ) && match
          ? `https://johnnyguides.com/sync/scripts/${match[1]}`
          : undefined;
      }
      const contract = globalThis.CreatorCatalogueContract;
      const canonical = contract?.canonicalPostUrl?.(platform, raw);
      return typeof canonical === "string" && canonical === raw
        ? canonical
        : undefined;
    } catch {
      return undefined;
    }
  }

  function canonicalPaidUrl(value) {
    const raw = text(value, 1000);
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.hash
      )
        return undefined;
      if (
        url.hostname === "onlyfans.com" &&
        !url.search &&
        /^\/[A-Za-z0-9._]{1,64}\/?$/.test(url.pathname)
      )
        return `https://onlyfans.com/${url.pathname.replace(/^\/+|\/+$/g, "")}`;
      if (
        url.hostname === "fansly.com" &&
        !url.search &&
        /^\/[A-Za-z0-9._]{1,64}\/posts\/?$/.test(url.pathname)
      )
        return `https://fansly.com/${url.pathname.replace(/^\/+|\/+$/g, "")}`;
      for (const platform of ["onlyfans", "fansly", "manyvids", "pornhub"])
        if (canonicalUrl(platform, raw)) return canonicalUrl(platform, raw);
    } catch {
      return undefined;
    }
    return undefined;
  }

  function asset(role, proof) {
    if (!proof || typeof proof !== "object") return null;
    const name = basename(proof.name ?? proof.basename);
    const size = Number(proof.size);
    const lastModified = isoTime(proof.lastModified);
    if (!name || !Number.isSafeInteger(size) || size < 0 || !lastModified)
      return null;
    return {
      role: ASSET_ROLE_MAP[role] || "other",
      name,
      size,
      lastModified,
      ...(hash(proof.sha256) ? { sha256: hash(proof.sha256) } : {}),
    };
  }

  function mappedStatus(status, submitted, postUrl, error) {
    const normalized = text(status, 40).toLowerCase();
    if (postUrl) return error ? "partial" : "uploaded";
    if (["skipped", "cancelled"].includes(normalized)) return normalized;
    if (["failed", "error", "blocked"].includes(normalized)) return "failed";
    if (
      submitted ||
      ["submitted", "submit-attempted", "posted-link-unresolved"].includes(
        normalized,
      )
    )
      return "submitted";
    if (
      [
        "uploaded",
        "published",
        "sent",
        "sheet-complete",
        "result-captured",
      ].includes(normalized)
    )
      return "uploaded";
    if (["selected", "planned"].includes(normalized)) return "selected";
    return normalized ? "pending" : "selected";
  }

  function target(platform, state, fallbackStatus) {
    const mappedPlatform = PLATFORM_MAP[platform];
    if (!mappedPlatform) return null;
    const postUrls = [
      state?.postUrl,
      state?.resultUrl,
      ...(Array.isArray(state?.postUrls) ? state.postUrls : []),
    ]
      .map((url) => canonicalUrl(platform, url))
      .filter(Boolean);
    const uniquePostUrls = [...new Set(postUrls)].slice(0, 100);
    const postUrl = uniquePostUrls[0];
    const error = safeError(state?.errorCode || state?.rejectionCode);
    const submitted =
      state?.submitAttempted === true || state?.submitted === true;
    return {
      platform: mappedPlatform,
      status: mappedStatus(
        state?.status || state?.stage || fallbackStatus,
        submitted,
        postUrl,
        error,
      ),
      ...(postUrl ? { postUrl } : {}),
      ...(uniquePostUrls.length > 1 ? { postUrls: uniquePostUrls } : {}),
      ...(error ? { error } : {}),
      submitted,
      ...(safeError(state?.googleErrorCode || state?.sheetErrorCode)
        ? {
            googleError: safeError(
              state.googleErrorCode || state.sheetErrorCode,
            ),
          }
        : {}),
    };
  }

  function assetList(fileProof) {
    if (!fileProof || typeof fileProof !== "object") return [];
    return Object.entries(fileProof)
      .map(([role, proof]) => asset(role, proof))
      .filter(Boolean)
      .slice(0, 100);
  }

  function uploadScript(record) {
    const script = record?.scriptState || record?.script;
    const proof = record?.draft?.fileProof?.script;
    if (!script && !proof) return undefined;
    const status =
      script?.status === "sent" || script?.status === "uploaded"
        ? "uploaded"
        : script?.status === "partial"
          ? "partial"
          : script?.status === "failed"
            ? "failed"
            : script?.status === "skipped"
              ? "skipped"
              : script?.status === "waiting" || script?.status === "pending"
                ? "pending"
                : "selected";
    const links = [
      ...new Set(
        (Array.isArray(script?.urls) ? script.urls : [])
          .map((url) => canonicalUrl("script", url))
          .filter(Boolean),
      ),
    ].slice(0, 100);
    const sentKeys = [
      ...new Set(
        (Array.isArray(script?.sentKeys) ? script.sentKeys : [])
          .map((key) => text(key, 200))
          .filter((key) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(key)),
      ),
    ].slice(0, 100);
    const writebackState =
      script?.writebackState ||
      (script
        ? record.catalogue?.destination?.workbookId
          ? script.sheetPending === true
            ? "pending"
            : "synced"
          : "not-associated"
        : undefined);
    return {
      status,
      ...(basename(proof?.name || script?.filename)
        ? { filename: basename(proof?.name || script.filename) }
        : {}),
      ...(hash(script?.sha256 || proof?.sha256)
        ? { sha256: hash(script?.sha256 || proof.sha256) }
        : {}),
      ...(links.length ? { links } : {}),
      ...(sentKeys.length ? { sentKeys } : {}),
      ...(new Set(["not-associated", "pending", "synced"]).has(writebackState)
        ? { writebackState }
        : {}),
      ...(status === "failed" && safeError(script?.errorCode)
        ? { error: safeError(script.errorCode) }
        : {}),
    };
  }

  function uploadSnapshot(record) {
    if (
      !record ||
      typeof record !== "object" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(text(record.id, 64))
    )
      throw new Error("Invalid upload workflow record.");
    const targets = Object.entries(record.platforms || {})
      .map(([platform, state]) => target(platform, state))
      .filter(Boolean);
    return {
      runId: text(record.id, 64),
      kind: "upload",
      revision:
        Number.isSafeInteger(record.workflowRevision) &&
        record.workflowRevision > 0
          ? record.workflowRevision
          : 1,
      sourceKey: sourceKey(record.catalogue?.id),
      ...(catalogueContractDestination(record.catalogue?.destination)
        ? {
            destination: catalogueContractDestination(
              record.catalogue.destination,
            ),
          }
        : {}),
      targets: targets.slice(0, 20),
      assets: assetList(record.draft?.fileProof),
      ...(uploadScript(record) ? { script: uploadScript(record) } : {}),
    };
  }

  function socialSnapshot(record) {
    const plan = record?.plan;
    if (!plan || !/^[A-Za-z0-9_-]{8,64}$/.test(text(plan.id, 64)))
      throw new Error("Invalid social workflow record.");
    const jobs =
      record.jobs && typeof record.jobs === "object" ? record.jobs : {};
    const targets = [];
    if (plan.targets?.x) targets.push(target("x", jobs.x, "planned"));
    if (Array.isArray(plan.targets?.reddit) && plan.targets.reddit.length) {
      const redditJobs = Object.entries(jobs).filter(([key]) =>
        key.startsWith("reddit:"),
      );
      const selected = redditJobs.length
        ? redditJobs
        : [["reddit", { stage: "planned" }]];
      const candidates = selected
        .map(([, job]) => target("reddit", job, "planned"))
        .filter(Boolean);
      const urls = [
        ...new Set(
          candidates
            .flatMap((item) => [item.postUrl, ...(item.postUrls || [])])
            .filter(Boolean),
        ),
      ].slice(0, 100);
      const hasSuccess = candidates.some((item) =>
        ["uploaded", "partial"].includes(item.status),
      );
      const hasUnresolvedOrFailure = candidates.some((item) =>
        ["partial", "failed", "submitted", "pending"].includes(item.status),
      );
      const allSkipped =
        candidates.length > 0 &&
        candidates.every((item) =>
          ["skipped", "cancelled"].includes(item.status),
        );
      const status =
        hasSuccess && hasUnresolvedOrFailure
          ? "partial"
          : hasSuccess
            ? "uploaded"
            : candidates.some((item) => item.status === "failed")
              ? "failed"
              : candidates.some((item) => item.status === "submitted")
                ? "submitted"
                : candidates.some((item) => item.status === "pending")
                  ? "pending"
                  : allSkipped
                    ? "skipped"
                    : "selected";
      if (candidates.length) {
        targets.push({
          platform: "reddit",
          status,
          ...(urls[0] ? { postUrl: urls[0] } : {}),
          ...(urls.length > 1 ? { postUrls: urls } : {}),
          submitted: candidates.some((item) => item.submitted),
          ...(status === "failed" || status === "partial"
            ? {
                error:
                  candidates.find((item) => item.error)?.error ||
                  "reddit_target_incomplete",
              }
            : {}),
        });
      }
    }
    if (plan.targets?.reddit?.length) {
      const redgifs = target("redgifs", jobs.redgifs, "planned");
      if (redgifs) targets.push(redgifs);
    }
    const xJob = jobs.x || {};
    const paidUrl = canonicalPaidUrl(xJob.resolvedPaidUrl || plan.paidUrl);
    const reply =
      plan.targets?.x && paidUrl
        ? {
            paidUrl,
            autoReply: plan.xOptions?.autoReply ?? plan.mode === "autonomous",
            replyDelayMinutes: Number.isInteger(
              plan.xOptions?.replyDelayMinutes,
            )
              ? plan.xOptions.replyDelayMinutes
              : 0,
            ...(text(xJob.replyLine, 200)
              ? { wordingTemplate: text(xJob.replyLine, 200) }
              : {}),
            ...(canonicalUrl("x", xJob.resultUrl)
              ? { mainStatusUrl: canonicalUrl("x", xJob.resultUrl) }
              : {}),
            ...(canonicalUrl("x", xJob.replyResultUrl)
              ? { replyStatusUrl: canonicalUrl("x", xJob.replyResultUrl) }
              : {}),
            ...(isoTime(xJob.replyDueAt)
              ? { dueAt: isoTime(xJob.replyDueAt) }
              : {}),
            attempted: xJob.replySubmitAttempted === true,
          }
        : undefined;
    const proof = plan.socialFile || {};
    const video = asset("video", {
      name: proof.basename,
      size: proof.size,
      lastModified: proof.lastModified,
      sha256: proof.sha256,
    });
    const catalogueId = sourceKey(
      record.catalogueAssociation?.id || plan.catalogue?.id,
    );
    const destination = catalogueContractDestination(
      record.catalogueAssociation
        ? record.catalogueAssociation.destination
        : plan.catalogue?.destination,
    );
    return {
      runId: text(plan.id, 64),
      kind: "social",
      revision:
        Number.isSafeInteger(record.workflowRevision) &&
        record.workflowRevision > 0
          ? record.workflowRevision
          : 1,
      sourceKey: catalogueId,
      ...(destination ? { destination } : {}),
      targets: targets.slice(0, 20),
      assets: video ? [video] : [],
      ...(reply ? { reply } : {}),
      ...(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
        text(String(plan.xOptions?.clipId || record.clipId || ""), 128),
      ) ||
      hash(proof.sha256) ||
      catalogueId
        ? {
            clip: {
              ...(text(
                String(plan.xOptions?.clipId || record.clipId || ""),
                128,
              )
                ? {
                    clipId: text(
                      String(plan.xOptions?.clipId || record.clipId),
                      128,
                    ),
                  }
                : {}),
              ...(hash(proof.sha256) ? { sha256: hash(proof.sha256) } : {}),
              ...(catalogueId ? { episodeKey: catalogueId } : {}),
            },
          }
        : {}),
    };
  }

  function normalize(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
      throw new Error("Invalid creator workflow snapshot.");
    const runId = text(snapshot.runId, 128);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId) ||
      !["upload", "social"].includes(snapshot.kind)
    )
      throw new Error("Invalid creator workflow identity.");
    if (
      (snapshot.targets || []).length > 20 ||
      (snapshot.assets || []).length > 100
    )
      throw new Error("Creator workflow snapshot exceeds its bounds.");
    const revision =
      Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0
        ? snapshot.revision
        : 1;
    const targets = (
      Array.isArray(snapshot.targets) ? snapshot.targets : []
    ).map((item) => {
      const platform = PLATFORM_MAP[item?.platform];
      if (
        !platform ||
        ![
          "selected",
          "pending",
          "submitted",
          "uploaded",
          "partial",
          "failed",
          "skipped",
          "cancelled",
        ].includes(item.status)
      )
        throw new Error("Invalid creator workflow target.");
      const postUrl = canonicalUrl(item.platform, item.postUrl);
      const postUrls = [
        postUrl,
        ...(Array.isArray(item.postUrls) ? item.postUrls : []),
      ]
        .map((url) => canonicalUrl(item.platform, url))
        .filter(Boolean);
      const uniquePostUrls = [...new Set(postUrls)].slice(0, 100);
      const error = safeError(item.error);
      const googleError = safeError(item.googleError);
      return {
        platform,
        status: item.status,
        ...(uniquePostUrls[0] ? { postUrl: uniquePostUrls[0] } : {}),
        ...(uniquePostUrls.length > 1 ? { postUrls: uniquePostUrls } : {}),
        ...(error ? { error } : {}),
        submitted: item.submitted === true,
        ...(googleError ? { googleError } : {}),
      };
    });
    if (new Set(targets.map((item) => item.platform)).size !== targets.length)
      throw new Error("Duplicate creator workflow target.");
    return {
      runId,
      kind: snapshot.kind,
      revision,
      sourceKey: sourceKey(snapshot.sourceKey),
      ...(snapshot.destination
        ? { destination: catalogueContractDestination(snapshot.destination) }
        : {}),
      targets,
      assets: (Array.isArray(snapshot.assets) ? snapshot.assets : []).map(
        (item) => {
          const proof = asset(item.role, item);
          if (!proof) throw new Error("Invalid creator workflow asset.");
          return proof;
        },
      ),
      ...(snapshot.script
        ? {
            script: uploadScript({
              script: {
                ...snapshot.script,
                urls: snapshot.script.links,
                filename: snapshot.script.filename,
              },
            }),
          }
        : {}),
      ...(snapshot.reply && canonicalPaidUrl(snapshot.reply.paidUrl)
        ? {
            reply: {
              paidUrl: canonicalPaidUrl(snapshot.reply.paidUrl),
              autoReply: snapshot.reply.autoReply === true,
              replyDelayMinutes:
                Number.isInteger(snapshot.reply.replyDelayMinutes) &&
                snapshot.reply.replyDelayMinutes >= 0 &&
                snapshot.reply.replyDelayMinutes <= 10080
                  ? snapshot.reply.replyDelayMinutes
                  : 0,
              ...(text(snapshot.reply.wordingTemplate, 200)
                ? { wordingTemplate: text(snapshot.reply.wordingTemplate, 200) }
                : {}),
              ...(canonicalUrl("x", snapshot.reply.mainStatusUrl)
                ? {
                    mainStatusUrl: canonicalUrl(
                      "x",
                      snapshot.reply.mainStatusUrl,
                    ),
                  }
                : {}),
              ...(canonicalUrl("x", snapshot.reply.replyStatusUrl)
                ? {
                    replyStatusUrl: canonicalUrl(
                      "x",
                      snapshot.reply.replyStatusUrl,
                    ),
                  }
                : {}),
              ...(isoTime(Date.parse(snapshot.reply.dueAt))
                ? { dueAt: isoTime(Date.parse(snapshot.reply.dueAt)) }
                : {}),
              attempted: snapshot.reply.attempted === true,
            },
          }
        : {}),
      ...(snapshot.clip && typeof snapshot.clip === "object"
        ? {
            clip: {
              ...(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
                text(snapshot.clip.clipId, 128),
              )
                ? { clipId: text(snapshot.clip.clipId, 128) }
                : {}),
              ...(hash(snapshot.clip.sha256)
                ? { sha256: hash(snapshot.clip.sha256) }
                : {}),
              ...(sourceKey(snapshot.clip.episodeKey)
                ? { episodeKey: sourceKey(snapshot.clip.episodeKey) }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * @param {{ storage?: { get: (keys: string[] | null) => Promise<Record<string, any>>, set: (values: Record<string, any>) => Promise<unknown>, remove: (key: string) => Promise<unknown> }, send?: (command: "recordCreatorWorkflow", snapshot: Record<string, any>) => Promise<{ status?: string, code?: string } | undefined>, now?: () => number }} options
   */
  function create({ storage, send, now = Date.now } = {}) {
    if (
      !storage?.get ||
      !storage?.set ||
      !storage?.remove ||
      typeof send !== "function"
    )
      throw new Error(
        "Catalogue workflow storage and native sender are required.",
      );

    async function enqueue(snapshot) {
      const normalized = normalize(snapshot);
      const key = `${KEY_PREFIX}${normalized.runId}`;
      const revisionKey = `${REVISION_PREFIX}${normalized.runId}`;
      const signatureKey = `${SIGNATURE_PREFIX}${normalized.runId}`;
      return serialize(async () => {
        const signature = await contentSignature(normalized);
        const existingValues = await storage.get([
          key,
          revisionKey,
          signatureKey,
        ]);
        const existing = existingValues[key];
        const prior = existing?.snapshot;
        const priorSignature =
          existingValues[signatureKey]?.signature ||
          (prior ? await contentSignature(prior) : undefined);
        if (priorSignature === signature) {
          const unchangedSnapshot = prior || {
            ...normalized,
            revision:
              Number(existingValues[revisionKey]) || normalized.revision,
          };
          return {
            status: existing?.state || "unchanged",
            snapshot: unchangedSnapshot,
            unchanged: true,
          };
        }
        const revision = Math.max(
          normalized.revision,
          (Number(prior?.revision) || 0) + 1,
          (Number(existingValues[revisionKey]) || 0) + 1,
        );
        const value = {
          snapshot: { ...normalized, revision },
          state: "pending",
          updatedAt: Number(now()) || Date.now(),
          ...(existing?.lastError ? { lastError: existing.lastError } : {}),
        };
        await storage.set({ [key]: value, [revisionKey]: revision });
        await storage.set({
          [signatureKey]: { signature, revision },
        });
        return { status: "pending", snapshot: value.snapshot };
      });
    }

    async function observeRevision(runId, revision) {
      if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(runId))
        throw new Error("Invalid creator workflow run ID.");
      if (!Number.isSafeInteger(revision) || revision <= 0)
        throw new Error("Invalid creator workflow revision.");
      const key = `${KEY_PREFIX}${runId}`;
      const revisionKey = `${REVISION_PREFIX}${runId}`;
      return serialize(async () => {
        const stored = await storage.get([key, revisionKey]);
        const queuedRevision = stored[key]?.snapshot?.revision;
        const revisionFloor = stored[revisionKey];
        const floor = Math.max(
          revision,
          Number.isSafeInteger(queuedRevision) && queuedRevision > 0
            ? queuedRevision
            : 0,
          Number.isSafeInteger(revisionFloor) && revisionFloor > 0
            ? revisionFloor
            : 0,
        );
        if (floor !== revisionFloor)
          await storage.set({ [revisionKey]: floor });
        return floor;
      });
    }

    async function flush() {
      return serialize(async () => {
        const stored = await storage.get(null);
        const entries = Object.entries(stored)
          .filter(
            ([key, value]) =>
              key.startsWith(KEY_PREFIX) &&
              value?.snapshot &&
              value.state !== "conflict",
          )
          .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
          .slice(0, MAX_BATCH);
        const results = [];
        for (const [key, envelope] of entries) {
          try {
            const response = await send(
              "recordCreatorWorkflow",
              envelope.snapshot,
            );
            const status = text(response?.status, 30).toLowerCase();
            if (["recorded", "idempotent", "stale"].includes(status)) {
              await storage.remove(key);
              results.push({ runId: envelope.snapshot.runId, status });
            } else {
              const code =
                safeError(response?.code) ||
                (status === "conflict"
                  ? "creator_workflow_conflict"
                  : "native_response_unresolved");
              await storage.set({
                [key]: {
                  ...envelope,
                  state: status === "conflict" ? "conflict" : "pending",
                  lastError: code,
                },
              });
              results.push({
                runId: envelope.snapshot.runId,
                status: status === "conflict" ? "conflict" : "pending",
                error: code,
              });
            }
          } catch (error) {
            const code = safeError(error?.code) || "native_unavailable";
            await storage.set({
              [key]: { ...envelope, state: "pending", lastError: code },
            });
            results.push({
              runId: envelope.snapshot.runId,
              status: "pending",
              error: code,
            });
          }
        }
        return {
          processed: entries.length,
          remaining: Object.keys(await storage.get(null)).filter((key) =>
            key.startsWith(KEY_PREFIX),
          ).length,
          results,
        };
      });
    }

    async function scanPersisted() {
      const stored = await storage.get(null);
      return Object.entries(stored)
        .filter(([key]) => key.startsWith(KEY_PREFIX))
        .map(([, value]) => value)
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        .slice(0, MAX_BATCH);
    }

    return Object.freeze({ enqueue, observeRevision, flush, scanPersisted });
  }

  function serialize(operation) {
    const current = queue.catch(() => {}).then(operation);
    queue = current;
    return current;
  }

  globalThis.CreatorCatalogueWorkflow = Object.freeze({
    create,
    uploadSnapshot,
    socialSnapshot,
    KEY_PREFIX,
    REVISION_PREFIX,
  });
})();
