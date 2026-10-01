(() => {
  "use strict";

  // Main-world half of the passive X collector. Injected at document_start,
  // before X's own code captures fetch/XMLHttpRequest, so X keeps calling the
  // wrappers below. The wrappers never alter requests or responses; they read
  // a clone of allowlisted GraphQL responses and announce the owner's own
  // posts to the isolated relay over a nonce-bound page event.
  const contract = globalThis.CreatorXCollectorContract;
  const marker = Symbol.for("creator.x-collector.page");
  if (!contract || globalThis[marker]) return;
  Object.defineProperty(globalThis, marker, { value: true });

  const MAX_RESPONSE_CHARS = 8_000_000;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const owner = { accountId: null, handle: null };
  let answeredReady = false;

  function announce(detail) {
    document.dispatchEvent(
      new CustomEvent(contract.PAGE_EVENT, { detail: JSON.stringify(detail) }),
    );
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
    announce({ kind: "diagnostic", nonce, operation, reason });
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
        nonce,
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
    const readXhr = (xhr) => {
      const operation = xhrOperations.get(xhr);
      if (!operation || xhr.status < 200 || xhr.status >= 300) return;
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
    XhrPrototype.open = function creatorObservedOpen(...args) {
      try {
        const operation = watchedOperation(args[1]);
        const known = xhrOperations.has(this);
        xhrOperations.set(this, operation);
        if (operation && !known)
          this.addEventListener("load", () => readXhr(this));
      } catch {
        // Observation must never affect X's own request.
      }
      return Reflect.apply(nativeOpen, this, args);
    };
  }

  // Handshake: in either load order, the relay locks onto exactly one
  // nonce before X's scripts run; later page events without it are ignored.
  document.addEventListener(contract.PAGE_EVENT, (event) => {
    let detail;
    try {
      detail = JSON.parse(String(event.detail || ""));
    } catch {
      return;
    }
    // Once the relay holds the nonce, never reveal it again.
    if (detail?.kind === "locked") answeredReady = true;
    if (detail?.kind !== "ready" || answeredReady) return;
    answeredReady = true;
    announce({ kind: "hello", nonce });
  });
  announce({ kind: "hello", nonce });
})();
