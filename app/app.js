(function startOFEnhancerApp(global) {
  "use strict";

  const buttons = Array.from(document.querySelectorAll("[data-view]"));
  const panels = Array.from(document.querySelectorAll("[data-panel]"));
  const connectionLabel = document.querySelector("#connectionLabel");
  const versionLabel = document.querySelector("#versionLabel");
  const agentSetting = document.querySelector("#agentSetting");
  const openUploader = document.querySelector("#openUploader");
  const actionStatus = document.querySelector("#actionStatus");
  const catalogueSummary = document.querySelector("#catalogueSummary");
  const catalogueStatus = document.querySelector("#catalogueStatus");
  const catalogueLoading = document.querySelector("#catalogueLoading");
  const catalogueUnavailable = document.querySelector("#catalogueUnavailable");
  const catalogueEmpty = document.querySelector("#catalogueEmpty");
  const catalogueNoMatches = document.querySelector("#catalogueNoMatches");
  const catalogueList = document.querySelector("#catalogueList");
  const loadMoreCatalogue = document.querySelector("#loadMoreCatalogue");
  const catalogueSearch = document.querySelector("#catalogueSearch");
  const catalogueFile = document.querySelector("#catalogueFile");
  const importCatalogue = document.querySelector("#importCatalogue");
  const scanThumbnails = document.querySelector("#scanThumbnails");
  const filterButtons = Array.from(
    document.querySelectorAll("[data-catalogue-filter]"),
  );
  const thumbnailReview = document.querySelector("#thumbnailReview");
  const thumbnailReviewList = document.querySelector("#thumbnailReviewList");
  const thumbnailReviewCount = document.querySelector("#thumbnailReviewCount");
  const matchDialog = document.querySelector("#matchDialog");
  const matchDialogFile = document.querySelector("#matchDialogFile");
  const matchDialogImage = document.querySelector("#matchDialogImage");
  const matchDialogStatus = document.querySelector("#matchDialogStatus");
  const candidateList = document.querySelector("#candidateList");
  const closeMatchDialog = document.querySelector("#closeMatchDialog");
  const googleCatalogue = document.querySelector("#googleCatalogue");
  const googleCatalogueStatus = document.querySelector(
    "#googleCatalogueStatus",
  );
  const googlePrimaryAction = document.querySelector("#googlePrimaryAction");
  const googleDisconnect = document.querySelector("#googleDisconnect");
  const googleSetup = document.querySelector("#googleSetup");
  const googleSetupForm = document.querySelector("#googleSetupForm");
  const googleClientId = document.querySelector("#googleClientId");
  const googleSetupStatus = document.querySelector("#googleSetupStatus");
  const googleMigrationDialog = document.querySelector(
    "#googleMigrationDialog",
  );
  const googleMigrationWorkbook = document.querySelector(
    "#googleMigrationWorkbook",
  );
  const googleMigrationSheet = document.querySelector("#googleMigrationSheet");
  const googleMigrationRows = document.querySelector("#googleMigrationRows");
  const googleMigrationChanges = document.querySelector(
    "#googleMigrationChanges",
  );
  const googleMigrationConflicts = document.querySelector(
    "#googleMigrationConflicts",
  );
  const googleMigrationStatus = document.querySelector(
    "#googleMigrationStatus",
  );
  const cancelGoogleMigration = document.querySelector(
    "#cancelGoogleMigration",
  );
  const applyGoogleMigration = document.querySelector("#applyGoogleMigration");

  const platformNames = Object.freeze({
    onlyfans: "OnlyFans",
    fansly: "Fansly",
    manyvids: "ManyVids",
    pornhubFree: "Pornhub Free",
    pornhubPaid: "Pornhub Paid",
    clips4sale: "Clips4Sale",
    x: "X",
    reddit: "Reddit",
    redgifs: "Redgifs",
  });
  const maximumCatalogueBytes = 5 * 1024 * 1024;

  let catalogue = null;
  let cataloguePromise = null;
  let catalogueFilter = "all";
  let renderLimit = 100;
  let currentAsset = null;
  let googleStatusView = null;
  let googlePollTimer = null;
  let frozenMigration = null;

  function showView(name) {
    for (const button of buttons) {
      const current = button.dataset.view === name;
      if (current) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    document.querySelector(`[data-panel="${name}"] h1`)?.focus?.();
    if (name === "catalogue") {
      loadCatalogue();
      refreshGoogleCatalogue();
    } else stopGooglePolling();
  }

  function thumbnailUrl(assetId) {
    return assetId
      ? `https://thumbs.ofenhancer.local/${encodeURIComponent(assetId)}`
      : "";
  }

  function formatDate(value) {
    if (!value) return "No release date";
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return value;
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeThumbnail(assetId, className = "catalogue-thumbnail") {
    if (!assetId)
      return element("div", `${className} thumbnail-placeholder`, "No image");
    const image = element("img", className);
    image.src = thumbnailUrl(assetId);
    image.alt = "";
    const sizes = {
      "catalogue-thumbnail": [128, 72],
      "review-thumbnail": [96, 54],
      "candidate-thumbnail": [88, 50],
      "dialog-thumbnail": [176, 99],
    };
    const [width, height] = sizes[className] || [128, 72];
    image.width = width;
    image.height = height;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      image.replaceWith(
        element("div", `${className} thumbnail-placeholder`, "No image"),
      );
    });
    return image;
  }

  function renderCatalogueRow(item) {
    const row = element("li", "catalogue-row");
    row.dataset.catalogueRow = "";
    row.append(makeThumbnail(item.thumbnailAssetId));

    const main = element("div", "catalogue-row-main");
    const titleLine = element("div", "catalogue-title-line");
    titleLine.append(element("h3", "", item.title));
    titleLine.append(
      element(
        "span",
        `binding-state ${item.thumbnailStatus === "bound" ? "is-bound" : ""}`,
        item.thumbnailStatus === "bound"
          ? "Thumbnail bound"
          : "Needs thumbnail",
      ),
    );
    main.append(titleLine);
    const context = [item.series, item.episode && `Episode ${item.episode}`]
      .filter(Boolean)
      .join(" · ");
    main.append(
      element(
        "p",
        "catalogue-meta",
        [formatDate(item.plannedDate), context].filter(Boolean).join(" · "),
      ),
    );

    const platforms = element("div", "platform-list");
    const links = Object.keys(item.platformLinks || {});
    if (links.length === 0)
      platforms.append(element("span", "muted-label", "No platform links"));
    for (const platform of links)
      platforms.append(
        element("span", "platform-badge", platformNames[platform] || platform),
      );
    main.append(platforms);
    row.append(main);

    const counts = element("div", "social-counts");
    counts.append(element("span", "", `X ${item.xTeasers}`));
    counts.append(element("span", "", `Reddit ${item.redditTeasers}`));
    row.append(counts);
    return row;
  }

  function visibleItems() {
    if (!catalogue) return [];
    const query = catalogueSearch.value.trim().toLocaleLowerCase();
    return catalogue.items.filter((item) => {
      if (catalogueFilter === "missing" && item.thumbnailStatus === "bound")
        return false;
      if (catalogueFilter === "bound" && item.thumbnailStatus !== "bound")
        return false;
      if (!query) return true;
      return [item.title, item.series, item.episode, item.sourceKey]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }

  function renderReview() {
    thumbnailReviewList.replaceChildren();
    const unmatched = catalogue?.unmatchedAssets || [];
    thumbnailReview.hidden = unmatched.length === 0;
    thumbnailReviewCount.textContent = String(unmatched.length);
    for (const asset of unmatched) {
      const row = element("li", "review-row");
      row.append(makeThumbnail(asset.assetId, "review-thumbnail"));
      const copy = element("div", "review-copy");
      copy.append(element("strong", "", asset.fileName));
      const suggestion = asset.candidates?.[0]?.title;
      copy.append(
        element(
          "span",
          "",
          suggestion ? `Likely: ${suggestion}` : "No close catalogue match",
        ),
      );
      row.append(copy);
      const choose = element("button", "secondary-button", "Choose video");
      choose.type = "button";
      choose.addEventListener("click", () => openMatchDialog(asset));
      row.append(choose);
      thumbnailReviewList.append(row);
    }
  }

  function renderCatalogue() {
    catalogueLoading.hidden = true;
    catalogueUnavailable.hidden = true;
    const total = catalogue?.items?.length || 0;
    const bound =
      catalogue?.items?.filter((item) => item.thumbnailStatus === "bound")
        .length || 0;
    const pending = catalogue?.unmatchedAssets?.length || 0;
    catalogueSummary.textContent = `${total} ${total === 1 ? "video" : "videos"} · ${bound} ${bound === 1 ? "thumbnail" : "thumbnails"} matched${pending ? ` · ${pending} to review` : ""}`;
    catalogueEmpty.hidden = total !== 0;
    catalogueSearch.disabled = total === 0;
    for (const button of filterButtons) button.disabled = total === 0;
    renderReview();

    catalogueList.replaceChildren();
    const items = visibleItems();
    for (const item of items.slice(0, renderLimit))
      catalogueList.append(renderCatalogueRow(item));
    loadMoreCatalogue.hidden = items.length <= renderLimit;
    catalogueNoMatches.hidden = total === 0 || items.length !== 0;
  }

  function renderCatalogueUnavailable() {
    catalogueLoading.hidden = true;
    catalogueUnavailable.hidden = false;
    catalogueEmpty.hidden = true;
    catalogueNoMatches.hidden = true;
    thumbnailReview.hidden = true;
    catalogueList.replaceChildren();
    loadMoreCatalogue.hidden = true;
    catalogueSummary.textContent = "The local catalogue is not connected.";
    catalogueSearch.disabled = true;
    importCatalogue.disabled = true;
    scanThumbnails.disabled = true;
    for (const button of filterButtons) button.disabled = true;
  }

  async function loadCatalogue(force = false) {
    if (cataloguePromise && !force) return cataloguePromise;
    catalogueLoading.hidden = false;
    cataloguePromise = global.OFEnhancerHost.request("getCatalogue")
      .then((value) => {
        catalogue = value;
        renderCatalogue();
        return value;
      })
      .catch(() => {
        catalogue = null;
        renderCatalogueUnavailable();
        return null;
      })
      .finally(() => {
        cataloguePromise = null;
      });
    return cataloguePromise;
  }

  function friendlyCatalogueError(error) {
    const messages = {
      "snapshot-too-large": "That catalogue file is too large.",
      "invalid-snapshot": "That file is not a valid catalogue snapshot.",
      "thumbnail-root-missing": "Thumbnail folder was not found.",
      "thumbnail-folder-not-selected": "No thumbnail folder was selected.",
      "unsafe-thumbnail-root": "That thumbnail folder is not safe to scan.",
      "too-many-thumbnails": "That folder contains too many thumbnails.",
      "thumbnail-scan-failed": "The thumbnail scan could not finish.",
      "asset-not-found": "That thumbnail is no longer available.",
      "item-not-found": "That catalogue video is no longer available.",
    };
    return (
      messages[error?.message] || "OFEnhancer could not finish that action."
    );
  }

  function setBusy(control, busy) {
    control.disabled = busy;
    control.setAttribute("aria-busy", String(busy));
  }

  function cataloguePanelIsVisible() {
    return !document.querySelector('[data-panel="catalogue"]')?.hidden;
  }

  function stopGooglePolling() {
    if (googlePollTimer !== null) global.clearTimeout(googlePollTimer);
    googlePollTimer = null;
  }

  function scheduleGooglePolling(state) {
    stopGooglePolling();
    if (
      cataloguePanelIsVisible() &&
      (state === "connecting" || state === "syncing")
    ) {
      googlePollTimer = global.setTimeout(refreshGoogleCatalogue, 1500);
    }
  }

  function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
  }

  function formatGoogleDate(value) {
    if (!value) return "Not checked yet.";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Not checked yet.";
    return `Last checked ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date)}.`;
  }

  function setGooglePrimaryAction(label, action, className = "action-button") {
    googlePrimaryAction.textContent = label;
    googlePrimaryAction.dataset.googleAction = action;
    googlePrimaryAction.className = className;
    googlePrimaryAction.hidden = false;
    setBusy(googlePrimaryAction, false);
  }

  function renderGoogleCatalogue(view, notice = "") {
    const knownStates = new Set([
      "notConfigured",
      "disconnected",
      "connecting",
      "needsInspection",
      "migrationReady",
      "ready",
      "syncing",
      "conflict",
      "error",
    ]);
    const state = knownStates.has(view?.state) ? view.state : "error";
    googleStatusView = {
      state,
      workbookName:
        typeof view?.workbookName === "string" ? view.workbookName : "",
      sheetName: typeof view?.sheetName === "string" ? view.sheetName : "",
      planHash: typeof view?.planHash === "string" ? view.planHash : "",
      rowsToBind: Number.isInteger(view?.rowsToBind) ? view.rowsToBind : 0,
      migrationChanges: Number.isInteger(view?.migrationChanges)
        ? view.migrationChanges
        : 0,
      pendingCount: Number.isInteger(view?.pendingCount)
        ? view.pendingCount
        : 0,
      conflictCount: Number.isInteger(view?.conflictCount)
        ? view.conflictCount
        : 0,
      lastVerifiedSync: view?.lastVerifiedSync || null,
      errorCode: typeof view?.errorCode === "string" ? view.errorCode : "",
    };

    googleCatalogue.hidden = false;
    googleDisconnect.hidden = true;
    setBusy(googleDisconnect, false);
    googleCatalogueStatus.setAttribute("aria-busy", "false");

    if (notice) {
      googleCatalogueStatus.textContent = notice;
    } else if (state === "notConfigured") {
      googleCatalogueStatus.textContent = "Add your Google setup in Settings.";
    } else if (state === "disconnected") {
      googleCatalogueStatus.textContent =
        "Connect the workbook you use for your catalogue.";
    } else if (state === "connecting") {
      googleCatalogueStatus.textContent = "Finish in your browser.";
    } else if (state === "needsInspection") {
      googleCatalogueStatus.textContent = `${googleStatusView.workbookName || "Your workbook"} is connected. Check it before syncing.`;
    } else if (state === "migrationReady") {
      const rowVerb = googleStatusView.rowsToBind === 1 ? "needs" : "need";
      const changeVerb = googleStatusView.migrationChanges === 1 ? "is" : "are";
      googleCatalogueStatus.textContent = `${plural(googleStatusView.rowsToBind, "row")} ${rowVerb} linking. ${plural(googleStatusView.migrationChanges, "workbook change")} ${changeVerb} ready.`;
    } else if (state === "ready") {
      googleCatalogueStatus.textContent = `${plural(googleStatusView.pendingCount, "update")} waiting. ${formatGoogleDate(googleStatusView.lastVerifiedSync)}`;
    } else if (state === "syncing") {
      googleCatalogueStatus.textContent = "Syncing Google Sheet…";
      googleCatalogueStatus.setAttribute("aria-busy", "true");
    } else if (state === "conflict") {
      googleCatalogueStatus.textContent =
        "The workbook changed. Check it before syncing.";
    } else if (
      googleStatusView.errorCode.includes("authorization") ||
      googleStatusView.errorCode.includes("token")
    ) {
      googleCatalogueStatus.textContent = "Reconnect Google Sheet to continue.";
    } else {
      googleCatalogueStatus.textContent =
        "OFEnhancer could not finish that Google Sheet action.";
    }

    if (state === "notConfigured") {
      setGooglePrimaryAction("Settings", "settings", "secondary-button");
    } else if (state === "disconnected") {
      setGooglePrimaryAction("Connect Google Sheet", "connect");
    } else if (state === "connecting") {
      setGooglePrimaryAction("Cancel", "cancel", "secondary-button");
    } else if (state === "needsInspection") {
      setGooglePrimaryAction("Check workbook", "inspect");
      googleDisconnect.hidden = false;
    } else if (state === "migrationReady") {
      setGooglePrimaryAction("Review changes", "review");
      googleDisconnect.hidden = false;
    } else if (state === "ready") {
      setGooglePrimaryAction("Sync now", "sync");
      googleDisconnect.hidden = false;
    } else if (state === "syncing") {
      setGooglePrimaryAction("Syncing…", "sync");
      setBusy(googlePrimaryAction, true);
      googleDisconnect.hidden = false;
      googleDisconnect.disabled = true;
    } else if (state === "conflict") {
      setGooglePrimaryAction("Check workbook", "inspect");
      googleDisconnect.hidden = false;
    } else if (
      googleStatusView.errorCode.includes("authorization") ||
      googleStatusView.errorCode.includes("token")
    ) {
      setGooglePrimaryAction("Reconnect", "connect");
      googleDisconnect.hidden = false;
    } else if (googleStatusView.workbookName) {
      setGooglePrimaryAction("Check workbook", "inspect");
      googleDisconnect.hidden = false;
    } else {
      setGooglePrimaryAction("Connect Google Sheet", "connect");
    }

    scheduleGooglePolling(state);
  }

  async function refreshGoogleCatalogue() {
    stopGooglePolling();
    if (!cataloguePanelIsVisible()) return;
    try {
      const status = await global.OFEnhancerHost.request(
        "getGoogleCatalogueStatus",
      );
      if (cataloguePanelIsVisible()) renderGoogleCatalogue(status);
    } catch (error) {
      if (!cataloguePanelIsVisible()) return;
      renderGoogleCatalogue({ state: "error", errorCode: error?.message });
    }
  }

  function openGoogleSettings() {
    showView("settings");
    googleSetup.open = true;
    global.requestAnimationFrame(() => googleClientId.focus());
  }

  function openGoogleMigrationReview() {
    if (!/^[a-f0-9]{64}$/.test(googleStatusView?.planHash || "")) {
      googleCatalogueStatus.textContent =
        "Check the workbook again before reviewing changes.";
      return;
    }
    frozenMigration = { ...googleStatusView };
    googleMigrationWorkbook.textContent =
      frozenMigration.workbookName || "Selected workbook";
    googleMigrationSheet.textContent =
      frozenMigration.sheetName || "Catalogue sheet";
    googleMigrationRows.textContent = plural(frozenMigration.rowsToBind, "row");
    googleMigrationChanges.textContent = plural(
      frozenMigration.migrationChanges,
      "change",
    );
    googleMigrationConflicts.textContent = plural(
      frozenMigration.conflictCount,
      "conflict",
    );
    googleMigrationStatus.textContent = "";
    googleMigrationDialog.showModal();
  }

  async function runGoogleAction(action) {
    if (action === "settings") {
      openGoogleSettings();
      return;
    }
    if (action === "review") {
      openGoogleMigrationReview();
      return;
    }
    const operations = {
      connect: "startGoogleCatalogueConnection",
      cancel: "cancelGoogleCatalogueConnection",
      inspect: "inspectGoogleWorkbook",
      sync: "syncGoogleCatalogue",
    };
    const operation = operations[action];
    if (!operation) return;

    setBusy(googlePrimaryAction, true);
    googleDisconnect.disabled = true;
    googleCatalogueStatus.setAttribute("aria-busy", "true");
    const workingCopy = {
      connect: "Opening your browser…",
      cancel: "Cancelling connection…",
      inspect: "Checking workbook…",
      sync: "Syncing Google Sheet…",
    };
    googleCatalogueStatus.textContent = workingCopy[action];
    try {
      renderGoogleCatalogue(await global.OFEnhancerHost.request(operation));
    } catch (error) {
      renderGoogleCatalogue({
        ...googleStatusView,
        state: "error",
        errorCode: error?.message,
      });
    }
  }

  async function disconnectGoogle() {
    setBusy(googleDisconnect, true);
    setBusy(googlePrimaryAction, true);
    googleCatalogueStatus.setAttribute("aria-busy", "true");
    googleCatalogueStatus.textContent = "Disconnecting Google Sheet…";
    try {
      renderGoogleCatalogue(
        await global.OFEnhancerHost.request("disconnectGoogleCatalogue"),
      );
    } catch (error) {
      renderGoogleCatalogue({
        ...googleStatusView,
        state: "error",
        errorCode: error?.message,
      });
    }
  }

  async function applyGoogleMigrationPlan() {
    const approved = frozenMigration;
    if (!approved) return;
    setBusy(applyGoogleMigration, true);
    cancelGoogleMigration.disabled = true;
    googleMigrationStatus.textContent = "Updating workbook…";
    try {
      const status = await global.OFEnhancerHost.request(
        "applyGoogleWorkbookMigration",
        { planHash: approved.planHash },
      );
      googleMigrationDialog.close();
      renderGoogleCatalogue(status);
    } catch (error) {
      if (error?.message === "stale-migration-plan") {
        googleMigrationDialog.close();
        googleCatalogueStatus.setAttribute("aria-busy", "true");
        googleCatalogueStatus.textContent = "Checking the updated workbook…";
        try {
          const status = await global.OFEnhancerHost.request(
            "inspectGoogleWorkbook",
          );
          renderGoogleCatalogue(
            status,
            "The workbook changed. Review the updated changes.",
          );
        } catch (inspectionError) {
          renderGoogleCatalogue({
            ...googleStatusView,
            state: "error",
            errorCode: inspectionError?.message,
          });
        }
      } else {
        googleMigrationStatus.textContent =
          "OFEnhancer could not update the workbook. Choose No and check it again.";
      }
    } finally {
      setBusy(applyGoogleMigration, false);
      cancelGoogleMigration.disabled = false;
    }
  }

  function openMatchDialog(asset) {
    currentAsset = asset;
    matchDialogFile.textContent = asset.fileName;
    matchDialogImage.replaceChildren(
      makeThumbnail(asset.assetId, "dialog-thumbnail"),
    );
    matchDialogStatus.textContent = "";
    candidateList.replaceChildren();
    if (!asset.candidates?.length) {
      candidateList.append(
        element(
          "p",
          "candidate-empty",
          "No close matches. Import an updated catalogue and try again.",
        ),
      );
    }
    for (const candidate of asset.candidates || []) {
      const button = element("button", "candidate-row");
      button.type = "button";
      button.setAttribute("aria-label", `Use ${candidate.title}`);
      button.append(
        makeThumbnail(candidate.thumbnailAssetId, "candidate-thumbnail"),
      );
      const copy = element("span", "candidate-copy");
      copy.append(element("strong", "", candidate.title));
      copy.append(element("span", "", formatDate(candidate.plannedDate)));
      button.append(copy);
      button.append(element("span", "candidate-action", "Use this video"));
      button.addEventListener("click", () => confirmMatch(button, candidate));
      candidateList.append(button);
    }
    matchDialog.showModal();
  }

  async function confirmMatch(button, candidate) {
    if (!currentAsset) return;
    setBusy(button, true);
    matchDialogStatus.textContent = "Saving match…";
    try {
      await global.OFEnhancerHost.request("confirmAssetBinding", {
        assetId: currentAsset.assetId,
        itemId: candidate.itemId,
      });
      matchDialog.close();
      catalogueStatus.textContent = "Thumbnail matched.";
      await loadCatalogue(true);
    } catch (error) {
      matchDialogStatus.textContent = friendlyCatalogueError(error);
    } finally {
      setBusy(button, false);
    }
  }

  for (const button of buttons)
    button.addEventListener("click", () => showView(button.dataset.view));

  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      catalogueFilter = button.dataset.catalogueFilter;
      renderLimit = 100;
      for (const option of filterButtons)
        option.setAttribute("aria-pressed", String(option === button));
      renderCatalogue();
    });
  }

  catalogueSearch.addEventListener("input", () => {
    renderLimit = 100;
    renderCatalogue();
  });
  loadMoreCatalogue.addEventListener("click", () => {
    renderLimit += 100;
    renderCatalogue();
  });
  importCatalogue.addEventListener("click", () => catalogueFile.click());
  catalogueFile.addEventListener("change", async () => {
    const file = catalogueFile.files?.[0];
    if (!file) return;
    if (file.size > maximumCatalogueBytes) {
      catalogueStatus.textContent = "That catalogue file is too large.";
      catalogueFile.value = "";
      return;
    }
    setBusy(importCatalogue, true);
    catalogueStatus.textContent = "Importing catalogue…";
    try {
      await global.OFEnhancerHost.request("importCatalogueSnapshot", {
        json: await file.text(),
      });
      catalogueStatus.textContent = "Catalogue imported.";
      await loadCatalogue(true);
    } catch (error) {
      catalogueStatus.textContent = friendlyCatalogueError(error);
    } finally {
      catalogueFile.value = "";
      setBusy(importCatalogue, false);
    }
  });

  scanThumbnails.addEventListener("click", async () => {
    setBusy(scanThumbnails, true);
    catalogueStatus.textContent = "Scanning thumbnails…";
    try {
      await global.OFEnhancerHost.request("scanThumbnails");
      catalogueStatus.textContent = "Thumbnail scan complete.";
      await loadCatalogue(true);
    } catch (error) {
      catalogueStatus.textContent = friendlyCatalogueError(error);
    } finally {
      setBusy(scanThumbnails, false);
    }
  });

  closeMatchDialog.addEventListener("click", () => matchDialog.close());
  matchDialog.addEventListener("close", () => {
    if (matchDialog.open) return;
    currentAsset = null;
    matchDialogStatus.textContent = "";
  });

  googlePrimaryAction.addEventListener("click", () =>
    runGoogleAction(googlePrimaryAction.dataset.googleAction),
  );
  googleDisconnect.addEventListener("click", disconnectGoogle);

  googleClientId.addEventListener("input", () => {
    googleClientId.setCustomValidity("");
    googleClientId.setAttribute("aria-invalid", "false");
    googleSetupStatus.textContent = "";
  });
  googleSetupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const clientId = googleClientId.value.trim();
    if (
      !/^[0-9]{6,30}-[a-z0-9]{8,128}\.apps\.googleusercontent\.com$/.test(
        clientId,
      )
    ) {
      googleClientId.setCustomValidity("Enter a valid Google client ID.");
      googleClientId.setAttribute("aria-invalid", "true");
      googleSetupStatus.textContent = "Enter a valid Google client ID.";
      googleClientId.focus();
      return;
    }

    googleClientId.setCustomValidity("");
    googleClientId.setAttribute("aria-invalid", "false");
    googleClientId.value = clientId;
    const submit = googleSetupForm.querySelector('[type="submit"]');
    setBusy(submit, true);
    googleSetupForm.setAttribute("aria-busy", "true");
    googleSetupStatus.textContent = "Saving Google setup…";
    try {
      googleStatusView = await global.OFEnhancerHost.request(
        "saveGoogleClientId",
        { clientId },
      );
      googleSetupStatus.textContent = "Google setup saved.";
    } catch {
      googleSetupStatus.textContent = "OFEnhancer could not save Google setup.";
    } finally {
      setBusy(submit, false);
      googleSetupForm.setAttribute("aria-busy", "false");
    }
  });

  cancelGoogleMigration.addEventListener("click", () =>
    googleMigrationDialog.close(),
  );
  applyGoogleMigration.addEventListener("click", applyGoogleMigrationPlan);
  googleMigrationDialog.addEventListener("close", () => {
    frozenMigration = null;
    googleMigrationStatus.textContent = "";
  });

  global.addEventListener("pagehide", stopGooglePolling);
  global.addEventListener("beforeunload", stopGooglePolling);

  openUploader.addEventListener("click", async () => {
    openUploader.disabled = true;
    actionStatus.textContent = "Opening Chrome…";
    try {
      await global.OFEnhancerHost.request("openChromeUploader");
      actionStatus.textContent = "Chrome uploader opened.";
    } catch (error) {
      actionStatus.textContent =
        error.message === "extension-not-configured"
          ? "Connect the Chrome extension in Settings first."
          : "Chrome could not open the uploader.";
    } finally {
      openUploader.disabled = false;
    }
  });

  global.OFEnhancerHost.request("getStatus")
    .then((status) => {
      document.body.dataset.connected = "true";
      connectionLabel.textContent = "Connected";
      versionLabel.textContent = `v${status.productVersion}`;
      agentSetting.textContent = `Connected · protocol ${status.protocolVersion}`;
    })
    .catch(() => {
      document.body.dataset.connected = "false";
      connectionLabel.textContent = "Desktop agent unavailable";
      versionLabel.textContent = "Offline";
      agentSetting.textContent = "Not connected";
      openUploader.disabled = true;
      actionStatus.textContent = "Restart OFEnhancer to reconnect.";
    });
})(globalThis);
