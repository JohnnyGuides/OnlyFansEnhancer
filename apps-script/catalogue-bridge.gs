"use strict";

var CREATOR_UPLOAD_SPREADSHEET_ID =
  "1Ninkxbv1SOvatcJ3AP4zwKWxdc32imlIkP_IMUSTR9E";
var CREATOR_UPLOAD_SHEET_NAME = "2026 Video Catalogue";
var CREATOR_UPLOAD_SECRET_PROPERTY = "CREATOR_UPLOAD_SECRET";
var CREATOR_UPLOAD_MATCH_THRESHOLD = 75;
var CREATOR_UPLOAD_LINK_FIELDS = {
  onlyfans: "onlyfansLink",
  fansly: "fanslyLink",
  manyvids: "manyvidsLink",
};
var CREATOR_UPLOAD_LINK_COLUMNS = { onlyfans: 10, fansly: 11, manyvids: 12 };

function creatorUploadClean(value) {
  return String(value == null ? "" : value).trim();
}

function creatorUploadNormalizedText(value) {
  return creatorUploadClean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.(?:mp4|m4v|mov|webm|avi|mkv)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:full|limited|teaser|final|vr)\b/g, " ")
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
  var values = sheet.getRange(2, 1, endRow - 1, 12).getValues();
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
      empty: !cells.some(creatorUploadClean),
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

function creatorUploadSheet() {
  var book = SpreadsheetApp.openById(CREATOR_UPLOAD_SPREADSHEET_ID);
  var sheet = book.getSheetByName(CREATOR_UPLOAD_SHEET_NAME);
  if (!sheet) throw new Error("The catalogue sheet is unavailable.");
  return sheet;
}

function creatorUploadHandle(action, payload) {
  var sheet = creatorUploadSheet();
  if (action === "getCatalogueSnapshot") {
    return creatorUploadSnapshot(creatorUploadReadRows(sheet));
  }
  if (action === "matchCatalogue") {
    return creatorUploadMatchRows(
      creatorUploadValidateDraft(payload || {}),
      creatorUploadReadRows(sheet),
    );
  }
  if (action !== "commitPlatformLink")
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
    var plan = creatorUploadPlanCommit(current, payload);
    if (plan.status !== "updated") return plan;
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
  matchRows: creatorUploadMatchRows,
  planCommit: creatorUploadPlanCommit,
  readRows: creatorUploadReadRows,
  snapshot: creatorUploadSnapshot,
});
