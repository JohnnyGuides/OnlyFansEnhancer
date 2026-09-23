(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const TAG_INPUT_SELECTOR = 'input[name="tags"]';
  const CATEGORY_INPUT_SELECTOR =
    'input[name="category"], input[name="categoryInput"]';
  const ORIENTATION_HOST =
    'custom-dropdown[data-key="orientation"], .dropdownElement[data-error="orientation"]';
  const ORIENTATION_TRIGGER = ".customSelectTrigger, .selectedValue";

  function tokenFieldRoot(input) {
    const siteField = input.closest("v-input")?.parentElement;
    if (siteField?.querySelector(":scope > .c-pills-container"))
      return siteField;
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
      ".c-pill",
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
    allowUnavailable = false,
  }) {
    const expectedKey = toolkit.normalizeText(token);
    if (selectedTokenLabels(input, suggestionListId).has(expectedKey)) {
      return {
        label: token,
        status: "unchanged",
        detail: "already selected",
      };
    }

    const root = tokenFieldRoot(input);
    const listSelector = `#${CSS.escape(suggestionListId)}`;
    const list = root.querySelector(listSelector);
    const beforeSignature = listSignature(list);
    let sawFreshSuggestions = false;
    let ambiguousSuggestions = false;
    input.focus();
    toolkit.setControlValue(input, "");
    toolkit.setControlValue(input, token);

    let exactItem;
    try {
      exactItem = await toolkit.waitFor(
        () => {
          const currentList = root.querySelector(listSelector);
          if (!currentList || !toolkit.isVisible(currentList)) return null;
          const signature = listSignature(currentList);
          if (!signature || signature === beforeSignature) return null;
          sawFreshSuggestions = true;
          const items = Array.from(currentList.querySelectorAll("li")).filter(
            toolkit.isVisible,
          );
          const resolution = toolkit.resolveExact(items, token, (element) =>
            toolkit.displayText(element.textContent),
          );
          if (resolution.status === "ambiguous") {
            ambiguousSuggestions = true;
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
    } catch (error) {
      if (ambiguousSuggestions)
        throw new toolkit.ToolkitError(
          "AMBIGUOUS_TARGET",
          `Multiple exact Pornhub suggestions match “${token}”.`,
        );
      if (
        !allowUnavailable ||
        error?.code !== "TIMEOUT" ||
        !sawFreshSuggestions
      )
        throw error;
      toolkit.setControlValue(input, "");
      return {
        label: token,
        status: "unavailable",
        detail: "No exact site suggestion; omitted from this draft",
      };
    }

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
    const host = toolkit.queryUnique(ORIENTATION_HOST, document, {
      description: "Pornhub orientation control",
    });
    const trigger = toolkit.queryUnique(ORIENTATION_TRIGGER, host, {
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
          host.querySelectorAll(
            ".customOptions .customOption, .c-drop-wrapper__list .c-drop-wrapper__option",
          ),
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

  function formSignature(mode = "free") {
    const orientationHost = toolkit.queryUnique(ORIENTATION_HOST, document, {
      optional: true,
    });
    const orientation = orientationHost
      ? toolkit.queryUnique(ORIENTATION_TRIGGER, orientationHost)
      : null;
    const videoType = toolkit.queryUnique(
      '[data-error="videoType"] .selectedValue, [data-key="videoType"] .customSelectTrigger',
      document,
      { optional: true },
    );
    const tagInput = toolkit.queryUnique(TAG_INPUT_SELECTOR, document, {
      optional: true,
    });
    const categoryInput =
      mode === "free"
        ? toolkit.queryUnique(CATEGORY_INPUT_SELECTOR, document, {
            optional: true,
          })
        : null;
    const tagListId = mode === "paid" ? "inputFancentroTag" : "inputTag";
    return JSON.stringify({
      videoType: toolkit.accessibleName(videoType),
      orientation: toolkit.accessibleName(orientation),
      tags: tagInput
        ? Array.from(selectedTokenLabels(tagInput, tagListId)).sort()
        : [],
      categories: categoryInput
        ? Array.from(selectedTokenLabels(categoryInput, "f2vCategory")).sort()
        : [],
    });
  }

  function inspectPreset(name, preset, { mode = "free" } = {}) {
    if (!["free", "paid"].includes(mode))
      throw new Error("Unsupported Pornhub video type.");
    const tagInput = toolkit.queryUnique(TAG_INPUT_SELECTOR, document, {
      optional: true,
    });
    const categoryInput =
      mode === "free"
        ? toolkit.queryUnique(CATEGORY_INPUT_SELECTOR, document, {
            optional: true,
          })
        : null;
    const tagListId = mode === "paid" ? "inputFancentroTag" : "inputTag";
    const currentTags = tagInput
      ? selectedTokenLabels(tagInput, tagListId)
      : new Set();
    const currentCategories = categoryInput
      ? selectedTokenLabels(categoryInput, "f2vCategory")
      : new Set();
    const desiredTags = mode === "paid" ? preset.tags.slice(0, 7) : preset.tags;
    if (mode === "paid" && (desiredTags.length < 2 || desiredTags.length > 7))
      throw new Error("Pornhub Pay To View requires 2–7 saved tags.");
    const tagsToAdd = desiredTags.filter(
      (tag) => !currentTags.has(toolkit.normalizeText(tag)),
    );
    if (mode === "paid" && currentTags.size + tagsToAdd.length > 7)
      throw new Error(
        "Pornhub Pay To View already has tags outside the saved seven-tag preset; review them before retrying.",
      );
    const categoriesToAdd = (mode === "free" ? preset.categories : []).filter(
      (category) => !currentCategories.has(toolkit.normalizeText(category)),
    );
    return {
      name,
      mode,
      tagListId,
      preset,
      tagsToAdd,
      categoriesToAdd,
      signature: formSignature(mode),
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
    if (formSignature(plan.mode) !== plan.signature) {
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
            suggestionListId: plan.tagListId || "inputTag",
            signal,
            budget,
            allowUnavailable: true,
          }),
        ))
      ) {
        return failedResult(outcomes);
      }
    }
    if (
      outcomes.some((item) => item.status === "unavailable") &&
      selectedTokenLabels(tagInput, plan.tagListId).size < 2
    ) {
      return failedResult([
        ...outcomes,
        {
          label: "Tags",
          status: "failed",
          detail:
            "Fewer than two accepted site tags remain after omitting unavailable tags.",
        },
      ]);
    }

    if (plan.mode !== "paid") {
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
    }

    return {
      status: "success",
      summary: `Pornhub preset “${plan.name}” applied with verified available values. Review and submit manually.`,
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
})();
