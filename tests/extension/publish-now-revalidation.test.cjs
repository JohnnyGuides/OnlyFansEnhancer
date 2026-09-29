"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

const onlyFansPage = `
  <form id="composer">
    <button id="attach_file_photo" aria-label="Add media" type="button"></button>
    <input id="file_upload_input" type="file" accept="video/*">
    <div class="tiptap ProseMirror b-text-editor js-text-editor" role="textbox" contenteditable="true"></div>
    <input id="post-label-1" type="checkbox" checked>
    <input id="post-label-2" type="checkbox">
    <span class="b-post-labels" aria-checked="false">Tag</span>
    <button id="save" type="button">Save</button>
  </form>
  <script>
    globalThis.saveClicks = 0;
    globalThis.deliveries = [];
    document.querySelector("#composer").addEventListener("click", (event) => {
      if (event.target.matches("button") && event.target.textContent === "Save")
        globalThis.saveClicks += 1;
    });
    globalThis.onAttach = () => {
      const media = document.createElement("div");
      media.className = "b-dropzone__preview";
      const state = document.createElement("span");
      state.textContent = globalThis.processingMs ? "Uploading 40%" : "Ready";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "b-dropzone__preview__delete";
      remove.textContent = "Delete";
      media.append(state, remove);
      document.querySelector("#composer").append(media);
      if (globalThis.processingMs && globalThis.processingMs !== Infinity)
        setTimeout(() => (state.textContent = "Ready"), globalThis.processingMs);
      if (globalThis.attachMutation) globalThis.attachMutation();
    };
  </script>`;

async function onlyFansRun(page, { mutate, ...options }) {
  await page.setContent(onlyFansPage);
  await page.addScriptTag({
    path: path.join(repositoryRoot, "workflows/upload-platform-adapters.js"),
  });
  await page.evaluate((options) => {
    globalThis.processingMs = options.processingMs || 0;
    if (options.attachMutation)
      globalThis.attachMutation = new Function(options.attachMutation);
    globalThis.armed = false;
    globalThis.armCalls = 0;
    globalThis.gate = new Promise((resolve) => (globalThis.release = resolve));
    if (options.during)
      setTimeout(new Function(options.during), options.duringMs || 150);
    if (options.afterControl) {
      // Runs once, when the publish-now control scan first finds its control
      // after the media preview exists.
      const form = document.querySelector("#composer");
      const scan = form.querySelectorAll.bind(form);
      let fired = false;
      form.querySelectorAll = (selector) => {
        const found = scan(selector);
        if (
          !fired &&
          selector === "button" &&
          scan(".b-dropzone__preview").length > 0 &&
          [...found].some((button) => button.id === "save")
        ) {
          fired = true;
          new Function(options.afterControl)();
        }
        return found;
      };
    }
  }, options);
  const running = page.evaluate(async (options) => {
    const controller = new AbortController();
    if (options.abortAfterMs)
      setTimeout(() => controller.abort(), options.abortAfterMs);
    try {
      const result = await CreatorUploadPlatformAdapters.runOnlyFans({
        draft: {
          publishMode: options.publishMode || "autonomous",
          scheduleIntent: options.scheduleIntent,
          mediaFiles: options.mediaFiles || [],
          description: "Approved description",
        },
        signal: controller.signal,
        async attachFile(role, selector) {
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          transfer.items.add(new File([role], role + ".mp4"));
          input.files = transfer.files;
          globalThis.deliveries.push(role);
          globalThis.onAttach();
        },
        async beforeCommit() {
          globalThis.armed = true;
          globalThis.armCalls += 1;
          if (options.gated) await globalThis.gate;
          return { armed: true };
        },
      });
      return { result, clicks: globalThis.saveClicks };
    } catch (error) {
      return {
        error: error.name + ": " + error.message,
        clicks: globalThis.saveClicks,
      };
    }
  }, options);
  if (options.gated) {
    await page.waitForFunction(() => globalThis.armed === true);
    await page.evaluate(mutate);
    await page.evaluate(() => globalThis.release());
  }
  const outcome = await running;
  outcome.deliveries = await page.evaluate(() => globalThis.deliveries);
  outcome.arms = await page.evaluate(() => globalThis.armCalls);
  return outcome;
}

async function withPage(callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    await callback(await browser.newPage());
  } finally {
    await browser.close();
  }
}

