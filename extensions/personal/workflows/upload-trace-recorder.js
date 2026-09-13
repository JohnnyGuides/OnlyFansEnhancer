(() => {
  "use strict";

  if (globalThis.CreatorUploadTraceRecorder) return;

  const STORAGE_KEY = "creatorUploadTraceRecorderV1";
  const HOST_ID = "creator-upload-trace-recorder-host";
  const MAX_EVENTS = 800;
  const MAX_DURATION_MS = 45 * 60 * 1000;
  const ROUTE_POLL_MS = 250;
  const SNAPSHOT_DEBOUNCE_MS = 250;
  const SNAPSHOT_POLL_MS = 1000;
  const MAX_SNAPSHOT_CANDIDATES = 800;
  const STATUS_PATTERN =
    /\b(upload(?:ed|ing)?|process(?:ed|ing)?|publish(?:ed|ing)?|post(?:ed|ing)?|schedul(?:e|ed|ing)|complete(?:d)?|success|failed?|error|progress|ready|finaliz(?:e|ed|ing)|convert(?:ed|ing)?|transcod(?:e|ed|ing)?)\b/i;
  /** @type {ReadonlyArray<readonly [string, RegExp]>} */
  const STATUS_STATE_PATTERNS = Object.freeze([
    ["upload", /\bupload(?:ed|ing)?\b/i],
    ["process", /\bprocess(?:ed|ing)?\b/i],
    ["publish", /\bpublish(?:ed|ing)?\b/i],
    ["post", /\bpost(?:ed|ing)?\b/i],
    ["schedule", /\bschedul(?:e|ed|ing)\b/i],
    ["complete", /\bcomplete(?:d)?\b/i],
    ["success", /\bsuccess\b/i],
    ["failed", /\bfailed?\b/i],
    ["error", /\berror\b/i],
    ["progress", /\bprogress\b/i],
    ["ready", /\bready\b/i],
    ["finalize", /\bfinaliz(?:e|ed|ing)\b/i],
    ["convert", /\bconvert(?:ed|ing)?\b/i],
    ["transcode", /\btranscod(?:e|ed|ing)?\b/i],
  ]);
  const ACTION_PATTERN =
    /\b(add|attach|back|calendar|cancel|close|confirm|continue|date|delete|done|edit|finish|later|next|now|ok|post|previous|publish|remove|save|schedule|submit|time|upload|view)\b/i;
  const SAFE_ACTION_LABEL_WORDS = new Set([
    "add",
    "apply",
    "attach",
    "audience",
    "back",
    "calendar",
    "cancel",
    "caption",
    "close",
    "confirm",
    "continue",
    "create",
    "date",
    "delete",
    "description",
    "done",
    "edit",
    "file",
    "free",
    "finish",
    "finished",
    "for",
    "helper",
    "later",
    "load",
    "media",
    "new",
    "next",
    "now",
    "ok",
    "post",
    "preview",
    "preset",
    "previous",
    "publish",
    "remove",
    "save",
    "schedule",
    "set",
    "share",
    "submit",
    "time",
    "title",
    "to",
    "upload",
    "video",
    "view",
  ]);
  const SAFE_RESOURCE_PATH_SEGMENTS = new Set([
    "account",
    "chat",
    "complete",
    "contentdiscovery",
    "convert",
    "counters",
    "create",
    "event",
    "file",
    "finalize",
    "finish",
    "following",
    "followingstreams",
    "hash",
    "labels",
    "later",
    "livesuggestions",
    "log",
    "media",
    "mediastories",
    "online",
    "part",
    "parts",
    "post",
    "posts",
    "schedule",
    "scheduled",
    "schedules",
    "settings",
    "signed",
    "status",
    "streaming",
    "track",
    "upload",
    "users",
    "vault",
  ]);
  const RESOURCE_INITIATORS = new Set(["fetch", "xmlhttprequest", "beacon"]);

  /**
   * @typedef {{type: string, at: string, ms: number, data: Record<string, any>}} TraceEvent
   * @typedef {{
   *   schemaVersion: number,
   *   id: string,
   *   platform: string,
   *   origin: string,
   *   active: boolean,
   *   startedAt: number,
   *   expiresAt: number,
   *   stoppedAt: number | null,
   *   stopReason: string,
   *   events: TraceEvent[]
   *   ownerId?: string
   *   diagnosticVersion?: number
   * }} TraceState
   */

  /** @type {TraceState | null} */
  let currentTrace = null;
  /** @type {Promise<void>} */
  let storageQueue = Promise.resolve();
  let panel = null;
  let routeTimer = null;
  let snapshotTimer = null;
  let snapshotPollTimer = null;
  let mutationObserver = null;
  let performanceObserver = null;
  let lastRoute = "";
  let lastSnapshot = "";
  let ownerId = "";
  let assetRole = "full";
  const documentGeneration = globalThis.crypto?.randomUUID?.() || "";

  function ownsTrace(trace) {
    return Boolean(
      trace?.active &&
      trace.origin === location.origin &&
      trace.ownerId === ownerId &&
      ownerId,
    );
  }

  function sanitizeUrl(value, base) {
    try {
      const url = base
        ? new URL(String(value), String(base))
        : new URL(String(value));
      if (!/^https?:$/.test(url.protocol)) return "";
      const sanitized = `${url.protocol}//${url.host}${url.pathname}`;
      const viewkey = url.searchParams.get("viewkey");
      return viewkey && /^[a-z0-9_-]{1,100}$/i.test(viewkey)
        ? `${sanitized}?viewkey=${encodeURIComponent(viewkey)}`
        : sanitized;
    } catch {
      return "";
    }
  }

  function sanitizeFilename(value) {
    const basename = String(value ?? "")
      .split(/[\\/]/)
      .pop();
    const extension = basename.match(/\.[a-z0-9]{1,10}$/i)?.[0] || "";
    return `[redacted]${extension.toLowerCase()}`;
  }

  function decodePathSegment(value) {
    let decoded = String(value || "");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return decoded;
  }

  function sanitizeResourceUrl(value, base) {
    try {
      const url = base
        ? new URL(String(value), String(base))
        : new URL(String(value));
      if (!/^https?:$/.test(url.protocol)) return "";
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => {
          const decoded = decodePathSegment(segment);
          const extension = decoded.match(/\.([a-z0-9]{1,10})$/i)?.[1];
          if (extension) return `[file].${extension.toLowerCase()}`;
          const normalized = decoded.toLowerCase();
          return SAFE_RESOURCE_PATH_SEGMENTS.has(normalized) ||
            /^api\d*$/.test(normalized) ||
            /^v\d+$/.test(normalized)
            ? normalized
            : "[id]";
        });
      return `${url.protocol}//${url.host}${segments.length ? `/${segments.join("/")}` : ""}`;
    } catch {
      return "";
    }
  }

  function sanitizeText(value, maximumLength = 180) {
    return String(value ?? "")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(
        /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
        "[email]",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maximumLength);
  }

  function stableToken(value, maximumLength = 80) {
    const token = sanitizeText(value, maximumLength);
    if (!token || token.includes("[email]") || token.includes("[url]")) {
      return "";
    }
    return token;
  }

  function safeActionText(value) {
    const text = sanitizeText(value, 120);
    if (/^\d{1,4}(?:(?:[.:/-]\d{1,4})+|\s*(?:am|pm))?$/i.test(text)) {
      return text;
    }
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    return words.length > 0 &&
      words.every((word) => SAFE_ACTION_LABEL_WORDS.has(word))
      ? text
      : "";
  }

  function elementSignature(element) {
    if (!element || element.nodeType !== 1) return null;
    const tag = String(element.tagName || "").toLowerCase();
    const type = stableToken(element.getAttribute?.("type"), 30).toLowerCase();
    const signature = { tag };
    if (type) signature.type = type;
    if (tag === "input" && type === "file") {
      signature.connected = Boolean(element.isConnected);
      signature.accept = stableToken(element.getAttribute("accept"), 160);
      signature.multiple = Boolean(element.multiple);
    }

    for (const [attribute, key] of [
      ["role", "role"],
      ["id", "id"],
      ["name", "name"],
      ["data-testid", "testId"],
      ["data-test", "test"],
      ["data-qa", "qa"],
    ]) {
      const value = stableToken(element.getAttribute?.(attribute));
      if (value) signature[key] = value;
    }

    const classes = Array.from(element.classList || [])
      .filter(
        (value) =>
          /^[a-z][a-z0-9_-]{0,39}$/i.test(value) &&
          !/\d{5,}/.test(value) &&
          !/^[a-f0-9]{12,}$/i.test(value),
      )
      .slice(0, 5);
    if (classes.length) signature.classes = classes;

    const mayUseText =
      ["button", "a"].includes(tag) ||
      element.getAttribute?.("role") === "button";
    const formLabel = ["input", "select", "textarea"].includes(tag)
      ? Array.from(element.labels || [])
          .map((candidate) => candidate.textContent)
          .find(Boolean)
      : "";
    const explicitLabel =
      element.getAttribute?.("aria-label") ||
      element.getAttribute?.("title") ||
      formLabel;
    const label = explicitLabel
      ? safeActionText(explicitLabel)
      : mayUseText
        ? safeActionText(element.textContent)
        : "";
    if (label) signature.label = label;
    return signature;
  }

  function appendBoundedEvent(events, event, maximumEvents = 800) {
    const current = Array.isArray(events) ? events : [];
    if (current.length >= maximumEvents) return current;
    const previous = current.at(-1);
    if (
      previous &&
      JSON.stringify([previous.type, previous.data]) ===
        JSON.stringify([event?.type, event?.data])
    ) {
      return current;
    }
    return [...current, event];
  }

  function platformFor(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (host === "onlyfans.com" || host.endsWith(".onlyfans.com")) {
      return "OnlyFans";
    }
    if (host === "fansly.com" || host.endsWith(".fansly.com")) return "Fansly";
    if (host === "manyvids.com" || host.endsWith(".manyvids.com")) {
      return "ManyVids";
    }
    if (host === "pornhub.mainhub.com") return "Pornhub";
    if (host === "x.com" || host.endsWith(".x.com")) return "X";
    if (host === "redgifs.com" || host.endsWith(".redgifs.com")) {
      return "Redgifs";
    }
    if (host === "reddit.com" || host.endsWith(".reddit.com")) {
      return "Reddit";
    }
    return "Unsupported";
  }

  /** @returns {Promise<TraceState | null>} */
  async function readTrace() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const candidate = stored[STORAGE_KEY];
    return candidate && typeof candidate === "object"
      ? /** @type {TraceState} */ (candidate)
      : null;
  }

  /** @param {TraceState} trace */
  async function writeTrace(trace) {
    await chrome.storage.local.set({ [STORAGE_KEY]: trace });
    currentTrace = trace;
    renderPanel();
    return trace;
  }

  /**
   * @param {(trace: TraceState | null) => TraceState | null | undefined | Promise<TraceState | null | undefined>} update
   * @returns {Promise<TraceState | null>}
   */
  function updateTrace(update) {
    const operation = storageQueue
      .catch(() => {})
      .then(async () => {
        const previous = await readTrace();
        const next = await update(previous);
        return next === undefined ? previous : writeTrace(next);
      });
    storageQueue = operation.then(
      () => undefined,
      (error) => showPanelError(error),
    );
    return operation;
  }

  function eventRecord(trace, type, data, now = Date.now()) {
    return {
      type,
      at: new Date(now).toISOString(),
      ms: Math.max(0, now - trace.startedAt),
      data,
    };
  }

  function appendEvent(type, data) {
    if (!ownsTrace(currentTrace)) {
      return Promise.resolve(currentTrace);
    }
    return updateTrace((trace) => {
      if (!ownsTrace(trace) || trace.id !== currentTrace.id) return trace;
      const events = appendBoundedEvent(
        trace.events,
        eventRecord(trace, type, data),
        MAX_EVENTS,
      );
      return {
        ...trace,
        active: events.length < MAX_EVENTS,
        stoppedAt: events.length < MAX_EVENTS ? null : Date.now(),
        stopReason: events.length < MAX_EVENTS ? "" : "event-cap",
        events,
      };
    });
  }

  function sessionId() {
    return (
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
  }

  async function startSession() {
    const now = Date.now();
    const platform = platformFor(location.hostname);
    const trace = {
      schemaVersion: 1,
      diagnosticVersion: 2,
      ownerId,
      id: sessionId(),
      platform,
      origin: location.origin,
      active: true,
      startedAt: now,
      expiresAt: now + MAX_DURATION_MS,
      stoppedAt: null,
      stopReason: "",
      events: [],
    };
    trace.events = appendBoundedEvent(
      trace.events,
      eventRecord(trace, "session-start", {
        platform,
        route: sanitizeUrl(location.href),
      }),
      MAX_EVENTS,
    );
    await updateTrace(() => trace);
    startObservers();
    scheduleSnapshot();
  }

  async function stopSession(reason = "manual", download = false) {
    const stopped = await updateTrace((trace) => {
      if (!trace) return trace;
      const now = Date.now();
      const events = trace.active
        ? appendBoundedEvent(
            trace.events,
            eventRecord(trace, "session-stop", { reason }, now),
            MAX_EVENTS,
          )
        : trace.events;
      return {
        ...trace,
        active: false,
        stoppedAt: trace.stoppedAt || now,
        stopReason: trace.stopReason || reason,
        events,
      };
    });
    stopObservers();
    if (download && stopped) downloadTrace(stopped);
    return stopped;
  }

  function traceFilename(trace) {
    const stamp = new Date(trace.startedAt).toISOString().replace(/[:.]/g, "-");
    return `creator-upload-trace-${trace.platform.toLowerCase()}-${stamp}.json`;
  }

  function downloadTrace(trace) {
    const blob = new Blob([JSON.stringify(trace, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = traceFilename(trace);
    link.hidden = true;
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function isRecorderNode(node) {
    const host = document.getElementById(HOST_ID);
    if (!host || !node) return false;
    if (node === host || host.contains?.(node)) return true;
    return node.getRootNode?.() === host.shadowRoot;
  }

  function eventElement(event) {
    return (event.composedPath?.() || [event.target]).find(
      (node) =>
        node?.nodeType === 1 &&
        !isRecorderNode(node) &&
        inPublishingScope(node),
    );
  }

  function editableEventElement(event) {
    return (event.composedPath?.() || [event.target]).find(
      (node) =>
        node?.nodeType === 1 &&
        !isRecorderNode(node) &&
        inPublishingScope(node) &&
        (node.matches?.(
          "input,select,textarea,[contenteditable]:not([contenteditable='false'])",
        ) ||
          node.getAttribute?.("role") === "textbox"),
    );
  }

  function hasMeaningfulEditorText(value) {
    return Boolean(
      String(value || "").replace(/[\s\u200b-\u200d\ufeff]/gi, ""),
    );
  }

  function actionableEventElement(event) {
    const path = (event.composedPath?.() || [event.target]).filter(
      (node) =>
        node?.nodeType === 1 &&
        !isRecorderNode(node) &&
        inPublishingScope(node),
    );
    const semantic = path.find(
      (node) =>
        node.matches?.(
          "button,a[href],input[type='button'],input[type='file'],input[type='submit'],[role='button'],[role='menuitem'],[role='option'],[role='checkbox'],[role='radio'],[tabindex]:not([tabindex='-1'])",
        ) || node.hasAttribute?.("onclick"),
    );
    if (semantic) return semantic;
    const classed = path.find((node) =>
      Array.from(node.classList || []).some((name) =>
        /(?:^|[-_])(btn|button|click|pointer)(?:$|[-_])/i.test(name),
      ),
    );
    if (classed) return classed;
    const pointerPath = path.filter(
      (node) => getComputedStyle(node).cursor === "pointer",
    );
    return pointerPath.at(-1) || null;
  }

  function toolkitPanelId(element) {
    let candidate = element;
    for (let depth = 0; candidate && depth < 8; depth += 1) {
      const toolId = stableToken(candidate.dataset?.creatorToolkitPanel, 80);
      if (toolId) return toolId;
      const root = candidate.getRootNode?.();
      candidate = root?.host || candidate.parentElement;
    }
    return "";
  }

  function interactionContext(event, element) {
    const toolId = toolkitPanelId(element);
    return {
      actor: event?.isTrusted === true ? "user" : "script",
      surface: toolId ? "toolkit-panel" : "platform",
      ...(toolId ? { toolId } : {}),
      documentGeneration,
      frame: globalThis.top === globalThis.window ? "top" : "child",
      boundary: element.closest?.(
        "[role='dialog'], .modal, app-media-upload-modal",
      )
        ? "dialog"
        : element.closest?.("app-post-creation, form, .uppy-Dashboard")
          ? "composer"
          : "outside",
    };
  }

  function structuredLabels(values) {
    return Array.from(values || [])
      .map((value) => stableToken(value, 120))
      .filter(Boolean)
      .slice(0, 20);
  }

  function recordToolkitEvent(kind, data = {}) {
    const allowedKinds = new Set([
      "panel-action",
      "control-action",
      "run-start",
      "run-result",
    ]);
    if (!allowedKinds.has(kind)) return Promise.resolve(currentTrace);

    const sanitized = {};
    const toolId = stableToken(data.toolId, 80);
    if (toolId) sanitized.toolId = toolId;

    if (kind === "panel-action") {
      sanitized.actor = data.actor === "user" ? "user" : "script";
      sanitized.actionId = stableToken(data.actionId, 80);
      sanitized.label = stableToken(data.label, 120);
      if (data.fieldId) sanitized.fieldId = stableToken(data.fieldId, 80);
      if (data.selection) {
        sanitized.selection = stableToken(data.selection, 120);
      }
    } else if (kind === "control-action") {
      sanitized.action = stableToken(data.action, 50);
      sanitized.control = elementSignature(data.control);
      const selectedLabels = structuredLabels(data.selectedLabels);
      if (selectedLabels.length) sanitized.selectedLabels = selectedLabels;
    } else if (kind === "run-start") {
      sanitized.label = stableToken(data.label, 160);
    } else if (kind === "run-result") {
      sanitized.status = stableToken(data.status, 30);
      sanitized.summary = sanitizeText(data.summary, 240);
      sanitized.items = Array.from(data.items || [])
        .slice(0, 100)
        .map((item) => ({
          label: sanitizeText(item?.label, 160),
          status: stableToken(item?.status, 30),
        }))
        .filter((item) => item.label || item.status);
    }

    return appendEvent(`toolkit-${kind}`, sanitized);
  }

  function candidatePostUrl(
    value,
    sourceHostname = globalThis.location?.hostname,
  ) {
    const sanitized = sanitizeUrl(value, globalThis.location?.href);
    if (!sanitized) return "";
    const url = new URL(sanitized);
    const platform = platformFor(sourceHostname);

    if (platform === "X") {
      const match = url.pathname.match(
        /^\/([a-z0-9_]{1,15})\/status\/(\d+)\/?$/i,
      );
      return url.hostname === "x.com" && match
        ? `https://x.com/${match[1]}/status/${match[2]}`
        : "";
    }

    if (platform === "Redgifs") {
      const match = url.pathname.match(/^\/watch\/([a-z0-9-]+)\/?$/i);
      return platformFor(url.hostname) === platform && match
        ? `https://www.redgifs.com/watch/${match[1]}`
        : "";
    }

    if (platform === "Reddit") {
      const match = url.pathname.match(
        /^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)\/([a-z0-9_-]+)\/?$/i,
      );
      return platformFor(url.hostname) === platform && match
        ? `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/${match[3]}`
        : "";
    }

    if (
      platform === "Pornhub" &&
      ["pornhub.com", "www.pornhub.com"].includes(url.hostname) &&
      url.pathname.toLowerCase() === "/view_video.php"
    ) {
      const viewkey = stableToken(url.searchParams.get("viewkey"), 80);
      return /^[a-z0-9]+$/i.test(viewkey)
        ? `${url.origin}/view_video.php?viewkey=${encodeURIComponent(viewkey)}`
        : "";
    }

    if (platform === "Unsupported" || platformFor(url.hostname) !== platform) {
      return "";
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const contentIndex = segments.findIndex((segment) =>
      /^(?:post|posts|video|videos)$/i.test(segment),
    );
    const identifier = segments[contentIndex + 1] || "";
    const safeIdentifier =
      /^\d+$/.test(identifier) ||
      /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(identifier) ||
      (/^[a-z0-9_]{8,}$/i.test(identifier) && /\d/.test(identifier));
    if (contentIndex >= 0 && safeIdentifier) {
      return `${url.origin}/${segments[contentIndex]}/${identifier}`;
    }

    if (platform === "OnlyFans" && /^\d+$/.test(segments[0] || "")) {
      return `${url.origin}/${segments[0]}`;
    }

    return "";
  }

  function actionElementSignature(element) {
    const signature = elementSignature(element);
    if (!signature?.label) {
      const text = safeActionText(element?.textContent);
      if (text) signature.label = text;
    }
    return signature;
  }

  function handleClick(event) {
    const element = actionableEventElement(event);
    if (!element) return;
    /** @type {Record<string, any>} */
    const data = {
      ...interactionContext(event, element),
      control: actionElementSignature(element),
    };
    const href =
      element.tagName?.toLowerCase() === "a"
        ? candidatePostUrl(element.href)
        : "";
    if (href) data.url = href;
    void appendEvent("click", data);
    if (element.tagName?.toLowerCase() === "input" && element.type === "file") {
      // Some pickers detach or clear before the document's change listener runs.
      element.addEventListener("change", handleChange, {
        capture: true,
        once: true,
      });
    }
  }

  function handleChange(event) {
    const input = eventElement(event);
    const tag = input?.tagName?.toLowerCase();
    if (!["input", "select", "textarea"].includes(tag)) return;
    const type = input.getAttribute?.("type")?.toLowerCase() || "";
    const context = interactionContext(event, input);

    if (tag !== "input" || type !== "file") {
      /** @type {Record<string, any>} */
      const data = {
        ...context,
        control: elementSignature(input),
      };
      if (tag === "select") {
        data.selectedLabels = structuredLabels(
          Array.from(input.selectedOptions || []).map(
            (option) => option.textContent,
          ),
        );
      } else if (["checkbox", "radio"].includes(type)) {
        data.checked = Boolean(input.checked);
      } else {
        data.valueState = String(input.value || "") ? "nonempty" : "empty";
      }
      void appendEvent("control-change", data);
      return;
    }

    const files = Array.from(input.files || [])
      .slice(0, 20)
      .map((file) => ({
        name: sanitizeFilename(file.name),
        size: Number(file.size) || 0,
        type: stableToken(file.type, 100),
      }));
    if (files.length) {
      void appendEvent("file-selected", {
        ...context,
        control: elementSignature(input),
        files,
        assetRole,
      });
    }
  }

  function handleInput(event) {
    const control = editableEventElement(event);
    if (!control) return;
    const tag = control.tagName?.toLowerCase();
    const type = control.getAttribute?.("type")?.toLowerCase() || "";
    if (
      tag === "select" ||
      type === "file" ||
      ["checkbox", "radio"].includes(type)
    ) {
      return;
    }
    const value = control.isContentEditable
      ? control.textContent
      : control.value;
    void appendEvent("control-change", {
      ...interactionContext(event, control),
      control: elementSignature(control),
      valueState: hasMeaningfulEditorText(value) ? "nonempty" : "empty",
    });
  }

  function handleSubmit(event) {
    const form = eventElement(event);
    if (form?.tagName?.toLowerCase() !== "form") return;
    void appendEvent("submit", {
      ...interactionContext(event, form),
      form: elementSignature(form),
      submitter: elementSignature(event.submitter),
    });
  }

  function handleKeydown(event) {
    if (!["Enter", "Tab", "Escape"].includes(event.key)) return;
    const element = eventElement(event);
    if (!element) return;
    void appendEvent("control-key", {
      ...interactionContext(event, element),
      key: event.key,
      control: elementSignature(element),
    });
  }

  function isVisible(element) {
    if (!element?.isConnected || element.hidden) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }

  function inPublishingScope(element) {
    if (platformFor(location.hostname) !== "Fansly") return true;
    return Boolean(
      element?.closest?.(
        "app-post-creation, app-account-media-upload, app-post-schedule-modal, app-media-upload-modal, [data-testid='upload-composer'], [data-creator-toolkit-panel]",
      ),
    );
  }

  function statusSnapshot() {
    const statuses = [];
    let candidates = 0;
    for (const element of document.querySelectorAll(
      '[role="status"],[role="alert"],[role="progressbar"],progress,[aria-busy="true"]',
    )) {
      candidates += 1;
      if (candidates > MAX_SNAPSHOT_CANDIDATES || statuses.length >= 12) break;
      if (
        isRecorderNode(element) ||
        !isVisible(element) ||
        !inPublishingScope(element) ||
        element.classList.contains("rmp-seek-bar")
      )
        continue;
      const role = element.getAttribute("role") || "";
      const rawText = String(element.textContent || "").trim();
      const states = STATUS_PATTERN.test(rawText)
        ? STATUS_STATE_PATTERNS.filter(([, pattern]) =>
            pattern.test(rawText),
          ).map(([state]) => state)
        : [];
      const progress =
        element.getAttribute("aria-valuenow") ||
        (element.tagName?.toLowerCase() === "progress" && "value" in element
          ? String(element.value)
          : "");
      if (!states.length && !progress && role !== "progressbar") continue;
      statuses.push({
        control: elementSignature(element),
        ...(states.length ? { states } : {}),
        ...(progress ? { progress: stableToken(progress, 30) } : {}),
      });
    }
    return statuses;
  }

  function semanticSnapshot() {
    const fileInputs = [];
    let candidates = 0;
    for (const element of document.querySelectorAll('input[type="file"]')) {
      candidates += 1;
      if (candidates > MAX_SNAPSHOT_CANDIDATES || fileInputs.length >= 8) break;
      if (
        !isRecorderNode(element) &&
        inPublishingScope(element) &&
        (isVisible(element) ||
          element.closest(
            "form, app-post-creation, .uppy-Dashboard, [role='dialog'], .modal",
          ))
      ) {
        fileInputs.push({
          ...elementSignature(element),
          hidden: !isVisible(element),
          locatorMatches: Math.min(
            document.querySelectorAll("input[type='file']").length,
            MAX_SNAPSHOT_CANDIDATES,
          ),
        });
      }
    }

    const actions = [];
    candidates = 0;
    for (const element of document.querySelectorAll(
      'button,input[type="button"],input[type="submit"],[role="button"]',
    )) {
      candidates += 1;
      if (candidates > MAX_SNAPSHOT_CANDIDATES || actions.length >= 12) break;
      if (isRecorderNode(element) || !inPublishingScope(element)) continue;
      const signature = elementSignature(element);
      if (ACTION_PATTERN.test(signature?.label || "") && isVisible(element)) {
        actions.push(signature);
      }
    }

    const links = [];
    const seenLinks = new Set();
    candidates = 0;
    for (const element of document.querySelectorAll("a[href]")) {
      candidates += 1;
      if (candidates > MAX_SNAPSHOT_CANDIDATES || links.length >= 12) break;
      if (isRecorderNode(element) || !inPublishingScope(element)) continue;
      const candidate = candidatePostUrl(element.getAttribute("href"));
      if (!candidate || seenLinks.has(candidate) || !isVisible(element))
        continue;
      seenLinks.add(candidate);
      links.push(candidate);
    }
    return {
      route: sanitizeUrl(location.href),
      fileInputs,
      actions,
      statuses: statusSnapshot(),
      calendar: [
        ...document.querySelectorAll(
          "[class*='calendar'] [class*='month'], [class*='calendar'] [class*='year']",
        ),
      ]
        .slice(0, MAX_SNAPSHOT_CANDIDATES)
        .filter(
          (element) =>
            isVisible(element) &&
            /^(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?|\d{4})$/i.test(
              element.textContent.trim(),
            ),
        )
        .slice(0, 8)
        .map((element) => ({
          control: elementSignature(element),
          value: element.textContent.trim(),
        })),
      mediaControls: [
        ...document.querySelectorAll(
          ".b-dropzone__preview__delete, app-account-media-upload app-account-media-template, app-post-creation app-account-media-template",
        ),
      ]
        .filter(isVisible)
        .slice(0, 20)
        .map((element) => ({
          control: elementSignature(element),
          parent: elementSignature(element.parentElement),
        })),
      links,
    };
  }

  function scheduleSnapshot() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (!currentTrace?.active) return;
      const snapshot = semanticSnapshot();
      const signature = JSON.stringify(snapshot);
      if (signature === lastSnapshot) return;
      lastSnapshot = signature;
      void appendEvent("semantic-snapshot", snapshot);
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  function observeMutations() {
    mutationObserver = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !isRecorderNode(record.target) &&
            (record.type === "attributes" ||
              Array.from(record.addedNodes || []).some(
                (node) => !isRecorderNode(node),
              )),
        )
      ) {
        scheduleSnapshot();
      }
    });
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy", "aria-valuenow", "href", "role"],
    });
  }

  function observeResources() {
    if (typeof PerformanceObserver !== "function") return;
    performanceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!RESOURCE_INITIATORS.has(entry.initiatorType)) continue;
        const url = sanitizeResourceUrl(entry.name, location.href);
        if (!url) continue;
        void appendEvent("resource", {
          url,
          initiatorType: entry.initiatorType,
          durationMs: Math.max(0, Math.round(entry.duration)),
        });
      }
    });
    performanceObserver.observe({ type: "resource", buffered: false });
  }

  function pollRouteAndTimeout() {
    if (!currentTrace?.active || currentTrace.origin !== location.origin)
      return;
    if (Date.now() >= currentTrace.expiresAt) {
      void stopSession("timeout", false);
      return;
    }
    const route = sanitizeUrl(location.href);
    if (route !== lastRoute) {
      lastRoute = route;
      void appendEvent("route", { route });
      scheduleSnapshot();
    }
  }

  function startObservers() {
    stopObservers();
    if (!currentTrace?.active || currentTrace.origin !== location.origin)
      return;
    lastRoute = sanitizeUrl(location.href);
    lastSnapshot = "";
    document.addEventListener("click", handleClick, true);
    document.addEventListener("change", handleChange, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("keydown", handleKeydown, true);
    observeMutations();
    observeResources();
    routeTimer = setInterval(pollRouteAndTimeout, ROUTE_POLL_MS);
    snapshotPollTimer = setInterval(scheduleSnapshot, SNAPSHOT_POLL_MS);
  }

  function stopObservers() {
    clearInterval(routeTimer);
    clearInterval(snapshotPollTimer);
    clearTimeout(snapshotTimer);
    routeTimer = null;
    snapshotPollTimer = null;
    snapshotTimer = null;
    mutationObserver?.disconnect();
    performanceObserver?.disconnect();
    mutationObserver = null;
    performanceObserver = null;
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("change", handleChange, true);
    document.removeEventListener("input", handleInput, true);
    document.removeEventListener("submit", handleSubmit, true);
    document.removeEventListener("keydown", handleKeydown, true);
  }

  function showPanelError(error) {
    if (!panel) return;
    panel.status.textContent = `Recorder error: ${sanitizeText(error?.message || error)}`;
    panel.status.dataset.tone = "error";
  }

  function renderPanel() {
    if (!panel) return;
    const activeHere = ownsTrace(currentTrace);
    const activeElsewhere = currentTrace?.active && !activeHere;
    panel.start.disabled = Boolean(currentTrace?.active);
    panel.stop.disabled = !activeHere;
    panel.download.disabled = !currentTrace || currentTrace.active;
    panel.discard.disabled = !currentTrace || currentTrace.active;
    panel.status.dataset.tone = activeHere ? "recording" : "idle";
    if (activeHere) {
      panel.status.textContent = `Recording ${currentTrace.platform} — ${currentTrace.events.length}/${MAX_EVENTS} events`;
    } else if (activeElsewhere) {
      panel.status.textContent = `A trace is active on ${currentTrace.platform}.`;
    } else if (currentTrace) {
      panel.status.textContent = `Saved ${currentTrace.platform} trace — ${currentTrace.events.length} events`;
    } else {
      panel.status.textContent = "Ready. Recording never starts automatically.";
    }
  }

  function makeButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      void onClick().catch(showPanelError);
    });
    return button;
  }

  function hidePanel() {
    panel?.host.remove();
    panel = null;
    return true;
  }

  function showPanel() {
    if (!panel) mountPanel();
    return true;
  }

  function mountPanel() {
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("aside");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel { box-sizing: border-box; width: min(360px, calc(100vw - 32px)); padding: 13px; border: 1px solid #61556e; border-radius: 12px; background: #19151f; color: #f8f5fb; box-shadow: 0 12px 34px rgba(0,0,0,.45); font: 13px/1.4 system-ui, sans-serif; }
      .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 5px; }
      h2 { margin: 0; font-size: 14px; }
      p { margin: 0 0 10px; color: #cfc6d8; }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; }
      button { border: 1px solid #675a75; border-radius: 8px; padding: 7px 9px; background: #2b2434; color: white; font: inherit; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: rgba(182,160,255,.2); }
      .actions button:first-child { border-color: #8e6df2; background: #7452dc; }
      .hide { width: auto; padding: 4px 7px; background: transparent; color: #cfc6d8; font-size: 12px; }
      button:hover:not(:disabled) { background: #3a3046; }
      .actions button:first-child:hover:not(:disabled) { background: #8564e8; }
      button:focus-visible { outline: 2px solid #b6a0ff; outline-offset: 2px; }
      button:disabled { opacity: .45; cursor: default; }
      [role="status"] { margin-top: 10px; padding: 8px; border-radius: 8px; background: #282230; color: #ddd5e5; }
      [data-tone="recording"] { background: #1e3c32; color: #d8ffef; }
      [data-tone="error"] { background: #4a252b; color: #ffd9dd; }
    `;
    const frame = document.createElement("section");
    frame.className = "panel";
    const headingRow = document.createElement("div");
    headingRow.className = "heading";
    const heading = document.createElement("h2");
    heading.textContent = "Upload trace recorder";
    const hide = makeButton("Hide trace recorder", async () => hidePanel());
    hide.className = "hide";
    headingRow.append(heading, hide);
    const description = document.createElement("p");
    description.textContent =
      "Captures sanitized events locally; never publishes.";
    const actions = document.createElement("div");
    const role = document.createElement("select");
    role.setAttribute("aria-label", "Recorded asset role");
    for (const value of ["full", "teaser", "thumbnail"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      role.append(option);
    }
    role.addEventListener("change", () => {
      assetRole = role.value;
    });
    actions.className = "actions";
    const start = makeButton("Start trace", startSession);
    const stop = makeButton("Stop and download", () =>
      stopSession("manual", true),
    );
    const download = makeButton("Download last trace", async () => {
      const trace = await readTrace();
      if (trace) downloadTrace(trace);
    });
    const discard = makeButton("Discard saved trace", async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      currentTrace = null;
      renderPanel();
    });
    actions.append(start, stop, download, discard);
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    frame.append(headingRow, description, role, actions, status);
    shadow.append(style, frame);
    (document.documentElement || document.body).appendChild(host);
    panel = { host, start, stop, download, discard, status };
    renderPanel();
  }

  async function initialize() {
    if (chrome.runtime?.sendMessage) {
      const response = await chrome.runtime.sendMessage({
        type: "GET_UPLOAD_TRACE_CONTEXT",
      });
      ownerId = response?.ownerId || "";
    } else {
      ownerId =
        globalThis.sessionStorage.getItem("creatorTraceOwner") || sessionId();
      globalThis.sessionStorage.setItem("creatorTraceOwner", ownerId);
    }
    currentTrace = await readTrace();
    if (ownsTrace(currentTrace) && Date.now() >= currentTrace.expiresAt) {
      await stopSession("timeout", false);
    } else if (ownsTrace(currentTrace)) {
      showPanel();
      startObservers();
      scheduleSnapshot();
    }
    renderPanel();
  }

  function storageChanged(changes, area) {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    currentTrace = changes[STORAGE_KEY].newValue || null;
    if (ownsTrace(currentTrace)) {
      if (!routeTimer) startObservers();
    } else {
      stopObservers();
    }
    renderPanel();
  }

  globalThis.CreatorUploadTraceRecorder = Object.freeze({
    sanitizeUrl,
    sanitizeFilename,
    sanitizeResourceUrl,
    sanitizeText,
    elementSignature,
    appendBoundedEvent,
    platformFor,
    candidatePostUrl,
    recordToolkitEvent,
    showPanel,
    hidePanel,
  });

  if (globalThis.document && globalThis.chrome?.storage?.local) {
    chrome.storage.onChanged?.addListener(storageChanged);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => void initialize(), {
        once: true,
      });
    } else {
      void initialize().catch(showPanelError);
    }
  }
})();
