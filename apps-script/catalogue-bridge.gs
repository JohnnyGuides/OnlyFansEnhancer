"use strict";

var CREATOR_UPLOAD_SPREADSHEET_ID_PROPERTY = "CREATOR_UPLOAD_SPREADSHEET_ID";
var CREATOR_UPLOAD_SHEET_NAME = "2026 Video Catalogue";
var CREATOR_UPLOAD_PRESET_SHEET_NAME = "2026 uploads";
var CREATOR_UPLOAD_LEDGER_SHEET_NAME = "Creator Distribution Ledger";
var CREATOR_UPLOAD_SECRET_PROPERTY = "CREATOR_UPLOAD_SECRET";
var CREATOR_UPLOAD_MATCH_THRESHOLD = 75;
var CREATOR_UPLOAD_LINK_FIELDS = {
  pornhub: "pornhubLink",
  onlyfans: "onlyfansLink",
  fansly: "fanslyLink",
  manyvids: "manyvidsLink",
};
var CREATOR_UPLOAD_LINK_COLUMNS = {
  pornhub: 8,
  onlyfans: 10,
  fansly: 11,
  manyvids: 12,
};

function creatorUploadClean(value) {
  return String(value == null ? "" : value).trim();
}

function creatorUploadSpreadsheetId() {
  var spreadsheetId = creatorUploadClean(
    PropertiesService.getScriptProperties().getProperty(
      CREATOR_UPLOAD_SPREADSHEET_ID_PROPERTY,
    ),
  );
  if (!spreadsheetId) {
    throw new Error(
      "CREATOR_UPLOAD_SPREADSHEET_ID Script Property is not configured.",
    );
  }
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId)) {
    throw new Error(
      "CREATOR_UPLOAD_SPREADSHEET_ID Script Property is invalid.",
    );
  }
  return spreadsheetId;
}

function creatorUploadNormalizedText(value) {
  return creatorUploadClean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.(?:mp4|m4v|mov|webm|avi|mkv)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:full|limited|final|vr)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function creatorUploadTokens(value) {
  var values = creatorUploadNormalizedText(value)
    .split(/\s+/)
    .filter(function (token) {
      return token.length > 1;
    });
  return values.filter(function (token, index) {
    return values.indexOf(token) === index;
  });
}

function creatorUploadSimilarity(left, right) {
  var a = creatorUploadTokens(left);
  var b = creatorUploadTokens(right);
  if (!a.length || !b.length) return 0;
  var overlap = a.filter(function (token) {
    return b.indexOf(token) !== -1;
  }).length;
  return (2 * overlap) / (a.length + b.length);
}

function creatorUploadParseDay(value) {
  var match = creatorUploadClean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : NaN;
}

function creatorUploadScoreRow(draft, row) {
  var titleScore = Math.max(
    creatorUploadSimilarity(draft.title, row.title),
    creatorUploadSimilarity(draft.filename, row.title),
  );
  var descriptionScore = creatorUploadSimilarity(
    draft.description,
    row.description,
  );
  var targetDay = creatorUploadParseDay(draft.releaseDate);
  var rowDay = creatorUploadParseDay(row.releaseDate);
  var distance =
    isNaN(targetDay) || isNaN(rowDay)
      ? 99
      : Math.abs(targetDay - rowDay) / 86400000;
  var dateScore = distance === 0 ? 45 : Math.max(0, 14 - distance * 2);
  var emptyBonus = (draft.targets || []).reduce(function (score, platform) {
    var field = CREATOR_UPLOAD_LINK_FIELDS[platform];
    return score + (creatorUploadClean(row[field]) ? 0 : 3);
  }, 0);
  return Math.round(
    titleScore * 40 + descriptionScore * 14 + dateScore + emptyBonus,
  );
}

function creatorUploadSlugify(value) {
  return (
    creatorUploadNormalizedText(value).replace(/\s+/g, "-") || "untitled-video"
  );
}

