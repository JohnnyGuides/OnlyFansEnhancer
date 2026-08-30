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

function syncAvatarFields() {
  $("#customFields").hidden = $("#avatarMode").value !== "custom";
}

function syncConsentUi() {
  const accepted = $("#consentAccepted").checked;
  $("#enabled").disabled = !accepted;
  if (!accepted) $("#enabled").checked = false;
}

async function load() {
  const [{ settings }, { stats }] = await Promise.all([
    sendMessage({ type: "GET_SETTINGS" }),
    sendMessage({ type: "GET_STATS" })
  ]);
  $("#consentAccepted").checked = settings.consentAccepted;
  $("#enabled").checked = settings.enabled;
  $("#ownHandles").value = settings.ownHandles.join(", ");
  $("#avatarMode").value = settings.avatarMode;
  $("#mappedAccounts").textContent = stats.mappedAccounts;
  $("#importedAvatars").textContent = stats.importedAvatars;
  $("#usedImportedAvatars").textContent = stats.usedImportedAvatars;
  syncConsentUi();
  syncAvatarFields();
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
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
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
  syncAvatarFields();
  const progress = $("#importProgress");
  let imported = 0;
  let faceDetected = 0;
  let batch = [];

  for (let index = 0; index < files.length; index += 1) {
    progress.textContent = `Processing ${index + 1} of ${files.length}…`;
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
    "the rest used local smart crop.";
  await load();
  $("#avatarMode").value = "custom";
  syncAvatarFields();
}

async function clearImages() {
  if (!confirm("Delete every imported avatar from this extension?")) return;
  await sendMessage({ type: "CLEAR_CUSTOM_AVATARS" });
  await load();
  showStatus("Imported image pack cleared.");
}

async function save() {
  showStatus("");
  const consentAccepted = $("#consentAccepted").checked;
  const enabled = consentAccepted && $("#enabled").checked;
  const avatarMode = $("#avatarMode").value;
  if (avatarMode === "custom") {
    const { stats } = await sendMessage({ type: "GET_STATS" });
    if (!stats.importedAvatars) {
      throw new Error("Import at least one image before selecting the custom pack.");
    }
  }

  await sendMessage({
    type: "SET_SETTINGS",
    patch: {
      consentAccepted,
      enabled,
      ownHandles: $("#ownHandles").value
        .split(",")
        .map((value) => value.trim().replace(/^@/, ""))
        .filter(Boolean),
      avatarMode
    }
  });
  showStatus(
    consentAccepted
      ? "Saved. Reload open OnlyFans tabs to apply the setting."
      : "Saved. Masking remains off because consent was not granted."
  );
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

$("#consentAccepted").addEventListener("change", syncConsentUi);
$("#avatarMode").addEventListener("change", syncAvatarFields);
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

load().catch((error) => showStatus(error.message, true));
