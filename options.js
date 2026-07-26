"use strict";

const AVATAR_CACHE_SIZE = 96;
const $ = (selector) => document.querySelector(selector);

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

function showStatus(message, isError = false) {
  const status = $("#status");
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
      "Gelbooru user ID must contain digits only—not your username. Check your profile URL for ?id=…"
    );
  }
  return credentials;
}

async function load() {
  const [{ settings }, { stats }, { history }] = await Promise.all([
    sendMessage({ type: "GET_SETTINGS" }),
    sendMessage({ type: "GET_STATS" }),
    sendMessage({ type: "GET_GELBOORU_HISTORY" })
  ]);

  $("#enabled").checked = settings.enabled;
  $("#ownHandles").value = settings.ownHandles.join(", ");
  $("#avatarMode").value = settings.avatarMode;
  $("#gelbooruRatingMode").value = settings.gelbooruRatingMode || "any";
  $("#gelbooruUserId").value = settings.gelbooruUserId;
  $("#gelbooruApiKey").value = settings.gelbooruApiKey;
  $("#realbooruEndpoint").value =
    settings.realbooruEndpoint || "http://127.0.0.1:47831";
  $("#mappedAccounts").textContent = stats.mappedAccounts;
  $("#usedAnimeSelfies").textContent =
    stats.usedRemoteSelfies ?? stats.usedAnimeSelfies;
  $("#importedAvatars").textContent = stats.importedAvatars;

  const historyList = $("#gelbooruHistory");
  historyList.replaceChildren();
  for (const item of history.slice(0, 100)) {
    const row = document.createElement("li");
    const source = item.source || "gelbooru";
    const label = item.usedAt
      ? `${source} #${item.id} · ${item.action} · ${new Date(item.usedAt).toLocaleString()}`
      : `${source} #${item.id} · previously used`;
    if (item.postUrl) {
      const link = document.createElement("a");
      link.href = item.postUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = label;
      row.appendChild(link);
    } else {
      row.textContent = label;
    }
    historyList.appendChild(row);
  }
  if (!history.length) {
    const row = document.createElement("li");
    row.textContent = "No remote pictures have been assigned yet.";
    historyList.appendChild(row);
  }

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

  toggleGelbooruFields();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cropAroundFace(bitmap, face) {
  const box = face.boundingBox;
  const maximumSide = Math.min(bitmap.width, bitmap.height);
  const side = clamp(Math.max(box.width, box.height) * 2.35, 48, maximumSide);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2 + box.height * 0.12;

  return {
    x: clamp(centerX - side / 2, 0, bitmap.width - side),
    y: clamp(centerY - side / 2, 0, bitmap.height - side),
    side,
    detection: "face"
  };
}

async function nativeFaceCrop(bitmap) {
  if (!("FaceDetector" in globalThis)) return null;
  try {
    const detector = new FaceDetector({
      fastMode: true,
      maxDetectedFaces: 5
    });
    const faces = await detector.detect(bitmap);
    if (!faces.length) return null;
    const largest = faces.reduce((best, face) => {
      const area = face.boundingBox.width * face.boundingBox.height;
      const bestArea = best.boundingBox.width * best.boundingBox.height;
      return area > bestArea ? face : best;
    });
    return cropAroundFace(bitmap, largest);
  } catch {
    return null;
  }
}

function smartCrop(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 128 / longest);
  const width = Math.max(8, Math.round(bitmap.width * scale));
  const height = Math.max(8, Math.round(bitmap.height * scale));
  const analysis = document.createElement("canvas");
  analysis.width = width;
  analysis.height = height;
  const context = analysis.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);

  const luminance = (x, y) => {
    const index = (y * width + x) * 4;
    return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
  };

  let total = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const gradient =
        Math.abs(luminance(x + 1, y) - luminance(x - 1, y)) +
        Math.abs(luminance(x, y + 1) - luminance(x, y - 1));
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height * 0.4) / (height / 2);
      const centerPrior = 0.35 + 0.65 * Math.exp(-(dx * dx + dy * dy) * 1.8);
      const upperPrior = y < height * 0.72 ? 1.15 : 0.65;
      const weight = (gradient + 2) * centerPrior * upperPrior;
      total += weight;
      weightedX += x * weight;
      weightedY += y * weight;
    }
  }

  const salientX = total ? weightedX / total / scale : bitmap.width / 2;
  const salientY = total ? weightedY / total / scale : bitmap.height * 0.4;
  const centerX = salientX * 0.65 + bitmap.width * 0.5 * 0.35;
  const centerY = salientY * 0.65 + bitmap.height * 0.38 * 0.35;
  const side = Math.min(bitmap.width, bitmap.height);

  return {
    x: clamp(centerX - side / 2, 0, bitmap.width - side),
    y: clamp(centerY - side / 2, 0, bitmap.height - side),
    side,
    detection: "smart"
  };
}

