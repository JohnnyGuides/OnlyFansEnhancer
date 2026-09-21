(() => {
  "use strict";
  const KEY = "ofenhancerInstallationV1";
  const UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const REMOVE =
    "Remove Creator Workflow Toolkit in chrome://extensions, then load the OFEnhancer extension folder again.";

  function create({ chrome }) {
    let installing = null;
    async function clearOwnedStorage() {
      // These API objects are scoped by Chrome to this extension. No profile,
      // website, desktop catalogue or other extension data is accessible here.
      for (const area of ["local", "session", "sync"])
        if (chrome.storage[area]?.clear) await chrome.storage[area].clear();
    }
    function installed(details) {
      // Chrome reports unpacked reloads as "update", not "install". Never
      // manufacture a receipt during startup, update, reload or storage repair.
      if (details.reason !== "install") return;
      installing = (async () => {
        await clearOwnedStorage();
        await chrome.storage.local.set({
          [KEY]: {
            id: crypto.randomUUID(),
            installedAt: Date.now(),
            status: "initializing",
          },
        });
      })();
      return installing;
    }
    chrome.runtime.onInstalled?.addListener(installed);
    async function getInstallation() {
      if (installing) await installing;
      const value = (await chrome.storage.local.get(KEY))[KEY];
      return value &&
        value.status === "ready" &&
        UUID.test(value.id || "") &&
        Number.isSafeInteger(value.installedAt) &&
        value.installedAt > 0
        ? { id: value.id, installedAt: value.installedAt }
        : null;
    }
    async function needsInitialization() {
      if (installing) await installing;
      const value = (await chrome.storage.local.get(KEY))[KEY];
      return Boolean(
        value &&
        value.status === "initializing" &&
        UUID.test(value.id || "") &&
        Number.isSafeInteger(value.installedAt) &&
        value.installedAt > 0,
      );
    }
    async function completeInstallation() {
      if (installing) await installing;
      const value = (await chrome.storage.local.get(KEY))[KEY];
      if (
        !value ||
        value.status !== "initializing" ||
        !UUID.test(value.id || "")
      )
        return false;
      await chrome.storage.local.set({ [KEY]: { ...value, status: "ready" } });
      const confirmed = (await chrome.storage.local.get(KEY))[KEY];
      if (confirmed?.status !== "ready" || confirmed.id !== value.id)
        throw new Error("Installation initialization was not durable.");
      return true;
    }
    async function uninstall() {
      if (typeof chrome.management?.uninstallSelf !== "function")
        throw new Error(REMOVE);
      try {
        await chrome.management.uninstallSelf({ showConfirmDialog: false });
      } catch {
        throw new Error(`Chrome refused self-removal. ${REMOVE}`);
      }
    }
    return Object.freeze({
      getInstallation,
      needsInitialization,
      completeInstallation,
      uninstall,
    });
  }
  globalThis.CreatorExtensionLifecycle = Object.freeze({ create });
})();
