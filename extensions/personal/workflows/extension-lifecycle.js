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
          [KEY]: { id: crypto.randomUUID(), installedAt: Date.now() },
        });
      })();
      return installing;
    }
    chrome.runtime.onInstalled?.addListener(installed);
    async function getInstallation() {
      if (installing) await installing;
      const value = (await chrome.storage.local.get(KEY))[KEY];
      return value &&
        UUID.test(value.id || "") &&
        Number.isSafeInteger(value.installedAt) &&
        value.installedAt > 0
        ? { id: value.id, installedAt: value.installedAt }
        : null;
    }
    async function uninstall() {
      if (typeof chrome.management?.uninstallSelf !== "function")
        throw new Error(REMOVE);
      for (const area of ["local", "session", "sync"]) {
        if (!chrome.storage[area]?.clear) continue;
        try {
          await chrome.storage[area].clear();
        } catch {
          throw new Error(
            `Extension storage was partially cleared (${area} failed). ${REMOVE}`,
          );
        }
      }
      try {
        await chrome.management.uninstallSelf({ showConfirmDialog: false });
      } catch {
        throw new Error(`Chrome refused self-removal. ${REMOVE}`);
      }
    }
    return Object.freeze({ getInstallation, uninstall });
  }
  globalThis.CreatorExtensionLifecycle = Object.freeze({ create });
})();