for (const scheduleIntent of ["none", "now"]) {
  test(`OnlyFans ${scheduleIntent} waits for a delayed processing indicator to clear`, async () => {
    await withPage(async (page) => {
      const outcome = await onlyFansRun(page, {
        scheduleIntent,
        processingMs: 400,
        mediaFiles: [{ role: "media1", name: "b.mp4", kind: "video" }],
      });
      assert.equal(outcome.error, undefined);
      assert.deepEqual(outcome.deliveries, ["full", "media1"]);
      assert.equal(
        outcome.result.status,
        scheduleIntent === "now" ? "submitted" : "manual-submit-required",
      );
      assert.equal(outcome.clicks, scheduleIntent === "now" ? 1 : 0);
    });
  });

  for (const [kind, attachMutation] of [
    [
      "checked state",
      "document.querySelector('#post-label-2').checked = true;",
    ],
    ["text", "document.querySelector('.b-post-labels').textContent = 'Other';"],
  ]) {
    test(`OnlyFans ${scheduleIntent} rejects a label ${kind} change with the count unchanged`, async () => {
      await withPage(async (page) => {
        const outcome = await onlyFansRun(page, {
          scheduleIntent,
          attachMutation,
        });
        assert.match(outcome.error, /labels/i);
        assert.equal(outcome.clicks, 0);
      });
    });
  }
}

test("OnlyFans none aborts while processing never clears and clicks nothing", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "none",
      processingMs: Infinity,
      abortAfterMs: 600,
    });
    assert.match(outcome.error, /^AbortError/);
    assert.equal(outcome.clicks, 0);
  });
});

test("OnlyFans none in manual mode never clicks a final control after delayed processing", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      publishMode: "manual",
      scheduleIntent: "none",
      processingMs: 400,
    });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.result.status, "manual-submit-required");
    assert.equal(outcome.clicks, 0);
  });
});

for (const [name, mutate] of [
  [
    "caption edited",
    () => {
      document.querySelector("[role='textbox']").textContent = "Edited";
    },
  ],
  [
    "label changed",
    () => {
      document.querySelector("#post-label-2").checked = true;
    },
  ],
  [
    "composer replaced",
    () => {
      const editor = document.querySelector("[role='textbox']");
      editor.replaceWith(editor.cloneNode(true));
    },
  ],
]) {
  test(`OnlyFans now rejects after arming when the ${name}`, async () => {
    await withPage(async (page) => {
      const outcome = await onlyFansRun(page, {
        scheduleIntent: "now",
        gated: true,
        mutate,
      });
      assert.ok(outcome.error, "run must reject");
      assert.equal(outcome.clicks, 0);
    });
  });
}

test("OnlyFans now refuses before arming when media returns to processing after the control is found", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "now",
      afterControl:
        "document.querySelector('.b-dropzone__preview span').textContent = 'Processing 60%';",
    });
    assert.ok(outcome.error, "run must reject");
    assert.equal(outcome.arms, 0);
    assert.equal(outcome.clicks, 0);
  });
});

test("OnlyFans now clicks the current Post button when it was replaced and nothing else changed", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "now",
      gated: true,
      mutate: () => {
        const save = document.querySelector("#save");
        save.replaceWith(save.cloneNode(true));
      },
    });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.result.status, "submitted");
    assert.equal(outcome.clicks, 1);
  });
});

async function fanslyRun(page, mutate) {
  await page.setContent(`
    <app-post-creation>
      <div class="default-dropdown">
        <div class="dropdown-title">Media</div>
        <div class="dropdown-item">Upload New</div>
      </div>
      <input id="fansly-file" type="file" accept="video/*">
      <div id="media"></div>
      <textarea></textarea>
      <div class="icon-stack"><i class="fa-clock"></i><i class="fa-calendar"></i></div>
      <div class="btn new-post-btn solid-blue">Post</div>
    </app-post-creation>
    <div id="preset-menu" hidden><div class="dropdown-item">defaulT</div></div>
    <script>
      document.querySelector(".default-dropdown .dropdown-item").addEventListener("click", () => document.querySelector("#fansly-file").click());
      globalThis.postClicks = 0;
      document.querySelector("#fansly-file").addEventListener("change", () => {
        const card = document.createElement("app-account-media-template");
        card.dataset.locked = "false";
        card.innerHTML = '<div class="locked-text-container">Access</div>';
        card.querySelector(".locked-text-container").addEventListener("click", () => document.querySelector("#preset-menu").hidden = false);
        document.querySelector("#media").append(card);
      });
      document.querySelector("#preset-menu .dropdown-item").addEventListener("click", () => {
        const card = document.querySelector("app-account-media-template");
        card.dataset.locked = "true";
        card.dataset.preset = "defaulT";
        card.querySelector(".locked-text-container").textContent = "defaulT";
        document.querySelector("#preset-menu").hidden = true;
      });
      document.querySelector(".new-post-btn").addEventListener("click", () => globalThis.postClicks += 1);
    </script>`);
  await page.evaluate(() => {
    globalThis.CreatorToolkitMasterRun = true;
    globalThis.armed = false;
    globalThis.gate = new Promise((resolve) => (globalThis.release = resolve));
  });
  for (const relativePath of [
    "workflows/registry.js",
    "workflows/common.js",
    "workflows/fansly-prefill.js",
    "workflows/upload-platform-adapters.js",
  ])
    await page.addScriptTag({ path: path.join(repositoryRoot, relativePath) });
  const running = page.evaluate(async () => {
    try {
      const result = await CreatorUploadPlatformAdapters.runFansly({
        draft: {
          publishMode: "autonomous",
          scheduleIntent: "now",
          hasTeaser: false,
          fanslyPreset: "defaulT",
          fanslyCaption: "Fansly caption",
          profiles: {
            fanslyPrefill: { message: "", fillMode: "replace", toggles: {} },
          },
        },
        async attachFile(role, selector) {
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          transfer.items.add(new File([role], role + ".mp4"));
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        async beforeCommit() {
          globalThis.armed = true;
          await globalThis.gate;
          return { armed: true };
        },
      });
      return { result, clicks: globalThis.postClicks };
    } catch (error) {
      return { error: error.message, clicks: globalThis.postClicks };
    }
  });
  await page.waitForFunction(() => globalThis.armed === true);
  await page.evaluate(mutate);
  await page.evaluate(() => globalThis.release());
  return running;
}

for (const [name, mutate] of [
  [
    "caption edited",
    () => {
      document.querySelector("textarea").value = "Edited";
    },
  ],
  [
    "composer replaced",
    () => {
      const second = document.createElement("app-post-creation");
      second.textContent = "Second composer";
      document.body.append(second);
    },
  ],
]) {
  test(`Fansly now rejects after arming when the ${name}`, async () => {
    await withPage(async (page) => {
      const outcome = await fanslyRun(page, mutate);
      assert.ok(outcome.error, "run must reject");
      assert.equal(outcome.clicks, 0);
    });
  });
}

test("Fansly now clicks Post once when nothing changed after arming", async () => {
  await withPage(async (page) => {
    const outcome = await fanslyRun(page, () => {});
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.result.status, "submitted");
    assert.equal(outcome.clicks, 1);
  });
});

