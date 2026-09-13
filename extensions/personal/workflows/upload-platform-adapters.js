(() => {
  "use strict";

  if (globalThis.CreatorUploadPlatformAdapters) return;

  const DEFAULT_DOM_TIMEOUT = 20_000;
  const UPLOAD_TIMEOUT = 45 * 60_000;
  const MANYVIDS_FULL_INPUT =
    "input.uppy-Dashboard-input[type='file']:not([webkitdirectory])";

  function abortIfNeeded(signal) {
    if (signal?.aborted)
      throw new DOMException("Upload cancelled.", "AbortError");
  }

  function visible(element) {
    if (!element || element.closest("[hidden]")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function enabled(element) {
    return Boolean(
      element &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.closest("fieldset[disabled],[aria-disabled='true']"),
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
    if (!visible(element) || !enabled(element)) {
      throw new Error(`${label} is unavailable.`);
    }
    element.click();
  }

  async function beforeCommit(context, platform) {
    if (typeof context.beforeCommit !== "function") {
      throw new Error(`${platform} final action is not durably armed.`);
    }
    const result = await context.beforeCommit();
    if (result?.armed !== true) {
      throw new Error(`${platform} final action was not durably armed.`);
    }
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
    while (Date.now() - started < timeoutMs) {
      abortIfNeeded(signal);
      const value = probe();
      if (value) return value;
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
      control.replaceChildren(document.createTextNode(text));
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

  function manyVidsCompletedCard(filename) {
    const expected = normalizedFilename(filename);
    const cards = [...document.querySelectorAll(".uppy-Dashboard-Item")].filter(
      (card) => {
        const label =
          card.querySelector(".uppy-Dashboard-Item-name")?.textContent || "";
        const completed =
          card.getAttribute("data-state") === "upload-complete" ||
          card.matches(
            ".is-complete, .uppy-Dashboard-Item--complete, [data-upload-complete='true']",
          );
        return completed && normalizedFilename(label) === expected;
      },
    );
    if (cards.length > 1) {
      throw new Error("ManyVids completed upload card is ambiguous.");
    }
    return cards[0] || null;
  }

  function manyVidsEditControl(card) {
    const candidates = [...card.querySelectorAll("button")].filter(
      (button) =>
        enabled(button) &&
        !button.matches(
          ".uppy-Dashboard-Item-action--remove, [aria-label*='remove' i], [aria-label*='delete' i], [title*='delete' i]",
        ),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `ManyVids continue/edit control is ${candidates.length ? "ambiguous" : "missing"}.`,
      );
    }
    return candidates[0];
  }

  async function runManyVidsUpload(context) {
    const { draft, signal } = context;
    one(MANYVIDS_FULL_INPUT, "ManyVids full-video input", document, {
      allowHidden: true,
    });
    await context.attachFile("full", MANYVIDS_FULL_INPUT);
    const card = await waitFor(
      () => manyVidsCompletedCard(draft.fullFilename),
      "ManyVids completed upload card",
      UPLOAD_TIMEOUT,
      signal,
    );
    context.progress?.("upload-ready");
    click(manyVidsEditControl(card), "ManyVids continue/edit control");
    context.progress?.("edit-requested");
    return { platform: "manyvids", status: "edit-requested" };
  }

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function selectByOption(root, expectedValues, label, excluded = new Set()) {
    const expected = expectedValues.map(normalizedText);
    const matches = [...root.querySelectorAll("select")].filter(
      (select) =>
        !excluded.has(select) &&
        [...select.options].some((option) =>
          expected.includes(normalizedText(option.value || option.textContent)),
        ),
    );
    if (matches.length !== 1) {
      throw new Error(
        `${label} select is ${matches.length ? "ambiguous" : "missing"}.`,
      );
    }
    const select = matches[0];
    const option = [...select.options].find((candidate) =>
      expected.includes(
        normalizedText(candidate.value || candidate.textContent),
      ),
    );
    selectOption(select, option.value, label);
    excluded.add(select);
    return select;
  }

  async function runManyVidsEdit(context) {
    const { draft, signal } = context;
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
    context.progress?.("configuring");

    if (draft.hasTeaser !== false) {
      const previewMenu = exactText(
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
    }

    if (draft.manyvidsThumbnail) {
      click(
        one("#upload_screenshot", "ManyVids thumbnail Upload control"),
        "ManyVids thumbnail Upload control",
      );
      await context.attachFile("thumbnail", "#fileUploader[name='image']");
      click(
        one(
          "#save_thumb[name='upload_thumbnail_btn']",
          "ManyVids thumbnail Save control",
        ),
        "ManyVids thumbnail Save control",
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

    const coPerformer = one(
      "select#co-performer",
      "ManyVids co-performer control",
      form,
    );

    const release = new Date(`${draft.releaseDate}T00:00:00.000Z`);
    if (Number.isNaN(release.getTime())) {
      throw new Error("ManyVids release date is invalid.");
    }
    const excluded = new Set([coPerformer]);
    selectByOption(
      form,
      [
        String(release.getUTCMonth() + 1).padStart(2, "0"),
        release.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
      ],
      "ManyVids launch month",
      excluded,
    );
    selectByOption(
      form,
      [String(release.getUTCDate())],
      "ManyVids launch day",
      excluded,
    );
    selectByOption(
      form,
      [String(release.getUTCFullYear())],
      "ManyVids launch year",
      excluded,
    );
    const save = exactText(
      "#saveVideo",
      "Save",
      "ManyVids final Save control",
      form,
    );
    if (draft.publishMode === "manual")
      return {
        platform: "manyvids",
        status: "manual-submit-required",
        manyvidsId,
      };
    await beforeCommit(context, "ManyVids");
    click(save, "ManyVids final Save control");
    context.progress?.("save-clicked");
    return { platform: "manyvids", status: "save-clicked", manyvidsId };
  }

  function selectOption(select, expected, label) {
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
    if (byDay.length !== 1) {
      throw new Error(`${platform} publication date is missing or ambiguous.`);
    }
    click(byDay[0], `${platform} publication date`);
  }

  function findOnlyFansTimeList(part, target) {
    const explicit = document.querySelector(
      `.vdatetime-time-picker__list[data-part="${part}"]`,
    );
    if (explicit && visible(explicit)) return explicit;
    const candidates = [
      ...document.querySelectorAll(".vdatetime-time-picker__list"),
    ].filter(
      (list) =>
        visible(list) &&
        [...list.querySelectorAll(".vdatetime-time-picker__item")].some(
          (item) => item.textContent.trim() === String(Number(target)),
        ),
    );
    if (candidates.length !== 1) {
      throw new Error(`OnlyFans ${part} list is missing or ambiguous.`);
    }
    return candidates[0];
  }

  async function runOnlyFans(context) {
    const { draft, signal } = context;
    abortIfNeeded(signal);
    context.progress?.("uploading-full");
    await context.attachFile("full", "#file_upload_input");
    context.progress?.("configuring");

    const editor = one(
      ".tiptap.ProseMirror[role='textbox'], .js-text-editor[role='textbox']",
      "OnlyFans description editor",
    );
    fillTextControl(editor, draft.description);

    const parts = zonedParts(
      draft.scheduledIso,
      draft.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    click(
      one("button[aria-label='Schedule post']", "OnlyFans schedule control"),
      "OnlyFans schedule control",
    );
    await waitFor(
      () =>
        [...document.querySelectorAll(".vdatetime-calendar__month__day")].some(
          visible,
        ),
      "OnlyFans date picker",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    chooseDate(document, parts, "OnlyFans");
    click(
      exactText("button", "Next", "OnlyFans date confirmation"),
      "OnlyFans date confirmation",
    );
    await waitFor(
      () =>
        [...document.querySelectorAll(".vdatetime-time-picker__item")].some(
          visible,
        ),
      "OnlyFans time picker",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const hourList = findOnlyFansTimeList("hour", parts.hour);
    const minuteList = findOnlyFansTimeList("minute", parts.minute);
    click(
      exactText(
        ".vdatetime-time-picker__item",
        String(Number(parts.hour)),
        "OnlyFans hour",
        hourList,
      ),
      "OnlyFans hour",
    );
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
      exactText("button", "OK", "OnlyFans time confirmation"),
      "OnlyFans time confirmation",
    );

    const commit = await waitFor(
      () => {
        const candidates = [...document.querySelectorAll("button")].filter(
          (button) =>
            visible(button) &&
            enabled(button) &&
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
    if (draft.publishMode === "manual")
      return { platform: "onlyfans", status: "manual-submit-required" };
    await beforeCommit(context, "OnlyFans");
    click(commit, "OnlyFans final Save control");
    context.progress?.("submitted");
    return { platform: "onlyfans", status: "submitted" };
  }

  function fanslyUploadNew(composer) {
    click(
      one(".default-dropdown > .dropdown-title", "Fansly media menu", composer),
      "Fansly media menu",
    );
    click(
      exactText(".dropdown-item", "Upload New", "Fansly Upload New"),
      "Fansly Upload New",
    );
  }

  async function attachFanslyMedia(context, composer, role) {
    const before = composer.querySelectorAll(
      "app-account-media-template",
    ).length;
    fanslyUploadNew(composer);
    await context.attachFile(role, "app-post-creation input[type='file']");
    return waitFor(
      () => {
        const cards = [
          ...composer.querySelectorAll("app-account-media-template"),
        ];
        return cards.length > before ? cards.at(-1) : null;
      },
      `Fansly ${role} media card`,
      DEFAULT_DOM_TIMEOUT,
      context.signal,
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
    click(uploadNewCandidates[0], "Fansly free-preview Upload New control");
    await context.attachFile("teaser", "app-post-creation input[type='file']");
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

  async function runFansly(context) {
    const { draft, signal } = context;
    abortIfNeeded(signal);
    const composer = one("app-post-creation", "Fansly post composer");
    context.progress?.("uploading-full");
    const fullCard = await attachFanslyMedia(context, composer, "full");
    context.progress?.("configuring");
    click(fullCard, "Fansly full media card");
    const lockControl = one(
      ".locked-text-container",
      "Fansly full media access control",
      fullCard,
    );
    click(lockControl, "Fansly full media access control");
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
          fullCard.dataset.preset === expected ||
          [...fullCard.querySelectorAll(".locked-text-container")].some(
            (control) => control.textContent.trim() === expected,
          )
        );
      },
      "Fansly locked-media preset",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );

    if (draft.hasTeaser !== false) {
      context.progress?.("waiting-for-teaser");
      await attachFanslyPreview(context, composer, fullCard);
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
    const parts = zonedParts(
      draft.scheduledIso,
      draft.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
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
        const day = [...document.querySelectorAll(".current-month-day")].find(
          visible,
        );
        return (
          day?.closest("[role='dialog'], .modal, #schedule-modal") ||
          day?.parentElement
        );
      },
      "Fansly schedule dialog",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    chooseDate(dateRoot, parts, "Fansly");
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
    click(schedule, "Fansly Schedule control");
    const confirm = await waitFor(
      () => {
        const candidates = [
          ...document.querySelectorAll(".btn, button"),
        ].filter(
          (control) =>
            control !== schedule &&
            visible(control) &&
            enabled(control) &&
            control.textContent.trim().toLowerCase() === "post",
        );
        return candidates.length === 1 ? candidates[0] : null;
      },
      "Fansly final Post confirmation",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    if (draft.publishMode === "manual")
      return { platform: "fansly", status: "manual-submit-required" };
    await beforeCommit(context, "Fansly");
    click(confirm, "Fansly final Post confirmation");
    context.progress?.("submitted");
    return { platform: "fansly", status: "submitted" };
  }

  globalThis.CreatorUploadPlatformAdapters = Object.freeze({
    runFansly,
    runManyVidsEdit,
    runManyVidsUpload,
    runOnlyFans,
  });
})();
