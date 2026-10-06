"use strict";

const { cropImportedImage } = globalThis.FanAvatarCrop;
const $ = (selector) => document.querySelector(selector);

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
    globalThis.FanIdentityMaskSendMessage({ type: "GET_SETTINGS" }),
    globalThis.FanIdentityMaskSendMessage({ type: "GET_STATS" }),
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
    "the rest used local smart crop.";
  await load();
  $("#avatarMode").value = "custom";
  syncAvatarFields();
}

async function clearImages() {
  if (!confirm("Delete every imported avatar from this extension?")) return;
  await globalThis.FanIdentityMaskSendMessage({ type: "CLEAR_CUSTOM_AVATARS" });
  await load();
  showStatus("Imported image pack cleared.");
}

async function save() {
  showStatus("");
  const consentAccepted = $("#consentAccepted").checked;
  const enabled = consentAccepted && $("#enabled").checked;
  const avatarMode = $("#avatarMode").value;
  if (avatarMode === "custom") {
    const { stats } = await globalThis.FanIdentityMaskSendMessage({
      type: "GET_STATS",
    });
    if (!stats.importedAvatars) {
      throw new Error(
        "Import at least one image before selecting the custom pack.",
      );
    }
  }

  await globalThis.FanIdentityMaskSendMessage({
    type: "SET_SETTINGS",
    patch: {
      consentAccepted,
      enabled,
      ownHandles: $("#ownHandles")
        .value.split(",")
        .map((value) => value.trim().replace(/^@/, ""))
        .filter(Boolean),
      avatarMode,
    },
  });
  showStatus(
    consentAccepted
      ? "Saved. Reload open OnlyFans tabs to apply the setting."
      : "Saved. Masking remains off because consent was not granted.",
  );
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