const EDITOR = "document.querySelector(\"[role='textbox']\")";
const MOVE_EDITOR_TO_NEW_FORM = `
  const editor = ${EDITOR};
  const other = document.createElement("form");
  other.id = "composer2";
  document.body.append(other);
  other.append(editor);`;
const ALERT = `
  const alert = document.createElement("div");
  alert.setAttribute("role", "alert");
  alert.textContent = "Something is wrong";
  document.querySelector("#composer").append(alert);`;
const SCHEDULE_CHIP = `
  const chip = document.createElement("div");
  chip.className = "b-dropzone__preview m-schedule";
  chip.textContent = "Scheduled";
  document.querySelector("#composer").append(chip);`;

test("OnlyFans none rejects and returns no prepared result when the caption is edited during the readiness wait", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "none",
      processingMs: 400,
      during: `${EDITOR}.textContent = "Edited";`,
    });
    assert.ok(outcome.error, "run must reject");
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.clicks, 0);
  });
});

test("OnlyFans none rejects when a schedule chip appears during the readiness wait", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "none",
      processingMs: 400,
      during: SCHEDULE_CHIP,
    });
    assert.match(outcome.error, /schedule/i);
    assert.equal(outcome.result, undefined);
  });
});

for (const [name, during] of [
  ["caption edited", `${EDITOR}.textContent = "Edited";`],
  ["schedule chip shown", SCHEDULE_CHIP],
  ["blocking error shown", ALERT],
]) {
  test(`OnlyFans now rejects before the durable arm when the ${name} during the readiness wait`, async () => {
    await withPage(async (page) => {
      const outcome = await onlyFansRun(page, {
        scheduleIntent: "now",
        processingMs: 400,
        during,
      });
      assert.ok(outcome.error, "run must reject");
      assert.equal(outcome.arms, 0);
      assert.equal(outcome.clicks, 0);
    });
  });
}

test("OnlyFans none rejects when the composer is replaced during the readiness wait", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "none",
      processingMs: 400,
      during: MOVE_EDITOR_TO_NEW_FORM,
    });
    assert.match(outcome.error, /ownership/i);
    assert.equal(outcome.result, undefined);
  });
});

test("OnlyFans now rejects after arming when the composer is replaced but the old editor stays connected", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "now",
      gated: true,
      mutate: new Function(MOVE_EDITOR_TO_NEW_FORM),
    });
    assert.match(outcome.error, /ownership/i);
    assert.equal(outcome.clicks, 0);
  });
});

test("OnlyFans now rejects after arming when a blocking error appears", async () => {
  await withPage(async (page) => {
    const outcome = await onlyFansRun(page, {
      scheduleIntent: "now",
      gated: true,
      mutate: new Function(ALERT),
    });
    assert.match(outcome.error, /validation error/i);
    assert.equal(outcome.clicks, 0);
  });
});

test("Fansly now rejects after arming when a blocking error appears", async () => {
  await withPage(async (page) => {
    const outcome = await fanslyRun(page, () => {
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = "Something is wrong";
      document.querySelector("app-post-creation").append(alert);
    });
    assert.match(outcome.error, /validation error/i);
    assert.equal(outcome.clicks, 0);
  });
});
