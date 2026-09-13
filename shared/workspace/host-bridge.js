(function attachOFEnhancerHost(global) {
  "use strict";

  const pending = new Map();

  function requestId() {
    return global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  }

  function desktopRequest(operation, payload) {
    return new Promise((resolve, reject) => {
      const id = requestId();
      const timeout = ["getStatus", "getChromeReadiness"].includes(operation)
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error("Desktop connection check timed out."));
          }, 4000)
        : null;
      pending.set(id, { resolve, reject, timeout });
      global.chrome.webview.postMessage(
        JSON.stringify({ requestId: id, operation, payload }),
      );
    });
  }

  function extensionRequest(operation, payload) {
    return new Promise((resolve, reject) => {
      global.chrome.runtime.sendMessage(
        { type: "OFENHANCER_APP_REQUEST", operation, payload },
        (response) => {
          if (global.chrome.runtime.lastError) {
            reject(new Error("Chrome could not reach OFEnhancer."));
            return;
          }
          if (!response?.ok) {
            reject(
              new Error(response?.error?.code || "OFEnhancer request failed."),
            );
            return;
          }
          resolve(response.result);
        },
      );
    });
  }

  if (global.chrome?.webview) {
    global.chrome.webview.addEventListener("message", ({ data }) => {
      const response = typeof data === "string" ? JSON.parse(data) : data;
      const waiting = pending.get(response?.requestId);
      if (!waiting) return;
      pending.delete(response.requestId);
      clearTimeout(waiting.timeout);
      if (response.ok) waiting.resolve(response.result);
      else
        waiting.reject(
          new Error(response?.error?.code || "OFEnhancer request failed."),
        );
    });
  }

  global.OFEnhancerHost = Object.freeze({
    request(operation, payload = {}) {
      if (typeof global.__OFENHANCER_TEST_HOST__ === "function")
        return global.__OFENHANCER_TEST_HOST__(operation, payload);
      if (global.chrome?.webview) return desktopRequest(operation, payload);
      if (global.chrome?.runtime?.sendMessage)
        return extensionRequest(operation, payload);
      return Promise.reject(new Error("OFEnhancer is not connected."));
    },
  });
})(globalThis);
