"use strict";

(() => {
  const PLATFORM_LABELS = {
    onlyfans: "OnlyFans",
    fansly: "Fansly",
    manyvids: "ManyVids",
    pornhub: "Pornhub",
  };
  const VIDEO_EXTENSIONS = /\.(?:mp4|m4v|mov|webm|avi|mkv)$/i;
  const IMAGE_EXTENSIONS = /\.(?:jpe?g|png)$/i;
  const TARGETS = new Set(["onlyfans", "fansly", "manyvids", "pornhub"]);
  const SOCIAL_TARGETS = new Set(["x", "reddit"]);
  const PAID_LINK_SOURCES = new Set(["onlyfans", "fansly", "manyvids"]);
  const TRACE_HASH = /^[a-f0-9]{64}$/i;
  const PRESET_ID = /^[A-Za-z0-9_-]{2,100}$/;
  const PRESET_REVISION = /^[a-f0-9]{8,64}$/i;
  const X_CAPTION_MAX = 280;
  const REDDIT_TITLE_MAX = 300;
  const WORKFLOW_TOOL_CONTROLS = Object.freeze({
    uploadTraceRecorder: "#toolUploadTraceRecorder",
    c4sUpload: "#toolC4sUpload",
    phUploader: "#toolPhUploader",
    fanslyPrefill: "#toolFanslyPrefill",
    manyvidsAutofill: "#toolManyvidsAutofill",
    sheerTags: "#toolSheerTags",
    onlyfansAutoSelect: "#toolOnlyfansAutoSelect",
    onlyfansAutoFollow: "#toolOnlyfansAutoFollow",
    redditBannerCensor: "#toolRedditBannerCensor",
  });

  function localDateTimeValue(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
  }

  function nextFridayUtc(
    now = new Date(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    const current = new Date(now);
    const target = new Date(current);
    target.setUTCHours(15, 0, 0, 0);
    target.setUTCDate(target.getUTCDate() + ((5 - target.getUTCDay() + 7) % 7));
    if (target <= current) target.setUTCDate(target.getUTCDate() + 7);
    return {
      iso: target.toISOString(),
      releaseDate: target.toISOString().slice(0, 10),
      localValue: localDateTimeValue(target, timeZone),
      timeZone,
    };
  }

  function nextFridayLocalValue(now = new Date()) {
    return nextFridayUtc(now).localValue;
  }

  function isVideoFile(file) {
    const mimeType = String(file?.type || "");
    return Boolean(
      file &&
      Number(file.size) > 0 &&
      (mimeType
        ? mimeType.startsWith("video/")
        : VIDEO_EXTENSIONS.test(String(file.name || ""))),
    );
  }

  function isImageFile(file) {
    const mimeType = String(file?.type || "");
    return Boolean(
      file &&
      Number(file.size) > 0 &&
      (mimeType
        ? ["image/png", "image/jpeg"].includes(mimeType)
        : IMAGE_EXTENSIONS.test(String(file.name || ""))),
    );
  }

  const normalizedThumbnails = new WeakMap();
  function normalizeThumbnailFile(file) {
    if (!(file instanceof File) || !isImageFile(file))
      return Promise.reject(
        new Error("Choose a readable PNG or JPEG thumbnail."),
      );
    if (file.size > 50 * 1024 * 1024)
      return Promise.reject(new Error("Choose a thumbnail under 50 MB."));
    if (normalizedThumbnails.has(file)) return normalizedThumbnails.get(file);
    const conversion = (async () => {
      let bitmap;
      try {
        bitmap = await createImageBitmap(file, {
          imageOrientation: "from-image",
        });
      } catch {
        throw new Error("Choose a readable PNG or JPEG thumbnail.");
      }
      try {
        if (
          !bitmap.width ||
          !bitmap.height ||
          bitmap.width > 10000 ||
          bitmap.height > 10000
        )
          throw new Error("The thumbnail dimensions are unsupported.");
        const width = 640;
        const height = 360;
        const scale = Math.max(width / bitmap.width, height / bitmap.height);
        const cropWidth = width / scale;
        const cropHeight = height / scale;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Thumbnail conversion is unavailable.");
        context.fillStyle = "#000";
        context.fillRect(0, 0, width, height);
        context.drawImage(
          bitmap,
          (bitmap.width - cropWidth) / 2,
          (bitmap.height - cropHeight) / 2,
          cropWidth,
          cropHeight,
          0,
          0,
          width,
          height,
        );
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob?.size || blob.size >= 2_000_000)
          throw new Error("The converted thumbnail exceeds 2 MB.");
        const base = file.name.replace(/\.[^.]+$/, "").slice(0, 100);
        return new File([blob], `${base} (640x360).png`, {
          type: "image/png",
        });
      } finally {
        bitmap.close();
      }
    })();
    normalizedThumbnails.set(file, conversion);
    return conversion;
  }

  function scheduledIsoForReleaseDate(releaseDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(releaseDate || ""))) return "";
    const scheduled = new Date(`${releaseDate}T15:00:00.000Z`);
    return !Number.isNaN(scheduled.getTime()) && scheduled.getUTCDay() === 5
      ? scheduled.toISOString()
      : "";
  }

  const NEUTRAL_TEST_PRESET = "Neutral test (manual)";
  function neutralTestSelection(files) {
    const selected = Array.isArray(files) ? files : [];
    const roles = {
      fullFile: "neutral-full.mp4",
      teaserFile: "neutral-teaser.mp4",
      thumbnailFile: "neutral-thumbnail-valid.png",
    };
    const result = {};
    for (const [role, name] of Object.entries(roles)) {
      const candidates = selected.filter((file) => file.name === name);
      const file = candidates[0];
      if (
        candidates.length !== 1 ||
        file.source !== "development-fixture" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          file.fixtureToken || "",
        ) ||
        !Number.isSafeInteger(file.lastModified) ||
        file.lastModified <= 0 ||
        !Number.isSafeInteger(file.size) ||
        file.filePath ||
        file.path ||
        file.webkitRelativePath ||
        !(role === "thumbnailFile" ? isImageFile(file) : isVideoFile(file))
      )
        throw new Error(
          "Template file is missing or invalid. Check the development fixtures and click Load Template again.",
        );
      result[role] = Object.freeze({
        source: file.source,
        fixtureToken: file.fixtureToken,
        name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      });
    }
    return result;
  }

  function neutralTestProfiles(saved) {
    const profiles = structuredClone(saved);
    profiles.fanslyPrefill = {
      ...profiles.fanslyPrefill,
      message: "",
      toggles: { ...profiles.fanslyPrefill.toggles, "Post to FYP": false },
    };
    profiles.manyvidsAutofill = { ...profiles.manyvidsAutofill, tags: [] };
    profiles.phUploader = {
      presets: {
        [NEUTRAL_TEST_PRESET]: {
          orientation: "Straight",
          tags: [],
          categories: [],
        },
      },
      seriesPresets: {},
    };
    return profiles;
  }

  function profileAuthorizationSummary(profiles = {}, contentPreset = "") {
    const fansly = profiles.fanslyPrefill || {};
    const manyvids = profiles.manyvidsAutofill || {};
    const preset = profiles.phUploader?.presets?.[contentPreset] || {};
    const toggleSummary = Object.entries(fansly.toggles || {})
      .map(([label, enabled]) => `${label}: ${enabled ? "on" : "off"}`)
      .join(" · ");
    return {
      fansly: toggleSummary || "No saved toggle changes",
      manyvids: [
        `co-performer ${manyvids.coPerformer || "unset"}`,
        `price mode ${manyvids.priceModeExpectedLabel || "unset"}`,
        `$${manyvids.price || "unset"}`,
        `launch mode ${manyvids.launchModeExpectedLabel || "unset"}`,
        `time ${manyvids.launchTimeLabel || manyvids.launchTimeValue || "unset"}`,
        `bundle ${manyvids.membershipExpectedLabel || "unset"}`,
        `Premium ${manyvids.premiumExpectedLabel || "unset"}`,
        `tags ${(manyvids.tags || []).join(", ") || "none"}`,
      ].join(" · "),
      pornhub: [
        `orientation ${preset.orientation || "unset"}`,
        `tags ${(preset.tags || []).join(", ") || "none"}`,
        `categories ${(preset.categories || []).join(", ") || "none"}`,
      ].join(" · "),
    };
  }

  function normalizedSeries(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en-US");
  }

  function learnSeriesPresetMap(current, seasonArc, preset) {
    const series = String(seasonArc || "")
      .trim()
      .slice(0, 200);
    const presetName = String(preset || "")
      .trim()
      .slice(0, 100);
    const entries = Object.entries(current || {}).filter(
      ([name]) => normalizedSeries(name) !== normalizedSeries(series),
    );
    if (!series || !presetName) {
      return Object.fromEntries(entries.slice(-100));
    }
    return Object.fromEntries([...entries.slice(-99), [series, presetName]]);
  }

  function normalizeDraft({
    workflowMode = "main",
    publishMode = "manual",
    fullFile,
    teaserFile = null,
    thumbnailFile = null,
    pornhubFile = null,
    title,
    description,
    scheduledIso,
    targets,
    contentPreset = "",
    pornhubMode = "free",
    pornhubCertificationsConfirmed = false,
  } = {}) {
    const errors = [];
    const mainEnabled = workflowMode !== "teaser";
    if (!["main", "teaser", "both"].includes(workflowMode))
      errors.push("Choose a workflow.");
    if (!["manual", "autonomous"].includes(publishMode))
      errors.push("Choose a publishing mode.");
    const selectedTargets =
      mainEnabled && Array.isArray(targets)
        ? [...new Set(targets)].filter((target) => TARGETS.has(target))
        : [];
    const separatePornhubFileIsEnough =
      selectedTargets.length === 1 &&
      selectedTargets[0] === "pornhub" &&
      isVideoFile(pornhubFile);
    if (mainEnabled && !separatePornhubFileIsEnough && !isVideoFile(fullFile)) {
      errors.push("Choose a non-empty full video.");
    }
    if (mainEnabled && teaserFile && !isVideoFile(teaserFile)) {
      errors.push("Choose a non-empty teaser video or leave it blank.");
    }
    if (mainEnabled && thumbnailFile && !isImageFile(thumbnailFile)) {
      errors.push("Choose a PNG or JPEG thumbnail or leave it blank.");
    }
    if (mainEnabled && pornhubFile && !isVideoFile(pornhubFile)) {
      errors.push("Choose a non-empty Pornhub video or leave it blank.");
    }
    const cleanTitle = String(title || "").trim();
    if (mainEnabled && !cleanTitle) errors.push("Enter a catalogue title.");
    const scheduled = new Date(scheduledIso);
    if (
      mainEnabled &&
      (!String(scheduledIso || "").trim() ||
        Number.isNaN(scheduled.getTime()) ||
        scheduled.getUTCDay() !== 5 ||
        scheduled.getUTCHours() !== 15)
    ) {
      errors.push("Choose a Friday; publication time is fixed at 15:00 UTC.");
    }
    if (
      mainEnabled &&
      (!selectedTargets.length || selectedTargets.length !== targets?.length)
    ) {
      errors.push(
        "Choose OnlyFans, Fansly, ManyVids, Pornhub, or a combination.",
      );
    }
    const cleanPreset = String(contentPreset || "").trim();
    if (selectedTargets.includes("pornhub") && !cleanPreset) {
      errors.push("Choose an exact Pornhub content preset.");
    }
    if (
      selectedTargets.includes("pornhub") &&
      !["free", "paid"].includes(pornhubMode)
    )
      errors.push("Choose a supported MainHub video type.");
    return {
      valid: errors.length === 0,
      errors,
      workflowMode,
      publishMode,
      hasTeaser: mainEnabled && isVideoFile(teaserFile),
      title: cleanTitle,
      description: String(description || "").trim(),
      scheduledIso: Number.isNaN(scheduled.getTime())
        ? ""
        : scheduled.toISOString(),
      releaseDate: Number.isNaN(scheduled.getTime())
        ? ""
        : scheduled.toISOString().slice(0, 10),
      targets: selectedTargets,
      contentPreset: cleanPreset,
      pornhubMode,
      pornhubCertificationsConfirmed: pornhubCertificationsConfirmed === true,
      media: {
        ...(selectedTargets.includes("onlyfans")
          ? { onlyfans: { full: fullFile?.name || "" } }
          : {}),
        ...(selectedTargets.includes("fansly")
          ? {
              fansly: {
                full: fullFile?.name || "",
                teaser: teaserFile?.name || null,
              },
            }
          : {}),
        ...(selectedTargets.includes("manyvids")
          ? {
              manyvids: {
                full: fullFile?.name || "",
                teaser: teaserFile?.name || "",
                thumbnail: thumbnailFile?.name || null,
              },
            }
          : {}),
        ...(selectedTargets.includes("pornhub")
          ? {
              pornhub: {
                file: pornhubFile?.name || fullFile?.name || "",
                source: pornhubFile ? "pornhub" : "full",
                thumbnail: thumbnailFile?.name || null,
              },
            }
          : {}),
      },
    };
  }

  function canonicalPaidUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        new Set(["onlyfans.com", "fansly.com", "www.manyvids.com"]).has(
          url.hostname,
        )
        ? url.href
        : "";
    } catch {
      return "";
    }
  }

  function hex(bytes) {
    return [...new Uint8Array(bytes)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  async function sha256(value) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(await value.arrayBuffer());
    return hex(await crypto.subtle.digest("SHA-256", bytes));
  }

  async function buildSocialDistributionPlan({
    id,
    file,
    caption,
    paidLink,
    mode,
    targets,
    subreddits,
    catalogue,
    preparationOnly = false,
    evidence,
    authorizationAt,
  }) {
    const contract = globalThis.CreatorSocialDistributionContract;
    if (!contract)
      throw new Error("The social distribution contract is unavailable.");
    const captionHash = await sha256(caption);
    const socialFile = {
      basename: String(file?.name || ""),
      size: Number(file?.size),
      lastModified: Number(file?.lastModified),
      sha256: await sha256(file),
    };
    const reddit = [];
    for (const item of subreddits || []) {
      const title = item.title || caption;
      reddit.push({
        subreddit: item.subreddit,
        presetId: item.presetId,
        presetRevision: item.presetRevision,
        title: {
          state: title ? "nonempty" : "empty",
          sha256: await sha256(title),
        },
        body: {
          state: item.body ? "nonempty" : "empty",
          sha256: await sha256(item.body || ""),
        },
        flair: item.flair,
        nsfw: item.nsfw === true,
      });
    }
    const plan = {
      id,
      mode,
      ...(preparationOnly ? { preparationOnly: true } : {}),
      catalogue,
      socialFile,
      caption: {
        state: caption ? "nonempty" : "empty",
        sha256: captionHash,
      },
      paidUrl: paidLink?.kind === "url" ? paidLink.url : "",
      ...(paidLink?.kind === "upload-result"
        ? {
            paidLinkSource: paidLink.platform,
            paidUploadSessionId: id,
          }
        : {}),
      targets: {
        x: targets.includes("x"),
        reddit: targets.includes("reddit") ? reddit : [],
      },
      evidence,
      authorization: { at: authorizationAt, sha256: "" },
    };
    plan.authorization.sha256 = await sha256(
      JSON.stringify({ ...plan, authorization: { at: authorizationAt } }),
    );
    return contract.freezeDistributionPlan(plan);
  }

  function normalizeSocialDraft({
    file = null,
    caption = "",
    paidUrl = "",
    paidLinkSource = "",
    mode = "manual",
    targets = [],
    subreddits = [],
    catalogue = null,
    preparationOnly = false,
    evidence = {},
  } = {}) {
    const selectedTargets = Array.isArray(targets)
      ? [...new Set(targets)].filter((target) => SOCIAL_TARGETS.has(target))
      : [];
    const enabled = Boolean(file) || selectedTargets.length > 0;
    if (!enabled) {
      return {
        enabled: false,
        valid: true,
        errors: [],
        caption: "",
        mode: "manual",
        targets: [],
        paidLink: null,
        subreddits: [],
      };
    }

    const errors = [];
    if (!isVideoFile(file))
      errors.push("Choose a non-empty social teaser video.");
    if (!selectedTargets.length || selectedTargets.length !== targets.length) {
      errors.push("Choose X, Reddit, or both for the social teaser.");
    }
    const cleanCaption = String(caption || "")
      .trim()
      .slice(0, 5001);
    if (!cleanCaption) errors.push("Enter the social caption.");
    if (selectedTargets.includes("x") && cleanCaption.length > X_CAPTION_MAX) {
      errors.push(`Keep the X caption at ${X_CAPTION_MAX} characters or less.`);
    }
    const normalizedMode = new Set(["manual", "autonomous"]).has(mode)
      ? mode
      : "manual";
    if (normalizedMode !== mode)
      errors.push("Choose a social publishing mode.");
    if (
      preparationOnly &&
      (mode !== "manual" || !selectedTargets.includes("reddit"))
    )
      errors.push("Reddit draft preparation must stay manual.");
    if (
      catalogue !== null &&
      (!Number.isInteger(Number(catalogue?.row)) ||
        Number(catalogue?.row) < 2 ||
        !String(catalogue?.id || "").trim() ||
        !String(catalogue?.title || "").trim() ||
        !/^[a-f0-9]{8,64}$/i.test(String(catalogue?.fingerprint || "")))
    ) {
      errors.push("Confirm one exact catalogue episode first.");
    }

    let paidLink = null;
    if (selectedTargets.includes("x")) {
      const source = String(paidLinkSource || "").trim();
      const url = canonicalPaidUrl(paidUrl);
      if (PAID_LINK_SOURCES.has(source)) {
        paidLink = { kind: "upload-result", platform: source };
      } else if (url) {
        paidLink = { kind: "url", url };
      } else {
        errors.push("Choose the paid-video link for the first X reply.");
      }
    }

    const normalizedSubreddits = (Array.isArray(subreddits) ? subreddits : [])
      .map((item) => ({
        subreddit: String(item?.subreddit || "")
          .trim()
          .replace(/^r\//i, "")
          .slice(0, 21),
        presetId: String(item?.presetId || "")
          .trim()
          .slice(0, 101),
        presetRevision: String(item?.presetRevision || "")
          .trim()
          .toLowerCase()
          .slice(0, 65),
        status: String(item?.status || "Needs review").slice(0, 30),
        title: String(item?.title || "")
          .trim()
          .slice(0, REDDIT_TITLE_MAX + 1),
        body: String(item?.body || "")
          .trim()
          .slice(0, 10_001),
        flair: String(item?.flair || "")
          .trim()
          .slice(0, 101),
        nsfw: item?.nsfw === true,
      }))
      .filter((item) => /^[A-Za-z0-9_]{2,21}$/.test(item.subreddit));
    for (const item of normalizedSubreddits) {
      if (
        !PRESET_ID.test(item.presetId) ||
        !PRESET_REVISION.test(item.presetRevision)
      ) {
        errors.push(`Refresh the preset for r/${item.subreddit}.`);
      }
      if ((item.title || cleanCaption).length > REDDIT_TITLE_MAX) {
        errors.push(
          `Keep the Reddit title for r/${item.subreddit} at ${REDDIT_TITLE_MAX} characters or less.`,
        );
      }
      if (item.body.length > 10_000) {
        errors.push(
          `Keep the Reddit body for r/${item.subreddit} at 10000 characters or less.`,
        );
      }
      if (item.flair.length > 100) {
        errors.push(
          `Keep the Reddit flair for r/${item.subreddit} at 100 characters or less.`,
        );
      }
    }
    if (selectedTargets.includes("reddit") && !normalizedSubreddits.length) {
      errors.push("Choose at least one subreddit.");
    }
    if (
      normalizedMode === "autonomous" &&
      normalizedSubreddits.some((item) => item.status !== "Approved")
    ) {
      errors.push("Only Approved subreddit presets can run autonomously.");
    }

    const missingEvidence = [];
    if (selectedTargets.includes("x") && !TRACE_HASH.test(evidence?.x || "")) {
      missingEvidence.push("X");
    }
    if (selectedTargets.includes("reddit") && !preparationOnly) {
      if (!TRACE_HASH.test(evidence?.redgifs || "")) {
        missingEvidence.push("Redgifs");
      }
      if (!TRACE_HASH.test(evidence?.reddit || "")) {
        missingEvidence.push("Reddit");
      }
    }
    if (missingEvidence.length) {
      errors.push(
        `Record successful ${missingEvidence.join(", ")} flows before authorizing social publishing.`,
      );
    }

    return {
      enabled,
      valid: errors.length === 0,
      errors,
      caption: cleanCaption,
      mode: normalizedMode,
      ...(preparationOnly ? { preparationOnly: true } : {}),
      targets: selectedTargets,
      paidLink,
      subreddits: normalizedSubreddits,
    };
  }

  function validateDraft({
    file,
    teaserFile = null,
    thumbnailFile = null,
    title,
    scheduledAt,
    targets,
  } = {}) {
    const scheduled = new Date(scheduledAt);
    const normalized = normalizeDraft({
      fullFile: file,
      teaserFile,
      thumbnailFile,
      title,
      description: "",
      scheduledIso: Number.isNaN(scheduled.getTime())
        ? ""
        : scheduled.toISOString(),
      targets,
    });
    const errors = normalized.errors.map((error) =>
      error === "Choose a non-empty full video."
        ? "Choose a non-empty video file."
        : error === "Enter a catalogue title."
          ? "Enter a title."
          : error.startsWith("Choose a Friday")
            ? "Choose a valid publication date and time."
            : error,
    );
    return { valid: errors.length === 0, errors };
  }

  function titleFromFilename(name) {
    return String(name || "")
      .replace(/\.(?:mp4|m4v|mov|webm|avi|mkv)$/i, "")
      .replace(/\s*\((?:full|limited|teaser)\)\s*$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function proposalSignature(proposal) {
    const executable = proposal?.targets?.executable || [];
    const candidate = proposal?.candidate || {};
    return JSON.stringify({
      candidate: {
        row: candidate.row,
        id: candidate.id || "",
        releaseDate: candidate.releaseDate || "",
        title: candidate.title || "",
        description: candidate.description || "",
        seasonArc: candidate.seasonArc || "",
        episode: candidate.episode || "",
        pornhubLink: candidate.pornhubLink || "",
        onlyfansLink: candidate.onlyfansLink || "",
        fanslyLink: candidate.fanslyLink || "",
        manyvidsLink: candidate.manyvidsLink || "",
        fingerprint: candidate.fingerprint || "",
      },
      executable,
      schedules: executable.map((platform) => ({
        platform,
        releaseDate: proposal?.schedules?.[platform]?.releaseDate || "",
        verified: proposal?.schedules?.[platform]?.verified === true,
      })),
    });
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(
            Object.assign(new Error(chrome.runtime.lastError.message), {
              uploadAdmission: chrome.runtime.lastError.uploadAdmission,
            }),
          );
          return;
        }
        if (!response?.ok) {
          reject(
            Object.assign(
              new Error(response?.error || "Extension request failed."),
              {
                rejectionCode: response?.rejectionCode,
                uploadAdmission: response?.uploadAdmission,
                recoveryRequired: response?.recoveryRequired === true,
              },
            ),
          );
          return;
        }
        resolve(response);
      });
    });
  }

  function mount() {
    const get = (selector) => document.querySelector(selector);
    const workflowMode = get("#workflowMode");
    // Preserve the main/teaser/both state contract while native radios provide
    // labels, arrow-key navigation and fieldset disabled semantics.
    if (workflowMode?.tagName === "FIELDSET")
      Object.defineProperty(workflowMode, "value", {
        get: () => workflowMode.querySelector("input:checked")?.value || "main",
        set: (value) => {
          for (const radio of workflowMode.querySelectorAll("input"))
            radio.checked = radio.value === value;
        },
      });
    const mainPublishMode = get("#mainPublishMode");
    const catalogueAssociation = get("#catalogueAssociation");
    const fullInput = get("#uploadFullVideo");
    const teaserInput = get("#uploadTeaser");
    const thumbnailInput = get("#uploadManyvidsThumbnail");
    const catalogueThumbnails = get("#catalogueThumbnails");
    const loadCatalogueThumbnails = get("#loadCatalogueThumbnails");
    const catalogueThumbnailStatus = get("#catalogueThumbnailStatus");
    const catalogueThumbnailChoices = get("#catalogueThumbnailChoices");
    const catalogueThumbnailHint = get("#catalogueThumbnailHint");
    const pornhubInput = get("#uploadPornhubVideo");
    const contentPreset = get("#contentPreset");
    const pornhubVideoType = get("#pornhubVideoType");
    const pornhubCertificationsConfirmed = get(
      "#pornhubCertificationsConfirmed",
    );
    const title = get("#uploadTitle");
    const description = get("#uploadDescription");
    const releaseDate = get("#releaseDate");
    const releaseSummary = get("#releaseTimeSummary");
    const onlyfans = get("#targetOnlyfans");
    const fansly = get("#targetFansly");
    const manyvids = get("#targetManyvids");
    const pornhub = get("#targetPornhub");
    const errors = get("#draftErrors");
    const matchStatus = get("#matchStatus");
    const continueWithoutSheet = get("#continueWithoutSheet");
    const cataloguePicker = get("#cataloguePicker");
    const catalogueSearch = get("#catalogueSearch");
    const catalogueRow = get("#catalogueRow");
    const catalogueCards = get("#catalogueCards");
    const showMoreCatalogue = get("#showMoreCatalogue");
    const showAllCatalogue = get("#showAllCatalogue");
    const refreshCatalogue = get("#refreshCatalogue");
    const selectedCatalogueReason = get("#selectedCatalogueReason");
    const pornhubRecommendation = get("#pornhubRecommendation");
    const socialInput = get("#uploadSocialTeaser");
    const socialCaption = get("#socialCaption");
    const socialX = get("#targetSocialX");
    const socialReddit = get("#targetSocialReddit");
    const socialPaidLinkFields = get("#socialPaidLinkFields");
    const socialPaidLink = get("#socialPaidLink");
    const socialCustomPaidLinkField = get("#socialCustomPaidLinkField");
    const socialCustomPaidLink = get("#socialCustomPaidLink");
    const subredditFields = get("#subredditFields");
    const subredditStatus = get("#subredditStatus");
    const subredditList = get("#subredditList");
    const subredditSearch = get("#subredditSearch");
    const refreshSubreddits = get("#refreshSubreddits");
    const socialErrors = get("#socialErrors");
    const socialTraceStatus = get("#socialTraceStatus");
    const uploadButton = get("#uploadButton");
    const uploadError = get("#uploadError");
    const catalogueSelectionStatus = get("#catalogueSelectionStatus");
    const changeCatalogueEntry = get("#changeCatalogueEntry");
    const runNotice = get("#runNotice");
    const reviewRecovery = get("#reviewRecovery");
    const refreshReadiness = get("#refreshReadiness");
    const results = get("#results");
    const workspaceTabs = get("#workspaceTabs");
    const uploaderTab = get("#uploaderTab");
    const settingsTab = get("#settingsTab");
    const uploaderPanel = get("#uploaderPanel");
    const settingsPanel = get("#settingsPanel");
    const workflowSettingsForm = get("#workflowSettingsForm");
    const workflowSettingsStatus = get("#workflowSettingsStatus");
    const workflowProfilesInput = get("#workflowProfiles");
    const saveWorkflowSettingsButton = get("#saveWorkflowSettings");
    const resetWorkflowProfilesButton = get("#resetWorkflowProfiles");
    const clearWorkflowHistoryButton = get("#clearWorkflowHistory");
    const workflowHistory = get("#workflowHistory");
    const activeHelperCount = get("#activeHelperCount");
    const creatorRegistry = globalThis.CreatorToolkitRegistry;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const initialSchedule = nextFridayUtc(new Date(), timeZone);
    let fullFile = null;
    let teaserFile = null;
    let thumbnailFile = null;
    let thumbnailCatalogueId = null;
    let thumbnailChoicesRevision = 0;
    let thumbnailChoices = null;
    let autoThumbnailAssetId = null;
    let pornhubFile = null;
    let socialFile = null;
    let matchTimer = null;
    let matchRevision = 0;
    let currentMatch = null;
    let currentProposal = null;
    let currentSnapshot = null;
    let snapshotPromise = null;
    let selectedCatalogueRow = null;
    let catalogueCardLimit = 18;
    let catalogueCardRevision = 0;
    let cataloguePreviewTimer = null;
    const cataloguePreviewCache = new Map();
    let manualTargets = null;
    let uploadWithoutSheet = catalogueAssociation?.value === "later";
    let activeSession = null;
    let resumable = null;
    let runBusy = false;
    let readiness = null;
    let readinessRevision = 0;
    const lockedControls = new Map();
    let lastAttempt = null;
    let optionalSelectionCount = 0;
    let socialPollTimer = null;
    let workflowProfiles = null;
    let profilesLoaded = false;
    let neutralTestMode = false;
    let neutralTestFiles = null;
    let templateRevision = 0;
    document.addEventListener("input", () => {
      templateRevision++;
    });
    let subredditSnapshot = null;
    let subredditLoadPromise = null;
    let lastSubredditSelection = [];
    const subredditSelectionPromise = chrome.storage.local
      .get("creatorSocialSubredditSelectionV1")
      .then((stored) => {
        lastSubredditSelection = Array.isArray(
          stored.creatorSocialSubredditSelectionV1,
        )
          ? stored.creatorSocialSubredditSelectionV1
              .map((name) => String(name).toLowerCase())
              .slice(0, 100)
          : [];
      });
    const platformStates = new Map();
    const workflowControls = Object.fromEntries(
      Object.entries(WORKFLOW_TOOL_CONTROLS).map(([id, selector]) => [
        id,
        get(selector),
      ]),
    );

    releaseDate.value = initialSchedule.releaseDate;

    function selectWorkspaceTab(nextTab, focus = false) {
      const showSettings = nextTab === settingsTab;
      get("#uploadActions").hidden = showSettings;
      for (const [tab, panel, selected] of [
        [uploaderTab, uploaderPanel, !showSettings],
        [settingsTab, settingsPanel, showSettings],
      ]) {
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panel.hidden = !selected;
      }
      if (focus) nextTab.focus();
    }

    function handleWorkspaceTabKey(event) {
      const tabs = [uploaderTab, settingsTab];
      const current = tabs.indexOf(event.currentTarget);
      let next = current;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      else if (event.key === "ArrowLeft") {
        next = (current - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectWorkspaceTab(tabs[next], true);
    }

    function updateActiveHelperCount() {
      const active = Object.values(workflowControls).filter(
        (control) => control.checked,
      ).length;
      activeHelperCount.textContent = `${active} active`;
    }

    function showWorkflowSettingsStatus(message, state = "saved") {
      workflowSettingsStatus.textContent = message;
      workflowSettingsStatus.dataset.state = state;
    }

    function markWorkflowSettingsDirty() {
      updateActiveHelperCount();
      showWorkflowSettingsStatus(
        "Unsaved changes. Save to update active site helpers and upload recipes.",
        "dirty",
      );
    }

    function renderWorkflowHistory(history) {
      workflowHistory.replaceChildren();
      const entries = Array.isArray(history) ? history.slice(0, 50) : [];
      for (const entry of entries) {
        const row = document.createElement("li");
        const time = entry.timestamp
          ? new Date(entry.timestamp).toLocaleString()
          : "unknown time";
        row.textContent = `${time} · ${entry.toolId || "unknown tool"} · ${entry.status || "unknown"} · ${entry.summary || "no summary"}`;
        workflowHistory.append(row);
      }
      if (!entries.length) {
        const row = document.createElement("li");
        row.textContent = "No workflow actions have been recorded.";
        workflowHistory.append(row);
      }
    }

    function workflowSettingsFromForm() {
      let profiles;
      try {
        profiles = JSON.parse(workflowProfilesInput.value);
      } catch (error) {
        throw new Error(`Workflow profile JSON is invalid: ${error.message}`, {
          cause: error,
        });
      }
      const tools = Object.fromEntries(
        Object.entries(workflowControls).map(([id, control]) => [
          id,
          {
            enabled: control.checked,
            autorun: id === "redditBannerCensor" && control.checked,
          },
        ]),
      );
      const normalized = creatorRegistry.normalizeSettings({
        schemaVersion: creatorRegistry.SCHEMA_VERSION,
        tools,
        profiles,
      });
      if (normalized.errors.length) {
        throw new Error(normalized.errors.join(" "));
      }
      return normalized.value;
    }

    async function loadWorkflowSettingsPanel() {
      let settings;
      for (;;) {
        try {
          settings = await globalThis.CreatorToolkit.loadSettings();
          break;
        } catch (error) {
          if (!globalThis.OFEnhancerDesktopUpload) throw error;
          showWorkflowSettingsStatus(
            "Waiting for Chrome to load workflow profiles…",
            "loading",
          );
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Number(globalThis.CreatorWorkflowProfileRetryDelayMs) || 1000,
            ),
          );
        }
      }
      for (const [id, control] of Object.entries(workflowControls)) {
        control.checked = settings.tools[id]?.enabled === true;
      }
      workflowProfilesInput.value = JSON.stringify(settings.profiles, null, 2);
      workflowProfiles = settings.profiles;
      profilesLoaded = true;
      const stored = await chrome.storage.local.get(
        creatorRegistry.ACTION_LOG_KEY,
      );
      renderWorkflowHistory(stored[creatorRegistry.ACTION_LOG_KEY]);
      updateActiveHelperCount();
      showWorkflowSettingsStatus(
        "All changes are saved. Enabled helpers are available on matching sites.",
      );
      return settings;
    }

    async function saveWorkflowSettingsPanel() {
      saveWorkflowSettingsButton.disabled = true;
      showWorkflowSettingsStatus("Saving helper settings…", "loading");
      try {
        const settings = await globalThis.CreatorToolkit.saveSettings(
          workflowSettingsFromForm(),
        );
        const response = await sendMessage({ type: "SYNC_CREATOR_TOOLS" });
        workflowProfilesInput.value = JSON.stringify(
          settings.profiles,
          null,
          2,
        );
        workflowProfiles = settings.profiles;
        profilesLoaded = true;
        updateActiveHelperCount();
        invalidateMatch();
        scheduleMatch();
        const skipped = response.creatorTools?.skipped || [];
        showWorkflowSettingsStatus(
          skipped.length
            ? `Helper settings saved, but ${skipped.length} site registration${skipped.length === 1 ? " is" : "s are"} unavailable. Check Chrome site access, then reload that site.`
            : "Helper settings saved. Active site helpers and upload recipes are updated.",
          skipped.length ? "error" : "saved",
        );
      } catch (error) {
        showWorkflowSettingsStatus(error.message, "error");
      } finally {
        saveWorkflowSettingsButton.disabled = false;
      }
    }

    function resetWorkflowProfiles() {
      workflowProfilesInput.value = JSON.stringify(
        creatorRegistry.DEFAULT_PROFILES,
        null,
        2,
      );
      markWorkflowSettingsDirty();
    }

    async function clearWorkflowHistory() {
      await chrome.storage.local.set({
        [creatorRegistry.ACTION_LOG_KEY]: [],
      });
      renderWorkflowHistory([]);
      showWorkflowSettingsStatus("Local workflow history cleared.");
    }

    function selectedTargets() {
      if (workflowMode?.value === "teaser") return [];
      return [
        onlyfans.checked ? "onlyfans" : "",
        fansly.checked ? "fansly" : "",
        manyvids.checked ? "manyvids" : "",
        pornhub.checked ? "pornhub" : "",
      ].filter(Boolean);
    }

    function selectedSocialTargets() {
      if (workflowMode?.value === "main") return [];
      return [
        socialX.checked ? "x" : "",
        socialReddit.checked ? "reddit" : "",
      ].filter(Boolean);
    }

    function selectedSocialMode() {
      return get('input[name="socialMode"]:checked')?.value || "manual";
    }

    function selectedRunTargets() {
      return [
        ...new Set([
          ...selectedTargets(),
          ...selectedSocialTargets().filter((target) => target === "x"),
          ...platformStates.keys(),
        ]),
      ];
    }

    function socialEvidence() {
      const value = globalThis.CreatorSocialTraceEvidence || {};
      return {
        x: String(value.x || ""),
        redgifs: String(value.redgifs || ""),
        reddit: String(value.reddit || ""),
      };
    }

    function currentPaidLink() {
      const selected = socialPaidLink.value;
      if (selected.startsWith("run:")) {
        return { paidUrl: "", paidLinkSource: selected.slice(4) };
      }
      if (selected === "custom") {
        return { paidUrl: socialCustomPaidLink.value, paidLinkSource: "" };
      }
      return { paidUrl: selected, paidLinkSource: "" };
    }

    function selectedSubreddits() {
      return [...subredditList.querySelectorAll(".subreddit-preset")]
        .filter((row) => row.querySelector('input[type="checkbox"]').checked)
        .map((row) => ({
          subreddit: row.dataset.name,
          presetId: row.dataset.presetId,
          presetRevision: row.dataset.presetRevision,
          status: row.dataset.status,
          title: row.querySelector('[data-field="title"]').value,
          body: row.querySelector('[data-field="body"]').value,
          flair: row.querySelector('[data-field="flair"]').value,
          nsfw: row.querySelector('[data-field="nsfw"]').checked,
        }));
    }

    function socialDraft(candidate = currentMatch?.candidate || null) {
      if (workflowMode?.value === "main") return normalizeSocialDraft();
      const paid = currentPaidLink();
      const readiness = globalThis.CreatorSocialDistributionRuntimeReady;
      const preparationOnly =
        selectedSocialMode() === "manual" &&
        selectedSocialTargets().includes("reddit") &&
        readiness?.redditDrafts === true &&
        readiness?.redgifsDrafts === true;
      const value = normalizeSocialDraft({
        file: socialFile,
        caption: socialCaption.value,
        paidUrl: paid.paidUrl,
        paidLinkSource: paid.paidLinkSource,
        mode: selectedSocialMode(),
        targets: selectedSocialTargets(),
        subreddits: selectedSubreddits(),
        catalogue: uploadWithoutSheet ? null : candidate,
        preparationOnly,
        evidence: socialEvidence(),
      });
      if (!value.enabled && ["teaser", "both"].includes(workflowMode?.value)) {
        value.enabled = true;
        value.valid = false;
        value.errors.push(
          "Choose a social teaser and at least one destination.",
        );
      }
      const runtimeReady =
        readiness === true ||
        (Boolean(readiness) &&
          (!value.targets.includes("x") || readiness.x === true) &&
          (!value.targets.includes("reddit") ||
            (value.preparationOnly
              ? readiness.redgifsDrafts === true &&
                readiness.redditDrafts === true
              : readiness.redgifs === true && readiness.reddit === true)));
      if (value.enabled && !runtimeReady) {
        value.errors.push(
          "Trace-derived social publishing adapters are not installed yet.",
        );
        value.valid = false;
      }
      return value;
    }

    function addPaidLinkOption(value, label) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      socialPaidLink.append(option);
    }

    function renderPaidLinkOptions(candidate = currentMatch?.candidate || {}) {
      const previous = socialPaidLink.value;
      socialPaidLink.replaceChildren();
      addPaidLinkOption("", "Choose the paid-video link");
      for (const [platform, label] of [
        ["onlyfans", "OnlyFans"],
        ["fansly", "Fansly"],
        ["manyvids", "ManyVids"],
      ]) {
        const url = catalogueLink(candidate, platform);
        if (url) addPaidLinkOption(url, `${label} · existing catalogue link`);
        else if (selectedTargets().includes(platform)) {
          addPaidLinkOption(
            `run:${platform}`,
            `${label} · use the new link from this upload`,
          );
        }
      }
      addPaidLinkOption("custom", "Use a custom paid-video URL");
      const available = [...socialPaidLink.options].map(
        (option) => option.value,
      );
      if (previous && available.includes(previous)) {
        socialPaidLink.value = previous;
      } else {
        socialPaidLink.value = available.find((value) => value) || "";
      }
      socialCustomPaidLinkField.hidden = socialPaidLink.value !== "custom";
    }

    function presetRow(preset) {
      const row = document.createElement("div");
      row.className = "subreddit-preset";
      row.dataset.name = preset.subreddit;
      row.dataset.presetId = preset.id;
      row.dataset.presetRevision = preset.revision;
      row.dataset.status = preset.status;
      row.dataset.search = [preset.subreddit, preset.status, preset.notes]
        .join(" ")
        .toLowerCase();

      const choice = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "socialSubreddits";
      checkbox.dataset.subreddit = preset.subreddit.toLowerCase();
      checkbox.checked =
        preset.status !== "Rejected" &&
        lastSubredditSelection.includes(preset.subreddit.toLowerCase());
      const summary = document.createElement("span");
      summary.className = "subreddit-preset-summary";
      const name = document.createElement("strong");
      name.textContent = preset.subreddit;
      const details = document.createElement("small");
      details.textContent = [
        preset.readiness === "ready"
          ? "Suggested · Ready"
          : preset.rawStatus || preset.status,
        preset.notes,
      ]
        .filter(Boolean)
        .join(" · ");
      summary.append(name, details);
      choice.append(checkbox, summary);

      const overrides = document.createElement("div");
      overrides.className = "subreddit-overrides";
      overrides.hidden = !checkbox.checked;
      const fieldPrefix = `subreddit-${preset.subreddit.toLowerCase()}`;
      overrides.innerHTML = `
        <label>Title override<input data-field="title" name="${fieldPrefix}-title" type="text" maxlength="300" autocomplete="off" placeholder="Use the social caption…" /></label>
        <label>Flair<input data-field="flair" name="${fieldPrefix}-flair" type="text" maxlength="100" autocomplete="off" placeholder="Optional flair…" /></label>
        <label class="body-field">Body<textarea data-field="body" name="${fieldPrefix}-body" rows="3" maxlength="10000" autocomplete="off" placeholder="Optional body text…"></textarea></label>
        <label class="nsfw-toggle"><input data-field="nsfw" name="${fieldPrefix}-nsfw" type="checkbox" checked /> Mark NSFW</label>
      `;
      checkbox.addEventListener("change", async () => {
        overrides.hidden = !checkbox.checked;
        lastSubredditSelection = [
          ...subredditList.querySelectorAll(
            '.subreddit-preset input[type="checkbox"]:checked',
          ),
        ].map((input) => input.dataset.subreddit);
        await chrome.storage.local.set({
          creatorSocialSubredditSelectionV1: lastSubredditSelection,
        });
        refreshSocialReview();
      });
      for (const control of overrides.querySelectorAll("input, textarea")) {
        control.addEventListener("input", refreshSocialReview);
        control.addEventListener("change", refreshSocialReview);
      }
      row.append(choice, overrides);
      return row;
    }

    function renderSubredditPresets() {
      subredditList.replaceChildren();
      const presets =
        globalThis.CreatorSubredditPresets.rankReady(subredditSnapshot);
      if (!presets.length) {
        subredditStatus.textContent =
          "No subreddit presets are available in the connected catalogue.";
        return;
      }
      for (const preset of presets) {
        const row = presetRow(preset);
        subredditList.append(row);
      }
      applyPresetMode();
    }

    function applyPresetMode() {
      const autonomous = selectedSocialMode() === "autonomous";
      for (const row of subredditList.querySelectorAll(".subreddit-preset")) {
        row.querySelector('input[type="checkbox"]').disabled =
          row.dataset.status === "Rejected" ||
          (autonomous && row.dataset.status !== "Approved");
      }
      filterSubredditPresets();
    }

    function filterSubredditPresets() {
      const query = subredditSearch.value.trim().toLowerCase();
      const rows = [...subredditList.querySelectorAll(".subreddit-preset")];
      let shown = 0;
      for (const row of rows) {
        row.hidden = Boolean(query) && !row.dataset.search.includes(query);
        if (!row.hidden) shown += 1;
      }
      if (!rows.length) return;
      const autonomous = selectedSocialMode() === "autonomous";
      subredditStatus.textContent = `${query ? `${shown} of ` : ""}${rows.length} preset${rows.length === 1 ? "" : "s"} ${query ? "shown" : "loaded"}. ${autonomous ? "Only Approved presets are selectable." : "Review-only presets remain available for manual confirmation."}`;
    }

    async function loadSubredditPresets({ refresh = false } = {}) {
      if (refresh) subredditLoadPromise = null;
      subredditStatus.textContent = "Loading subreddit presets…";
      try {
        const client = globalThis.CreatorCatalogueClient;
        if (!client?.getSubredditPresetSnapshot) {
          throw new Error("The subreddit preset bridge is unavailable.");
        }
        await subredditSelectionPromise;
        subredditLoadPromise ||= client.getSubredditPresetSnapshot();
        const response = await subredditLoadPromise;
        subredditSnapshot =
          globalThis.CreatorSubredditPresets.normalizeSnapshot(response.rows);
        renderSubredditPresets();
        refreshSocialReview();
      } catch (error) {
        subredditStatus.textContent = `${error.message} Use Refresh list after reconnecting the catalogue bridge.`;
      }
    }

    async function recheckSubredditPresets(social) {
      if (!social.targets.includes("reddit")) return;
      const client = globalThis.CreatorCatalogueClient;
      if (!client?.getSubredditPresetSnapshot) {
        throw new Error("The subreddit preset bridge is unavailable.");
      }
      const response = await client.getSubredditPresetSnapshot();
      const refreshed = globalThis.CreatorSubredditPresets.normalizeSnapshot(
        response.rows,
      );
      const byName = new Map(
        refreshed.presets.map((preset) => [
          preset.subreddit.toLowerCase(),
          preset,
        ]),
      );
      const changed = social.subreddits.some((selected) => {
        const current = byName.get(selected.subreddit.toLowerCase());
        return (
          !current ||
          current.id !== selected.presetId ||
          current.revision !== selected.presetRevision ||
          current.status !== selected.status ||
          (social.mode === "autonomous" && current.status !== "Approved")
        );
      });
      if (!changed) return;
      subredditSnapshot = refreshed;
      subredditLoadPromise = Promise.resolve(response);
      renderSubredditPresets();
      refreshSocialReview();
      throw new Error(
        "Subreddit presets changed. Review the refreshed settings and click Upload again.",
      );
    }

    function refreshSocialReview() {
      socialPaidLinkFields.hidden = !socialX.checked;
      subredditFields.hidden = !socialReddit.checked;
      renderPaidLinkOptions(currentMatch?.candidate || {});
      if (socialReddit.checked && !subredditSnapshot && !subredditLoadPromise) {
        void loadSubredditPresets();
      }
      const value = socialDraft();
      socialErrors.textContent = value.enabled ? value.errors.join(" ") : "";
      const missingTrace = value.errors.find((error) =>
        error.startsWith("Record successful"),
      );
      const missingRuntime = value.errors.find((error) =>
        error.startsWith("Trace-derived"),
      );
      socialTraceStatus.textContent = !value.enabled
        ? "Select X or Reddit to check recorded-flow evidence."
        : missingTrace ||
          missingRuntime ||
          "Recorded-flow evidence is ready. Upload authorizes the selected social mode.";
      if (currentMatch) renderMatch(currentMatch);
    }

    function catalogueLink(candidate, platform) {
      return String(candidate?.[`${platform}Link`] || "").trim();
    }

    function pendingTargets(value, match = currentMatch) {
      return value.targets.filter(
        (platform) =>
          !catalogueLink(match?.candidate, platform) &&
          match?.candidate?.publicationState?.[platform] !== "review" &&
          match?.candidate?.publicationState?.[platform] !== "published",
      );
    }

    function draft() {
      const value = normalizeDraft({
        workflowMode: workflowMode?.value || "both",
        publishMode: neutralTestMode
          ? "manual"
          : mainPublishMode?.value || "manual",
        fullFile,
        teaserFile,
        thumbnailFile,
        pornhubFile,
        title:
          workflowMode?.value === "teaser"
            ? socialCaption.value.trim().split("\n")[0] ||
              titleFromFilename(socialFile?.name || "Social teaser")
            : title.value,
        description: description.value,
        scheduledIso: scheduledIsoForReleaseDate(releaseDate.value),
        targets: selectedTargets(),
        contentPreset: contentPreset.value,
        pornhubMode: pornhubVideoType.value,
        pornhubCertificationsConfirmed: pornhubCertificationsConfirmed.checked,
      });
      if (
        workflowMode?.value === "both" &&
        !value.targets.length &&
        selectedSocialTargets().length
      ) {
        value.errors = value.errors.filter(
          (error) =>
            error !==
            "Choose OnlyFans, Fansly, ManyVids, Pornhub, or a combination.",
        );
        value.valid = value.errors.length === 0;
      }
      if (!profilesLoaded || !workflowProfiles) {
        value.errors.push("Workflow profiles are still loading.");
        value.valid = false;
        return value;
      }
      const profiles = profilesForDraft();
      if (
        value.targets.includes("pornhub") &&
        !Object.hasOwn(profiles.phUploader.presets, value.contentPreset)
      ) {
        value.errors.push(
          "The selected Pornhub content preset is unavailable.",
        );
        value.valid = false;
      }
      if (value.targets.includes("pornhub") && value.pornhubMode === "paid") {
        const price = Number(profiles.manyvidsAutofill.price);
        const tags = profiles.phUploader.presets[value.contentPreset]?.tags;
        if (!Number.isFinite(price) || price <= 0) {
          value.errors.push(
            "Pay To View needs a positive saved ManyVids price.",
          );
          value.valid = false;
        }
        if (!Array.isArray(tags) || tags.length < 2) {
          value.errors.push(
            "Pay To View needs at least two saved preset tags.",
          );
          value.valid = false;
        }
      }
      value.fanslyCaption =
        globalThis.CreatorToolkitAdapters?.fanslyPrefill?.composeMasterCaption(
          value.description,
          profiles.fanslyPrefill.message,
        ) ?? value.description;
      value.profiles = profiles;
      return value;
    }

    function profilesForDraft() {
      const profiles = {
        fanslyPrefill: structuredClone(workflowProfiles.fanslyPrefill),
        manyvidsAutofill: structuredClone(workflowProfiles.manyvidsAutofill),
        phUploader: structuredClone(workflowProfiles.phUploader),
      };
      return neutralTestMode ? neutralTestProfiles(profiles) : profiles;
    }

    async function refreshProfiles() {
      const settings = await globalThis.CreatorToolkit.loadSettings();
      workflowProfiles = settings.profiles;
      profilesLoaded = true;
      return JSON.stringify(profilesForDraft());
    }

    function refreshReleaseSummary() {
      const iso = scheduledIsoForReleaseDate(releaseDate.value);
      if (!iso) {
        releaseSummary.textContent =
          "Choose a Friday. Time is fixed at 15:00 UTC.";
        return;
      }
      const local = localDateTimeValue(new Date(iso), timeZone).replace(
        "T",
        " ",
      );
      releaseSummary.textContent = `15:00 UTC · ${local} ${timeZone}`;
    }

    function fileSummary(file, emptyText) {
      return file ? file.name : emptyText;
    }

    function showCatalogueThumbnailPicker(match) {
      const id =
        match?.status === "matched" &&
        workflowMode.value !== "teaser" &&
        !get("#optionalMedia").hidden &&
        !thumbnailInput.closest("[data-media-for]").hidden
          ? match.candidate?.id
          : null;
      catalogueThumbnails.hidden = !id;
      if (!id) {
        catalogueThumbnailHint.textContent = "";
        return;
      }
      if (thumbnailCatalogueId === id) {
        catalogueThumbnailHint.textContent = thumbnailChoices?.length
          ? ` · ${thumbnailChoices.length} named thumbnails`
          : "";
        return;
      }
      if (
        thumbnailFile?.source === "catalogue-thumbnail" &&
        thumbnailFile.catalogueId !== id
      ) {
        thumbnailFile = null;
        autoThumbnailAssetId = null;
        renderFilePickers();
      }
      thumbnailCatalogueId = id;
      thumbnailChoices = null;
      catalogueThumbnailHint.textContent = "";
      catalogueThumbnailChoices.replaceChildren();
      catalogueThumbnailStatus.textContent = "Looking for named thumbnails…";
      void loadThumbnailChoices(id);
    }

    async function loadThumbnailChoices(id, refresh = false) {
      const revision = ++thumbnailChoicesRevision;
      loadCatalogueThumbnails.disabled = true;
      try {
        const { result } = await sendMessage({
          type: "OFENHANCER_APP_REQUEST",
          operation: "getUploadThumbnailOptions",
          payload: { catalogueId: id, refresh },
        });
        if (
          revision !== thumbnailChoicesRevision ||
          thumbnailCatalogueId !== id
        )
          return;
        thumbnailChoices = result.choices || [];
        if (
          autoThumbnailAssetId &&
          (thumbnailChoices.length !== 1 ||
            thumbnailChoices[0].assetId !== autoThumbnailAssetId)
        ) {
          if (thumbnailFile?.assetId === autoThumbnailAssetId) {
            thumbnailFile = null;
            renderFilePickers();
          }
          autoThumbnailAssetId = null;
        }
        catalogueThumbnailHint.textContent = thumbnailChoices.length
          ? ` · ${thumbnailChoices.length} named thumbnails`
          : "";
        catalogueThumbnailChoices.replaceChildren();
        if (!result.configured) {
          catalogueThumbnailStatus.textContent =
            "Set a thumbnail folder in the desktop Catalogue to use named thumbnails.";
          return;
        }
        if (!thumbnailChoices.length) {
          catalogueThumbnailStatus.textContent =
            "No named thumbnails found for this catalogue ID. You can choose a file above.";
          return;
        }
        if (
          thumbnailChoices.length === 1 &&
          !thumbnailFile &&
          !activeSession &&
          !runBusy
        ) {
          const choice = thumbnailChoices[0];
          thumbnailFile = {
            name: choice.name,
            size: choice.size,
            type: choice.type,
            lastModified: choice.lastModified,
            source: "catalogue-thumbnail",
            catalogueId: id,
            assetId: choice.assetId,
          };
          autoThumbnailAssetId = choice.assetId;
          thumbnailInput.value = "";
          renderFilePickers();
          scheduleMatch();
        }
        catalogueThumbnailStatus.textContent =
          autoThumbnailAssetId === thumbnailFile?.assetId
            ? `Automatically selected ${thumbnailChoices[0].name} for ${id}.`
            : `Choose one of ${thumbnailChoices.length} named thumbnails for ${id}.`;
        for (const choice of thumbnailChoices) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "catalogue-thumbnail-choice";
          button.dataset.assetId = choice.assetId;
          button.setAttribute(
            "aria-pressed",
            String(thumbnailFile?.assetId === choice.assetId),
          );
          const preview = document.createElement("img");
          preview.alt = "";
          preview.loading = "lazy";
          const label = document.createElement("span");
          label.textContent = choice.name;
          button.append(preview, label);
          button.addEventListener("click", () => {
            if (activeSession || runBusy) return;
            autoThumbnailAssetId = null;
            thumbnailFile = {
              name: choice.name,
              size: choice.size,
              type: choice.type,
              lastModified: choice.lastModified,
              source: "catalogue-thumbnail",
              catalogueId: id,
              assetId: choice.assetId,
            };
            thumbnailInput.value = "";
            catalogueThumbnailStatus.textContent = `Selected ${choice.name} for ${id}.`;
            renderFilePickers();
            scheduleMatch();
          });
          catalogueThumbnailChoices.append(button);
        }
        for (const choice of thumbnailChoices) {
          if (revision !== thumbnailChoicesRevision) return;
          try {
            const { result: preview } = await sendMessage({
              type: "OFENHANCER_APP_REQUEST",
              operation: "getUploadThumbnailPreview",
              payload: { catalogueId: id, assetId: choice.assetId },
            });
            if (
              revision === thumbnailChoicesRevision &&
              thumbnailCatalogueId === id
            )
              catalogueThumbnailChoices.querySelector(
                `[data-asset-id="${choice.assetId}"] img`,
              ).src = preview.dataUrl;
          } catch {
            // A missing or changed variant stays selectable only until native validation rejects it.
          }
        }
      } catch (error) {
        if (
          revision === thumbnailChoicesRevision &&
          thumbnailCatalogueId === id
        )
          catalogueThumbnailStatus.textContent = `Named thumbnails could not load: ${error.message}`;
      } finally {
        if (revision === thumbnailChoicesRevision)
          loadCatalogueThumbnails.disabled = false;
      }
    }

    function invalidateMatch() {
      readiness = null;
      ++readinessRevision;
      uploadError.textContent = "";
      reviewRecovery.hidden = true;
      refreshReadiness.hidden = true;
      updateUploadAction();
      currentMatch = null;
      currentProposal = null;
      uploadButton.disabled = true;
      cataloguePicker.hidden = true;
      showCatalogueThumbnailPicker(null);
      pornhubRecommendation.textContent = "";
      selectedCatalogueReason.textContent = "";
      continueWithoutSheet.hidden = true;
      matchRevision += 1;
    }

    function validate(show = false) {
      const value = draft();
      errors.textContent = show ? value.errors.join(" ") : "";
      return value;
    }

    function proposalDraft() {
      return {
        filename: fullFile?.name || "",
        title: title.value.trim(),
        description: description.value.trim(),
        releaseDate: releaseDate.value,
      };
    }

    function currentQueueEvidence() {
      try {
        return globalThis.CreatorUploadQueueEvidence?.snapshot?.() || {};
      } catch {
        return {};
      }
    }

    async function loadCatalogueSnapshot({ refresh = false } = {}) {
      if (refresh) snapshotPromise = null;
      const client = globalThis.CreatorCatalogueClient;
      if (!client?.getCatalogueSnapshot) {
        throw new Error(
          "Catalogue snapshot client is unavailable. Reload the extension or continue without the sheet.",
        );
      }
      snapshotPromise ||= client.getCatalogueSnapshot();
      return snapshotPromise;
    }

    function setInferredTargets(targets) {
      const inferred = new Set(targets);
      onlyfans.checked = inferred.has("onlyfans");
      fansly.checked = inferred.has("fansly");
      manyvids.checked = inferred.has("manyvids");
      pornhub.checked = inferred.has("pornhub");
    }

    function proposalReason(proposal) {
      return [
        proposal.candidate?.seasonArc,
        proposal.candidate?.episode
          ? `Episode ${proposal.candidate.episode}`
          : "",
        ...(proposal.reasons || []),
      ]
        .filter(Boolean)
        .join(" · ");
    }

    function renderPicker() {
      if (!currentSnapshot) return;
      const engine = globalThis.CreatorCatalogueProposal;
      const query = engine
        ? globalThis.CreatorCatalogueContract.normalizedText(
            catalogueSearch.value,
          )
        : "";
      const ranked = engine.rankRows(proposalDraft(), currentSnapshot.rows);
      const visible = ranked.filter((candidate) => {
        const searchable = globalThis.CreatorCatalogueContract.normalizedText(
          [
            candidate.title,
            candidate.id,
            candidate.seasonArc,
            candidate.episode,
          ].join(" "),
        );
        if (query && !searchable.includes(query)) return false;
        return (
          showAllCatalogue.checked ||
          engine.inferTargets(candidate, ["onlyfans", "fansly", "manyvids"])
            .recommended.length > 0
        );
      });
      catalogueRow.replaceChildren();
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = "Choose a catalogue episode";
      catalogueRow.append(prompt);
      const group = document.createElement("optgroup");
      group.label = showAllCatalogue.checked
        ? "All catalogue entries"
        : "Likely matches";
      catalogueRow.append(group);
      for (const candidate of visible) {
        const option = document.createElement("option");
        option.value = `row:${candidate.row}`;
        option.textContent = [
          candidate.title || candidate.id,
          candidate.releaseDate || "no date",
          `PH ${candidate.pornhubLink ? "yes" : "missing"}`,
          `OF ${candidate.onlyfansLink ? "yes" : "missing"}`,
          `Fansly ${candidate.fanslyLink ? "yes" : "missing"}`,
          `MV ${candidate.manyvidsLink ? "yes" : "missing"}`,
        ].join(" · ");
        group.append(option);
      }
      const addNew = document.createElement("option");
      addNew.value = "new";
      addNew.textContent = "+ Add new catalogue entry";
      if (workflowMode?.value !== "teaser") catalogueRow.append(addNew);
      if (selectedCatalogueRow === "new") catalogueRow.value = "new";
      else if (Number.isInteger(selectedCatalogueRow)) {
        catalogueRow.value = `row:${selectedCatalogueRow}`;
      }
      const revision = ++catalogueCardRevision;
      clearTimeout(cataloguePreviewTimer);
      catalogueCards.replaceChildren();
      const cards = visible.slice(0, catalogueCardLimit);
      const pendingImages = new Map();
      showMoreCatalogue.hidden = visible.length <= cards.length;
      for (const candidate of cards) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "catalogue-card";
        card.setAttribute(
          "aria-pressed",
          String(candidate.row === selectedCatalogueRow),
        );
        const image = document.createElement("img");
        image.alt = "";
        image.width = 112;
        image.height = 63;
        image.loading = "lazy";
        const main = document.createElement("span");
        main.className = "catalogue-card-main";
        const name = document.createElement("strong");
        name.textContent = candidate.title || candidate.id;
        const detail = document.createElement("small");
        detail.textContent = [candidate.releaseDate, candidate.seasonArc]
          .filter(Boolean)
          .join(" · ");
        main.append(name, detail);
        card.append(image, main);
        card.addEventListener("click", () => {
          catalogueRow.value = `row:${candidate.row}`;
          catalogueRow.dispatchEvent(new Event("change", { bubbles: true }));
        });
        catalogueCards.append(card);
        const id = candidate.id;
        if (!id || !/^[a-z0-9-]{1,200}$/.test(id)) continue;
        if (cataloguePreviewCache.has(id)) {
          if (cataloguePreviewCache.get(id))
            image.src = cataloguePreviewCache.get(id);
          continue;
        }
        pendingImages.set(id, image);
      }
      if (pendingImages.size)
        cataloguePreviewTimer = setTimeout(() => {
          if (revision !== catalogueCardRevision) return;
          const ids = [...pendingImages.keys()];
          for (let index = 0; index < ids.length; index += 18) {
            const batch = ids.slice(index, index + 18);
            void sendMessage({
              type: "OFENHANCER_APP_REQUEST",
              operation: "getCatalogueThumbnailPreviews",
              payload: { catalogueIds: batch },
            })
              .then(({ result }) => {
                for (const id of batch) {
                  const dataUrl = result?.previews?.[id] || null;
                  cataloguePreviewCache.set(id, dataUrl);
                  if (revision === catalogueCardRevision && dataUrl)
                    pendingImages.get(id).src = dataUrl;
                }
              })
              .catch(() => {});
          }
        }, 120);
      cataloguePicker.hidden = false;
    }

    function buildProposal(selectedRow = null) {
      if (workflowMode?.value === "teaser") {
        const candidate = currentSnapshot?.rows.find(
          (row) => Number(row.row) === selectedRow,
        );
        return {
          status: candidate ? "ready" : "needs-selection",
          candidate,
          targets: { executable: [], recommended: [] },
          schedules: {},
        };
      }
      return globalThis.CreatorCatalogueProposal.build({
        draft: proposalDraft(),
        snapshot: currentSnapshot,
        selectedRow,
        now: new Date(),
        executablePlatforms: manualTargets
          ? [...manualTargets]
          : [
              "onlyfans",
              "fansly",
              "manyvids",
              ...(contentPreset.value ? ["pornhub"] : []),
            ],
        queueByPlatform: currentQueueEvidence(),
      });
    }

    function applyProposal(proposal, catalogueStatus = "matched") {
      currentProposal = proposal;
      continueWithoutSheet.hidden = proposal.status !== "needs-queue-evidence";
      const candidate = proposal.candidate;
      if (workflowMode?.value === "teaser" && candidate) {
        currentMatch = { status: "matched", candidate };
        selectedCatalogueReason.textContent =
          "Results will be associated with this entry.";
        renderMatch(currentMatch);
        return;
      }
      if (!candidate) {
        currentMatch = null;
        uploadButton.disabled = true;
        renderPicker();
        return;
      }
      if (candidate.title) title.value = candidate.title;
      if (candidate.description) description.value = candidate.description;
      if (!contentPreset.value && candidate.seasonArc && workflowProfiles) {
        const resolved =
          globalThis.CreatorToolkitAdapters?.phUploader?.resolvePreset(
            workflowProfiles.phUploader,
            candidate.seasonArc,
            "",
          );
        if (resolved) contentPreset.value = resolved.name;
      }
      const inferredTargets = [...proposal.targets.executable];
      if (
        !candidate.pornhubLink &&
        contentPreset.value &&
        !inferredTargets.includes("pornhub")
      ) {
        inferredTargets.push("pornhub");
      }
      setInferredTargets(inferredTargets);
      const executableDates = [
        ...new Set(
          proposal.targets.executable
            .map((platform) => proposal.schedules[platform]?.releaseDate)
            .filter(Boolean),
        ),
      ];
      if (executableDates.length === 1) releaseDate.value = executableDates[0];
      refreshReleaseSummary();
      pornhubRecommendation.textContent = proposal.targets.recommended.includes(
        "pornhub",
      )
        ? contentPreset.value
          ? "Pornhub metadata preparation was added from an exact content preset. File assignment is automatic; final Submit remains manual."
          : "Pornhub is recommended from the empty catalogue link. Choose an exact content preset to add its trace-gated metadata step."
        : "";
      selectedCatalogueReason.textContent = proposalReason(proposal);
      currentMatch = { status: catalogueStatus, candidate };
      matchStatus.textContent = `Catalogue row ${candidate.row} is the strongest deterministic proposal.`;
      renderMatch(currentMatch);
      if (proposal.status !== "ready") {
        updateUploadAction();
        if (proposal.status === "needs-queue-evidence") {
          const unverified = proposal.targets.executable
            .filter((platform) => !proposal.schedules[platform]?.verified)
            .map(
              (platform) =>
                ({
                  onlyfans: "OnlyFans",
                  fansly: "Fansly",
                  manyvids: "ManyVids",
                  pornhub: "Pornhub",
                })[platform],
            );
          catalogueSelectionStatus.textContent = `${unverified.join(" and ")} queue${unverified.length === 1 ? " is" : "s are"} not verified yet.`;
        } else if (proposal.status === "not-executable") {
          catalogueSelectionStatus.textContent =
            "The missing platform is recommended but not executable yet.";
        }
      }
    }

    function creatorUploadRequest(value, sessionId, targets) {
      return {
        type: "PREPARE_CREATOR_UPLOAD",
        sessionId,
        targets,
        draft: {
          title: value.title,
          hasTeaser: value.hasTeaser,
          publishMode: value.publishMode,
          description: value.description,
          fullFilename: fullFile?.name || "",
          releaseDate: value.releaseDate,
          scheduledIso: value.scheduledIso,
          timeZone,
          fanslyPreset: "defaulT",
          fanslyPresetSelection: "first",
          manyvidsThumbnail:
            targets.includes("manyvids") && Boolean(thumbnailFile),
          pornhubThumbnail:
            targets.includes("pornhub") &&
            value.pornhubMode === "free" &&
            Boolean(thumbnailFile),
          pornhubFilename: pornhubFile?.name || fullFile?.name || "",
          fileProof: {
            full: fileResumeProof(fullFile),
            teaser: fileResumeProof(teaserFile),
            thumbnail:
              targets.includes("manyvids") ||
              (targets.includes("pornhub") && value.pornhubMode === "free")
                ? fileResumeProof(thumbnailFile)
                : null,
            pornhub: fileResumeProof(pornhubFile || fullFile),
          },
          contentPreset: value.contentPreset,
          pornhubMode: value.pornhubMode,
          pornhubCertificationsConfirmed: value.pornhubCertificationsConfirmed,
          fanslyCaption: value.fanslyCaption,
          profiles: value.profiles,
          profileSignature: value.profileSignature,
        },
        catalogue:
          currentMatch.status === "upload-only"
            ? null
            : {
                ...(currentSnapshot?.source === "desktop"
                  ? {
                      source: "desktop",
                      itemId:
                        currentMatch.candidate.itemId ||
                        currentMatch.candidate.id,
                    }
                  : {}),
                publicationState: currentMatch.candidate.publicationState,
                row: currentMatch.candidate.row,
                id: currentMatch.candidate.id,
                releaseDate: currentMatch.candidate.releaseDate,
                title: currentMatch.candidate.title,
                description: currentMatch.candidate.description,
                seasonArc: currentMatch.candidate.seasonArc || "",
                episode: currentMatch.candidate.episode || "",
                pornhubLink: currentMatch.candidate.pornhubLink || "",
                onlyfansLink: currentMatch.candidate.onlyfansLink || "",
                fanslyLink: currentMatch.candidate.fanslyLink || "",
                manyvidsLink: currentMatch.candidate.manyvidsLink || "",
                fingerprint: currentMatch.candidate.fingerprint,
                status: currentMatch.status,
              },
      };
    }

    function draftBlocker(value, social) {
      if (!value.valid) return value.errors.join(" ");
      if (!social.valid) return social.errors.join(" ");
      if (!currentMatch)
        return "Choose the catalogue entry or wait for the draft check.";
      if (
        value.targets.some(
          (platform) =>
            currentMatch.candidate.publicationState?.[platform] === "review",
        )
      )
        return "A selected platform has an unresolved catalogue link. Review that link or deselect the platform.";
      if (
        currentProposal &&
        workflowMode.value !== "teaser" &&
        currentProposal.status !== "ready" &&
        !(currentProposal.status === "nothing-pending" && social.enabled)
      )
        return currentProposal.status === "needs-queue-evidence"
          ? "Verify the selected platform queues, or explicitly continue without the sheet."
          : "Resolve the catalogue recommendation before uploading. Choose an executable destination.";
      if (!pendingTargets(value, currentMatch).length && !social.enabled)
        return "Every selected platform already has a catalogue link. Nothing will be uploaded.";
      return "";
    }

    function renderRunSettings(value = draft()) {
      const authorization = profileAuthorizationSummary(
        value.profiles,
        value.contentPreset,
      );
      const settings = get("#platformSettings");
      settings.replaceChildren();
      for (const platform of value.targets) {
        const line = document.createElement("p");
        const label = document.createElement("strong");
        label.textContent = PLATFORM_LABELS[platform] + ": ";
        const detail = {
          onlyfans:
            "Full video and description; existing labels are left unchanged.",
          fansly:
            "Full video restricted with the first Load Preset entry; a selected teaser becomes Free Preview. " +
            authorization.fansly,
          manyvids: authorization.manyvids,
          pornhub:
            (value.pornhubMode === "paid"
              ? `Pay To View on Fancentro at $${Number(value.profiles?.manyvidsAutofill?.price || 0).toFixed(2)}, with 2–7 saved tags.`
              : authorization.pornhub +
                ". Free To View with saved categories and optional thumbnail.") +
            (value.pornhubCertificationsConfirmed
              ? " Select All and Certify is authorized for this upload."
              : " Site certifications stay for your review.") +
            " Final Submit stays manual.",
        }[platform];
        line.append(label, document.createTextNode(detail));
        settings.append(line);
      }
      get("#selectedPlatformDetails").hidden = !value.targets.length;
      const social = socialDraft();
      const automatic =
        value.targets.some((p) => p !== "pornhub") &&
        value.publishMode === "autonomous";
      runNotice.textContent =
        automatic || (social.enabled && social.mode === "autonomous")
          ? "Upload authorizes publishing or scheduling in the selected automatic modes. Pornhub Submit stays manual."
          : "Upload prepares unpublished drafts. You review and publish on each site.";
      if (currentMatch?.status === "upload-only")
        runNotice.textContent += " No sheet data will be read or written.";
      updateMediaRelevance();
    }

    function updateUploadAction() {
      uploadButton.disabled =
        runBusy ||
        Boolean(activeSession) ||
        !get("#resumePrompt").hidden ||
        readiness?.ready !== true;
      const ongoing =
        activeSession &&
        !activeSession.needsReconciliation &&
        !activeSession.connectionLost &&
        [...platformStates.values()].some((state) =>
          [
            "preparing",
            "prepared",
            "uploading-full",
            "configuring",
            "waiting-for-teaser",
            "waiting-for-thumbnail",
            "upload-ready",
            "edit-requested",
            "upload-observing",
            "upload-progress-unknown",
          ].includes(state.status),
        );
      uploadButton.setAttribute(
        "aria-busy",
        String(runBusy || Boolean(ongoing)),
      );
      get("#uploadActions").dataset.state = activeSession?.needsReconciliation
        ? "attention"
        : runBusy || ongoing
          ? "busy"
          : uploadError.textContent
            ? "error"
            : readiness?.ready
              ? "ready"
              : "incomplete";
    }

    function lockDraft(locked) {
      if (locked) {
        for (const control of document.querySelectorAll(
          "#workflowMode, .workflow-panel input, .workflow-panel button:not(#loadTemplate), .draft-card input, .draft-card select, .draft-card textarea, #mainDestinations input, #mainPublishMode, #catalogueAssociation, #cataloguePicker input, #cataloguePicker select, #cataloguePicker button, .social-card input, .social-card select, .social-card textarea, .social-card button, #settingsPanel input, #settingsPanel select, #settingsPanel textarea, #settingsPanel button, #changeCatalogueEntry, #continueWithoutSheet",
        )) {
          if (!lockedControls.has(control))
            lockedControls.set(control, control.disabled);
          control.disabled = true;
        }
      } else {
        for (const [control, disabled] of lockedControls)
          control.disabled = disabled;
        lockedControls.clear();
      }
      renderFilePickers();
    }

    async function checkReadiness() {
      if (runBusy || activeSession) return;
      const revision = ++readinessRevision;
      readiness = null;
      const value = draft(),
        social = socialDraft();
      const blocker = draftBlocker(value, social);
      updateUploadAction();
      if (blocker) {
        matchStatus.textContent = blocker;
        return;
      }
      matchStatus.textContent =
        "Checking previous runs and platform configuration…";
      try {
        const targets = pendingTargets(value, currentMatch);
        if (targets.length) {
          value.profileSignature = await creatorRegistry.uploadProfileSignature(
            value.profiles,
          );
          if (revision !== readinessRevision || runBusy || activeSession)
            return;
          const response = await sendMessage({
            ...creatorUploadRequest(value, randomSessionId(), targets),
            type: "CHECK_CREATOR_UPLOAD_AVAILABILITY",
          });
          if (response.availability?.ready !== true)
            throw new Error(
              "The running extension could not verify readiness. Reload the matching OFEnhancer version, then check readiness again.",
            );
        }
        if (revision !== readinessRevision || runBusy || activeSession) return;
        readiness = { ready: true };
        matchStatus.textContent = uploadError.textContent
          ? "Ready to retry. Review the error before continuing."
          : "Ready. Upload starts this run.";
        reviewRecovery.hidden = true;
        refreshReadiness.hidden = true;
      } catch (error) {
        if (revision !== readinessRevision || runBusy || activeSession) return;
        readiness = { ready: false };
        matchStatus.textContent = error.recoveryRequired
          ? "Previous work needs review before Upload."
          : "Upload readiness could not be verified.";
        uploadError.textContent =
          error.message +
          (error.recoveryRequired
            ? " Open Upload history to review the existing work. Your selections are unchanged."
            : " Correct the issue, then check readiness. Your selections are unchanged.");
        reviewRecovery.hidden = !error.recoveryRequired;
        refreshReadiness.hidden = false;
      }
      updateUploadAction();
    }

    function renderMatch(match) {
      const candidate = match.candidate;
      if (!socialCaption.value.trim() && candidate.title)
        socialCaption.value = candidate.title;
      renderPaidLinkOptions(candidate);
      catalogueSelectionStatus.textContent =
        match.status === "upload-only"
          ? "Catalogue deferred · upload without sheet"
          : (match.status === "new" ? "New catalogue row " : "Catalogue row ") +
            candidate.row +
            " · " +
            candidate.id +
            " · " +
            candidate.title;
      changeCatalogueEntry.hidden = match.status === "upload-only";
      renderRunSettings();
      showCatalogueThumbnailPicker(match);
      void checkReadiness();
    }

    function previewWithoutSheet(value) {
      currentMatch = { status: "upload-only", candidate: value };
      matchStatus.textContent =
        "Results will stay local until you associate a catalogue entry.";
      renderMatch(currentMatch);
    }

    async function matchCatalogue(forceNew = false) {
      if (runBusy || activeSession) return;
      clearTimeout(matchTimer);
      const revision = ++matchRevision;
      currentMatch = null;
      currentProposal = null;
      uploadButton.disabled = true;
      cataloguePicker.hidden = true;
      continueWithoutSheet.hidden = uploadWithoutSheet;
      const value = validate(true);
      if (!value.valid || activeSession) {
        uploadButton.disabled = true;
        matchStatus.textContent = value.valid
          ? "An upload session is already active."
          : "Complete the required fields to enable Upload.";
        return;
      }
      if (uploadWithoutSheet) {
        previewWithoutSheet(value);
        return;
      }
      matchStatus.textContent = forceNew
        ? "Finding the next safe empty catalogue row…"
        : "Loading the catalogue and ranking likely episodes…";
      uploadButton.disabled = true;
      try {
        const client = globalThis.CreatorCatalogueClient;
        if (!client?.loadConfig || !globalThis.CreatorCatalogueProposal) {
          throw new Error(
            "Catalogue proposal tools are unavailable. Reload the extension or continue without the sheet.",
          );
        }
        const config = await client.loadConfig();
        if (revision !== matchRevision) return;
        if (!config.connected && !config.endpoint && !config.secret) {
          throw new Error(
            "Catalogue matching is not connected. Restore the catalogue connection, or explicitly choose Continue without sheet.",
          );
        }
        currentSnapshot = await loadCatalogueSnapshot();
        get("#catalogueConnectionStatus").textContent =
          "Catalogue loaded. Choose an entry now or associate results later.";
        if (revision !== matchRevision) return;
        if (forceNew) selectedCatalogueRow = "new";
        const proposal = buildProposal(selectedCatalogueRow);
        if (proposal.status === "needs-selection") {
          currentProposal = proposal;
          matchStatus.textContent =
            "More than one catalogue episode is plausible. Choose the exact row.";
          renderPicker();
          return;
        }
        applyProposal(proposal, forceNew ? "new" : "matched");
      } catch (error) {
        if (revision !== matchRevision) return;
        currentMatch = null;
        matchStatus.textContent = error.message;
        continueWithoutSheet.hidden = false;
      }
    }

    function scheduleMatch() {
      if (runBusy || activeSession) return;
      clearTimeout(matchTimer);
      invalidateMatch();
      refreshReleaseSummary();
      renderRunSettings();
      const value = validate(true);
      if (!value.valid || activeSession) {
        matchStatus.textContent =
          "Complete the required fields to enable Upload.";
        return;
      }
      matchStatus.textContent = "Waiting for edits to settle…";
      matchTimer = setTimeout(() => matchCatalogue(false), 180);
    }

    function statusLabel(status) {
      return (
        {
          preparing: "Preparing authenticated interface",
          "not-started": "Not started · draft preserved",
          prepared: "Authenticated interface ready",
          cancelled: "Stopped · draft preserved",
          "uploading-full": "Uploading full video",
          "upload-observing":
            "Upload exceeds 45 minutes; continuing to observe",
          "upload-progress-unknown":
            "Upload progress unknown; continuing to observe",
          "upload-attention-required":
            "Upload progress stalled · inspect the existing attachment",
          "upload-ready": "Upload ready; opening editor",
          "edit-requested": "Opening ManyVids editor",
          "save-clicked": "Saving ManyVids video",
          configuring: "Configuring access and schedule",
          "waiting-for-teaser": "Waiting for teaser",
          "waiting-for-thumbnail": "Waiting for thumbnail",
          "edit-failed": "ManyVids editor stopped safely",
          submitted: "Submitted; resolving link",
          "link-captured": "Post link captured",
          "posted-link-unresolved": "Submitted; recover link manually",
          "catalogue-commit-failed": "Posted; sheet update failed",
          "catalogue-updated": "Sheet updated and verified",
          "uploaded-no-sheet": "Scheduled · sheet not connected",
          "recorded-local": "Saved locally · sheet unchanged",
          "published-local": "Published · catalogue entry deferred",
          "review-required": "Draft prepared · review remaining fields",
          "waiting-for-redgifs": "Draft prepared · add the Redgifs link",
          "ready-for-review": "Draft ready for your review",
          "manual-submit-required": "Prepared · review and publish manually",
          "already-linked": "Already linked",
          idempotent: "Catalogue already current",
          conflict: "Catalogue link conflict",
          stale: "Catalogue row changed",
          failed: "Failed",
        }[status] ||
        status ||
        "Working"
      );
    }

    function renderPlatformStates() {
      results.replaceChildren();
      if (!activeSession && platformStates.size === 0) return;
      for (const platform of selectedRunTargets()) {
        const state = platformStates.get(platform) || { status: "prepared" };
        const card = document.createElement("article");
        card.className = "result-card";
        const heading = document.createElement("div");
        heading.className = "result-heading";
        const name = document.createElement("h3");
        name.textContent =
          platform === "onlyfans"
            ? "OnlyFans"
            : platform === "fansly"
              ? "Fansly"
              : platform === "manyvids"
                ? "ManyVids"
                : platform === "pornhub"
                  ? "Pornhub"
                  : platform === "x"
                    ? "X"
                    : platform === "redgifs"
                      ? "Redgifs"
                      : `r/${platform.replace(/^reddit:/, "")}`;
        const badge = document.createElement("span");
        badge.className = "result-status";
        badge.dataset.state = state.status || "";
        badge.textContent = statusLabel(state.status);
        heading.append(name, badge);
        card.append(heading);
        if (state.postUrl) {
          const link = document.createElement("a");
          link.href = state.postUrl;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = state.postUrl;
          card.append(link);
        }
        if (state.error) {
          const message = document.createElement("p");
          message.className = "error";
          message.textContent = state.error;
          card.append(message);
        }
        if (state.manualFields?.length) {
          const remaining = document.createElement("p");
          remaining.textContent = `Review in your browser: ${state.manualFields.join(", ")}.`;
          card.append(remaining);
        }
        const retryNeedsNew =
          platform === "pornhub" &&
          state.status === "failed" &&
          state.stage === "upload" &&
          !state.postUrl;
        if (retryNeedsNew) {
          const next = document.createElement("p");
          next.textContent =
            "Inspect the existing site draft, then Start new upload to try again.";
          card.append(next);
        }
        if (
          !retryNeedsNew &&
          (new Set([
            "failed",
            "edit-failed",
            "catalogue-commit-failed",
            "upload-attention-required",
            "stale",
            "conflict",
          ]).has(state.status) ||
            (Boolean(state.postUrl) &&
              !new Set([
                "catalogue-updated",
                "uploaded-no-sheet",
                "recorded-local",
                "published-local",
                "idempotent",
              ]).has(state.status)))
        ) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.textContent = state.postUrl
            ? "Retry sheet update"
            : state.status === "upload-attention-required"
              ? "Continue observing"
              : `Retry ${name.textContent}`;
          retry.addEventListener("click", () => retryPlatform(platform, retry));
          card.append(retry);
        }
        results.append(card);
      }
    }

    function setPlatformState(platform, patch) {
      platformStates.set(platform, {
        ...(platformStates.get(platform) || {}),
        ...patch,
      });
      renderPlatformStates();
      updateUploadAction();
      if (patch.postUrl && activeSession?.catalogueDeferred)
        get("#savedCatalogueAssociation").hidden = false;
    }

    function applySocialJob(job) {
      if (!job) return;
      setPlatformState("x", {
        status:
          job.stage === "sheet-complete"
            ? job.googleSynced === false
              ? "recorded-local"
              : "catalogue-updated"
            : job.stage === "result-captured" &&
                activeSession?.catalogueDeferred
              ? "published-local"
              : job.stage,
        postUrl: job.resultUrl || "",
        error: job.error || "",
      });
      if (job.resultUrl && activeSession?.catalogueDeferred)
        get("#savedCatalogueAssociation").hidden = false;
    }

    function scheduleSocialResume(sessionId, job) {
      clearTimeout(socialPollTimer);
      if (
        !sessionId ||
        !job ||
        (job.stage === "result-captured" && activeSession?.catalogueDeferred) ||
        new Set(["sheet-complete", "failed", "blocked"]).has(job.stage)
      ) {
        return;
      }
      const configuredDelay = Number(globalThis.CreatorSocialPollDelayMs);
      const delay = Number.isFinite(configuredDelay)
        ? Math.max(10, Math.min(configuredDelay, 60_000))
        : 5_000;
      socialPollTimer = setTimeout(async () => {
        try {
          const response = await sendMessage({
            type: "RESUME_CREATOR_SOCIAL_DISTRIBUTION",
            sessionId,
          });
          if (activeSession?.id !== sessionId || activeSession.closed) return;
          const resumed = response.socialDistribution?.jobs?.x;
          applySocialJob(resumed);
          scheduleSocialResume(sessionId, resumed);
        } catch (error) {
          if (activeSession?.id !== sessionId || activeSession.closed) return;
          setPlatformState("x", {
            status: "failed",
            error: error.message,
          });
        }
      }, delay);
    }

    function randomSessionId() {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      return [...bytes]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    }

    function channelFor(session) {
      if (!session.channel) {
        session.channel = new BroadcastChannel(`creator-upload:${session.id}`);
      }
      return session.channel;
    }

    async function rememberPornhubSeriesPreset(value) {
      if (!value.targets.includes("pornhub")) return;
      const seasonArc = String(currentMatch?.candidate?.seasonArc || "").trim();
      if (!seasonArc || !value.contentPreset) return;
      const settings = await globalThis.CreatorToolkit.loadSettings();
      settings.profiles.phUploader.seriesPresets = learnSeriesPresetMap(
        settings.profiles.phUploader.seriesPresets,
        seasonArc,
        value.contentPreset,
      );
      await globalThis.CreatorToolkit.saveSettings(settings);
    }

    function fileIdentity(file) {
      return file
        ? {
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
            ...(file.source === "development-fixture"
              ? { source: file.source, fixtureToken: file.fixtureToken }
              : {}),
            ...(file.source === "catalogue-thumbnail"
              ? {
                  source: file.source,
                  catalogueId: file.catalogueId,
                  assetId: file.assetId,
                }
              : {}),
          }
        : null;
    }

    function fileResumeProof(file) {
      const identity = fileIdentity(file);
      return identity
        ? {
            name: identity.name,
            size: identity.size,
            lastModified: identity.lastModified,
            type: identity.type,
          }
        : null;
    }

    function matchesResumeFile(expected, file) {
      if (!expected) return true;
      const actual = fileResumeProof(file);
      return Boolean(
        actual &&
        actual.name === expected.name &&
        actual.size === expected.size &&
        actual.lastModified === expected.lastModified &&
        actual.type === expected.type,
      );
    }

    function sessionFile(session, role) {
      const file = session.files[role] || null;
      const expected = session.fileProof[role] || null;
      if (!file || !expected) return null;
      const actual = fileIdentity(file);
      return JSON.stringify(actual) === JSON.stringify(expected) ? file : null;
    }

    function deliverFile(session, request) {
      if (session.cancelled) return;
      const file = sessionFile(session, request.role);
      if (!file) {
        session.pendingFiles.set(request.requestId, request);
        setPlatformState(request.platform, {
          status:
            request.role === "thumbnail"
              ? "waiting-for-thumbnail"
              : request.role === "teaser"
                ? "waiting-for-teaser"
                : "upload-attention-required",
        });
        return;
      }
      if (globalThis.OFEnhancerDesktopUpload)
        return globalThis.OFEnhancerDesktopUpload.deliverFile(
          session,
          request,
          file,
        );
      if (file.source === "development-fixture")
        return sendMessage({
          type: "DELIVER_DEVELOPMENT_FILE",
          requestId: request.requestId,
          sessionId: request.sessionId,
          platform: request.platform,
          role: request.role,
          token: request.token,
          fixtureToken: file.fixtureToken,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
        }).catch((error) => {
          session.port.postMessage({
            type: "file-response",
            requestId: request.requestId,
            ok: false,
            error: error.message,
          });
        });
      if (file.source === "catalogue-thumbnail")
        return sendMessage({
          type: "DELIVER_CATALOGUE_THUMBNAIL_FILE",
          requestId: request.requestId,
          sessionId: request.sessionId,
          platform: request.platform,
          role: request.role,
          token: request.token,
          catalogueId: file.catalogueId,
          assetId: file.assetId,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
        }).catch((error) => {
          session.port.postMessage({
            type: "file-response",
            requestId: request.requestId,
            ok: false,
            error: error.message,
          });
        });
      if (request.role === "thumbnail") {
        void normalizeThumbnailFile(file)
          .then((converted) => {
            if (!session.cancelled)
              deliverBrowserFile(session, request, converted);
          })
          .catch((error) => {
            session.port.postMessage({
              type: "file-response",
              requestId: request.requestId,
              ok: false,
              error: error.message,
            });
          });
        return;
      }
      deliverBrowserFile(session, request, file);
    }

    function deliverBrowserFile(session, request, file) {
      const channel = channelFor(session);
      let sent = false;
      const probe = () =>
        channel.postMessage({
          source: "creator-upload-console",
          direction: "probe",
          sessionId: session.id,
          platform: request.platform,
          requestId: request.requestId,
        });
      const readyPoll = setInterval(probe, 250);
      const timeout = setTimeout(() => {
        clearInterval(readyPoll);
        channel.removeEventListener("message", onAck);
        session.port.postMessage({
          type: "file-response",
          requestId: request.requestId,
          ok: false,
          error: "The platform file bridge did not acknowledge the video.",
        });
      }, 60_000);
      const onAck = (event) => {
        if (session.cancelled) {
          clearTimeout(timeout);
          clearInterval(readyPoll);
          channel.removeEventListener("message", onAck);
          return;
        }
        const data = event.data;
        if (
          data?.source === "creator-upload-bridge" &&
          data.direction === "ready" &&
          data.sessionId === session.id &&
          data.platform === request.platform &&
          data.requestId === request.requestId &&
          !sent
        ) {
          sent = true;
          clearInterval(readyPoll);
          channel.postMessage({
            source: "creator-upload-console",
            sessionId: session.id,
            platform: request.platform,
            role: request.role,
            requestId: request.requestId,
            token: request.token,
            file,
          });
          return;
        }
        if (
          data?.source !== "creator-upload-bridge" ||
          data.direction !== "ack" ||
          data.sessionId !== session.id ||
          data.platform !== request.platform ||
          data.role !== request.role ||
          data.requestId !== request.requestId
        ) {
          return;
        }
        clearTimeout(timeout);
        clearInterval(readyPoll);
        channel.removeEventListener("message", onAck);
        session.port.postMessage({
          type: "file-response",
          requestId: request.requestId,
          ok: data.ok === true,
          error: data.ok
            ? ""
            : data.error || "Platform rejected the video transfer.",
        });
      };
      channel.addEventListener("message", onAck);
      probe();
    }

    function flushPendingTeaser() {
      const session = activeSession;
      if (!session || !sessionFile(session, "teaser")) return;
      for (const [requestId, request] of [...session.pendingFiles]) {
        if (request.role !== "teaser") continue;
        session.pendingFiles.delete(requestId);
        deliverFile(session, request);
      }
    }

    function connectSession(sessionId, confirmed) {
      let acceptBinding, rejectBinding;
      const bound = new Promise((resolve, reject) => {
        acceptBinding = resolve;
        rejectBinding = reject;
      });
      const bindingTimer = setTimeout(
        () =>
          rejectBinding(
            new Error(
              "The browser did not acknowledge the upload connection. Reconnect Chrome and check readiness before retrying.",
            ),
          ),
        15000,
      );
      const session = {
        whenBound: bound.finally(() => clearTimeout(bindingTimer)),
        id: sessionId,
        files: { ...confirmed.files },
        fileProof: Object.fromEntries(
          Object.entries(confirmed.files).map(([role, file]) => [
            role,
            fileIdentity(file),
          ]),
        ),
        proof: { ...confirmed.proof },
        socialSessionId: confirmed.socialSessionId || "",
        port: null,
        channel: null,
        pendingFiles: new Map(),
        closed: false,
      };
      function connectPort() {
        if (session.closed) return;
        const port = chrome.runtime.connect({ name: "creator-upload-console" });
        session.port = port;
        port.onMessage.addListener((message) => {
          if (
            session.closed ||
            session.port !== port ||
            message?.sessionId !== sessionId
          )
            return;
          if (message.type === "session-bound") {
            if (confirmed.existing && message.existing !== true) {
              rejectBinding(
                new Error(
                  "The saved upload is no longer available. Start New after reviewing upload history.",
                ),
              );
              return;
            }
            session.connectionLost = false;
            acceptBinding();
            updateUploadAction();
            return;
          }
          if (message.type === "file-request") {
            deliverFile(session, message);
            return;
          }
          if (message.type === "platform-progress") {
            setPlatformState(message.platform, {
              status: message.status,
              error: message.error || "",
            });
            return;
          }
          if (message.type === "platform-result") {
            setPlatformState(message.platform, message.result);
            return;
          }
          if (message.type === "session-restored") {
            for (const platform of message.platforms || []) {
              setPlatformState(platform.platform, platform);
            }
            return;
          }
          if (message.type === "session-restore-rejected") {
            session.closed = true;
            session.needsReconciliation = true;
            rejectBinding(new Error(message.error));
            uploadError.textContent =
              message.error + " Review recovery before starting another run.";
            matchStatus.textContent = "Upload connection requires review.";
            reviewRecovery.hidden = false;
            updateUploadAction();
          }
        });
        port.onDisconnect.addListener(() => {
          if (session.port !== port || session.closed) return;
          session.channel?.close();
          session.channel = null;
          session.connectionLost = true;
          const error = new Error(
            chrome.runtime.lastError?.message ||
              "The browser upload connection was interrupted.",
          );
          rejectBinding(error);
          uploadError.textContent =
            error.message +
            " Restore Chrome, then review this run. Upload will not be repeated automatically.";
          matchStatus.textContent = "Browser connection interrupted.";
          reviewRecovery.hidden = false;
          updateUploadAction();
          setTimeout(connectPort, 250);
        });
        port.postMessage({
          type: "bind-session",
          sessionId,
          proof: session.proof,
        });
        if (session.socialSessionId) {
          port.postMessage({
            type: "bind-social-session",
            sessionId: session.socialSessionId,
          });
        }
      }
      try {
        connectPort();
      } catch (error) {
        rejectBinding(error);
      }
      return session;
    }

    async function retryPlatform(platform, button) {
      if (!activeSession) return;
      const session = activeSession;
      button.disabled = true;
      setPlatformState(platform, { status: "prepared", error: "" });
      try {
        const response = await sendMessage({
          type: "RETRY_CREATOR_UPLOAD_PLATFORM",
          sessionId: session.id,
          platform,
        });
        if (activeSession !== session || session.closed) return;
        for (const result of response.results || [])
          setPlatformState(result.platform, result);
      } catch (error) {
        if (activeSession !== session || session.closed) return;
        setPlatformState(platform, { status: "failed", error: error.message });
      } finally {
        button.disabled = false;
      }
    }

    async function recheckProposalBeforeUpload() {
      const priorProfiles = JSON.stringify(draft().profiles);
      const currentProfiles = await refreshProfiles();
      if (priorProfiles !== currentProfiles) {
        scheduleMatch();
        throw new Error(
          "Workflow profiles changed. Review the updated plan and click Upload again.",
        );
      }
      if (!currentProposal || currentMatch?.status === "upload-only") return;
      const social = socialDraft(currentMatch.candidate);
      if (
        currentMatch.status === "matched" &&
        social.enabled &&
        social.valid &&
        pendingTargets(draft(), currentMatch).length === 0
      ) {
        currentSnapshot = await loadCatalogueSnapshot({ refresh: true });
        const refreshed = currentSnapshot.rows.find(
          (row) => Number(row.row) === Number(currentMatch.candidate.row),
        );
        if (
          !refreshed ||
          refreshed.id !== currentMatch.candidate.id ||
          refreshed.fingerprint !== currentMatch.candidate.fingerprint
        ) {
          throw new Error(
            "The matched catalogue row changed. Review it and click Upload again.",
          );
        }
        currentMatch = { ...currentMatch, candidate: refreshed };
        return;
      }
      const previousSignature = proposalSignature(currentProposal);
      currentSnapshot = await loadCatalogueSnapshot({ refresh: true });
      const selectedRow =
        currentMatch.status === "new" ? "new" : currentMatch.candidate.row;
      selectedCatalogueRow = selectedRow;
      const refreshed = buildProposal(selectedRow);
      if (
        refreshed.status !== "ready" ||
        proposalSignature(refreshed) !== previousSignature
      ) {
        applyProposal(refreshed, selectedRow === "new" ? "new" : "matched");
        throw new Error(
          "Catalogue or queue changed. Review the updated proposal and click Upload again.",
        );
      }
      currentProposal = refreshed;
      currentMatch = {
        status: selectedRow === "new" ? "new" : "matched",
        candidate: refreshed.candidate,
      };
    }

    async function startUpload() {
      if (runBusy || activeSession || readiness?.ready !== true) return;
      let prepareDispatched = false;
      let recheckAfterFailure = false;
      let value = validate(true);
      let social = socialDraft();
      if (!value.valid || !social.valid || !currentMatch || activeSession)
        return;
      if (
        value.targets.some(
          (platform) =>
            currentMatch.candidate?.publicationState?.[platform] === "review",
        )
      )
        return;
      let targets = [];
      runBusy = true;
      clearTimeout(matchTimer);
      ++matchRevision;
      ++readinessRevision;
      uploadError.textContent = "";
      reviewRecovery.hidden = true;
      refreshReadiness.hidden = true;
      matchStatus.textContent = "Checking the selected run…";
      lockDraft(true);
      updateUploadAction();
      try {
        await recheckProposalBeforeUpload();
        social = socialDraft(currentMatch.candidate);
        if (!social.valid) {
          throw new Error(social.errors.join(" "));
        }
        await recheckSubredditPresets(social);
        value = validate(true);
        const blocker = draftBlocker(value, social);
        if (blocker) throw new Error(blocker);
        value.profileSignature = await creatorRegistry.uploadProfileSignature(
          value.profiles,
        );
        targets = pendingTargets(value);
        if (!targets.length && !social.enabled) {
          matchStatus.textContent =
            "Every selected platform is already linked. Nothing was uploaded.";
          uploadButton.disabled = false;
          return;
        }
        if (
          thumbnailFile &&
          thumbnailFile.source !== "development-fixture" &&
          thumbnailFile.source !== "catalogue-thumbnail" &&
          targets.some((target) => ["manyvids", "pornhub"].includes(target)) &&
          (targets.includes("manyvids") || value.pornhubMode === "free")
        )
          await normalizeThumbnailFile(thumbnailFile);
        const sessionId = randomSessionId();
        const socialPlan = social.enabled
          ? await buildSocialDistributionPlan({
              id: sessionId,
              file: socialFile,
              caption: social.caption,
              paidLink: social.paidLink,
              mode: social.mode,
              targets: social.targets,
              subreddits: social.subreddits,
              preparationOnly: social.preparationOnly === true,
              catalogue: uploadWithoutSheet
                ? null
                : {
                    row: currentMatch.candidate.row,
                    id: currentMatch.candidate.id,
                    title: currentMatch.candidate.title,
                    fingerprint: currentMatch.candidate.fingerprint,
                  },
              evidence: socialEvidence(),
              authorizationAt: Date.now(),
            })
          : null;
        const selectedFiles = {
          full: fullFile,
          teaser: teaserFile,
          thumbnail: thumbnailFile,
          pornhub: pornhubFile || fullFile,
          social: socialFile,
        };
        activeSession = connectSession(sessionId, {
          files: selectedFiles,
          socialSessionId: socialPlan?.id || "",
          proof: {
            fullFilename: fullFile?.name || "",
            pornhubFilename: pornhubFile?.name || fullFile?.name || "",
            manyvidsThumbnail:
              targets.includes("manyvids") && Boolean(thumbnailFile),
            pornhubThumbnail:
              targets.includes("pornhub") &&
              value.pornhubMode === "free" &&
              Boolean(thumbnailFile),
            pornhubMode: value.pornhubMode,
            profileSignature: value.profileSignature,
            fileProof: {
              full: fileResumeProof(fullFile),
              teaser: fileResumeProof(teaserFile),
              thumbnail:
                targets.includes("manyvids") ||
                (targets.includes("pornhub") && value.pornhubMode === "free")
                  ? fileResumeProof(thumbnailFile)
                  : null,
              pornhub: fileResumeProof(pornhubFile || fullFile),
            },
          },
        });
        activeSession.catalogueDeferred = uploadWithoutSheet;
        lastAttempt = { sessionId, phase: "connecting" };
        if (workflowMode) workflowMode.disabled = true;
        if (catalogueAssociation) catalogueAssociation.disabled = true;
        fullInput.disabled = true;
        thumbnailInput.disabled = true;
        pornhubInput.disabled = true;
        teaserInput.disabled = true;
        socialInput.disabled = true;
        platformStates.clear();
        for (const platform of value.targets) {
          const postUrl = catalogueLink(currentMatch.candidate, platform);
          platformStates.set(
            platform,
            postUrl
              ? { status: "already-linked", postUrl }
              : { status: "preparing" },
          );
        }
        if (socialPlan?.targets.x) {
          platformStates.set("x", { status: "preparing" });
        }
        renderPlatformStates();
        uploadButton.disabled = true;
        matchStatus.textContent = "Connecting this run to Chrome…";
        get("#preparationControls").hidden = false;
        if (targets.length) {
          await activeSession.whenBound;
          if (activeSession.closed)
            throw new Error(
              "The upload connection closed before preparation. Reconnect Chrome and retry.",
            );
          prepareDispatched = true;
          lastAttempt.phase = "preparing";
          matchStatus.textContent =
            "Preparing authenticated platform composers…";
          const response = await sendMessage(
            creatorUploadRequest(value, sessionId, targets),
          );
          if (
            response.uploadSession?.sessionId !== sessionId ||
            !Array.isArray(response.uploadSession.platforms)
          )
            throw new Error(
              "The preparation acknowledgement is invalid. Review this run before retrying; preparation may already exist.",
            );
          activeSession.accepted = true;
          lastAttempt.phase = "accepted";
          teaserInput.disabled = Boolean(teaserFile);
          for (const platform of response.uploadSession.platforms || []) {
            setPlatformState(platform.platform, platform);
          }
          try {
            await rememberPornhubSeriesPreset(value);
          } catch (error) {
            console.warn(
              "Could not remember the Pornhub Season/Arc preset.",
              error,
            );
          }
          matchStatus.textContent =
            "Uploading through the real authenticated pages…";
          const preparedTargets = response.uploadSession.platforms
            .filter((platform) => platform.status === "prepared")
            .map((platform) => platform.platform);
          if (preparedTargets.length) {
            activeSession.startRequested = true;
            lastAttempt.phase = "starting";
            const started = await sendMessage({
              type: "START_CREATOR_UPLOAD",
              sessionId,
              targets: preparedTargets,
            });
            if (started.accepted !== true)
              throw new Error(
                "The start acknowledgement is missing. Review this run; do not repeat Upload.",
              );
            for (const result of started.results || [])
              setPlatformState(result.platform, result);
          }
        }
        if (socialPlan) {
          await activeSession.whenBound;
          prepareDispatched = true;
          const preparedSocial = await sendMessage({
            type: "PREPARE_CREATOR_SOCIAL_DISTRIBUTION",
            plan: socialPlan,
            caption: social.caption,
            subreddits: social.subreddits.map((target) => ({
              ...target,
              title: target.title || social.caption,
            })),
          });
          activeSession.accepted = true;
          for (const [destination, target] of Object.entries(
            preparedSocial.socialDistribution?.targets || {},
          ))
            setPlatformState(destination, target);
          if (social.targets.includes("reddit"))
            get("#redditLinkStep").hidden = false;
          const startedSocial = await sendMessage({
            type: "START_CREATOR_SOCIAL_DISTRIBUTION",
            sessionId: socialPlan.id,
          });
          const xJob = startedSocial.socialDistribution?.jobs?.x;
          applySocialJob(xJob);
          scheduleSocialResume(socialPlan.id, xJob);
        }
        matchStatus.textContent =
          activeSession.startRequested || socialPlan
            ? "Run accepted. Follow the platform results below; Upload will not repeat this run."
            : "Preparation needs attention. Review the platform results before starting another run.";
      } catch (error) {
        const notStarted =
          !prepareDispatched ||
          (activeSession?.accepted !== true &&
            error.uploadAdmission === "not-started");
        lastAttempt = {
          ...lastAttempt,
          phase: notStarted ? "not-started" : "needs-reconciliation",
          error: error.message,
          rejectionCode: error.rejectionCode || "transport-or-preflight-error",
        };
        uploadError.textContent =
          error.message +
          (notStarted
            ? error.recoveryRequired
              ? " Review Upload history before retrying. Your files and details are unchanged."
              : " Your files and details are unchanged. Correct the issue, then click Upload to retry."
            : " This run may already have started. Restore the connection and review its progress or recovery evidence; do not start another upload.");
        if (notStarted) {
          if (activeSession) {
            activeSession.closed = true;
            activeSession.channel?.close();
            activeSession.port?.disconnect();
            activeSession = null;
            for (const platform of targets)
              setPlatformState(platform, {
                status: "not-started",
                error: error.message,
              });
          }
          get("#preparationControls").hidden = true;
          matchStatus.textContent = "Upload did not start.";
          readiness = null;
          recheckAfterFailure = true;
        } else if (activeSession) {
          activeSession.needsReconciliation = true;
          matchStatus.textContent =
            "Run needs attention. Files remain associated with this run.";
        }
        reviewRecovery.hidden = !(error.recoveryRequired || !notStarted);
        refreshReadiness.hidden = !notStarted;
      } finally {
        runBusy = false;
        if (!activeSession) lockDraft(false);
        updateUploadAction();
        if (recheckAfterFailure) void checkReadiness();
      }
    }

    get("#cancelPreparation")?.addEventListener("click", async () => {
      const session = activeSession;
      if (!session) return;
      const button = get("#cancelPreparation");
      button.disabled = true;
      try {
        const response = await sendMessage({
          type: "CANCEL_CREATOR_UPLOAD",
          sessionId: session.id,
        });
        if (response.cancelled !== true)
          throw new Error(
            "The browser did not confirm cancellation. Review the existing run before retrying.",
          );
        if (activeSession !== session) return;
        session.cancelled = true;
        matchStatus.textContent =
          "Preparation stopped. The site may continue an upload already started; drafts and recovery evidence are preserved.";
      } catch (error) {
        uploadError.textContent = error.message;
      } finally {
        button.disabled = false;
        updateUploadAction();
      }
    });
    get("#exportPreparation")?.addEventListener("click", async () => {
      try {
        const result = await sendMessage({
          type: "GET_CREATOR_UPLOAD_RECOVERY",
          sessionId: activeSession?.id,
        });
        get("#preparationDiagnosticsText").textContent = JSON.stringify(
          {
            schemaVersion: 1,
            lastAttempt: lastAttempt
              ? {
                  sessionId: lastAttempt.sessionId,
                  phase: lastAttempt.phase,
                  rejectionCode: lastAttempt.rejectionCode,
                }
              : null,
            records: result.records || [],
            publication: result.publication || [],
          },
          null,
          2,
        );
        get("#preparationDiagnostics").showModal();
      } catch (error) {
        matchStatus.textContent = error.message;
      }
    });
    get("#closePreparationDiagnostics")?.addEventListener("click", () =>
      get("#preparationDiagnostics").close(),
    );
    get("#resetPreparation")?.addEventListener("click", async () => {
      if (runBusy || (activeSession && !activeSession.cancelled)) {
        get("#recoveryStatus").textContent =
          "Stop or finish the current run and review its remote drafts before clearing any preparation evidence.";
        return;
      }
      get("#resetPreparationDialog").showModal();
    });
    get("#closePreparationReset")?.addEventListener("click", () =>
      get("#resetPreparationDialog").close(),
    );
    get("#confirmPreparationReset")?.addEventListener("click", async () => {
      if (
        !window.confirm(
          "Clear all locally saved preparation evidence? This does not alter any remote drafts or durable publication records.",
        )
      )
        return;
      try {
        await sendMessage({
          type: "CLEAR_CREATOR_UPLOAD_PREPARATION",
        });
        get("#resetPreparationDialog").close();
        uploadError.textContent = "";
        matchStatus.textContent =
          "Preparation evidence cleared by your explicit request. Publication records are unchanged.";
        void loadRecovery();
        if (!activeSession) void checkReadiness();
      } catch (error) {
        get("#recoveryStatus").textContent = error.message;
      }
    });
    get("#savePreparationDiagnostics")?.addEventListener("click", () => {
      const blob = new Blob([get("#preparationDiagnosticsText").textContent], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "ofenhancer-preparation-diagnostics.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    async function loadResumePrompt() {
      const prompt = get("#resumePrompt");
      try {
        const response = await sendMessage({
          type: "GET_CREATOR_UPLOAD_RESUMABLE",
        });
        if (activeSession) return;
        resumable = response.resumable || null;
        prompt.hidden = !resumable && !response.pendingRecovery;
        updateUploadAction();
        if (prompt.hidden) return;
        get("#resumeError").textContent = "";
        get("#resumeUpload").hidden = !resumable;
        get("#newFromResume").hidden = false;
        get("#resumeHeading").textContent = resumable
          ? "Resume or New"
          : "Previous upload detected";
        const savedFiles = resumable
          ? [
              ...new Set(
                [
                  resumable.draft.fullFilename,
                  resumable.draft.pornhubFilename,
                ].filter(Boolean),
              ),
            ]
          : [];
        get("#resumeSummary").textContent = resumable
          ? `Detected ${savedFiles.length > 1 ? "videos" : "video"} “${savedFiles.join(" + ") || resumable.draft.title}” in the queue.`
          : `${response.pendingRecovery} previous preparation ${response.pendingRecovery === 1 ? "run is" : "runs are"} saved in upload history.`;
        get("#resumeInstructions").textContent = resumable
          ? "To Resume, reselect the exact saved files. New retires earlier local runs across Upload Hub and the browser extension. Remote drafts and review history remain."
          : "This run cannot be resumed from the saved state. Review any remote draft, then choose New. Earlier local runs will be retired; remote drafts and review history remain.";
      } catch (error) {
        if (activeSession) return;
        prompt.hidden = false;
        updateUploadAction();
        get("#resumeUpload").hidden = true;
        get("#newFromResume").hidden = true;
        get("#resumeHeading").textContent = "Upload recovery unavailable";
        get("#resumeSummary").textContent =
          "The saved upload state could not be checked.";
        get("#resumeInstructions").textContent =
          "Restore the browser connection, then reopen Upload.";
        get("#resumeError").textContent = error.message;
      }
    }

    get("#resumeUpload")?.addEventListener("click", async () => {
      if (!resumable || activeSession || runBusy) return;
      const expected = resumable.draft;
      const selectedPornhub = pornhubFile || fullFile;
      if (
        (expected.fullFilename && fullFile?.name !== expected.fullFilename) ||
        (expected.pornhubFilename &&
          selectedPornhub?.name !== expected.pornhubFilename) ||
        (expected.hasTeaser && !teaserFile) ||
        (expected.manyvidsThumbnail && !thumbnailFile) ||
        (expected.pornhubThumbnail && !thumbnailFile) ||
        !matchesResumeFile(expected.fileProof?.full, fullFile) ||
        !matchesResumeFile(expected.fileProof?.teaser, teaserFile) ||
        !matchesResumeFile(expected.fileProof?.thumbnail, thumbnailFile) ||
        !matchesResumeFile(expected.fileProof?.pornhub, selectedPornhub)
      ) {
        get("#resumeError").textContent =
          "Reselect the exact saved video and any selected preview or thumbnail before resuming.";
        return;
      }
      const button = get("#resumeUpload");
      button.disabled = true;
      get("#resumeError").textContent = "";
      try {
        if (
          thumbnailFile &&
          thumbnailFile.source !== "development-fixture" &&
          thumbnailFile.source !== "catalogue-thumbnail" &&
          (expected.manyvidsThumbnail || expected.pornhubThumbnail)
        )
          await normalizeThumbnailFile(thumbnailFile);
        const targetNames = new Set(
          resumable.platforms.map((target) => target.platform),
        );
        workflowMode.value = "main";
        onlyfans.checked = targetNames.has("onlyfans");
        fansly.checked = targetNames.has("fansly");
        manyvids.checked = targetNames.has("manyvids");
        pornhub.checked = targetNames.has("pornhub");
        mainPublishMode.value = expected.publishMode;
        title.value = expected.title;
        description.value = expected.description;
        releaseDate.value = expected.releaseDate;
        if (
          expected.contentPreset &&
          ![...contentPreset.options].some(
            (option) => option.value === expected.contentPreset,
          )
        )
          contentPreset.add(
            new Option(expected.contentPreset, expected.contentPreset),
          );
        contentPreset.value = expected.contentPreset;
        pornhubVideoType.value = expected.pornhubMode || "free";
        pornhubCertificationsConfirmed.checked =
          expected.pornhubCertificationsConfirmed === true;
        refreshReleaseSummary();
        ++readinessRevision;
        activeSession = connectSession(resumable.id, {
          existing: true,
          files: {
            full: fullFile,
            teaser: teaserFile,
            thumbnail: thumbnailFile,
            pornhub: selectedPornhub,
          },
          proof: {
            fullFilename: expected.fullFilename,
            pornhubFilename: expected.pornhubFilename,
            manyvidsThumbnail: expected.manyvidsThumbnail,
            pornhubThumbnail: expected.pornhubThumbnail,
            pornhubMode: expected.pornhubMode || "free",
            profileSignature: expected.profileSignature,
            fileProof: {
              full: fileResumeProof(fullFile),
              teaser: fileResumeProof(teaserFile),
              thumbnail: fileResumeProof(thumbnailFile),
              pornhub: fileResumeProof(selectedPornhub),
            },
          },
        });
        platformStates.clear();
        for (const target of resumable.platforms)
          platformStates.set(target.platform, target);
        await activeSession.whenBound;
        get("#resumePrompt").hidden = true;
        updateUploadAction();
        get("#preparationControls").hidden = false;
        lockDraft(true);
        renderPlatformStates();
        matchStatus.textContent =
          "Reconnected to the saved upload. Review the platform result before continuing.";
        uploadError.textContent = "";
        updateUploadAction();
      } catch (error) {
        get("#resumeError").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });

    async function loadRecovery() {
      const button = get("#refreshRecovery");
      button.disabled = true;
      get("#recoveryStatus").textContent =
        "Reading preparation and publication history…";
      try {
        const response = await sendMessage({
          type: "GET_CREATOR_UPLOAD_RECOVERY",
        });
        const records = response.records || [],
          publication = response.publication || [];
        const container = get("#recoveryRecords");
        container.replaceChildren();
        for (const record of records) {
          const item = document.createElement("article");
          item.className = "recovery-record";
          const heading = document.createElement("h3");
          heading.textContent = "Previous run " + record.id.slice(-8);
          const detail = document.createElement("p");
          const platforms = [
            ...new Set(
              record.steps.map(
                (step) => PLATFORM_LABELS[step.platform] || step.platform,
              ),
            ),
          ];
          detail.textContent = record.supersededAt
            ? `${platforms.join(" · ")} · previous local run retired. Remote drafts were not changed.`
            : platforms.join(" · ") +
              (record.archivedVersion
                ? " · retained from " + record.archivedVersion
                : "") +
              ". A prepared or uncertain draft may still exist. Inspect the platform drafts before starting New.";
          item.append(heading, detail);
          container.append(item);
        }
        for (const record of publication) {
          const item = document.createElement("p");
          item.className = "error";
          item.textContent =
            (PLATFORM_LABELS[record.platform] || record.platform) +
            " · publication attempt recorded. Recover the existing result; clearing preparation evidence will not permit another publication.";
          container.append(item);
        }
        get("#recoveryStatus").textContent =
          records.length || publication.length
            ? records.filter((record) => !record.supersededAt).length +
              " active preparation run(s), " +
              records.filter((record) => record.supersededAt).length +
              " retired run(s), " +
              publication.length +
              " publication receipt(s). New keeps this history and does not change remote drafts."
            : "No retained preparation or publication records. Files and details in this window are unchanged.";
        get("#resetPreparation").hidden = !records.length;
      } catch (error) {
        get("#recoveryStatus").textContent =
          error.message +
          " Keep existing evidence and restore the browser connection before retrying.";
      } finally {
        button.disabled = false;
      }
    }
    get("#refreshRecovery").addEventListener(
      "click",
      () => void loadRecovery(),
    );
    reviewRecovery.addEventListener("click", () => {
      get("#uploadRecovery").open = true;
      get("#uploadRecovery").scrollIntoView({ block: "start" });
      get("#refreshRecovery").focus();
      void loadRecovery();
    });

    function newUploadDraft() {
      if (activeSession) {
        activeSession.closed = true;
        activeSession.channel?.close();
        activeSession.port?.disconnect();
      }
      activeSession = null;
      resumable = null;
      get("#resumePrompt").hidden = true;
      updateUploadAction();
      templateRevision++;
      lockDraft(false);
      leaveNeutralTest();
      neutralTestFiles = null;
      selectedCatalogueRow = null;
      manualTargets = null;
      currentSnapshot = null;
      snapshotPromise = null;
      clearTimeout(socialPollTimer);
      clearTimeout(matchTimer);
      platformStates.clear();
      renderPlatformStates();
      for (const input of [
        fullInput,
        teaserInput,
        thumbnailInput,
        pornhubInput,
        socialInput,
      ]) {
        input.disabled = false;
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      title.value = "";
      description.value = "";
      pornhubVideoType.value = "free";
      pornhubCertificationsConfirmed.checked = true;
      socialCaption.value = "";
      socialCustomPaidLink.value = "";
      releaseDate.value = nextFridayUtc(new Date(), timeZone).releaseDate;
      refreshReleaseSummary();
      workflowMode.value = "main";
      mainPublishMode.value = "manual";
      catalogueAssociation.value = "later";
      uploadWithoutSheet = true;
      for (const target of [onlyfans, fansly, manyvids, pornhub])
        target.checked = target.defaultChecked;
      socialX.checked = false;
      socialReddit.checked = false;
      get('input[name="socialMode"][value="manual"]').checked = true;
      get('input[name="socialMode"][value="autonomous"]').checked = false;
      lastAttempt = null;
      if (workflowMode) workflowMode.disabled = neutralTestMode;
      if (catalogueAssociation) catalogueAssociation.disabled = neutralTestMode;
      mainPublishMode.disabled = neutralTestMode;
      contentPreset.disabled = neutralTestMode;
      get("#preparationControls").hidden = true;
      get("#savedCatalogueAssociation").hidden = true;
      get("#redditLinkStep").hidden = true;
      updateWorkflowVisibility();
      refreshSocialReview();
      invalidateMatch();
      scheduleMatch();
      get("#neutralTestStatus").textContent =
        "New upload ready. Earlier local sessions are retired; review history is preserved.";
    }

    async function startNewUpload() {
      if (runBusy)
        throw new Error(
          "Wait for the current Upload request to finish connecting, then start New.",
        );
      const reset = await sendMessage({ type: "START_NEW_CREATOR_UPLOAD" });
      if (!reset.reset)
        throw new Error("The previous upload state could not be retired.");
      newUploadDraft();
      void loadRecovery();
    }
    for (const id of ["#newUploadDraft", "#newFromResume"])
      get(id)?.addEventListener("click", async () => {
        const button = get(id);
        button.disabled = true;
        get("#resumeError").textContent = "";
        try {
          await startNewUpload();
        } catch (error) {
          get("#neutralTestStatus").textContent = error.message;
          get("#resumeError").textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });

    function applyNeutralTestPreset() {
      if (activeSession)
        throw new Error(
          "Finish or stop the current preparation, then start a new draft before loading a test preset. Existing uploads were not changed.",
        );
      if (!neutralTestFiles) throw new Error("Click Load Template again.");
      neutralTestMode = true;
      workflowMode.value = "main";
      workflowMode.disabled = true;
      mainPublishMode.value = "manual";
      mainPublishMode.disabled = true;
      catalogueAssociation.value = "later";
      catalogueAssociation.disabled = true;
      uploadWithoutSheet = true;
      if (
        ![...contentPreset.options].some(
          (option) => option.value === NEUTRAL_TEST_PRESET,
        )
      )
        contentPreset.add(new Option(NEUTRAL_TEST_PRESET, NEUTRAL_TEST_PRESET));
      contentPreset.value = NEUTRAL_TEST_PRESET;
      contentPreset.disabled = true;
      pornhubVideoType.value = "free";
      pornhubVideoType.disabled = true;
      pornhubCertificationsConfirmed.checked = true;
      title.value = "Neutral upload verification";
      description.value = "Neutral upload verification. Unpublished test.";
      releaseDate.value = nextFridayUtc(new Date(), timeZone).releaseDate;
      fullFile = neutralTestFiles.fullFile;
      teaserFile = neutralTestFiles.teaserFile;
      thumbnailFile = neutralTestFiles.thumbnailFile;
      pornhubFile = null;
      for (const input of [
        fullInput,
        teaserInput,
        thumbnailInput,
        pornhubInput,
      ])
        input.value = "";
      selectedCatalogueRow = null;
      manualTargets = null;
      renderFilePickers();
      for (const control of [onlyfans, fansly, manyvids, pornhub])
        control.checked = true;
      socialX.checked = false;
      socialReddit.checked = false;
      get("#neutralTestStatus").textContent =
        "Template loaded · unpublished preparation only.";
      updateWorkflowVisibility();
      refreshReleaseSummary();
      invalidateMatch();
      scheduleMatch();
    }
    function leaveNeutralTest() {
      if (activeSession)
        throw new Error("Start a new draft before changing test mode.");
      neutralTestMode = false;
      for (const control of [
        workflowMode,
        mainPublishMode,
        catalogueAssociation,
        contentPreset,
        pornhubVideoType,
      ])
        control.disabled = false;
      for (const option of [...contentPreset.options])
        if (option.value === NEUTRAL_TEST_PRESET) option.remove();
      contentPreset.value = "";
      get("#neutralTestStatus").textContent =
        "Saved presets restored for this draft. Previously chosen test files remain selected; nothing was uploaded.";
      scheduleMatch();
    }
    get("#loadTemplate")?.addEventListener("click", async () => {
      const button = get("#loadTemplate");
      button.disabled = true;
      try {
        if (runBusy)
          throw new Error(
            "Wait for the current Upload request to finish connecting, then load the template.",
          );
        if (activeSession) await startNewUpload();
        const revision = templateRevision;
        const files = globalThis.OFEnhancerDesktopUpload
          ? await globalThis.OFEnhancerDesktopUpload.loadDevelopmentFixtures()
          : (await sendMessage({ type: "LOAD_DEVELOPMENT_TEMPLATE" })).files;
        if (activeSession || runBusy || revision !== templateRevision)
          throw new Error(
            "The draft changed while loading. Click Load Template again.",
          );
        neutralTestFiles = neutralTestSelection(files);
        applyNeutralTestPreset();
      } catch (error) {
        get("#neutralTestStatus").textContent =
          /extension-not-admitted|Connect the current personal extension/i.test(
            error.message,
          )
            ? "Load Template needs the current Chrome extension. Reload Creator Workflow Toolkit in Chrome, reopen Upload Hub, and try again."
            : error.message;
      } finally {
        button.disabled = false;
      }
    });

    function updateMediaRelevance() {
      const targets = new Set(selectedTargets());
      const files = [teaserFile, thumbnailFile, pornhubFile];
      const rows = [...document.querySelectorAll("[data-media-for]")];
      let relevant = 0;
      rows.forEach((row, index) => {
        const used = row.dataset.mediaFor
          .split(" ")
          .some(
            (target) =>
              targets.has(target) &&
              (index !== 1 ||
                target !== "pornhub" ||
                pornhubVideoType.value === "free"),
          );
        row.hidden = !used && !files[index];
        row.dataset.inactive = String(!used);
        if (!row.hidden) relevant++;
      });
      get("#optionalMedia").hidden = !relevant;
      if (!relevant || thumbnailInput.closest("[data-media-for]").hidden) {
        catalogueThumbnails.hidden = true;
        catalogueThumbnailHint.textContent = "";
      }
      const selected = files.filter(Boolean).length;
      if (selected > optionalSelectionCount) get("#optionalMedia").open = true;
      optionalSelectionCount = selected;
      get("#optionalMediaCount").textContent = selected
        ? "· " + selected + " selected"
        : "";
      get("#pornhubPresetFields").hidden = !targets.has("pornhub");
    }

    function renderFilePickers() {
      for (const button of catalogueThumbnailChoices.querySelectorAll(
        "[data-asset-id]",
      ))
        button.setAttribute(
          "aria-pressed",
          String(thumbnailFile?.assetId === button.dataset.assetId),
        );
      for (const [input, file, summary, empty] of [
        [fullInput, fullFile, "fullFileSummary", "Choose the main video"],
        [
          teaserInput,
          teaserFile,
          "teaserFileSummary",
          "Fansly and ManyVids preview",
        ],
        [
          thumbnailInput,
          thumbnailFile,
          "manyvidsThumbnailSummary",
          "Center-cropped to 640 × 360 for ManyVids and Pornhub",
        ],
        [
          pornhubInput,
          pornhubFile,
          "pornhubFileSummary",
          "Uses the full video unless replaced",
        ],
        [
          socialInput,
          socialFile,
          "socialFileSummary",
          "Choose a video for social posts",
        ],
      ]) {
        get("#" + summary).textContent = fileSummary(file, empty);
        get("#" + summary + "Size").textContent = file
          ? file.size >= 1000 ** 3
            ? (file.size / 1000 ** 3).toFixed(2) + " GB"
            : file.size >= 1000 ** 2
              ? (file.size / 1000 ** 2).toFixed(1) + " MB"
              : Math.max(1, Math.round(file.size / 1000)) + " KB"
          : "";
        const choose = document.querySelector(
          '[data-choose-file="' + input.id + '"]',
        );
        const remove = document.querySelector(
          '[data-remove-file="' + input.id + '"]',
        );
        choose.textContent = file ? "Replace" : "Choose file";
        choose.disabled = input.disabled;
        remove.hidden = !file;
        remove.disabled = input.disabled;
      }
      updateMediaRelevance();
    }
    for (const button of document.querySelectorAll("[data-choose-file]"))
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.chooseFile);
        if (!input.disabled) input.click();
      });
    for (const button of document.querySelectorAll("[data-remove-file]"))
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.removeFile);
        if (input.disabled) return;
        templateRevision++;
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    const fileControlObserver = new MutationObserver(renderFilePickers);
    for (const input of [
      fullInput,
      teaserInput,
      thumbnailInput,
      pornhubInput,
      socialInput,
    ])
      fileControlObserver.observe(input, {
        attributes: true,
        attributeFilter: ["disabled"],
      });

    fullInput.addEventListener("change", () => {
      fullFile = fullInput.files?.[0] || null;
      selectedCatalogueRow = null;
      manualTargets = null;
      get("#fullFileSummary").textContent = fileSummary(
        fullFile,
        "Choose the main video",
      );
      if (fullFile && !title.value.trim())
        title.value = titleFromFilename(fullFile.name);
      if (fullFile && !socialCaption.value.trim()) {
        socialCaption.value = title.value;
      }
      scheduleMatch();
    });
    function updateWorkflowVisibility() {
      const teaserOnly = workflowMode?.value === "teaser";
      get(".draft-card").hidden = teaserOnly;
      get("#mainDestinations").hidden = teaserOnly;
      get("#mainPublishFields").hidden = teaserOnly;
      get(".social-card").hidden = workflowMode?.value === "main";
      fullInput.required = !teaserOnly;
      if (teaserOnly) showAllCatalogue.checked = true;
      updateMediaRelevance();
    }
    workflowMode?.addEventListener("change", () => {
      updateWorkflowVisibility();
      refreshSocialReview();
      scheduleMatch();
    });
    mainPublishMode?.addEventListener("change", scheduleMatch);
    catalogueAssociation?.addEventListener("change", () => {
      uploadWithoutSheet = catalogueAssociation.value === "later";
      scheduleMatch();
    });
    get("#prepareRedditLinks")?.addEventListener("click", async () => {
      const button = get("#prepareRedditLinks");
      if (!activeSession?.socialSessionId) return;
      button.disabled = true;
      try {
        const response = await sendMessage({
          type: "PREPARE_CREATOR_REDDIT_LINKS",
          sessionId: activeSession.socialSessionId,
          redgifsUrl: get("#redditWatchUrl").value.trim(),
        });
        for (const [destination, target] of Object.entries(
          response.socialDistribution?.targets || {},
        ))
          setPlatformState(destination, target);
        get("#redditLinkStatus").textContent =
          "Links filled. Review each Reddit draft before publishing.";
      } catch (error) {
        get("#redditLinkStatus").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    let associationSnapshot = null;
    get("#loadAssociationRows")?.addEventListener("click", async () => {
      try {
        associationSnapshot = await loadCatalogueSnapshot({ refresh: true });
        const select = get("#savedCatalogueRow");
        select.replaceChildren(new Option("Choose an entry", ""));
        for (const row of associationSnapshot.rows)
          select.append(new Option(row.title || row.id, String(row.row)));
        get("#savedAssociationStatus").textContent =
          "Choose the entry for the saved results.";
      } catch (error) {
        get("#savedAssociationStatus").textContent = error.message;
      }
    });
    get("#savedCatalogueRow")?.addEventListener("change", () => {
      get("#associateSavedResults").disabled = !get("#savedCatalogueRow").value;
    });
    get("#associateSavedResults")?.addEventListener("click", async () => {
      const row = associationSnapshot?.rows.find(
        (candidate) =>
          Number(candidate.row) === Number(get("#savedCatalogueRow").value),
      );
      if (!row || !activeSession) return;
      const button = get("#associateSavedResults");
      button.disabled = true;
      try {
        if (selectedTargets().length)
          await sendMessage({
            type: "ASSOCIATE_CREATOR_UPLOAD_CATALOGUE",
            sessionId: activeSession.id,
            catalogue: row,
          });
        if (activeSession.socialSessionId) {
          const response = await sendMessage({
            type: "ASSOCIATE_CREATOR_SOCIAL_CATALOGUE",
            sessionId: activeSession.socialSessionId,
            catalogue: row,
          });
          applySocialJob(response.socialDistribution?.jobs?.x);
        }
        get("#savedAssociationStatus").textContent =
          "Association saved. No uploads or publications were repeated.";
      } catch (error) {
        get("#savedAssociationStatus").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    teaserInput.addEventListener("change", () => {
      const selected = teaserInput.files?.[0] || null;
      if (activeSession?.files.teaser) return;
      teaserFile = selected;
      if (activeSession && teaserFile) {
        activeSession.files.teaser = teaserFile;
        activeSession.fileProof.teaser = fileIdentity(teaserFile);
        teaserInput.disabled = true;
      }
      get("#teaserFileSummary").textContent = fileSummary(
        teaserFile,
        "Fansly and ManyVids preview",
      );
      flushPendingTeaser();
      if (!activeSession) scheduleMatch();
    });
    thumbnailInput.addEventListener("change", () => {
      autoThumbnailAssetId = null;
      thumbnailFile = thumbnailInput.files?.[0] || null;
      if (thumbnailFile && !catalogueThumbnails.hidden)
        catalogueThumbnailStatus.textContent = `Using ${thumbnailFile.name}.`;
      renderFilePickers();
      get("#manyvidsThumbnailSummary").textContent = fileSummary(
        thumbnailFile,
        "Center-cropped to 640 × 360 for ManyVids and Pornhub",
      );
      if (!activeSession) scheduleMatch();
    });
    loadCatalogueThumbnails.addEventListener("click", () => {
      if (thumbnailCatalogueId)
        void loadThumbnailChoices(thumbnailCatalogueId, true);
    });
    pornhubInput.addEventListener("change", () => {
      pornhubFile = pornhubInput.files?.[0] || null;
      get("#pornhubFileSummary").textContent = fileSummary(
        pornhubFile,
        "Uses the full video unless replaced",
      );
      if (!activeSession) scheduleMatch();
    });
    socialInput.addEventListener("change", () => {
      socialFile = socialInput.files?.[0] || null;
      get("#socialFileSummary").textContent = fileSummary(
        socialFile,
        "Choose a video for social posts",
      );
      refreshSocialReview();
    });
    for (const input of [
      fullInput,
      teaserInput,
      thumbnailInput,
      pornhubInput,
      socialInput,
    ])
      input.addEventListener("change", renderFilePickers);
    renderFilePickers();
    socialCaption.addEventListener("input", refreshSocialReview);
    for (const control of [socialX, socialReddit]) {
      control.addEventListener("change", () => {
        if (socialReddit.checked && !subredditSnapshot) {
          void loadSubredditPresets();
        }
        refreshSocialReview();
      });
    }
    socialPaidLink.addEventListener("change", () => {
      socialCustomPaidLinkField.hidden = socialPaidLink.value !== "custom";
      refreshSocialReview();
    });
    socialCustomPaidLink.addEventListener("input", refreshSocialReview);
    for (const control of document.querySelectorAll(
      'input[name="socialMode"]',
    )) {
      control.addEventListener("change", () => {
        applyPresetMode();
        refreshSocialReview();
      });
    }
    for (const tab of [uploaderTab, settingsTab]) {
      tab.addEventListener("click", () => selectWorkspaceTab(tab));
      tab.addEventListener("keydown", handleWorkspaceTabKey);
    }
    for (const control of Object.values(workflowControls)) {
      control.addEventListener("change", markWorkflowSettingsDirty);
    }
    workflowProfilesInput.addEventListener("input", markWorkflowSettingsDirty);
    saveWorkflowSettingsButton.addEventListener("click", () => {
      void saveWorkflowSettingsPanel();
    });
    resetWorkflowProfilesButton.addEventListener(
      "click",
      resetWorkflowProfiles,
    );
    clearWorkflowHistoryButton.addEventListener("click", () => {
      void clearWorkflowHistory().catch((error) =>
        showWorkflowSettingsStatus(error.message, "error"),
      );
    });
    workflowSettingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    refreshSubreddits.addEventListener("click", async () => {
      refreshSubreddits.disabled = true;
      await loadSubredditPresets({ refresh: true });
      refreshSubreddits.disabled = false;
    });
    subredditSearch.addEventListener("input", filterSubredditPresets);
    for (const control of [
      title,
      description,
      releaseDate,
      contentPreset,
      pornhubVideoType,
      pornhubCertificationsConfirmed,
    ]) {
      control.addEventListener("input", scheduleMatch);
    }
    pornhubVideoType.addEventListener("change", () => {
      scheduleMatch();
    });
    for (const control of [onlyfans, fansly, manyvids, pornhub]) {
      control.addEventListener("change", () => {
        if (selectedCatalogueRow !== null) {
          manualTargets = new Set(selectedTargets());
        }
        scheduleMatch();
      });
    }
    uploadButton.addEventListener("click", () => startUpload());
    catalogueSearch.addEventListener("input", () => {
      catalogueCardLimit = 18;
      renderPicker();
    });
    showAllCatalogue.addEventListener("change", () => {
      catalogueCardLimit = 18;
      renderPicker();
    });
    showMoreCatalogue.addEventListener("click", () => {
      catalogueCardLimit += 18;
      renderPicker();
    });
    catalogueRow.addEventListener("change", () => {
      const value = catalogueRow.value;
      if (!value) return;
      selectedCatalogueRow = value === "new" ? "new" : Number(value.slice(4));
      manualTargets = null;
      const proposal = buildProposal(selectedCatalogueRow);
      applyProposal(
        proposal,
        selectedCatalogueRow === "new" ? "new" : "matched",
      );
      renderPicker();
    });
    refreshCatalogue.addEventListener("click", async () => {
      refreshCatalogue.disabled = true;
      matchStatus.textContent = "Refreshing the catalogue snapshot…";
      try {
        currentSnapshot = await loadCatalogueSnapshot({ refresh: true });
        const proposal = buildProposal(selectedCatalogueRow);
        if (proposal.status === "needs-selection") {
          currentProposal = proposal;
          renderPicker();
          matchStatus.textContent =
            "Catalogue refreshed. Choose the exact episode.";
        } else {
          applyProposal(
            proposal,
            selectedCatalogueRow === "new" ? "new" : "matched",
          );
          renderPicker();
        }
      } catch (error) {
        matchStatus.textContent = error.message;
      } finally {
        refreshCatalogue.disabled = false;
      }
    });
    continueWithoutSheet.addEventListener("click", () => {
      if (activeSession) return;
      clearTimeout(matchTimer);
      invalidateMatch();
      const value = validate(true);
      if (!value.valid) return;
      uploadWithoutSheet = true;
      if (catalogueAssociation) catalogueAssociation.value = "later";
      previewWithoutSheet(value);
    });
    changeCatalogueEntry.addEventListener("click", () => {
      if (runBusy || activeSession) return;
      currentMatch = null;
      readiness = null;
      ++readinessRevision;
      updateUploadAction();
      renderPicker();
      matchStatus.textContent =
        "Choose another catalogue episode or a new entry.";
      catalogueSearch.focus();
    });
    globalThis.addEventListener("beforeunload", (event) => {
      if (
        fullFile ||
        teaserFile ||
        thumbnailFile ||
        pornhubFile ||
        socialFile
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    globalThis.addEventListener("pagehide", () => {
      if (activeSession) activeSession.closed = true;
      activeSession?.port?.disconnect();
      activeSession?.channel?.close();
    });

    const actionResize = new ResizeObserver(() => {
      const height = get("#uploadActions").getBoundingClientRect().height;
      if (height)
        document.documentElement.style.setProperty(
          "--upload-action-height",
          height + "px",
        );
    });
    actionResize.observe(get("#uploadActions"));
    refreshReadiness.addEventListener("click", () => {
      if (runBusy || activeSession) return;
      uploadError.textContent = "";
      if (currentMatch) void checkReadiness();
      else scheduleMatch();
    });
    updateWorkflowVisibility();
    void globalThis.CreatorCatalogueClient?.loadConfig?.()
      .then((config) => {
        get("#catalogueConnectionStatus").textContent = config.connected
          ? "Catalogue matching is available when you choose an entry."
          : "Catalogue matching is optional.";
      })
      .catch(() => {
        get("#catalogueConnectionStatus").textContent =
          "Catalogue matching is optional.";
      });
    refreshReleaseSummary();
    refreshSocialReview();
    loadWorkflowSettingsPanel()
      .then(() => scheduleMatch())
      .catch((error) => {
        matchStatus.textContent = error.message;
      });
    void loadResumePrompt();
    validate();
  }

  globalThis.CreatorUploadConsole = Object.freeze({
    buildSocialDistributionPlan,
    nextFridayUtc,
    nextFridayLocalValue,
    learnSeriesPresetMap,
    normalizeDraft,
    neutralTestSelection,
    normalizeThumbnailFile,
    neutralTestProfiles,
    normalizeSocialDraft,
    profileAuthorizationSummary,
    proposalSignature,
    scheduledIsoForReleaseDate,
    titleFromFilename,
    validateDraft,
  });
  if (typeof document !== "undefined") mount();
})();
