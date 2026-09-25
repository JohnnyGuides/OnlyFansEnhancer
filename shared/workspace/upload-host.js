(() => {
  "use strict";
  const webview = globalThis.chrome?.webview;
  if (!webview) return;
  const pending = new Map();
  const ports = new Map();
  let browserStatus = null;
  let refreshing = null;
  let statusView = null;
  let statusPoll;
  let liveExpiry;
  let readiness;
  let observationGeneration = 0;
  const stagedGeneratedMedia = new Map();
  async function stageGeneratedMedia(file, sessionId, role) {
    const key = `${sessionId}/${role}`;
    if (stagedGeneratedMedia.has(key)) return stagedGeneratedMedia.get(key);
    const staging = (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const chunkSize = 256 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const part = bytes.subarray(
          offset,
          Math.min(offset + chunkSize, bytes.length),
        );
        let raw = "";
        for (let index = 0; index < part.length; index += 8192)
          raw += String.fromCharCode(...part.subarray(index, index + 8192));
        const final = offset + part.length === bytes.length;
        const response = await call("stageGeneratedMediaChunk", {
          sessionId,
          role,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          sha256,
          offset,
          final,
          chunk: btoa(raw),
        });
        if (Boolean(response.staged) !== final)
          throw new Error("Generated media staging did not complete.");
      }
    })();
    stagedGeneratedMedia.set(key, staging);
    try {
      await staging;
    } catch (error) {
      stagedGeneratedMedia.delete(key);
      throw error;
    }
  }
  function call(operation, payload = {}, files) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(
        () => {
          pending.delete(requestId);
          reject(
            new Error(
              "The desktop upload request timed out. Review progress before retrying.",
            ),
          );
        },
        [
          "browserRequest",
          "deliverUploadFile",
          "deliverGeneratedMedia",
          "deliverDevelopmentFixture",
          "deliverCatalogueThumbnail",
        ].includes(operation)
          ? 2 * 60 * 60_000
          : 30_000,
      );
      pending.set(requestId, { resolve, reject, timeout, operation });
      const message = JSON.stringify({ requestId, operation, payload });
      try {
        if (files) webview.postMessageWithAdditionalObjects(message, files);
        else webview.postMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  function event() {
    const listeners = new Set();
    return {
      addListener: (value) => listeners.add(value),
      removeListener: (value) => listeners.delete(value),
      emit: (...args) => {
        for (const fn of listeners) fn(...args);
      },
    };
  }
  const storageChanged = event();
  function closePort(portId, reason) {
    const port = ports.get(portId);
    if (!port) return;
    ports.delete(portId);
    withLastError(reason, () => port.onDisconnect.emit());
  }
  function connectionLost(reason) {
    browserStatus = null;
    for (const [id, item] of pending) {
      if (
        !new Set([
          "browserRequest",
          "deliverUploadFile",
          "deliverGeneratedMedia",
          "deliverDevelopmentFixture",
          "deliverCatalogueThumbnail",
        ]).has(item.operation)
      )
        continue;
      clearTimeout(item.timeout);
      pending.delete(id);
      item.reject(new Error(reason));
    }
    for (const portId of [...ports.keys()]) closePort(portId, reason);
    if (statusView) statusView.message.textContent = reason;
  }
  webview.addEventListener("message", ({ data }) => {
    let value;
    try {
      value = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      connectionLost("The desktop returned an invalid upload response.");
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.uploadEvent) {
      const item = value.uploadEvent;
      if (item.uploadConnectionLost) connectionLost(item.uploadConnectionLost);
      else if (item.disconnected)
        closePort(
          item.portId,
          item.error || "The browser upload port disconnected.",
        );
      else if (item.storageChanges)
        storageChanged.emit(item.storageChanges, "local");
      else ports.get(item.portId)?.onMessage.emit(item.message);
      return;
    }
    const waiting = pending.get(value.requestId);
    if (!waiting) return;
    pending.delete(value.requestId);
    clearTimeout(waiting.timeout);
    if (value.ok) waiting.resolve(value.result);
    else
      waiting.reject(new Error(value.error?.code || "Desktop request failed."));
  });
  async function refreshBrowsers() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const started = Date.now();
      let next = await call("getUploadBrowsers");
      if (Number.isFinite(next.expiresInMilliseconds)) {
        next.expiresInMilliseconds = Math.max(
          0,
          next.expiresInMilliseconds - (Date.now() - started),
        );
        if (!next.expiresInMilliseconds)
          next = { ...next, browsers: [], connected: false };
      }
      if (
        browserStatus?.connected &&
        (!next.connected || next.selected !== browserStatus.selected)
      )
        connectionLost(
          "The selected browser disconnected or changed. Review upload progress before continuing.",
        );
      browserStatus = next;
      clearTimeout(liveExpiry);
      if (Number.isFinite(next.expiresInMilliseconds) && next.browsers?.length)
        liveExpiry = setTimeout(
          () => {
            connectionLost(
              "Chrome not connected. Fresh browser evidence expired; review progress before retrying.",
            );
          },
          Math.max(0, next.expiresInMilliseconds),
        );
      renderStatus();
      return next;
    })()
      .catch((error) => {
        connectionLost(error.message);
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  async function ensureBrowser() {
    await refreshBrowsers();
    if (browserStatus?.updateRequired)
      throw new Error(
        "Reload the existing OFEnhancer extension in chrome://extensions after reviewing existing uploads, then reopen this Upload Hub. The running extension does not match the installed desktop version.",
      );
    // Sole-browser selection belongs to a requested operation, never an observation.
    if (
      !browserStatus?.connected &&
      browserStatus?.browsers?.length === 1 &&
      !browserStatus.selectionRequired
    )
      browserStatus = await call("selectUploadBrowser", {
        browserId: browserStatus.browsers[0],
      });
    if (!browserStatus?.connected)
      throw new Error(
        "Chrome is unavailable or needs a browser selection. Check the connection, then retry deliberately.",
      );
  }
  const rpc = async (command) => {
    try {
      await ensureBrowser();
    } catch (error) {
      // No browserRequest was sent. Later transport failures remain uncertain.
      error.uploadAdmission = "not-started";
      throw error;
    }
    return call("browserRequest", command);
  };
  function withLastError(reason, callback) {
    if (reason)
      globalThis.chrome.runtime.lastError = {
        message: reason instanceof Error ? reason.message : String(reason),
        ...(reason?.uploadAdmission
          ? { uploadAdmission: reason.uploadAdmission }
          : {}),
      };
    try {
      return callback();
    } finally {
      delete globalThis.chrome.runtime.lastError;
    }
  }
  function callbackResult(result, callback) {
    if (typeof callback !== "function") return result;
    void result.then(
      (value) => callback(value),
      (error) => withLastError(error, () => callback(undefined)),
    );
    return undefined;
  }
  globalThis.chrome.runtime = {
    getURL: (path) => new URL(path, location.href).href,
    sendMessage(message, callback) {
      const result = rpc({ kind: "message", message });
      return callbackResult(result, callback);
    },
    connect({ name }) {
      if (name !== "creator-upload-console")
        throw new Error("Unsupported upload connection.");
      const portId = crypto.randomUUID();
      const port = {
        onMessage: event(),
        onDisconnect: event(),
        postMessage(message) {
          if (!ports.has(portId))
            throw new Error("The upload port disconnected.");
          void rpc({ kind: "port", portId, message }).catch((error) =>
            closePort(portId, error.message),
          );
        },
        disconnect() {
          closePort(portId);
          void rpc({ kind: "disconnect", portId }).catch(() => {});
        },
      };
      ports.set(portId, port);
      return port;
    },
  };
  globalThis.chrome.storage = {
    onChanged: storageChanged,
    local: {
      get(keys, callback) {
        return callbackResult(rpc({ kind: "storageGet", keys }), callback);
      },
      set(values, callback) {
        return callbackResult(rpc({ kind: "storageSet", values }), callback);
      },
    },
  };
  globalThis.chrome.permissions = {
    contains: (permissions, callback) =>
      callbackResult(
        rpc({ kind: "permissions", permissions }).then(
          (result) => result.granted,
        ),
        callback,
      ),
    request: async () => {
      throw new Error(
        "Open the browser uploader to enable an optional legacy bridge.",
      );
    },
  };
  globalThis.OFEnhancerDesktopUpload = Object.freeze({
    refreshBrowsers,
    loadDevelopmentFixtures: () => call("loadDevelopmentFixtures"),
    async deliverFile(session, request, file) {
      try {
        await ensureBrowser();
        if (file.source === "generated")
          await stageGeneratedMedia(file, request.sessionId, request.role);
        return await call(
          file.source === "catalogue-thumbnail"
            ? "deliverCatalogueThumbnail"
            : file.source === "development-fixture"
              ? "deliverDevelopmentFixture"
              : file.source === "generated"
                ? "deliverGeneratedMedia"
                : "deliverUploadFile",
          {
            requestId: request.requestId,
            sessionId: request.sessionId,
            platform: request.platform,
            role: request.role,
            token: request.token,
            ...(file.source === "catalogue-thumbnail"
              ? { catalogueId: file.catalogueId, assetId: file.assetId }
              : file.source === "development-fixture"
                ? { fixtureToken: file.fixtureToken }
                : {}),
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
          },
          file.source === "development-fixture" ||
            file.source === "catalogue-thumbnail" ||
            file.source === "generated"
            ? undefined
            : [file],
        );
      } catch (error) {
        try {
          session.port.postMessage({
            type: "file-response",
            requestId: request.requestId,
            ok: false,
            error: error.message,
          });
        } catch {
          /* The disconnected port has already rejected the file transfer. */
        }
        throw error;
      }
    },
  });

  function renderStatus() {
    if (!statusView || !browserStatus) return;
    const ids = browserStatus.browsers || [];
    const labels = {
      "not-found": "Chrome not found",
      setup: "Set up Chrome",
      repair: "Chrome setup needs repair",
      offline: "Chrome not connected",
      choose: "Choose Chrome browser",
      connected: "Chrome connected",
    };
    statusView.message.textContent = browserStatus.updateRequired
      ? "Chrome extension update required. Review existing uploads, reload the existing extension in chrome://extensions, then reopen the Upload Hub. Keep its settings and recovery data."
      : readiness?.state
        ? `${labels[readiness.state] || "Checking Chrome"}. ${readiness.message}`
        : browserStatus.connected
          ? "A browser exchange is live. Chrome setup diagnostics are unavailable."
          : ids.length
            ? "Choose the browser to use for uploads."
            : "Open Chrome with the OFEnhancer extension to connect uploads.";
    const connected =
      !browserStatus.updateRequired &&
      (readiness?.state === "connected" ||
        (!readiness && browserStatus.connected));
    if (connected) statusView.message.textContent = "Connected";
    statusView.panel.dataset.connected = String(connected);
    statusView.panel.setAttribute(
      "aria-label",
      connected ? "Chrome connected" : "Chrome connection",
    );
    statusView.setup.hidden = connected;
    statusView.refresh.hidden = connected;
    statusView.select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose browser";
    statusView.select.append(placeholder);
    for (const [index, id] of ids.entries()) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = `Browser ${index + 1} · ${id.slice(0, 8)}`;
      statusView.select.append(option);
    }
    statusView.select.value = browserStatus.selected || "";
    statusView.select.hidden =
      ids.length < 2 && !browserStatus.selectionRequired;
    statusView.label.hidden = statusView.select.hidden;
  }
  function mountStatus() {
    // Chrome-only settings are not a desktop route or a second permission surface.
    for (const element of document.querySelectorAll("[data-chrome-only]"))
      element.remove();
    for (const element of document.querySelectorAll("[data-desktop-only]"))
      element.hidden = false;
    const panel = document.createElement("section");
    panel.setAttribute("aria-label", "Browser connection");
    panel.className = "desktop-upload-connection";
    const back = document.createElement("a");
    back.href = "index.html";
    back.textContent = "Back to catalogue";
    back.hidden = true;
    const setup = document.createElement("a");
    setup.href = "index.html?chrome-setup=1";
    setup.textContent = "Check Chrome setup";
    const message = document.createElement("p");
    message.setAttribute("role", "status");
    message.textContent = "Connecting to Chrome…";
    message.className = "chrome-connection-state";
    const chromeMark = document.createElement("span");
    chromeMark.className = "chrome-brand-mark";
    chromeMark.setAttribute("aria-hidden", "true");
    const label = document.createElement("label");
    label.textContent = "Upload browser";
    label.htmlFor = "desktopUploadBrowser";
    const select = document.createElement("select");
    select.id = label.htmlFor;
    select.setAttribute("aria-label", "Upload browser");
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Check again";
    refresh.title =
      "Check which Chrome browser is selected and whether its extension is connected";
    panel.append(chromeMark, message, label, select, setup, refresh);
    const header =
      document.querySelector(".app-heading") ||
      document.querySelector(".app-header");
    if (header) header.append(panel);
    else (document.querySelector("main") || document.body).prepend(panel);
    statusView = { panel, message, label, select, setup, refresh };
    const update = () => {
      const generation = ++observationGeneration;
      void Promise.all([refreshBrowsers(), call("getChromeReadiness")])
        .then(([, value]) => {
          if (generation !== observationGeneration) return;
          readiness = value;
          renderStatus();
        })
        .catch((error) => {
          if (generation !== observationGeneration) return;
          readiness = null;
          connectionLost(error.message);
        });
    };
    refresh.addEventListener("click", update);
    select.addEventListener("change", async () => {
      if (!select.value) return;
      select.disabled = true;
      try {
        if (
          ports.size ||
          [...pending.values()].some((item) =>
            [
              "browserRequest",
              "deliverUploadFile",
              "deliverGeneratedMedia",
              "deliverDevelopmentFixture",
              "deliverCatalogueThumbnail",
            ].includes(item.operation),
          )
        )
          throw new Error(
            "Finish the current upload connection before switching browsers.",
          );
        browserStatus = await call("selectUploadBrowser", {
          browserId: select.value,
        });
        renderStatus();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        select.disabled = false;
      }
    });
    update();
    statusPoll = setInterval(update, 5000);
    globalThis.addEventListener("focus", update);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mountStatus, { once: true });
  else mountStatus();
  globalThis.addEventListener("pagehide", () => {
    clearInterval(statusPoll);
    ++observationGeneration;
    clearTimeout(liveExpiry);
    for (const [id, item] of pending) {
      clearTimeout(item.timeout);
      item.reject(new Error("The upload window closed."));
      pending.delete(id);
    }
    for (const portId of [...ports.keys()])
      closePort(portId, "The upload window closed.");
  });
})();
