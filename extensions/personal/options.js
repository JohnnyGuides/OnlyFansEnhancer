"use strict";

const { cropImportedImage } = globalThis.FanAvatarCrop;
const $ = (selector) => document.querySelector(selector);
const CATALOGUE_CLIENT = globalThis.CreatorCatalogueClient;
if (!CATALOGUE_CLIENT) {
  throw new Error("Creator catalogue client failed to load.");
}

function showStatus(message, isError = false) {
  const status = $("#status");
  status.textContent = message;
  status.style.color = isError ? "#ffb4c4" : "#91d8ac";
}

function showCatalogueStatus(message, isError = false) {
  const status = $("#catalogueBridgeStatus");
  status.textContent = message;
  status.style.color = isError ? "#ffb4c4" : "#91d8ac";
}

function toggleGelbooruFields() {
  const mode = $("#avatarMode").value;
  $("#gelbooruFields").hidden = !["gelbooru", "mixed"].includes(mode);
  $("#realbooruFields").hidden = !["realbooru", "mixed"].includes(mode);
  $("#customFields").hidden = mode !== "custom";
}

function gelbooruCredentials() {
  let userId = $("#gelbooruUserId").value.trim();
  let apiKey = $("#gelbooruApiKey").value.trim();

  if (/(?:^|[?&])api_key=/i.test(apiKey)) {
    const fragment = apiKey.replace(/^[?&]/, "");
    const params = new URLSearchParams(fragment);
    apiKey = (params.get("api_key") || "").trim();
    userId = (params.get("user_id") || userId).trim();
  }

  return { userId, apiKey };
}

function validateGelbooruCredentials() {
  const credentials = gelbooruCredentials();
  if (!credentials.userId || !credentials.apiKey) {
    throw new Error("Enter both your numeric Gelbooru user ID and API key.");
  }
  if (!/^\d+$/.test(credentials.userId)) {
    throw new Error(
      "Gelbooru user ID must contain digits only—not your username. Check your profile URL for ?id=…",
    );
  }
  return credentials;
}

async function loadCatalogueBridge() {
  const config = await CATALOGUE_CLIENT.loadConfig();
  $("#catalogueBridgeUrl").value = config.endpoint;
  $("#catalogueBridgeSecret").value = config.secret;
  showCatalogueStatus(
    config.endpoint && config.secret
      ? "Catalogue bridge settings are stored locally."
      : "Catalogue bridge is not configured yet.",
  );
}

async function saveCatalogueBridge() {
  showCatalogueStatus("");
  const config = CATALOGUE_CLIENT.normalizeConfig({
    endpoint: $("#catalogueBridgeUrl").value,
    secret: $("#catalogueBridgeSecret").value,
  });
  if (!config.valid) throw new Error(config.errors.join(" "));
  const granted = await chrome.permissions.request({
    origins: [
      "https://script.google.com/*",
      "https://script.googleusercontent.com/*",
    ],
  });
  if (!granted) throw new Error("Apps Script site permission was not granted.");
  const saved = await CATALOGUE_CLIENT.saveConfig(config.value);
  $("#catalogueBridgeUrl").value = saved.endpoint;
  $("#catalogueBridgeSecret").value = saved.secret;
  showCatalogueStatus("Catalogue bridge saved for the upload console.");
}

const SYNC_SCRIPT = globalThis.CreatorSyncScript;

function showSyncScriptStatus(message, isError = false) {
  const status = $("#syncScriptStatus");
  status.textContent = message;
  status.style.color = isError ? "#ffb4c4" : "#91d8ac";
}

async function loadSyncScript() {
  const stored = (await chrome.storage.local.get(SYNC_SCRIPT.SETTINGS_KEY))[
    SYNC_SCRIPT.SETTINGS_KEY
  ];
  $("#syncScriptOrigin").value = stored?.origin || SYNC_SCRIPT.DEFAULT_ORIGIN;
  $("#syncScriptToken").value = stored?.token || "";
  showSyncScriptStatus(
    stored?.token
      ? "Script upload settings are stored locally."
      : "Script upload is not configured yet.",
  );
}

async function saveSyncScript() {
  showSyncScriptStatus("");
  const settings = SYNC_SCRIPT.normalizeSettings({
    origin: $("#syncScriptOrigin").value,
    token: $("#syncScriptToken").value,
  });
  if (!settings.valid) throw new Error(settings.errors.join(" "));
  const granted = await chrome.permissions.request({
    origins: [`${settings.value.origin}/*`],
  });
  if (!granted) throw new Error("Website permission was not granted.");
  await chrome.storage.local.set({
    [SYNC_SCRIPT.SETTINGS_KEY]: settings.value,
  });
  $("#syncScriptOrigin").value = settings.value.origin;
  showSyncScriptStatus("Script upload saved for the upload console.");
}

