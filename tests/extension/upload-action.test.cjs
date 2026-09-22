"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createUploadFixture } = require("../support/upload-action-fixture.cjs");

for (const desktop of [false, true]) {
  const surface = desktop ? "desktop hosted transport" : "extension";
  test(
    surface +
      ": one Upload binds files, prepares once and starts once without returning to editing",
    async () => {
      const fixture = await createUploadFixture({ desktop });
      const { page, worker } = fixture;
      try {
        await fixture.ready();
        await worker.evaluate(() => {
          globalThis.fixtureRequestFile = true;
        });
        await page.evaluate(() => {
          document.querySelector("#uploadButton").click();
          document
            .querySelector("#uploadButton")
            .dispatchEvent(new Event("click"));
        });
        await page.waitForFunction(
          () =>
            document
              .querySelector("#uploadButton")
              .getAttribute("aria-busy") === "true",
        );
        await page.waitForFunction(() =>
          document
            .querySelector("#matchStatus")
            .textContent.includes("Run accepted"),
        );
        const commands = await fixture.commands();
        assert.deepEqual(
          commands.map((item) => item.type),
          ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"],
        );
        const sessionId = commands[0].request.sessionId;
        assert.equal(commands[0].launcher, desktop ? "desktop" : "extension");
        assert.equal(commands[1].sessionId, sessionId);
        assert.equal(commands[0].request.draft.publishMode, "manual");
        assert.equal(
          await page.locator("#preparationControls").isVisible(),
          true,
        );
        assert.equal(await page.locator("#uploadButton").isDisabled(), true);
        assert.equal(await page.locator("#uploadTitle").isDisabled(), true);
        assert.equal(
          await page
            .locator("#uploadFullVideo")
            .evaluate((input) => input.files[0].name),
          "benign-new-clip.mp4",
        );
        if (!desktop) {
          await page.evaluate((id) => {
            globalThis.fixtureReceivedFiles = [];
            const channel = new BroadcastChannel("creator-upload:" + id);
            globalThis.fixtureReceiver = channel;
            channel.addEventListener("message", async ({ data }) => {
              if (
                data.source !== "creator-upload-console" ||
                data.sessionId !== id
              )
                return;
              if (data.direction === "probe")
                channel.postMessage({
                  source: "creator-upload-bridge",
                  direction: "ready",
                  sessionId: id,
                  platform: data.platform,
                  requestId: data.requestId,
                });
              else if (data.file instanceof File) {
                fixtureReceivedFiles.push({
                  name: data.file.name,
                  text: await data.file.text(),
                  sessionId: data.sessionId,
                });
                channel.postMessage({
                  source: "creator-upload-bridge",
                  direction: "ack",
                  sessionId: id,
                  platform: data.platform,
                  role: data.role,
                  requestId: data.requestId,
                  ok: true,
                });
              }
            });
          }, sessionId);
          await page.waitForFunction(
            () => globalThis.fixtureReceivedFiles?.length === 1,
          );
          assert.deepEqual(await page.evaluate(() => fixtureReceivedFiles[0]), {
            name: "benign-new-clip.mp4",
            text: "benign generated fixture bytes",
            sessionId,
          });
        } else {
          await page.waitForFunction(
            () => globalThis.fixtureNativeFiles.length === 1,
          );
          const file = await page.evaluate(() => fixtureNativeFiles[0]);
          assert.equal(file.name, "benign-new-clip.mp4");
          assert.equal(file.text, "benign generated fixture bytes");
          assert.equal(file.sessionId, sessionId);
        }
        await page.waitForTimeout(150);
        await worker.evaluate(() => fixtureFinish.get("onlyfans")());
        await page.waitForFunction(() =>
          document
            .querySelector("#results")
            .textContent.includes("Prepared · review and publish manually"),
        );
        assert.equal(await page.locator("#uploadButton").isDisabled(), true);
        assert.equal((await fixture.commands()).length, 2);
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
      }
    },
  );

  test(
    surface +
      ": actual recovery rejection between readiness and PREPARE is visible and preserves the draft",
    async () => {
      const fixture = await createUploadFixture({ desktop });
      const { page, worker } = fixture;
      try {
        await fixture.ready();
        const before = await fixture.seedPreparation();
        await page.locator("#uploadButton").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#uploadError")
            .textContent.includes("existing prepared or uncertain draft"),
        );
        await page.waitForFunction(
          () => document.querySelector("#reviewRecovery").hidden === false,
        );
        assert.equal(await page.locator("#uploadButton").isDisabled(), true);
        assert.equal(
          await page.locator("#uploadTitle").inputValue(),
          "Benign upload verification",
        );
        assert.equal(
          await page.locator("#uploadDescription").inputValue(),
          "Unpublished development draft.",
        );
        assert.equal(
          await page
            .locator("#uploadFullVideo")
            .evaluate((input) => input.files[0].name),
          "benign-new-clip.mp4",
        );
        assert.equal(await page.locator("#targetOnlyfans").isChecked(), true);
        assert.equal(await page.locator("#targetOnlyfans").isEnabled(), true);
        assert.equal(await page.locator("#workflowMode").isEnabled(), true);
        assert.equal(
          await page.locator("#preparationControls").isVisible(),
          false,
        );
        assert.equal(
          await page
            .locator("#confirmation, #uploadSummary, #confirmUpload")
            .count(),
          0,
        );
        assert.deepEqual(
          (await fixture.commands()).map((item) => item.type),
          ["PREPARE_CREATOR_UPLOAD"],
        );
        assert.deepEqual(
          await worker.evaluate(() => CreatorUploadSessionStore.listRecovery()),
          before,
        );
        for (const [width, zoom] of [
          [390, 1],
          [650, 2],
        ]) {
          await page.setViewportSize({ width, height: 844 });
          await page.evaluate((value) => {
            document.documentElement.style.zoom = String(value);
            window.scrollTo(0, 0);
          }, zoom);
          const recoveryControls = await page.evaluate(() =>
            ["uploadButton", "reviewRecovery", "refreshReadiness"].map((id) => {
              const rect = document.getElementById(id).getBoundingClientRect();
              return {
                id,
                visible:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.left >= 0 &&
                  rect.right <= innerWidth + 1 &&
                  rect.top >= 0 &&
                  rect.bottom <= innerHeight + 1,
              };
            }),
          );
          assert.ok(
            recoveryControls.every((control) => control.visible),
            JSON.stringify({ width, zoom, recoveryControls }),
          );
        }
        await page.evaluate(() => {
          document.documentElement.style.zoom = "1";
        });
        await page.locator("#reviewRecovery").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#recoveryRecords")
            .textContent.includes("Previous run"),
        );
        assert.match(
          await page.locator("#recoveryStatus").textContent(),
          /does not stop an upload/,
        );
        assert.deepEqual(
          await worker.evaluate(() => CreatorUploadSessionStore.listRecovery()),
          before,
        );
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
      }
    },
  );
}

