(function startOFEnhancerApp(global) {
  "use strict";

  const buttons = Array.from(document.querySelectorAll("[data-view]"));
  const panels = Array.from(document.querySelectorAll("[data-panel]"));
  const connectionLabel = document.querySelector("#connectionLabel");
  const versionLabel = document.querySelector("#versionLabel");
  const agentSetting = document.querySelector("#agentSetting");
  const browserPreference = document.querySelector("#browserPreference");
  const browserPreferenceStatus = document.querySelector(
    "#browserPreferenceStatus",
  );
  const connectBrowserDialog = document.querySelector("#connectBrowserDialog");
  const connectBrowserSelect = document.querySelector("#connectBrowserSelect");
  const connectBrowserStatus = document.querySelector("#connectBrowserStatus");
  const continueBrowserConnection = document.querySelector(
    "#continueBrowserConnection",
  );
  const openUploader = document.querySelector("#openUploader");
  const actionStatus = document.querySelector("#actionStatus");
  const attentionHeading = document.querySelector("#attentionHeading");
  const attentionStatus = document.querySelector("#attentionStatus");
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
  const googleSecondaryAction = document.querySelector(
    "#googleSecondaryAction",
  );
  const googleDisconnect = document.querySelector("#googleDisconnect");
  const googleSetup = document.querySelector("#googleSetup");
  const googleSetupForm = document.querySelector("#googleSetupForm");
  const googleClientId = document.querySelector("#googleClientId");
  const googleSetupStatus = document.querySelector("#googleSetupStatus");
  const importGoogleSetup = document.querySelector("#importGoogleSetup");
  const googleSetupImportStatus = document.querySelector(
    "#googleSetupImportStatus",
  );
  const googleSettingStatus = document.querySelector("#googleSettingStatus");
  const googleSettingsAction = document.querySelector("#googleSettingsAction");
  const googleSheetUrlForm = document.querySelector("#googleSheetUrlForm");
  const googleSheetUrl = document.querySelector("#googleSheetUrl");
  const googleSheetUrlStatus = document.querySelector("#googleSheetUrlStatus");
  const googleMigrationDialog = document.querySelector(
    "#googleMigrationDialog",
  );
  const googleMigrationWorkbook = document.querySelector(
    "#googleMigrationWorkbook",
  );
  const googleMigrationSheet = document.querySelector("#googleMigrationSheet");
  const googleMigrationAdd = document.querySelector("#googleMigrationAdd");
  const googleMigrationLink = document.querySelector("#googleMigrationLink");
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
  let catalogueGeneration = 0;
  let catalogueFilter = "all";
  let renderLimit = 100;
  let currentAsset = null;
  let googleStatusView = null;
  let googlePollTimer = null;
  let frozenMigration = null;
  let browserSettingsView = null;
  let connectionStartPending = false;
  let browserDialogGeneration = 0;
  let chromeReadiness = null;
  let chromePollGeneration = 0;
  let chromeExpiry;
  let chromePoll;
  const chromeSetupDialog = document.querySelector("#chromeSetupDialog");
  const chromeLabels = {
    checking: "Checking Chrome…",
    unavailable: "Desktop agent unavailable",
    "not-found": "Chrome not found",
    setup: "Set up Chrome",
    offline: "Chrome not connected",
    repair: "Chrome setup needs repair",
    "reset-pending": "Fresh reset: action needed",
    connected: "Chrome connected",
    choose: "Choose Chrome browser",
    unsupported: "Desktop agent available",
  };

  function renderChrome(value) {
    chromeReadiness = value;
    const label = chromeLabels[value.state] || chromeLabels.checking;
    document.body.dataset.connected = String(value.state === "connected");
    connectionLabel.textContent = label;
    document.querySelector("#extensionSetting").textContent =
      `${label}. ${value.message}`;
    attentionHeading.textContent = label;
    attentionStatus.textContent = value.message;
    for (const node of document.querySelectorAll(".chrome-readiness-message"))
      node.textContent = `${label}. ${value.message}`;
    document.querySelector("#chromeSetupMessage").textContent =
      value.state === "repair"
        ? "Chrome setup needs attention. Open troubleshooting below."
        : `${label}. ${value.message}`;
    document.querySelector("#chromeSetupError").textContent =
      value.setupError || "";
    document.querySelector("#chromeResetNotice").hidden = !value.resetPending;
    document.querySelector("#chromeResetExtensionId").textContent =
      value.resetExtensionId || value.extensionId || "";
    const removing = value.resetPending && value.resetStage === "removal";
    document.querySelector("#chromeRemovalTask").hidden = !removing;
    document.querySelector("#chromeReplacementTask").hidden =
      !value.resetPending || removing;
    document.querySelector("#chromeExtensionFolder").textContent =
      value.extensionFolder ||
      "Select Set up Chrome to find the installed extension-keyed folder.";
    document.querySelector("#chromeSetupSteps").hidden =
      !value.chromeFound || removing;
    for (const button of document.querySelectorAll("[data-chrome-action]")) {
      button.hidden =
        value.state === "unsupported" ||
        value.state === "unavailable" ||
        (button.dataset.chromeAction === "installChromeInfo"
          ? value.chromeFound
          : !value.chromeFound);
    }
    for (const open of document.querySelectorAll(
      '[data-chrome-action="openChromeExtensions"]',
    ))
      open.hidden = value.canOpenExtensions !== true;
    document.querySelector('[data-chrome-action="prepareChrome"]').hidden =
      !value.chromeFound ||
      (value.prepared && !(value.resetPending && !value.extensionFolder));
    document.querySelector("#chromeAddressHint").hidden =
      value.canOpenExtensions === true;
    document.querySelector("#chromeFolderStep").hidden = Boolean(
      value.extensionId && !value.extensionFolder,
    );
    document.querySelector("#copyChromeFolder").disabled =
      !value.extensionFolder;
    document.querySelector(
      '[data-chrome-action="revealChromeExtension"]',
    ).disabled = !value.extensionFolder;
  }

  async function refreshChrome() {
    const generation = ++chromePollGeneration;
    const started = performance.now();
    // An unanswered observation cannot retain a green state indefinitely.
    const timeout = setTimeout(() => {
      if (generation !== chromePollGeneration) return;
      ++chromePollGeneration;
      renderChrome({
        state: "unavailable",
        message: "The desktop connection check did not respond. Check again.",
      });
    }, 4000);
    try {
      const status = await global.OFEnhancerHost.request("getStatus");
      if (generation !== chromePollGeneration) return;
      versionLabel.textContent = `v${status.productVersion}`;
      agentSetting.textContent = `Available · protocol ${status.protocolVersion}`;
      const value = status.capabilities?.includes("chrome-readiness")
        ? await global.OFEnhancerHost.request("getChromeReadiness")
        : {
            state: "unsupported",
            message:
              "This host does not expose desktop Chrome setup diagnostics. Use the existing Chrome extension tools; desktop availability alone does not verify publishing readiness.",
          };
      if (generation !== chromePollGeneration) return;
      clearTimeout(timeout);
      clearTimeout(chromeExpiry);
      const remaining =
        Math.min(10000, value.browserStatus?.expiresInMilliseconds || 0) -
        (performance.now() - started);
      if (value.state === "connected" && remaining <= 0)
        value.state = "checking";
      renderChrome(value);
      if (value.state === "connected")
        chromeExpiry = setTimeout(
          () => {
            renderChrome({
              state: "checking",
              message: "Fresh Chrome evidence is required. Check again.",
            });
          },
          Math.max(0, remaining),
        );
    } catch {
      if (generation !== chromePollGeneration) return;
      clearTimeout(chromeExpiry);
      clearTimeout(timeout);
      agentSetting.textContent = "Unavailable";
      renderChrome({
        state: "unavailable",
        message: "Start OFEnhancer to reconnect.",
      });
    }
  }

  async function showChromeSetup() {
    chromeSetupDialog.showModal();
    await refreshChrome();
    const prepare = document.querySelector(
      '[data-chrome-action="prepareChrome"]',
    );
    if (
      chromeReadiness?.chromeFound &&
      !prepare.disabled &&
      ((!chromeReadiness.prepared && chromeReadiness.state === "setup") ||
        (chromeReadiness.resetPending && !chromeReadiness.extensionFolder))
    )
      prepare.click();
  }
  document.querySelector("#chromeConnection").addEventListener("click", () => {
    void showChromeSetup();
  });
  for (const button of document.querySelectorAll(".chrome-setup-trigger"))
    button.addEventListener("click", () => {
      void showChromeSetup();
    });
  document
    .querySelector("#closeChromeSetup")
    .addEventListener("click", () => chromeSetupDialog.close());
  document
    .querySelector("#checkChrome")
    .addEventListener("click", refreshChrome);
  for (const button of document.querySelectorAll("[data-chrome-action]"))
    button.addEventListener("click", async () => {
      if (
        button.dataset.chromeAction === "freshChromeReset" &&
        !global.confirm(
          "Reset the OFEnhancer Chrome extension? Removing it clears its Chrome settings and upload checkpoints, but does not undo anything already submitted to a platform. Your catalogue, Google connection and desktop history stay intact. Stop active upload preparation first.",
        )
      )
        return;
      button.disabled = true;
      const message = document.querySelector("#chromeSetupActionStatus");
      try {
        message.textContent =
          button.dataset.chromeAction === "freshChromeReset"
            ? "Saving the reset task…"
            : "Opening…";
        const result = await global.OFEnhancerHost.request(
          button.dataset.chromeAction,
        );
        message.textContent =
          result?.message ||
          (button.dataset.chromeAction === "prepareChrome"
            ? "Ready. Finish the steps in Chrome."
            : "Opened. Check connection after finishing in Chrome.");
      } catch (error) {
        message.textContent = `Could not finish: ${error.message}`;
      } finally {
        button.disabled = false;
        void refreshChrome();
      }
    });
  for (const button of document.querySelectorAll("[data-reset-evidence]"))
    button.addEventListener("click", async () => {
      const evidence = button.dataset.resetEvidence;
      if (
        evidence === "unknown" &&
        !global.confirm(
          "Continue without confirming removal? The previous installation will remain denied desktop access, and a genuine replacement installation is still required.",
        )
      )
        return;
      button.disabled = true;
      const message = document.querySelector("#chromeSetupActionStatus");
      try {
        message.textContent = "Saving this Chrome status…";
        await global.OFEnhancerHost.request("continueChromeReset", {
          evidence,
        });
        message.textContent =
          evidence === "removed"
            ? "Recorded as your report. Load the replacement extension now."
            : evidence === "absent"
              ? "Recorded as your report. Load the replacement extension now."
              : "Removal remains unconfirmed. Load the replacement extension now.";
      } catch (error) {
        message.textContent = `Could not continue: ${error.message}`;
      } finally {
        button.disabled = false;
        void refreshChrome();
      }
    });
  for (const [id, value] of [
    ["copyChromeFolder", () => chromeReadiness?.extensionFolder],
    ["copyChromeAddress", () => "chrome://extensions"],
  ]) {
    document.getElementById(id).addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value() || "");
        document.querySelector("#chromeSetupActionStatus").textContent =
          "Copied.";
      } catch {
        document.querySelector("#chromeSetupActionStatus").textContent =
          "Copy was unavailable. Select and copy the displayed text.";
      }
    });
  }
  global.addEventListener("focus", refreshChrome);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshChrome();
  });
  global.addEventListener("pagehide", () => {
    ++chromePollGeneration;
    clearInterval(chromePoll);
    clearTimeout(chromeExpiry);
  });

  function showView(name) {
    for (const button of buttons) {
      const current = button.dataset.view === name;
      if (current) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    document.querySelector(`[data-panel="${name}"] h1`)?.focus?.();
    if (name === "catalogue") loadCatalogue();
    if (name === "catalogue" || name === "settings") {
      refreshGoogleCatalogue();
    } else stopGooglePolling();
    if (name === "settings") loadBrowserSettings();
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
    const sourceCells = item.sourceLinkCells || {};
    const links = [
      ...new Set([
        ...Object.keys(item.platformLinks || {}),
        ...Object.keys(sourceCells),
      ]),
    ];
    if (links.length === 0)
      platforms.append(element("span", "muted-label", "No platform links"));
    for (const platform of links)
      platforms.append(
        element(
          "span",
          "platform-badge",
          `${platformNames[platform] || platform}${sourceCells[platform]?.issueCode ? " · review link" : ""}`,
        ),
      );
    main.append(platforms);
    for (const [platform, cell] of Object.entries(sourceCells)) {
      const details = element("details", "catalogue-source-links");
      const name = platformNames[platform] || platform;
      details.append(
        element(
          "summary",
          "",
          cell.issueCode
            ? `${name} link needs review · sheet row ${item.sourceRow}`
            : `${name} · ${plural(cell.urls?.length || 0, "saved link")}`,
        ),
      );
      if (cell.issueCode) {
        details.append(
          element(
            "p",
            "",
            "The original cell was preserved. No link was chosen automatically. Correct it in your sheet, then import again.",
          ),
        );
        if (cell.text)
          details.append(
            element("p", "source-link-value", `Displayed: ${cell.text}`),
          );
        if (cell.hyperlink)
          details.append(
            element(
              "p",
              "source-link-value",
              `Clickable destination: ${cell.hyperlink}`,
            ),
          );
      } else {
        const list = element("ul", "");
        for (const url of cell.urls || [])
          list.append(element("li", "source-link-value", url));
        details.append(list);
      }
      main.append(details);
    }
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
    if (total === 0)
      document.querySelector(".catalogue-controls").before(catalogueEmpty);
    document.querySelector('[data-panel="catalogue"]').dataset.catalogueState =
      total ? "populated" : "empty";
    catalogueSummary.hidden = total === 0;
    document.querySelector(".catalogue-search").hidden = total === 0;
    document.querySelector(".filter-group").hidden = total === 0;
    scanThumbnails.hidden = total === 0;
    importCatalogue.disabled = false;
    importCatalogue.className =
      total === 0 ? "action-button" : "secondary-button";
    catalogueList.hidden = total === 0;
    scanThumbnails.disabled = false;
    catalogueSearch.disabled = total === 0;
    for (const button of filterButtons) button.disabled = total === 0;
    renderReview();
    if (total === 0) thumbnailReview.hidden = true;

    catalogueList.replaceChildren();
    const items = visibleItems();
    for (const item of items.slice(0, renderLimit))
      catalogueList.append(renderCatalogueRow(item));
    loadMoreCatalogue.hidden = items.length <= renderLimit;
    catalogueNoMatches.hidden = total === 0 || items.length !== 0;
  }

  function announceCatalogueResults() {
    const count = visibleItems().length;
    catalogueStatus.textContent = `${plural(count, "video")} shown.`;
  }

  function renderCatalogueUnavailable(error) {
    document.querySelector('[data-panel="catalogue"]').dataset.catalogueState =
      "unavailable";
    catalogueSummary.hidden = false;
    catalogueLoading.hidden = true;
    catalogueUnavailable.hidden = false;
    catalogueEmpty.hidden = true;
    catalogueNoMatches.hidden = true;
    thumbnailReview.hidden = true;
    catalogueList.replaceChildren();
    loadMoreCatalogue.hidden = true;
    catalogueList.hidden = true;
    catalogueSummary.textContent = "The local catalogue is not connected.";
    catalogueSearch.disabled = true;
    const unsupported = [
      "unsupported-operation",
      "catalogue-unavailable",
    ].includes(error?.message);
    catalogueUnavailable.querySelector("h2").textContent = unsupported
      ? "Open the desktop app"
      : "Catalogue could not load";
    catalogueUnavailable.querySelector("p").textContent = unsupported
      ? "The local catalogue is available in OFEnhancer for Windows."
      : "Your saved catalogue has not been replaced. Check the connection and try again.";
    importCatalogue.disabled = unsupported;
    scanThumbnails.disabled = true;
    for (const button of filterButtons) button.disabled = true;
  }

  async function loadCatalogue(force = false) {
    if (cataloguePromise && !force) return cataloguePromise;
    const generation = ++catalogueGeneration;
    catalogueLoading.hidden = false;
    catalogueSearch.disabled = true;
    scanThumbnails.disabled = true;
    for (const button of filterButtons) button.disabled = true;
    catalogueNoMatches.hidden = true;
    catalogueEmpty.hidden = true;
    catalogueUnavailable.hidden = true;
    cataloguePromise = global.OFEnhancerHost.request("getCatalogue")
      .then((value) => {
        if (generation !== catalogueGeneration) return null;
        if (!value || !Array.isArray(value.items))
          throw new Error("invalid-catalogue-response");
        catalogue = value;
        renderCatalogue();
        return value;
      })
      .catch((error) => {
        if (generation !== catalogueGeneration) return null;
        catalogue = null;
        renderCatalogueUnavailable(error);
        return null;
      })
      .finally(() => {
        if (generation === catalogueGeneration) cataloguePromise = null;
      });
    return cataloguePromise;
  }

  document
    .querySelector("#retryCatalogue")
    .addEventListener("click", () => loadCatalogue(true));

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

  function googleControlsAreVisible() {
    return ["catalogue", "settings"].some(
      (name) => !document.querySelector(`[data-panel="${name}"]`)?.hidden,
    );
  }

  function stopGooglePolling() {
    if (googlePollTimer !== null) global.clearTimeout(googlePollTimer);
    googlePollTimer = null;
  }

  function scheduleGooglePolling(state) {
    stopGooglePolling();
    if (
      googleControlsAreVisible() &&
      (state === "connecting" || state === "syncing")
    ) {
      googlePollTimer = global.setTimeout(refreshGoogleCatalogue, 1500);
    }
  }

  function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
  }

  function parseGoogleSheetUrl(value) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "docs.google.com" ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    const match = url.pathname.match(
      /^\/spreadsheets\/d\/([A-Za-z0-9_-]{1,256})(?:\/|$)/,
    );
    if (!match) return null;
    const fragment = new URLSearchParams(url.hash.slice(1));
    const gids = fragment.getAll("gid");
    if (gids.length > 1) return null;
    const rawGid = gids.length === 0 ? null : gids[0];
    if (rawGid !== null && !/^\d{1,10}$/.test(rawGid)) return null;
    const gid = rawGid === null ? null : Number(rawGid);
    if (gid !== null && (!Number.isSafeInteger(gid) || gid > 2147483647))
      return null;
    return `https://docs.google.com/spreadsheets/d/${match[1]}/edit${gid === null ? "" : `#gid=${gid}`}`;
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

  function setGoogleSecondaryAction(label, action) {
    googleSecondaryAction.textContent = label;
    googleSecondaryAction.dataset.googleAction = action;
    googleSecondaryAction.className = "secondary-button";
    googleSecondaryAction.hidden = false;
    setBusy(googleSecondaryAction, false);
  }

  function googleErrorPresentation(code) {
    if (code === "catalogue-layout-changed")
      return {
        message:
          "The sheet layout changed during import. Nothing was imported. Try again to read its current layout.",
        label: "Try import again",
        action: "import",
        allowDisconnect: true,
      };
    if (code === "catalogue-empty")
      return {
        message:
          "The catalogue tab has no videos with an ID and title. Your existing catalogue was kept.",
        label: "Try import again",
        action: "import",
        allowDisconnect: true,
      };
    if (code === "workbook-row-limit")
      return {
        message:
          "The catalogue tab exceeds the current import limit of 5,002 sheet rows. Your existing catalogue was kept.",
        label: "Try import again",
        action: "import",
        allowDisconnect: true,
      };
    if (code === "google-import-sync-active")
      return {
        message:
          "This workbook already uses sheet sync. Refresh it through the existing sync connection.",
        label: "Check workbook",
        action: "inspect",
      };
    if (code === "google-client-configuration-required")
      return {
        message:
          "Google setup is incomplete. Import the desktop app setup file, then connect again.",
        label: "Finish Google setup",
        action: "setup",
      };
    if (code === "workbook-profile-not-found")
      return {
        message:
          "This workbook does not match the optional sheet-sync layout. You can still import its catalogue without changing the sheet.",
        label: "Import catalogue",
        action: "import",
        allowDisconnect: true,
      };
    if (code === "catalogue-tab-not-found")
      return {
        message:
          "No catalogue tab was recognised. Import needs an ID and Title (or Name) header within the first 20 rows and 24 columns.",
        label: "Import catalogue",
        action: "import",
        allowDisconnect: true,
      };
    if (
      [
        "catalogue-tab-ambiguous",
        "catalogue-header-ambiguous",
        "workbook-profile-ambiguous",
      ].includes(code)
    )
      return {
        message:
          "More than one tab or column matches the catalogue. Nothing was imported. Use a workbook with one clearly labelled catalogue tab.",
        label: "Try import again",
        action: "import",
        allowDisconnect: true,
      };
    if (code === "selected-sheet-does-not-match-url")
      return {
        message:
          "The spreadsheet selected in Google did not match the pasted URL. Try again and choose that same spreadsheet.",
        label: "Try again",
        action: "connect",
      };
    if (
      [
        "invalid-workbook-date",
        "invalid-workbook-link",
        "invalid-workbook-count",
        "invalid-workbook-projection",
        "invalid-google-response",
      ].includes(code)
    )
      return {
        message: `The catalogue contains a value OFEnhancer could not read (${code}). Nothing was imported.`,
        label: "Try import again",
        action: "import",
        allowDisconnect: true,
      };
    if (
      [
        "token-exchange-failed",
        "invalid-token-response",
        "authorization-denied",
        "state-mismatch",
        "invalid-picked-file",
        "picked-file-validation-failed",
        "missing-refresh-token",
      ].includes(code)
    )
      return {
        message: `Google sign-in could not finish (${code}). Check the app setup and reconnect.`,
        label: "Reconnect",
        action: "connect",
      };
    if (
      [
        "browser-launch-failed",
        "browser-not-installed",
        "invalid-browser",
      ].includes(code)
    )
      return {
        message:
          "The browser could not open. Choose a browser and try connecting again.",
        label: "Connect again",
        action: "connect",
      };
    if (code === "google-catalogue-unavailable")
      return {
        message:
          "Google Sheet is unavailable. Restart OFEnhancer, then try again.",
        label: "Try again",
        action: "refresh",
      };
    if (code === "google-client-id-not-configured")
      return {
        message: "This copy needs Google setup.",
        label: "Developer setup",
        action: "developer",
        className: "secondary-button",
      };
    if (
      code === "google-operation-in-progress" ||
      code === "google-connection-in-progress"
    )
      return {
        message: "Google Sheet is busy. Wait for the current action to finish.",
        label: "Check status",
        action: "refresh",
        className: "secondary-button",
      };
    if (code === "stale-migration-plan")
      return {
        message: "The workbook changed. Check it again before reviewing.",
        label: "Check workbook",
        action: "inspect",
        allowDisconnect: true,
      };
    if (code === "google-sync-unresolved")
      return {
        message:
          "OFEnhancer could not confirm the last Google Sheet update. Sync again to check it.",
        label: "Sync again",
        action: "sync",
        allowDisconnect: true,
      };
    if (code === "google-migration-unresolved")
      return {
        message:
          "OFEnhancer could not confirm the workbook update. Check the workbook before trying again.",
        label: "Check workbook",
        action: "inspect",
        allowDisconnect: true,
      };
    if (code === "google-sync-conflict")
      return {
        message: "The workbook changed. Check it before syncing.",
        label: "Check workbook",
        action: "inspect",
        allowDisconnect: true,
      };
    if (
      code === "google-authorization-required" ||
      code === "google-token-refresh-failed"
    )
      return {
        message:
          "Your Google connection expired or is no longer valid. Reconnect to continue.",
        label: "Reconnect",
        action: "connect",
        allowDisconnect: true,
      };
    if (code === "google-session-failed" || code === "google-connection-failed")
      return {
        message:
          "OFEnhancer could not connect to Google Sheet. Reconnect to try again.",
        label: "Reconnect",
        action: "connect",
      };
    if (code === "google-connection-cancel-failed")
      return {
        message:
          "OFEnhancer could not cancel the browser connection. Check its status before trying again.",
        label: "Check status",
        action: "refresh",
        className: "secondary-button",
        allowDisconnect: true,
      };
    if (code === "google-catalogue-disconnected")
      return {
        message: "Connect your Google account to continue.",
        label: "Connect Google account",
        action: "connect",
      };
    if (code === "google-migration-failed")
      return {
        message:
          "OFEnhancer could not update the workbook. Check it before trying again.",
        label: "Check workbook",
        action: "inspect",
        allowDisconnect: true,
      };
    if (code === "google-workbook-not-ready")
      return {
        message: "Check the workbook before trying that action again.",
        label: "Check workbook",
        action: "inspect",
        allowDisconnect: true,
      };
    if (
      code === "google-connection-not-in-progress" ||
      code === "google-operation-cancelled" ||
      code === "google-disconnect-failed"
    )
      return {
        message: "Google Sheet changed state. Check its current status.",
        label: "Check status",
        action: "refresh",
        className: "secondary-button",
      };
    return null;
  }

  function defaultGoogleErrorPresentation(code) {
    if (
      code === "OFEnhancer is not connected." ||
      code === "Chrome could not reach OFEnhancer."
    )
      return {
        message:
          "Desktop app is not connected. Start OFEnhancer, then try again.",
        label: "Try again",
        action: "refresh",
      };
    return {
      message:
        "OFEnhancer could not finish the Google Sheet action. Try again.",
      label: "Try again",
      action: "refresh",
    };
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
      planHash:
        state === "migrationReady" && typeof view?.planHash === "string"
          ? view.planHash
          : "",
      rowsToBind: Number.isInteger(view?.rowsToBind) ? view.rowsToBind : 0,
      migrationChanges: Number.isInteger(view?.migrationChanges)
        ? view.migrationChanges
        : 0,
      pendingCount: Number.isInteger(view?.pendingCount)
        ? view.pendingCount
        : 0,
      attemptedCount: Number.isInteger(view?.attemptedCount)
        ? view.attemptedCount
        : 0,
      unresolvedCount: Number.isInteger(view?.unresolvedCount)
        ? view.unresolvedCount
        : 0,
      conflictCount: Number.isInteger(view?.conflictCount)
        ? view.conflictCount
        : 0,
      lastVerifiedSync: view?.lastVerifiedSync || null,
      errorCode: typeof view?.errorCode === "string" ? view.errorCode : "",
      preferredSheetUrl:
        typeof view?.preferredSheetUrl === "string"
          ? view.preferredSheetUrl
          : "",
    };
    if (
      googleStatusView.preferredSheetUrl &&
      document.activeElement !== googleSheetUrl
    )
      googleSheetUrl.value = googleStatusView.preferredSheetUrl;
    let codePresentation = googleErrorPresentation(googleStatusView.errorCode);
    const verificationCount =
      googleStatusView.attemptedCount + googleStatusView.unresolvedCount;
    if (
      codePresentation &&
      googleStatusView.errorCode === "google-sync-conflict" &&
      googleStatusView.conflictCount
    ) {
      const pendingCopy = googleStatusView.pendingCount
        ? `${plural(googleStatusView.pendingCount, "update")} waiting. `
        : "";
      const conflictVerb =
        googleStatusView.conflictCount === 1 ? "needs" : "need";
      codePresentation = {
        ...codePresentation,
        message: `${pendingCopy}${plural(googleStatusView.conflictCount, "conflict")} ${conflictVerb} review.`,
      };
    }
    if (
      codePresentation &&
      googleStatusView.errorCode === "google-sync-unresolved" &&
      verificationCount
    ) {
      const verb = verificationCount === 1 ? "needs" : "need";
      const pendingCopy = googleStatusView.pendingCount
        ? ` ${plural(googleStatusView.pendingCount, "update")} waiting.`
        : "";
      codePresentation = {
        ...codePresentation,
        message: `${plural(verificationCount, "update")} ${verb} verification.${pendingCopy}`,
        label: "Verify updates",
      };
    }
    const errorPresentation =
      codePresentation ||
      (state === "error"
        ? defaultGoogleErrorPresentation(googleStatusView.errorCode)
        : null);

    googleCatalogue.hidden = false;
    googleSecondaryAction.hidden = true;
    setBusy(googleSecondaryAction, false);
    googleDisconnect.hidden = true;
    setBusy(googleDisconnect, false);
    googleCatalogueStatus.setAttribute("aria-busy", "false");

    if (codePresentation) {
      googleCatalogueStatus.textContent = codePresentation.message;
    } else if (notice) {
      googleCatalogueStatus.textContent = notice;
    } else if (state === "notConfigured") {
      googleCatalogueStatus.textContent = "This copy needs Google setup.";
    } else if (state === "disconnected") {
      googleCatalogueStatus.textContent =
        "Connect the workbook you use for your catalogue.";
    } else if (state === "connecting") {
      googleCatalogueStatus.textContent = "Finish in your browser.";
    } else if (state === "needsInspection") {
      googleCatalogueStatus.textContent = `${googleStatusView.workbookName || "Your workbook"} is connected. Import videos without changing your sheet.`;
    } else if (state === "migrationReady") {
      const rowVerb = googleStatusView.rowsToBind === 1 ? "needs" : "need";
      const changeVerb = googleStatusView.migrationChanges === 1 ? "is" : "are";
      googleCatalogueStatus.textContent = `${plural(googleStatusView.rowsToBind, "row")} ${rowVerb} linking. ${plural(googleStatusView.migrationChanges, "workbook change")} ${changeVerb} ready.`;
    } else if (state === "ready") {
      const pendingCopy = googleStatusView.pendingCount
        ? `${plural(googleStatusView.pendingCount, "update")} waiting.`
        : "No updates waiting.";
      const conflictCopy = googleStatusView.conflictCount
        ? ` ${plural(googleStatusView.conflictCount, "conflict")} ${googleStatusView.conflictCount === 1 ? "needs" : "need"} review.`
        : "";
      googleCatalogueStatus.textContent = `${pendingCopy}${conflictCopy} ${formatGoogleDate(googleStatusView.lastVerifiedSync)}`;
    } else if (state === "syncing") {
      googleCatalogueStatus.textContent = "Syncing Google Sheet…";
      googleCatalogueStatus.setAttribute("aria-busy", "true");
    } else if (state === "conflict") {
      googleCatalogueStatus.textContent =
        "The workbook changed. Check it before syncing.";
    } else {
      googleCatalogueStatus.textContent = errorPresentation.message;
    }

    if (codePresentation) {
      setGooglePrimaryAction(
        codePresentation.label,
        codePresentation.action,
        codePresentation.className,
      );
      if (
        googleStatusView.errorCode === "google-sync-conflict" &&
        googleStatusView.pendingCount
      )
        setGoogleSecondaryAction("Sync pending updates", "sync");
      googleDisconnect.hidden = !codePresentation.allowDisconnect;
    } else if (state === "notConfigured") {
      setGooglePrimaryAction(
        "Developer setup",
        "developer",
        "secondary-button",
      );
    } else if (state === "disconnected") {
      setGooglePrimaryAction("Connect Google account", "connect");
    } else if (state === "connecting") {
      setGooglePrimaryAction("Cancel", "cancel", "secondary-button");
    } else if (state === "needsInspection") {
      setGooglePrimaryAction("Import catalogue", "import");
      setGoogleSecondaryAction("Set up sheet sync", "inspect");
      googleDisconnect.hidden = false;
    } else if (state === "migrationReady") {
      setGooglePrimaryAction("Review changes", "review");
      googleDisconnect.hidden = false;
    } else if (state === "ready") {
      if (googleStatusView.conflictCount) {
        setGooglePrimaryAction("Check workbook", "inspect");
        if (googleStatusView.pendingCount)
          setGoogleSecondaryAction("Sync pending updates", "sync");
      } else setGooglePrimaryAction("Sync now", "sync");
      googleDisconnect.hidden = false;
    } else if (state === "syncing") {
      setGooglePrimaryAction("Syncing…", "sync");
      setBusy(googlePrimaryAction, true);
      googleDisconnect.hidden = false;
      googleDisconnect.disabled = true;
    } else if (state === "conflict") {
      setGooglePrimaryAction("Check workbook", "inspect");
      if (googleStatusView.pendingCount)
        setGoogleSecondaryAction("Sync pending updates", "sync");
      googleDisconnect.hidden = false;
    } else {
      setGooglePrimaryAction(
        errorPresentation.label,
        errorPresentation.action,
        errorPresentation.className,
      );
      googleDisconnect.hidden = !errorPresentation.allowDisconnect;
    }

    renderGoogleSettings();
    scheduleGooglePolling(state);
  }

  function setGoogleSettingsAction(label, action) {
    googleSettingsAction.textContent = label;
    googleSettingsAction.dataset.googleAction = action;
    googleSettingsAction.hidden = false;
    setBusy(googleSettingsAction, false);
  }

  function renderGoogleSettings() {
    const state = googleStatusView?.state || "error";
    const needsDeveloperSetup =
      state === "notConfigured" ||
      googleStatusView?.errorCode === "google-client-id-not-configured" ||
      googleStatusView?.errorCode === "google-client-configuration-required";
    googleSetup.hidden = false;
    if (needsDeveloperSetup) {
      googleSettingStatus.textContent =
        "Google setup is incomplete. Import the desktop app setup file to connect.";
      googleSettingStatus.dataset.state = "disconnected";
      setGoogleSettingsAction("Finish Google setup", "setup");
    } else if (state === "disconnected") {
      googleSettingStatus.textContent = "Not connected";
      googleSettingStatus.dataset.state = "disconnected";
      setGoogleSettingsAction("Connect Google account", "connect");
    } else if (state === "connecting") {
      googleSettingStatus.textContent = "Waiting for Google authorization…";
      googleSettingStatus.dataset.state = "loading";
      setGoogleSettingsAction("Cancel", "cancel");
    } else if (
      state === "needsInspection" ||
      state === "migrationReady" ||
      state === "ready" ||
      state === "syncing" ||
      state === "conflict"
    ) {
      googleSettingStatus.textContent = `Connected to Google · ${googleStatusView.workbookName || "Your workbook"}${googleStatusView.sheetName ? ` — ${googleStatusView.sheetName}` : ""}`;
      googleSettingStatus.dataset.state = "connected";
      setGoogleSettingsAction("Open catalogue", "catalogue");
    } else if (
      googleStatusView?.errorCode === "google-authorization-required" ||
      googleStatusView?.errorCode === "google-token-refresh-failed"
    ) {
      googleSettingStatus.textContent = "Authorization failed or expired";
      googleSettingStatus.dataset.state = "error";
      setGoogleSettingsAction("Reconnect", "connect");
    } else {
      googleSettingStatus.textContent = "Google connection needs attention";
      googleSettingStatus.dataset.state = "error";
      setGoogleSettingsAction("Open catalogue", "catalogue");
    }
  }

  async function refreshGoogleCatalogue() {
    stopGooglePolling();
    if (!googleControlsAreVisible()) return;
    try {
      const status = await global.OFEnhancerHost.request(
        "getGoogleCatalogueStatus",
      );
      if (googleControlsAreVisible()) renderGoogleCatalogue(status);
    } catch (error) {
      if (!googleControlsAreVisible()) return;
      renderGoogleCatalogue({ state: "error", errorCode: error?.message });
    }
  }

  function renderBrowserSettings(view, notice = "") {
    const options = Array.isArray(view?.options) ? view.options : [];
    const selectedId = String(view?.selectedId || "system");
    browserSettingsView = {
      selectedId,
      options: options.map((option) => ({
        id: String(option.id || ""),
        name: String(option.name || option.id || ""),
      })),
    };
    browserPreference.replaceChildren();
    for (const option of browserSettingsView.options) {
      if (!option.id || !option.name) continue;
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.name;
      browserPreference.append(element);
    }
    browserPreference.value = selectedId;
    browserPreference.disabled = false;
    browserPreferenceStatus.textContent =
      notice ||
      `Google sign-in opens in ${
        browserSettingsView.options.find((option) => option.id === selectedId)
          ?.name || "System default"
      }.`;
  }

  async function loadBrowserSettings() {
    browserPreference.disabled = true;
    browserPreferenceStatus.textContent = "Checking installed browsers…";
    try {
      renderBrowserSettings(
        await global.OFEnhancerHost.request("getBrowserOptions"),
      );
    } catch {
      browserPreferenceStatus.textContent =
        "Browser choices are unavailable while the desktop app is disconnected.";
    }
  }

  async function saveBrowserPreference() {
    const browserId = browserPreference.value;
    const previousId = browserSettingsView?.selectedId || "system";
    browserPreference.disabled = true;
    browserPreferenceStatus.textContent = "Saving browser choice…";
    try {
      renderBrowserSettings(
        await global.OFEnhancerHost.request("saveBrowserPreference", {
          browserId,
        }),
        "Browser choice saved.",
      );
    } catch {
      browserPreference.value = previousId;
      browserPreference.disabled = false;
      browserPreferenceStatus.textContent =
        "That browser is no longer available. Choose another browser.";
    }
  }

  function openGoogleSettings() {
    showView("settings");
    googleSetup.hidden = false;
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
    googleMigrationAdd.textContent = `${plural(frozenMigration.migrationChanges, "workbook change")} for publishing, assets, and history`;
    googleMigrationLink.textContent = `${plural(frozenMigration.rowsToBind, "catalogue row")} to OFEnhancer`;
    googleMigrationConflicts.textContent = plural(
      frozenMigration.conflictCount,
      "conflict",
    );
    googleMigrationStatus.textContent = "";
    googleMigrationDialog.showModal();
  }

  function selectedConnectionBrowserName() {
    const selectedId = connectBrowserSelect.value;
    return (
      browserSettingsView?.options.find((option) => option.id === selectedId)
        ?.name || "The selected browser"
    );
  }

  function connectionBrowserFailureMessage(code) {
    if (
      code === "browser-launch-failed" ||
      code === "browser-not-installed" ||
      code === "invalid-browser"
    )
      return `${selectedConnectionBrowserName()} could not open. Choose another browser or try again.`;
    if (code === "google-client-configuration-required")
      return "Google setup is incomplete. Open Developer setup or try again after updating OFEnhancer.";
    return "Google sign-in could not start. Check your connection and try again.";
  }

  async function chooseConnectionBrowser(payload) {
    let view;
    try {
      view = await global.OFEnhancerHost.request("getBrowserOptions");
    } catch {
      // Older hosts can still connect using their own browser launcher.
      return "continue";
    }
    renderBrowserSettings(view);
    if (
      browserSettingsView.options.filter((option) => option.id !== "system")
        .length < 2
    )
      return "continue";
    connectBrowserSelect.replaceChildren(
      ...Array.from(browserPreference.options, (option) =>
        option.cloneNode(true),
      ),
    );
    connectBrowserSelect.value = browserPreference.value;
    connectBrowserSelect.disabled = false;
    setBusy(continueBrowserConnection, false);
    connectBrowserStatus.textContent = "";
    connectBrowserDialog.returnValue = "";
    const generation = ++browserDialogGeneration;
    const choice = new Promise((resolve) => {
      const continueConnection = async () => {
        let preferenceSaved = false;
        setBusy(continueBrowserConnection, true);
        connectBrowserSelect.disabled = true;
        connectBrowserStatus.textContent = "Saving browser choice…";
        try {
          const saved = await global.OFEnhancerHost.request(
            "saveBrowserPreference",
            { browserId: connectBrowserSelect.value },
          );
          if (
            generation !== browserDialogGeneration ||
            !connectBrowserDialog.open
          )
            return;
          renderBrowserSettings(saved);
          preferenceSaved = true;
          connectBrowserStatus.textContent = "Opening your browser…";
          await performGoogleAction("connect", payload, true);
          if (generation !== browserDialogGeneration) return;
          if (connectBrowserDialog.open) connectBrowserDialog.close("started");
        } catch (error) {
          if (generation !== browserDialogGeneration) return;
          connectBrowserStatus.textContent = !preferenceSaved
            ? "Could not save that browser choice. Choose another browser or try again."
            : connectionBrowserFailureMessage(error?.message);
        } finally {
          if (generation === browserDialogGeneration) {
            setBusy(continueBrowserConnection, false);
            connectBrowserSelect.disabled = false;
          }
        }
      };
      connectBrowserDialog.addEventListener(
        "close",
        () => {
          if (generation === browserDialogGeneration)
            browserDialogGeneration += 1;
          continueBrowserConnection.removeEventListener(
            "click",
            continueConnection,
          );
          resolve(connectBrowserDialog.returnValue || "cancel");
        },
        { once: true },
      );
      continueBrowserConnection.addEventListener("click", continueConnection);
    });
    connectBrowserDialog.showModal();
    return choice;
  }

  async function runGoogleAction(action, payload = {}) {
    if (action !== "connect") return performGoogleAction(action, payload);
    if (connectionStartPending) return;
    connectionStartPending = true;
    try {
      if ((await chooseConnectionBrowser(payload)) === "continue")
        await performGoogleAction(action, payload);
    } finally {
      connectionStartPending = false;
    }
  }

  async function performGoogleAction(
    action,
    payload = {},
    throwOnError = false,
  ) {
    if (action === "setup") {
      showView("settings");
      googleSetup.hidden = false;
      googleSetup.open = true;
      global.requestAnimationFrame(() => importGoogleSetup.focus());
      return;
    }
    if (action === "developer") {
      openGoogleSettings();
      return;
    }
    if (action === "catalogue") {
      showView("catalogue");
      return;
    }
    if (action === "review") {
      openGoogleMigrationReview();
      return;
    }
    if (action === "refresh") {
      setBusy(googlePrimaryAction, true);
      if (!googleSecondaryAction.hidden) setBusy(googleSecondaryAction, true);
      googleDisconnect.disabled = true;
      googleCatalogueStatus.setAttribute("aria-busy", "true");
      googleCatalogueStatus.textContent = "Checking Google Sheet status…";
      await refreshGoogleCatalogue();
      return;
    }
    const operations = {
      connect: "startGoogleCatalogueConnection",
      cancel: "cancelGoogleCatalogueConnection",
      inspect: "inspectGoogleWorkbook",
      sync: "syncGoogleCatalogue",
      import: "importGoogleCatalogue",
    };
    const operation = operations[action];
    if (!operation) return;

    setBusy(googlePrimaryAction, true);
    if (!googleSecondaryAction.hidden) setBusy(googleSecondaryAction, true);
    googleDisconnect.disabled = true;
    googleCatalogueStatus.setAttribute("aria-busy", "true");
    const workingCopy = {
      connect: "Opening your browser…",
      cancel: "Cancelling connection…",
      inspect: "Checking workbook…",
      sync: "Syncing Google Sheet…",
      import: "Finding the catalogue tab and importing videos…",
    };
    googleCatalogueStatus.textContent = workingCopy[action];
    try {
      const result = await global.OFEnhancerHost.request(operation, payload);
      if (action === "import") {
        renderGoogleCatalogue(
          result.status,
          `Imported ${plural(result.importedItems, "video")} from ${result.sheetName}.${result.issues?.length ? ` Review ${plural(result.issues.length, "link cell")}; the original values were preserved in the catalogue.` : ""}`,
        );
        await loadCatalogue(true);
      } else renderGoogleCatalogue(result);
      if (action === "inspect") await loadCatalogue(true);
    } catch (error) {
      renderGoogleCatalogue({
        ...googleStatusView,
        state: "error",
        errorCode: error?.message,
      });
      if (throwOnError) throw error;
    }
  }

  async function disconnectGoogle() {
    setBusy(googleDisconnect, true);
    setBusy(googlePrimaryAction, true);
    if (!googleSecondaryAction.hidden) setBusy(googleSecondaryAction, true);
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
      await loadCatalogue(true);
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
            status?.state === "migrationReady"
              ? "The workbook changed. Review the updated changes."
              : "",
          );
          await loadCatalogue(true);
        } catch (inspectionError) {
          renderGoogleCatalogue({
            ...googleStatusView,
            state: "error",
            errorCode: inspectionError?.message,
          });
        }
      } else {
        googleMigrationDialog.close();
        renderGoogleCatalogue({
          ...googleStatusView,
          state: "error",
          planHash: null,
          errorCode: error?.message,
        });
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
      announceCatalogueResults();
    });
  }

  catalogueSearch.addEventListener("input", () => {
    renderLimit = 100;
    renderCatalogue();
    announceCatalogueResults();
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
  googleSecondaryAction.addEventListener("click", () =>
    runGoogleAction(googleSecondaryAction.dataset.googleAction),
  );
  googleDisconnect.addEventListener("click", disconnectGoogle);
  googleSettingsAction.addEventListener("click", () =>
    runGoogleAction(googleSettingsAction.dataset.googleAction),
  );
  browserPreference.addEventListener("change", saveBrowserPreference);
  document
    .querySelector("#cancelBrowserConnection")
    .addEventListener("click", () => connectBrowserDialog.close());
  importGoogleSetup.addEventListener("click", async () => {
    setBusy(importGoogleSetup, true);
    googleSetupImportStatus.textContent =
      "Choose the Google desktop app setup file…";
    try {
      const status = await global.OFEnhancerHost.request(
        "importGoogleClientConfiguration",
      );
      renderGoogleCatalogue(status);
      googleSetupImportStatus.textContent =
        status?.errorCode === "google-client-configuration-required" ||
        status?.state === "notConfigured"
          ? "No setup file was imported."
          : "Google setup saved on this PC.";
      if (status?.state !== "notConfigured" && !status?.errorCode)
        googleSetup.open = false;
      if (!googleSetup.hidden) importGoogleSetup.focus();
      else googleSettingsAction.focus();
    } catch (error) {
      const messages = {
        "google-client-configuration-invalid":
          "Choose the Desktop app JSON file downloaded from Google Cloud.",
        "google-client-configuration-mismatch":
          "That setup file belongs to a different Google app. Choose the file for OFEnhancer.",
        "google-client-configuration-save-failed":
          "OFEnhancer could not save the setup file. Try again.",
      };
      googleSetupImportStatus.textContent =
        messages[error?.message] ||
        "The setup file could not be imported. Finish any connection in progress, then try again.";
      importGoogleSetup.focus();
    } finally {
      setBusy(importGoogleSetup, false);
    }
  });

  googleClientId.addEventListener("input", () => {
    googleClientId.setCustomValidity("");
    googleClientId.setAttribute("aria-invalid", "false");
    googleSetupStatus.textContent = "";
  });
  googleSheetUrl.addEventListener("input", () => {
    googleSheetUrl.setCustomValidity("");
    googleSheetUrl.setAttribute("aria-invalid", "false");
    googleSheetUrlStatus.textContent = "";
  });
  googleSheetUrlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const canonicalUrl = parseGoogleSheetUrl(googleSheetUrl.value);
    if (!canonicalUrl) {
      const message =
        "Paste a Google Sheets URL like https://docs.google.com/spreadsheets/d/…";
      googleSheetUrl.setCustomValidity(message);
      googleSheetUrl.setAttribute("aria-invalid", "true");
      googleSheetUrlStatus.textContent = message;
      googleSheetUrl.focus();
      return;
    }
    googleSheetUrl.setCustomValidity("");
    googleSheetUrl.setAttribute("aria-invalid", "false");
    googleSheetUrl.value = canonicalUrl;
    try {
      const saved = await global.OFEnhancerHost.request(
        "saveGoogleSheetTarget",
        { sheetUrl: canonicalUrl },
      );
      renderGoogleCatalogue(saved);
      if (
        saved.state === "notConfigured" ||
        saved.errorCode === "google-client-configuration-required"
      ) {
        googleSheetUrlStatus.textContent =
          "Sheet saved on this PC. Finish Google setup, then connect and import it.";
        return;
      }
      googleSheetUrlStatus.textContent =
        "Sheet saved. Continue in Google and select this same spreadsheet.";
      await runGoogleAction("connect", { sheetUrl: canonicalUrl });
    } catch (error) {
      googleSheetUrlStatus.textContent =
        error?.message || "Could not save the Sheet URL.";
    }
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
    googleClientId.readOnly = true;
    setBusy(googleClientId, true);
    setBusy(submit, true);
    googleSetupForm.setAttribute("aria-busy", "true");
    googleSetupStatus.textContent = "Saving Google setup…";
    try {
      const status = await global.OFEnhancerHost.request("saveGoogleClientId", {
        clientId,
      });
      if (googleClientId.value.trim() === clientId) {
        googleSetupStatus.textContent = "Google setup saved.";
        renderGoogleCatalogue(status);
        googleSetup.open = false;
      } else {
        googleSetupStatus.textContent =
          "Google setup changed while saving. Save the current value again.";
      }
    } catch {
      googleSetupStatus.textContent = "OFEnhancer could not save Google setup.";
    } finally {
      googleClientId.readOnly = false;
      setBusy(googleClientId, false);
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
    if (global.chrome?.webview) {
      if (!["connected", "choose"].includes(chromeReadiness?.state)) {
        void showChromeSetup();
        return;
      }
      global.location.href = "upload-console.html";
      return;
    }
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

  void refreshChrome();
  if (new URLSearchParams(global.location.search).get("chrome-setup") === "1")
    void showChromeSetup();
  chromePoll = setInterval(refreshChrome, 5000);
})(globalThis);
