"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createUploadFixture } = require("../support/upload-action-fixture.cjs");

const PAST = "2020-01-03";
const FUTURE = "2099-01-02";
// A Tuesday; the next schedulable Friday is 2099-01-09.
const FUTURE_TUESDAY = "2099-01-06";

function installCatalogue(page) {
  return page.evaluate(
    ([past, future, tuesday]) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.readinessRequests = [];
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY") {
          readinessRequests.push(message);
          return callback({ ok: true, availability: { ready: true } });
        }
        return send(message, callback);
      };
      const rows = [
        ["Studio tour", past],
        ["Studio tour recap", future],
        ["Studio tour outtakes", tuesday],
      ].map(([title, releaseDate], index) => ({
        row: 42 + index,
        id: `studio-${index}`,
        itemId: `studio-${index}`,
        title,
        description: `Description ${index}`,
        category: "GameSync",
        seasonArc: "Setaria",
        releaseDate,
        fingerprint: "a".repeat(64),
        publicationState: { onlyfans: "empty" },
      }));
      globalThis.CreatorCatalogueClient = {
        loadConfig: async () => ({ source: "desktop", connected: true }),
        getCatalogueSnapshot: async () => ({
          status: "snapshot",
          source: "desktop",
          rows,
        }),
        writeUploadCatalogueEntry: async () => {
          throw new Error("Fixture stops before external writes");
        },
      };
      globalThis.CreatorUploadQueueEvidence = {
        snapshot: () =>
          Object.fromEntries(
            ["onlyfans", "fansly", "manyvids"].map((p) => [
              p,
              { verified: true, scheduled: [], occupiedFridays: [] },
            ]),
          ),
      };
    },
    [PAST, FUTURE, FUTURE_TUESDAY],
  );
}

async function matched(fixture) {
  const { page } = fixture;
  await installCatalogue(page);
  await fixture.ready();
  await page.locator("#uploadTitle").fill("Studio tour");
  await page.waitForFunction(
    () =>
      !document.querySelector("#uploadButton").disabled &&
      document.querySelectorAll("#catalogueCards .catalogue-card").length >= 3,
  );
  return page;
}

const settled = (page, expected) =>
  page.waitForFunction(
    (expected) =>
      !document.querySelector("#uploadButton").disabled &&
      document.querySelector("#releaseDate").value === expected,
    expected,
  );

test("explicit selection takes the sheet date; auto-match keeps the computed Friday", async () => {
  const fixture = await createUploadFixture();
  try {
    const page = await matched(fixture);
    const automatic = await page.locator("#releaseDate").inputValue();
    assert.notEqual(automatic, PAST);
    assert.notEqual(automatic, FUTURE);
    await page
      .locator("#catalogueCards .catalogue-card", {
        hasText: "Studio tour recap",
      })
      .click();
    await settled(page, FUTURE);
    const scheduled = await page.evaluate(() => readinessRequests.at(-1).draft);
    assert.equal(scheduled.scheduleIntent, "friday");
    assert.equal(scheduled.scheduledIso, `${FUTURE}T15:00:00.000Z`);
    assert.doesNotMatch(
      await page.locator("#releaseTimeSummary").textContent(),
      /Past date/,
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("a future sheet date that is not a Friday moves to the next Friday with a note", async () => {
  const fixture = await createUploadFixture();
  try {
    const page = await matched(fixture);
    await page
      .locator("#catalogueCards .catalogue-card", {
        hasText: "Studio tour outtakes",
      })
      .click();
    await settled(page, "2099-01-09");
    assert.match(
      await page.locator("#releaseTimeSummary").textContent(),
      /sheet date 2099-01-06 is not a Friday/,
    );
    assert.equal(await page.locator("#releaseTimeSummary").isVisible(), true);
    const scheduled = await page.evaluate(() => readinessRequests.at(-1).draft);
    assert.equal(scheduled.scheduleIntent, "friday");
    assert.equal(scheduled.scheduledIso, "2099-01-09T15:00:00.000Z");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("a past sheet date is noted and prepares every platform unscheduled", async () => {
  const fixture = await createUploadFixture();
  try {
    const page = await matched(fixture);
    await page
      .locator("#catalogueCards .catalogue-card", { hasText: "Studio tour" })
      .first()
      .click();
    await settled(page, PAST);
    assert.match(
      await page.locator("#releaseTimeSummary").textContent(),
      /^Past date — sheet update, posts go up unscheduled/,
    );
    assert.equal(await page.locator("#releaseTimeSummary").isVisible(), true);
    await page.waitForFunction(
      () => readinessRequests.at(-1)?.draft?.releaseDate === "2020-01-03",
    );
    const request = await page.evaluate(() => readinessRequests.at(-1));
    assert.equal(request.draft.scheduleIntent, "none");
    assert.equal(request.draft.scheduledIso, "");
    assert.deepEqual(request.targets, ["onlyfans", "fansly", "manyvids"]);
    // Editing the date afterwards leaves the past-date mode.
    await page.locator("#releaseDate").fill(FUTURE);
    await page.waitForFunction(
      () =>
        !/Past date/.test(
          document.querySelector("#releaseTimeSummary").textContent,
        ),
    );
    // A plain future Friday has no note, so the summary stays hidden.
    assert.equal(await page.locator("#releaseTimeSummary").isVisible(), false);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("a thumbnail change leaves the similar-entry cards untouched", async () => {
  const fixture = await createUploadFixture();
  try {
    const page = await matched(fixture);
    const mark = () =>
      page.evaluate(() => {
        globalThis.markedCards = [
          ...document.querySelectorAll("#catalogueCards .catalogue-card"),
        ];
        return markedCards.map((card) => card.dataset.row);
      });
    const same = () =>
      page.evaluate(() => {
        const now = [
          ...document.querySelectorAll("#catalogueCards .catalogue-card"),
        ];
        return (
          now.length === markedCards.length &&
          now.every((card, index) => card === markedCards[index])
        );
      });
    const order = await mark();
    const before = await page.evaluate(() => readinessRequests.length);
    await page.locator("#uploadManyvidsThumbnail").setInputFiles({
      name: "thumb.png",
      mimeType: "image/png",
      buffer: Buffer.from("benign png"),
    });
    await page.waitForFunction(
      (before) => readinessRequests.length > before,
      before,
    );
    await page.waitForTimeout(400);
    assert.equal(await same(), true);
    assert.deepEqual(await mark(), order);
    // Choosing a card keeps its neighbours in place and only moves the pressed state.
    await page
      .locator("#catalogueCards .catalogue-card", {
        hasText: "Studio tour recap",
      })
      .click();
    await settled(page, FUTURE);
    await page.waitForTimeout(400);
    assert.equal(await same(), true);
    assert.deepEqual(
      await page.evaluate(() =>
        [
          ...document.querySelectorAll("#catalogueCards [aria-pressed=true]"),
        ].map((card) => card.dataset.row),
      ),
      ["43"],
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});
