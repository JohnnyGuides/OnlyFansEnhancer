(() => {
  "use strict";

  // Main-world half of the passive X collector. Injected at document_start,
  // before X's own code captures fetch/XMLHttpRequest, so X keeps calling the
  // wrappers below. The wrappers never alter requests or responses; they read
  // a clone of allowlisted GraphQL responses and send the owner's own posts
  // to the isolated relay over a private MessageChannel port.
  //
  // During a background scan the extension worker, through the relay and the
  // same private port, asks for one older page at a time: the owner's own
  // profile-timeline request is replayed with the next cursor and the
  // allowlisted headers X itself sent. Nothing is clicked, typed or posted.
  const contract = globalThis.CreatorXCollectorContract;
  const marker = Symbol.for("creator.x-collector.page");
  if (!contract || globalThis[marker]) return;
  Object.defineProperty(globalThis, marker, { value: true });

  const MAX_RESPONSE_CHARS = 8_000_000;
  const REPLAY_TIMEOUT_MS = 30_000;
  const channel = new MessageChannel();
  const owner = { accountId: null, handle: null };
  // The last owner profile-timeline request X made, its next cursor and a
  // summary of its posts. X's own requests stop updating it once paging starts.
  const scan = {
    template: null,
    cursor: null,
    statusIds: [],
    newestUtc: null,
    posts: [],
    started: false,
    busy: false,
  };
  let handedOver = false;

  // Messages queue on the port until the relay starts it; page scripts never
  // see the port, so they can neither read nor forge collector messages.
  function announce(detail) {
    channel.port1.postMessage(detail);
  }

  function currentOwnerId() {
    const fromCookie = contract.ownerIdFromCookie(document.cookie);
    if (fromCookie && fromCookie !== owner.accountId) {
      owner.accountId = fromCookie;
      owner.handle = null;
    }
    return owner.accountId;
  }

  function diagnostic(operation, reason) {
    announce({ kind: "diagnostic", operation, reason });
  }

  function inspectScheduled(operation, payload) {
    const ownerId = currentOwnerId();
    if (!ownerId) {
      diagnostic(operation, "owner-unknown");
      return null;
    }
    const result = contract.extractScheduled(payload);
    if (!result.ok) {
      if (result.reason !== "error-response")
        diagnostic(operation, result.reason);
      return result;
    }
    announce({
      kind: "scheduled",
      operation,
      batch: {
        owner: { accountId: ownerId, handle: owner.handle },
        scheduled: result.posts,
      },
    });
    return result;
  }

  function inspect(operation, payload) {
    const kind = contract.operationKind(operation);
    if (kind === "viewer") {
      const viewer = contract.viewerIdentity(payload);
      if (viewer) {
        owner.accountId = viewer.id;
        owner.handle = viewer.handle;
      }
      return null;
    }
    if (kind === "scheduled") return inspectScheduled(operation, payload);
    if (kind !== "tweets") return null;
    const ownerId = currentOwnerId();
    const result = contract.extractOwnerTweets(payload, ownerId);
    if (!result.ok) {
      if (result.reason !== "error-response")
        diagnostic(operation, result.reason);
      return result;
    }
    if (!result.tweets.length) return result;
    owner.handle = result.tweets[0].authorHandle;
    for (
      let index = 0;
      index < result.tweets.length;
      index += contract.MAX_BATCH
    ) {
      announce({
        kind: "batch",
        operation,
        batch: {
          owner: { accountId: ownerId, handle: owner.handle },
          observations: result.tweets.slice(index, index + contract.MAX_BATCH),
        },
      });
    }
    return result;
  }

  function safeInspect(operation, payload) {
    try {
      return inspect(operation, payload);
    } catch {
      diagnostic(operation, "inspection-failed");
      return null;
    }
  }

  function watchedOperation(url) {
    const name = contract.operationName(url);
    return name && contract.operationKind(name) ? name : null;
  }

  function pageSummary(result) {
    const tweets = result?.tweets || [];
    const times = tweets
      .map((tweet) => Date.parse(tweet.createdAt))
      .filter(Number.isFinite);
    return {
      statusIds: tweets.slice(0, contract.MAX_BATCH).map((t) => t.statusId),
      newestUtc: times.length
        ? new Date(Math.max(...times)).toISOString()
        : null,
      posts: tweets
        .slice(0, contract.MAX_SCAN_PREVIEWS)
        .map((tweet) => contract.scanPreview(tweet)),
    };
  }

  // Keep X's own owner-timeline request as the replay template.
  function rememberTemplate(entry, xhr, payload, result) {
    if (scan.started || !result?.ok) return;
    if (!contract.SCAN_OPERATIONS.includes(entry.operation)) return;
    if (String(entry.method || "").toUpperCase() !== "GET") return;
    const ownerId = currentOwnerId();
    if (!contract.replayUrl(entry.url, "probe", ownerId)) return;
    scan.template = {
      operation: entry.operation,
      url: String(entry.url),
      headers: contract.replayHeaders(entry.headers),
      withCredentials: xhr.withCredentials !== false,
    };
    scan.cursor = contract.bottomCursor(payload);
    Object.assign(scan, pageSummary(result));
  }

  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function creatorObservedFetch(...args) {
      const pending = Reflect.apply(nativeFetch, this, args);
      try {
        const input = args[0];
        const operation = watchedOperation(
          typeof input === "string" ? input : input?.url || String(input || ""),
        );
        if (operation && pending && typeof pending.then === "function") {
          pending.then(
            (response) => {
              if (!response?.ok || typeof response.clone !== "function") return;
              response
                .clone()
                .json()
                .then(
                  (payload) => safeInspect(operation, payload),
                  () => diagnostic(operation, "unreadable"),
                );
            },
            () => {},
          );
        }
      } catch {
        // Observation must never affect X's own request.
      }
      return pending;
    };
  }

  const xhrOperations = new WeakMap();
  const XhrPrototype = globalThis.XMLHttpRequest?.prototype;
  const nativeOpen = XhrPrototype?.open;
  const nativeSetRequestHeader = XhrPrototype?.setRequestHeader;
  if (XhrPrototype && typeof nativeOpen === "function") {
    const readXhr = (xhr, entry) => {
      const operation = entry.operation;
      if (xhr.status < 200 || xhr.status >= 300) return;
      let payload;
      if (xhr.responseType === "json") payload = xhr.response;
      else if (xhr.responseType === "" || xhr.responseType === "text") {
        const text = String(xhr.responseText || "");
        if (!text || text.length > MAX_RESPONSE_CHARS) return;
        try {
          payload = JSON.parse(text);
        } catch {
          diagnostic(operation, "unreadable");
          return;
        }
      } else return;
      const result = safeInspect(operation, payload);
      try {
        rememberTemplate(entry, xhr, payload, result);
      } catch {
        // A template is optional; observation continues without one.
      }
    };
    // Every open() of a watched URL gets its own one-shot listener; a token
    // ties it to that open so a reused object is read once per request.
    XhrPrototype.open = function creatorObservedOpen(...args) {
      try {
        const operation = watchedOperation(args[1]);
        const token = {};
        const entry = {
          operation,
          token,
          method: args[0],
          url: args[1],
          headers: {},
        };
        xhrOperations.set(this, entry);
        if (operation)
          this.addEventListener(
            "load",
            () => {
              if (xhrOperations.get(this)?.token === token)
                readXhr(this, entry);
            },
            { once: true },
          );
      } catch {
        // Observation must never affect X's own request.
      }
      return Reflect.apply(nativeOpen, this, args);
    };
    if (typeof nativeSetRequestHeader === "function") {
      XhrPrototype.setRequestHeader = function creatorObservedHeader(...args) {
        try {
          const entry = xhrOperations.get(this);
          if (
            entry?.operation &&
            contract.SCAN_OPERATIONS.includes(entry.operation)
          )
            entry.headers[String(args[0])] = String(args[1]);
        } catch {
          // Observation must never affect X's own request.
        }
        return Reflect.apply(nativeSetRequestHeader, this, args);
      };
    }
  }

  // One replayed request, bypassing the observing wrappers.
  function sendReplay(url, template) {
    return new Promise((resolve) => {
      const Xhr = globalThis.XMLHttpRequest;
      if (typeof Xhr !== "function" || typeof nativeOpen !== "function") {
        resolve({ status: 0, text: "" });
        return;
      }
      const xhr = new Xhr();
      const done = () =>
        resolve({
          status: Number(xhr.status) || 0,
          text: xhr.status === 200 ? String(xhr.responseText || "") : "",
        });
      xhr.addEventListener("load", done, { once: true });
      for (const type of ["error", "timeout", "abort"])
        xhr.addEventListener(type, () => resolve({ status: 0, text: "" }), {
          once: true,
        });
      Reflect.apply(nativeOpen, xhr, ["GET", url, true]);
      for (const [name, value] of Object.entries(template.headers))
        Reflect.apply(nativeSetRequestHeader, xhr, [name, value]);
      xhr.withCredentials = template.withCredentials;
      xhr.timeout = REPLAY_TIMEOUT_MS;
      xhr.send();
    });
  }

  function scanStatus() {
    return {
      ok: true,
      ownerId: currentOwnerId(),
      ready: Boolean(scan.template),
      operation: scan.template?.operation || "",
      cursor: Boolean(scan.cursor),
      statusIds: [...scan.statusIds],
      newestUtc: scan.newestUtc,
      posts: scan.posts,
    };
  }

  async function replayPage() {
    const ownerId = currentOwnerId();
    if (!ownerId) return { ok: false, reason: "signed-out", ownerId: null };
    if (scan.busy) return { ok: false, reason: "busy", ownerId };
    if (!scan.template) return { ok: false, reason: "no-template", ownerId };
    if (!scan.cursor) return { ok: false, reason: "no-cursor", ownerId };
    const url = contract.replayUrl(scan.template.url, scan.cursor, ownerId);
    if (!url) return { ok: false, reason: "not-owner-timeline", ownerId };
    scan.started = true;
    scan.busy = true;
    try {
      const response = await sendReplay(url, scan.template);
      if (response.status !== 200)
        return { ok: false, reason: `http-${response.status}`, ownerId };
      if (!response.text || response.text.length > MAX_RESPONSE_CHARS)
        return { ok: false, reason: "unreadable", ownerId };
      let payload;
      try {
        payload = JSON.parse(response.text);
      } catch {
        return { ok: false, reason: "unreadable", ownerId };
      }
      const result = safeInspect(scan.template.operation, payload);
      if (!result?.ok)
        return {
          ok: false,
          reason: result?.reason || "inspection-failed",
          ownerId,
        };
      scan.cursor = contract.bottomCursor(payload);
      Object.assign(scan, pageSummary(result));
      return {
        ok: true,
        ownerId,
        cursor: Boolean(scan.cursor),
        statusIds: [...scan.statusIds],
        newestUtc: scan.newestUtc,
        posts: scan.posts,
      };
    } finally {
      scan.busy = false;
    }
  }

  // Commands arrive only from the relay over the private port.
  channel.port1.onmessage = (event) => {
    const detail = event.data;
    if (detail?.kind !== "scan-command" || typeof detail.id !== "string")
      return;
    const reply = (value) =>
      announce({ kind: "scan-reply", id: detail.id, reply: value });
    if (detail.command === "status") reply(scanStatus());
    else if (detail.command === "page")
      replayPage().then(reply, () =>
        reply({ ok: false, reason: "replay-failed", ownerId: owner.accountId }),
      );
    else reply({ ok: false, reason: "unknown-command" });
  };

  // Handshake over synchronous DOM events before X's scripts run: in either
  // load order the relay receives the port exactly once, then announces
  // "locked" and the port is never offered again.
  function offerPort() {
    document.dispatchEvent(
      new MessageEvent(contract.PAGE_EVENT, {
        data: JSON.stringify({ kind: "hello" }),
        ports: [channel.port2],
      }),
    );
  }
  document.addEventListener(contract.PAGE_EVENT, (event) => {
    let detail;
    try {
      detail = JSON.parse(String(event.detail || ""));
    } catch {
      return;
    }
    if (detail?.kind === "locked") handedOver = true;
    if (detail?.kind !== "ready" || handedOver) return;
    handedOver = true;
    offerPort();
  });
  offerPort();
})();
