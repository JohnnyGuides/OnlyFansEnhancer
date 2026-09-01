(() => {
  "use strict";

  if (globalThis.CreatorToolkit) return;

  const registry = globalThis.CreatorToolkitRegistry;
  if (!registry) {
    throw new Error("CreatorToolkitRegistry must load before common.js");
  }

  const PANEL_STACK_ID = "creator-toolkit-panel-stack";
  const ROUTE_POLL_MS = 400;
  const MAX_LOG_ENTRIES = 100;

  function traceToolkitEvent(kind, data) {
    try {
      const outcome =
        globalThis.CreatorUploadTraceRecorder?.recordToolkitEvent?.(kind, data);
      if (outcome && typeof outcome.catch === "function") {
        void outcome.catch(() => {});
      }
    } catch {
      // Tracing is optional and must never affect a helper action.
    }
  }

  class ToolkitError extends Error {
    constructor(code, message, details = null) {
      super(message);
      this.name = "ToolkitError";
      this.code = code;
      this.details = details;
    }
  }

  class AbortToolkitError extends ToolkitError {
    constructor(message = "Operation stopped.") {
      super("ABORTED", message);
      this.name = "AbortError";
    }
  }

  function chromeLastError() {
    return globalThis.chrome?.runtime?.lastError || null;
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome?.storage?.local) {
        reject(
          new ToolkitError(
            "STORAGE_UNAVAILABLE",
            "Chrome storage is unavailable.",
          ),
        );
        return;
      }
      chrome.storage.local.get(keys, (value) => {
        const error = chromeLastError();
        if (error)
          reject(new ToolkitError("STORAGE_READ_FAILED", error.message));
        else resolve(value || {});
      });
    });
  }

  /** @returns {Promise<void>} */
  function storageSet(value) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome?.storage?.local) {
        reject(
          new ToolkitError(
            "STORAGE_UNAVAILABLE",
            "Chrome storage is unavailable.",
          ),
        );
        return;
      }
      chrome.storage.local.set(value, () => {
        const error = chromeLastError();
        if (error)
          reject(new ToolkitError("STORAGE_WRITE_FAILED", error.message));
        else resolve();
      });
    });
  }

  async function loadSettings() {
    const stored = await storageGet([
      registry.STORAGE_KEY,
      registry.LEGACY_STORAGE_KEY,
    ]);
    const current = stored[registry.STORAGE_KEY];
    if (current) {
      const normalized = registry.normalizeSettings(current).value;
      if (JSON.stringify(current) !== JSON.stringify(normalized)) {
        await storageSet({ [registry.STORAGE_KEY]: normalized });
      }
      return normalized;
    }

    const migrated = registry.migrateLegacySettings(
      stored[registry.LEGACY_STORAGE_KEY],
    );
    await storageSet({ [registry.STORAGE_KEY]: migrated });
    return migrated;
  }

  async function saveSettings(settings) {
    const normalized = registry.normalizeSettings(settings);
    if (normalized.errors.length) {
      throw new ToolkitError(
        "INVALID_SETTINGS",
        normalized.errors.join(" "),
        normalized.errors,
      );
    }
    await storageSet({ [registry.STORAGE_KEY]: normalized.value });
    return normalized.value;
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en-US");
  }

  function displayText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw new AbortToolkitError(
        typeof signal.reason === "string"
          ? signal.reason
          : "Operation stopped.",
      );
    }
  }

  /** @returns {Promise<void>} */
  function sleep(milliseconds, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(done, Math.max(0, milliseconds));

      function done() {
        signal?.removeEventListener("abort", aborted);
        resolve();
      }

      function aborted() {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", aborted);
        reject(
          new AbortToolkitError(
            typeof signal.reason === "string"
              ? signal.reason
              : "Operation stopped.",
          ),
        );
      }

      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  /**
   * @param {() => any} read
   * @param {{
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   *   intervalMs?: number,
   *   description?: string
   * }} [options]
   */
  async function waitFor(
    read,
    {
      signal,
      timeoutMs = 10000,
      intervalMs = 80,
      description = "condition",
    } = {},
  ) {
    const deadline = performance.now() + timeoutMs;
    let lastError = null;
    while (performance.now() <= deadline) {
      throwIfAborted(signal);
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs, signal);
    }
    throw new ToolkitError(
      "TIMEOUT",
      `Timed out waiting for ${description}.`,
      lastError ? String(lastError.message || lastError) : null,
    );
  }

  /**
   * @param {() => any} read
   * @param {{
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   *   intervalMs?: number,
   *   stableMs?: number,
   *   signature?: (value: any) => string,
   *   description?: string
   * }} [options]
   */
  async function waitForStable(
    read,
    {
      signal,
      timeoutMs = 10000,
      intervalMs = 100,
      stableMs = 400,
      signature = (value) => JSON.stringify(value),
      description = "stable state",
    } = {},
  ) {
    const deadline = performance.now() + timeoutMs;
    let previousSignature = null;
    let stableSince = 0;
    let previousValue = null;

    while (performance.now() <= deadline) {
      throwIfAborted(signal);
      const value = read();
      if (value) {
        const currentSignature = signature(value);
        if (currentSignature === previousSignature) {
          if (performance.now() - stableSince >= stableMs) return value;
        } else {
          previousSignature = currentSignature;
          stableSince = performance.now();
          previousValue = value;
        }
      } else {
        previousSignature = null;
        stableSince = 0;
        previousValue = null;
      }
      await sleep(intervalMs, signal);
    }

    throw new ToolkitError(
      "TIMEOUT",
      `Timed out waiting for ${description}.`,
      previousValue,
    );
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    return element.getClientRects().length > 0;
  }

  function isEnabledElement(element) {
    return (
      isVisible(element) &&
      !element.matches(":disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    );
  }

  function queryVisibleAll(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).filter(isVisible);
  }

  function queryUnique(selector, root = document, options = {}) {
    const matches = Array.from(root.querySelectorAll(selector)).filter(
      (element) =>
        options.requireVisible === false
          ? element.isConnected
          : isVisible(element),
    );
    if (matches.length === 1) return matches[0];
    if (!matches.length && options.optional) return null;
    throw new ToolkitError(
      matches.length ? "AMBIGUOUS_SELECTOR" : "MISSING_SELECTOR",
      matches.length
        ? `Expected one ${options.description || selector}; found ${matches.length}.`
        : `Could not find ${options.description || selector}.`,
    );
  }

  function accessibleName(element) {
    if (!(element instanceof Element)) return "";
    return displayText(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent ||
        element.getAttribute("value") ||
        "",
    );
  }

  function resolveExact(elements, expected, getLabel = accessibleName) {
    const normalizedExpected = normalizeText(expected);
    const matches = Array.from(elements).filter(
      (element) => normalizeText(getLabel(element)) === normalizedExpected,
    );
    if (matches.length === 1) {
      return { status: "found", element: matches[0], expected };
    }
    return {
      status: matches.length ? "ambiguous" : "missing",
      expected,
      matches,
    };
  }

  function requireExact(elements, expected, getLabel = accessibleName) {
    const resolution = resolveExact(elements, expected, getLabel);
    if (resolution.status === "found") return resolution.element;
    throw new ToolkitError(
      resolution.status === "ambiguous" ? "AMBIGUOUS_TARGET" : "MISSING_TARGET",
      resolution.status === "ambiguous"
        ? `More than one exact match exists for “${expected}”.`
        : `No exact match exists for “${expected}”.`,
    );
  }

  function nativeValueSetter(element) {
    let prototype = Object.getPrototypeOf(element);
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) return descriptor.set;
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  function setNativeValue(element, value) {
    if (!element || !("value" in element)) {
      throw new ToolkitError(
        "INVALID_CONTROL",
        "Control has no value property.",
      );
    }
    const setter = nativeValueSetter(element);
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function dispatchValueEvents(element, inputType = "insertReplacementText") {
    try {
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType,
          data: null,
        }),
      );
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setControlValue(element, value) {
    setNativeValue(element, value);
    dispatchValueEvents(element);
    traceToolkitEvent("control-action", {
      action: "set-value",
      control: element,
    });
  }

  function clickElement(element, signal) {
    throwIfAborted(signal);
    if (!isEnabledElement(element)) {
      throw new ToolkitError(
        "CONTROL_NOT_ACTIONABLE",
        `Control “${accessibleName(element) || element?.tagName || "unknown"}” is not actionable.`,
      );
    }
    element.click();
    traceToolkitEvent("control-action", {
      action: "click",
      control: element,
    });
  }

  function selectedOptionValues(select) {
    return Array.from(select.selectedOptions || [])
      .map((option) => option.value)
      .filter((value) => value !== "");
  }

  function selectedOptionLabels(select) {
    return Array.from(select.selectedOptions || []).map((option) =>
      displayText(option.textContent),
    );
  }

  function setSelectValues(select, values) {
    const desired = new Set(values.map(String));
    for (const option of Array.from(select.options || [])) {
      option.selected = desired.has(String(option.value));
    }
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    traceToolkitEvent("control-action", {
      action: "select-values",
      control: select,
      selectedLabels: selectedOptionLabels(select),
    });
  }

  /**
   * @param {string} selector
   * @param {{
   *   root?: Document | ShadowRoot | Element,
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   *   minimumOptions?: number
   * }} [options]
   */
  async function waitForStableSelect(
    selector,
    { root = document, signal, timeoutMs = 15000, minimumOptions = 1 } = {},
  ) {
    return waitForStable(
      () => {
        const select = root.querySelector(selector);
        if (
          !(select instanceof HTMLSelectElement) ||
          !isVisible(select) ||
          select.options.length < minimumOptions
        ) {
          return null;
        }
        return select;
      },
      {
        signal,
        timeoutMs,
        description: `stable select ${selector}`,
        signature: (select) =>
          Array.from(select.options)
            .map(
              (option) =>
                `${option.value}\u0000${displayText(option.textContent)}`,
            )
            .join("\u0001"),
      },
    );
  }

  function createLinkedAbortController(parentSignal) {
    const controller = new AbortController();
    if (!parentSignal) return controller;
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
      return controller;
    }
    parentSignal.addEventListener(
      "abort",
      () => controller.abort(parentSignal.reason),
      { once: true },
    );
    return controller;
  }

  function createBudget(
    signal,
    { maxActions = 100, maxDurationMs = 120000 } = {},
  ) {
    const startedAt = performance.now();
    let actions = 0;
    return Object.freeze({
      step(count = 1) {
        throwIfAborted(signal);
        if (performance.now() - startedAt > maxDurationMs) {
          throw new ToolkitError(
            "DURATION_LIMIT",
            `Stopped after the ${maxDurationMs} ms duration limit.`,
          );
        }
        if (actions + count > maxActions) {
          throw new ToolkitError(
            "ACTION_LIMIT",
            `Stopped before exceeding the ${maxActions}-action limit.`,
          );
        }
        actions += count;
        return actions;
      },
      check() {
        throwIfAborted(signal);
        if (performance.now() - startedAt > maxDurationMs) {
          throw new ToolkitError(
            "DURATION_LIMIT",
            `Stopped after the ${maxDurationMs} ms duration limit.`,
          );
        }
      },
      get actions() {
        return actions;
      },
      get elapsedMs() {
        return Math.round(performance.now() - startedAt);
      },
    });
  }

  function ensurePanelStack() {
    let host = document.getElementById(PANEL_STACK_ID);
    if (host) return host.shadowRoot.querySelector(".stack");

    host = document.createElement("div");
    host.id = PANEL_STACK_ID;
    host.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .stack {
        display: flex;
        flex-direction: column-reverse;
        align-items: flex-end;
        gap: 10px;
        max-height: calc(100vh - 32px);
        overflow: auto;
        pointer-events: none;
      }
    `;
    const stack = document.createElement("div");
    stack.className = "stack";
    shadow.append(style, stack);
    (document.documentElement || document.body).appendChild(host);
    return stack;
  }

  function createToolPanel({ id, title, description = "" }) {
    const stack = ensurePanelStack();
    const existing = stack.querySelector(
      `[data-creator-toolkit-panel="${CSS.escape(id)}"]`,
    );
    existing?.remove();
    const host = document.createElement("section");
    host.dataset.creatorToolkitPanel = id;
    host.style.cssText = "all:initial;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel {
        box-sizing: border-box;
        width: min(390px, calc(100vw - 32px));
        max-height: min(560px, calc(100vh - 32px));
        overflow: auto;
        border: 1px solid #4a405a;
        border-radius: 14px;
        background: #1b1722;
        color: #f8f6fb;
        box-shadow: 0 14px 40px rgba(0, 0, 0, .48);
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      header { padding: 12px 14px 8px; border-bottom: 1px solid #342c40; }
      h2 { margin: 0; font-size: 14px; line-height: 1.3; }
      p { margin: 5px 0 0; color: #c8c0d2; }
      .body { padding: 12px 14px 14px; }
      .fields { display: grid; gap: 8px; margin-bottom: 10px; }
      .field { display: grid; gap: 4px; color: #d8d0e1; }
      .field span { font-size: 12px; }
      select, input {
        box-sizing: border-box;
        width: 100%;
        border: 1px solid #5c506e;
        border-radius: 8px;
        padding: 7px 8px;
        background: #25202e;
        color: #fff;
        font: inherit;
      }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; }
      button {
        box-sizing: border-box;
        border: 1px solid #5c506e;
        border-radius: 9px;
        padding: 7px 10px;
        background: #2b2435;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      button:hover:not(:disabled) { background: #392f47; }
      button.primary { border-color: #8e6df2; background: #7452dc; }
      button.danger { border-color: #b66; background: #6f2d35; }
      button:disabled { opacity: .52; cursor: default; }
      .status {
        min-height: 1.45em;
        margin-top: 10px;
        padding: 8px 9px;
        border-radius: 8px;
        background: #25202e;
        color: #ddd6e6;
        white-space: pre-wrap;
      }
      .status[data-tone="error"] { background: #48242a; color: #ffd8dc; }
      .status[data-tone="success"] { background: #1f3a31; color: #d5ffed; }
      .status[data-tone="warning"] { background: #43371f; color: #fff0bf; }
      .plan { margin-top: 10px; border-top: 1px solid #342c40; padding-top: 10px; }
      .plan[hidden] { display: none; }
      .plan strong { display: block; margin-bottom: 6px; }
      .plan ul { margin: 0 0 9px; padding-left: 19px; }
      .plan li { margin: 3px 0; color: #ded8e6; overflow-wrap: anywhere; }
      .result { margin-top: 8px; font-size: 12px; color: #bdb4ca; }
      .result div { margin-top: 3px; }
      .result [data-status="failed"],
      .result [data-status="ambiguous"] { color: #ffb9c0; }
      .result [data-status="changed"],
      .result [data-status="success"] { color: #bff7de; }
    `;

    const panel = document.createElement("div");
    panel.className = "panel";
    const header = document.createElement("header");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const intro = document.createElement("p");
    intro.textContent = description;
    header.append(heading);
    if (description) header.append(intro);

    const body = document.createElement("div");
    body.className = "body";
    const fields = document.createElement("div");
    fields.className = "fields";
    const actions = document.createElement("div");
    actions.className = "actions";
    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Ready.";

    const plan = document.createElement("div");
    plan.className = "plan";
    plan.hidden = true;
    const result = document.createElement("div");
    result.className = "result";

    body.append(fields, actions, status, plan, result);
    panel.append(header, body);
    shadow.append(style, panel);
    stack.appendChild(host);

    const actionButtons = new Map();
    let planGeneration = 0;

    function setStatus(message, tone = "neutral") {
      status.textContent = displayText(message);
      status.dataset.tone = tone;
    }

    function clearPlan() {
      planGeneration += 1;
      plan.replaceChildren();
      plan.hidden = true;
    }

    function showPlan({
      summary = "Review the proposed changes.",
      items = [],
      confirmLabel = "Apply",
      onConfirm,
    }) {
      clearPlan();
      const generation = planGeneration;
      plan.hidden = false;
      const headingNode = document.createElement("strong");
      headingNode.textContent = summary;
      const list = document.createElement("ul");
      for (const item of items) {
        const entry = document.createElement("li");
        entry.textContent = displayText(item);
        list.appendChild(entry);
      }
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "primary";
      confirm.textContent = confirmLabel;
      confirm.addEventListener("click", async (event) => {
        if (generation !== planGeneration) return;
        traceToolkitEvent("panel-action", {
          toolId: id,
          actor: event.isTrusted ? "user" : "script",
          actionId: "confirm",
          label: confirmLabel,
        });
        try {
          await onConfirm();
        } catch (error) {
          setStatus(error?.message || String(error), "error");
        }
      });
      plan.append(headingNode, list, confirm);
    }

    function addAction({
      id: actionId,
      label,
      variant = "",
      allowWhileRunning = false,
      onClick,
    }) {
      if (actionButtons.has(actionId)) {
        throw new ToolkitError(
          "DUPLICATE_ACTION",
          `Duplicate panel action ${actionId}.`,
        );
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = variant;
      button.dataset.allowWhileRunning = String(allowWhileRunning);
      button.addEventListener("click", async (event) => {
        traceToolkitEvent("panel-action", {
          toolId: id,
          actor: event.isTrusted ? "user" : "script",
          actionId,
          label,
        });
        try {
          await onClick();
        } catch (error) {
          setStatus(error?.message || String(error), "error");
        }
      });
      actionButtons.set(actionId, button);
      actions.appendChild(button);
      return button;
    }

    function addSelect({ id: fieldId, label, options, value, onChange }) {
      const wrapper = document.createElement("label");
      wrapper.className = "field";
      const labelNode = document.createElement("span");
      labelNode.textContent = label;
      const select = document.createElement("select");
      select.dataset.fieldId = fieldId;
      for (const optionValue of options) {
        const option = document.createElement("option");
        option.value = String(optionValue);
        option.textContent = String(optionValue);
        select.appendChild(option);
      }
      select.value = String(value);
      select.addEventListener("change", (event) => {
        traceToolkitEvent("panel-action", {
          toolId: id,
          actor: event.isTrusted ? "user" : "script",
          actionId: "select",
          fieldId,
          selection: select.value,
        });
        onChange?.(select.value);
      });
      wrapper.append(labelNode, select);
      fields.appendChild(wrapper);
      return select;
    }

    function setRunning(running) {
      for (const button of actionButtons.values()) {
        button.disabled =
          running && button.dataset.allowWhileRunning !== "true";
      }
      const confirm = plan.querySelector("button");
      if (confirm) confirm.disabled = running;
    }

    function showResult(runResult) {
      result.replaceChildren();
      const items = Array.isArray(runResult?.items) ? runResult.items : [];
      for (const item of items) {
        const line = document.createElement("div");
        line.dataset.status = item.status || "unknown";
        line.textContent = `${item.label}: ${item.status}${
          item.detail ? ` — ${item.detail}` : ""
        }`;
        result.appendChild(line);
      }
    }

    return Object.freeze({
      host,
      addAction,
      addSelect,
      setStatus,
      setRunning,
      showPlan,
      clearPlan,
      showResult,
      destroy() {
        host.remove();
        if (!stack.childElementCount) {
          document.getElementById(PANEL_STACK_ID)?.remove();
        }
      },
    });
  }

  function serializeLogResult(result) {
    return {
      status: displayText(result?.status || "unknown").slice(0, 30),
      summary: displayText(result?.summary || "").slice(0, 500),
      items: Array.isArray(result?.items)
        ? result.items.slice(0, 100).map((item) => ({
            label: displayText(item.label).slice(0, 200),
            status: displayText(item.status).slice(0, 30),
            detail: displayText(item.detail || "").slice(0, 500),
          }))
        : [],
    };
  }

  async function appendActionLog(toolId, result) {
    try {
      const stored = await storageGet(registry.ACTION_LOG_KEY);
      const previous = Array.isArray(stored[registry.ACTION_LOG_KEY])
        ? stored[registry.ACTION_LOG_KEY]
        : [];
      const entry = {
        id:
          globalThis.crypto?.randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        toolId,
        timestamp: new Date().toISOString(),
        url: location.href.slice(0, 1000),
        ...serializeLogResult(result),
      };
      await storageSet({
        [registry.ACTION_LOG_KEY]: [entry, ...previous].slice(
          0,
          MAX_LOG_ENTRIES,
        ),
      });
    } catch (error) {
      console.warn(
        "[Creator Workflow Toolkit] Could not write action log.",
        error,
      );
    }
  }

  function createActionRunner({
    toolId,
    panel,
    lifecycleSignal,
    maxActions = 100,
    maxDurationMs = 120000,
  }) {
    let activeController = null;

    async function run(label, task) {
      if (activeController) {
        throw new ToolkitError(
          "RUN_IN_PROGRESS",
          "Another action is already running.",
        );
      }
      activeController = createLinkedAbortController(lifecycleSignal);
      const signal = activeController.signal;
      const budget = createBudget(signal, { maxActions, maxDurationMs });
      panel.clearPlan();
      panel.setRunning(true);
      panel.setStatus(`${label}…`);
      traceToolkitEvent("run-start", { toolId, label });

      let result;
      try {
        result = await task({ signal, budget });
        throwIfAborted(signal);
        result = {
          status: result?.status || "success",
          summary: result?.summary || `${label} completed.`,
          items: Array.isArray(result?.items) ? result.items : [],
        };
        const tone =
          result.status === "success"
            ? "success"
            : result.status === "partial"
              ? "warning"
              : "error";
        panel.setStatus(result.summary, tone);
        panel.showResult(result);
        traceToolkitEvent("run-result", {
          toolId,
          status: result.status,
          summary: result.summary,
          items: result.items,
        });
        await appendActionLog(toolId, result);
        return result;
      } catch (error) {
        const aborted =
          error?.name === "AbortError" ||
          error?.code === "ABORTED" ||
          signal.aborted;
        result = {
          status: aborted ? "stopped" : "failed",
          summary: aborted
            ? error?.message || "Operation stopped."
            : error?.message || String(error),
          items: [],
        };
        panel.setStatus(result.summary, aborted ? "warning" : "error");
        panel.showResult(result);
        traceToolkitEvent("run-result", {
          toolId,
          status: result.status,
          summary: result.summary,
          items: result.items,
        });
        await appendActionLog(toolId, result);
        if (!aborted)
          console.error(`[Creator Workflow Toolkit] ${toolId}`, error);
        return result;
      } finally {
        activeController = null;
        panel.setRunning(false);
      }
    }

    return Object.freeze({
      run,
      stop(reason = "Stopped by user.") {
        activeController?.abort(reason);
      },
      get running() {
        return Boolean(activeController);
      },
    });
  }

  function routeMatches(matcher) {
    if (typeof matcher === "function") return matcher(location);
    if (matcher instanceof RegExp) return matcher.test(location.href);
    return true;
  }

  function mountTool({ id, match, mount }) {
    if (!Object.hasOwn(registry.TOOL_DEFINITIONS, id)) {
      throw new ToolkitError("UNKNOWN_TOOL", `Unknown tool ID “${id}”.`);
    }

    let disposed = false;
    let active = null;
    let evaluation = 0;
    let lastHref = location.href;

    async function unmount(reason) {
      const record = active;
      active = null;
      if (!record) return;
      record.controller.abort(reason);
      try {
        await record.dispose?.();
      } catch (error) {
        console.warn(`[Creator Workflow Toolkit] ${id} cleanup failed.`, error);
      }
    }

    async function evaluate(reason = "state change") {
      const token = ++evaluation;
      let settings;
      try {
        settings = await loadSettings();
      } catch (error) {
        await unmount("Settings unavailable.");
        console.error(
          `[Creator Workflow Toolkit] ${id} settings failed.`,
          error,
        );
        return;
      }
      if (disposed || token !== evaluation) return;

      const toolSettings = settings.tools[id];
      const shouldMount = toolSettings?.enabled === true && routeMatches(match);
      const fingerprint = JSON.stringify({
        tool: toolSettings,
        profile: settings.profiles[id],
        href: location.href,
      });

      if (active && (!shouldMount || active.fingerprint !== fingerprint)) {
        await unmount(
          shouldMount ? "Configuration or route changed." : "Tool disabled.",
        );
      }
      if (!shouldMount || active || disposed) return;

      const controller = new AbortController();
      const record = {
        controller,
        fingerprint,
        dispose: null,
      };
      active = record;

      try {
        const dispose = await mount({
          id,
          signal: controller.signal,
          settings: registry.clone(toolSettings),
          profile: registry.clone(settings.profiles[id]),
          reason,
        });
        if (active !== record || controller.signal.aborted) {
          await dispose?.();
          return;
        }
        record.dispose = typeof dispose === "function" ? dispose : null;
      } catch (error) {
        if (active === record) active = null;
        controller.abort("Mount failed.");
        console.error(`[Creator Workflow Toolkit] ${id} mount failed.`, error);
      }
    }

    const storageListener = (changes, area) => {
      if (
        area === "local" &&
        (changes[registry.STORAGE_KEY] || changes[registry.LEGACY_STORAGE_KEY])
      ) {
        void evaluate("settings changed");
      }
    };
    chrome.storage?.onChanged?.addListener(storageListener);

    const routeTimer = setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      void evaluate("route changed");
    }, ROUTE_POLL_MS);

    void evaluate("initial load");

    return async () => {
      disposed = true;
      ++evaluation;
      clearInterval(routeTimer);
      chrome.storage?.onChanged?.removeListener(storageListener);
      await unmount("Tool lifecycle disposed.");
    };
  }

  globalThis.CreatorToolkit = Object.freeze({
    ToolkitError,
    AbortToolkitError,
    registry,
    loadSettings,
    saveSettings,
    storageGet,
    storageSet,
    normalizeText,
    displayText,
    accessibleName,
    throwIfAborted,
    sleep,
    waitFor,
    waitForStable,
    isVisible,
    isEnabledElement,
    queryVisibleAll,
    queryUnique,
    resolveExact,
    requireExact,
    setNativeValue,
    setControlValue,
    dispatchValueEvents,
    clickElement,
    selectedOptionValues,
    selectedOptionLabels,
    setSelectValues,
    waitForStableSelect,
    createLinkedAbortController,
    createBudget,
    createToolPanel,
    createActionRunner,
    appendActionLog,
    mountTool,
  });
})();
