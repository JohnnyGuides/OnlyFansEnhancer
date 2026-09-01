"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");

async function loadRuntime(page, initialStorage = {}) {
  await page.addInitScript((stored) => {
    const data = structuredClone(stored);
    const listeners = new Set();
    globalThis.__toolkitTestStorage = data;
    globalThis.__toolkitStorageListeners = listeners;
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(data, key)) {
                result[key] = structuredClone(data[key]);
              }
            }
            queueMicrotask(() => callback(result));
          },
          set(values, callback) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = {
                oldValue: data[key],
                newValue: structuredClone(value),
              };
              data[key] = structuredClone(value);
            }
            queueMicrotask(() => {
              for (const listener of listeners) listener(changes, "local");
              callback?.();
            });
          },
        },
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          },
        },
      },
    };
  }, initialStorage);
  await page.route("https://runtime.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<main><button>Exact</button><button>Other</button></main>",
    }),
  );
  await page.goto("https://runtime.test/inactive");
  await page.addScriptTag({
    path: path.join(repositoryRoot, "creator-tools", "registry.js"),
  });
  await page.addScriptTag({
    path: path.join(repositoryRoot, "creator-tools", "common.js"),
  });
}

test("shared runtime fails closed, disposes on settings changes, and aborts pending mutations", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRuntime(page);

    const initial = await page.evaluate(async () => {
      const toolkit = CreatorToolkit;
      const defaults = await toolkit.loadSettings();
      const exact = toolkit.resolveExact(
        Array.from(document.querySelectorAll("button")),
        " exact ",
      );
      const missing = toolkit.resolveExact(
        Array.from(document.querySelectorAll("button")),
        "missing",
      );
      let ambiguousCode = "";
      const duplicate = document.createElement("button");
      duplicate.textContent = "Exact";
      document.body.appendChild(duplicate);
      try {
        toolkit.requireExact(
          Array.from(document.querySelectorAll("button")),
          "Exact",
        );
      } catch (error) {
        ambiguousCode = error.code;
      }
      return {
        c4sEnabled: defaults.tools.c4sUpload.enabled,
        exactStatus: exact.status,
        missingStatus: missing.status,
        ambiguousCode,
      };
    });
    assert.deepEqual(initial, {
      c4sEnabled: true,
      exactStatus: "found",
      missingStatus: "missing",
      ambiguousCode: "AMBIGUOUS_TARGET",
    });

    const lifecycle = await page.evaluate(async () => {
      globalThis.__lifecycleEvents = [];
      CreatorToolkit.mountTool({
        id: "c4sUpload",
        match: (location) => location.pathname === "/active",
        mount({ signal }) {
          __lifecycleEvents.push("mounted");
          signal.addEventListener("abort", () =>
            __lifecycleEvents.push("aborted"),
          );
          return () => __lifecycleEvents.push("disposed");
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const beforeEnable = [...__lifecycleEvents];

      const settings = await CreatorToolkit.loadSettings();
      settings.tools.c4sUpload.enabled = true;
      await CreatorToolkit.saveSettings(settings);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const enabledOffRoute = [...__lifecycleEvents];

      history.pushState({}, "", "/active");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterRouteEntry = [...__lifecycleEvents];

      settings.tools.c4sUpload.enabled = false;
      await CreatorToolkit.saveSettings(settings);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterDisable = [...__lifecycleEvents];

      settings.tools.c4sUpload.enabled = true;
      await CreatorToolkit.saveSettings(settings);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterReenable = [...__lifecycleEvents];

      history.pushState({}, "", "/inactive");
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        beforeEnable,
        enabledOffRoute,
        afterRouteEntry,
        afterDisable,
        afterReenable,
        afterRouteExit: [...__lifecycleEvents],
      };
    });
    assert.deepEqual(lifecycle.beforeEnable, []);
    assert.deepEqual(lifecycle.enabledOffRoute, []);
    assert.deepEqual(lifecycle.afterRouteEntry, ["mounted"]);
    assert.deepEqual(lifecycle.afterDisable, [
      "mounted",
      "aborted",
      "disposed",
    ]);
    assert.deepEqual(lifecycle.afterReenable, [
      "mounted",
      "aborted",
      "disposed",
      "mounted",
    ]);
    assert.deepEqual(lifecycle.afterRouteExit, [
      "mounted",
      "aborted",
      "disposed",
      "mounted",
      "aborted",
      "disposed",
    ]);

    const stopped = await page.evaluate(async () => {
      const panel = CreatorToolkit.createToolPanel({
        id: "runtime-test",
        title: "Runtime test",
      });
      const lifecycleController = new AbortController();
      const runner = CreatorToolkit.createActionRunner({
        toolId: "c4sUpload",
        panel,
        lifecycleSignal: lifecycleController.signal,
        maxActions: 1,
        maxDurationMs: 5000,
      });
      let mutated = false;
      const running = runner.run("Waiting", async ({ signal, budget }) => {
        await CreatorToolkit.sleep(1000, signal);
        budget.step();
        mutated = true;
        return { status: "success", summary: "mutated", items: [] };
      });
      setTimeout(() => runner.stop("test stop"), 40);
      const result = await running;
      panel.destroy();
      return {
        status: result.status,
        mutated,
        logged:
          __toolkitTestStorage.creatorToolkitActionLogV1?.[0]?.status || "",
      };
    });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.mutated, false);
    assert.equal(stopped.logged, "stopped");
  } finally {
    await browser.close();
  }
});

test("loading schema 2 settings persists the one-time all-helper activation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loadRuntime(page, {
      creatorToolkitV2: {
        schemaVersion: 2,
        tools: {
          c4sUpload: { enabled: false, autorun: false },
          uploadTraceRecorder: { enabled: false, autorun: false },
        },
        profiles: { fanslyPrefill: { message: "preserve this" } },
      },
    });

    const result = await page.evaluate(async () => {
      const settings = await CreatorToolkit.loadSettings();
      return {
        loaded: settings,
        stored: __toolkitTestStorage.creatorToolkitV2,
      };
    });

    assert.equal(result.loaded.schemaVersion, 3);
    assert.equal(result.loaded.tools.c4sUpload.enabled, true);
    assert.equal(result.loaded.tools.uploadTraceRecorder.enabled, true);
    assert.equal(result.loaded.profiles.fanslyPrefill.message, "preserve this");
    assert.deepEqual(result.stored, result.loaded);
  } finally {
    await browser.close();
  }
});
