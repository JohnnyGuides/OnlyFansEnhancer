(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const TAG_INPUT_SELECTOR = 'input[name="tags"]';
  const CATEGORY_INPUT_SELECTOR =
    'input[name="category"], input[name="categoryInput"]';

  function tokenFieldRoot(input) {
    return (
      input.closest(".c-input-container")?.parentElement ||
      input.closest(".c-input-wrapper")?.parentElement ||
      input.parentElement?.parentElement ||
      input.parentElement ||
      document
    );
  }

  function selectedTokenLabels(input, suggestionListId) {
    const root = tokenFieldRoot(input);
    const suggestionList = root.querySelector(
      `#${CSS.escape(suggestionListId)}`,
    );
    const selectors = [
      "[data-tag-name]",
      "[data-category-name]",
      ".c-tag",
      ".tag",
      ".chip",
      ".token",
      "[class*='tag-item']",
      "[class*='selected-item']",
      "[class*='chip']",
    ].join(",");
    const labels = new Set();
    for (const element of root.querySelectorAll(selectors)) {
      if (suggestionList?.contains(element)) continue;
      const label = toolkit.normalizeText(
        element.getAttribute("data-tag-name") ||
          element.getAttribute("data-category-name") ||
          element.textContent,
      );
      if (label) labels.add(label);
    }
    return labels;
  }

  function listSignature(list) {
    if (!list) return "";
    return Array.from(list.querySelectorAll("li"))
      .map(
        (item) =>
          `${item.getAttribute("data-value") || ""}\u0000${toolkit.displayText(
            item.textContent,
          )}`,
      )
      .join("\u0001");
  }

  async function selectExactToken({
    input,
    token,
    suggestionListId,
    signal,
    budget,
  }) {
    const expectedKey = toolkit.normalizeText(token);
    if (selectedTokenLabels(input, suggestionListId).has(expectedKey)) {
      return {
        label: token,
        status: "unchanged",
        detail: "already selected",
      };
    }

    const list = document.getElementById(suggestionListId);
    const beforeSignature = listSignature(list);
    input.focus();
    toolkit.setControlValue(input, "");
    toolkit.setControlValue(input, token);

    const exactItem = await toolkit.waitFor(
      () => {
        const currentList = document.getElementById(suggestionListId);
        if (!currentList || !toolkit.isVisible(currentList)) return null;
        const signature = listSignature(currentList);
        if (!signature || signature === beforeSignature) return null;
        const items = Array.from(currentList.querySelectorAll("li")).filter(
          toolkit.isVisible,
        );
        const resolution = toolkit.resolveExact(items, token, (element) =>
          toolkit.displayText(element.textContent),
        );
        if (resolution.status === "ambiguous") {
          throw new toolkit.ToolkitError(
            "AMBIGUOUS_TARGET",
            `Multiple exact Pornhub suggestions match “${token}”.`,
          );
        }
        return resolution.status === "found" ? resolution.element : null;
      },
      {
        signal,
        timeoutMs: 6500,
        intervalMs: 80,
        description: `fresh exact Pornhub suggestion “${token}”`,
      },
    );

    budget.step();
    toolkit.clickElement(exactItem, signal);
    await toolkit.waitFor(
      () => selectedTokenLabels(input, suggestionListId).has(expectedKey),
      {
        signal,
        timeoutMs: 2500,
        intervalMs: 80,
        description: `selected Pornhub token “${token}”`,
      },
    );
    return {
      label: token,
      status: "changed",
      detail: "exact token selected and verified",
    };
  }

  async function selectOrientation(expected, signal, budget) {
    const host = toolkit.queryUnique(
      'custom-dropdown[data-key="orientation"]',
      document,
      { description: "Pornhub orientation control" },
    );
    const trigger = toolkit.queryUnique(".customSelectTrigger", host, {
      description: "Pornhub orientation trigger",
    });
    if (
      toolkit.normalizeText(toolkit.accessibleName(trigger)) ===
      toolkit.normalizeText(expected)
    ) {
      return {
        label: "Orientation",
        status: "unchanged",
        detail: expected,
      };
    }
    budget.step();
    toolkit.clickElement(trigger, signal);
    const option = await toolkit.waitFor(
      () => {
        const local = Array.from(
          host.querySelectorAll(".customOptions .customOption"),
        ).filter(toolkit.isVisible);
        const resolution = toolkit.resolveExact(local, expected, (element) =>
          toolkit.displayText(element.textContent),
        );
        if (resolution.status === "ambiguous") {
          throw new toolkit.ToolkitError(
            "AMBIGUOUS_ORIENTATION",
            `Multiple exact orientation options match “${expected}”.`,
          );
        }
        return resolution.status === "found" ? resolution.element : null;
      },
      {
        signal,
        timeoutMs: 3000,
        description: `exact orientation “${expected}”`,
      },
    );
    budget.step();
    toolkit.clickElement(option, signal);
    await toolkit.waitFor(
      () =>
        toolkit.normalizeText(toolkit.accessibleName(trigger)) ===
        toolkit.normalizeText(expected),
      {
        signal,
        timeoutMs: 2000,
        description: `verified orientation “${expected}”`,
      },
    );
    return {
      label: "Orientation",
      status: "changed",
      detail: expected,
    };
  }

  function formSignature() {
    const orientation = document.querySelector(
      'custom-dropdown[data-key="orientation"] .customSelectTrigger',
    );
    const tagInput = document.querySelector(TAG_INPUT_SELECTOR);
    const categoryInput = document.querySelector(CATEGORY_INPUT_SELECTOR);
    return JSON.stringify({
      orientation: toolkit.accessibleName(orientation),
      tags: tagInput
        ? Array.from(selectedTokenLabels(tagInput, "inputTag")).sort()
        : [],
      categories: categoryInput
        ? Array.from(selectedTokenLabels(categoryInput, "f2vCategory")).sort()
        : [],
    });
  }

  function inspectPreset(name, preset) {
    const tagInput = document.querySelector(TAG_INPUT_SELECTOR);
    const categoryInput = document.querySelector(CATEGORY_INPUT_SELECTOR);
    const currentTags = tagInput
      ? selectedTokenLabels(tagInput, "inputTag")
      : new Set();
    const currentCategories = categoryInput
      ? selectedTokenLabels(categoryInput, "f2vCategory")
      : new Set();
    const tagsToAdd = preset.tags.filter(
      (tag) => !currentTags.has(toolkit.normalizeText(tag)),
    );
    const categoriesToAdd = preset.categories.filter(
      (category) => !currentCategories.has(toolkit.normalizeText(category)),
    );
    return {
      name,
      preset,
      tagsToAdd,
      categoriesToAdd,
      signature: formSignature(),
      items: [
        `Orientation: exact “${preset.orientation}”`,
        `Append ${tagsToAdd.length} missing tag(s): ${tagsToAdd.join(", ") || "none"}`,
        `Append ${categoriesToAdd.length} missing category/categories: ${
          categoriesToAdd.join(", ") || "none"
        }`,
        "Existing tags/categories are preserved.",
        "No fuzzy or first-result substitution is allowed.",
        "Site Save/Submit remains manual.",
      ],
    };
  }

  function resolvePreset(profile, seasonArc, explicitName) {
    const presets = profile?.presets || {};
    const explicit = String(explicitName || "").trim();
    if (explicit) {
      return Object.hasOwn(presets, explicit)
        ? { name: explicit, preset: presets[explicit], source: "explicit" }
        : null;
    }
    const expectedSeries = toolkit.normalizeText(seasonArc);
    if (!expectedSeries) return null;
    const matches = Object.entries(profile?.seriesPresets || {}).filter(
      ([series]) => toolkit.normalizeText(series) === expectedSeries,
    );
    if (matches.length !== 1) return null;
    const name = String(matches[0][1] || "").trim();
    return Object.hasOwn(presets, name)
      ? { name, preset: presets[name], source: "series" }
      : null;
  }

  async function applyPreset(plan, signal, budget) {
    if (formSignature() !== plan.signature) {
      throw new toolkit.ToolkitError(
        "STALE_PREVIEW",
        "The Pornhub uploader changed after preview. Preview the preset again.",
      );
    }
    const outcomes = [];

    async function step(label, operation) {
      try {
        outcomes.push(await operation());
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

    const solo = document.querySelector('input[type="radio"][value="solo"]');
    if (solo instanceof HTMLInputElement && !solo.checked) {
      if (
        !(await step("Solo/Animation", async () => {
          budget.step();
          toolkit.clickElement(solo, signal);
          await toolkit.waitFor(() => solo.checked, {
            signal,
            timeoutMs: 1500,
            description: "Solo/Animation radio state",
          });
          return {
            label: "Solo/Animation",
            status: "changed",
            detail: "selected and verified",
          };
        }))
      ) {
        return failedResult(outcomes);
      }
    }

    if (
      !(await step("Orientation", () =>
        selectOrientation(plan.preset.orientation, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }

    const tagInput = toolkit.queryUnique(TAG_INPUT_SELECTOR, document, {
      description: "Pornhub tag input",
    });
    for (const tag of plan.tagsToAdd) {
      if (
        !(await step(`Tag ${tag}`, () =>
          selectExactToken({
            input: tagInput,
            token: tag,
            suggestionListId: "inputTag",
            signal,
            budget,
          }),
        ))
      ) {
        return failedResult(outcomes);
      }
    }

    const categoryInput = toolkit.queryUnique(
      CATEGORY_INPUT_SELECTOR,
      document,
      { description: "Pornhub category input" },
    );
    for (const category of plan.categoriesToAdd) {
      if (
        !(await step(`Category ${category}`, () =>
          selectExactToken({
            input: categoryInput,
            token: category,
            suggestionListId: "f2vCategory",
            signal,
            budget,
          }),
        ))
      ) {
        return failedResult(outcomes);
      }
    }

    return {
      status: "success",
      summary: `Pornhub preset “${plan.name}” applied with exact verified values. Review and submit manually.`,
      items: outcomes,
    };
  }

  function failedResult(outcomes) {
    return {
      status: outcomes.some((item) => item.status === "changed")
        ? "partial"
        : "failed",
      summary:
        "Pornhub stopped at the first missing, ambiguous, stale, or unverified value.",
      items: outcomes,
    };
  }

  async function mount({ signal, profile }) {
    const panel = toolkit.createToolPanel({
      id: "phUploader",
      title: "Pornhub uploader presets",
      description:
        "Previewed append-only presets with exact fresh autocomplete matches.",
    });
    const runner = toolkit.createActionRunner({
      toolId: "phUploader",
      panel,
      lifecycleSignal: signal,
      maxActions: 100,
      maxDurationMs: 180000,
    });

    for (const [name, preset] of Object.entries(profile.presets)) {
      panel.addAction({
        id: `preset-${toolkit.normalizeText(name).replace(/\W+/g, "-")}`,
        label: name,
        onClick: () => {
          const plan = inspectPreset(name, preset);
          panel.showPlan({
            summary: `Review Pornhub preset “${name}”.`,
            items: plan.items,
            confirmLabel: `Apply ${name}`,
            onConfirm: () =>
              runner.run(`Applying ${name} preset`, ({ signal, budget }) =>
                applyPreset(plan, signal, budget),
              ),
          });
          panel.setStatus("Preview ready. Nothing has changed.", "neutral");
        },
      });
    }
    panel.addAction({
      id: "stop",
      label: "Stop",
      variant: "danger",
      allowWhileRunning: true,
      onClick: () => runner.stop(),
    });

    return () => {
      runner.stop("Pornhub tool disposed.");
      panel.destroy();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.phUploader = Object.freeze({
    selectedTokenLabels,
    listSignature,
    selectExactToken,
    selectOrientation,
    inspectPreset,
    resolvePreset,
    applyPreset,
    failedResult,
  });

  if (!globalThis.CreatorToolkitMasterRun) {
    toolkit.mountTool({
      id: "phUploader",
      match: (location) =>
        location.origin === "https://pornhub.mainhub.com" &&
        location.pathname.startsWith("/upload/uploader"),
      mount,
    });
  }
})();
