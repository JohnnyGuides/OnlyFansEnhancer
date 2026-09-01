"use strict";
const fileInput = document.querySelector("#teaserFile"),
  rowSelect = document.querySelector("#catalogueRow"),
  confirmButton = document.querySelector("#confirm"),
  fileStatus = document.querySelector("#fileStatus"),
  summary = document.querySelector("#summary"),
  result = document.querySelector("#result");
let fileProof = null,
  rows = [],
  frames = [],
  resumeSession = null,
  rebindCandidate = null,
  suppressAutoReconcile = false;
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
async function framesOf(file, duration) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.muted = true;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () =>
        reject(new Error("Chrome could not decode the teaser."));
      video.src = url;
    });
    const output = [];
    for (const fraction of [0.2, 0.5, 0.8]) {
      await new Promise((resolve, reject) => {
        video.onseeked = resolve;
        video.onerror = () =>
          reject(new Error("Chrome could not decode an audit frame."));
        video.currentTime = Math.min(
          duration * fraction,
          Math.max(duration - 0.05, 0),
        );
      });
      const scale = Math.min(1, 960 / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas
        .getContext("2d")
        .drawImage(video, 0, 0, canvas.width, canvas.height);
      output.push(canvas.toDataURL("image/jpeg", 0.82));
    }
    return output;
  } finally {
    URL.revokeObjectURL(url);
  }
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

function sameFileProof(left, right) {
  return (
    left &&
    right &&
    ["basename", "size", "lastModified", "sha256"].every(
      (field) => left[field] === right[field],
    ) &&
    Math.abs(left.duration - right.duration) < 0.05
  );
}
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  confirmButton.disabled = true;
  fileStatus.textContent = "Reading file identity…";
  try {
    fileProof = await proofOf(file);
    frames = await framesOf(file, fileProof.duration);
    if (resumeSession) {
      if (!sameFileProof(fileProof, resumeSession.pairing.file))
        throw new Error(
          "This is not the exact teaser from the unfinished session.",
        );
      renderRows({
        rows: [{ ...resumeSession.pairing.catalogue, score: 100 }],
      });
      rowSelect.value = String(resumeSession.pairing.catalogue.row);
      rowSelect.disabled = true;
      confirmButton.textContent = "Resume Reconciliation";
      fileStatus.textContent = `${file.name} · exact unfinished-session identity confirmed`;
      updateConfirmation();
      return;
    }
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

chrome.runtime.onMessage.addListener((incoming) => {
  if (incoming?.type !== "X_TEASER_CAPTURED") return;
  if (suppressAutoReconcile || frames.length !== 3) {
    result.textContent =
      "X status captured. Reselect the exact teaser to resume reconciliation without reposting.";
    return;
  }
  result.textContent =
    "X status captured. Writing the audit, then the Sheet, then moving the source…";
  message({ type: "RECONCILE_X_TEASER", id: incoming.id, frames })
    .then(({ xTeaser }) => {
      result.textContent =
        xTeaser.stage === "moved"
          ? `Complete: ${xTeaser.capture.statusUrl} was audited, added to the catalogue, and moved to Done.`
          : `Stopped safely at ${xTeaser.stage}.`;
    })
    .catch((error) => {
      result.textContent = `${error.message} Nothing after the failed stage was attempted.`;
    });
});
rowSelect.addEventListener("change", updateConfirmation);
confirmButton.addEventListener("click", async () => {
  const row = rows.find((item) => String(item.row) === rowSelect.value);
  confirmButton.disabled = true;
  result.textContent = "Rechecking the catalogue and requesting X access…";
  try {
    if (rebindCandidate) {
      frames = [];
      const response = await message({
        type: "CONFIRM_X_TEASER_REBIND",
        ...rebindCandidate,
      });
      resumeSession = response.rebind.session;
      rebindCandidate = null;
      suppressAutoReconcile = false;
      fileInput.disabled = false;
      confirmButton.textContent = "Resume Reconciliation";
      result.textContent =
        "X status captured. Reselect the exact teaser to resume reconciliation without reposting.";
      fileStatus.textContent = `Unfinished ${resumeSession.stage} session found for ${resumeSession.pairing.file.basename}. Reselect that exact file.`;
      return;
    }
    if (resumeSession) {
      const response = await message({
        type: "RECONCILE_X_TEASER",
        id: resumeSession.id,
        frames,
      });
      result.textContent =
        response.xTeaser.stage === "moved"
          ? `Complete: ${response.xTeaser.capture.statusUrl} was audited, added to the catalogue, and moved to Done.`
          : `Stopped safely at ${response.xTeaser.stage}.`;
      return;
    }
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

message({ type: "GET_X_TEASER_SESSIONS" })
  .then(({ sessions, rebind }) => {
    const paired = [...sessions]
      .reverse()
      .find((session) => session.stage === "paired" && !session.capture);
    resumeSession =
      [...sessions]
        .reverse()
        .find((session) => session.capture && session.stage !== "moved") ||
      null;
    if (paired) {
      result.textContent = `Observation resumed for ${paired.pairing.file.basename}. Continue in the bound X tab; Chrome will not repost.`;
    }
    if (rebind?.action === "confirm-status") {
      frames = [];
      suppressAutoReconcile = true;
      fileInput.disabled = true;
      rebindCandidate = {
        id: rebind.id,
        tabId: rebind.tabId,
        statusUrl: rebind.statusUrl,
      };
      confirmButton.textContent = "Yes — Use This X Status";
      confirmButton.disabled = false;
      summary.textContent = `Use ${rebind.statusUrl} for the already-paired teaser?`;
      result.textContent =
        "Chrome found one restored X status tab but will not bind it without your Yes.";
    } else if (rebind?.action === "ambiguous") {
      result.textContent =
        "Several X tabs are open. Close unrelated X tabs, then reopen this recorder; nothing was captured.";
    }
    if (resumeSession) {
      fileStatus.textContent = `Unfinished ${resumeSession.stage} session found for ${resumeSession.pairing.file.basename}. Reselect that exact file to resume without reposting.`;
    }
  })
  .catch((error) => {
    result.textContent = error.message;
  });