async function loadIdentitySettings() {
  const { settings } = await globalThis.FanIdentityMaskSendMessage({
    type: "GET_SETTINGS",
  });
  $("#enabled").checked = settings.enabled;
  $("#ownHandles").value = settings.ownHandles.join(", ");
  $("#avatarMode").value = settings.avatarMode;
  $("#gelbooruRatingMode").value = settings.gelbooruRatingMode || "any";
  $("#gelbooruUserId").value = settings.gelbooruUserId;
  $("#gelbooruApiKey").value = settings.gelbooruApiKey;
  toggleGelbooruFields();
}

async function loadIdentityStats() {
  const { stats } = await globalThis.FanIdentityMaskSendMessage({
    type: "GET_STATS",
  });
  $("#mappedAccounts").textContent = stats.mappedAccounts;
  $("#usedAnimeSelfies").textContent =
    stats.usedRemoteSelfies ?? stats.usedAnimeSelfies;
  $("#importedAvatars").textContent = stats.importedAvatars;

  const error = $("#avatarError");
  error.hidden = !stats.lastAvatarError;
  error.textContent = stats.lastAvatarError
    ? `Latest remote-avatar fallback: ${stats.lastAvatarError}`
    : "";
  $("#gelbooruDebug").textContent = stats.lastAvatarError
    ? `Last background result: ${stats.lastAvatarError}`
    : "No Gelbooru error is currently recorded.";
  $("#realbooruDebug").textContent = stats.lastAvatarError
    ? `Last background result: ${stats.lastAvatarError}`
    : "No Realbooru error is currently recorded.";
}

function createAvatarTile({ imageUrl, title, subtitle, action, run }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "avatar-tile";
  button.setAttribute("aria-label", `${action}: ${title} ${subtitle}`.trim());

  const media = document.createElement("span");
  media.className = "avatar-tile-media";
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  const fallback = document.createElement("span");
  fallback.className = "avatar-tile-fallback";
  fallback.textContent = "Image unavailable";
  fallback.hidden = Boolean(imageUrl);
  if (imageUrl) {
    image.src = imageUrl;
    image.addEventListener("error", () => {
      image.hidden = true;
      fallback.hidden = false;
    });
  }
  const overlay = document.createElement("span");
  overlay.className = "avatar-tile-action";
  overlay.textContent = action;
  media.append(image, fallback, overlay);

  const caption = document.createElement("span");
  caption.className = "avatar-tile-caption";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = subtitle;
  caption.append(heading, detail);
  button.append(media, caption);

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await run();
      await Promise.all([loadAvatarManagementView(), loadIdentityStats()]);
      showStatus(`${action} completed.`);
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  return button;
}

async function loadAvatarManagementView() {
  const { avatarView } = await globalThis.FanIdentityMaskSendMessage({
    type: "GET_AVATAR_MANAGEMENT_VIEW",
  });
  const currentGrid = $("#currentAvatarGrid");
  const retiredGrid = $("#retiredAvatarGrid");
  currentGrid.replaceChildren();
  retiredGrid.replaceChildren();

  for (const item of avatarView.current) {
    const handle = item.handle
      ? `@${item.handle.replace(/^@/, "")}`
      : "Masked account";
    currentGrid.appendChild(
      createAvatarTile({
        imageUrl: item.avatarUrl,
        title: item.displayName,
        subtitle: handle,
        action: "Regenerate",
        run: () =>
          globalThis.FanIdentityMaskSendMessage({
            type: "ROTATE_AVATAR",
            primaryKey: item.primaryKey,
            aliases: [],
          }),
      }),
    );
  }

  for (const item of avatarView.retired) {
    retiredGrid.appendChild(
      createAvatarTile({
        imageUrl: item.sourceUrl,
        title: item.source || "gelbooru",
        subtitle: `#${item.id}`,
        action: "Re-enable",
        run: () =>
          globalThis.FanIdentityMaskSendMessage({
            type: "REENABLE_REMOTE_AVATAR",
            source: item.source,
            id: item.id,
          }),
      }),
    );
  }

  $("#currentAvatarEmpty").hidden = avatarView.current.length > 0;
  $("#retiredAvatarEmpty").hidden = avatarView.retired.length > 0;
}

