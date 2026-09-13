(() => {
  "use strict";

  const SOURCE = "creator-upload-file-bridge";
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session");
  const platform = params.get("platform");
  const parentOrigin = params.get("parentOrigin");
  if (
    !/^[A-Za-z0-9_-]{16,128}$/.test(sessionId || "") ||
    !new Set(["onlyfans", "fansly", "manyvids", "x", "redgifs"]).has(
      platform,
    ) ||
    !new Set([
      "https://onlyfans.com",
      "https://fansly.com",
      "https://x.com",
      "https://www.manyvids.com",
      "https://studio.redgifs.com",
    ]).has(parentOrigin)
  ) {
    return;
  }

  const channel = new BroadcastChannel(`creator-upload:${sessionId}`);
  channel.addEventListener("message", (event) => {
    const data = event.data;
    if (
      data?.source === "creator-upload-console" &&
      data.direction === "probe" &&
      data.sessionId === sessionId &&
      data.platform === platform
    ) {
      channel.postMessage({
        source: "creator-upload-bridge",
        direction: "ready",
        sessionId,
        platform,
        requestId: data.requestId,
      });
      return;
    }
    if (
      data?.source !== "creator-upload-console" ||
      data.sessionId !== sessionId ||
      data.platform !== platform ||
      !new Set(["full", "teaser", "thumbnail", "social"]).has(data.role) ||
      (["x", "redgifs"].includes(platform) && data.role !== "social") ||
      (!["x", "redgifs"].includes(platform) && data.role === "social") ||
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
        requestId: data.requestId,
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
