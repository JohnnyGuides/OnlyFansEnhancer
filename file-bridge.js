(() => {
  "use strict";

  const SOURCE = "creator-upload-file-bridge";
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session");
  const platform = params.get("platform");
  const parentOrigin = params.get("parentOrigin");
  if (
    !/^[A-Za-z0-9_-]{16,128}$/.test(sessionId || "") ||
    !new Set(["onlyfans", "fansly"]).has(platform) ||
    !new Set(["https://onlyfans.com", "https://fansly.com"]).has(parentOrigin)
  ) {
    return;
  }

  const channel = new BroadcastChannel(`creator-upload:${sessionId}`);
  channel.addEventListener("message", (event) => {
    const data = event.data;
    if (
      data?.source !== "creator-upload-console" ||
      data.sessionId !== sessionId ||
      data.platform !== platform ||
      !new Set(["full", "teaser"]).has(data.role) ||
      !(data.file instanceof File)
    ) {
      return;
    }
    parent.postMessage(
      {
        source: SOURCE,
        direction: "file",
        sessionId,
        platform,
        role: data.role,
        token: data.token,
        file: data.file,
      },
      parentOrigin,
    );
  });

  globalThis.addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      event.data?.source !== SOURCE ||
      event.data.direction !== "ack" ||
      event.data.sessionId !== sessionId ||
      event.data.platform !== platform
    ) {
      return;
    }
    channel.postMessage({ ...event.data, source: "creator-upload-bridge" });
  });

  channel.postMessage({
    source: "creator-upload-bridge",
    direction: "ready",
    sessionId,
    platform,
  });
})();