function renderXFirstReply(view) {
  $("#xFirstReplyEnabled").checked = view.enabled;
  const counts = Object.entries(view.counters || {})
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${outcome} ${count}`);
  // Neutral status text; only a desktop error is coloured.
  if (view.lastError) $("#xFirstReplyStatus").dataset.tone = "error";
  else delete $("#xFirstReplyStatus").dataset.tone;
  $("#xFirstReplyStatus").textContent = [
    `Status: ${view.label}.`,
    `${view.pending} pending.`,
    view.lastError ? `Last desktop error: ${view.lastError}.` : "",
    counts.length ? `Outcomes: ${counts.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  $("#xFirstReplyLog").replaceChildren(
    ...(view.log || []).slice(0, 10).map((entry) => {
      const row = document.createElement("li");
      row.textContent = `${entry.at} ${entry.statusId}: ${entry.outcome}${
        entry.late ? " (late)" : ""
      }${entry.replyId ? ` reply ${entry.replyId}` : ""}`;
      return row;
    }),
  );
}

async function loadXFirstReply() {
  const { xFirstReply } = await globalThis.FanIdentityMaskSendMessage({
    type: "GET_X_FIRST_REPLY_STATUS",
  });
  renderXFirstReply(xFirstReply);
}

async function setXFirstReply(enabled) {
  const { xFirstReply } = await globalThis.FanIdentityMaskSendMessage({
    type: "SET_X_FIRST_REPLY_ENABLED",
    enabled,
  });
  renderXFirstReply(xFirstReply);
}

async function load() {
  const results = await Promise.allSettled([
    loadXFirstReply(),
    loadCatalogueBridge(),
    loadSyncScript(),
    loadIdentitySettings(),
    loadIdentityStats(),
    loadAvatarManagementView(),
  ]);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));
  if (failures.length) {
    showStatus(
      `Some settings panels could not load: ${failures.join(" ")}`,
      true,
    );
  }
}

async function importImages() {
  const files = [...$("#customImages").files].slice(0, 300);
  if (!files.length) throw new Error("Choose one or more image files first.");

  $("#avatarMode").value = "custom";
  toggleGelbooruFields();
  const progress = $("#importProgress");
  let imported = 0;
  let faceDetected = 0;
  let batch = [];

  for (let index = 0; index < files.length; index += 1) {
    progress.textContent = `Cropping ${index + 1} of ${files.length}…`;
    const avatar = await cropImportedImage(files[index]);
    if (avatar.detection === "face") faceDetected += 1;
    batch.push(avatar);

    if (batch.length === 20 || index === files.length - 1) {
      const response = await globalThis.FanIdentityMaskSendMessage({
        type: "ADD_CUSTOM_AVATARS",
        avatars: batch,
      });
      imported = response.importedAvatars;
      batch = [];
    }
  }

  progress.textContent =
    `Pack now contains ${imported} images. Native faces found in ${faceDetected}; ` +
    `the rest used smart crop.`;
  await load();
  $("#avatarMode").value = "custom";
  toggleGelbooruFields();
}

async function clearImages() {
  if (!confirm("Delete every imported avatar from this extension?")) return;
  await globalThis.FanIdentityMaskSendMessage({ type: "CLEAR_CUSTOM_AVATARS" });
  await load();
  showStatus("Imported image pack cleared.");
}

async function requestGelbooruPermission() {
  return chrome.permissions.request({
    origins: ["https://gelbooru.com/*", "https://*.gelbooru.com/*"],
  });
}

async function requestRealbooruPermission() {
  return chrome.permissions.request({
    origins: ["https://realbooru.com/*"],
  });
}

async function testGelbooru() {
  showStatus("");
  const debug = $("#gelbooruDebug");
  const button = $("#testGelbooru");
  const credentials = validateGelbooruCredentials();

  const granted = await requestGelbooruPermission();
  if (!granted) throw new Error("Gelbooru site permission was not granted.");

  button.disabled = true;
  button.textContent = "Testing…";
  debug.textContent = "Contacting Gelbooru without sending any OnlyFans data…";

  try {
    const { test } = await globalThis.FanIdentityMaskSendMessage({
      type: "TEST_GELBOORU",
      gelbooruUserId: credentials.userId,
      gelbooruApiKey: credentials.apiKey,
      gelbooruRatingMode: $("#gelbooruRatingMode").value,
    });
    debug.textContent =
      `${test.message} Query: ${test.query}. ` +
      `Returned: ${test.returnedPosts}; usable after local filters: ${test.usablePosts}.`;
    showStatus("Gelbooru connection test completed.");
  } catch (error) {
    debug.textContent = `Test failed: ${error.message}`;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Test Gelbooru connection";
  }
}

