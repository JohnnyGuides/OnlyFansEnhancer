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

function modeForPercentage(percentage) {
  if (percentage <= 0) return "gelbooru";
  if (percentage >= 100) return "realbooru";
  return "mixed";
}

function percentageForSettings(settings) {
  if (settings.avatarMode === "gelbooru") return 0;
  if (settings.avatarMode === "realbooru") return 100;
  return Number.isFinite(Number(settings.realbooruPercentage))
    ? Number(settings.realbooruPercentage)
    : 50;
}

function renderMix(percentage) {
  const realbooru = Math.min(100, Math.max(0, Number(percentage)));
  const gelbooru = 100 - realbooru;
  $("#mixValue").textContent = `${gelbooru} / ${realbooru}`;
  $("#gelbooruChance").textContent = `${gelbooru}% anime`;
  $("#realbooruChance").textContent = `${realbooru}% real`;
  $("#mixSummary").textContent =
    `Each new picture has a ${realbooru}% Realbooru and ` +
    `${gelbooru}% Gelbooru chance.`;
}

async function requestSourcePermissions(percentage) {
  const origins = [];
  if (percentage < 100) {
    origins.push("https://gelbooru.com/*", "https://*.gelbooru.com/*");
  }
  if (percentage > 0) {
    origins.push("https://realbooru.com/*", "http://127.0.0.1/*");
  }
  return chrome.permissions.request({ origins });
}

async function load() {
  const [{ settings }, { stats }] = await Promise.all([
    sendMessage({ type: "GET_SETTINGS" }),
    sendMessage({ type: "GET_STATS" })
  ]);

  $("#enabled").checked = settings.enabled;
  $("#count").textContent =
    `${stats.mappedAccounts} persistent ${stats.mappedAccounts === 1 ? "identity" : "identities"}`;
  const percentage = percentageForSettings(settings);
  $("#sourceMix").value = percentage;
  renderMix(percentage);
}

$("#enabled").addEventListener("change", async (event) => {
  await sendMessage({
    type: "SET_SETTINGS",
    patch: { enabled: event.target.checked }
  });
  $("#note").textContent = "Enabled setting saved—reload OnlyFans.";
});

$("#sourceMix").addEventListener("input", (event) => {
  renderMix(event.target.value);
});

$("#sourceMix").addEventListener("change", async (event) => {
  const percentage = Number(event.target.value);
  $("#note").textContent = "Requesting source permissions…";
  try {
    const granted = await requestSourcePermissions(percentage);
    if (!granted) throw new Error("Required source permission was not granted.");
    await sendMessage({
      type: "SET_SETTINGS",
      patch: {
        avatarMode: modeForPercentage(percentage),
        realbooruPercentage: percentage
      }
    });
    $("#note").textContent =
      "Source mix saved. Existing pictures stay; new requests use this mix.";
  } catch (error) {
    $("#note").textContent = error.message;
    await load();
  }
});

async function resetDimension(type) {
  const isNames = type === "names";
  const confirmed = confirm(
    isNames
      ? "Replace every masked name while keeping all current pictures?"
      : "Replace every masked picture while keeping names and permanently retiring the old pictures?"
  );
  if (!confirmed) return;

  const button = isNames ? $("#resetNames") : $("#resetPictures");
  button.disabled = true;
  try {
    const response = await sendMessage({
      type: isNames ? "RESET_NAMES" : "RESET_PICTURES"
    });
    $("#note").textContent = isNames
      ? `${response.resetAccounts} names reset; pictures and account mappings preserved.`
      : `${response.resetAccounts} pictures queued for replacement; names and history preserved.`;
  } finally {
    button.disabled = false;
  }
}

$("#resetNames").addEventListener("click", () => {
  resetDimension("names").catch((error) => {
    $("#note").textContent = error.message;
  });
});

$("#resetPictures").addEventListener("click", () => {
  resetDimension("pictures").catch((error) => {
    $("#note").textContent = error.message;
  });
});

$("#options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

load().catch((error) => {
  $("#count").textContent = error.message;
});
