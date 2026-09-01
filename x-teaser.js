"use strict";
const fileInput = document.querySelector("#teaserFile"),
  rowSelect = document.querySelector("#catalogueRow"),
  confirmButton = document.querySelector("#confirm"),
  fileStatus = document.querySelector("#fileStatus"),
  summary = document.querySelector("#summary"),
  result = document.querySelector("#result");
let fileProof = null,
  rows = [];
function message(payload) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError)
        return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok)
        return reject(
          new Error(response?.error || "Extension request failed."),
        );
      resolve(response);
    }),
  );
}
async function durationOf(file) {
  const video = document.createElement("video"),
    url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve(video.duration);
      video.onerror = () =>
        reject(new Error("Chrome could not read the teaser duration."));
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function proofOf(file) {
  const [digest, duration] = await Promise.all([
    crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
    durationOf(file),
  ]);
  return {
    basename: file.name,
    size: file.size,
    lastModified: file.lastModified,
    duration,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}
function renderRows(ranked) {
  rows = ranked.rows;
  rowSelect.replaceChildren(new Option("Choose the exact catalogue entry", ""));
  for (const row of rows)
    rowSelect.add(
      new Option(`${row.score}% · ${row.title} — ${row.id}`, String(row.row)),
    );
  rowSelect.disabled = false;
}
function updateConfirmation() {
  const row = rows.find((item) => String(item.row) === rowSelect.value);
  confirmButton.disabled = !(fileProof && row);
  summary.textContent = row
    ? `Pair “${fileProof.basename}” with catalogue row ${row.row}: ${row.title}?`
    : "Choose a file and catalogue row to continue.";
}
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  confirmButton.disabled = true;
  fileStatus.textContent = "Reading file identity…";
  try {
    fileProof = await proofOf(file);
    const snapshot = await CreatorCatalogueClient.getCatalogueSnapshot();
    renderRows(
      CreatorXTeaserContract.rankCatalogueRows(fileProof, snapshot.rows),
    );
    fileStatus.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · identity ready`;
    updateConfirmation();
  } catch (error) {
    fileStatus.textContent = error.message;
  }
});
rowSelect.addEventListener("change", updateConfirmation);
confirmButton.addEventListener("click", async () => {
  const row = rows.find((item) => String(item.row) === rowSelect.value);
  confirmButton.disabled = true;
  result.textContent = "Rechecking the catalogue and requesting X access…";
  try {
    const granted = await chrome.permissions.request({
      origins: ["https://x.com/*"],
    });
    if (!granted) throw new Error("X permission was not granted.");
    const snapshot = await CreatorCatalogueClient.getCatalogueSnapshot();
    const fresh = snapshot.rows.find(
      (item) =>
        item.row === row.row &&
        item.id === row.id &&
        item.fingerprint === row.fingerprint,
    );
    if (!fresh) throw new Error("That catalogue row changed. Select it again.");
    await message({
      type: "PAIR_X_TEASER",
      pairing: CreatorXTeaserContract.freezePairing(fileProof, fresh),
    });
    result.textContent =
      "Paired. Chrome opened X and is waiting for the resulting status page.";
  } catch (error) {
    result.textContent = error.message;
    confirmButton.disabled = false;
  }
});