async function testRealbooru() {
  showStatus("");
  const debug = $("#realbooruDebug");
  const button = $("#testRealbooru");
  const granted = await requestRealbooruPermission();
  if (!granted) {
    throw new Error("Realbooru site permission was not granted.");
  }

  button.disabled = true;
  button.textContent = "Testing…";
  debug.textContent =
    "Fetching public Realbooru pages inside the extension without OnlyFans data…";

  try {
    const { test } = await globalThis.FanIdentityMaskSendMessage({
      type: "TEST_REALBOORU",
    });
    debug.textContent =
      `${test.message} Returned: ${test.returnedPosts}; ` +
      `usable after local filters: ${test.usablePosts}.`;
    showStatus("Realbooru connection test completed.");
  } catch (error) {
    debug.textContent = `Test failed: ${error.message}`;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Test Realbooru connection";
  }
}

async function save() {
  showStatus("");
  const avatarMode = $("#avatarMode").value;
  const credentials = ["gelbooru", "mixed"].includes(avatarMode)
    ? validateGelbooruCredentials()
    : gelbooruCredentials();

  if (["gelbooru", "mixed"].includes(avatarMode)) {
    const granted = await requestGelbooruPermission();
    if (!granted) throw new Error("Gelbooru permission was not granted.");
  }
  if (["realbooru", "mixed"].includes(avatarMode)) {
    const granted = await requestRealbooruPermission();
    if (!granted) {
      throw new Error("Realbooru site permission was not granted.");
    }
  }
  if (avatarMode === "custom") {
    const { stats } = await globalThis.FanIdentityMaskSendMessage({
      type: "GET_STATS",
    });
    if (!stats.importedAvatars) {
      throw new Error(
        "Import at least one selfie before selecting the custom pack.",
      );
    }
  }

  const patch = {
    enabled: $("#enabled").checked,
    ownHandles: $("#ownHandles")
      .value.split(",")
      .map((value) => value.trim().replace(/^@/, ""))
      .filter(Boolean),
    avatarMode,
    gelbooruRatingMode: $("#gelbooruRatingMode").value,
    gelbooruUserId: credentials.userId,
    gelbooruApiKey: credentials.apiKey,
  };

  await globalThis.FanIdentityMaskSendMessage({ type: "SET_SETTINGS", patch });
  $("#gelbooruUserId").value = credentials.userId;
  $("#gelbooruApiKey").value = credentials.apiKey;
  showStatus("Identity-mask settings saved.");
}

async function resetMappings() {
  const confirmed = confirm(
    "Reset every saved fan alias and avatar assignment? The next page load will create new identities.",
  );
  if (!confirmed) return;

  await globalThis.FanIdentityMaskSendMessage({ type: "RESET_MAPPINGS" });
  await load();
  showStatus("All mappings were reset.");
}

$("#avatarMode").addEventListener("change", toggleGelbooruFields);
$("#xFirstReplyEnabled").addEventListener("change", (event) => {
  setXFirstReply(event.target.checked).catch((error) => {
    showStatus(error.message, true);
    loadXFirstReply().catch(() => {});
  });
});
$("#save").addEventListener("click", () => {
  save().catch((error) => showStatus(error.message, true));
});
$("#saveCatalogueBridge").addEventListener("click", () => {
  saveCatalogueBridge().catch((error) =>
    showCatalogueStatus(error.message, true),
  );
});
$("#saveSyncScript").addEventListener("click", () => {
  saveSyncScript().catch((error) => showSyncScriptStatus(error.message, true));
});
$("#reset").addEventListener("click", () => {
  resetMappings().catch((error) => showStatus(error.message, true));
});
$("#importImages").addEventListener("click", () => {
  importImages().catch((error) => showStatus(error.message, true));
});
$("#clearImages").addEventListener("click", () => {
  clearImages().catch((error) => showStatus(error.message, true));
});
$("#testGelbooru").addEventListener("click", () => {
  testGelbooru().catch((error) => showStatus(error.message, true));
});
$("#testRealbooru").addEventListener("click", () => {
  testRealbooru().catch((error) => showStatus(error.message, true));
});

load().catch((error) => showStatus(error.message, true));
