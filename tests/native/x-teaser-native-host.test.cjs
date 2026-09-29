"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { before, test } = require("node:test");

const repositoryRoot = require("../support/paths.cjs").repositoryRoot;
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

test("configuration filesystem failures return a static native error without private paths", () => {
  const value = fixture();
  try {
    fs.unlinkSync(path.join(value.root, "config.json"));
    const result = invoke(value, { operation: "audit" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "native-filesystem-failure");
    assert.ok(!JSON.stringify(result).includes(value.root));
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

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
    assert.equal(
      fs.readdirSync(path.join(value.auditRoot, "frames")).length,
      0,
    );
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

test("native host refuses move when aggregate audit proof is corrupted", () => {
  const value = fixture();
  try {
    const request = auditRequest(value);
    const audited = invoke(value, request);
    assert.equal(audited.ok, true, audited.error);
    fs.writeFileSync(
      path.join(value.auditRoot, "frame-data.json"),
      "{}",
      "utf8",
    );
    const moved = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: request.status.statusId,
      receipt: audited.receipt,
    });
    assert.equal(moved.ok, false);
    assert.match(moved.error, /aggregate|proof|audit/i);
    assert.equal(fs.existsSync(value.source), true);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("native host recomputes the receipt token instead of trusting an edited field", () => {
  const value = fixture();
  try {
    const request = auditRequest(value);
    const audited = invoke(value, request);
    assert.equal(audited.ok, true, audited.error);
    const receiptPath = path.join(
      value.auditRoot,
      ".creator-x-teaser-receipts",
      `${request.status.statusId}.json`,
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.receipt = "a".repeat(64);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const moved = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: request.status.statusId,
      receipt: receipt.receipt,
    });
    assert.equal(moved.ok, false);
    assert.match(moved.error, /token|receipt|proof/i);
    assert.equal(fs.existsSync(value.source), true);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("an older receipt remains valid after a later audit extends aggregate files", () => {
  const value = fixture();
  try {
    const firstRequest = auditRequest(value);
    const first = invoke(value, firstRequest);
    assert.equal(first.ok, true, first.error);
    const secondBasename = "second-teaser.mp4";
    const secondSource = path.join(value.teaserRoot, secondBasename);
    const secondBytes = Buffer.from("second confirmed teaser fixture");
    fs.writeFileSync(secondSource, secondBytes);
    const secondProof = {
      basename: secondBasename,
      size: secondBytes.length,
      lastModified: fs.statSync(secondSource).mtimeMs,
      duration: 12,
      sha256: sha256(secondBytes),
    };
    const secondRequest = {
      ...firstRequest,
      basename: secondBasename,
      fileProof: secondProof,
      status: {
        ...firstRequest.status,
        statusId: "2094523397057237307",
        statusUrl: "https://x.com/Johnny_Guides/status/2094523397057237307",
      },
    };
    const second = invoke(value, secondRequest);
    assert.equal(second.ok, true, second.error);
    const moved = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: firstRequest.status.statusId,
      receipt: first.receipt,
    });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(moved.moveOutcome, "moved");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("native host rejects audit-frame junctions during recovery", (t) => {
  const value = fixture();
  try {
    const request = auditRequest(value);
    const audited = invoke(value, request);
    assert.equal(audited.ok, true, audited.error);
    const frames = path.join(value.auditRoot, "frames");
    const outside = path.join(value.root, "outside-frames");
    fs.renameSync(frames, outside);
    try {
      fs.symlinkSync(outside, frames, "junction");
    } catch (error) {
      t.skip(`Junction creation unavailable: ${error.message}`);
      return;
    }
    const moved = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: request.status.statusId,
      receipt: audited.receipt,
    });
    assert.equal(moved.ok, false);
    assert.match(moved.error, /reparse/i);
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

// ---- B12: audit/move serialization, staged writes, framing errors ----
const { spawn } = require("node:child_process");

function faultEnv(value, extra) {
  return {
    ...process.env,
    OFENHANCER_TEST_FAULT_DIR: value.root,
    ...extra,
  };
}

function invokeRaw(value, request, env) {
  const requestPath = path.join(value.root, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const result = spawnSync(
    "dotnet",
    [dll, "--request", path.join(value.root, "config.json"), requestPath],
    { cwd: repositoryRoot, encoding: "utf8", env: env ?? process.env },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function invokeAsync(value, request, env) {
  const requestPath = path.join(value.root, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "dotnet",
      [dll, "--request", path.join(value.root, "config.json"), requestPath],
      { cwd: repositoryRoot, env: env ?? process.env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      let output = {};
      try {
        output = JSON.parse(stdout.trim());
      } catch {
        output = { ok: false, error: `unparseable: ${stdout} ${stderr}` };
      }
      resolve({ ...output, exitCode: status });
    });
  });
}

function addSource(value, request, name, statusId, text) {
  const source = path.join(value.teaserRoot, name);
  const bytes = Buffer.from(text);
  fs.writeFileSync(source, bytes);
  return {
    ...request,
    basename: name,
    fileProof: {
      basename: name,
      size: bytes.length,
      lastModified: fs.statSync(source).mtimeMs,
      duration: 12,
      sha256: sha256(bytes),
    },
    status: {
      ...request.status,
      statusId,
      statusUrl: `https://x.com/Johnny_Guides/status/${statusId}`,
    },
  };
}

function walk(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function tempFiles(value) {
  return walk(value.auditRoot).filter((file) => file.endsWith(".tmp"));
}

function readAggregates(value) {
  return {
    catalogue: JSON.parse(
      fs.readFileSync(path.join(value.auditRoot, "catalogue.json"), "utf8"),
    ),
    frameData: JSON.parse(
      fs.readFileSync(path.join(value.auditRoot, "frame-data.json"), "utf8"),
    ),
  };
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("two host processes extending one audit root lose no update", async () => {
  for (let repetition = 0; repetition < 10; repetition++) {
    const value = fixture();
    try {
      const first = auditRequest(value);
      const second = addSource(
        value,
        first,
        "second-teaser.mp4",
        "2094523397057237307",
        "second confirmed teaser fixture",
      );
      const env = faultEnv(value, { OFENHANCER_TEST_PAUSE_MS: "300" });
      const results = await Promise.all([
        invokeAsync(value, first, env),
        invokeAsync(value, second, env),
      ]);
      for (const result of results) {
        assert.ok(
          result.ok === true || /busy/i.test(result.error),
          `${result.error}`,
        );
      }
      const succeeded = [first, second].filter((_, i) => results[i].ok);
      const { catalogue, frameData } = readAggregates(value);
      assert.deepEqual(
        catalogue.rows[0].urls.slice().sort(),
        succeeded.map((r) => r.status.statusUrl).sort(),
      );
      assert.deepEqual(
        frameData.entries.map((entry) => entry.url).sort(),
        succeeded.map((r) => r.status.statusUrl).sort(),
      );
      assert.equal(succeeded.length, 2, "both waited for the lock");
      assert.deepEqual(tempFiles(value), []);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("a held audit lock yields a busy error and writes nothing", async () => {
  const value = fixture();
  try {
    const first = auditRequest(value);
    const second = addSource(
      value,
      first,
      "second-teaser.mp4",
      "2094523397057237307",
      "second confirmed teaser fixture",
    );
    const holder = invokeAsync(
      value,
      first,
      faultEnv(value, { OFENHANCER_TEST_PAUSE_MS: "3000" }),
    );
    await waitFor(
      () => fs.readdirSync(value.root).some((n) => n.endsWith(".marker")),
      15000,
    );
    const blocked = await invokeAsync(
      value,
      second,
      faultEnv(value, { OFENHANCER_TEST_LOCK_TIMEOUT_MS: "300" }),
    );
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /busy/i);
    const held = await holder;
    assert.equal(held.ok, true, held.error);
    const { catalogue, frameData } = readAggregates(value);
    assert.deepEqual(catalogue.rows[0].urls, [first.status.statusUrl]);
    assert.equal(frameData.entries.length, 1);
    assert.equal(
      fs.existsSync(
        path.join(
          value.auditRoot,
          ".creator-x-teaser-receipts",
          `${second.status.statusId}.json`,
        ),
      ),
      false,
    );
    assert.equal(
      fs
        .readdirSync(path.join(value.auditRoot, "frames"))
        .some((name) => name.includes(second.status.statusId)),
      false,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

const interruptionPoints = [
  "mid-write-frame-1",
  "staged-frame-1",
  "after-frame-1",
  "after-frame-3",
  "after-catalogue",
  "after-frame-data",
  "before-receipt",
  "mid-write-receipt",
  "staged-receipt",
];

for (const point of interruptionPoints) {
  test(`an audit interrupted at ${point} recovers to the uninterrupted receipt`, () => {
    const baseline = fixture();
    const value = fixture();
    try {
      const expected = invoke(baseline, auditRequest(baseline));
      assert.equal(expected.ok, true, expected.error);
      const request = auditRequest(value);
      const killed = invokeRaw(
        value,
        request,
        faultEnv(value, { OFENHANCER_TEST_FAULT: point }),
      );
      assert.equal(killed.status, 87, `fault ${point} not injected`);
      assert.equal(killed.stdout, "");
      const retry = invoke(value, request);
      assert.equal(retry.ok, true, retry.error);
      assert.equal(retry.receipt, expected.receipt);
      assert.deepEqual(tempFiles(value), []);
      const { catalogue, frameData } = readAggregates(value);
      assert.deepEqual(catalogue.rows[0].urls, [request.status.statusUrl]);
      assert.equal(frameData.entries.length, 1);
      const moved = invoke(value, {
        operation: "move",
        basename: value.basename,
        fileProof: value.proof,
        statusId: request.status.statusId,
        receipt: retry.receipt,
      });
      assert.equal(moved.ok, true, moved.error);
      assert.deepEqual(tempFiles(value), []);
    } finally {
      fs.rmSync(baseline.root, { recursive: true, force: true });
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
}

test("the test-hook guard honours only a real directory under the system temp path", () => {
  const outside = fs.mkdtempSync(path.join(repositoryRoot, "guard-outside-"));
  const cases = [
    ["a directory outside temp", () => outside, 0],
    [
      "a junction under temp pointing outside",
      (value) => {
        const junction = path.join(value.root, "junction-outside");
        fs.symlinkSync(outside, junction, "junction");
        return junction;
      },
      0,
    ],
    ["a real directory under temp", (value) => value.root, 87],
  ];
  try {
    for (const [name, faultDirectory, expected] of cases) {
      const value = fixture();
      try {
        const result = invokeRaw(value, auditRequest(value), {
          ...process.env,
          OFENHANCER_TEST_FAULT_DIR: faultDirectory(value),
          OFENHANCER_TEST_FAULT: "after-catalogue",
        });
        assert.equal(result.status, expected, `${name}: ${result.stderr}`);
      } finally {
        fs.rmSync(path.join(value.root, "junction-outside"), { recursive: true, force: true });
        fs.rmSync(value.root, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("no temporary files remain after success or a failed move", () => {
  const value = fixture();
  try {
    const request = auditRequest(value);
    const audited = invoke(value, request);
    assert.equal(audited.ok, true, audited.error);
    assert.deepEqual(tempFiles(value), []);
    fs.writeFileSync(path.join(value.done, value.basename), "collision");
    const collision = invoke(value, {
      operation: "move",
      basename: value.basename,
      fileProof: value.proof,
      statusId: request.status.statusId,
      receipt: audited.receipt,
    });
    assert.equal(collision.ok, false);
    assert.deepEqual(tempFiles(value), []);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a failed aggregate publish removes its temporary file", () => {
  const value = fixture();
  try {
    fs.mkdirSync(path.join(value.auditRoot, "index.html"));
    const failed = invoke(value, auditRequest(value));
    assert.equal(failed.ok, false);
    assert.deepEqual(tempFiles(value), []);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a foreign final-name artifact is never overwritten", () => {
  const value = fixture();
  try {
    const request = auditRequest(value);
    const foreign = path.join(
      value.auditRoot,
      "frames",
      `${value.row.id}-${request.status.statusId}-f2.jpg`,
    );
    fs.writeFileSync(foreign, "foreign bytes");
    const failed = invoke(value, request);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /collision/i);
    assert.equal(fs.readFileSync(foreign, "utf8"), "foreign bytes");
    assert.equal(
      fs.existsSync(
        path.join(
          value.auditRoot,
          ".creator-x-teaser-receipts",
          `${request.status.statusId}.json`,
        ),
      ),
      false,
    );
    assert.deepEqual(tempFiles(value), []);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a leftover host temporary file is removed and a foreign dot-file is kept", () => {
  const value = fixture();
  try {
    const frames = path.join(value.auditRoot, "frames");
    const leftover = path.join(frames, ".x.0123.ofe-audit.tmp");
    const foreign = path.join(frames, ".keep.tmp");
    fs.writeFileSync(leftover, "torn");
    fs.writeFileSync(foreign, "not ours");
    const result = invoke(value, auditRequest(value));
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(fs.readFileSync(foreign, "utf8"), "not ours");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("an invalid length prefix gets a structured error, not a crash", () => {
  const result = spawnSync("dotnet", [dll], {
    cwd: repositoryRoot,
    input: Buffer.from([0xff, 0xff, 0xff, 0xff]),
  });
  assert.equal(result.status, 1, String(result.stderr));
  const length = result.stdout.readUInt32LE(0);
  const response = JSON.parse(result.stdout.subarray(4, 4 + length).toString());
  assert.equal(response.ok, false);
  assert.match(response.error, /bounded size/i);
  assert.doesNotMatch(String(result.stderr), /Unhandled exception/i);
});