function creatorUploadFingerprint(row) {
  var serialized = [
    row.row,
    row.id,
    row.releaseDate,
    row.title,
    row.description,
    row.seasonArc,
    row.episode,
    row.pornhubLink,
    row.onlyfansLink,
    row.fanslyLink,
    row.manyvidsLink,
    row.twitterTeasers,
    row.redditPosts,
  ]
    .map(creatorUploadClean)
    .join("\u001f");
  var hash = 0x811c9dc5;
  for (var index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function creatorUploadCanonicalUrl(platform, value) {
  var raw = creatorUploadClean(value);
  var match;
  if (platform === "pornhub") {
    try {
      var url = new URL(raw);
      var viewkeys = url.searchParams.getAll("viewkey");
      var viewkey = viewkeys[0] || "";
      return url.origin === "https://www.pornhub.com" &&
        url.pathname === "/view_video.php" &&
        viewkeys.length === 1 &&
        /^[A-Za-z0-9_-]{1,100}$/.test(viewkey)
        ? "https://www.pornhub.com/view_video.php?viewkey=" + viewkey
        : null;
    } catch (error) {
      return null;
    }
  }
  if (platform === "fansly") {
    match = raw.match(/^(?:https:\/\/fansly\.com\/post\/)?(\d+)\/?$/);
    return match ? "https://fansly.com/post/" + match[1] : null;
  }
  if (platform === "onlyfans") {
    match = raw.match(
      /^(?:https:\/\/onlyfans\.com\/)?(\d+)(?:\/johnny_guides)?\/?$/,
    );
    return match ? "https://onlyfans.com/" + match[1] + "/johnny_guides" : null;
  }
  if (platform === "manyvids") {
    match = raw.match(/^(?:https:\/\/www\.manyvids\.com\/Video\/)?(\d+)\/?$/i);
    return match ? "https://www.manyvids.com/Video/" + match[1] : null;
  }
  return null;
}

function creatorUploadCanonicalTwitterStatus(value) {
  var raw = creatorUploadClean(value);
  var match = raw.match(
    /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})$/,
  );
  return match && match[1].toLowerCase() !== "i"
    ? "https://x.com/" + match[1] + "/status/" + match[2]
    : null;
}

function creatorUploadCanonicalRedditPost(value) {
  try {
    var url = new URL(creatorUploadClean(value));
    var match = url.pathname.match(
      /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})\/([A-Za-z0-9_-]+)\/?$/i,
    );
    return url.protocol === "https:" &&
      url.hostname === "www.reddit.com" &&
      match
      ? "https://www.reddit.com/r/" +
          match[1] +
          "/comments/" +
          match[2].toLowerCase() +
          "/" +
          match[3]
      : null;
  } catch (error) {
    return null;
  }
}

function creatorUploadCanonicalRedgifsWatch(value) {
  var match = creatorUploadClean(value).match(
    /^https:\/\/www\.redgifs\.com\/watch\/([A-Za-z0-9-]{2,100})$/,
  );
  return match ? "https://www.redgifs.com/watch/" + match[1] : null;
}

function creatorUploadEmptyRow(row) {
  if (typeof row.empty === "boolean") return row.empty;
  return ![
    row.id,
    row.releaseDate,
    row.title,
    row.description,
    row.seasonArc,
    row.episode,
    row.pornhubLink,
    row.onlyfansLink,
    row.fanslyLink,
    row.manyvidsLink,
  ].some(creatorUploadClean);
}

function creatorUploadMatchRows(draft, rows) {
  var populated = rows.filter(function (row) {
    return !creatorUploadEmptyRow(row);
  });
  var ranked = populated
    .map(function (row) {
      return {
        row: row,
        score: creatorUploadScoreRow(draft, row),
        titleSimilarity: Math.max(
          creatorUploadSimilarity(draft.title, row.title),
          creatorUploadSimilarity(draft.filename, row.title),
        ),
      };
    })
    .sort(function (left, right) {
      return right.score - left.score || right.row.row - left.row.row;
    });
  if (
    !draft.forceNew &&
    ranked.length &&
    ranked[0].score >= CREATOR_UPLOAD_MATCH_THRESHOLD &&
    ranked[0].titleSimilarity >= 0.55
  ) {
    return {
      status: "matched",
      candidate: Object.assign({}, ranked[0].row, {
        fingerprint: creatorUploadFingerprint(ranked[0].row),
        score: ranked[0].score,
      }),
    };
  }
  var empty = rows.find(creatorUploadEmptyRow);
  if (!empty) throw new Error("No empty catalogue row is available.");
  var ids = populated.map(function (row) {
    return creatorUploadClean(row.id);
  });
  var base = creatorUploadSlugify(draft.title);
  var id = base;
  var suffix = 2;
  while (ids.indexOf(id) !== -1) {
    id = base + "-" + suffix;
    suffix += 1;
  }
  return {
    status: "new",
    candidate: {
      row: empty.row,
      id: id,
      releaseDate: draft.releaseDate,
      title: creatorUploadClean(draft.title),
      description: creatorUploadClean(draft.description),
      onlyfansLink: "",
      fanslyLink: "",
      manyvidsLink: "",
      fingerprint: creatorUploadFingerprint(empty),
      score: 0,
    },
  };
}

