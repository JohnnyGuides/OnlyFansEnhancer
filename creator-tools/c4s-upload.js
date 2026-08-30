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