async function hashFile(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function cropImportedImage(file) {
  const [bitmap, id] = await Promise.all([createImageBitmap(file), hashFile(file)]);
  try {
    const crop = (await nativeFaceCrop(bitmap)) || smartCrop(bitmap);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_CACHE_SIZE;
    canvas.height = AVATAR_CACHE_SIZE;
    const context = canvas.getContext("2d");
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.side,
      crop.side,
      0,
      0,
      canvas.width,
      canvas.height
    );
    return {
      id,
      detection: crop.detection,
      url: canvas.toDataURL("image/webp", 0.8)
    };
  } finally {
    bitmap.close();
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
      const response = await sendMessage({
        type: "ADD_CUSTOM_AVATARS",
        avatars: batch
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
  await sendMessage({ type: "CLEAR_CUSTOM_AVATARS" });
  await load();
  showStatus("Imported image pack cleared.");
}

async function requestGelbooruPermission() {
  return chrome.permissions.request({
    origins: ["https://gelbooru.com/*", "https://*.gelbooru.com/*"]
  });
}

async function requestRealbooruPermission() {
  return chrome.permissions.request({
    origins: ["https://realbooru.com/*", "http://127.0.0.1/*"]
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
    const { test } = await sendMessage({
      type: "TEST_GELBOORU",
      gelbooruUserId: credentials.userId,
      gelbooruApiKey: credentials.apiKey,
      gelbooruRatingMode: $("#gelbooruRatingMode").value
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
    throw new Error("Realbooru and local-scraper permissions were not granted.");
  }

  button.disabled = true;
  button.textContent = "Testing…";
  debug.textContent = "Contacting the loopback scraper without OnlyFans data…";

  try {
    const { test } = await sendMessage({
      type: "TEST_REALBOORU",
      realbooruEndpoint: $("#realbooruEndpoint").value.trim()
    });
    debug.textContent =
      `${test.message} Returned: ${test.returnedPosts}; ` +
      `usable after local filters: ${test.usablePosts}.`;
    showStatus("Realbooru scraper test completed.");
  } catch (error) {
    debug.textContent = `Test failed: ${error.message}`;
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "Test Realbooru scraper";
  }
}

async function save() {
  showStatus("");
  const avatarMode = $("#avatarMode").value;
  const credentials =
    ["gelbooru", "mixed"].includes(avatarMode)
      ? validateGelbooruCredentials()
      : gelbooruCredentials();

  if (["gelbooru", "mixed"].includes(avatarMode)) {
    const granted = await requestGelbooruPermission();
    if (!granted) throw new Error("Gelbooru permission was not granted.");
  }
  if (["realbooru", "mixed"].includes(avatarMode)) {
    const granted = await requestRealbooruPermission();
    if (!granted) {
      throw new Error("Realbooru and local-scraper permissions were not granted.");
    }
  }
  if (avatarMode === "custom") {
    const { stats } = await sendMessage({ type: "GET_STATS" });
    if (!stats.importedAvatars) {
      throw new Error("Import at least one selfie before selecting the custom pack.");
    }
  }

  const patch = {
    enabled: $("#enabled").checked,
    ownHandles: $("#ownHandles").value
      .split(",")
      .map((value) => value.trim().replace(/^@/, ""))
      .filter(Boolean),
    avatarMode,
    gelbooruRatingMode: $("#gelbooruRatingMode").value,
    gelbooruUserId: credentials.userId,
    gelbooruApiKey: credentials.apiKey,
    realbooruEndpoint: $("#realbooruEndpoint").value.trim()
  };

  await sendMessage({ type: "SET_SETTINGS", patch });
  $("#gelbooruUserId").value = credentials.userId;
  $("#gelbooruApiKey").value = credentials.apiKey;
  showStatus("Saved. Reload any open OnlyFans tabs to apply immediately.");
}

async function resetMappings() {
  const confirmed = confirm(
    "Reset every saved fan alias and avatar assignment? The next page load will create new identities."
  );
  if (!confirmed) return;

  await sendMessage({ type: "RESET_MAPPINGS" });
  await load();
  showStatus("All mappings were reset.");
}

$("#avatarMode").addEventListener("change", toggleGelbooruFields);
$("#save").addEventListener("click", () => {
  save().catch((error) => showStatus(error.message, true));
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
