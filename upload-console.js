"use strict";

(() => {
  const VIDEO_EXTENSIONS = /\.(?:mp4|m4v|mov|webm|avi|mkv)$/i;
  const IMAGE_EXTENSIONS = /\.(?:jpe?g|png)$/i;
  const TARGETS = new Set(["onlyfans", "fansly", "manyvids"]);

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

  function normalizeDraft({
    fullFile,
    teaserFile = null,
    thumbnailFile = null,
    title,
    description,
    scheduledIso,
    targets,
  } = {}) {
    const errors = [];
    if (!isVideoFile(fullFile)) errors.push("Choose a non-empty full video.");
    if (teaserFile && !isVideoFile(teaserFile)) {
      errors.push("Choose a non-empty teaser video or leave it blank.");
    }
    if (thumbnailFile && !isImageFile(thumbnailFile)) {
      errors.push("Choose a PNG or JPEG ManyVids thumbnail or leave it blank.");
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
    const selectedTargets = Array.isArray(targets)
      ? [...new Set(targets)].filter((target) => TARGETS.has(target))
      : [];
    if (!selectedTargets.length || selectedTargets.length !== targets?.length) {
      errors.push("Choose OnlyFans, Fansly, ManyVids, or a combination.");
    }
    if (selectedTargets.includes("manyvids") && !isVideoFile(teaserFile)) {
      errors.push("Choose a non-empty ManyVids teaser video.");
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
      },
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
    const title = get("#uploadTitle");
    const description = get("#uploadDescription");
    const releaseDate = get("#releaseDate");
    const releaseSummary = get("#releaseTimeSummary");
    const onlyfans = get("#targetOnlyfans");
    const fansly = get("#targetFansly");
    const manyvids = get("#targetManyvids");
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
    const confirmation = get("#confirmation");
    const confirmationNotice = get("#confirmationNotice");
    const matchBadge = get("#matchBadge");
    const matchQuestion = get("#matchQuestion");
    const uploadSummary = get("#uploadSummary");
    const confirmUpload = get("#confirmUpload");
    const rejectMatch = get("#rejectMatch");
    const results = get("#results");
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const initialSchedule = nextFridayUtc(new Date(), timeZone);
    let fullFile = null;
    let teaserFile = null;
    let thumbnailFile = null;
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
    const platformStates = new Map();

    releaseDate.value = initialSchedule.releaseDate;

    function selectedTargets() {
      return [
        onlyfans.checked ? "onlyfans" : "",
        fansly.checked ? "fansly" : "",
        manyvids.checked ? "manyvids" : "",
      ].filter(Boolean);
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
      return normalizeDraft({
        fullFile,
        teaserFile,
        thumbnailFile,
        title: title.value,
        description: description.value,
        scheduledIso: scheduledIsoForReleaseDate(releaseDate.value),
        targets: selectedTargets(),
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
          : ["onlyfans", "fansly", "manyvids"],
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
      setInferredTargets(proposal.targets.executable);
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
        ? "Pornhub is recommended from the empty catalogue link, but is not yet executable."
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
      summaryRow("Full video", fullFile.name);
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
            : `Full + ${teaserFile?.name || "teaser required"} preview · $19.99 · ${thumbnailFile?.name || "site-generated thumbnail"}`,
        );
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
            ]
              .filter(Boolean)
              .join(" · "),
      );
      confirmationNotice.textContent = uploadOnly
        ? "Yes opens or reuses your selected platform tabs, uploads the files, and schedules real posts using your signed-in sessions. No sheet data will be read or written. Existing posts are not checked against the sheet, so confirm this is not a duplicate upload."
        : "Yes opens or reuses your selected platform tabs, uploads and schedules real posts, and fills only the confirmed catalogue row's empty platform link cells.";
      confirmation.hidden = false;
      const value = draft();
      const nothingMissing = value.valid
        ? pendingTargets(value, match).length === 0
        : false;
      confirmUpload.disabled = !value.valid || nothingMissing;
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
      for (const platform of selectedTargets()) {
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
              : "ManyVids";
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
          state.status === "failed" ||
          (Boolean(state.postUrl) &&
            new Set(["catalogue-commit-failed", "stale", "conflict"]).has(
              state.status,
            ))
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

    function deliverFile(session, request) {
      const file =
        request.role === "full"
          ? fullFile
          : request.role === "thumbnail"
            ? thumbnailFile
            : teaserFile;
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
      if (!session || !teaserFile) return;
      for (const [requestId, request] of [...session.pendingFiles]) {
        if (request.role !== "teaser") continue;
        session.pendingFiles.delete(requestId);
        deliverFile(session, request);
      }
    }

    function connectSession(sessionId) {
      const port = chrome.runtime.connect({ name: "creator-upload-console" });
      const session = {
        id: sessionId,
        port,
        channel: null,
        pendingFiles: new Map(),
      };
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
        }
      });
      port.onDisconnect.addListener(() => {
        session.channel?.close();
      });
      port.postMessage({ type: "bind-session", sessionId });
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
      if (!currentProposal || currentMatch?.status === "upload-only") return;
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
      if (!value.valid || !currentMatch || activeSession) return;
      let targets = [];
      confirmUpload.disabled = true;
      rejectMatch.disabled = true;
      try {
        await recheckProposalBeforeUpload();
        value = validate(true);
        targets = pendingTargets(value);
        if (!targets.length) {
          matchStatus.textContent =
            "Every selected platform is already linked. Nothing was uploaded.";
          confirmUpload.disabled = false;
          rejectMatch.disabled = false;
          return;
        }
        const optionalOrigins = [
          ...(targets.includes("fansly") ? ["https://fansly.com/*"] : []),
          ...(targets.includes("manyvids")
            ? ["https://www.manyvids.com/*"]
            : []),
        ];
        if (optionalOrigins.length) {
          const granted = await chrome.permissions.request({
            origins: optionalOrigins,
          });
          if (!granted)
            throw new Error(
              "Selected platform site permission was not granted.",
            );
          await sendMessage({ type: "SYNC_CREATOR_TOOLS" });
        }
        const sessionId = randomSessionId();
        activeSession = connectSession(sessionId);
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
        renderPlatformStates();
        confirmation.hidden = true;
        matchStatus.textContent = "Preparing authenticated platform composers…";
        const response = await sendMessage({
          type: "PREPARE_CREATOR_UPLOAD",
          sessionId,
          targets,
          draft: {
            title: value.title,
            description: value.description,
            fullFilename: fullFile.name,
            releaseDate: value.releaseDate,
            scheduledIso: value.scheduledIso,
            timeZone,
            fanslyPreset: "defaulT",
            manyvidsThumbnail: Boolean(thumbnailFile),
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
        matchStatus.textContent =
          "Uploading through the real authenticated pages…";
        const started = await sendMessage({
          type: "START_CREATOR_UPLOAD",
          sessionId,
          targets,
        });
        for (const result of started.results || [])
          setPlatformState(result.platform, result);
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
      scheduleMatch();
    });
    teaserInput.addEventListener("change", () => {
      teaserFile = teaserInput.files?.[0] || null;
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
    for (const control of [title, description, releaseDate]) {
      control.addEventListener("input", scheduleMatch);
    }
    for (const control of [onlyfans, fansly, manyvids]) {
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
    globalThis.addEventListener("beforeunload", () => {
      activeSession?.port.disconnect();
      activeSession?.channel?.close();
    });

    refreshReleaseSummary();
    validate();
  }

  globalThis.CreatorUploadConsole = Object.freeze({
    nextFridayUtc,
    nextFridayLocalValue,
    normalizeDraft,
    proposalSignature,
    scheduledIsoForReleaseDate,
    titleFromFilename,
    validateDraft,
  });
  if (typeof document !== "undefined") mount();
})();
