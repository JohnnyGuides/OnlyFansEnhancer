(() => {
  "use strict";

  if (globalThis.CreatorUploadPlatformAdapters) return;

  const DEFAULT_DOM_TIMEOUT = 30_000;
  const UPLOAD_TIMEOUT = 45 * 60_000;
  const UPLOAD_STALL_TIMEOUT = 10 * 60_000;
  const MANYVIDS_FULL_INPUT =
    "input.uppy-Dashboard-input[type='file']:not([webkitdirectory])";
  let mutationSignal = null;
  let reportProgress = null;
  let pauseObservation = null;
  let progressScope = null;

  function newCommandId() {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function abortIfNeeded(signal) {
    if (signal?.aborted)
      throw new DOMException("Upload cancelled.", "AbortError");
  }

  function visible(element) {
    if (!element || element.closest("[hidden]")) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }

  function enabled(element) {
    return Boolean(
      element &&
      !element.disabled &&
      !element.hasAttribute("disabled") &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.closest("fieldset[disabled],[aria-disabled='true']"),
    );
  }

  function verifyNoBlockingErrors(root, platform) {
    if (
      [
        ...root.querySelectorAll(
          "[aria-invalid='true'], [role='alert'], input:invalid, textarea:invalid, select:invalid",
        ),
      ].some(
        (element) =>
          visible(element) &&
          (element.getAttribute("role") !== "alert" ||
            element.textContent.trim()),
      )
    )
      throw new Error(
        `${platform} has a visible validation error; the draft is not ready.`,
      );
  }

  function one(selector, label, root = document, { allowHidden = false } = {}) {
    const candidates = [...root.querySelectorAll(selector)].filter(
      (element) => allowHidden || visible(element),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `${label} is ${candidates.length ? "ambiguous" : "missing"} (${candidates.length} matches).`,
      );
    }
    return candidates[0];
  }

  /** @param {Document | Element} root */
  function exactText(
    selector,
    text,
    label,
    root = document,
    { caseSensitive = false } = {},
  ) {
    const expected = caseSensitive
      ? String(text).trim()
      : String(text).trim().toLowerCase();
    const candidates = [...root.querySelectorAll(selector)].filter(
      (element) => {
        const actual = caseSensitive
          ? element.textContent.trim()
          : element.textContent.trim().toLowerCase();
        return visible(element) && actual === expected;
      },
    );
    if (candidates.length !== 1) {
      throw new Error(
        `${label} is ${candidates.length ? "ambiguous" : "missing"} (${candidates.length} matches).`,
      );
    }
    return candidates[0];
  }

  function click(element, label) {
    abortIfNeeded(mutationSignal);
    if (!visible(element) || !enabled(element)) {
      throw new Error(`${label} is unavailable.`);
    }
    element.click();
  }

  async function beforeCommit(context, platform) {
    abortIfNeeded(context.signal);
    if (publicationMode(context.draft) !== "autonomous") {
      throw new Error(`${platform} publication is forbidden in manual mode.`);
    }
    if (typeof context.beforeCommit !== "function") {
      throw new Error(`${platform} final action is not durably armed.`);
    }
    const result = await context.beforeCommit();
    if (result?.armed !== true) {
      throw new Error(`${platform} final action was not durably armed.`);
    }
    abortIfNeeded(context.signal);
  }

  function publicationMode(draft) {
    const mode = draft?.publishMode ?? "manual";
    if (mode !== "manual" && mode !== "autonomous")
      throw new Error("Invalid publishing mode; no actions were authorized.");
    return mode;
  }

  async function runSharedRecipe(adapter, plan, signal, maximumActions) {
    const toolkit = globalThis.CreatorToolkit;
    if (!adapter || !toolkit) return null;
    const result = await adapter.applyPlan(
      plan,
      signal,
      toolkit.createBudget(signal, {
        maxActions: maximumActions,
        maxDurationMs: 180_000,
      }),
    );
    if (result.status !== "success") {
      throw new Error(result.summary || "Shared metadata recipe stopped.");
    }
    return result;
  }

  async function waitFor(
    probe,
    label,
    timeoutMs = DEFAULT_DOM_TIMEOUT,
    signal,
  ) {
    const started = Date.now();
    const longUpload = timeoutMs === UPLOAD_TIMEOUT;
    let lastAdvance = started;
    let highestProgress = null;
    let informed = false;
    while (longUpload || Date.now() - started < timeoutMs) {
      abortIfNeeded(signal);
      const value = await probe();
      if (value) return value;
      if (longUpload) {
        const scopes =
          progressScope?.isConnected && visible(progressScope)
            ? [progressScope]
            : [];
        const bars = scopes
          .flatMap((scope) => [
            ...scope.querySelectorAll(
              "[role='progressbar'][aria-valuenow][aria-valuemax]",
            ),
          ])
          .filter(visible);
        const readings = bars
          .map(
            (bar) =>
              Number(bar.getAttribute("aria-valuenow")) /
              Number(bar.getAttribute("aria-valuemax")),
          )
          .filter(
            (value) => Number.isFinite(value) && value >= 0 && value <= 1,
          );
        // Multiple/unlabelled progress streams are not evidence of a stall.
        if (readings.length === 1) {
          if (highestProgress === null || readings[0] > highestProgress) {
            highestProgress = readings[0];
            lastAdvance = Date.now();
          } else if (
            Date.now() - lastAdvance >= UPLOAD_STALL_TIMEOUT &&
            readings[0] < 1
          ) {
            if (pauseObservation) {
              await reportProgress?.("upload-attention-required");
              await pauseObservation();
              abortIfNeeded(signal);
              lastAdvance = Date.now();
              await reportProgress?.("upload-observing");
              continue;
            }
            throw new Error(
              `upload-stalled: No observed progress for ten minutes while waiting for ${label}. Inspect the existing attachment before resuming; do not upload it again.`,
            );
          }
        } else {
          highestProgress = null;
          lastAdvance = Date.now();
        }
        if (!informed && Date.now() - started >= UPLOAD_TIMEOUT) {
          informed = true;
          await reportProgress?.(
            readings.length === 1
              ? "upload-observing"
              : "upload-progress-unknown",
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  function zonedParts(iso, timeZone) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
      throw new Error("Invalid scheduled time.");
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return {
      date: `${value.year}-${value.month}-${value.day}`,
      day: String(Number(value.day)),
      hour: value.hour,
      minute: value.minute,
    };
  }

  function fillTextControl(control, value) {
    abortIfNeeded(mutationSignal);
    const text = String(value || "");
    if (
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLInputElement
    ) {
      const prototype =
        control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        control,
        text,
      );
    } else if (
      control.isContentEditable ||
      control.getAttribute("role") === "textbox"
    ) {
      if (control.isContentEditable) {
        control.focus();
        const selection = document.getSelection();
        const range = document.createRange();
        range.selectNodeContents(control);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand("insertText", false, text))
          throw new Error("The rich-text editor rejected text insertion.");
      } else {
        throw new Error("The description editor is not editable.");
      }
    } else {
      throw new Error("The description control is unsupported.");
    }
    control.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: text,
        inputType: "insertText",
      }),
    );
    control.dispatchEvent(
      new Event("change", { bubbles: true, composed: true }),
    );
  }

  function normalizedFilename(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase();
  }

  function manyVidsEditControl(card, wait = false) {
    const candidates = [...card.querySelectorAll("button, a[href]")].filter(
      (button) =>
        enabled(button) &&
        (/^Button edit video : /.test(
          button.getAttribute("aria-label") || "",
        ) ||
          /^(edit|continue)$/i.test(button.textContent.trim())) &&
        !button.matches(
          ".uppy-Dashboard-Item-action--remove, [aria-label*='remove' i], [aria-label*='delete' i], [title*='delete' i]",
        ),
    );
    if (!candidates.length && wait) return null;
    if (candidates.length !== 1) {
      throw new Error(
        `ManyVids continue/edit control is ${candidates.length ? "ambiguous" : "missing"}.`,
      );
    }
    return candidates[0];
  }

  async function runManyVidsUpload(context) {
    const { draft, signal } = context;
    publicationMode(draft);
    abortIfNeeded(signal);
    const initialInput = one(
      MANYVIDS_FULL_INPUT,
      "ManyVids full-video input",
      document,
      {
        allowHidden: true,
      },
    );
    const dashboard = initialInput.closest(".uppy-Dashboard");
    if (!dashboard || !visible(dashboard))
      throw new Error("ManyVids owned upload dashboard is unavailable.");
    progressScope = dashboard;
    if (dashboard.querySelectorAll(".uppy-Dashboard-Item").length)
      throw new Error(
        "ManyVids existing queued media requires association review before attachment.",
      );
    let ownedCard = null;
    let uploadIdentity = "";
    const currentCard = () => {
      if (!dashboard.isConnected || !visible(dashboard))
        throw new Error("ManyVids owned dashboard changed.");
      const cards = [
        ...dashboard.querySelectorAll(".uppy-Dashboard-Item"),
      ].filter(visible);
      if (cards.length > 1)
        throw new Error("ManyVids upload association is ambiguous.");
      if (!cards.length) return null;
      const card = cards[0];
      const identity = card.getAttribute("data-upload-id") || card.id;
      if (
        ownedCard &&
        card !== ownedCard &&
        (!uploadIdentity || identity !== uploadIdentity)
      )
        throw new Error("ManyVids upload card identity changed.");
      const name =
        card.querySelector(".uppy-Dashboard-Item-name")?.textContent || "";
      if (
        normalizedFilename(name) !== normalizedFilename(draft.fullFilename) &&
        !(
          (!name || /\.\.\.|…/.test(name)) &&
          fileReceipt?.role === "full" &&
          fileReceipt.name === draft.fullFilename &&
          fileReceipt.size > 0
        )
      )
        throw new Error(
          "ManyVids selected media does not match the approved full role.",
        );
      ownedCard = card;
      uploadIdentity ||= identity;
      return card;
    };
    const currentEdit = () => {
      const card = currentCard();
      return card?.matches(
        "[data-state='upload-complete'], .is-complete, .uppy-Dashboard-Item--complete, [data-upload-complete='true']",
      )
        ? card
        : null;
    };
    const fileReceipt = await context.attachFile("full", MANYVIDS_FULL_INPUT);
    // Uppy has both auto-start and queued variants. Only the dashboard's
    // upload action is an intermediate action; editor Save is never used here.
    let uploadObserved = false;
    let uploadAttempts = 0;
    const uploadCommand = context.checkpointStep ? newCommandId() : "";
    await waitFor(
      async () => {
        if (currentEdit()) {
          uploadObserved = true;
          return true;
        }
        if (!dashboard.isConnected || !visible(dashboard))
          throw new Error(
            "ManyVids owned dashboard changed; inspect the existing queue.",
          );
        const cards = [...dashboard.querySelectorAll(".uppy-Dashboard-Item")];
        if (!cards.length) return false;
        if (cards.length !== 1)
          throw new Error("ManyVids upload association is ambiguous.");
        const card = currentCard();
        if (!card) return false;
        const name =
          card.querySelector(".uppy-Dashboard-Item-name")?.textContent || "";
        const exactName =
          normalizedFilename(name) === normalizedFilename(draft.fullFilename);
        const receiptMatches =
          fileReceipt?.role === "full" &&
          normalizedFilename(fileReceipt.name) ===
            normalizedFilename(draft.fullFilename) &&
          Number.isSafeInteger(fileReceipt.size) &&
          fileReceipt.size > 0;
        if (
          !exactName &&
          !(
            (!name || name.includes("...") || name.includes("…")) &&
            receiptMatches
          )
        )
          throw new Error(
            "ManyVids selected media does not match the approved full role.",
          );
        const actions = [
          ...dashboard.querySelectorAll(".uppy-StatusBar-actionBtn--upload"),
        ].filter(visible);
        if (actions.length > 1)
          throw new Error("ManyVids intermediate upload control is ambiguous.");
        const dashboardObservedUpload = Boolean(
          card.matches(
            "[data-state='uploading'], .is-uploading, [data-upload-started='true']",
          ) || dashboard.querySelector(".uppy-StatusBar.is-uploading"),
        );
        if (uploadAttempts > 0 && dashboardObservedUpload) {
          uploadObserved = true;
          return true;
        }
        if (
          actions.length === 1 &&
          enabled(actions[0]) &&
          uploadAttempts === 0
        ) {
          abortIfNeeded(signal);
          if (!uploadAttempts)
            await context.checkpointStep?.(
              "start-upload",
              uploadCommand,
              "intent",
            );
          const currentAction = one(
            ".uppy-StatusBar-actionBtn--upload",
            "ManyVids queued upload",
            dashboard,
          );
          const currentCards = [
            ...dashboard.querySelectorAll(".uppy-Dashboard-Item"),
          ];
          if (
            !dashboard.isConnected ||
            currentCards.length !== 1 ||
            currentCards[0] !== card ||
            currentAction.textContent.trim() !== "Upload 1 file"
          )
            throw new Error(
              "ManyVids queue changed while recording upload intent.",
            );
          uploadAttempts += 1;
          click(currentAction, "ManyVids queued media upload");
          return false;
        }
        if (!uploadAttempts && dashboardObservedUpload) {
          uploadObserved = true;
          return true;
        }
        return false;
      },
      "ManyVids upload initiation",
      60_000,
      signal,
    );
    if (uploadObserved && uploadAttempts)
      await context.checkpointStep?.("start-upload", uploadCommand, "observed");
    let nextForegroundCheck = 0;
    const foregroundForObservation = async () => {
      if (
        !context.focusPage ||
        (document.visibilityState === "visible" && document.hasFocus())
      )
        return true;
      if (!currentCard()) return false;
      if (Date.now() < nextForegroundCheck) return false;
      const proof = await context.focusPage();
      abortIfNeeded(signal);
      nextForegroundCheck = Date.now() + (proof?.deferred ? 1000 : 30000);
      if (proof?.deferred) return false;
      if (proof?.focused !== true)
        throw new Error(
          "ManyVids [foreground-observation]: Upload-tab focus was not verified. Inspect the existing upload; do not attach it again.",
        );
      await waitFor(
        () => document.visibilityState === "visible" && document.hasFocus(),
        "ManyVids real foreground visibility after activation",
        5000,
        signal,
      );
      return true;
    };
    const card = await waitFor(
      async () => {
        if (!(await foregroundForObservation())) return null;
        const card = currentEdit();
        return card && manyVidsEditControl(card, true) ? card : null;
      },
      "ManyVids completed upload card",
      UPLOAD_TIMEOUT,
      signal,
    );
    await context.progress?.("upload-ready");
    const edit = card.matches("button[aria-label^='Button edit video :']")
      ? card
      : manyVidsEditControl(card);
    const editorCommand = context.checkpointStep ? newCommandId() : "";
    const href =
      edit.getAttribute("href") ||
      edit.getAttribute("data-href") ||
      edit.getAttribute("data-url");
    const destination = href ? new URL(href, "https://www.manyvids.com") : null;
    const videoId =
      destination?.origin === "https://www.manyvids.com" &&
      /^\/Edit-vid\/(\d+)\/?$/.exec(destination.pathname)?.[1];
    if (
      context.checkpointStep &&
      (!videoId || destination.search || destination.hash)
    )
      throw new Error(
        "ManyVids completed Edit destination identity is unavailable.",
      );
    await context.checkpointStep?.("open-editor", editorCommand, "intent", {
      destinationUrl: destination?.href,
      videoId,
    });
    if (
      !card.isConnected ||
      !edit.isConnected ||
      (context.focusPage &&
        (document.visibilityState !== "visible" || !document.hasFocus())) ||
      !enabled(edit) ||
      currentEdit() !== card ||
      (edit.getAttribute("href") ||
        edit.getAttribute("data-href") ||
        edit.getAttribute("data-url")) !== href
    )
      throw new Error(
        "ManyVids completed card changed during the editor checkpoint.",
      );
    click(edit, "ManyVids continue/edit control");
    return { platform: "manyvids", status: "edit-requested" };
  }

  function pornhubDeviceAction() {
    const actions = [
      ...document.querySelectorAll("button.uploadButton"),
    ].filter(visible);
    const intended = actions.filter((button) =>
      /^(upload from device|select video)$/i.test(
        (button.getAttribute("aria-label") || button.textContent).trim(),
      ),
    );
    if (intended.length !== 1)
      throw new Error(
        "Pornhub device upload candidates: " + intended.length + ".",
      );
    const button = intended[0];
    assertActionLabels(
      button,
      ["upload from device", "select video"],
      "Pornhub device-upload action",
    );
    const surface = button.closest(
      "form, section, [role='region'], [role='dialog']",
    );
    if (surface && /vault/i.test(surface.getAttribute("aria-label") || ""))
      throw new Error("Pornhub device action belongs to a foreign surface.");
    return button;
  }

  function inspectPornhubUploader() {
    if ([...document.querySelectorAll("input[type='password']")].some(visible))
      throw new Error(
        "Pornhub authentication is required; sign in before preparation.",
      );
    const candidates = [
      ...document.querySelectorAll("button.uploadButton"),
    ].filter(visible);
    if (!candidates.length) return null;
    const button = pornhubDeviceAction();
    if (!enabled(button))
      throw new Error(
        "Pornhub device-upload capability is unavailable (disabled action).",
      );
    const inputs = [
      ...document.querySelectorAll("input.dz-hidden-input[type='file']"),
    ];
    if (inputs.length > 1)
      throw new Error("Pornhub uploader file-input capability is ambiguous.");
    if (
      inputs.some(
        (input) =>
          !enabled(input) ||
          input.hasAttribute("webkitdirectory") ||
          input.hasAttribute("directory"),
      )
    )
      throw new Error("Pornhub device-upload capability is unavailable.");
    if (
      inputs.some(
        (input) => input instanceof HTMLInputElement && input.files?.length,
      ) ||
      [...document.querySelectorAll("input[name='title']")].some(
        (input) =>
          input instanceof HTMLInputElement &&
          visible(input) &&
          input.value.trim(),
      )
    )
      throw new Error(
        "Pornhub uploader contains existing media or metadata; inspect that draft. No file was handed off.",
      );
    return { uploader: true, deviceActions: 1 };
  }

  function bindPornhubDeviceAction() {
    const button = pornhubDeviceAction();
    const key = crypto.randomUUID();
    button.setAttribute("data-creator-device-action", key);
    return '[data-creator-device-action="' + key + '"]';
  }

  async function activatePornhubUploader(signal) {
    abortIfNeeded(signal);
    const button = pornhubDeviceAction();
    let activated = null;
    let ambiguous = false;
    const capture = (event) => {
      const input = event.target;
      if (
        !(input instanceof HTMLInputElement) ||
        !input.matches("input.dz-hidden-input[type='file']")
      )
        return;
      event.preventDefault();
      if (activated && activated !== input) ambiguous = true;
      activated = input;
    };
    globalThis.addEventListener("click", capture, true);
    try {
      click(button, "Pornhub visible uploader");
      const chosen = await waitFor(
        () => activated,
        "Pornhub activated file input",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
      abortIfNeeded(signal);
      if (
        ambiguous ||
        !chosen.isConnected ||
        chosen.webkitdirectory ||
        chosen.hasAttribute("directory")
      )
        throw new Error(
          "Pornhub activated file input changed or is ambiguous.",
        );
      return chosen;
    } finally {
      globalThis.removeEventListener("click", capture, true);
    }
  }

  async function runPornhub(context) {
    const { draft, signal } = context;
    publicationMode(draft);
    abortIfNeeded(signal);
    const selector = "input.dz-hidden-input[type='file']";
    await context.progress?.("uploading-full");
    await context.attachFile("pornhub", selector);
    await waitFor(
      () =>
        document.querySelector('custom-dropdown[data-key="orientation"]') &&
        document.querySelector('input[name="tags"]') &&
        document.querySelector(
          'input[name="category"], input[name="categoryInput"]',
        ),
      "Pornhub metadata form",
      UPLOAD_TIMEOUT,
      signal,
    );
    await context.progress?.("configuring");
    const title = one('input[name="title"]', "Pornhub title");
    if (!draft.title) throw new Error("Pornhub approved title is missing.");
    if (!enabled(title) || title.readOnly)
      throw new Error(
        "Pornhub [title]: The title input is unavailable; inspect the existing upload before retrying.",
      );
    fillTextControl(title, draft.title);
    await waitFor(
      () => {
        const current = one('input[name="title"]', "Pornhub title readback");
        return current.value === draft.title;
      },
      "Pornhub approved title readback",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const adapter = globalThis.CreatorToolkitAdapters?.phUploader;
    const toolkit = globalThis.CreatorToolkit;
    if (!adapter || !toolkit)
      throw new Error("Pornhub metadata recipe is unavailable.");
    const resolved = adapter.resolvePreset(
      draft.profiles?.phUploader,
      draft.seasonArc,
      draft.contentPreset,
    );
    if (!resolved) throw new Error("Pornhub content preset is unavailable.");
    const plan = adapter.inspectPreset(resolved.name, resolved.preset);
    const result = await adapter.applyPreset(
      plan,
      signal,
      toolkit.createBudget(signal, {
        maxActions: 100,
        maxDurationMs: 180_000,
      }),
    );
    if (result.status !== "success") {
      const failure = result.items?.find((item) => item.status === "failed");
      throw new Error(
        "Pornhub [metadata-preset]: " +
          (failure
            ? failure.label + ": " + failure.detail
            : result.summary || "Metadata preparation stopped."),
      );
    }
    if (
      one('input[name="title"]', "Pornhub final title readback").value !==
      draft.title
    )
      throw new Error(
        "Pornhub [title]: Approved title changed during metadata preparation.",
      );
    await context.progress?.("prepared");
    return {
      platform: "pornhub",
      status: "manual-submit-required",
      manualFields: ["schedule", "custom thumbnail (optional)", "final Submit"],
      effectiveFilename: draft.pornhubFilename,
      preset: resolved.name,
    };
  }

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  async function configureManyVidsSchedule(form, draft, signal) {
    const launch = one("#launchCustom", "ManyVids custom launch", form, {
      allowHidden: true,
    });
    const labels = [...(launch.labels || [])].filter(visible);
    const zones = labels
      .map(
        (label) =>
          label.textContent.match(
            /timezone\s*\(([A-Za-z_]+\/[A-Za-z_\-/]+)\)/i,
          )?.[1],
      )
      .filter(Boolean);
    if (zones.length !== 1 || !launch.checked)
      throw new Error(
        "ManyVids site timezone or custom launch selection is unverified.",
      );
    const parts = zonedParts(draft.scheduledIso, zones[0]);
    const input = one(
      "#dp1[name='available_date']",
      "ManyVids launch date",
      form,
    );
    click(input, "ManyVids launch calendar");
    const calendar = await waitFor(
      () => {
        const candidates = [
          ...document.querySelectorAll(".datepicker-dropdown .datepicker-days"),
        ].filter(visible);
        if (candidates.length > 1)
          throw new Error("ManyVids launch calendar is ambiguous.");
        return candidates[0];
      },
      "ManyVids launch calendar",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const months = Array.from({ length: 12 }, (_, index) =>
      new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2020, index, 1)),
      ),
    );
    const [year, month] = parts.date.split("-").map(Number);
    for (let attempt = 0; attempt < 120; attempt++) {
      const header = one(
        ".datepicker-switch",
        "ManyVids calendar month",
        calendar,
      ).textContent.trim();
      const match = header.match(/^([A-Za-z]+)\s+(\d{4})$/);
      const currentMonth = match ? months.indexOf(match[1]) : -1;
      if (!match || currentMonth < 0)
        throw new Error("ManyVids calendar month is unverified.");
      const delta =
        year * 12 + month - 1 - (Number(match[2]) * 12 + currentMonth);
      if (!delta) {
        click(
          exactText(
            "td.day:not(.old):not(.new):not(.disabled)",
            parts.day,
            "ManyVids launch day",
            calendar,
          ),
          "ManyVids launch day",
        );
        break;
      }
      click(
        one(
          delta > 0 ? ".next" : ".prev",
          "ManyVids calendar navigation",
          calendar,
        ),
        "ManyVids calendar navigation",
      );
      await waitFor(
        () =>
          calendar.querySelector(".datepicker-switch")?.textContent.trim() !==
          header,
        "ManyVids calendar navigation readback",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    }
    if (input.value !== parts.date)
      throw new Error("ManyVids launch date readback failed.");
    const time = one(
      "#available_time[name='available_time']",
      "ManyVids launch time",
      form,
      { allowHidden: true },
    );
    selectOption(time, `${parts.hour}:${parts.minute}`, "ManyVids launch time");
    if (
      time.value !== `${parts.hour}:${parts.minute}` ||
      input.value !== parts.date
    )
      throw new Error("ManyVids launch instant readback failed.");
    return { date: parts.date, time: time.value, timeZone: zones[0] };
  }

  async function runManyVidsEdit(context) {
    const { draft, signal } = context;
    publicationMode(draft);
    abortIfNeeded(signal);
    const manyvidsId = String(draft.manyvidsId || "").trim();
    if (!/^\d+$/.test(manyvidsId)) {
      throw new Error("ManyVids edit ID is invalid.");
    }
    const titleControl = one(
      "#Title[name='video_title']",
      "ManyVids title control",
      document,
      { allowHidden: true },
    );
    const form = titleControl.closest("form");
    if (!form) throw new Error("ManyVids edit form is missing.");
    progressScope = form;
    await context.progress?.("configuring");

    if (draft.hasTeaser !== false) {
      const previousTeaser = form
        .querySelector(".js-teaser-download")
        ?.getAttribute("href");
      const currentTeaserMenu = [
        ...form.querySelectorAll("#dropdownMenuLink[aria-haspopup='true']"),
      ].find(
        (element) => normalizedText(element.textContent) === "teaser options",
      );
      const previewMenu =
        currentTeaserMenu ||
        exactText(
          "button,a",
          "Custom Preview",
          "ManyVids Custom Preview control",
          form,
        );
      click(previewMenu, "ManyVids Custom Preview control");
      const previewUpload = await waitFor(
        () => {
          const candidates = [
            ...form.querySelectorAll(".dropdown-item,button,a"),
          ].filter(
            (candidate) =>
              candidate.id !== "upload_screenshot" &&
              visible(candidate) &&
              normalizedText(candidate.textContent) === "upload",
          );
          return candidates.length === 1 ? candidates[0] : null;
        },
        "ManyVids Custom Preview upload control",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
      click(previewUpload, "ManyVids Custom Preview upload control");
      await context.attachFile("teaser", "input.noborder[name='file']");
      if (currentTeaserMenu) {
        await waitFor(
          () => {
            const view = form.querySelector(".js-generate-video-teaser-html");
            const download = form.querySelector(".js-teaser-download");
            const uploadPanel = form.querySelector(
              ".js-custom-preview-wrapper",
            );
            return (
              view &&
              view.style.display !== "none" &&
              download?.getAttribute("href") &&
              download.getAttribute("href") !== previousTeaser &&
              uploadPanel &&
              !visible(uploadPanel)
            );
          },
          "ManyVids accepted custom teaser",
          UPLOAD_TIMEOUT,
          signal,
        );
      }
    }

    if (draft.manyvidsThumbnail) {
      const thumbnailPreview = () =>
        form.querySelector(".js-thumbnail-container img.js-video-screenshot");
      const previousThumbnail = thumbnailPreview()?.getAttribute("src");
      const thumbnailMenu = [
        ...form.querySelectorAll("#dropdownMenuLink"),
      ].find(
        (element) => normalizedText(element.textContent) === "edit thumbnail",
      );
      if (thumbnailMenu)
        click(thumbnailMenu, "ManyVids Edit Thumbnail control");
      click(
        one("#upload_screenshot", "ManyVids thumbnail Upload control"),
        "ManyVids thumbnail Upload control",
      );
      await context.attachFile("thumbnail", "#fileUploader[name='image']");
      await waitFor(
        () => {
          const confirmation = document.querySelector(
            "form[name='thumbnail'] #save_thumb[name='upload_thumbnail_btn']",
          );
          return visible(confirmation) && enabled(confirmation);
        },
        "ManyVids thumbnail crop confirmation",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
      const thumbnailCommand = context.checkpointStep
        ? crypto.randomUUID()
        : "";
      await context.checkpointStep?.(
        "confirm-thumbnail",
        thumbnailCommand,
        "intent",
      );
      click(
        one(
          "form[name='thumbnail'] #save_thumb[name='upload_thumbnail_btn']",
          "ManyVids thumbnail Save control",
        ),
        "ManyVids thumbnail Save control",
      );
      await waitFor(
        () => {
          const preview = thumbnailPreview();
          return (
            visible(preview) &&
            preview.complete &&
            preview.naturalWidth > 0 &&
            preview.getAttribute("src") !== previousThumbnail &&
            !visible(
              document.querySelector("form[name='thumbnail'] #save_thumb"),
            )
          );
        },
        "ManyVids accepted thumbnail",
        UPLOAD_TIMEOUT,
        signal,
      );
      await context.checkpointStep?.(
        "confirm-thumbnail",
        thumbnailCommand,
        "observed",
      );
    }

    const title = titleControl;
    const description = one(
      "#video_description",
      "ManyVids description control",
      form,
    );
    fillTextControl(title, draft.title);
    fillTextControl(description, draft.description);

    const sharedManyVids = globalThis.CreatorToolkitAdapters?.manyvidsAutofill;
    const sharedManyVidsProfile = draft.profiles?.manyvidsAutofill;
    if (!sharedManyVids || !sharedManyVidsProfile) {
      throw new Error("ManyVids shared metadata recipe is unavailable.");
    }
    await runSharedRecipe(
      sharedManyVids,
      sharedManyVids.inspectForm(form, sharedManyVidsProfile),
      signal,
      40,
    );

    one("select#co-performer", "ManyVids co-performer control", form);

    let scheduleProof = null;
    if (sharedManyVidsProfile.launchModeSelector === "#launchCustom") {
      scheduleProof = await configureManyVidsSchedule(form, draft, signal);
    }
    if (
      title.value !== String(draft.title || "") ||
      description.value !== String(draft.description || "")
    )
      throw new Error(
        "ManyVids metadata readback did not match the approved draft.",
      );
    const save = exactText(
      "#saveVideo",
      "Save",
      "ManyVids final Save control",
      form,
    );
    const verifiedRecipe = sharedManyVids.inspectForm(
      form,
      sharedManyVidsProfile,
    );
    verifyNoBlockingErrors(form, "ManyVids");
    if (
      verifiedRecipe.tagsToAdd.length ||
      [
        verifiedRecipe.priceMode,
        verifiedRecipe.launchMode,
        verifiedRecipe.membership,
        verifiedRecipe.premium,
      ].some(
        (mode) =>
          !mode.safe ||
          !(
            mode.control.checked ||
            mode.control.getAttribute("aria-checked") === "true"
          ),
      ) ||
      !enabled(save)
    )
      throw new Error(
        "ManyVids configured recipe or final editor readiness changed before verification.",
      );
    if (publicationMode(draft) === "manual")
      return {
        platform: "manyvids",
        status: "manual-submit-required",
        manyvidsId,
      };
    await beforeCommit(context, "ManyVids");
    verifyNoBlockingErrors(form, "ManyVids");
    if (
      !form.isConnected ||
      !save.isConnected ||
      title.value !== String(draft.title || "") ||
      description.value !== String(draft.description || "") ||
      (scheduleProof &&
        (form.querySelector("#dp1")?.value !== scheduleProof.date ||
          form.querySelector("#available_time")?.value !== scheduleProof.time ||
          !form.querySelector("#launchCustom")?.checked))
    )
      throw new Error(
        "ManyVids prepared state changed during the durable checkpoint.",
      );
    click(save, "ManyVids final Save control");
    await context.progress?.("save-clicked");
    return { platform: "manyvids", status: "save-clicked", manyvidsId };
  }

  function selectOption(select, expected, label) {
    abortIfNeeded(mutationSignal);
    const option = [...select.options].find(
      (candidate) =>
        candidate.value.trim().toLowerCase() === expected.toLowerCase() ||
        candidate.textContent.trim().toLowerCase() === expected.toLowerCase(),
    );
    if (!option) throw new Error(`${label} option ${expected} is unavailable.`);
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    ).set.call(select, option.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function chooseDate(root, parts, platform) {
    const exact = [
      ...root.querySelectorAll(`[data-date="${parts.date}"]`),
    ].filter(visible);
    if (exact.length === 1) {
      click(exact[0], `${platform} publication date`);
      return;
    }
    const selector =
      platform === "OnlyFans"
        ? ".vdatetime-calendar__month__day"
        : ".current-month-day";
    const byDay = [...root.querySelectorAll(selector)].filter(
      (candidate) =>
        visible(candidate) && candidate.textContent.trim() === parts.day,
    );
    const monthRoot = root.querySelector(
      `[data-year="${parts.date.slice(0, 4)}"][data-month="${parts.date.slice(5, 7)}"]`,
    );
    const expectedMonth = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${parts.date}T12:00:00Z`));
    const calendarScope =
      platform === "OnlyFans"
        ? byDay[0]?.closest(".vdatetime-popup, [role='dialog']")
        : null;
    const headerVerified =
      calendarScope &&
      [...calendarScope.querySelectorAll("div,span")].some(
        (element) =>
          visible(element) &&
          element.textContent.trim().replace(/\s+/g, " ") === expectedMonth,
      );
    if (
      (!monthRoot || !byDay.every((day) => monthRoot.contains(day))) &&
      !headerVerified
    )
      throw new Error(
        `${platform} calendar month/year is unverified; no date was selected.`,
      );
    if (byDay.length !== 1) {
      throw new Error(`${platform} publication date is missing or ambiguous.`);
    }
    click(byDay[0], `${platform} publication date`);
  }

  function findOnlyFansTimeList(part, target, root = document) {
    const explicit = root.querySelector(
      `.vdatetime-time-picker__list[data-part="${part}"]`,
    );
    if (explicit && visible(explicit)) return explicit;
    const typed = [
      ...root.querySelectorAll(".vdatetime-time-picker__list"),
    ].filter((list) => {
      const items = [...list.querySelectorAll(".vdatetime-time-picker__item")];
      return (
        visible(list) &&
        items.every((item) => /^\d+$/.test(item.textContent.trim())) &&
        (part === "minute"
          ? items.length === 60
          : items.length === 12 || items.length === 24)
      );
    });
    if (typed.length === 1) return typed[0];
    const candidates = [
      ...root.querySelectorAll(".vdatetime-time-picker__list"),
    ].filter(
      (list) =>
        visible(list) &&
        [...list.querySelectorAll(".vdatetime-time-picker__item")].some(
          (item) =>
            /^\d+$/.test(item.textContent.trim()) &&
            Number(item.textContent.trim()) === Number(target),
        ),
    );
    if (candidates.length > 1) {
      const numeric = candidates.filter((list) => {
        const values = [
          ...list.querySelectorAll(".vdatetime-time-picker__item"),
        ].map((item) => Number(item.textContent.trim()));
        return part === "minute"
          ? values.some((value) => value > 23)
          : values.length <= 24 &&
              values.every((value) => Number.isFinite(value) && value <= 23);
      });
      if (numeric.length === 1) return numeric[0];
    }
    if (candidates.length !== 1) {
      throw new Error(`OnlyFans ${part} list is missing or ambiguous.`);
    }
    return candidates[0];
  }

  async function chooseOnlyFansDate(root, parts, signal) {
    if (
      [...root.querySelectorAll(`[data-date="${parts.date}"]`)].filter(visible)
        .length === 1
    )
      return chooseDate(root, parts, "OnlyFans");
    const months = Array.from({ length: 12 }, (_, index) =>
      new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2020, index, 1)),
      ),
    );
    const [year, month] = parts.date.split("-").map(Number);
    for (let attempt = 0; attempt < 120; attempt++) {
      const header = one(
        ".vdatetime-calendar__current--month",
        "OnlyFans calendar month",
        root,
      );
      const previous = header.textContent.trim();
      const match = previous.match(/^([A-Za-z]+)\s+(\d{4})$/);
      const currentMonth = match ? months.indexOf(match[1]) : -1;
      if (!match || currentMonth < 0)
        throw new Error("OnlyFans calendar month/year is unverified.");
      const delta =
        year * 12 + month - 1 - (Number(match[2]) * 12 + currentMonth);
      if (!delta) return chooseDate(root, parts, "OnlyFans");
      click(
        one(
          delta > 0
            ? ".vdatetime-calendar__navigation--next"
            : ".vdatetime-calendar__navigation--previous",
          "OnlyFans calendar navigation",
          root,
        ),
        "OnlyFans calendar navigation",
      );
      await waitFor(
        () => header.textContent.trim() !== previous,
        "OnlyFans changed calendar month",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    }
    throw new Error(
      "OnlyFans date exceeds supported calendar navigation range.",
    );
  }

  function resolveOnlyFansComposer() {
    const editors = [
      ...document.querySelectorAll(
        ".tiptap.ProseMirror[role='textbox'], .js-text-editor[role='textbox']",
      ),
    ].filter(visible);
    if (editors.length > 1)
      throw new Error(
        "OnlyFans editor ownership candidates: " + editors.length,
      );
    if (!editors.length) return null;
    const editor = editors[0];
    let composer = editor.closest(
      "form, [role='region'][aria-label='NEW POST'], [role='dialog'][aria-label='NEW POST']",
    );
    if (!composer) {
      const headings = [
        ...document.querySelectorAll("h1, h2, [role='heading']"),
      ].filter(
        (node) =>
          visible(node) && normalizedText(node.textContent) === "new post",
      );
      if (headings.length !== 1)
        throw new Error(
          "OnlyFans NEW POST heading candidates: " + headings.length,
        );
      for (
        let ancestor = editor.parentElement;
        ancestor &&
        ancestor !== document.body &&
        ancestor !== document.documentElement;
        ancestor = ancestor.parentElement
      ) {
        if (ancestor.contains(headings[0])) {
          composer = ancestor;
          break;
        }
      }
    }
    if (
      !composer ||
      composer === document.body ||
      composer === document.documentElement
    )
      throw new Error("OnlyFans composer ownership is unverified.");
    if (
      composer.matches("[role='dialog']") &&
      composer.getAttribute("aria-label") !== "NEW POST"
    )
      throw new Error("OnlyFans foreign composer.");
    return { editor, composer };
  }

  async function preparationBoundary(platform, stage, operation) {
    try {
      return await operation();
    } catch (error) {
      // Cancellation must remain cancellation, and an uncertain handoff is never retried.
      if (error?.name === "AbortError" || error?.preparationStage) throw error;
      throw Object.assign(
        new Error(`${platform} [${stage}]: ${error.message}`, { cause: error }),
        { preparationStage: stage },
      );
    }
  }

  function referencedLabel(element, attribute) {
    const ids = (element.getAttribute(attribute) || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const labels = ids.map((id) => [
      ...document.querySelectorAll(`#${CSS.escape(id)}`),
    ]);
    return labels.every((matches) => matches.length === 1)
      ? labels.map((matches) => matches[0].textContent).join(" ")
      : "";
  }

  function actionName(element) {
    // Honour explicit relationships first; do not fall back through a broken label.
    if (element.hasAttribute("aria-labelledby"))
      return normalizedText(referencedLabel(element, "aria-labelledby"));
    return normalizedText(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent,
    );
  }

  function assertActionLabels(element, names, label) {
    const labels = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      referencedLabel(element, "aria-labelledby"),
      element.textContent,
    ]
      .map(normalizedText)
      .filter(Boolean);
    if (labels.some((name) => !names.includes(name)))
      throw new Error(
        label +
          " has conflicting action labels; no action was clicked. Capture the control identity before retrying.",
      );
  }

  function onlyFansOwnsControl({ composer, editor }, node) {
    return (
      composer.contains(node) ||
      (node instanceof HTMLButtonElement && node.form === composer) ||
      [editor.id, composer.id].some(
        (id) =>
          id &&
          (node.getAttribute("aria-controls") || "").split(/\s+/).includes(id),
      )
    );
  }

  function onlyFansScheduleAction(owned) {
    const candidates = [
      ...document.querySelectorAll("button, [role='button']"),
    ].filter((node) => {
      if (
        !visible(node) ||
        !onlyFansOwnsControl(owned, node) ||
        actionName(node) !== "schedule post"
      )
        return false;
      assertActionLabels(node, ["schedule post"], "OnlyFans schedule action");
      const evidence = [
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        referencedLabel(node, "aria-labelledby"),
        referencedLabel(node, "aria-describedby"),
        node.textContent,
      ];
      // A stale schedule tooltip must never override expiration's own identity.
      return !evidence.some((label) =>
        /\b(expiration|expire|expires|expiry|delete|remove)\b/i.test(
          label || "",
        ),
      );
    });
    if (candidates.length !== 1)
      throw new Error(
        `OnlyFans schedule action is ${candidates.length ? "ambiguous" : "missing"} (${candidates.length} matches). Inspect Schedule post, not Expiration period; capture a trace if the toolbar changed.`,
      );
    return candidates[0];
  }

  function onlyFansDialogs(composer) {
    return [
      ...document.querySelectorAll(
        "[role='dialog'], [aria-modal='true'], .vdatetime-popup",
      ),
    ].filter(
      (node) => visible(node) && node !== composer && !node.contains(composer),
    );
  }

  function onlyFansSchedulerSurface(composer, phase = "date") {
    const dialogs = onlyFansDialogs(composer);
    const names = (node) =>
      [
        actionName(node),
        node.getAttribute("aria-label") || "",
        node.getAttribute("title") || "",
        referencedLabel(node, "aria-labelledby"),
        ...node.querySelectorAll("h1,h2,h3,[role='heading']"),
      ].map((value) =>
        normalizedText(typeof value === "string" ? value : value.textContent),
      );
    if (
      dialogs.some((node) =>
        names(node).some((value) =>
          /\b(expiration|expiry|expires)\b/.test(value),
        ),
      )
    )
      throw new Error(
        "Expiration period opened instead of the OnlyFans scheduler. No date or time was changed; inspect the toolbar and capture a trace before retrying.",
      );
    const candidates = dialogs.filter((node) =>
      node.matches(".vdatetime-popup"),
    );
    if (candidates.length > 1)
      throw new Error("OnlyFans scheduler surface is ambiguous.");
    const popup = candidates[0];
    if (!popup) {
      if (dialogs.length)
        throw new Error(
          "Unsupported OnlyFans scheduler surface; capture the current scheduling dialog. No date or time was changed.",
        );
      return null;
    }
    if (
      dialogs.some(
        (node) =>
          node !== popup && !node.contains(popup) && !popup.contains(node),
      )
    )
      throw new Error(
        "OnlyFans scheduler surface is ambiguous; another dialog opened.",
      );
    const surfaces = dialogs.filter(
      (node) => node === popup || node.contains(popup),
    );
    if (
      !surfaces.some((node) =>
        names(node).some(
          (name) => name === "schedule post" || name === "schedule",
        ),
      )
    )
      throw new Error(
        "OnlyFans scheduler identity is unverified; an arbitrary date dialog is not accepted. Capture the scheduling surface before retrying.",
      );
    const controls =
      phase === "time"
        ? ".vdatetime-time-picker__item"
        : ".vdatetime-calendar__month__day";
    return [...popup.querySelectorAll(controls)].some(visible) &&
      popup.querySelector(".vdatetime-popup__tab.time")
      ? popup
      : null;
  }

  async function openOnlyFansScheduler(owned, revalidate, signal) {
    return preparationBoundary("OnlyFans", "schedule-surface", async () => {
      revalidate();
      if (onlyFansDialogs(owned.composer).length)
        throw new Error(
          "An existing OnlyFans dialog requires review before scheduling; no action was clicked.",
        );
      const action = onlyFansScheduleAction(owned);
      revalidate();
      if (!action.isConnected || onlyFansScheduleAction(owned) !== action)
        throw new Error("OnlyFans schedule action ownership changed.");
      click(action, "OnlyFans Schedule post action");
      return waitFor(
        () => {
          revalidate();
          return onlyFansSchedulerSurface(owned.composer);
        },
        "OnlyFans positively identified scheduler surface (not Expiration period)",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    });
  }

  async function runOnlyFans(context) {
    const { draft, signal } = context;
    publicationMode(draft);
    abortIfNeeded(signal);
    const owned = await waitFor(
      resolveOnlyFansComposer,
      "OnlyFans NEW POST ownership",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const { editor, composer } = owned;
    const revalidate = () => {
      const current = resolveOnlyFansComposer();
      if (
        !current ||
        current.editor !== editor ||
        current.composer !== composer
      )
        throw new Error("OnlyFans composer ownership changed.");
      return current;
    };
    const control = async (selector, label) =>
      waitFor(
        () => {
          revalidate();
          const candidates = [...document.querySelectorAll(selector)].filter(
            (node) => visible(node) && onlyFansOwnsControl(owned, node),
          );
          if (candidates.length > 1)
            throw new Error(
              label + " ownership candidates: " + candidates.length,
            );
          return candidates[0];
        },
        label,
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    await control(
      "#attach_file_photo[aria-label='Add media']",
      "OnlyFans media activation",
    );
    progressScope = composer;
    const labels = () =>
      [...composer.querySelectorAll("[id^='post-label-'], .b-post-labels")].map(
        (control) => ({
          node: control,
          checked:
            control instanceof HTMLInputElement ? control.checked : undefined,
          value: control.getAttribute("aria-checked"),
          text: control.textContent,
        }),
      );
    const labelsBefore = labels();
    const mediaPreviews = () =>
      [...composer.querySelectorAll(".b-dropzone__preview__delete")].filter(
        (control) => visible(control) && !control.closest(".m-schedule"),
      );
    const mediaReady = () => {
      const previews = mediaPreviews();
      const media = previews[0]?.closest(".b-dropzone__preview");
      return (
        previews.length === 1 &&
        media &&
        !/\b(processing|uploading|verifying)\b/i.test(media.textContent) &&
        ![
          ...media.querySelectorAll("[aria-busy='true'], [role='progressbar']"),
        ].some(visible)
      );
    };
    if (mediaPreviews().length)
      throw new Error(
        "OnlyFans existing attachments require association review before selecting media.",
      );
    if (
      !document.querySelector("#file_upload_input") &&
      !context.supportsNativePicker
    ) {
      click(
        await control(
          "#attach_file_photo[aria-label='Add media']",
          "OnlyFans media activation",
        ),
        "OnlyFans media activation",
      );
    }
    if (!context.supportsNativePicker)
      await waitFor(
        () => document.querySelector("#file_upload_input[type='file']"),
        "OnlyFans local media input",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    await context.progress?.("uploading-full");
    await context.attachFile("full", "#file_upload_input");
    await waitFor(
      () => {
        const previews = mediaPreviews();
        if (previews.length > 1)
          throw new Error(
            "OnlyFans selected attachment association is ambiguous.",
          );
        return previews.length === 1;
      },
      "OnlyFans recognized full attachment",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    await context.progress?.("configuring");

    revalidate();
    fillTextControl(editor, draft.description);
    await waitFor(
      () => editor.textContent === String(draft.description || ""),
      "OnlyFans description readback",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );

    const parts = zonedParts(
      draft.scheduledIso,
      draft.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const scheduleReadback = () => {
      const chip = one(
        ".b-dropzone__preview.m-schedule",
        "OnlyFans schedule readback",
        composer,
      );
      const datetime = chip
        .querySelector("time[datetime]")
        ?.getAttribute("datetime");
      if (
        datetime &&
        /(?:Z|[+-]\d{2}:\d{2})$/.test(datetime) &&
        new Date(datetime).getTime() === new Date(draft.scheduledIso).getTime()
      )
        return `${datetime}|${chip.textContent}`;
      const text = (chip.getAttribute("title") || chip.textContent)
        .trim()
        .replace(
          /^(?:scheduled\s+(?:for|on)|will\s+(?:send|be sent)\s+on)\s*/i,
          "",
        )
        .replace(/\s+at\s+/i, " ");
      if (
        !/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i.test(
          text,
        ) ||
        !/\b\d{4}\b/.test(text) ||
        !/\d{1,2}:\d{2}/.test(text)
      )
        throw new Error(
          "OnlyFans exact scheduled instant is unverified; inspect the schedule chip before publication.",
        );
      const parsed = new Date(text);
      const date = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
      if (
        date !== parts.date ||
        String(parsed.getHours()).padStart(2, "0") !== parts.hour ||
        String(parsed.getMinutes()).padStart(2, "0") !== parts.minute
      )
        throw new Error(
          "OnlyFans schedule readback does not match the approved instant.",
        );
      return text;
    };
    const popup = await openOnlyFansScheduler(owned, revalidate, signal);
    await chooseOnlyFansDate(popup, parts, signal);
    click(
      one(".vdatetime-popup__tab.time", "OnlyFans time tab", popup),
      "OnlyFans date confirmation",
    );
    await waitFor(
      () => {
        revalidate();
        const current = onlyFansSchedulerSurface(composer, "time");
        if (!popup.isConnected || (current && current !== popup))
          throw new Error(
            "OnlyFans scheduler ownership changed before time selection.",
          );
        return current === popup;
      },
      "OnlyFans time picker",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const hourList = findOnlyFansTimeList("hour", parts.hour, popup);
    const hourItems = [
      ...hourList.querySelectorAll(".vdatetime-time-picker__item"),
    ];
    const twelveHour =
      hourItems.length === 12 &&
      !hourItems.some((item) => Number(item.textContent.trim()) > 12);
    const hourValue = twelveHour
      ? String(Number(parts.hour) % 12 || 12)
      : String(Number(parts.hour));
    click(
      exactText(
        ".vdatetime-time-picker__item",
        hourValue,
        "OnlyFans hour",
        hourList,
      ),
      "OnlyFans hour",
    );
    if (twelveHour) {
      const periods = [
        ...popup.querySelectorAll(".vdatetime-time-picker__list"),
      ].filter(
        (list) =>
          visible(list) &&
          [...list.querySelectorAll(".vdatetime-time-picker__item")].some(
            (item) => item.textContent.trim() === "AM",
          ) &&
          [...list.querySelectorAll(".vdatetime-time-picker__item")].some(
            (item) => item.textContent.trim() === "PM",
          ),
      );
      if (periods.length !== 1)
        throw new Error("OnlyFans AM/PM control is missing or ambiguous.");
      click(
        exactText(
          ".vdatetime-time-picker__item",
          Number(parts.hour) < 12 ? "AM" : "PM",
          "OnlyFans AM/PM",
          periods[0],
        ),
        "OnlyFans AM/PM",
      );
    }
    const minuteList = findOnlyFansTimeList("minute", parts.minute, popup);
    click(
      exactText(
        ".vdatetime-time-picker__item",
        parts.minute,
        "OnlyFans minute",
        minuteList,
      ),
      "OnlyFans minute",
    );
    click(
      exactText("button", "OK", "OnlyFans time confirmation", popup),
      "OnlyFans time confirmation",
    );

    const commit = await waitFor(
      () => {
        if (!mediaReady()) return null;
        const candidates = [...composer.querySelectorAll("button")].filter(
          (button) =>
            visible(button) &&
            enabled(button) &&
            !button.closest(".vdatetime-popup, [role='dialog']") &&
            new Set(["save", "schedule"]).has(
              button.textContent.trim().toLowerCase(),
            ),
        );
        return candidates.length === 1 ? candidates[0] : null;
      },
      "OnlyFans final Save control and completed media upload",
      UPLOAD_TIMEOUT,
      signal,
    );
    const labelsAfter = labels();
    const scheduleProof = scheduleReadback();
    verifyNoBlockingErrors(editor.closest("form") || document, "OnlyFans");
    if (editor.textContent !== String(draft.description || "") || !mediaReady())
      throw new Error(
        "OnlyFans attachment or description changed before verification.",
      );
    if (
      labelsBefore.length !== labelsAfter.length ||
      labelsBefore.some((item, index) => {
        const next = labelsAfter[index];
        return (
          item.checked !== next.checked ||
          item.value !== next.value ||
          item.text !== next.text
        );
      })
    )
      throw new Error("OnlyFans labels changed during preparation.");
    if (publicationMode(draft) === "manual")
      return { platform: "onlyfans", status: "manual-submit-required" };
    await beforeCommit(context, "OnlyFans");
    if (scheduleReadback() !== scheduleProof)
      throw new Error(
        "OnlyFans schedule changed during the durable checkpoint.",
      );
    verifyNoBlockingErrors(editor.closest("form") || document, "OnlyFans");
    if (
      !editor.isConnected ||
      editor.textContent !== String(draft.description || "") ||
      !commit.isConnected ||
      !enabled(commit) ||
      !mediaReady()
    )
      throw new Error(
        "OnlyFans prepared state changed during the durable checkpoint.",
      );
    const checkpointLabels = labels();
    if (
      labelsBefore.length !== checkpointLabels.length ||
      labelsBefore.some(
        (item, index) =>
          item.checked !== checkpointLabels[index].checked ||
          item.value !== checkpointLabels[index].value ||
          item.text !== checkpointLabels[index].text,
      )
    )
      throw new Error("OnlyFans labels changed during the durable checkpoint.");
    click(commit, "OnlyFans final Save control");
    await context.progress?.("submitted");
    return { platform: "onlyfans", status: "submitted" };
  }

  function assertFanslyComposer(composer) {
    const candidates = [
      ...document.querySelectorAll("app-post-creation"),
    ].filter(visible);
    if (
      !composer.isConnected ||
      candidates.length !== 1 ||
      candidates[0] !== composer
    )
      throw new Error(
        "Fansly composer ownership changed; inspect the existing draft before retrying.",
      );
  }

  function fanslySourceScope(control, composer) {
    const ids = (control.getAttribute("aria-controls") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) {
      if (ids.length !== 1)
        throw new Error("Fansly media source relationship is ambiguous.");
      const scopes = [...document.querySelectorAll(`#${CSS.escape(ids[0])}`)];
      if (scopes.length !== 1)
        throw new Error(
          "Fansly owned media source menu is missing or ambiguous.",
        );
      return scopes[0];
    }
    const scope = control.closest(".default-dropdown");
    if (!scope || !composer.contains(scope))
      throw new Error(
        "Fansly Add Media source ownership is unverified; capture its current menu relationship.",
      );
    return scope;
  }

  function fanslySourceActivation(source, label) {
    assertActionLabels(source, ["upload new"], label);
    const activated = new Set();
    const capture = (event) => {
      if (
        !(event.target instanceof HTMLInputElement) ||
        event.target.type !== "file"
      )
        return;
      event.preventDefault();
      activated.add(event.target);
    };
    globalThis.addEventListener("click", capture, true);
    try {
      click(source, label);
      // Only nested activation during this exact source click proves causality.
      if (activated.size !== 1)
        throw new Error(
          `${label} activated ${activated.size} file inputs; its file-picker postcondition is missing or ambiguous. No file was handed off. Capture the source selection before retrying.`,
        );
      return { activated };
    } finally {
      globalThis.removeEventListener("click", capture, true);
    }
  }

  async function fanslyUploadNew(context, composer) {
    let menuControl;
    const sourceScope = await preparationBoundary(
      "Fansly",
      "media-menu",
      async () => {
        assertFanslyComposer(composer);
        const candidates = [
          ...composer.querySelectorAll(
            "button, [role='button'], .default-dropdown > .dropdown-title",
          ),
        ].filter((node) => {
          if (!visible(node)) return false;
          if (actionName(node) === "add media") {
            assertActionLabels(node, ["add media"], "Fansly Add Media action");
            return true;
          }
          const name = actionName(node);
          if (
            (name && name !== "media") ||
            (!name && node.hasAttribute("aria-labelledby"))
          )
            return false;
          if (name === "media")
            assertActionLabels(node, ["media"], "Fansly media menu");
          // The recorded homepage image identifies this owned source menu.
          // Its choices may be created only after activation; resolve them then.
          const scope =
            node.matches(".default-dropdown > .dropdown-title") &&
            node.closest(".default-dropdown");
          const imageControl = node.querySelectorAll(":scope > i.fa-image");
          return Boolean(
            scope &&
            (imageControl.length === 1 ||
              [...scope.querySelectorAll(".dropdown-item")].some(
                (item) => normalizedText(item.textContent) === "upload new",
              )),
          );
        });
        if (candidates.length !== 1)
          throw new Error(
            `Add Media action is ${candidates.length ? "ambiguous" : "missing"} (${candidates.length} matches). Open an empty homepage composer and capture the source menu.`,
          );
        menuControl = candidates[0];
        const scope = fanslySourceScope(menuControl, composer);
        click(menuControl, "Fansly Add Media");
        return scope;
      },
    );
    return preparationBoundary("Fansly", "upload-new", async () => {
      const source = await waitFor(
        () => {
          assertFanslyComposer(composer);
          if (
            !menuControl.isConnected ||
            !sourceScope.isConnected ||
            fanslySourceScope(menuControl, composer) !== sourceScope
          )
            throw new Error("Fansly media source ownership changed.");
          const candidates = [
            ...sourceScope.querySelectorAll(
              ".dropdown-item, button, [role='option'], [role='menuitem']",
            ),
          ].filter(
            (node) => visible(node) && actionName(node) === "upload new",
          );
          if (candidates.length > 1)
            throw new Error("Fansly Upload New source is ambiguous.");
          return candidates[0];
        },
        "Fansly owned Upload New source (not From Vault or Copied Media)",
        DEFAULT_DOM_TIMEOUT,
        context.signal,
      );
      assertFanslyComposer(composer);
      return {
        sourceScope,
        ...fanslySourceActivation(source, "Fansly owned Upload New"),
      };
    });
  }

  async function attachFanslyMedia(context, composer, role) {
    const before = composer.querySelectorAll(
      "app-account-media-template",
    ).length;
    const selection = await fanslyUploadNew(context, composer);
    const scope = await fanslyFileScope(context, composer, selection);
    await preparationBoundary("Fansly", "file-handoff", async () => {
      assertFanslyComposer(composer);
      await context.attachFile(role, "input[data-creator-fansly-file]");
    });
    return preparationBoundary("Fansly", "processing", () =>
      waitFor(
        () => {
          assertFanslyComposer(composer);
          const modals = [
            ...document.querySelectorAll(
              "app-account-media-upload.active-modal",
            ),
          ].filter(visible);
          if (modals.length > 1)
            throw new Error("Fansly media processing surface is ambiguous.");
          const currentScope = modals[0] || scope;
          const cards = [
            ...currentScope.querySelectorAll("app-account-media-template"),
          ];
          if (cards.length > (scope === composer ? before : 0) + 1)
            throw new Error("Fansly selected media association is ambiguous.");
          return cards.length > (currentScope === composer ? before : 0)
            ? cards.at(-1)
            : null;
        },
        `Fansly ${role} media card`,
        DEFAULT_DOM_TIMEOUT,
        context.signal,
      ),
    );
  }

  async function fanslyFileScope(context, composer, selection = null) {
    return preparationBoundary("Fansly", "file-input", () =>
      waitFor(
        () => {
          assertFanslyComposer(composer);
          const activated = [...(selection?.activated || [])];
          if (activated.length > 1)
            throw new Error("Fansly activated file input is ambiguous.");
          if (selection && activated.length !== 1)
            throw new Error(
              "Fansly Upload New file-picker activation is unverified; no file was handed off.",
            );
          const inputs = activated;
          if (!inputs.length) return false;
          if (inputs.length !== 1)
            throw new Error("Fansly media input is ambiguous.");
          const input = inputs[0];
          const dialog = input.closest("[role='dialog'], [aria-modal='true']");
          if (
            !input.isConnected ||
            !enabled(input) ||
            input.webkitdirectory ||
            input.hasAttribute("directory")
          )
            throw new Error(
              "Fansly owned file input changed or is unavailable.",
            );
          if (dialog && !visible(dialog)) return null;
          if (dialog && /\b(vault|copied media)\b/.test(actionName(dialog)))
            throw new Error(
              "Fansly activated file input belongs to a foreign source.",
            );
          // An arbitrary visible modal is not evidence of ownership. External inputs
          // require the observed click from the uniquely selected Upload New action.
          if (!composer.contains(input) && !activated.includes(input))
            throw new Error(
              "Fansly external file input ownership is unverified.",
            );
          for (const old of document.querySelectorAll(
            "[data-creator-fansly-file]",
          ))
            old.removeAttribute("data-creator-fansly-file");
          const scope = composer.contains(input)
            ? composer
            : dialog || input.parentElement;
          if (
            !scope ||
            scope.querySelectorAll(
              "input[type='file']:not([webkitdirectory]):not([directory])",
            ).length !== 1
          )
            throw new Error(
              "Fansly owned source file-input scope is ambiguous.",
            );
          input.setAttribute("data-creator-fansly-file", "");
          return scope;
        },
        "Fansly owned Upload New file input",
        DEFAULT_DOM_TIMEOUT,
        context.signal,
      ),
    );
  }

  async function attachFanslyPreview(context, composer, fullCard) {
    click(fullCard, "Fansly full media card for free preview");
    click(
      exactText(
        ".btn, button, [role='button']",
        "Add Free Preview",
        "Fansly Add Free Preview control",
        fullCard,
      ),
      "Fansly Add Free Preview control",
    );
    const mediaSourceMenu = composer.querySelector(".default-dropdown");
    const uploadNewCandidates = [
      ...document.querySelectorAll(".dropdown-item, [role='option'], button"),
    ].filter(
      (element) =>
        visible(element) &&
        element.textContent.trim() === "Upload New" &&
        !mediaSourceMenu?.contains(element),
    );
    if (uploadNewCandidates.length !== 1) {
      throw new Error(
        `Fansly free-preview Upload New control is ${uploadNewCandidates.length ? "ambiguous" : "missing"} (${uploadNewCandidates.length} matches).`,
      );
    }
    const selection = await preparationBoundary(
      "Fansly",
      "preview-source",
      () =>
        fanslySourceActivation(
          uploadNewCandidates[0],
          "Fansly free-preview Upload New control",
        ),
    );
    await fanslyFileScope(context, composer, selection);
    await context.attachFile("teaser", "input[data-creator-fansly-file]");
    return waitFor(
      () => {
        const markers = [
          ...fullCard.querySelectorAll(
            "[data-free-preview='true'], .free-preview, .media-preview, [class*='free-preview']",
          ),
        ].filter(visible);
        return markers.length === 1 ? markers[0] : null;
      },
      "Fansly attached free preview",
      DEFAULT_DOM_TIMEOUT,
      context.signal,
    );
  }

  function fanslyPermissionState(modal) {
    const settings = one(
      ".permission-settings-container",
      "Fansly effective permissions",
      modal,
    );
    const alternatives = [...settings.querySelectorAll(":scope > .flex-col")];
    const groups = (alternatives.length ? alternatives : [settings]).map(
      (group) =>
        [...group.querySelectorAll(".permission-flag:not(.new-flag)")].map(
          (flag) => flag.textContent.trim().replace(/\s+/g, " "),
        ),
    );
    if (
      groups.some(
        (flags) =>
          !flags.length ||
          flags.some((flag) => !flag) ||
          !flags.some(
            (flag) =>
              /^(Subscribed|Following|Private List)\b/i.test(flag) ||
              (/^Price\s+/i.test(flag) &&
                Number(flag.replace(/^Price\s+/i, "")) > 0),
          ),
      )
    )
      throw new Error(
        "Fansly preset has an unverified or public access alternative.",
      );
    return JSON.stringify(groups);
  }

  async function chooseFanslyDate(root, parts, signal) {
    if (!root.closest("app-post-schedule-modal"))
      return chooseDate(root, parts, "Fansly");
    const [year, month] = parts.date.split("-").map(Number);
    const months = Array.from({ length: 12 }, (_, index) =>
      new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2020, index, 1)),
      ),
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      const header = one(".header .month", "Fansly calendar month", root);
      const match = header.textContent.trim().match(/^(\w+)\s+(\d{4})$/);
      const currentMonth = match ? months.indexOf(match[1]) + 1 : 0;
      if (!currentMonth)
        throw new Error("Fansly calendar month/year is unverified.");
      const delta = (year - Number(match[2])) * 12 + month - currentMonth;
      if (!delta) {
        const day = exactText(
          ".current-month-day",
          parts.day,
          "Fansly calendar date",
          root,
        );
        click(day, "Fansly calendar date");
        await waitFor(
          () => day.classList.contains("is-selected"),
          "Fansly selected date",
          DEFAULT_DOM_TIMEOUT,
          signal,
        );
        return;
      }
      const previous = header.textContent;
      click(
        one(
          delta > 0 ? ".next-month" : ".previous-month",
          "Fansly calendar navigation",
          root,
        ),
        "Fansly calendar navigation",
      );
      await waitFor(
        () =>
          one(".header .month", "Fansly calendar month", root).textContent !==
          previous,
        "Fansly changed calendar month",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    }
    throw new Error("Fansly date exceeds supported calendar navigation range.");
  }

  async function prepareCurrentFanslyMedia(context, composer, modal, fullCard) {
    const { draft, signal } = context;
    if (draft.hasTeaser !== false) {
      await context.progress?.("waiting-for-teaser");
      const input = await preparationBoundary(
        "Fansly",
        "preview-source",
        async () => {
          assertFanslyComposer(composer);
          if (
            !fullCard.isConnected ||
            !modal.contains(fullCard) ||
            one(
              "app-account-media-upload.active-modal",
              "Fansly owned media modal",
            ) !== modal
          )
            throw new Error("Fansly preview media ownership changed.");
          click(
            exactText(
              "xd-localization-string",
              "Add Free Preview",
              "Fansly free preview",
              fullCard,
            ),
            "Fansly free preview",
          );
          const source = exactText(
            ".dropdown-item",
            "Upload New",
            "Fansly preview source",
            fullCard,
          );
          assertActionLabels(source, ["upload new"], "Fansly preview source");
          const selection = fanslySourceActivation(
            source,
            "Fansly preview Upload New",
          );
          const ownedInput = one(
            "input[type='file']:not([multiple]):not([webkitdirectory]):not([directory])",
            "Fansly preview input",
            fullCard,
            { allowHidden: true },
          );
          if (
            !ownedInput.isConnected ||
            !enabled(ownedInput) ||
            !fullCard.isConnected ||
            !modal.contains(fullCard) ||
            !selection.activated.has(ownedInput)
          )
            throw new Error(
              "Fansly preview-input activation belongs to a changed or foreign media source.",
            );
          return ownedInput;
        },
      );
      for (const old of document.querySelectorAll("[data-creator-fansly-file]"))
        old.removeAttribute("data-creator-fansly-file");
      input.setAttribute("data-creator-fansly-file", "");
      await context.attachFile("teaser", "input[data-creator-fansly-file]");
      await waitFor(
        () => fullCard.querySelector(".preview-image"),
        "Fansly selected free preview",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );
    }
    await context.progress?.("configuring");
    const load = exactText(".btn", "Load Preset", "Fansly Load Preset", modal);
    click(load, "Fansly Load Preset");
    const menu = load.closest(".transparent-dropdown");
    if (!menu) throw new Error("Fansly preset menu scope is missing.");
    const choices = [
      ...menu.querySelectorAll(".dropdown-list > .dropdown-item"),
    ].filter(visible);
    const preset =
      draft.fanslyPresetSelection === "first"
        ? choices[0]
        : choices.find(
            (choice) => choice.textContent.trim() === draft.fanslyPreset,
          );
    if (!preset) throw new Error("Fansly approved access preset is missing.");
    const presetName = preset.textContent.trim();
    if (!presetName) throw new Error("Fansly preset identity is empty.");
    click(preset, "Fansly approved access preset");
    const permissions = await waitFor(
      () => fanslyPermissionState(modal),
      "Fansly effective preset permissions",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    if (draft.hasTeaser !== false && !fullCard.querySelector(".preview-image"))
      throw new Error(
        "Fansly free preview disappeared after applying permissions.",
      );
    const commandId = context.checkpointStep ? crypto.randomUUID() : "";
    await context.checkpointStep?.("attach-media", commandId, "intent");
    click(
      exactText(".btn", "Upload", "Fansly parent media Upload", modal),
      "Fansly parent media Upload",
    );
    await waitFor(
      () => {
        const cards = [
          ...composer.querySelectorAll("app-account-media-template"),
        ];
        if (cards.length > 1)
          throw new Error("Fansly composer attachment is ambiguous.");
        return (
          !modal.isConnected &&
          cards.length === 1 &&
          !/\b(Verifying|Uploading|Processing)\b/i.test(cards[0].textContent) &&
          ![
            ...cards[0].querySelectorAll(
              "[aria-busy='true'], [role='progressbar'], .upload-progress, .verification-progress",
            ),
          ].some(visible)
        );
      },
      "Fansly processed composer attachment",
      UPLOAD_TIMEOUT,
      signal,
    );
    // Reopen the existing attachment; the composer itself omits preview/access details.
    click(
      exactText(
        "xd-localization-string",
        "Edit Permissions",
        "Fansly attached-media permissions",
        composer,
      ),
      "Fansly attached-media permissions",
    );
    const review = await waitFor(
      () => document.querySelector("app-account-media-upload.active-modal"),
      "Fansly attachment review",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const reviewCard = one(
      "app-account-media-template",
      "Fansly reviewed full media",
      review,
    );
    if (
      fanslyPermissionState(review) !== permissions ||
      (draft.hasTeaser !== false && !reviewCard.querySelector(".preview-image"))
    )
      throw new Error(
        "Fansly attachment permissions or free preview did not persist.",
      );
    click(
      exactText(
        ".btn",
        "Cancel",
        "Fansly close unchanged media review",
        review,
      ),
      "Fansly close unchanged media review",
    );
    await waitFor(
      () => !review.isConnected,
      "Fansly closed media review",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    await context.checkpointStep?.("attach-media", commandId, "observed");
  }

  async function runFansly(context) {
    const { draft, signal } = context;
    publicationMode(draft);
    abortIfNeeded(signal);
    const composer = await preparationBoundary(
      "Fansly",
      "composer-acquisition",
      async () => {
        await waitFor(
          () =>
            [...document.querySelectorAll("app-post-creation")].some(visible),
          "Fansly homepage composer; sign in and open an empty composer",
          DEFAULT_DOM_TIMEOUT,
          signal,
        );
        return one("app-post-creation", "Fansly post composer");
      },
    );
    progressScope = composer;
    if (composer.querySelector("app-account-media-template"))
      throw new Error(
        "Fansly existing media requires association review before attachment.",
      );
    await context.progress?.("uploading-full");
    const fullCard = await attachFanslyMedia(context, composer, "full");
    const currentMediaModal = fullCard.closest("app-account-media-upload");
    if (currentMediaModal) {
      await prepareCurrentFanslyMedia(
        context,
        composer,
        currentMediaModal,
        fullCard,
      );
    } else {
      const mediaModal = fullCard.closest(
        "[role='dialog'], app-media-upload-modal, .media-upload-modal",
      );
      if (draft.hasTeaser !== false) {
        await context.progress?.("waiting-for-teaser");
        await attachFanslyPreview(context, composer, fullCard);
      }
      await context.progress?.("configuring");
      click(fullCard, "Fansly full media card");
      const lockControl = one(
        ".locked-text-container",
        "Fansly full media access control",
        fullCard,
      );
      click(lockControl, "Fansly full media access control");
      const loadControls = [
        ...document.querySelectorAll("button, [role='button'], .btn"),
      ].filter(
        (control) =>
          visible(control) && control.textContent.trim() === "Load Preset",
      );
      if (loadControls.length > 1)
        throw new Error("Fansly Load Preset control is ambiguous.");
      if (loadControls.length === 1)
        click(loadControls[0], "Fansly Load Preset");
      const preset = exactText(
        ".dropdown-item, [role='option'], button",
        draft.fanslyPreset || "defaulT",
        "Fansly access preset defaulT",
        document,
        { caseSensitive: true },
      );
      click(preset, "Fansly access preset defaulT");
      await waitFor(
        () => {
          const expected = String(draft.fanslyPreset || "defaulT");
          return (
            fullCard.dataset.locked !== "false" &&
            (fullCard.dataset.preset === expected ||
              [...fullCard.querySelectorAll(".locked-text-container")].some(
                (control) => control.textContent.trim() === expected,
              ))
          );
        },
        "Fansly locked-media preset",
        DEFAULT_DOM_TIMEOUT,
        signal,
      );

      if (mediaModal) {
        const commandId = context.checkpointStep ? crypto.randomUUID() : "";
        const upload = exactText(
          "button, [role='button'], .btn",
          "Upload",
          "Fansly parent media Upload",
          mediaModal,
        );
        abortIfNeeded(signal);
        await context.checkpointStep?.("attach-media", commandId, "intent");
        click(upload, "Fansly parent media Upload");
        await waitFor(
          () => {
            const cards = [
              ...composer.querySelectorAll("app-account-media-template"),
            ].filter((card) => !mediaModal.contains(card));
            if (cards.length > 1)
              throw new Error("Fansly composer attachment is ambiguous.");
            const card = cards[0];
            return (
              card &&
              card.dataset.locked !== "false" &&
              (card.dataset.preset === "defaulT" ||
                card
                  .querySelector(".locked-text-container")
                  ?.textContent.trim() === "defaulT") &&
              (draft.hasTeaser === false ||
                card.querySelector("[data-free-preview='true'], .free-preview"))
            );
          },
          "Fansly processed composer attachment",
          UPLOAD_TIMEOUT,
          signal,
        );
        await context.checkpointStep?.("attach-media", commandId, "observed");
      }
    }

    const sharedFansly = globalThis.CreatorToolkitAdapters?.fanslyPrefill;
    const sharedFanslyProfile = draft.profiles?.fanslyPrefill;
    if (!sharedFansly || !sharedFanslyProfile) {
      throw new Error("Fansly shared metadata recipe is unavailable.");
    }
    await runSharedRecipe(
      {
        applyPlan: (plan, currentSignal, budget) =>
          sharedFansly.applyPlan(
            plan,
            sharedFanslyProfile,
            currentSignal,
            budget,
          ),
      },
      sharedFansly.inspectComposer(composer, sharedFanslyProfile, {
        desiredText: draft.fanslyCaption,
        forceWrite: true,
        finalAction:
          "Master Uploader will schedule after a durable checkpoint.",
      }),
      signal,
      10,
    );
    const calendarIcons = [
      ...composer.querySelectorAll(".icon-stack:has(.fa-clock) .fa-calendar"),
    ].filter(visible);
    const scheduleControl = calendarIcons.length
      ? calendarIcons.length === 1
        ? calendarIcons[0]
        : null
      : one(".icon-stack:has(.fa-clock)", "Fansly schedule control", composer);
    if (!scheduleControl)
      throw new Error("Fansly schedule control is ambiguous.");
    click(scheduleControl, "Fansly schedule control");
    const dateRoot = await waitFor(
      () => {
        const roots = [
          ...document.querySelectorAll(
            "app-post-schedule-modal .modal-content, #schedule-modal",
          ),
        ].filter(visible);
        if (roots.length > 1)
          throw new Error("Fansly schedule dialog is ambiguous.");
        return roots[0];
      },
      "Fansly schedule dialog",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const zoneTitle = one(".timezone", "Fansly displayed timezone", dateRoot);
    const siteZone = zoneTitle.nextElementSibling?.textContent.trim();
    if (!/^[A-Za-z_]+\/[A-Za-z_\-/]+$/.test(siteZone || ""))
      throw new Error("Fansly schedule timezone is unverified.");
    const parts = zonedParts(draft.scheduledIso, siteZone);
    await chooseFanslyDate(dateRoot, parts, signal);
    const selects = [...dateRoot.querySelectorAll("select")].filter(visible);
    const format = selects.find((select) =>
      [...select.options].some((option) => option.textContent.trim() === "24H"),
    );
    const hour = selects.find(
      (select) =>
        select !== format &&
        (select.dataset.time === "hour" ||
          [...select.options].some(
            (option) => option.textContent.trim() === "23",
          )),
    );
    const minute = selects.find(
      (select) => select !== format && select !== hour,
    );
    if (!format || !hour || !minute) {
      throw new Error(
        "Fansly schedule time controls are missing or ambiguous.",
      );
    }
    selectOption(format, "24H", "Fansly time format");
    selectOption(hour, parts.hour, "Fansly hour");
    selectOption(minute, parts.minute, "Fansly minute");
    if (
      hour.value !== parts.hour ||
      minute.value !== parts.minute ||
      format.selectedOptions[0]?.textContent.trim() !== "24H"
    )
      throw new Error("Fansly schedule time readback failed.");
    click(
      exactText(
        ".confirm-btn, .btn",
        "Confirm Date",
        "Fansly date confirmation",
        dateRoot,
      ),
      "Fansly date confirmation",
    );

    const schedule = await waitFor(
      () => {
        const control = composer.querySelector(".new-post-btn");
        return control &&
          visible(control) &&
          enabled(control) &&
          control.textContent.trim().toLowerCase() === "schedule"
          ? control
          : null;
      },
      "Fansly Schedule control and completed media uploads",
      UPLOAD_TIMEOUT,
      signal,
    );
    verifyNoBlockingErrors(composer, "Fansly");
    const finalCaption = composer.querySelector("textarea");
    if (
      draft.fanslyCaption !== undefined &&
      finalCaption?.value !== draft.fanslyCaption
    )
      throw new Error("Fansly caption changed before verification.");
    if (publicationMode(draft) === "manual")
      return { platform: "fansly", status: "manual-submit-required" };
    await beforeCommit(context, "Fansly");
    verifyNoBlockingErrors(composer, "Fansly");
    if (
      !composer.isConnected ||
      composer.querySelector(".new-post-btn") !== schedule ||
      !enabled(schedule) ||
      schedule.textContent.trim().toLowerCase() !== "schedule" ||
      (draft.fanslyCaption !== undefined &&
        composer.querySelector("textarea")?.value !== draft.fanslyCaption)
    )
      throw new Error(
        "Fansly prepared state changed during the durable checkpoint.",
      );
    click(schedule, "Fansly Schedule control");
    await context.progress?.("submitted");
    return { platform: "fansly", status: "submitted" };
  }

  function guarded(run) {
    return async (context) => {
      if (mutationSignal)
        throw new Error("Another preparation is active in this document.");
      mutationSignal = context.signal || new AbortController().signal;
      reportProgress = context.progress;
      pauseObservation = context.pauseObservation;
      try {
        abortIfNeeded(mutationSignal);
        const result = await run({ ...context, signal: mutationSignal });
        if (
          result.status === "manual-submit-required" &&
          context.checkpointStep
        ) {
          const commandId = newCommandId();
          abortIfNeeded(mutationSignal);
          await context.checkpointStep("verify", commandId, "intent");
          await context.checkpointStep("verify", commandId, "prepared");
        }
        return result;
      } finally {
        mutationSignal = null;
        reportProgress = null;
        pauseObservation = null;
        progressScope = null;
      }
    };
  }
  globalThis.CreatorUploadPlatformAdapters = Object.freeze({
    revision: "upload-hub-0.20.36",
    inspectPornhubUploader,
    bindPornhubDeviceAction,
    verifyPornhubDeviceAction: (selector) =>
      pornhubDeviceAction().matches(selector),
    resolveOnlyFansComposer,
    runFansly: guarded(runFansly),
    runManyVidsEdit: guarded(runManyVidsEdit),
    runManyVidsUpload: guarded(runManyVidsUpload),
    runOnlyFans: guarded(runOnlyFans),
    runPornhub: guarded(runPornhub),
    activatePornhubUploader,
  });
})();
