"use strict";
// Adapt older UI-only fixtures to the shared admission/port acknowledgement
// contract. Real worker admission, recovery and transport are exercised separately.
async function installUploaderMockAdmission(page) {
  await page.evaluate(() => {
    const runtime = chrome.runtime;
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (message, callback) => {
      if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY") {
        globalThis.mockReadinessChecks =
          (globalThis.mockReadinessChecks || 0) + 1;
        queueMicrotask(() =>
          callback({ ok: true, availability: { ready: true } }),
        );
        return;
      }
      return send(message, (response) => {
        if (message.type === "PREPARE_CREATOR_UPLOAD") {
          if (response?.ok && response.uploadSession)
            response.uploadSession.sessionId = message.sessionId;
          else if (response?.ok === false)
            response.uploadAdmission = "not-started";
        }
        if (message.type === "START_CREATOR_UPLOAD" && response?.ok)
          response.accepted = true;
        callback(response);
      });
    };
    const connect = runtime.connect?.bind(runtime);
    if (connect)
      runtime.connect = (...args) => {
        const port = connect(...args),
          listeners = [];
        const add = port.onMessage.addListener.bind(port.onMessage);
        port.onMessage.addListener = (listener) => {
          listeners.push(listener);
          add(listener);
        };
        const post = port.postMessage.bind(port);
        port.postMessage = (message) => {
          post(message);
          if (message.type === "bind-session")
            queueMicrotask(() =>
              listeners.forEach((listener) =>
                listener({
                  type: "session-bound",
                  sessionId: message.sessionId,
                }),
              ),
            );
        };
        return port;
      };
  });
}
module.exports = { installUploaderMockAdmission };
