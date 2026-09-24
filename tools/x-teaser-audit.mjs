#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { catalogueFromSheet, reconcileTeasers } from "./x-teaser-planner.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function jsonFile(file, fallback) {
  return file && fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : fallback;
}

function localAssets(root, pairings) {
  if (!root) return [];
  const absolute = path.resolve(root);
  if (!fs.statSync(absolute).isDirectory())
    throw new Error("Teaser root is not a directory.");
  const assets = [],
    pending = [absolute];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile() || !/\.(mp4|mov|m4v|webm)$/i.test(entry.name))
        continue;
      const relative = path.relative(absolute, full).replaceAll(path.sep, "/");
      const parts = relative.split("/").map((part) => part.toLowerCase());
      const state = parts.includes("done")
        ? "done"
        : parts.includes("ideas")
          ? "ideas"
          : "pending";
      assets.push({
        assetId: relative.toLowerCase(),
        basename: entry.name,
        relativePath: relative,
        state,
        catalogueId: pairings[relative] || null,
      });
      if (assets.length > 10_000)
        throw new Error("Teaser inventory exceeds 10,000 files.");
    }
  }
  return assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function readReceipts(root) {
  if (!root) return [];
  const directory = path.join(path.resolve(root), ".creator-x-teaser-receipts");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => {
      const value = jsonFile(path.join(directory, name), {});
      return {
        statusId: String(value.statusId || value.StatusId || ""),
        catalogueId: String(value.catalogueId || value.CatalogueId || ""),
        basename: String(value.basename || value.Basename || ""),
      };
    })
    .filter((receipt) => receipt.statusId);
}

function markdown(report) {
  const lines = [
    "# X teaser audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This is a read-only reconciliation. Recommendations do not post, edit the Sheet, or move files.",
    "",
    "## Inventory",
    "",
    `- Catalogue entries: ${report.counts.catalogueEntries}`,
    `- Sheet X links: ${report.counts.sheetLinks}`,
    `- X video posts observed: ${report.counts.xPostsObserved}`,
    `- Pending local clips: ${report.counts.pendingAssets}`,
    `- Done clips: ${report.counts.completedAssets}`,
    `- Audit receipts: ${report.counts.receipts}`,
    "",
    "## Reconciliation",
    "",
    `- Confirmed teaser posts without a Sheet link: ${report.xWithoutSheet.length}`,
    `- Unlinked X videos needing teaser classification: ${report.xNeedsClassification.length}`,
    `- Sheet links not visible in the sampled X profile: ${report.sheetNotObservedOnX?.length ?? "not checked"}`,
    `- Pending files without an exact catalogue pairing: ${report.unpairedAssets.length}`,
    "",
  ];
  for (const id of report.xWithoutSheet)
    lines.push(`- Confirmed teaser ${id} needs an exact catalogue row.`);
  for (const id of report.xNeedsClassification)
    lines.push(
      `- Classify X video ${id} before treating it as a missing teaser link.`,
    );
  lines.push("", "## Suggested queue", "");
  if (!report.queue.length)
    lines.push("No verified file-to-catalogue pairings are ready.");
  for (const [index, item] of report.queue.entries())
    lines.push(
      `${index + 1}. ${item.suggestedAtUtc} — ${item.basename.replaceAll("\n", " ")} → ${item.catalogueId} (${item.season}).`,
    );
  lines.push("", "## Performance review", "");
  for (const item of report.performance) {
    if (item.status === "insufficient-cohort")
      lines.push(
        `- ${item.window}: ${item.comparablePosts} age-matched posts; wait for at least 10 before judging.`,
      );
    else
      lines.push(
        `- ${item.window}: review ${item.statusId} (${item.views} views versus ${item.medianViews} median).`,
      );
  }
  lines.push("", "## Pairing work", "");
  for (const item of report.preparationQueue)
    lines.push(
      `- ${item.episode.replaceAll("\n", " ")}: ${item.variants.length} local variant(s), exact catalogue pairing required.`,
    );
  lines.push("");
  return lines.join("\n");
}

const sheetPath = option("--sheet");
if (!sheetPath) {
  console.error(
    "Usage: node tools/x-teaser-audit.mjs --sheet sheet.json [--x x.json] [--teasers path] [--audit path] [--pairings pairings.json] [--snapshots snapshots.json] [--record-snapshots path] [--out report.json] [--markdown report.md] [--queue queue.json] [--strict]",
  );
  process.exitCode = 2;
} else {
  const sheet = jsonFile(sheetPath, null);
  if (!sheet?.rows) throw new Error("Sheet export must contain rows.");
  const x = jsonFile(option("--x"), { posts: [] });
  const pairings = jsonFile(option("--pairings"), {});
  const snapshotPath = option("--record-snapshots");
  let snapshots = jsonFile(option("--snapshots") || snapshotPath, []);
  if (!Array.isArray(snapshots)) throw new Error("Snapshots must be an array.");
  if (snapshotPath) {
    const observedAt = Date.parse(x.observedAt);
    if (
      !option("--x") ||
      !Number.isFinite(observedAt) ||
      Math.abs(Date.now() - observedAt) > 3_600_000
    )
      throw new Error(
        "Record only a fresh X inventory captured within one hour.",
      );
    const known = new Set(
      snapshots.map((item) => `${item.statusId}:${item.observedAt}`),
    );
    for (const post of x.posts || []) {
      if (!/^\d+$/.test(String(post.statusId)) || !Number.isFinite(post.views))
        continue;
      const key = `${post.statusId}:${x.observedAt}`;
      if (known.has(key)) continue;
      snapshots.push({
        statusId: String(post.statusId),
        observedAt: x.observedAt,
        views: post.views,
      });
      known.add(key);
    }
    const temporary = `${snapshotPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshots, null, 2) + "\n", {
      flag: "wx",
    });
    fs.renameSync(temporary, snapshotPath);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      workbookId: sheet.workbookId || null,
      sheetId: sheet.sheetId || null,
      xInventoryProvided: Boolean(option("--x")),
      localRootProvided: Boolean(option("--teasers")),
    },
    ...reconcileTeasers({
      catalogue: catalogueFromSheet(sheet.rows),
      xPosts: x.posts || [],
      assets: localAssets(option("--teasers"), pairings),
      receipts: readReceipts(option("--audit")),
      snapshots,
    }),
  };
  if (!option("--x")) {
    report.sheetNotObservedOnX = null;
    report.sheetWithoutReceipt = option("--audit")
      ? report.sheetWithoutReceipt
      : null;
  }
  if (!option("--audit")) {
    report.receiptsWithoutSheet = null;
    report.sheetWithoutReceipt = null;
  }
  const output = JSON.stringify(report, null, 2) + "\n";
  const destination = option("--out");
  if (destination) fs.writeFileSync(destination, output, { flag: "w" });
  else process.stdout.write(output);
  const markdownPath = option("--markdown");
  if (markdownPath)
    fs.writeFileSync(markdownPath, markdown(report), { flag: "w" });
  const queuePath = option("--queue");
  if (queuePath)
    fs.writeFileSync(queuePath, JSON.stringify(report.queue, null, 2) + "\n", {
      flag: "w",
    });
  if (
    process.argv.includes("--strict") &&
    (report.xWithoutSheet.length || report.duplicateSheetBindings.length)
  )
    process.exitCode = 1;
}
