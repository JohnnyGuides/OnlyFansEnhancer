(() => {
  "use strict";

  if (globalThis.CreatorUploadFileBridge) return;

  const SOURCE = "creator-upload-file-bridge";
  const VIDEO_EXTENSIONS = /\.(?:mp4|m4v|mov|webm|avi|mkv)$/i;
  const IMAGE_EXTENSIONS = /\.(?:jpe?g|png)$/i;
  const AUDIO_EXTENSIONS = /\.(?:mp3|m4a|wav|aac|ogg|flac)$/i;
  const sessions = new Map();

  function assertToken(value, label) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(value || ""))) {
      throw new Error(`Invalid ${label}.`);
    }
  }

  function accepts(file, kind) {
    const type = String(file?.type || "");
    return Boolean(
      file instanceof File &&
      file.size > 0 &&
      (kind === "image"
        ? type
          ? ["image/png", "image/jpeg"].includes(type)
          : IMAGE_EXTENSIONS.test(file.name)
        : kind === "audio"
          ? type
            ? type.startsWith("audio/")
            : AUDIO_EXTENSIONS.test(file.name)
          : type
            ? type.startsWith("video/")
            : VIDEO_EXTENSIONS.test(file.name)),
    );
  }

  function postAck(event, message) {
    event.source?.postMessage(
      {
        source: SOURCE,
        direction: "ack",
        requestId: event.data.requestId,
        ...message,
      },
      event.origin === "null" ? "*" : event.origin,
    );
  }

  function install({ sessionId, platform, bridgeUrl, bridgeOrigin, roles }) {
    assertToken(sessionId, "upload session");
    if (
      !new Set([
        "onlyfans",
        "fansly",
        "manyvids",
        "pornhub",
        "x",
        "redgifs",
      ]).has(platform)
    ) {
      throw new Error("Unsupported upload platform.");
    }
    if (!roles || typeof roles !== "object") {
      throw new Error("Upload file roles are required.");
    }
    if (sessions.has(sessionId)) dispose(sessionId);

    /** @type {Array<[string, {selector: string, kind: "video" | "image" | "audio", token: string, used: boolean, value: any, waiters: Function[], activatedInput?: HTMLInputElement}]>} */
    const roleEntries = Object.entries(roles).map(([role, definition]) => {
      if (
        (!new Set(["full", "teaser", "thumbnail", "pornhub", "social"]).has(
          role,
        ) &&
          !/^media[1-8](?:Teaser)?$/.test(role)) ||
        (/^media[1-8]$/.test(role) &&
          !["onlyfans", "fansly"].includes(platform)) ||
        (/^media[1-8]Teaser$/.test(role) && platform !== "fansly") ||
        (platform === "pornhub"
          ? !["pornhub", "thumbnail"].includes(role)
          : role === "pornhub") ||
        (["x", "redgifs"].includes(platform) && role !== "social") ||
        (!["x", "redgifs"].includes(platform) && role === "social")
      ) {
        throw new Error("Unsupported upload file role.");
      }
      const kind = definition?.kind || "video";
      if (
        !new Set(["video", "image", "audio"]).has(kind) ||
        (/^media[1-8]Teaser$/.test(role) && kind !== "video")
      ) {
        throw new Error(`Unsupported ${role} file kind.`);
      }
      assertToken(definition?.token, `${role} file token`);
      if (!String(definition?.selector || "").trim()) {
        throw new Error(`Missing ${role} file selector.`);
      }
      return /** @type {[string, {selector: string, kind: "video" | "image" | "audio", token: string, used: boolean, value: any, waiters: Function[], activatedInput?: HTMLInputElement}]} */ ([
        role,
        {
          selector: definition.selector,
          kind,
          token: definition.token,
          used: false,
          value: null,
          waiters: [],
        },
      ]);
    });
    const roleMap = new Map(roleEntries);
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.dataset.creatorUploadFileBridge = sessionId;
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = bridgeUrl;

    const onMessage = (event) => {
      const data = event.data;
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== bridgeOrigin ||
        !data ||
        data.source !== SOURCE ||
        data.direction === "ack" ||
        data.sessionId !== sessionId ||
        data.platform !== platform
      ) {
        return;
      }
      const entry = roleMap.get(data.role);
      if (
        !entry ||
        entry.used ||
        data.token !== entry.token ||
        !accepts(data.file, entry.kind)
      ) {
        postAck(event, {
          sessionId,
          platform,
          role: data.role,
          ok: false,
          error: "File transfer was not authorized.",
        });
        return;
      }
      const candidates = document.querySelectorAll(entry.selector);
      const input =
        entry.activatedInput ||
        (candidates.length === 1 ? candidates[0] : null);
      if (
        !(input instanceof HTMLInputElement) ||
        !input.isConnected ||
        !input.matches(entry.selector) ||
        input.type !== "file" ||
        (platform === "pornhub" &&
          data.role === "pornhub" &&
          !entry.activatedInput)
      ) {
        postAck(event, {
          sessionId,
          platform,
          role: data.role,
          ok: false,
          error: "The expected platform file control is unavailable.",
        });
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(data.file);
      entry.used = true;
      input.files = transfer.files;
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      input.dispatchEvent(
        new Event("change", { bubbles: true, composed: true }),
      );
      entry.value = Object.freeze({
        name: data.file.name,
        size: data.file.size,
        type: data.file.type,
        role: data.role,
      });
      for (const resolve of entry.waiters.splice(0)) resolve(entry.value);
      postAck(event, {
        sessionId,
        platform,
        role: data.role,
        ok: true,
        file: entry.value,
      });
    };

    globalThis.addEventListener("message", onMessage);
    (document.documentElement || document.body).append(iframe);
    sessions.set(sessionId, { iframe, onMessage, roleMap, platform });
    return { sessionId, platform, roles: [...roleMap.keys()] };
  }

  function namedError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function waitFor(sessionId, role, timeoutMs = 600_000, signal) {
    const entry = sessions.get(sessionId)?.roleMap.get(role);
    if (!entry) return Promise.reject(new Error("Unknown upload file role."));
    if (entry.value) return Promise.resolve(entry.value);
    if (signal?.aborted)
      return Promise.reject(
        namedError("AbortError", "Waiting for the video was cancelled."),
      );
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        fail(new Error(`Timed out waiting for the ${role} video.`));
      }, timeoutMs);
      const onAbort = () =>
        fail(namedError("AbortError", "Waiting for the video was cancelled."));
      const settle = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        entry.waiters = entry.waiters.filter((waiter) => waiter !== done);
      };
      const fail = (error) => {
        settle();
        reject(error);
      };
      const done = (value) => {
        settle();
        resolve(value);
      };
      done.fail = fail;
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.waiters.push(done);
    });
  }

  function dispose(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    for (const entry of session.roleMap.values())
      for (const waiter of entry.waiters.splice(0))
        waiter.fail?.(
          namedError(
            "UploadFileBridgeDisposedError",
            "The upload file bridge was disposed.",
          ),
        );
    globalThis.removeEventListener("message", session.onMessage);
    session.iframe.remove();
    sessions.delete(sessionId);
  }

  function attachmentTarget(sessionId, role, token) {
    const entry = sessions.get(sessionId)?.roleMap.get(role);
    if (!entry || entry.used || entry.token !== token)
      throw new Error("File transfer was not authorized.");
    return { selector: entry.selector, kind: entry.kind };
  }

  function bindActivatedInput(sessionId, role, input) {
    const session = sessions.get(sessionId);
    const entry = session?.roleMap.get(role);
    if (
      session?.platform !== "pornhub" ||
      role !== "pornhub" ||
      !entry ||
      entry.used ||
      entry.activatedInput ||
      !(input instanceof HTMLInputElement) ||
      !input.isConnected ||
      !input.matches(entry.selector)
    )
      throw new Error("The activated upload input is not owned by this role.");
    entry.activatedInput = input;
  }

  // Called only by the extension after its native file attacher verified the
  // exact input and origin. A capture-phase receipt also handles sites that clear
  // or remove their input in the change handler; site acceptance remains separate.
  function acknowledgeNative(
    sessionId,
    role,
    token,
    expected,
    selectionVerified = false,
  ) {
    const { selector } = attachmentTarget(sessionId, role, token);
    const inputs = document.querySelectorAll(selector);
    const file = inputs.length === 1 ? inputs[0].files?.[0] : null;
    if (
      !selectionVerified &&
      (!file || file.name !== expected.name || file.size !== expected.size)
    )
      throw new Error("The platform file does not match the selected file.");
    const entry = sessions.get(sessionId).roleMap.get(role);
    entry.used = true;
    entry.value = Object.freeze({
      name: expected.name,
      size: expected.size,
      type: file?.type || "",
      role,
    });
    for (const resolve of entry.waiters.splice(0)) resolve(entry.value);
    return entry.value;
  }

  globalThis.CreatorUploadFileBridge = Object.freeze({
    dispose,
    install,
    waitFor,
    attachmentTarget,
    acknowledgeNative,
    bindActivatedInput,
  });
})();
