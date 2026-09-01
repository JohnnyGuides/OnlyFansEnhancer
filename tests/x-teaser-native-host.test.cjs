"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { before, test } = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const project = path.join(
  repositoryRoot,
  "native-host",
  "CreatorTeaserNativeHost",
  "CreatorTeaserNativeHost.csproj",
);
const dll = path.join(
  repositoryRoot,
  "native-host",
  "CreatorTeaserNativeHost",
  "bin",
  "Release",
  "net8.0",
  "CreatorTeaserNativeHost.dll",
);
const frameDataUrl = `data:image/jpeg;base64,${Buffer.from([
  0xff, 0xd8, 0xff, 0xd9,
]).toString("base64")}`;

before(() => {
  const result = spawnSync("dotnet", ["build", project, "-c", "Release"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-teaser-host-"));
  const teaserRoot = path.join(root, "tweets");
  const auditRoot = path.join(root, "audit");
  const done = path.join(teaserRoot, "Done");
  fs.mkdirSync(teaserRoot);
  fs.mkdirSync(auditRoot);
  fs.mkdirSync(done);
  fs.mkdirSync(path.join(auditRoot, "frames"));
  const basename = "resident-evil-ashley--teaser-01--face.mp4";
  const source = path.join(teaserRoot, basename);
  const bytes = Buffer.from("confirmed teaser fixture");
  fs.writeFileSync(source, bytes);
  const modified = new Date("2026-08-31T20:00:00.000Z");
  fs.utimesSync(source, modified, modified);
  const row = {
    row: 125,
    id: "resident-evil-ashley",
    releaseDate: "31.08.2026",
    title: "gooning to Ashley from Resident Evil 4",
    description: "Description",
    arc: "Resident Evil",
    category: "FantasyFuck",
    episode: "",
    pornhub: "",
    onlyfans: "https://onlyfans.com/1/johnny_guides",
    fansly: "https://fansly.com/post/2",
    manyvids: "",
    teaserCount: "0",
    urls: [],
  };
  fs.writeFileSync(
    path.join(auditRoot, "catalogue.json"),
    JSON.stringify({ headers: [], rows: [row] }, null, 2),
  );
  fs.writeFileSync(
    path.join(auditRoot, "frame-data.json"),
    JSON.stringify(
      {
        generatedAt: "2026-08-29",
        sheet: { tab: "2026 Video Catalogue" },
        summary: {
          catalogueLinks: 0,
          uniqueCatalogueLinks: 0,
          liveCatalogueLinks: 0,
          completeFrameEntries: 0,
          partialFrameEntries: 0,
          unmappedVisiblePosts: 0,
        },
        catalogue: [row],
        entries: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(auditRoot, "report-template.html"),
    "<!doctype html><script>const DATA=__AUDIT_DATA__;</script>",
  );
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ teaserRoot, auditRoot, doneName: "Done" }, null, 2),
  );
  const proof = {
    basename,
    size: bytes.length,
    lastModified: fs.statSync(source).mtimeMs,
    duration: 36.787,
    sha256: sha256(bytes),
  };
  return { root, teaserRoot, auditRoot, done, source, basename, proof, row };
}

function auditRequest(value) {
  const statusId = "2094523397057237306";
  return {
    operation: "audit",
    basename: value.basename,
    fileProof: value.proof,
    status: {
      statusId,
      statusUrl: `https://x.com/Johnny_Guides/status/${statusId}`,
      caption: "found Ashley in RE4",
      timestamp: "2026-08-31T20:31:00.000Z",
      duration: 36.787,
      poster: "https://pbs.twimg.com/media/poster.jpg",
    },
    catalogue: {
      row: value.row.row,
      id: value.row.id,
      title: value.row.title,
    },
    frames: [frameDataUrl, frameDataUrl, frameDataUrl],
  };
}

function invoke(value, request) {
  const requestPath = path.join(value.root, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const result = spawnSync(
    "dotnet",
    [dll, "--request", path.join(value.root, "config.json"), requestPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const output = JSON.parse(result.stdout.trim());
  return { ...output, exitCode: result.status, stderr: result.stderr };
}

test("native host writes one durable audit before an idempotent final move", () => {
  const value = fixture();
  try {
    const request = auditRequest(value);
    const audited = invoke(value, request);
    assert.equal(audited.ok, true, audited.error);
    assert.equal(audited.auditOutcome, "updated");
    assert.equal(fs.existsSync(value.source), true);

    const catalogue = JSON.parse(
      fs.readFileSync(path.join(value.auditRoot, "catalogue.json"), "utf8"),
    );
    const frameData = JSON.parse(
      fs.readFileSync(path.join(value.auditRoot, "frame-data.json"), "utf8"),
    );
    assert.deepEqual(catalogue.rows[0].urls, [request.status.statusUrl]);
    assert.equal(catalogue.rows[0].teaserCount, "1");
    assert.equal(frameData.entries.length, 1);
    assert.equal(frameData.entries[0].row, 125);
    assert.equal(frameData.entries[0].frames.length, 3);
    assert.equal(frameData.summary.completeFrameEntries, 1);
    assert.doesNotMatch(
      fs.readFileSync(path.join(value.auditRoot, "index.html"), "utf8"),
      /__AUDIT_DATA__/,
    );
    for (const frame of frameData.entries[0].frames) {
      assert.equal(fs.existsSync(path.join(value.auditRoot, frame.file)), true);
    }

    const again = invoke(value, request);
    assert.equal(again.ok, true);
    assert.equal(again.auditOutcome, "idempotent");

    const moved = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: request.status.statusId,
      receipt: audited.receipt,
    });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(moved.moveOutcome, "moved");
    assert.equal(fs.existsSync(value.source), false);
    assert.equal(fs.existsSync(path.join(value.done, value.basename)), true);

    const movedAgain = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: request.status.statusId,
      receipt: audited.receipt,
    });
    assert.equal(movedAgain.ok, true);
    assert.equal(movedAgain.moveOutcome, "idempotent");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("native host rejects traversal and stable identity mismatches", () => {
  const value = fixture();
  try {
    const traversal = invoke(value, {
      ...auditRequest(value),
      basename: "..\\escape.mp4",
    });
    assert.equal(traversal.ok, false);
    assert.match(traversal.error, /basename|path/i);

    const mismatch = invoke(value, {
      ...auditRequest(value),
      fileProof: { ...value.proof, size: value.proof.size + 1 },
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /identity/i);
    assert.equal(
      fs.existsSync(path.join(value.auditRoot, "frame-data.json")),
      true,
    );
    assert.equal(fs.readdirSync(path.join(value.auditRoot, "frames")).length, 0);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("native host refuses a move before audit and never overwrites Done", () => {
  const value = fixture();
  try {
    const early = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: "2094523397057237306",
      receipt: "missing",
    });
    assert.equal(early.ok, false);
    assert.match(early.error, /receipt|audit/i);
    assert.equal(fs.existsSync(value.source), true);

    const audited = invoke(value, auditRequest(value));
    assert.equal(audited.ok, true);
    fs.writeFileSync(path.join(value.done, value.basename), "collision");
    const collision = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: "2094523397057237306",
      receipt: audited.receipt,
    });
    assert.equal(collision.ok, false);
    assert.match(collision.error, /destination|collision/i);
    assert.equal(fs.existsSync(value.source), true);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("native host rejects multiple matches and reparse-point escapes", (t) => {
  const value = fixture();
  try {
    const nested = path.join(value.teaserRoot, "nested");
    fs.mkdirSync(nested);
    fs.copyFileSync(value.source, path.join(nested, value.basename));
    const multiple = invoke(value, auditRequest(value));
    assert.equal(multiple.ok, false);
    assert.match(multiple.error, /multiple|exactly one/i);
    fs.rmSync(nested, { recursive: true, force: true });

    const outside = path.join(value.root, "outside");
    fs.mkdirSync(outside);
    const junction = path.join(value.teaserRoot, "junction");
    try {
      fs.symlinkSync(outside, junction, "junction");
    } catch (error) {
      t.skip(`Junction creation unavailable: ${error.message}`);
      return;
    }
    const escapedSource = path.join(outside, value.basename);
    fs.renameSync(value.source, escapedSource);
    const escaped = invoke(value, auditRequest(value));
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /reparse|source|match/i);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
