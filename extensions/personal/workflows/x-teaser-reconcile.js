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
    if (session.stage === "moved") return session;
    const source = session.reconciliationSource;
    if (
      !source ||
      source.backend !== "apps-script" ||
      !source.workbookId ||
      !source.sheetName ||
      !source.endpoint
    )
      throw new Error(
        "This session has no verified remote Sheet source. Local recording cannot authorize a Done move; review the existing result.",
      );
    const proofMatches = (proof) =>
      proof?.backend === source.backend &&
      proof.workbookId === source.workbookId &&
      proof.sheetName === source.sheetName &&
      proof.itemId === session.pairing.catalogue.id &&
      proof.row === session.pairing.catalogue.row &&
      proof.statusUrl === session.capture.statusUrl;
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
      const snapshot = await catalogueClient.getReconciliationSnapshot(source);
      const row = snapshot.rows.find(
        (candidate) =>
          candidate.row === session.pairing.catalogue.row &&
          candidate.id === session.pairing.catalogue.id,
      );
      if (!row)
        throw new Error(
          "The catalogue row changed after pairing; the source file was not moved.",
        );
      let sheet;
      if (session.sheetAttempted) {
        if (
          !String(row.twitterTeasers || "")
            .split(/\s+/)
            .includes(session.capture.statusUrl)
        )
          throw new Error(
            "The previous Sheet append is uncertain. Reconcile it read-only before moving the source; it will not be submitted again.",
          );
        sheet = {
          status: "idempotent",
          remoteCommit: {
            backend: source.backend,
            workbookId: source.workbookId,
            sheetName: source.sheetName,
            row: row.row,
            itemId: row.id,
            statusUrl: session.capture.statusUrl,
          },
        };
      } else {
        session = await store.save({
          id: session.id,
          sheetAttempted: true,
          updatedAt: Date.now(),
        });
        session = await store.load(session.id);
        if (!session?.sheetAttempted)
          throw new Error(
            "The Sheet attempt checkpoint was not retained; no append was submitted.",
          );
        sheet = await catalogueClient.appendVerifiedTwitterTeaser(
          {
            row: row.row,
            id: row.id,
            fingerprint: session.pairing.catalogue.fingerprint,
            statusUrl: session.capture.statusUrl,
          },
          source,
        );
      }
      if (
        !new Set(["updated", "idempotent"]).has(sheet?.status) ||
        !proofMatches(sheet.remoteCommit)
      ) {
        throw new Error(
          `The Sheet did not durably append the X status (${sheet?.status || "unknown"}).`,
        );
      }
      session = await store.save({
        id: session.id,
        stage: "sheet-complete",
        sheetOutcome: sheet.status || sheet.outcome || "updated",
        remoteCommit: sheet.remoteCommit,
        updatedAt: Date.now(),
      });
    }
    if (session.stage === "sheet-complete") {
      if (!proofMatches(session.remoteCommit))
        throw new Error(
          "The saved Sheet checkpoint has no matching remote commitment; the source file was not moved.",
        );
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
