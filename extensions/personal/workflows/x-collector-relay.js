(() => {
  "use strict";

  // Isolated-world half of the passive X collector. Relays nonce-bound
  // batches from the main-world observer to the extension worker, and reads
  // rendered owner posts as a fallback when no network data arrived.
  const contract = globalThis.CreatorXCollectorContract;
  if (!contract || globalThis.CreatorXCollectorRelay) return;

  const DOM_FALLBACK_DELAY_MS = 10_000;
  const DOM_SCAN_DEBOUNCE_MS = 2_000;
  let nonce = null;
  let networkSeen = false;
  let scanTimer = null;
  let fallbackReady = false;
  const domSent = new Map();

  function send(message) {
    try {
      chrome.runtime.sendMessage(
        { type: contract.MESSAGE_TYPE, ...message },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // An invalidated extension context can no longer report.
    }
  }

  function onPageEvent(event) {
    let detail;
    try {
      detail = JSON.parse(String(event.detail || ""));
    } catch {
      return;
    }
    if (!detail || typeof detail !== "object") return;
    if (detail.kind === "hello") {
      if (nonce === null && /^[a-f0-9]{32}$/.test(String(detail.nonce || ""))) {
        nonce = detail.nonce;
        document.dispatchEvent(
          new CustomEvent(contract.PAGE_EVENT, {
            detail: JSON.stringify({ kind: "locked" }),
          }),
        );
      }
      return;
    }
    if (nonce === null || detail.nonce !== nonce) return;
    if (detail.kind === "batch") {
      networkSeen = true;
      send({ batch: detail.batch });
    } else if (detail.kind === "diagnostic") {
      send({
        diagnostic: {
          operation: String(detail.operation || ""),
          reason: String(detail.reason || ""),
        },
      });
    }
  }

  function scanDocument() {
    scanTimer = null;
    if (networkSeen || !fallbackReady) return;
    const handle = contract.ownerHandleFromDocument(document);
    if (!handle) return;
    const observations = [];
    for (const article of document.querySelectorAll("article")) {
      const row = contract.extractDomArticle(article, handle);
      if (!row) continue;
      const signature = JSON.stringify([row.text, row.metrics, row.media]);
      if (domSent.get(row.statusId) === signature) continue;
      domSent.set(row.statusId, signature);
      observations.push(row);
      if (observations.length === contract.MAX_BATCH) break;
    }
    if (observations.length)
      send({ batch: { owner: { accountId: null, handle }, observations } });
  }

  function scheduleScan() {
    if (networkSeen || !fallbackReady || scanTimer !== null) return;
    scanTimer = setTimeout(scanDocument, DOM_SCAN_DEBOUNCE_MS);
  }

  function startDomFallback() {
    if (typeof MutationObserver !== "function" || !document.documentElement)
      return;
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setTimeout(() => {
      fallbackReady = true;
      scheduleScan();
    }, DOM_FALLBACK_DELAY_MS);
  }

  document.addEventListener(contract.PAGE_EVENT, onPageEvent);
  document.dispatchEvent(
    new CustomEvent(contract.PAGE_EVENT, {
      detail: JSON.stringify({ kind: "ready" }),
    }),
  );
  startDomFallback();

  globalThis.CreatorXCollectorRelay = Object.freeze({ scanDocument });
})();
