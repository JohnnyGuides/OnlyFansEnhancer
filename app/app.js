(function startOFEnhancerApp(global) {
  "use strict";

  const buttons = Array.from(document.querySelectorAll("[data-view]"));
  const panels = Array.from(document.querySelectorAll("[data-panel]"));
  const connectionLabel = document.querySelector("#connectionLabel");
  const versionLabel = document.querySelector("#versionLabel");
  const agentSetting = document.querySelector("#agentSetting");
  const openUploader = document.querySelector("#openUploader");
  const actionStatus = document.querySelector("#actionStatus");

  function showView(name) {
    for (const button of buttons) {
      const current = button.dataset.view === name;
      if (current) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    document.querySelector(`[data-panel="${name}"] h1`)?.focus?.();
  }

  for (const button of buttons) {
    button.addEventListener("click", () => showView(button.dataset.view));
  }

  openUploader.addEventListener("click", async () => {
    openUploader.disabled = true;
    actionStatus.textContent = "Opening Chrome…";
    try {
      await global.OFEnhancerHost.request("openChromeUploader");
      actionStatus.textContent = "Chrome uploader opened.";
    } catch (error) {
      actionStatus.textContent =
        error.message === "extension-not-configured"
          ? "Connect the Chrome extension in Settings first."
          : "Chrome could not open the uploader.";
    } finally {
      openUploader.disabled = false;
    }
  });

  global.OFEnhancerHost.request("getStatus")
    .then((status) => {
      document.body.dataset.connected = "true";
      connectionLabel.textContent = "Connected";
      versionLabel.textContent = `v${status.productVersion}`;
      agentSetting.textContent = `Connected · protocol ${status.protocolVersion}`;
    })
    .catch(() => {
      document.body.dataset.connected = "false";
      connectionLabel.textContent = "Desktop agent unavailable";
      versionLabel.textContent = "Offline";
      agentSetting.textContent = "Not connected";
      openUploader.disabled = true;
      actionStatus.textContent = "Restart OFEnhancer to reconnect.";
    });
})(globalThis);
