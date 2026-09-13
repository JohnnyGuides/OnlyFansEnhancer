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
        const scopes = [
          ...document.querySelectorAll(
            ".uppy-Dashboard, app-account-media-upload, app-post-creation",
          ),
        ].filter(visible);
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
    publicationMode(draft);
    abortIfNeeded(signal);
    one(MANYVIDS_FULL_INPUT, "ManyVids full-video input", document, {
      allowHidden: true,
    });
    const previousEdits = new Set(
      document.querySelectorAll("button[aria-label^='Button edit video :']"),
    );
    const previousQueue = new Set(
      document.querySelectorAll(".uppy-Dashboard-Item"),
    );
    if (previousQueue.size)
      throw new Error(
        "ManyVids existing queued media requires association review before attachment.",
      );
    const currentEdit = () => {
      const controls = [
        ...document.querySelectorAll(
          "button[aria-label^='Button edit video :']",
        ),
      ].filter(
        (control) =>
          !previousEdits.has(control) &&
          control.getAttribute("aria-label") ===
            `Button edit video : ${draft.fullFilename}`,
      );
      if (controls.length > 1)
        throw new Error("ManyVids new editor association is ambiguous.");
      return controls[0] || null;
    };
    await context.attachFile("full", MANYVIDS_FULL_INPUT);
    // Uppy has both auto-start and queued variants. Only the dashboard's
    // upload action is an intermediate action; editor Save is never used here.
    let uploadStarted = false;
    const uploadCommand = context.checkpointStep ? crypto.randomUUID() : "";
    await waitFor(
      async () => {
        if (currentEdit() || manyVidsCompletedCard(draft.fullFilename))
          return true;
        const input = document.querySelector(MANYVIDS_FULL_INPUT);
        const dashboard = input?.closest(".uppy-Dashboard");
        if (!dashboard) return false;
        const cards = [...dashboard.querySelectorAll(".uppy-Dashboard-Item")];
        if (!cards.length) return false;
        if (cards.length !== 1)
          throw new Error("ManyVids upload association is ambiguous.");
        const card = cards[0];
        const name =
          card.querySelector(".uppy-Dashboard-Item-name")?.textContent || "";
        if (
          name &&
          !name.includes("...") &&
          !name.includes("…") &&
          normalizedFilename(name) !== normalizedFilename(draft.fullFilename)
        )
          throw new Error(
            "ManyVids selected media does not match the approved full role.",
          );
        if (
          card.matches(
            "[data-state='uploading'], .is-uploading, [data-upload-started='true']",
          ) ||
          dashboard.querySelector(".uppy-StatusBar.is-uploading")
        )
          return true;
        const actions = [
          ...dashboard.querySelectorAll(".uppy-StatusBar-actionBtn--upload"),
        ].filter(visible);
        if (actions.length > 1)
          throw new Error("ManyVids intermediate upload control is ambiguous.");
        if (!uploadStarted && actions.length === 1 && enabled(actions[0])) {
          abortIfNeeded(signal);
          await context.checkpointStep?.(
            "start-upload",
            uploadCommand,
            "intent",
          );
          uploadStarted = true;
          click(actions[0], "ManyVids queued media upload");
        }
        return false;
      },
      "ManyVids upload initiation",
      60_000,
      signal,
    );
    if (uploadStarted)
      await context.checkpointStep?.("start-upload", uploadCommand, "observed");
    const card = await waitFor(
      () => currentEdit() || manyVidsCompletedCard(draft.fullFilename),
      "ManyVids completed upload card",
      UPLOAD_TIMEOUT,
      signal,
    );
    await context.progress?.("upload-ready");
    click(
      card.matches("button[aria-label^='Button edit video :']")
        ? card
        : manyVidsEditControl(card),
      "ManyVids continue/edit control",
    );
    await context.progress?.("edit-requested");
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

    const coPerformer = one(
      "select#co-performer",
      "ManyVids co-performer control",
      form,
    );

    if (sharedManyVidsProfile.launchModeSelector === "#launchCustom") {
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

  function findOnlyFansTimeList(part, target) {
    const explicit = document.querySelector(
      `.vdatetime-time-picker__list[data-part="${part}"]`,
    );
    if (explicit && visible(explicit)) return explicit;
    const typed = [
      ...document.querySelectorAll(".vdatetime-time-picker__list"),
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
      ...document.querySelectorAll(".vdatetime-time-picker__list"),
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

  async function runOnlyFans(context) {
    const { draft, signal } = context;
    publicationMode(draft);
    abortIfNeeded(signal);
    await waitFor(
      () =>
        document.querySelector(
          ".tiptap.ProseMirror[role='textbox'], .js-text-editor[role='textbox']",
        ),
      "OnlyFans NEW POST editor",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const labels = () =>
      [...document.querySelectorAll("[id^='post-label-'], .b-post-labels")].map(
        (control) => ({
          node: control,
          checked:
            control instanceof HTMLInputElement ? control.checked : undefined,
          value: control.getAttribute("aria-checked"),
          text: control.textContent,
        }),
      );
    const labelsBefore = labels();
    if (document.querySelector(".b-dropzone__preview__delete"))
      throw new Error(
        "OnlyFans existing attachments require association review before selecting media.",
      );
    if (
      !document.querySelector("#file_upload_input") &&
      !context.supportsNativePicker
    ) {
      click(
        one(
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
        const previews = [
          ...document.querySelectorAll(".b-dropzone__preview__delete"),
        ].filter(visible);
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

    const editor = one(
      ".tiptap.ProseMirror[role='textbox'], .js-text-editor[role='textbox']",
      "OnlyFans description editor",
    );
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
        ...document.querySelectorAll(".vdatetime-time-picker__list"),
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
    const minuteList = findOnlyFansTimeList("minute", parts.minute);
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
    const labelsAfter = labels();
    verifyNoBlockingErrors(editor.closest("form") || document, "OnlyFans");
    if (
      editor.textContent !== String(draft.description || "") ||
      [...document.querySelectorAll(".b-dropzone__preview__delete")].filter(
        visible,
      ).length !== 1
    )
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
    click(commit, "OnlyFans final Save control");
    await context.progress?.("submitted");
    return { platform: "onlyfans", status: "submitted" };
  }

  function fanslyUploadNew(composer) {
    click(
      one(".default-dropdown > .dropdown-title", "Fansly media menu", composer),
      "Fansly media menu",
    );
    click(
      exactText(".dropdown-item", "Upload New", "Fansly Upload New", composer),
      "Fansly Upload New",
    );
  }

  async function attachFanslyMedia(context, composer, role) {
    const before = composer.querySelectorAll(
      "app-account-media-template",
    ).length;
    fanslyUploadNew(composer);
    const scope = await fanslyFileScope(context, composer);
    await context.attachFile(role, "input[data-creator-fansly-file]");
    return waitFor(
      () => {
        const currentScope =
          document.querySelector("app-account-media-upload.active-modal") ||
          scope;
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
    );
  }

  async function fanslyFileScope(context, composer) {
    return waitFor(
      () => {
        const dialogs = [
          ...document.querySelectorAll(
            "[role='dialog'], app-media-upload-modal, .media-upload-modal",
          ),
        ].filter(
          (node) => visible(node) && node.querySelector("input[type='file']"),
        );
        const deepest = dialogs.filter(
          (node) =>
            !dialogs.some((other) => other !== node && node.contains(other)),
        );
        if (deepest.length > 1)
          throw new Error("Fansly media source dialog is ambiguous.");
        const scope = deepest[0] || composer;
        const inputs = [
          ...scope.querySelectorAll(
            "input[type='file']:not([webkitdirectory])",
          ),
        ];
        if (!inputs.length) return false;
        if (inputs.length !== 1)
          throw new Error("Fansly media input is ambiguous.");
        for (const old of document.querySelectorAll(
          "[data-creator-fansly-file]",
        ))
          old.removeAttribute("data-creator-fansly-file");
        inputs[0].setAttribute("data-creator-fansly-file", "");
        return scope;
      },
      "Fansly media input",
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
    await fanslyFileScope(context, composer);
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
      click(
        exactText(
          "xd-localization-string",
          "Add Free Preview",
          "Fansly free preview",
          fullCard,
        ),
        "Fansly free preview",
      );
      click(
        exactText(
          ".dropdown-item",
          "Upload New",
          "Fansly preview source",
          fullCard,
        ),
        "Fansly preview source",
      );
      const input = one(
        "input[type='file']:not([multiple])",
        "Fansly preview input",
        fullCard,
        { allowHidden: true },
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
          !/\b(Verifying|Uploading|Processing)\b/i.test(composer.textContent)
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
    await waitFor(
      () => document.querySelector("app-post-creation"),
      "Fansly composer readiness",
      DEFAULT_DOM_TIMEOUT,
      signal,
    );
    const composer = one("app-post-creation", "Fansly post composer");
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
    abortIfNeeded(signal);
    click(confirm, "Fansly final Post confirmation");
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
          const commandId = crypto.randomUUID();
          abortIfNeeded(mutationSignal);
          await context.checkpointStep("verify", commandId, "intent");
          await context.checkpointStep("verify", commandId, "prepared");
        }
        return result;
      } finally {
        mutationSignal = null;
        reportProgress = null;
        pauseObservation = null;
      }
    };
  }
  globalThis.CreatorUploadPlatformAdapters = Object.freeze({
    runFansly: guarded(runFansly),
    runManyVidsEdit: guarded(runManyVidsEdit),
    runManyVidsUpload: guarded(runManyVidsUpload),
    runOnlyFans: guarded(runOnlyFans),
  });
})();
