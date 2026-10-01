(() => {
  "use strict";

  // Isolated-world half of the passive X collector. Relays batches from the
  // main-world observer's private port to the extension worker, and reads
  // rendered owner posts as a fallback when no network data arrived.
  const contract = globalThis.CreatorXCollectorContract;
  if (!contract || globalThis.CreatorXCollectorRelay) return;

  const DOM_FALLBACK_DELAY_MS = 10_000;
  const DOM_SCAN_DEBOUNCE_MS = 2_000;
  const SCAN_COMMAND_TIMEOUT_MS = 45_000;
  const SCAN_COMMAND_TYPE = "CREATOR_X_SCAN_COMMAND";
  let port = null;
  let networkSeen = false;
  let scanTimer = null;
  let fallbackReady = false;
  const domSent = new Map();
  const pendingCommands = new Map();
  let commandCounter = 0;

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

  function onPortMessage(event) {
    const detail = event.data;
    if (!detail || typeof detail !== "object") return;
    if (detail.kind === "batch") {
      networkSeen = true;
      send({ batch: detail.batch });
    } else if (detail.kind === "scheduled") {
      send({ scheduled: detail.batch });
    } else if (detail.kind === "scan-reply") {
      const resolve = pendingCommands.get(detail.id);
      pendingCommands.delete(detail.id);
      resolve?.(detail.reply);
    } else if (detail.kind === "diagnostic") {
      send({
        diagnostic: {
          operation: String(detail.operation || ""),
          reason: String(detail.reason || ""),
        },
      });
    }
  }

  // Accept exactly one port, offered before X's scripts run.
  function onPageEvent(event) {
    if (port !== null || event.data !== JSON.stringify({ kind: "hello" }))
      return;
    const offered = event.ports?.[0];
    if (!offered || typeof offered.postMessage !== "function") return;
    port = offered;
    port.onmessage = onPortMessage;
    document.dispatchEvent(
      new CustomEvent(contract.PAGE_EVENT, {
        detail: JSON.stringify({ kind: "locked" }),
      }),
    );
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

  // A background scan's worker asks the page, through this relay and the
  // private port, for its status or one older page.
  function relayScanCommand(command) {
    if (!port) return Promise.resolve({ ok: false, reason: "not-ready" });
    const id = `scan-${++commandCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(id);
        resolve({ ok: false, reason: "page-timeout" });
      }, SCAN_COMMAND_TIMEOUT_MS);
      pendingCommands.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      port.postMessage({ kind: "scan-command", id, command });
    });
  }

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== SCAN_COMMAND_TYPE) return false;
      // Only the extension's own worker (never a tab) may command a scan.
      if (sender?.id !== chrome.runtime.id || sender.tab) return false;
      if (!new Set(["status", "page"]).has(message.command)) return false;
      void relayScanCommand(message.command).then(sendResponse);
      return true;
    });
  } catch {
    // Without the runtime the relay only reports.
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