function creatorUploadPlanCommit(row, request) {
  if (
    creatorUploadFingerprint(row) !== creatorUploadClean(request.fingerprint)
  ) {
    return {
      status: "stale",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  var platform = request.platform;
  var field = CREATOR_UPLOAD_LINK_FIELDS[platform] || "";
  var postUrl = creatorUploadCanonicalUrl(platform, request.postUrl);
  if (!field || !postUrl) throw new Error("Invalid platform post link.");
  var next = Object.assign({}, row);
  var metadata = request.metadata || {};
  if (creatorUploadEmptyRow(row)) {
    next.id = creatorUploadClean(metadata.id);
    next.releaseDate = creatorUploadClean(metadata.releaseDate);
    next.title = creatorUploadClean(metadata.title);
    next.description = creatorUploadClean(metadata.description);
    if (!next.id || !next.releaseDate || !next.title) {
      throw new Error("New catalogue rows require ID, date, and title.");
    }
  } else if (
    creatorUploadClean(metadata.id) &&
    (creatorUploadClean(row.id) !== creatorUploadClean(metadata.id) ||
      creatorUploadClean(row.releaseDate) !==
        creatorUploadClean(metadata.releaseDate) ||
      creatorUploadClean(row.title) !== creatorUploadClean(metadata.title) ||
      creatorUploadClean(row.description) !==
        creatorUploadClean(metadata.description))
  ) {
    return {
      status: "stale",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  var current = creatorUploadClean(row[field]);
  if (current && current !== postUrl) {
    return {
      status: "conflict",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  next[field] = postUrl;
  var status = current === postUrl ? "idempotent" : "updated";
  return {
    status: status,
    row: next,
    fingerprint: creatorUploadFingerprint(next),
  };
}

function creatorUploadPlanTwitterAppend(row, request) {
  if (creatorUploadClean(row.id) !== creatorUploadClean(request.id)) {
    return {
      status: "conflict",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  var statusUrl = creatorUploadCanonicalTwitterStatus(request.statusUrl);
  if (!statusUrl) throw new Error("Invalid Twitter teaser status link.");
  var current = creatorUploadClean(row.twitterTeasers);
  var links = current.split(/\s+/).map(creatorUploadClean).filter(Boolean);
  if (links.indexOf(statusUrl) !== -1) {
    return {
      status: "idempotent",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  if (
    creatorUploadFingerprint(row) !== creatorUploadClean(request.fingerprint)
  ) {
    return {
      status: "stale",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  var next = Object.assign({}, row, {
    twitterTeasers: links.concat([statusUrl]).join("\n"),
  });
  return {
    status: "updated",
    row: next,
    fingerprint: creatorUploadFingerprint(next),
  };
}

function creatorUploadPlanRedditAppend(row, request) {
  if (creatorUploadClean(row.id) !== creatorUploadClean(request.id)) {
    return {
      status: "conflict",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  var redditUrl = creatorUploadCanonicalRedditPost(request.redditUrl);
  if (!redditUrl) throw new Error("Invalid Reddit post link.");
  var links = creatorUploadClean(row.redditPosts)
    .split(/\s+/)
    .map(creatorUploadClean)
    .filter(Boolean);
  var canonicalLinks = links
    .map(creatorUploadCanonicalRedditPost)
    .filter(Boolean)
    .filter(function (link, index, values) {
      return values.indexOf(link) === index;
    });
  if (canonicalLinks.indexOf(redditUrl) !== -1) {
    return {
      status: "idempotent",
      row: Object.assign({}, row, {
        redditPostCount: canonicalLinks.length,
        redditPosts: canonicalLinks.join("\n"),
      }),
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  if (
    creatorUploadFingerprint(row) !== creatorUploadClean(request.fingerprint)
  ) {
    return {
      status: "stale",
      row: row,
      fingerprint: creatorUploadFingerprint(row),
    };
  }
  canonicalLinks.push(redditUrl);
  var next = Object.assign({}, row, {
    redditPostCount: canonicalLinks.length,
    redditPosts: canonicalLinks.join("\n"),
  });
  return {
    status: "updated",
    row: next,
    fingerprint: creatorUploadFingerprint(next),
  };
}

function creatorUploadLedgerCanonicalUrl(platform, value) {
  if (platform === "x") return creatorUploadCanonicalTwitterStatus(value);
  if (platform === "redgifs") return creatorUploadCanonicalRedgifsWatch(value);
  if (platform === "reddit") return creatorUploadCanonicalRedditPost(value);
  return null;
}

function creatorUploadPlanLedgerAppend(rows, request) {
  var eventId = creatorUploadClean(request.eventId).slice(0, 100);
  var runId = creatorUploadClean(request.runId).slice(0, 64);
  var jobId = creatorUploadClean(request.jobId).slice(0, 100);
  var platform = creatorUploadClean(request.platform).toLowerCase();
  var catalogueRow = Number(request.catalogueRow);
  var catalogueId = creatorUploadClean(request.catalogueId).slice(0, 500);
  var resultId = creatorUploadClean(request.resultId).slice(0, 200);
  var resultUrl = creatorUploadLedgerCanonicalUrl(platform, request.resultUrl);
  var status = creatorUploadClean(request.status).toLowerCase();
  var recordedAt = Number(request.recordedAt);
  if (
    !/^[A-Za-z0-9_-]{2,100}$/.test(eventId) ||
    !/^[A-Za-z0-9_-]{8,64}$/.test(runId) ||
    !/^[A-Za-z0-9:_-]{1,100}$/.test(jobId) ||
    ["x", "redgifs", "reddit"].indexOf(platform) === -1 ||
    !Number.isInteger(catalogueRow) ||
    catalogueRow < 2 ||
    !catalogueId ||
    !resultId ||
    !resultUrl ||
    ["published", "deleted", "removed", "unresolved"].indexOf(status) === -1 ||
    !Number.isSafeInteger(recordedAt) ||
    recordedAt < 1
  ) {
    throw new Error("Invalid distribution ledger event.");
  }
  var row = {
    key: runId + ":" + jobId + ":" + eventId,
    runId: runId,
    jobId: jobId,
    platform: platform,
    catalogueRow: catalogueRow,
    catalogueId: catalogueId,
    resultId: resultId,
    resultUrl: resultUrl,
    status: status,
    recordedAt: recordedAt,
  };
  var existing = (Array.isArray(rows) ? rows : []).find(function (candidate) {
    return candidate.key === row.key;
  });
  if (!existing) return { status: "updated", row: row };
  var fields = Object.keys(row);
  var identical = fields.every(function (field) {
    return String(existing[field]) === String(row[field]);
  });
  return { status: identical ? "idempotent" : "conflict", row: existing };
}

function creatorUploadDateValue(value) {
  if (
    Object.prototype.toString.call(value) === "[object Date]" &&
    !isNaN(value.getTime())
  ) {
    return Utilities.formatDate(value, "UTC", "yyyy-MM-dd");
  }
  var text = creatorUploadClean(value);
  var local = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return local ? local[3] + "-" + local[2] + "-" + local[1] : text;
}

function creatorUploadReadRows(sheet) {
  var maxRow = Math.min(5000, Math.max(2, sheet.getMaxRows()));
  var endRow = Math.min(maxRow, Math.max(2, sheet.getLastRow() + 1));
  var values = sheet.getRange(2, 1, endRow - 1, 20).getValues();
  return values.map(function (cells, index) {
    return {
      row: index + 2,
      id: creatorUploadClean(cells[0]),
      releaseDate: creatorUploadDateValue(cells[1]),
      title: creatorUploadClean(cells[2]),
      description: creatorUploadClean(cells[3]),
      seasonArc: creatorUploadClean(cells[4]),
      episode: creatorUploadClean(cells[6]),
      pornhubLink: creatorUploadClean(cells[7]),
      onlyfansLink: creatorUploadClean(cells[9]),
      fanslyLink: creatorUploadClean(cells[10]),
      manyvidsLink: creatorUploadClean(cells[11]),
      twitterTeasers: creatorUploadClean(cells[14]),
      redditPostCount: Number(cells[18]) || 0,
      redditPosts: creatorUploadClean(cells[19]),
      empty: !cells.slice(0, 12).some(creatorUploadClean),
    };
  });
}

function creatorUploadSnapshot(rows) {
  var empty = rows.find(creatorUploadEmptyRow);
  if (!empty) throw new Error("No empty catalogue row is available.");
  function publicRow(row) {
    var result = Object.assign({}, row, {
      fingerprint: creatorUploadFingerprint(row),
    });
    delete result.empty;
    return result;
  }
  return {
    status: "snapshot",
    rows: rows
      .filter(function (row) {
        return !creatorUploadEmptyRow(row);
      })
      .map(publicRow),
    emptyRow: publicRow(empty),
  };
}

function creatorUploadValidateDraft(payload) {
  var draft = {
    filename: creatorUploadClean(payload.filename).slice(0, 255),
    title: creatorUploadClean(payload.title).slice(0, 500),
    description: creatorUploadClean(payload.description).slice(0, 10000),
    releaseDate: creatorUploadClean(payload.releaseDate),
    targets: Array.isArray(payload.targets) ? payload.targets.slice(0, 3) : [],
    forceNew: payload.forceNew === true,
  };
  if (
    !draft.title ||
    !/^\d{4}-\d{2}-\d{2}$/.test(draft.releaseDate) ||
    !draft.targets.length ||
    draft.targets.some(function (target) {
      return ["onlyfans", "fansly", "manyvids"].indexOf(target) === -1;
    })
  ) {
    throw new Error("Invalid catalogue match request.");
  }
  return draft;
}

function creatorUploadSheet(book) {
  book = book || SpreadsheetApp.openById(creatorUploadSpreadsheetId());
  var sheet = book.getSheetByName(CREATOR_UPLOAD_SHEET_NAME);
  if (!sheet) throw new Error("The catalogue sheet is unavailable.");
  return sheet;
}

function creatorUploadReadPresetRows(sheet) {
  var lastRow = Math.min(5000, Math.max(1, sheet.getLastRow()));
  if (lastRow < 2) return [];
  return sheet
    .getRange(2, 25, lastRow - 1, 3)
    .getValues()
    .map(function (cells) {
      return {
        subreddit: creatorUploadClean(cells[0]).slice(0, 23),
        status: creatorUploadClean(cells[1]).slice(0, 30),
        notes: creatorUploadClean(cells[2]).slice(0, 5000),
      };
    })
    .filter(function (row) {
      return row.subreddit || row.status || row.notes;
    });
}

function creatorUploadReadLedgerRows(sheet) {
  var lastRow = Math.min(20000, Math.max(1, sheet.getLastRow()));
  if (lastRow < 2) return [];
  return sheet
    .getRange(2, 1, lastRow - 1, 10)
    .getValues()
    .map(function (cells) {
      return {
        key: creatorUploadClean(cells[0]),
        runId: creatorUploadClean(cells[1]),
        jobId: creatorUploadClean(cells[2]),
        platform: creatorUploadClean(cells[3]),
        catalogueRow: Number(cells[4]),
        catalogueId: creatorUploadClean(cells[5]),
        resultId: creatorUploadClean(cells[6]),
        resultUrl: creatorUploadClean(cells[7]),
        status: creatorUploadClean(cells[8]),
        recordedAt: Number(cells[9]),
      };
    });
}

function creatorUploadLedgerSheet(book) {
  var sheet = book.getSheetByName(CREATOR_UPLOAD_LEDGER_SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(CREATOR_UPLOAD_LEDGER_SHEET_NAME);
    sheet.appendRow([
      "Key",
      "Run ID",
      "Job ID",
      "Platform",
      "Catalogue row",
      "Catalogue ID",
      "Result ID",
      "Result URL",
      "Status",
      "Recorded at (UTC ms)",
    ]);
  }
  if (typeof sheet.hideSheet === "function") sheet.hideSheet();
  return sheet;
}

function creatorUploadHandle(action, payload) {
  var book = SpreadsheetApp.openById(creatorUploadSpreadsheetId());
  if (action === "getSubredditPresetSnapshot") {
    var presetSheet = book.getSheetByName(CREATOR_UPLOAD_PRESET_SHEET_NAME);
    if (!presetSheet)
      throw new Error("The subreddit preset sheet is unavailable.");
    return {
      status: "snapshot",
      rows: creatorUploadReadPresetRows(presetSheet),
    };
  }
  if (action === "appendDistributionLedger") {
    var ledgerLock = LockService.getScriptLock();
    if (!ledgerLock.tryLock(15000))
      throw new Error(
        "The distribution ledger is busy; retry this checkpoint.",
      );
    try {
      var ledgerSheet = creatorUploadLedgerSheet(book);
      var ledgerPlan = creatorUploadPlanLedgerAppend(
        creatorUploadReadLedgerRows(ledgerSheet),
        payload || {},
      );
      if (ledgerPlan.status !== "updated") return ledgerPlan;
      var ledgerRow = ledgerPlan.row;
      ledgerSheet.appendRow([
        ledgerRow.key,
        ledgerRow.runId,
        ledgerRow.jobId,
        ledgerRow.platform,
        ledgerRow.catalogueRow,
        ledgerRow.catalogueId,
        ledgerRow.resultId,
        ledgerRow.resultUrl,
        ledgerRow.status,
        ledgerRow.recordedAt,
      ]);
      SpreadsheetApp.flush();
      var ledgerVerified = creatorUploadPlanLedgerAppend(
        creatorUploadReadLedgerRows(ledgerSheet),
        payload || {},
      );
      if (ledgerVerified.status !== "idempotent") {
        throw new Error(
          "The distribution ledger append could not be verified.",
        );
      }
      return { status: "updated", row: ledgerVerified.row };
    } finally {
      ledgerLock.releaseLock();
    }
  }
  var sheet = creatorUploadSheet(book);
  if (action === "getCatalogueSnapshot") {
    return creatorUploadSnapshot(creatorUploadReadRows(sheet));
  }
  if (action === "matchCatalogue") {
    return creatorUploadMatchRows(
      creatorUploadValidateDraft(payload || {}),
      creatorUploadReadRows(sheet),
    );
  }
  if (
    action !== "commitPlatformLink" &&
    action !== "appendTwitterTeaser" &&
    action !== "appendRedditPost"
  )
    throw new Error("Unsupported catalogue action.");
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000))
    throw new Error("The catalogue is busy; retry this platform.");
  try {
    var rowNumber = Number(payload.row);
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > 5000) {
      throw new Error("Invalid catalogue row.");
    }
    var current = creatorUploadReadRows(sheet).find(function (row) {
      return row.row === rowNumber;
    });
    if (!current) throw new Error("The catalogue row is unavailable.");
    var plan =
      action === "appendTwitterTeaser"
        ? creatorUploadPlanTwitterAppend(current, payload)
        : action === "appendRedditPost"
          ? creatorUploadPlanRedditAppend(current, payload)
          : creatorUploadPlanCommit(current, payload);
    if (plan.status !== "updated") return plan;
    if (action === "appendTwitterTeaser") {
      sheet.getRange(rowNumber, 15).setValue(plan.row.twitterTeasers);
      SpreadsheetApp.flush();
      var twitterVerified = creatorUploadReadRows(sheet).find(function (row) {
        return row.row === rowNumber;
      });
      var canonicalTwitter = creatorUploadCanonicalTwitterStatus(
        payload.statusUrl,
      );
      var verifiedTwitterLinks = twitterVerified
        ? creatorUploadClean(twitterVerified.twitterTeasers)
            .split(/\s+/)
            .map(creatorUploadClean)
            .filter(Boolean)
        : [];
      if (
        !twitterVerified ||
        verifiedTwitterLinks.indexOf(canonicalTwitter) === -1
      ) {
        throw new Error(
          "The Twitter teaser append could not be verified as durable.",
        );
      }
      return {
        status: "updated",
        row: twitterVerified,
        fingerprint: creatorUploadFingerprint(twitterVerified),
      };
    }
    if (action === "appendRedditPost") {
      sheet
        .getRange(rowNumber, 19, 1, 2)
        .setValues([[plan.row.redditPostCount, plan.row.redditPosts]]);
      SpreadsheetApp.flush();
      var redditVerified = creatorUploadReadRows(sheet).find(function (row) {
        return row.row === rowNumber;
      });
      var canonicalReddit = creatorUploadCanonicalRedditPost(payload.redditUrl);
      var verifiedRedditLinks = redditVerified
        ? creatorUploadClean(redditVerified.redditPosts)
            .split(/\s+/)
            .map(creatorUploadClean)
            .filter(Boolean)
        : [];
      if (
        !redditVerified ||
        verifiedRedditLinks.indexOf(canonicalReddit) === -1 ||
        redditVerified.redditPostCount !== verifiedRedditLinks.length
      ) {
        throw new Error(
          "The Reddit post append could not be verified as durable.",
        );
      }
      return {
        status: "updated",
        row: redditVerified,
        fingerprint: creatorUploadFingerprint(redditVerified),
      };
    }
    if (creatorUploadEmptyRow(current)) {
      sheet
        .getRange(rowNumber, 1, 1, 4)
        .setValues([
          [
            plan.row.id,
            new Date(plan.row.releaseDate + "T00:00:00Z"),
            plan.row.title,
            plan.row.description,
          ],
        ]);
    }
    var field = CREATOR_UPLOAD_LINK_FIELDS[payload.platform];
    var column = CREATOR_UPLOAD_LINK_COLUMNS[payload.platform];
    if (!field || !column) throw new Error("Invalid platform post link.");
    sheet.getRange(rowNumber, column).setValue(plan.row[field]);
    SpreadsheetApp.flush();
    var verified = creatorUploadReadRows(sheet).find(function (row) {
      return row.row === rowNumber;
    });
    return {
      status: "updated",
      row: verified,
      fingerprint: creatorUploadFingerprint(verified),
    };
  } finally {
    lock.releaseLock();
  }
}

function creatorUploadJson(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function doPost(event) {
  try {
    var contents =
      event && event.postData
        ? creatorUploadClean(event.postData.contents)
        : "";
    if (!contents || contents.length > 32000)
      throw new Error("Invalid request body.");
    var request = JSON.parse(contents);
    var expected = PropertiesService.getScriptProperties().getProperty(
      CREATOR_UPLOAD_SECRET_PROPERTY,
    );
    if (!expected || creatorUploadClean(request.secret) !== expected) {
      throw new Error("Catalogue bridge authorization failed.");
    }
    return creatorUploadJson({
      ok: true,
      result: creatorUploadHandle(request.action, request.payload || {}),
    });
  } catch (error) {
    return creatorUploadJson({
      ok: false,
      error: creatorUploadClean(error.message) || "Catalogue bridge failed.",
    });
  }
}

globalThis.CreatorCatalogueBridgeTest = Object.freeze({
  fingerprint: creatorUploadFingerprint,
  handle: creatorUploadHandle,
  matchRows: creatorUploadMatchRows,
  planCommit: creatorUploadPlanCommit,
  planTwitterAppend: creatorUploadPlanTwitterAppend,
  planRedditAppend: creatorUploadPlanRedditAppend,
  planLedgerAppend: creatorUploadPlanLedgerAppend,
  readLedgerRows: creatorUploadReadLedgerRows,
  readPresetRows: creatorUploadReadPresetRows,
  readRows: creatorUploadReadRows,
  snapshot: creatorUploadSnapshot,
});
