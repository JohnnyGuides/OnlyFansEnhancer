(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const SELECTORS = Object.freeze({
    categoryCombo: "#mui-component-select-category_id",
    categoryMenu: "#menu-category_id",
    relatedCombo: "#mui-component-select-related_categories",
    relatedMenu: "#menu-related_categories",
    performerCombo: "#performers-dropdown-select",
    performerSearch: "#search-performers-dropdown",
    performerList:
      'ul[role="listbox"][aria-labelledby="performers-dropdown-label"]',
    performerRadio:
      '[data-testid="edit-clip_radio-group_performers"] input[type="radio"][value="0"]',
    orientationCombo: "#mui-component-select-orientation_id",
    orientationMenu: "#menu-orientation_id",
    price: "#price-input",
    description: "#description-input",
    keywords: "#keywords-input",
  });

  function exactLabelInContainer(container, expected) {
    const expectedKey = toolkit.normalizeText(expected);
    if (toolkit.normalizeText(container.textContent) === expectedKey)
      return true;
    return Array.from(container.querySelectorAll("*")).some(
      (element) => toolkit.normalizeText(element.textContent) === expectedKey,
    );
  }

  function controlValue(element) {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element.value;
    }
    return "";
  }

  function currentKeywordLabels(input) {
    const root =
      input.closest(".MuiAutocomplete-root") ||
      input.parentElement?.parentElement ||
      input.parentElement ||
      document;
    return new Set(
      Array.from(
        root.querySelectorAll(
          ".MuiChip-label, [data-testid*='keyword'] [class*='label'], [role='listitem']",
        ),
      )
        .map((element) => toolkit.normalizeText(element.textContent))
        .filter(Boolean),
    );
  }

  function formSignature() {
    const selectors = [
      SELECTORS.categoryCombo,
      SELECTORS.relatedCombo,
      SELECTORS.performerCombo,
      SELECTORS.orientationCombo,
      SELECTORS.price,
      SELECTORS.description,
      SELECTORS.keywords,
    ];
    return selectors
      .map((selector) => {
        const element = document.querySelector(selector);
        return `${selector}\u0000${controlValue(element)}\u0000${toolkit.displayText(
          element?.textContent,
        )}`;
      })
      .join("\u0001");
  }

  function inspectForm(profile, audience, videoType) {
    const price = profile.prices[videoType];
    const prefix = profile.descriptionPrefixes[videoType] || "";
    const keywords = profile.keywordsByAudience[audience] || [];
    const priceInput = document.querySelector(SELECTORS.price);
    const description = document.querySelector(SELECTORS.description);
    const categoryCombo = document.querySelector(SELECTORS.categoryCombo);
    const relatedCombo = document.querySelector(SELECTORS.relatedCombo);
    const performerCombo = document.querySelector(SELECTORS.performerCombo);
    const orientationCombo = document.querySelector(SELECTORS.orientationCombo);

    if (!priceInput && !description && !categoryCombo && !orientationCombo) {
      throw new toolkit.ToolkitError(
        "FORM_NOT_FOUND",
        "The Clips4Sale upload form is not present.",
      );
    }

    const items = [];
    if (profile.category) {
      items.push(
        `Main category: ${toolkit.displayText(categoryCombo?.textContent) || "unset"} → ${profile.category}`,
      );
    } else {
      items.push(
        "Main category: unchanged (no approved category is configured; random taxonomy selection was removed)",
      );
    }
    if (profile.relatedCategories.length) {
      items.push(
        `Related categories: append exact ${profile.relatedCategories.join(", ")}`,
      );
    } else {
      items.push("Related categories: unchanged");
    }
    if (profile.performer) {
      items.push(
        `Performer: ${toolkit.displayText(performerCombo?.textContent) || "unset"} → ${profile.performer}, then exact Assign Performer`,
      );
    }
    items.push(
      `Audience: ${toolkit.displayText(orientationCombo?.textContent) || "unset"} → ${audience}`,
    );
    if (price) {
      items.push(`Price: ${controlValue(priceInput) || "unset"} → ${price}`);
    }
    if (prefix) {
      items.push(
        `Description: prepend configured ${videoType} notice while preserving current text`,
      );
    } else {
      items.push("Description: unchanged");
    }
    items.push(
      `Keywords: append up to ${keywords.length} exact configured values`,
    );
    items.push("Site Save/Submit remains manual.");

    return {
      audience,
      videoType,
      price,
      prefix,
      keywords,
      items,
      signature: formSignature(),
      current: {
        category: toolkit.displayText(categoryCombo?.textContent),
        related: toolkit.displayText(relatedCombo?.textContent),
        performer: toolkit.displayText(performerCombo?.textContent),
        orientation: toolkit.displayText(orientationCombo?.textContent),
        price: controlValue(priceInput),
        description: controlValue(description),
      },
    };
  }

  async function closeOwnedMenu(combo, menu, signal) {
    if (!menu?.isConnected || !toolkit.isVisible(menu)) return;
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    menu.dispatchEvent(escape);
    combo.dispatchEvent(escape);
    try {
      await toolkit.waitFor(
        () => !menu.isConnected || !toolkit.isVisible(menu),
        {
          signal,
          timeoutMs: 800,
          intervalMs: 40,
          description: `owned menu ${menu.id || "overlay"} to close`,
        },
      );
    } catch {
      toolkit.clickElement(combo, signal);
      await toolkit.waitFor(
        () => !menu.isConnected || !toolkit.isVisible(menu),
        {
          signal,
          timeoutMs: 800,
          intervalMs: 40,
          description: `owned menu ${menu.id || "overlay"} to close`,
        },
      );
    }
  }

  async function selectMuiExact({
    comboSelector,
    menuSelector,
    expected,
    multi = false,
    signal,
    budget,
  }) {
    const combo = toolkit.queryUnique(comboSelector, document, {
      description: `Clips4Sale control for ${expected}`,
    });
    if (exactLabelInContainer(combo, expected)) {
      return {
        label: expected,
        status: "unchanged",
        detail: "already selected",
      };
    }

    budget.step();
    toolkit.clickElement(combo, signal);
    const menu = await toolkit.waitFor(
      () => {
        const candidate = document.querySelector(menuSelector);
        return candidate && toolkit.isVisible(candidate) ? candidate : null;
      },
      {
        signal,
        timeoutMs: 4000,
        description: `owned Clips4Sale menu ${menuSelector}`,
      },
    );
    const controlledId = combo.getAttribute("aria-controls");
    if (controlledId && menu.id && controlledId !== menu.id) {
      throw new toolkit.ToolkitError(
        "MENU_OWNERSHIP",
        `The open menu ${menu.id} is not owned by ${comboSelector}.`,
      );
    }

    const search = menu.querySelector(
      'input[type="text"], input[placeholder*="search" i]',
    );
    if (search) {
      toolkit.setControlValue(search, expected);
    }

    const item = await toolkit.waitFor(
      () => {
        const options = Array.from(
          menu.querySelectorAll('li[role="option"], li[role="menuitem"]'),
        ).filter(toolkit.isVisible);
        const resolution = toolkit.resolveExact(options, expected, (element) =>
          toolkit.displayText(element.textContent),
        );
        if (resolution.status === "ambiguous") {
          throw new toolkit.ToolkitError(
            "AMBIGUOUS_TARGET",
            `Multiple exact Clips4Sale options match “${expected}”.`,
          );
        }
        return resolution.status === "found" ? resolution.element : null;
      },
      {
        signal,
        timeoutMs: 4000,
        intervalMs: 80,
        description: `exact Clips4Sale option “${expected}”`,
      },
    );

    budget.step();
    toolkit.clickElement(item, signal);
    await toolkit.waitFor(
      () => {
        if (multi) {
          const checkbox = item.querySelector('input[type="checkbox"]');
          return (
            checkbox?.checked ||
            item.getAttribute("aria-selected") === "true" ||
            exactLabelInContainer(combo, expected)
          );
        }
        return exactLabelInContainer(combo, expected);
      },
      {
        signal,
        timeoutMs: 2000,
        intervalMs: 60,
        description: `verified Clips4Sale selection “${expected}”`,
      },
    );
    await closeOwnedMenu(combo, menu, signal);
    return {
      label: expected,
      status: "changed",
      detail: "exact option selected and verified",
    };
  }

  async function assignPerformerExact(expected, signal, budget) {
    const unassign = toolkit
      .queryVisibleAll('button, [role="button"]')
      .find(
        (button) =>
          toolkit.normalizeText(toolkit.accessibleName(button)) ===
          "unassign performer",
      );
    const combo = toolkit.queryUnique(SELECTORS.performerCombo, document, {
      description: "performer selector",
    });
    if (unassign && exactLabelInContainer(combo, expected)) {
      return {
        label: `Performer ${expected}`,
        status: "unchanged",
        detail: "already assigned",
      };
    }

    const radio = document.querySelector(SELECTORS.performerRadio);
    if (radio instanceof HTMLInputElement && !radio.checked) {
      budget.step();
      toolkit.clickElement(radio, signal);
      await toolkit.waitFor(() => radio.checked, {
        signal,
        timeoutMs: 1200,
        description: "performer mode",
      });
    }

    if (!exactLabelInContainer(combo, expected)) {
      budget.step();
      toolkit.clickElement(combo, signal);
      const search = await toolkit.waitFor(
        () => {
          const candidate = document.querySelector(SELECTORS.performerSearch);
          return candidate && toolkit.isVisible(candidate) ? candidate : null;
        },
        {
          signal,
          timeoutMs: 4000,
          description: "performer search",
        },
      );
      toolkit.setControlValue(search, expected);
      const list = await toolkit.waitFor(
        () => {
          const candidate = document.querySelector(SELECTORS.performerList);
          return candidate && toolkit.isVisible(candidate) ? candidate : null;
        },
        {
          signal,
          timeoutMs: 4000,
          description: "performer result list",
        },
      );
      const performer = await toolkit.waitFor(
        () => {
          const candidates = Array.from(
            list.querySelectorAll('li[role="option"], li[role="menuitem"]'),
          ).filter(toolkit.isVisible);
          const resolution = toolkit.resolveExact(
            candidates,
            expected,
            (element) => toolkit.displayText(element.textContent),
          );
          if (resolution.status === "ambiguous") {
            throw new toolkit.ToolkitError(
              "AMBIGUOUS_PERFORMER",
              `Multiple exact performers match “${expected}”.`,
            );
          }
          return resolution.status === "found" ? resolution.element : null;
        },
        {
          signal,
          timeoutMs: 5000,
          description: `exact performer “${expected}”`,
        },
      );
      budget.step();
      toolkit.clickElement(performer, signal);
      await toolkit.waitFor(() => exactLabelInContainer(combo, expected), {
        signal,
        timeoutMs: 2000,
        description: `selected performer “${expected}”`,
      });
      await closeOwnedMenu(combo, list, signal);
    }

    const assign = toolkit.requireExact(
      toolkit.queryVisibleAll('button, [role="button"]'),
      "Assign Performer",
    );
    budget.step();
    toolkit.clickElement(assign, signal);
    await toolkit.waitFor(
      () =>
        toolkit
          .queryVisibleAll('button, [role="button"]')
          .some(
            (button) =>
              toolkit.normalizeText(toolkit.accessibleName(button)) ===
              "unassign performer",
          ),
      {
        signal,
        timeoutMs: 3000,
        description: `assigned performer “${expected}”`,
      },
    );
    return {
      label: `Performer ${expected}`,
      status: "changed",
      detail: "selected and assignment verified",
    };
  }

  function setExactInput(selector, value, label, signal, budget) {
    const input = toolkit.queryUnique(selector, document, {
      description: label,
    });
    if (String(input.value) === String(value)) {
      return {
        label,
        status: "unchanged",
        detail: String(value),
      };
    }
    budget.step();
    toolkit.throwIfAborted(signal);
    toolkit.setControlValue(input, value);
    if (String(input.value) !== String(value)) {
      throw new toolkit.ToolkitError(
        "POSTCONDITION_FAILED",
        `${label} did not retain “${value}”.`,
      );
    }
    return {
      label,
      status: "changed",
      detail: String(value),
    };
  }

  async function addKeywords(keywords, signal, budget) {
    const input = toolkit.queryUnique(SELECTORS.keywords, document, {
      description: "keyword input",
    });
    const outcomes = [];
    for (const keyword of keywords.slice(0, 15)) {
      toolkit.throwIfAborted(signal);
      if (currentKeywordLabels(input).has(toolkit.normalizeText(keyword))) {
        outcomes.push({
          label: `Keyword ${keyword}`,
          status: "unchanged",
          detail: "already present",
        });
        continue;
      }
      budget.step();
      input.focus();
      toolkit.setControlValue(input, keyword);
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await toolkit.waitFor(
        () => currentKeywordLabels(input).has(toolkit.normalizeText(keyword)),
        {
          signal,
          timeoutMs: 2500,
          intervalMs: 80,
          description: `accepted keyword “${keyword}”`,
        },
      );
      outcomes.push({
        label: `Keyword ${keyword}`,
        status: "changed",
        detail: "accepted and verified",
      });
    }
    return outcomes;
  }

  async function applyPlan(plan, profile, signal, budget) {
    if (formSignature() !== plan.signature) {
      throw new toolkit.ToolkitError(
        "STALE_PREVIEW",
        "The upload form changed after preview. Preview again before applying.",
      );
    }
    const outcomes = [];

    async function step(label, operation) {
      try {
        const result = await operation();
        if (Array.isArray(result)) outcomes.push(...result);
        else outcomes.push(result);
        return true;
      } catch (error) {
        outcomes.push({
          label,
          status: "failed",
          detail: error?.message || String(error),
        });
        return false;
      }
    }

    if (
      profile.category &&
      !(await step("Main category", () =>
        selectMuiExact({
          comboSelector: SELECTORS.categoryCombo,
          menuSelector: SELECTORS.categoryMenu,
          expected: profile.category,
          signal,
          budget,
        }),
      ))
    ) {
      return failedResult(outcomes);
    }

    for (const related of profile.relatedCategories) {
      if (
        !(await step(`Related category ${related}`, () =>
          selectMuiExact({
            comboSelector: SELECTORS.relatedCombo,
            menuSelector: SELECTORS.relatedMenu,
            expected: related,
            multi: true,
            signal,
            budget,
          }),
        ))
      ) {
        return failedResult(outcomes);
      }
    }

    if (
      profile.performer &&
      !(await step(`Performer ${profile.performer}`, () =>
        assignPerformerExact(profile.performer, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }

    if (
      !(await step(`Audience ${plan.audience}`, () =>
        selectMuiExact({
          comboSelector: SELECTORS.orientationCombo,
          menuSelector: SELECTORS.orientationMenu,
          expected: plan.audience,
          signal,
          budget,
        }),
      ))
    ) {
      return failedResult(outcomes);
    }

    if (
      plan.price &&
      !(await step("Price", async () =>
        setExactInput(SELECTORS.price, plan.price, "Price", signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }

    if (plan.prefix) {
      const description = toolkit.queryUnique(SELECTORS.description, document, {
        description: "description input",
      });
      const current = description.value || "";
      const desired = current.startsWith(plan.prefix)
        ? current
        : `${plan.prefix}${current}`;
      if (
        !(await step("Description prefix", async () =>
          setExactInput(
            SELECTORS.description,
            desired,
            "Description prefix",
            signal,
            budget,
          ),
        ))
      ) {
        return failedResult(outcomes);
      }
    }

    if (
      plan.keywords.length &&
      !(await step("Keywords", () =>
        addKeywords(plan.keywords, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }

    return {
      status: "success",
      summary:
        "Clips4Sale plan applied and verified. Review the form; site submission remains manual.",
      items: outcomes,
    };
  }

  function failedResult(outcomes) {
    return {
      status: outcomes.some((item) => item.status === "changed")
        ? "partial"
        : "failed",
      summary:
        "Clips4Sale stopped at the first failed invariant. Later steps were not attempted.",
      items: outcomes,
    };
  }

  function findThumbnailInput() {
    return /** @type {HTMLInputElement | null} */ (
      document.querySelector(
        'input[type="file"][data-testid="clip-thumbnail_[0]_input_nsfw-custom-uploader"]',
      )
    );
  }

  function openThumbnailUploader() {
    if (findThumbnailInput()) return;
    const replace = /** @type {HTMLButtonElement | null} */ (
      document.querySelector('[data-testid="clip-thumbnail_button_reupload"]')
    );
    const upload = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent.trim() === "Upload custom image",
    );
    (replace || upload)?.click();
  }

  function openFourKEditor(lifecycleSignal) {
    openThumbnailUploader();
    document.querySelector("[data-ofenhancer-4k-editor]")?.remove();
    const host = document.createElement("div");
    host.setAttribute("data-ofenhancer-4k-editor", "");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        dialog { width: min(1080px, calc(100vw - 32px)); max-height: min(860px, calc(100vh - 32px)); padding: 0; border: 1px solid #4a405a; border-radius: 16px; background: #1b1722; color: #f8f6fb; box-shadow: 0 20px 60px rgba(0,0,0,.55); font: 14px/1.45 system-ui, "Segoe UI", sans-serif; }
        dialog::backdrop { background: rgba(8,6,12,.78); }
        .head, .foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; }
        .head { border-bottom: 1px solid #382f43; }
        .foot { border-top: 1px solid #382f43; }
        h2 { margin: 0; font-size: 18px; line-height: 1.25; }
        p { margin: 4px 0 0; color: #c8c0d2; }
        .close { flex: 0 0 auto; font-size: 20px; line-height: 1; }
        .body { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 22px; padding: 20px; overflow: auto; max-height: calc(100vh - 170px); }
        .preview { min-width: 0; }
        .preview-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
        .preview-top strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .stage { display: grid; place-items: center; min-height: 280px; border: 1px dashed #5c506e; border-radius: 12px; background: #110e17; overflow: hidden; }
        canvas { display: block; width: 100%; height: auto; cursor: grab; touch-action: none; }
        canvas:active { cursor: grabbing; }
        canvas:focus-visible, button:focus-visible { outline: 2px solid #c5b3ff; outline-offset: 3px; }
        .hint { margin-top: 10px; font-size: 12px; }
        .styles h3 { margin: 0 0 10px; font-size: 13px; color: #ddd5e5; }
        .style-list { display: grid; gap: 8px; }
        button { border: 1px solid #625671; border-radius: 9px; padding: 8px 11px; background: #2b2435; color: #fff; font: inherit; cursor: pointer; }
        button:hover:not(:disabled) { background: #392f47; }
        button:disabled { opacity: .5; cursor: default; }
        .style-choice { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; text-align: left; }
        .style-choice[aria-pressed="true"] { border-color: #ae92ff; background: #352a49; }
        .sample { display: grid; place-items: center; width: 52px; height: 32px; flex: 0 0 auto; font-size: 16px; font-weight: 900; }
        .sample.wordmark { color: #fff; text-shadow: -2px -2px #000, 2px 2px #000; }
        .sample.dark { border-radius: 5px; background: #080808; color: #fff; }
        .sample.light { border-radius: 5px; background: #fff; color: #111; }
        .foot .status { margin: 0; min-height: 1em; font-size: 12px; }
        .set-thumbnail { border-color: #977af0; background: #7452dc; font-weight: 700; }
        input[type=file] { display: none; }
        @media (max-width: 720px) { .body { grid-template-columns: 1fr; gap: 16px; } .style-list { grid-template-columns: repeat(3, 1fr); } .style-choice { flex-direction: column; align-items: flex-start; } .stage { min-height: 180px; } }
      </style>
      <dialog aria-labelledby="ofenhancer4kTitle">
        <div class="head"><div><h2 id="ofenhancer4kTitle">4K thumbnail</h2><p>Choose an original image, then drag the 4K mark into place.</p></div><button class="close" type="button" aria-label="Close 4K editor">×</button></div>
        <div class="body">
          <div class="preview"><div class="preview-top"><strong class="filename">No image selected</strong><button class="choose" type="button">Choose image</button></div><div class="stage"><span class="empty">Your image will appear here</span><canvas aria-label="Thumbnail preview. Use arrow keys to move the 4K mark." tabindex="0" hidden></canvas></div><p class="hint">Drag the mark on the image. Arrow keys move it in small steps.</p></div>
          <div class="styles"><h3>4K style</h3><div class="style-list"><button class="style-choice" type="button" data-style="wordmark" aria-pressed="false"><span class="sample wordmark">4K</span><span>Wordmark</span></button><button class="style-choice" type="button" data-style="dark" aria-pressed="true"><span class="sample dark">4K</span><span>Dark badge</span></button><button class="style-choice" type="button" data-style="light" aria-pressed="false"><span class="sample light">4K</span><span>Light badge</span></button></div></div>
        </div>
        <div class="foot"><p class="status" role="status">The original image stays unchanged.</p><button class="set-thumbnail" type="button" disabled>Set thumbnail</button></div>
        <input class="file" type="file" accept="image/png,image/jpeg">
      </dialog>`;
    (document.documentElement || document.body).append(host);
    const dialog = shadow.querySelector("dialog");
    const canvas = shadow.querySelector("canvas");
    const context = canvas.getContext("2d");
    const fileInput = /** @type {HTMLInputElement} */ (
      shadow.querySelector(".file")
    );
    const status = shadow.querySelector(".status");
    const setThumbnail = /** @type {HTMLButtonElement} */ (
      shadow.querySelector(".set-thumbnail")
    );
    const styleChoices = /** @type {NodeListOf<HTMLButtonElement>} */ (
      shadow.querySelectorAll(".style-choice")
    );
    let bitmap = null;
    let file = null;
    let fileKey = null;
    let style = "dark";
    let position = { x: 0.88, y: 0.13 };
    let badge = null;
    let dragging = false;

    function close() {
      bitmap?.close();
      bitmap = null;
      if (dialog.open) dialog.close();
      host.remove();
      lifecycleSignal?.removeEventListener("abort", close);
    }
    lifecycleSignal?.addEventListener("abort", close, { once: true });
    dialog.addEventListener("close", close, { once: true });
    shadow.querySelector(".close").addEventListener("click", close);
    shadow
      .querySelector(".choose")
      .addEventListener("click", () => fileInput.click());

    function drawBadge(ctx, width, height) {
      const fontSize = Math.max(24, width * 0.075);
      ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
      const textWidth = ctx.measureText("4K").width;
      const pad = fontSize * 0.23;
      const badgeWidth = textWidth + pad * 2;
      const badgeHeight = fontSize * 1.35;
      const x = Math.max(
        0,
        Math.min(width - badgeWidth, position.x * width - badgeWidth / 2),
      );
      const y = Math.max(
        0,
        Math.min(height - badgeHeight, position.y * height - badgeHeight / 2),
      );
      if (style !== "wordmark") {
        ctx.fillStyle = style === "dark" ? "#090909" : "#fff";
        ctx.beginPath();
        ctx.roundRect(
          x,
          y,
          badgeWidth,
          badgeHeight,
          Math.max(4, fontSize * 0.13),
        );
        ctx.fill();
      }
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      if (style === "wordmark") {
        ctx.lineWidth = Math.max(3, fontSize * 0.1);
        ctx.strokeStyle = "#090909";
        ctx.strokeText("4K", x + badgeWidth / 2, y + badgeHeight / 2);
      }
      ctx.fillStyle = style === "light" ? "#111" : "#fff";
      ctx.fillText("4K", x + badgeWidth / 2, y + badgeHeight / 2);
      return { x, y, width: badgeWidth, height: badgeHeight };
    }

    function render() {
      if (!bitmap) return;
      const width = Math.min(bitmap.width, 900);
      canvas.width = width;
      canvas.height = Math.round((bitmap.height / bitmap.width) * width);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      badge = drawBadge(context, canvas.width, canvas.height);
    }

    function savePlacement() {
      if (!fileKey) return;
      void chrome.storage.local.set({ [fileKey]: { style, ...position } });
    }

    fileInput.addEventListener("change", async () => {
      const selected = fileInput.files?.[0];
      if (!selected) return;
      if (
        !["image/png", "image/jpeg"].includes(selected.type) ||
        selected.size > 50 * 1024 * 1024
      ) {
        status.textContent = "Choose a PNG or JPEG under 50 MB.";
        return;
      }
      try {
        const next = await createImageBitmap(selected);
        if (
          next.width < 1 ||
          next.height < 1 ||
          next.width > 10000 ||
          next.height > 10000
        ) {
          next.close();
          throw new Error("Image dimensions are unsupported.");
        }
        bitmap?.close();
        bitmap = next;
        file = selected;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await selected.arrayBuffer(),
        );
        fileKey =
          "c4s-4k-placement-" +
          Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        const saved = await new Promise((resolve) =>
          chrome.storage.local.get(fileKey, resolve),
        );
        const preset = saved[fileKey];
        style = ["wordmark", "dark", "light"].includes(preset?.style)
          ? preset.style
          : "dark";
        position =
          Number.isFinite(preset?.x) && Number.isFinite(preset?.y)
            ? {
                x: Math.min(1, Math.max(0, preset.x)),
                y: Math.min(1, Math.max(0, preset.y)),
              }
            : { x: 0.88, y: 0.13 };
        styleChoices.forEach((button) =>
          button.setAttribute(
            "aria-pressed",
            String(button.dataset.style === style),
          ),
        );
        shadow.querySelector(".filename").textContent = selected.name;
        /** @type {HTMLElement} */ (shadow.querySelector(".empty")).hidden =
          true;
        canvas.hidden = false;
        setThumbnail.disabled = false;
        status.textContent = preset
          ? "Previous 4K placement restored."
          : "Move the 4K mark, then set the thumbnail.";
        render();
      } catch (error) {
        status.textContent =
          error?.message || "That image could not be opened.";
      }
    });

    styleChoices.forEach((button) =>
      button.addEventListener("click", () => {
        style = button.dataset.style;
        styleChoices.forEach((choice) =>
          choice.setAttribute("aria-pressed", String(choice === button)),
        );
        render();
        savePlacement();
      }),
    );

    function point(event) {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - bounds.left) * canvas.width) / bounds.width,
        y: ((event.clientY - bounds.top) * canvas.height) / bounds.height,
      };
    }
    canvas.addEventListener("pointerdown", (event) => {
      if (!bitmap || !badge) return;
      const p = point(event);
      if (
        p.x < badge.x ||
        p.x > badge.x + badge.width ||
        p.y < badge.y ||
        p.y > badge.y + badge.height
      )
        return;
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const p = point(event);
      position = {
        x: Math.min(1, Math.max(0, p.x / canvas.width)),
        y: Math.min(1, Math.max(0, p.y / canvas.height)),
      };
      render();
    });
    for (const name of ["pointerup", "pointercancel"])
      canvas.addEventListener(name, () => {
        if (!dragging) return;
        dragging = false;
        savePlacement();
      });
    canvas.addEventListener("keydown", (event) => {
      const delta = {
        ArrowLeft: [-0.01, 0],
        ArrowRight: [0.01, 0],
        ArrowUp: [0, -0.01],
        ArrowDown: [0, 0.01],
      }[event.key];
      if (!delta || !bitmap) return;
      event.preventDefault();
      position = {
        x: Math.min(1, Math.max(0, position.x + delta[0])),
        y: Math.min(1, Math.max(0, position.y + delta[1])),
      };
      render();
      savePlacement();
    });

    setThumbnail.addEventListener("click", async () => {
      if (!bitmap || !file) return;
      setThumbnail.disabled = true;
      try {
        const target = findThumbnailInput();
        if (!target)
          throw new Error(
            "Open the Previews step, then reopen this editor to set the thumbnail.",
          );
        const output = document.createElement("canvas");
        const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
        output.width = Math.round(bitmap.width * scale);
        output.height = Math.round(bitmap.height * scale);
        if (
          output.width < 877 ||
          output.height < 493 ||
          Math.abs(output.width / output.height - 16 / 9) > 0.01
        )
          throw new Error(
            "Clips4Sale requires a 16:9 image at least 877 × 493.",
          );
        const outputContext = output.getContext("2d");
        outputContext.drawImage(bitmap, 0, 0, output.width, output.height);
        drawBadge(outputContext, output.width, output.height);
        const encode = (type, quality) =>
          new Promise((resolve) => output.toBlob(resolve, type, quality));
        let blob = await encode("image/png");
        if (blob?.size > 5 * 1024 * 1024)
          for (const quality of [0.9, 0.8, 0.7]) {
            blob = await encode("image/jpeg", quality);
            if (blob?.size <= 5 * 1024 * 1024) break;
          }
        if (!blob) throw new Error("The 4K image could not be created.");
        if (blob.size > 5 * 1024 * 1024)
          throw new Error("The 4K image exceeds Clips4Sale’s 5 MB limit.");
        const generated = new File(
          [blob],
          file.name.replace(/\.[^.]+$/, "") +
            (blob.type === "image/jpeg" ? "_4k.jpg" : "_4k.png"),
          { type: blob.type, lastModified: Date.now() },
        );
        const transfer = new DataTransfer();
        transfer.items.add(generated);
        target.files = transfer.files;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        savePlacement();
        status.textContent = "4K thumbnail sent to the Clips4Sale uploader.";
      } catch (error) {
        status.textContent =
          error?.message || "The 4K thumbnail could not be set.";
      } finally {
        setThumbnail.disabled = false;
      }
    });
    dialog.showModal();
  }

  async function mount({ signal, profile }) {
    let audience = profile.audience;
    let videoType = profile.videoType;
    const panel = toolkit.createToolPanel({
      id: "c4sUpload",
      title: "Clips4Sale upload assistant",
      description:
        "Serial, exact, previewed changes. Random categories and generic overlay closing are removed.",
    });
    panel.addSelect({
      id: "audience",
      label: "Audience",
      options: Object.keys(profile.keywordsByAudience),
      value: audience,
      onChange: (value) => {
        audience = value;
        panel.clearPlan();
      },
    });
    panel.addSelect({
      id: "video-type",
      label: "Video type",
      options: Object.keys(profile.prices),
      value: videoType,
      onChange: (value) => {
        videoType = value;
        panel.clearPlan();
      },
    });

    const runner = toolkit.createActionRunner({
      toolId: "c4sUpload",
      panel,
      lifecycleSignal: signal,
      maxActions:
        20 +
        profile.relatedCategories.length * 2 +
        (profile.keywordsByAudience[audience]?.length || 0),
      maxDurationMs: 120000,
    });

    async function preview() {
      const plan = inspectForm(profile, audience, videoType);
      panel.showPlan({
        summary: "Review the complete Clips4Sale form plan.",
        items: plan.items,
        confirmLabel: "Apply verified plan",
        onConfirm: () =>
          runner.run("Applying Clips4Sale plan", ({ signal, budget }) =>
            applyPlan(plan, profile, signal, budget),
          ),
      });
      panel.setStatus(
        profile.category
          ? "Preview ready. Nothing has changed."
          : "Preview ready. Main category is intentionally unchanged until an approved profile category is configured.",
        profile.category ? "neutral" : "warning",
      );
    }

    panel.addAction({
      id: "preview",
      label: "Preview upload plan",
      variant: "primary",
      onClick: preview,
    });
    panel.addAction({
      id: "four-k-thumbnail",
      label: "4K thumbnail",
      onClick: () => openFourKEditor(signal),
    });
    panel.addAction({
      id: "stop",
      label: "Stop",
      variant: "danger",
      allowWhileRunning: true,
      onClick: () => runner.stop(),
    });

    return () => {
      runner.stop("Clips4Sale tool disposed.");
      panel.destroy();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.c4sUpload = Object.freeze({
    inspectForm,
    selectMuiExact,
    assignPerformerExact,
    formSignature,
  });

  toolkit.mountTool({
    id: "c4sUpload",
    match: (location) =>
      location.origin === "https://workspace.clips4sale.com" &&
      location.pathname.startsWith("/upload"),
    mount,
  });
})();
