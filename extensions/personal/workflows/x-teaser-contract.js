(() => {
  "use strict";

  if (globalThis.CreatorXTeaserContract) return;

  const catalogue = globalThis.CreatorCatalogueContract;
  if (!catalogue) throw new Error("CreatorCatalogueContract is unavailable.");

  function clean(value, maximum = 5000) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maximum);
  }

  function canonicalStatusUrl(value) {
    return catalogue.canonicalXStatusUrl(clean(value, 500));
  }

  function finiteNumber(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum
      ? number
      : null;
  }

  function sanitizeFileProof(value) {
    const basename = clean(value?.basename, 255);
    const size = finiteNumber(value?.size, 1, Number.MAX_SAFE_INTEGER);
    const lastModified = finiteNumber(
      value?.lastModified,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const duration = finiteNumber(value?.duration, 0.001, 8 * 60 * 60);
    const sha256 = clean(value?.sha256, 64).toLowerCase();
    if (
      !basename ||
      /[\\/]/.test(basename) ||
      basename === "." ||
      basename === ".." ||
      size === null ||
      lastModified === null ||
      duration === null ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error("Invalid X teaser file proof.");
    }
    return { basename, size, lastModified, duration, sha256 };
  }

  function catalogueRow(value) {
    const row = Number(value?.row);
    const id = clean(value?.id, 500);
    const title = clean(value?.title, 500);
    const fingerprint = clean(value?.fingerprint, 64).toLowerCase();
    if (
      !Number.isInteger(row) ||
      row < 2 ||
      row > 5002 ||
      !id ||
      !title ||
      !/^[a-f0-9]{8,64}$/.test(fingerprint)
    ) {
      throw new Error("Choose one explicit catalogue row.");
    }
    return { row, id, title, fingerprint };
  }

  function rankCatalogueRows(fileProof, rows) {
    if (Array.isArray(rows) && rows.length > 5000)
      throw new Error("The catalogue exceeds 5000 items.");
    const file = sanitizeFileProof(fileProof);
    const ranked = (Array.isArray(rows) ? rows : [])
      .map((item) => {
        const safe = catalogueRow(item);
        return {
          ...safe,
          score: Math.round(
            Math.max(
              catalogue.similarity(file.basename, safe.id),
              catalogue.similarity(file.basename, safe.title),
            ) * 100,
          ),
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score || Number(right.row) - Number(left.row),
      );
    return { selectedRow: null, rows: ranked };
  }

  function freezePairing(fileProof, row) {
    return {
      file: sanitizeFileProof(fileProof),
      catalogue: catalogueRow(row),
    };
  }

  function posterUrl(value) {
    try {
      const url = new URL(clean(value, 1000));
      return url.protocol === "https:" &&
        (url.hostname === "pbs.twimg.com" ||
          url.hostname.endsWith(".twimg.com"))
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function validateCapture(value) {
    const statusUrl = canonicalStatusUrl(value?.url);
    const timestamp = clean(value?.timestamp, 40);
    const parsedTimestamp = new Date(timestamp);
    const duration = finiteNumber(value?.duration, 0.001, 8 * 60 * 60);
    const poster = posterUrl(value?.poster);
    if (
      !statusUrl ||
      Number(value?.articleCount) !== 1 ||
      value?.warningGate === true ||
      value?.video !== true ||
      !timestamp ||
      Number.isNaN(parsedTimestamp.getTime()) ||
      parsedTimestamp.toISOString() !== timestamp ||
      duration === null ||
      !poster
    ) {
      throw new Error("X status capture is incomplete or ambiguous.");
    }
    return {
      statusId: statusUrl.split("/").at(-1),
      statusUrl,
      caption: clean(value?.caption, 5000),
      timestamp,
      duration,
      poster,
    };
  }

  globalThis.CreatorXTeaserContract = Object.freeze({
    canonicalStatusUrl,
    freezePairing,
    rankCatalogueRows,
    sanitizeFileProof,
    validateCapture,
  });
})();