test("a confirmed pre-admission failure re-enables Upload only after another successful safety check", async () => {
  const fixture = await createUploadFixture();
  const { page, worker } = fixture;
  try {
    await fixture.ready();
    await worker.evaluate(() => {
      globalThis.fixturePrepareError =
        "The connected catalogue changed. Review the item again before uploading.";
    });
    await page.locator("#uploadButton").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#uploadError")
          .textContent.includes("catalogue changed") &&
        !document.querySelector("#uploadButton").disabled,
    );
    assert.equal(await page.locator("#uploadTitle").isEnabled(), true);
    assert.equal(await page.locator("#preparationControls").isVisible(), false);
    assert.equal(
      (await fixture.commands()).filter(
        (item) => item.type === "START_CREATOR_UPLOAD",
      ).length,
      0,
    );
    await worker.evaluate(() => {
      globalThis.fixturePrepareError = "";
    });
    await page.locator("#uploadButton").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#matchStatus")
        .textContent.includes("Run accepted"),
    );
    const commands = await fixture.commands();
    assert.equal(
      commands.filter((item) => item.type === "PREPARE_CREATOR_UPLOAD").length,
      2,
    );
    assert.equal(
      commands.filter((item) => item.type === "START_CREATOR_UPLOAD").length,
      1,
    );
    assert.notEqual(
      commands[0].request.sessionId,
      commands[1].request.sessionId,
    );
    assert.equal(await page.locator("#uploadError").textContent(), "");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("uncertain START transport never unlocks or silently repeats an accepted run", async () => {
  const fixture = await createUploadFixture();
  try {
    await fixture.ready();
    await fixture.worker.evaluate(() => {
      globalThis.fixtureStartError =
        "Acknowledgement interrupted after dispatch.";
    });
    await fixture.page.locator("#uploadButton").click();
    await fixture.page.waitForFunction(() =>
      document
        .querySelector("#uploadError")
        .textContent.includes("may already have started"),
    );
    assert.equal(
      await fixture.page.locator("#uploadButton").isDisabled(),
      true,
    );
    assert.equal(await fixture.page.locator("#uploadTitle").isDisabled(), true);
    assert.equal(
      await fixture.page.locator("#preparationControls").isVisible(),
      true,
    );
    await fixture.page.evaluate(() =>
      document.querySelector("#uploadButton").dispatchEvent(new Event("click")),
    );
    assert.equal((await fixture.commands()).length, 2);
    assert.equal(
      await fixture.page.locator("#uploadButton").getAttribute("aria-busy"),
      "false",
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("retained publication intent blocks availability without altering the publication journal", async () => {
  const fixture = await createUploadFixture();
  try {
    await fixture.worker.evaluate(async () => {
      await CreatorUploadSessionStore.save({
        id: "prior-publication-run",
        launcher: "desktop",
        draft: { fullFilename: "benign-new-clip.mp4" },
        platforms: { onlyfans: { submitAttempted: true } },
      });
    });
    const before = await fixture.worker.evaluate(() =>
      CreatorUploadSessionStore.listPublication(),
    );
    const page = fixture.page;
    await page.locator("#uploadFullVideo").setInputFiles({
      name: "benign-new-clip.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("benign"),
    });
    await page.locator("#uploadDescription").fill("Unpublished verification.");
    await page.waitForFunction(() =>
      document
        .querySelector("#uploadError")
        .textContent.includes("publication attempt"),
    );
    assert.equal(await page.locator("#uploadButton").isDisabled(), true);
    assert.equal((await fixture.commands()).length, 0);
    assert.deepEqual(
      await fixture.worker.evaluate(() =>
        CreatorUploadSessionStore.listPublication(),
      ),
      before,
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("compact UI has one in-flow Upload rail, conditional media, no Step 4 and no overflow at 200%", async () => {
  const fixture = await createUploadFixture();
  const page = fixture.page;
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      await page.getByRole("button", { name: "Upload", exact: true }).count(),
      1,
    );
    assert.equal(await page.locator("#uploadButton").isDisabled(), true);
    assert.equal(
      await page
        .locator("#confirmation, #uploadSummary, #matchQuestion")
        .count(),
      0,
    );
    assert.doesNotMatch(
      await page.locator("#uploaderPanel").textContent(),
      /Step 4|Yes, upload now|after Yes|same Yes|confirm the plan/i,
    );
    await fixture.ready("A very long benign filename ".repeat(8) + ".mp4");
    assert.equal(await page.locator("#optionalMedia").isVisible(), false);
    assert.equal(await page.locator("#pornhubPresetFields").isVisible(), false);
    await page.locator("#targetManyvids").check();
    assert.equal(await page.locator("#optionalMedia").isVisible(), true);
    await page.locator("#optionalMedia > summary").click();
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-choose-file="uploadManyvidsThumbnail"]').click();
    await (
      await chooser
    ).setFiles({
      name: "benign-thumbnail.png",
      mimeType: "image/png",
      buffer: Buffer.from("fixture"),
    });
    await page.locator("#targetManyvids").uncheck();
    assert.equal(
      await page.locator('[data-media-for="manyvids"]').isVisible(),
      true,
    );
    assert.equal(
      await page
        .locator('[data-media-for="manyvids"]')
        .getAttribute("data-inactive"),
      "true",
    );
    await page.locator('[data-remove-file="uploadManyvidsThumbnail"]').click();
    assert.equal(await page.locator("#optionalMedia").isVisible(), false);
    for (const [width, zoom] of [
      [1280, 1],
      [390, 1],
      [650, 2],
      [320, 1],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
        window.scrollTo(0, 0);
      }, zoom);
      const bounds = await page.evaluate(() => {
        const button = document
          .querySelector("#uploadButton")
          .getBoundingClientRect();
        const rail = document.querySelector("#uploadActions");
        return {
          overflow:
            document.documentElement.scrollWidth > window.innerWidth + 1,
          left: button.left,
          right: button.right,
          top: button.top,
          bottom: button.bottom,
          width: window.innerWidth,
          height: window.innerHeight,
          position: getComputedStyle(rail).position,
        };
      });
      assert.equal(
        bounds.overflow,
        false,
        JSON.stringify({ width, zoom, bounds }),
      );
      assert.ok(
        bounds.left >= 0 &&
          bounds.right <= bounds.width + 1 &&
          bounds.top >= 0 &&
          bounds.bottom <= bounds.height + 1,
        JSON.stringify({ width, zoom, bounds }),
      );
      assert.equal(bounds.position, "sticky");
      await page.evaluate(() => window.scrollTo(0, 10000000));
      await page.waitForTimeout(40);
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector("#uploadContent").getBoundingClientRect()
              .bottom <=
            document.querySelector("#uploadActions").getBoundingClientRect()
              .top +
              1,
        ),
        true,
      );
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
    });
    await page.locator("#uploadButton").focus();
    assert.equal(
      await page
        .locator("#uploadButton")
        .evaluate((button) => button === document.activeElement),
      true,
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("a rejected session binding stops busy feedback without releasing an accepted run", async () => {
  const fixture = await createUploadFixture();
  try {
    await fixture.ready();
    await fixture.page.locator("#uploadButton").click();
    await fixture.page.waitForFunction(() =>
      document
        .querySelector("#matchStatus")
        .textContent.includes("Run accepted"),
    );
    const [prepare] = await fixture.commands();
    await fixture.worker.evaluate(
      (sessionId) =>
        creatorUploadPost(sessionId, {
          type: "session-restore-rejected",
          error: "The approved files no longer match the stored session.",
        }),
      prepare.request.sessionId,
    );
    await fixture.page.waitForFunction(() =>
      document
        .querySelector("#uploadError")
        .textContent.includes("no longer match"),
    );
    assert.equal(
      await fixture.page.locator("#uploadButton").getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      await fixture.page.locator("#uploadButton").isDisabled(),
      true,
    );
    assert.equal(await fixture.page.locator("#uploadTitle").isDisabled(), true);
    assert.equal(
      await fixture.page.locator("#reviewRecovery").isVisible(),
      true,
    );
    assert.equal((await fixture.commands()).length, 2);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("desktop disconnection before dispatch keeps the draft and permits retry only after reconnecting", async () => {
  const fixture = await createUploadFixture({ desktop: true });
  try {
    await fixture.ready();
    await fixture.page.evaluate(() => {
      globalThis.fixtureOffline = true;
    });
    await fixture.page.locator("#uploadButton").click();
    await fixture.page.waitForFunction(
      () =>
        !document.querySelector("#refreshReadiness").hidden &&
        document.querySelector("#uploadError").textContent.length > 0,
    );
    assert.equal((await fixture.commands()).length, 0);
    assert.equal(
      await fixture.page.locator("#uploadButton").isDisabled(),
      true,
    );
    assert.equal(
      await fixture.page.locator("#uploadTitle").inputValue(),
      "Benign upload verification",
    );
    assert.equal(
      await fixture.page
        .locator("#uploadFullVideo")
        .evaluate((input) => input.files[0].name),
      "benign-new-clip.mp4",
    );
    assert.equal(
      await fixture.page.locator("#preparationControls").isVisible(),
      false,
    );
    await fixture.page.evaluate(() => {
      globalThis.fixtureOffline = false;
    });
    await fixture.page.locator("#refreshReadiness").click();
    await fixture.page.waitForFunction(
      () => !document.querySelector("#uploadButton").disabled,
    );
    await fixture.page.locator("#uploadButton").click();
    await fixture.page.waitForFunction(() =>
      document
        .querySelector("#matchStatus")
        .textContent.includes("Run accepted"),
    );
    assert.deepEqual(
      (await fixture.commands()).map((command) => command.type),
      ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"],
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});
