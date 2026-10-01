(() => {
  "use strict";

  // Worker-side queue for passive X observations: validates relay messages
  // strictly, keeps a bounded queue, and forwards small batches to the
  // desktop catalogue. Undeliverable batches are dropped and counted; the
  // collector never retries in a loop.
  if (globalThis.CreatorXCollectorForwarder) return;

  const FORWARD_LIMIT = 25;
  const QUEUE_LIMIT = 500;
  const FLUSH_DELAY_MS = 3_000;
  const DIAGNOSTIC_REASONS = new Set([
    "schema-drift",
    "owner-unknown",
    "unreadable",
    "inspection-failed",
  ]);

  function create({
    contract,
    send,
    persist = async (_diagnostics) => {},
    setTimer = setTimeout,
    delayMs = FLUSH_DELAY_MS,
  }) {
    const queue = new Map();
    const diagnostics = {
      batchesReceived: 0,
      rowsQueued: 0,
      rowsForwarded: 0,
      rowsDroppedForeign: 0,
      rowsDroppedQueueFull: 0,
      batchesRejected: 0,
      desktopFailures: 0,
      lastDesktopError: "",
      lastForwardedUtc: "",
      pageReasons: {},
    };
    let timer = null;
    let flushing = Promise.resolve();

    const save = () => persist({ ...diagnostics }).catch(() => {});

    function accept(message) {
      if (message && Object.hasOwn(message, "diagnostic")) {
        const { operation, reason } = message.diagnostic || {};
        if (
          !contract.operationKind(String(operation || "")) ||
          !DIAGNOSTIC_REASONS.has(reason)
        )
          throw new Error("invalid-x-diagnostic");
        const key = `${operation}:${reason}`;
        diagnostics.pageReasons[key] = (diagnostics.pageReasons[key] || 0) + 1;
        void save();
        return { queued: 0 };
      }
      let valid;
      try {
        valid = contract.validateBatch(message?.batch);
      } catch (error) {
        diagnostics.batchesRejected += 1;
        void save();
        throw error;
      }
      diagnostics.batchesReceived += 1;
      diagnostics.rowsDroppedForeign += valid.dropped;
      const ownerKey = JSON.stringify(valid.owner);
      let queued = 0;
      for (const row of valid.observations) {
        const key = `${ownerKey}\n${row.source}\n${row.statusId}`;
        if (!queue.has(key) && queue.size >= QUEUE_LIMIT) {
          diagnostics.rowsDroppedQueueFull += 1;
          continue;
        }
        queue.delete(key);
        queue.set(key, { owner: valid.owner, ownerKey, row });
        queued += 1;
      }
      diagnostics.rowsQueued += queued;
      void save();
      schedule();
      return { queued };
    }

    function schedule() {
      if (timer !== null || queue.size === 0) return;
      timer = setTimer(() => {
        timer = null;
        void flush();
      }, delayMs);
    }

    function takeBatch() {
      const first = queue.values().next().value;
      if (!first) return null;
      const observations = [];
      for (const [key, entry] of queue) {
        if (entry.ownerKey !== first.ownerKey) continue;
        observations.push(entry.row);
        queue.delete(key);
        if (observations.length === FORWARD_LIMIT) break;
      }
      return { owner: first.owner, observations };
    }

    function flush() {
      flushing = flushing.then(async () => {
        for (let batch = takeBatch(); batch; batch = takeBatch()) {
          try {
            await send(batch);
            diagnostics.rowsForwarded += batch.observations.length;
            diagnostics.lastForwardedUtc = new Date().toISOString();
          } catch (error) {
            diagnostics.desktopFailures += 1;
            diagnostics.lastDesktopError = String(
              error?.message || "desktop-unavailable",
            ).slice(0, 200);
          }
        }
        await save();
      });
      return flushing;
    }

    return Object.freeze({
      accept,
      flush,
      diagnostics: () => JSON.parse(JSON.stringify(diagnostics)),
      size: () => queue.size,
    });
  }

  globalThis.CreatorXCollectorForwarder = Object.freeze({
    create,
    FORWARD_LIMIT,
    QUEUE_LIMIT,
  });
})();
