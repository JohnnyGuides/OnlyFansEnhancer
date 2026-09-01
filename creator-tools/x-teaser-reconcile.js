(() => {
  "use strict";
  if (globalThis.CreatorXTeaserReconcile) return;

  async function run({
    sessionId,
    frames,
    store,
    nativeSend,
    catalogueClient,
  }) {
    let session = await store.load(sessionId);
    if (!session?.capture)
      throw new Error("The X status has not been captured yet.");
    if (session.stage === "status-captured") {
      if (!Array.isArray(frames) || frames.length !== 3)
        throw new Error(
          "Reselect the exact teaser to recreate its audit frames.",
        );
      const audit = await nativeSend({
        operation: "audit",
        basename: session.pairing.file.basename,
        fileProof: session.pairing.file,
        status: session.capture,
        catalogue: {
          row: session.pairing.catalogue.row,
          id: session.pairing.catalogue.id,
          title: session.pairing.catalogue.title,
        },
        frames,
      });
      session = await store.save({
        id: session.id,
        stage: "audit-complete",
        auditOutcome: audit.auditOutcome,
        auditReceipt: audit.receipt,
        updatedAt: Date.now(),
      });
    }
    if (session.stage === "audit-complete") {
      const snapshot = await catalogueClient.getCatalogueSnapshot();
      const row = snapshot.rows.find(
        (candidate) =>
          candidate.row === session.pairing.catalogue.row &&
          candidate.id === session.pairing.catalogue.id &&
          candidate.fingerprint === session.pairing.catalogue.fingerprint,
      );
      if (!row)
        throw new Error(
          "The catalogue row changed after pairing; the source file was not moved.",
        );
      const sheet = await catalogueClient.appendTwitterTeaser({
        row: row.row,
        id: row.id,
        fingerprint: row.fingerprint,
        statusUrl: session.capture.statusUrl,
      });
      if (!new Set(["updated", "idempotent"]).has(sheet?.status)) {
        throw new Error(
          `The Sheet did not durably append the X status (${sheet?.status || "unknown"}).`,
        );
      }
      session = await store.save({
        id: session.id,
        stage: "sheet-complete",
        sheetOutcome: sheet.status || sheet.outcome || "updated",
        updatedAt: Date.now(),
      });
    }
    if (session.stage === "sheet-complete") {
      const moved = await nativeSend({
        operation: "move",
        basename: session.pairing.file.basename,
        fileProof: session.pairing.file,
        statusId: session.capture.statusId,
        receipt: session.auditReceipt,
      });
      session = await store.save({
        id: session.id,
        stage: "moved",
        moveOutcome: moved.moveOutcome,
        updatedAt: Date.now(),
      });
    }
    return session;
  }
  globalThis.CreatorXTeaserReconcile = Object.freeze({ run });
})();
