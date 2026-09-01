"use strict";

(() => {
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
        ? mimeType.startsWith("image/")
        : IMAGE_EXTENSIONS.test(String(file.name || ""))),
    );
  }

  function scheduledIsoForReleaseDate(releaseDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(releaseDate || ""))) return "";
    const scheduled = new Date(`${releaseDate}T15:00:00.000Z`);
    return !Number.isNaN(scheduled.getTime()) && scheduled.getUTCDay() === 5
      ? scheduled.toISOString()
      : "";
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
    fullFile,
    teaserFile = null,
    thumbnailFile = null,
    pornhubFile = null,
    title,
    description,
    scheduledIso,
    targets,
    contentPreset = "",
  } = {}) {
    const errors = [];
    const selectedTargets = Array.isArray(targets)
      ? [...new Set(targets)].filter((target) => TARGETS.has(target))
      : [];
    const separatePornhubFileIsEnough =
      selectedTargets.length === 1 &&
      selectedTargets[0] === "pornhub" &&
      isVideoFile(pornhubFile);
    if (!separatePornhubFileIsEnough && !isVideoFile(fullFile)) {
      errors.push("Choose a non-empty full video.");
    }
    if (teaserFile && !isVideoFile(teaserFile)) {
      errors.push("Choose a non-empty teaser video or leave it blank.");
    }
    if (thumbnailFile && !isImageFile(thumbnailFile)) {
      errors.push("Choose a PNG or JPEG ManyVids thumbnail or leave it blank.");
    }
    if (pornhubFile && !isVideoFile(pornhubFile)) {
      errors.push("Choose a non-empty Pornhub video or leave it blank.");
    }
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) errors.push("Enter a catalogue title.");
    const scheduled = new Date(scheduledIso);
    if (
      !String(scheduledIso || "").trim() ||
      Number.isNaN(scheduled.getTime()) ||
      scheduled.getUTCDay() !== 5 ||
      scheduled.getUTCHours() !== 15
    ) {
      errors.push("Choose a Friday; publication time is fixed at 15:00 UTC.");
    }
    if (!selectedTargets.length || selectedTargets.length !== targets?.length) {
      errors.push(
        "Choose OnlyFans, Fansly, ManyVids, Pornhub, or a combination.",
      );
    }
    if (selectedTargets.includes("manyvids") && !isVideoFile(teaserFile)) {
      errors.push("Choose a non-empty ManyVids teaser video.");
    }
    const cleanPreset = String(contentPreset || "").trim();
    if (selectedTargets.includes("pornhub") && !cleanPreset) {
      errors.push("Choose an exact Pornhub content preset.");
    }
    return {
      valid: errors.length === 0,
      errors,
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
      !Number.isInteger(Number(catalogue?.row)) ||
      Number(catalogue?.row) < 2 ||
      !String(catalogue?.id || "").trim() ||
      !String(catalogue?.title || "").trim() ||
      !/^[a-f0-9]{8,64}$/i.test(String(catalogue?.fingerprint || ""))
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
    if (selectedTargets.includes("reddit")) {
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
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Extension request failed."));
          return;
        }
        resolve(response);
      });
    });
  }

  function mount() {
    const get = (selector) => document.querySelector(selector);
    const fullInput = get("#uploadFullVideo");
    const teaserInput = get("#uploadTeaser");
    const thumbnailInput = get("#uploadManyvidsThumbnail");
    const pornhubInput = get("#uploadPornhubVideo");
    const contentPreset = get("#contentPreset");
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
    const confirmation = get("#confirmation");
    const confirmationNotice = get("#confirmationNotice");
    const matchBadge = get("#matchBadge");
    const matchQuestion = get("#matchQuestion");
    const uploadSummary = get("#uploadSummary");
    const confirmUpload = get("#confirmUpload");
    const rejectMatch = get("#rejectMatch");
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
    let pornhubFile = null;
    let socialFile = null;
    let matchTimer = null;
    let matchRevision = 0;
    let currentMatch = null;
    let currentProposal = null;
    let currentSnapshot = null;
    let snapshotPromise = null;
    let selectedCatalogueRow = null;
    let manualTargets = null;
    let uploadWithoutSheet = false;
    let activeSession = null;
    let socialPollTimer = null;
    let workflowProfiles = null;
    let profilesLoaded = false;
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
      const settings = await globalThis.CreatorToolkit.loadSettings();
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
      return [
        onlyfans.checked ? "onlyfans" : "",
        fansly.checked ? "fansly" : "",
        manyvids.checked ? "manyvids" : "",
        pornhub.checked ? "pornhub" : "",
      ].filter(Boolean);
    }

    function selectedSocialTargets() {
      return [
        socialX.checked ? "x" : "",
        socialReddit.checked ? "reddit" : "",
      ].filter(Boolean);
    }

    function selectedSocialMode() {
      return get('input[name="socialMode"]:checked')?.value || "manual";
    }

    function selectedRunTargets() {
      return [...selectedTargets(), ...(socialX.checked ? ["x"] : [])];
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
      const paid = currentPaidLink();
      const value = normalizeSocialDraft({
        file: socialFile,
        caption: socialCaption.value,
        paidUrl: paid.paidUrl,
        paidLinkSource: paid.paidLinkSource,
        mode: selectedSocialMode(),
        targets: selectedSocialTargets(),
        subreddits: selectedSubreddits(),
        catalogue: candidate,
        evidence: socialEvidence(),
      });
      const readiness = globalThis.CreatorSocialDistributionRuntimeReady;
      const runtimeReady =
        readiness === true ||
        (Boolean(readiness) &&
          (!value.targets.includes("x") || readiness.x === true) &&
          (!value.targets.includes("reddit") ||
            (readiness.redgifs === true && readiness.reddit === true)));
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
      checkbox.checked = lastSubredditSelection.includes(
        preset.subreddit.toLowerCase(),
      );
      const summary = document.createElement("span");
      summary.className = "subreddit-preset-summary";
      const name = document.createElement("strong");
      name.textContent = preset.subreddit;
      const details = document.createElement("small");
      details.textContent = [preset.status, preset.notes]
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
      const presets = subredditSnapshot?.presets || [];
      if (!presets.length) {
        subredditStatus.textContent =
          "No subreddit presets are available in 2026 uploads Y:AA.";
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
          autonomous && row.dataset.status !== "Approved";
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
        "Subreddit presets changed. Review the refreshed settings and click Yes again.",
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
          "Recorded-flow evidence is ready. The final plan still waits for the one Yes confirmation.";
      if (currentMatch) renderMatch(currentMatch);
    }

    function catalogueLink(candidate, platform) {
      return String(candidate?.[`${platform}Link`] || "").trim();
    }

    function pendingTargets(value, match = currentMatch) {
      return value.targets.filter(
        (platform) => !catalogueLink(match?.candidate, platform),
      );
    }

    function draft() {
      const value = normalizeDraft({
        fullFile,
        teaserFile,
        thumbnailFile,
        pornhubFile,
        title: title.value,
        description: description.value,
        scheduledIso: scheduledIsoForReleaseDate(releaseDate.value),
        targets: selectedTargets(),
        contentPreset: contentPreset.value,
      });
      if (!value.targets.length && selectedSocialTargets().length) {
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
      const profiles = {
        fanslyPrefill: structuredClone(workflowProfiles.fanslyPrefill),
        manyvidsAutofill: structuredClone(workflowProfiles.manyvidsAutofill),
        phUploader: structuredClone(workflowProfiles.phUploader),
      };
      if (
        value.targets.includes("pornhub") &&
        !Object.hasOwn(profiles.phUploader.presets, value.contentPreset)
      ) {
        value.errors.push(
          "The selected Pornhub content preset is unavailable.",
        );
        value.valid = false;
      }
      value.fanslyCaption =
        globalThis.CreatorToolkitAdapters?.fanslyPrefill?.composeMasterCaption(
          value.description,
          profiles.fanslyPrefill.message,
        ) ?? value.description;
      value.profiles = profiles;
      value.profileSignature = JSON.stringify(profiles);
      return value;
    }

    async function refreshProfiles() {
      const settings = await globalThis.CreatorToolkit.loadSettings();
      workflowProfiles = settings.profiles;
      profilesLoaded = true;
      return JSON.stringify({
        fanslyPrefill: workflowProfiles.fanslyPrefill,
        manyvidsAutofill: workflowProfiles.manyvidsAutofill,
        phUploader: workflowProfiles.phUploader,
      });
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
      return file
        ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB · kept only in this tab`
        : emptyText;
    }

    function invalidateMatch() {
      currentMatch = null;
      currentProposal = null;
      confirmation.hidden = true;
      cataloguePicker.hidden = true;
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
      catalogueRow.append(addNew);
      if (selectedCatalogueRow === "new") catalogueRow.value = "new";
      else if (Number.isInteger(selectedCatalogueRow)) {
        catalogueRow.value = `row:${selectedCatalogueRow}`;
      }
      cataloguePicker.hidden = false;
    }

    function buildProposal(selectedRow = null) {
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
      if (!candidate) {
        currentMatch = null;
        confirmation.hidden = true;
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
          ? "Pornhub metadata preparation was added from an exact content preset. File assignment and final Submit remain manual."
          : "Pornhub is recommended from the empty catalogue link. Choose an exact content preset to add its trace-gated metadata step."
        : "";
      selectedCatalogueReason.textContent = proposalReason(proposal);
      currentMatch = { status: catalogueStatus, candidate };
      matchStatus.textContent = `Catalogue row ${candidate.row} is the strongest deterministic proposal.`;
      renderMatch(currentMatch);
      if (proposal.status !== "ready") {
        confirmUpload.disabled = true;
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
          matchQuestion.textContent = `${unverified.join(" and ")} queue${unverified.length === 1 ? " is" : "s are"} not verified yet.`;
        } else if (proposal.status === "not-executable") {
          matchQuestion.textContent =
            "The missing platform is recommended but not executable yet.";
        }
      }
    }

    function summaryRow(label, value) {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      uploadSummary.append(term, detail);
    }

    function renderMatch(match) {
      const candidate = match.candidate;
      if (!socialCaption.value.trim() && candidate.title) {
        socialCaption.value = candidate.title;
      }
      renderPaidLinkOptions(candidate);
      const social = socialDraft(candidate);
      const uploadOnly = match.status === "upload-only";
      matchBadge.textContent = uploadOnly
        ? "Upload without sheet"
        : currentProposal
          ? `Row ${candidate.row} proposed`
          : match.status === "matched"
            ? `Row ${candidate.row} matched`
            : `New row ${candidate.row}`;
      matchQuestion.textContent = uploadOnly
        ? `Upload and schedule “${candidate.title}” on the selected platforms?`
        : currentProposal
          ? `Likely episode: “${candidate.title}”. Upload to the missing executable platforms?`
          : match.status === "matched"
            ? `Is this your video from the sheet: “${candidate.title}”?`
            : `No credible existing episode matched. Create row ${candidate.row} for “${candidate.title}”?`;
      rejectMatch.textContent = currentProposal
        ? "No"
        : match.status === "matched"
          ? "No, use a new row"
          : "No, edit details";
      uploadSummary.replaceChildren();
      const value = draft();
      const authorization = profileAuthorizationSummary(
        value.profiles,
        value.contentPreset,
      );
      summaryRow(
        "Catalogue",
        uploadOnly
          ? "Not connected · existing sheet links will not be checked"
          : `2026 Video Catalogue row ${candidate.row} · ${candidate.id}`,
      );
      summaryRow(
        "Release",
        `${currentProposal ? releaseDate.value : candidate.releaseDate} · 15:00 UTC`,
      );
      summaryRow(
        "Full video",
        fullFile?.name || "Not selected · separate Pornhub video only",
      );
      if (selectedTargets().includes("fansly")) {
        const existing = catalogueLink(candidate, "fansly");
        if (existing) summaryRow("Fansly", `Already linked · ${existing}`);
        else {
          summaryRow(
            "Fansly teaser",
            teaserFile?.name || "Will wait for you to choose it",
          );
          summaryRow(
            "Fansly access",
            "Full locked with preset defaulT · teaser attached as Free Preview",
          );
          summaryRow("Fansly caption", value.fanslyCaption || "Empty");
          summaryRow("Fansly saved toggles", authorization.fansly);
        }
      }
      if (selectedTargets().includes("onlyfans")) {
        const existing = catalogueLink(candidate, "onlyfans");
        summaryRow(
          "OnlyFans",
          existing
            ? `Already linked · ${existing}`
            : "Full upload · labels left completely unchanged",
        );
      }
      if (selectedTargets().includes("manyvids")) {
        const existing = catalogueLink(candidate, "manyvids");
        summaryRow(
          "ManyVids",
          existing
            ? `Already linked · ${existing}`
            : `Full + ${teaserFile?.name || "teaser required"} preview · $${value.profiles.manyvidsAutofill.price} · ${thumbnailFile?.name || "site-generated thumbnail"}`,
        );
        if (!existing) {
          summaryRow("ManyVids saved recipe", authorization.manyvids);
        }
      }
      if (selectedTargets().includes("pornhub")) {
        const existing = catalogueLink(candidate, "pornhub");
        summaryRow(
          "Pornhub",
          existing
            ? `Already linked · ${existing}`
            : `${pornhubFile?.name || fullFile.name} · ${contentPreset.value || "preset required"} · metadata only; file and final Submit remain manual`,
        );
        if (!existing) {
          summaryRow("Pornhub saved preset", authorization.pornhub);
        }
      }
      if (social.enabled) {
        summaryRow(
          "Social teaser",
          socialFile?.name || "Social teaser required",
        );
        summaryRow(
          "Social mode",
          social.mode === "autonomous"
            ? "Autonomous after this Yes"
            : "Fill and upload, then stop before final publish",
        );
        summaryRow("Social caption", social.caption);
        if (social.targets.includes("x")) {
          summaryRow(
            "X",
            social.paidLink?.kind === "upload-result"
              ? `Caption + teaser · first reply uses the new ${social.paidLink.platform} link from this run`
              : `Caption + teaser · first reply ${social.paidLink?.url || "needs a paid link"}`,
          );
        }
        if (social.targets.includes("reddit")) {
          if (!social.subreddits.length) {
            summaryRow("Reddit", "Choose at least one subreddit");
          }
          for (const target of social.subreddits) {
            summaryRow(
              `Reddit · r/${target.subreddit}`,
              [
                `Title: ${target.title || social.caption}`,
                `Body: ${target.body || "Empty"}`,
                `Flair: ${target.flair || "None"}`,
                `NSFW: ${target.nsfw ? "Yes" : "No"}`,
              ].join(" · "),
            );
          }
        }
      }
      summaryRow("Description", description.value.trim() || "Empty");
      summaryRow(
        "Sheet cells",
        uploadOnly
          ? "None · post links will appear here when captured"
          : [
              match.status === "new"
                ? `A${candidate.row}:D${candidate.row}`
                : "Existing metadata unchanged",
              selectedTargets().includes("onlyfans")
                ? `J${candidate.row} if empty`
                : "",
              selectedTargets().includes("fansly")
                ? `K${candidate.row} if empty`
                : "",
              selectedTargets().includes("manyvids")
                ? `L${candidate.row} if empty`
                : "",
              selectedTargets().includes("pornhub")
                ? `H${candidate.row} only after a future verified link capture`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
      );
      confirmationNotice.textContent = uploadOnly
        ? "Yes opens or reuses your selected platform tabs, uploads the files, and schedules real posts using your signed-in sessions. No sheet data will be read or written. Existing posts are not checked against the sheet, so confirm this is not a duplicate upload."
        : social.enabled
          ? "One Yes freezes the paid upload and social distribution plan. Manual mode stops before final social publishing; Autonomous mode may click only trace-verified final controls."
          : "Yes opens or reuses your selected platform tabs, uploads and schedules real posts, and fills only the confirmed catalogue row's empty platform link cells.";
      confirmation.hidden = false;
      const nothingMissing = value.valid
        ? pendingTargets(value, match).length === 0 && !social.enabled
        : false;
      confirmUpload.disabled = !value.valid || !social.valid || nothingMissing;
      if (nothingMissing) {
        matchQuestion.textContent =
          "Every selected platform already has a catalogue link. Nothing will be uploaded.";
      }
    }

    function previewWithoutSheet(value) {
      currentMatch = { status: "upload-only", candidate: value };
      matchStatus.textContent =
        "Ready to upload. Sheet matching and link saving are off for this run.";
      renderMatch(currentMatch);
    }

    async function matchCatalogue(forceNew = false) {
      clearTimeout(matchTimer);
      const revision = ++matchRevision;
      currentMatch = null;
      currentProposal = null;
      confirmation.hidden = true;
      cataloguePicker.hidden = true;
      continueWithoutSheet.hidden = true;
      const value = validate(true);
      if (!value.valid || activeSession) {
        confirmation.hidden = true;
        matchStatus.textContent = value.valid
          ? "An upload session is already active."
          : "Complete the required fields to preview the upload.";
        return;
      }
      if (uploadWithoutSheet) {
        previewWithoutSheet(value);
        return;
      }
      matchStatus.textContent = forceNew
        ? "Finding the next safe empty catalogue row…"
        : "Loading the catalogue and ranking likely episodes…";
      confirmation.hidden = true;
      try {
        const client = globalThis.CreatorCatalogueClient;
        if (!client?.loadConfig || !globalThis.CreatorCatalogueProposal) {
          throw new Error(
            "Catalogue proposal tools are unavailable. Reload the extension or continue without the sheet.",
          );
        }
        const config = await client.loadConfig();
        if (revision !== matchRevision) return;
        if (!config.endpoint && !config.secret) {
          previewWithoutSheet(value);
          return;
        }
        currentSnapshot = await loadCatalogueSnapshot();
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
      clearTimeout(matchTimer);
      invalidateMatch();
      refreshReleaseSummary();
      const value = validate();
      if (!value.valid || activeSession) {
        matchStatus.textContent =
          "Complete the required fields to preview the upload.";
        return;
      }
      matchStatus.textContent = "Waiting for edits to settle…";
      matchTimer = setTimeout(() => matchCatalogue(false), 180);
    }

    function statusLabel(status) {
      return (
        {
          prepared: "Ready",
          "uploading-full": "Uploading full video",
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
          "catalogue-updated": "Catalogue updated",
          "uploaded-no-sheet": "Scheduled · sheet not connected",
          "manual-submit-required":
            "Metadata ready · attach the named file and submit manually",
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
                  : "X";
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
        if (
          new Set([
            "failed",
            "edit-failed",
            "catalogue-commit-failed",
            "stale",
            "conflict",
          ]).has(state.status) ||
          (Boolean(state.postUrl) &&
            !new Set([
              "catalogue-updated",
              "uploaded-no-sheet",
              "idempotent",
            ]).has(state.status))
        ) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.textContent = state.postUrl
            ? "Retry sheet update"
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
    }

    function applySocialJob(job) {
      if (!job) return;
      setPlatformState("x", {
        status:
          job.stage === "sheet-complete" ? "catalogue-updated" : job.stage,
        postUrl: job.resultUrl || "",
        error: job.error || "",
      });
    }

    function scheduleSocialResume(sessionId, job) {
      clearTimeout(socialPollTimer);
      if (
        !sessionId ||
        !job ||
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
          const resumed = response.socialDistribution?.jobs?.x;
          applySocialJob(resumed);
          scheduleSocialResume(sessionId, resumed);
        } catch (error) {
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
          }
        : null;
    }

    function sessionFile(session, role) {
      const file = session.files[role] || null;
      const expected = session.fileProof[role] || null;
      if (!file || !expected) return null;
      const actual = fileIdentity(file);
      return JSON.stringify(actual) === JSON.stringify(expected) ? file : null;
    }

    function deliverFile(session, request) {
      const file = sessionFile(session, request.role);
      if (!file) {
        session.pendingFiles.set(request.requestId, request);
        setPlatformState(request.platform, {
          status:
            request.role === "thumbnail"
              ? "waiting-for-thumbnail"
              : "waiting-for-teaser",
        });
        return;
      }
      const channel = channelFor(session);
      const timeout = setTimeout(() => {
        channel.removeEventListener("message", onAck);
        session.port.postMessage({
          type: "file-response",
          requestId: request.requestId,
          ok: false,
          error: "The platform file bridge did not acknowledge the video.",
        });
      }, 60_000);
      const onAck = (event) => {
        const data = event.data;
        if (
          data?.source !== "creator-upload-bridge" ||
          data.direction !== "ack" ||
          data.sessionId !== session.id ||
          data.platform !== request.platform ||
          data.role !== request.role
        ) {
          return;
        }
        clearTimeout(timeout);
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
      channel.postMessage({
        source: "creator-upload-console",
        sessionId: session.id,
        platform: request.platform,
        role: request.role,
        token: request.token,
        file,
      });
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
      const session = {
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
          if (message?.sessionId !== sessionId) return;
          if (message.type === "file-request") {
            deliverFile(session, message);
            return;
          }
          if (message.type === "platform-progress") {
            setPlatformState(message.platform, { status: message.status });
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
            matchStatus.textContent = message.error;
          }
        });
        port.onDisconnect.addListener(() => {
          if (session.port !== port || session.closed) return;
          session.channel?.close();
          session.channel = null;
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
      connectPort();
      return session;
    }

    async function retryPlatform(platform, button) {
      if (!activeSession) return;
      button.disabled = true;
      setPlatformState(platform, { status: "prepared", error: "" });
      try {
        const response = await sendMessage({
          type: "RETRY_CREATOR_UPLOAD_PLATFORM",
          sessionId: activeSession.id,
          platform,
        });
        for (const result of response.results || [])
          setPlatformState(result.platform, result);
      } catch (error) {
        setPlatformState(platform, { status: "failed", error: error.message });
      } finally {
        button.disabled = false;
      }
    }

    async function recheckProposalBeforeUpload() {
      const priorProfiles = draft().profileSignature;
      const currentProfiles = await refreshProfiles();
      if (priorProfiles !== currentProfiles) {
        scheduleMatch();
        throw new Error(
          "Workflow profiles changed. Review the updated plan and click Yes again.",
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
            "The matched catalogue row changed. Review it and click Yes again.",
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
          "Catalogue or queue changed. Review the updated proposal and click Yes again.",
        );
      }
      currentProposal = refreshed;
      currentMatch = {
        status: selectedRow === "new" ? "new" : "matched",
        candidate: refreshed.candidate,
      };
    }

    async function startUpload() {
      let value = validate(true);
      let social = socialDraft();
      if (!value.valid || !social.valid || !currentMatch || activeSession)
        return;
      let targets = [];
      confirmUpload.disabled = true;
      rejectMatch.disabled = true;
      try {
        await recheckProposalBeforeUpload();
        social = socialDraft(currentMatch.candidate);
        if (!social.valid) {
          throw new Error(social.errors.join(" "));
        }
        await recheckSubredditPresets(social);
        value = validate(true);
        targets = pendingTargets(value);
        if (!targets.length && !social.enabled) {
          matchStatus.textContent =
            "Every selected platform is already linked. Nothing was uploaded.";
          confirmUpload.disabled = false;
          rejectMatch.disabled = false;
          return;
        }
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
              catalogue: {
                row: currentMatch.candidate.row,
                id: currentMatch.candidate.id,
                title: currentMatch.candidate.title,
                fingerprint: currentMatch.candidate.fingerprint,
              },
              evidence: socialEvidence(),
              authorizationAt: Date.now(),
            })
          : null;
        const confirmedFiles = {
          full: fullFile,
          teaser: teaserFile,
          thumbnail: thumbnailFile,
          pornhub: pornhubFile,
          social: socialFile,
        };
        activeSession = connectSession(sessionId, {
          files: confirmedFiles,
          socialSessionId: socialPlan?.id || "",
          proof: {
            fullFilename: fullFile?.name || "",
            pornhubFilename: pornhubFile?.name || fullFile?.name || "",
            manyvidsThumbnail: Boolean(thumbnailFile),
            profileSignature: value.profileSignature,
          },
        });
        fullInput.disabled = true;
        thumbnailInput.disabled = true;
        pornhubInput.disabled = true;
        teaserInput.disabled = Boolean(teaserFile);
        socialInput.disabled = Boolean(socialFile);
        platformStates.clear();
        for (const platform of value.targets) {
          const postUrl = catalogueLink(currentMatch.candidate, platform);
          platformStates.set(
            platform,
            postUrl
              ? { status: "already-linked", postUrl }
              : { status: "prepared" },
          );
        }
        if (socialPlan?.targets.x) {
          platformStates.set("x", { status: "prepared" });
        }
        renderPlatformStates();
        confirmation.hidden = true;
        matchStatus.textContent = "Preparing authenticated platform composers…";
        if (targets.length) {
          const response = await sendMessage({
            type: "PREPARE_CREATOR_UPLOAD",
            sessionId,
            targets,
            draft: {
              title: value.title,
              description: value.description,
              fullFilename: fullFile?.name || "",
              releaseDate: value.releaseDate,
              scheduledIso: value.scheduledIso,
              timeZone,
              fanslyPreset: "defaulT",
              manyvidsThumbnail: Boolean(thumbnailFile),
              pornhubFilename: pornhubFile?.name || fullFile?.name || "",
              contentPreset: value.contentPreset,
              fanslyCaption: value.fanslyCaption,
              profiles: value.profiles,
              profileSignature: value.profileSignature,
            },
            catalogue:
              currentMatch.status === "upload-only"
                ? null
                : {
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
          });
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
          const started = await sendMessage({
            type: "START_CREATOR_UPLOAD",
            sessionId,
            targets,
          });
          for (const result of started.results || [])
            setPlatformState(result.platform, result);
        }
        if (socialPlan) {
          const preparedSocial = await sendMessage({
            type: "PREPARE_CREATOR_SOCIAL_DISTRIBUTION",
            plan: socialPlan,
            caption: social.caption,
          });
          const xTarget = preparedSocial.socialDistribution?.targets?.x;
          if (xTarget) setPlatformState("x", xTarget);
          const startedSocial = await sendMessage({
            type: "START_CREATOR_SOCIAL_DISTRIBUTION",
            sessionId: socialPlan.id,
          });
          const xJob = startedSocial.socialDistribution?.jobs?.x;
          applySocialJob(xJob);
          scheduleSocialResume(socialPlan.id, xJob);
        }
        matchStatus.textContent =
          "Upload run finished. Review each platform card.";
      } catch (error) {
        matchStatus.textContent = error.message;
        if (activeSession) {
          for (const platform of targets) {
            if (
              !platformStates.get(platform)?.status ||
              platformStates.get(platform).status === "prepared"
            ) {
              setPlatformState(platform, {
                status: "failed",
                error: error.message,
              });
            }
          }
        }
        confirmUpload.disabled = false;
        rejectMatch.disabled = false;
      }
    }

    fullInput.addEventListener("change", () => {
      fullFile = fullInput.files?.[0] || null;
      selectedCatalogueRow = null;
      manualTargets = null;
      get("#fullFileSummary").textContent = fileSummary(
        fullFile,
        "Required. It starts transferring after Yes and remains only in this open tab.",
      );
      if (fullFile && !title.value.trim())
        title.value = titleFromFilename(fullFile.name);
      if (fullFile && !socialCaption.value.trim()) {
        socialCaption.value = title.value;
      }
      scheduleMatch();
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
        "Optional now. Fansly can upload the full video first and wait here for the teaser before posting.",
      );
      flushPendingTeaser();
      if (!activeSession) scheduleMatch();
    });
    thumbnailInput.addEventListener("change", () => {
      thumbnailFile = thumbnailInput.files?.[0] || null;
      get("#manyvidsThumbnailSummary").textContent = fileSummary(
        thumbnailFile,
        "Optional. If empty, ManyVids keeps its site-generated thumbnail.",
      );
      if (!activeSession) scheduleMatch();
    });
    pornhubInput.addEventListener("change", () => {
      pornhubFile = pornhubInput.files?.[0] || null;
      get("#pornhubFileSummary").textContent = fileSummary(
        pornhubFile,
        "Optional limited edition. If empty, Pornhub uses the full-video selection in the plan.",
      );
      if (!activeSession) scheduleMatch();
    });
    socialInput.addEventListener("change", () => {
      socialFile = socialInput.files?.[0] || null;
      get("#socialFileSummary").textContent = fileSummary(
        socialFile,
        "Optional until X or Reddit is selected. Kept only in this tab.",
      );
      refreshSocialReview();
    });
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
    for (const control of [title, description, releaseDate, contentPreset]) {
      control.addEventListener("input", scheduleMatch);
    }
    for (const control of [onlyfans, fansly, manyvids, pornhub]) {
      control.addEventListener("change", () => {
        if (selectedCatalogueRow !== null) {
          manualTargets = new Set(selectedTargets());
        }
        scheduleMatch();
      });
    }
    confirmUpload.addEventListener("click", () => startUpload());
    catalogueSearch.addEventListener("input", () => renderPicker());
    showAllCatalogue.addEventListener("change", () => renderPicker());
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
      previewWithoutSheet(value);
    });
    rejectMatch.addEventListener("click", () => {
      if (currentProposal) {
        selectedCatalogueRow =
          currentMatch?.status === "new"
            ? "new"
            : currentMatch?.candidate?.row || selectedCatalogueRow;
        confirmation.hidden = true;
        renderPicker();
        matchStatus.textContent =
          "Choose another catalogue episode or add a new entry.";
        catalogueSearch.focus();
      } else if (currentMatch?.status === "matched") {
        matchCatalogue(true);
      } else {
        invalidateMatch();
        matchStatus.textContent =
          "Edit the title, description, or Friday; the preview will update.";
        title.focus();
      }
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

    refreshReleaseSummary();
    refreshSocialReview();
    loadWorkflowSettingsPanel()
      .then(() => scheduleMatch())
      .catch((error) => {
        matchStatus.textContent = error.message;
      });
    validate();
  }

  globalThis.CreatorUploadConsole = Object.freeze({
    buildSocialDistributionPlan,
    nextFridayUtc,
    nextFridayLocalValue,
    learnSeriesPresetMap,
    normalizeDraft,
    normalizeSocialDraft,
    profileAuthorizationSummary,
    proposalSignature,
    scheduledIsoForReleaseDate,
    titleFromFilename,
    validateDraft,
  });
  if (typeof document !== "undefined") mount();
})();
