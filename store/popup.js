"use strict";

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

async function load() {
  const [{ settings }, { stats }] = await Promise.all([
    sendMessage({ type: "GET_SETTINGS" }),
    sendMessage({ type: "GET_STATS" })
  ]);
  $("#enabled").checked = settings.enabled;
  $("#enabled").disabled = !settings.consentAccepted;
  $("#count").textContent = `${stats.mappedAccounts} persistent aliases`;
  $("#mode").textContent =
    settings.avatarMode === "custom"
      ? "Local imported avatar pack"
      : "Local generated avatars";
  $("#setupMessage").textContent = settings.consentAccepted
    ? "Identity mappings stay in Chrome local storage."
    : "Open settings to review the privacy disclosure and choose whether to enable masking.";
  $("#note").textContent = settings.consentAccepted
    ? "Changes apply to open OnlyFans tabs."
    : "Setup is required before any identity is processed.";
}

$("#enabled").addEventListener("change", async () => {
  try {
    await sendMessage({
      type: "SET_SETTINGS",
      patch: { enabled: $("#enabled").checked }
    });
    $("#note").textContent = "Reload open OnlyFans tabs to apply the change.";
  } catch (error) {
    $("#note").textContent = error.message;
  }
});

async function resetDimension(type) {
  const isNames = type === "names";
  const button = isNames ? $("#resetNames") : $("#resetPictures");
  button.disabled = true;
  try {
    const response = await sendMessage({
      type: isNames ? "RESET_NAMES" : "RESET_PICTURES"
    });
    $("#count").textContent = `${response.stats.mappedAccounts} persistent aliases`;
    $("#note").textContent = isNames
      ? `Reset names for ${response.resetAccounts} mapped accounts.`
      : `Reset pictures for ${response.resetAccounts} mapped accounts.`;
  } catch (error) {
    $("#note").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$("#resetNames").addEventListener("click", () => resetDimension("names"));
$("#resetPictures").addEventListener("click", () => resetDimension("pictures"));
$("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());

load().catch((error) => {
  $("#note").textContent = error.message;
});
