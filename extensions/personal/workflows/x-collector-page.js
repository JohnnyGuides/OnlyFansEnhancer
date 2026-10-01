(() => {
  "use strict";

  // Main-world half of the passive X collector. Injected at document_start,
  // before X's own code captures fetch/XMLHttpRequest, so X keeps calling the
  // wrappers below. The wrappers never alter requests or responses; they read
  // a clone of allowlisted GraphQL responses and send the owner's own posts
  // to the isolated relay over a private MessageChannel port.
  const contract = globalThis.CreatorXCollectorContract;
  const marker = Symbol.for("creator.x-collector.page");
  if (!contract || globalThis[marker]) return;
  Object.defineProperty(globalThis, marker, { value: true });

  const MAX_RESPONSE_CHARS = 8_000_000;
  const channel = new MessageChannel();
  const owner = { accountId: null, handle: null };
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

  function inspect(operation, payload) {
    const kind = contract.operationKind(operation);
    if (kind === "viewer") {
      const viewer = contract.viewerIdentity(payload);
      if (viewer) {
        owner.accountId = viewer.id;
        owner.handle = viewer.handle;
      }
      return;
    }
    if (kind !== "tweets") return;
    const ownerId = currentOwnerId();
    const result = contract.extractOwnerTweets(payload, ownerId);
    if (!result.ok) {
      if (result.reason !== "error-response")
        diagnostic(operation, result.reason);
      return;
    }
    if (!result.tweets.length) return;
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
  }

  function safeInspect(operation, payload) {
    try {
      inspect(operation, payload);
    } catch {
      diagnostic(operation, "inspection-failed");
    }
  }

  function watchedOperation(url) {
    const name = contract.operationName(url);
    return name && contract.operationKind(name) ? name : null;
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
  if (XhrPrototype && typeof XhrPrototype.open === "function") {
    const nativeOpen = XhrPrototype.open;
    const readXhr = (xhr, operation) => {
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
      safeInspect(operation, payload);
    };
    // Every open() of a watched URL gets its own one-shot listener; a token
    // ties it to that open so a reused object is read once per request.
    XhrPrototype.open = function creatorObservedOpen(...args) {
      try {
        const operation = watchedOperation(args[1]);
        const token = {};
        xhrOperations.set(this, { operation, token });
        if (operation)
          this.addEventListener(
            "load",
            () => {
              if (xhrOperations.get(this)?.token === token)
                readXhr(this, operation);
            },
            { once: true },
          );
      } catch {
        // Observation must never affect X's own request.
      }
      return Reflect.apply(nativeOpen, this, args);
    };
  }

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
