(() => {
  "use strict";
  const HOST = "com.johnnyguides.ofenhancer";
  const UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  let port;
  let timer;
  let requestId;
  let connectionId;
  let browserId;
  const uninstalled = new Set();

  chrome.management.onUninstalled.addListener((id) => {
    if (/^[a-p]{32}$/.test(id)) uninstalled.add(id);
  });

  async function identities() {
    const stored = await chrome.storage.session.get("verifierBrowserId");
    browserId = UUID.test(stored.verifierBrowserId || "")
      ? stored.verifierBrowserId
      : crypto.randomUUID();
    await chrome.storage.session.set({ verifierBrowserId: browserId });
    connectionId ||= crypto.randomUUID();
  }

  async function exchange() {
    if (!port) return;
    await identities();
    const installed = (await chrome.management.getAll())
      .filter((item) => /^[a-p]{32}$/.test(item.id))
      .slice(0, 128)
      .map((item) => ({ id: item.id, enabled: item.enabled === true }));
    requestId = crypto.randomUUID();
    port.postMessage({
      protocolVersion: 1,
      requestId,
      operation: "browserExchange",
      payload: {
        browserId,
        connectionId,
        extensionId: chrome.runtime.id,
        maintenanceVerifier: {
          installed,
          uninstalled: [...uninstalled].slice(0, 128),
        },
      },
    });
  }

  function connect() {
    if (port) return;
    port = chrome.runtime.connectNative(HOST);
    port.onMessage.addListener((response) => {
      if (response?.requestId !== requestId || response.ok !== true) return;
      clearTimeout(timer);
      if (response.result?.removalVerified === true) {
        void chrome.management.uninstallSelf({ showConfirmDialog: false });
        return;
      }
      timer = setTimeout(() => void exchange(), 500);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      clearTimeout(timer);
      timer = setTimeout(connect, 2000);
    });
    void exchange();
  }

  connect();
})();
