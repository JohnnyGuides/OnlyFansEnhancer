(function (global) {
  "use strict";
  const NAME = "OFEnhancerTeaserDraftsV1";
  const MAX_FILE = 512 * 1024 * 1024;
  const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  function validDay(value) {
    if (!DATE.test(value || "")) return false;
    const date = new Date(value + "T12:00:00Z");
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }
  function open() {
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts", { keyPath: "date" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "Teaser drafts could not open. Your existing drafts are unchanged.",
          ),
        );
    });
  }
  async function transact(mode, run) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("drafts", mode);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () =>
          reject(
            new Error(
              "Teaser draft could not be saved. Keep this window open and try again.",
            ),
          );
        run(
          transaction.objectStore("drafts"),
          (value) => {
            result = value;
          },
          transaction,
        );
      });
    } finally {
      db.close();
    }
  }
  function summaries(records) {
    return records.map(({ file, thumbnail, ...record }) => ({
      ...record,
      name: file?.name || "",
      size: file?.size || 0,
      hasThumbnail: Boolean(thumbnail),
    }));
  }
  async function list() {
    return transact("readonly", (store, done) => {
      const read = store.getAll();
      read.onsuccess = () => done(summaries(read.result));
    });
  }
  async function get(date) {
    if (!validDay(date)) throw new Error("Choose a calendar day.");
    return transact("readonly", (store, done) => {
      const read = store.get(date);
      read.onsuccess = () => done(read.result || null);
    });
  }
  async function save(draft) {
    if (
      !validDay(draft?.date) ||
      !(draft.file instanceof File) ||
      !draft.file.size ||
      draft.file.size >= MAX_FILE ||
      !/\.(mp4|mov|m4v|webm)$/i.test(draft.file.name) ||
      typeof draft.caption !== "string" ||
      draft.caption.length > 280 ||
      (draft.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) ||
      (draft.thumbnail &&
        (!(draft.thumbnail instanceof Blob) ||
          draft.thumbnail.size > 2_000_000))
    )
      throw new Error(
        "Choose a video under 512 MB and a caption of at most 280 characters.",
      );
    const record = {
      date: draft.date,
      file: draft.file,
      thumbnail: draft.thumbnail || null,
      caption: draft.caption,
      episodeKey: String(draft.episodeKey || ""),
      clipId: draft.clipId || null,
      time: /^\d{2}:\d{2}$/.test(draft.time || "") ? draft.time : "18:00",
      replyDelayMinutes:
        Number.isInteger(draft.replyDelayMinutes) &&
        draft.replyDelayMinutes >= 1 &&
        draft.replyDelayMinutes <= 1440
          ? draft.replyDelayMinutes
          : 15,
      paidUrl: String(draft.paidUrl || ""),
      status: "draft",
      updatedAt: Date.now(),
    };
    return transact("readwrite", (store, done, transaction) => {
      const read = store.getAll();
      read.onsuccess = () => {
        const existing = read.result.find((item) => item.date === record.date);
        if (existing?.status && existing.status !== "draft") {
          transaction.abort();
          return;
        }
        const others = read.result.filter((item) => item.date !== record.date);
        if (
          others.length >= 61 ||
          others.reduce(
            (size, item) => size + (item.file?.size || 0),
            record.file.size,
          ) > MAX_TOTAL
        ) {
          transaction.abort();
          return;
        }
        store.put(record);
        done(record);
      };
    });
  }
  async function checkpoint(date, status, sessionId) {
    if (
      !validDay(date) ||
      !new Set([
        "preparing",
        "prepared",
        "scheduled",
        "posted",
        "unresolved",
      ]).has(status) ||
      !/^[a-f0-9]{48}$/.test(sessionId || "")
    )
      throw new Error("Teaser execution identity is missing.");
    return transact("readwrite", (store, done, transaction) => {
      const read = store.get(date);
      read.onsuccess = () => {
        const record = read.result;
        if (!record || (record.sessionId && record.sessionId !== sessionId)) {
          transaction.abort();
          return;
        }
        const transitions = {
          draft: ["preparing"],
          preparing: ["prepared", "unresolved"],
          prepared: ["scheduled", "posted", "unresolved"],
          scheduled: ["posted", "unresolved"],
          posted: [],
          unresolved: ["prepared", "scheduled", "posted"],
        };
        if (
          record.status !== status &&
          !transitions[record.status]?.includes(status)
        ) {
          transaction.abort();
          return;
        }
        record.status = status;
        record.sessionId = sessionId;
        record.updatedAt = Date.now();
        store.put(record);
        done(record);
      };
    });
  }
  global.OFEnhancerTeaserDrafts = Object.freeze({
    list,
    get,
    save,
    checkpoint,
    validDay,
  });
})(globalThis);
