(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const SELECTORS = Object.freeze({
    coPerformer: "select#co-performer",
    price: "#appendedPrependedInput",
    launchTime: "#available_time",
    tagInput: "#input-new-custom-tag-filter",
    tagSuggestions: "#dropdown-items-custom-tags",
  });

  function activeForm() {
    const tagInput = document.querySelector(SELECTORS.tagInput);
    const form = tagInput?.closest("form");
    if (form && toolkit.isVisible(form)) return form;
    const forms = Array.from(document.querySelectorAll("form")).filter(
      (candidate) =>
        toolkit.isVisible(candidate) &&
        (candidate.querySelector(SELECTORS.price) ||
          candidate.querySelector(SELECTORS.coPerformer)),
    );
    if (forms.length === 1) return forms[0];
    throw new toolkit.ToolkitError(
      forms.length ? "AMBIGUOUS_FORM" : "FORM_NOT_FOUND",
      forms.length
        ? `Expected one visible ManyVids edit form; found ${forms.length}.`
        : "The visible ManyVids edit form is not ready.",
    );
  }

  function controlLabel(control) {
    if (!control) return "";
    const id = control.id;
    const associated = id
      ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
      : null;
    return toolkit.displayText(
      control.getAttribute("aria-label") ||
        associated?.textContent ||
        control.closest("label")?.textContent ||
        control.getAttribute("title") ||
        "",
    );
  }

  function selectedTags(form) {
    const result = new Map();
    for (const input of form.querySelectorAll(
      '.multi-dropdown-list input[name="tags[]"]',
    )) {
      const container =
        input.closest("li") ||
        input.closest("[data-tag-name]") ||
        input.parentElement;
      const label = toolkit.displayText(
        container?.getAttribute("data-tag-name") ||
          container
            ?.querySelector("[data-label]")
            ?.getAttribute("data-label") ||
          container?.textContent ||
          input.getAttribute("data-label") ||
          "",
      );
      if (label) result.set(toolkit.normalizeText(label), { label, input });
    }
    return result;
  }

  function suggestionSignature(container) {
    if (!container) return "";
    return Array.from(
      container.querySelectorAll(
        'li, [role="option"], [data-value], button[data-tag]',
      ),
    )
      .map(
        (element) =>
          `${element.getAttribute("data-value") || ""}\u0000${toolkit.displayText(
            element.textContent,
          )}`,
      )
      .join("\u0001");
  }

  async function addExactTag(form, tag, signal, budget) {
    if (selectedTags(form).has(toolkit.normalizeText(tag))) {
      return {
        label: `Tag ${tag}`,
        status: "unchanged",
        detail: "already present",
      };
    }
    if (selectedTags(form).size >= 10) {
      return {
        label: `Tag ${tag}`,
        status: "skipped",
        detail: "ManyVids ten-tag capacity reached",
      };
    }

    const input = toolkit.queryUnique(SELECTORS.tagInput, form, {
      description: "ManyVids tag input",
    });
    const oldContainer = document.querySelector(SELECTORS.tagSuggestions);
    const oldSignature = suggestionSignature(oldContainer);
    input.focus();
    toolkit.setControlValue(input, "");
    toolkit.setControlValue(input, tag);

    const option = await toolkit.waitFor(
      () => {
        const container = document.querySelector(SELECTORS.tagSuggestions);
        if (!container || !toolkit.isVisible(container)) return null;
        const signature = suggestionSignature(container);
        if (!signature || signature === oldSignature) return null;
        const candidates = Array.from(
          container.querySelectorAll(
            'li, [role="option"], [data-value], button[data-tag]',
          ),
        ).filter(
          (element) =>
            toolkit.isVisible(element) &&
            !element.matches(".not-found-button-section-custom-tag"),
        );
        const resolution = toolkit.resolveExact(candidates, tag, (element) =>
          toolkit.displayText(element.textContent),
        );
        if (resolution.status === "ambiguous") {
          throw new toolkit.ToolkitError(
            "AMBIGUOUS_TAG",
            `Multiple exact ManyVids suggestions match “${tag}”.`,
          );
        }
        return resolution.status === "found" ? resolution.element : null;
      },
      {
        signal,
        timeoutMs: 5000,
        intervalMs: 80,
        description: `fresh exact ManyVids tag “${tag}”`,
      },
    );

    budget.step();
    toolkit.clickElement(option, signal);
    await toolkit.waitFor(
      () => selectedTags(form).has(toolkit.normalizeText(tag)),
      {
        signal,
        timeoutMs: 2500,
        intervalMs: 80,
        description: `selected ManyVids tag “${tag}”`,
      },
    );
    toolkit.setControlValue(input, "");
    return {
      label: `Tag ${tag}`,
      status: "changed",
      detail: "exact tag selected and verified",
    };
  }

  function inspectModeControl(form, selector, expectedLabel) {
    const control = form.querySelector(selector);
    const actualLabel = controlLabel(control);
    if (!control) {
      return {
        selector,
        expectedLabel,
        control: null,
        safe: false,
        detail: "control not present",
      };
    }
    if (!expectedLabel) {
      return {
        selector,
        expectedLabel,
        control,
        safe: false,
        detail: `not configured; visible label is “${actualLabel || "unlabelled"}”`,
      };
    }
    return {
      selector,
      expectedLabel,
      control,
      safe:
        toolkit.normalizeText(actualLabel) ===
        toolkit.normalizeText(expectedLabel),
      detail:
        toolkit.normalizeText(actualLabel) ===
        toolkit.normalizeText(expectedLabel)
          ? "exact label verified"
          : `expected “${expectedLabel}”, found “${actualLabel || "unlabelled"}”`,
    };
  }

  function formSignature(form) {
    const fields = [
      SELECTORS.coPerformer,
      SELECTORS.price,
      SELECTORS.launchTime,
      SELECTORS.tagInput,
      "#free_vid_0",
      "#launchCustom",
      "#membership3",
      "#premium2",
    ];
    return JSON.stringify({
      fields: fields.map((selector) => {
        const element = form.querySelector(selector);
        return {
          selector,
          value: element?.value ?? "",
          checked: element?.checked ?? null,
          label: controlLabel(element),
        };
      }),
      tags: Array.from(selectedTags(form).keys()).sort(),
    });
  }

  function inspectForm(form, profile) {
    const coPerformer = form.querySelector(SELECTORS.coPerformer);
    const price = form.querySelector(SELECTORS.price);
    const launchTime = form.querySelector(SELECTORS.launchTime);
    const existingTags = selectedTags(form);
    const tagsToAdd = profile.tags.filter(
      (tag) => !existingTags.has(toolkit.normalizeText(tag)),
    );
    const priceMode = inspectModeControl(
      form,
      profile.priceModeSelector,
      profile.priceModeExpectedLabel,
    );
    const launchMode = inspectModeControl(
      form,
      profile.launchModeSelector,
      profile.launchModeExpectedLabel,
    );
    const membership = inspectModeControl(
      form,
      profile.membershipSelector,
      profile.membershipExpectedLabel,
    );
    const premium = inspectModeControl(
      form,
      profile.premiumSelector,
      profile.premiumExpectedLabel,
    );

    return {
      form,
      profile,
      priceMode,
      launchMode,
      membership,
      premium,
      tagsToAdd,
      signature: formSignature(form),
      items: [
        `Co-performer: ${coPerformer?.selectedOptions?.[0]?.textContent?.trim() || "unset"} → exact “${profile.coPerformer}”`,
        `Price mode ${profile.priceModeSelector}: ${priceMode.detail}${
          priceMode.safe ? " (will select if needed)" : " (will not click)"
        }`,
        `Price: ${price?.value || "unset"} → ${profile.price}`,
        `Launch mode ${profile.launchModeSelector}: ${launchMode.detail}${
          launchMode.safe ? " (will select if needed)" : " (will not click)"
        }`,
        `Launch time: ${launchTime?.selectedOptions?.[0]?.textContent?.trim() || "unset"} → exact “${profile.launchTimeLabel}”`,
        `Membership ${profile.membershipSelector}: ${membership.detail}${
          membership.safe ? " (will select if needed)" : " (will not click)"
        }`,
        `Premium ${profile.premiumSelector}: ${premium.detail}${
          premium.safe ? " (will select if needed)" : " (will not click)"
        }`,
        `Append ${tagsToAdd.length} missing exact tag(s): ${tagsToAdd.join(", ") || "none"}`,
        "Existing tags are preserved; capacity is capped at ten.",
        "Site Save/Submit remains manual.",
      ],
    };
  }

  async function selectRadioIfSafe(inspection, signal, budget) {
    if (!inspection.safe) {
      return {
        label: inspection.selector,
        status: "skipped",
        detail: inspection.detail,
      };
    }
    const control = inspection.control;
    if (control.checked || control.getAttribute("aria-checked") === "true") {
      return {
        label: inspection.expectedLabel,
        status: "unchanged",
        detail: "already selected",
      };
    }
    budget.step();
    toolkit.clickElement(control, signal);
    await toolkit.waitFor(
      () => control.checked || control.getAttribute("aria-checked") === "true",
      {
        signal,
        timeoutMs: 1500,
        description: `ManyVids mode “${inspection.expectedLabel}”`,
      },
    );
    return {
      label: inspection.expectedLabel,
      status: "changed",
      detail: "exact labelled mode selected",
    };
  }

  function setField(element, value, label, signal, budget) {
    if (!element) {
      throw new toolkit.ToolkitError(
        "MISSING_CONTROL",
        `${label} control is unavailable.`,
      );
    }
    if (String(element.value) === String(value)) {
      return { label, status: "unchanged", detail: String(value) };
    }
    budget.step();
    toolkit.throwIfAborted(signal);
    toolkit.setControlValue(element, value);
    if (String(element.value) !== String(value)) {
      throw new toolkit.ToolkitError(
        "POSTCONDITION_FAILED",
        `${label} did not retain “${value}”.`,
      );
    }
    return { label, status: "changed", detail: String(value) };
  }

  async function selectExactOption(
    select,
    expectedLabel,
    fallbackValue,
    signal,
    budget,
  ) {
    const options = Array.from(select.options);
    let resolution = toolkit.resolveExact(options, expectedLabel, (option) =>
      toolkit.displayText(option.textContent),
    );
    if (resolution.status === "missing" && fallbackValue) {
      const byValue = options.filter(
        (option) => String(option.value) === String(fallbackValue),
      );
      resolution =
        byValue.length === 1
          ? { status: "found", element: byValue[0] }
          : {
              status: byValue.length ? "ambiguous" : "missing",
              matches: byValue,
            };
    }
    if (resolution.status !== "found") {
      throw new toolkit.ToolkitError(
        resolution.status === "ambiguous"
          ? "AMBIGUOUS_OPTION"
          : "MISSING_OPTION",
        `Could not resolve one exact option “${expectedLabel}”.`,
      );
    }
    return setField(
      select,
      resolution.element.value,
      expectedLabel,
      signal,
      budget,
    );
  }

  async function applyPlan(plan, signal, budget) {
    if (formSignature(plan.form) !== plan.signature) {
      throw new toolkit.ToolkitError(
        "STALE_PREVIEW",
        "The ManyVids form changed after preview. Preview again.",
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

    const coPerformer = toolkit.queryUnique(SELECTORS.coPerformer, plan.form, {
      description: "co-performer select",
    });
    if (
      !(await step("Co-performer", () =>
        selectExactOption(
          coPerformer,
          plan.profile.coPerformer,
          "NO",
          signal,
          budget,
        ),
      ))
    ) {
      return failedResult(outcomes);
    }

    if (
      !(await step("Price mode", () =>
        selectRadioIfSafe(plan.priceMode, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }
    if (
      !(await step("Price", async () =>
        setField(
          plan.form.querySelector(SELECTORS.price),
          plan.profile.price,
          "Price",
          signal,
          budget,
        ),
      ))
    ) {
      return failedResult(outcomes);
    }

    if (
      !(await step("Launch mode", () =>
        selectRadioIfSafe(plan.launchMode, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }
    const time = toolkit.queryUnique(SELECTORS.launchTime, plan.form, {
      description: "launch-time select",
    });
    if (
      !(await step("Launch time", () =>
        selectExactOption(
          time,
          plan.profile.launchTimeLabel,
          plan.profile.launchTimeValue,
          signal,
          budget,
        ),
      ))
    ) {
      return failedResult(outcomes);
    }

    if (
      !(await step("Membership mode", () =>
        selectRadioIfSafe(plan.membership, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }
    if (
      !(await step("Premium mode", () =>
        selectRadioIfSafe(plan.premium, signal, budget),
      ))
    ) {
      return failedResult(outcomes);
    }
    for (const tag of plan.tagsToAdd) {
      if (
        !(await step(`Tag ${tag}`, () =>
          addExactTag(plan.form, tag, signal, budget),
        ))
      ) {
        return failedResult(outcomes);
      }
    }

    return {
      status: outcomes.some((item) => item.status === "skipped")
        ? "partial"
        : "success",
      summary:
        "ManyVids plan completed with exact verified fields. Unconfigured mode controls were left unchanged; review and save manually.",
      items: outcomes,
    };
  }

  function failedResult(outcomes) {
    return {
      status: outcomes.some((item) => item.status === "changed")
        ? "partial"
        : "failed",
      summary:
        "ManyVids stopped at the first missing, ambiguous, or unverified value.",
      items: outcomes,
    };
  }

  async function mount({ signal, profile }) {
    const panel = toolkit.createToolPanel({
      id: "manyvidsAutofill",
      title: "ManyVids edit assistant",
      description:
        "Manual before/after plan. Exact values only; nonempty fields change only after confirmation.",
    });
    const runner = toolkit.createActionRunner({
      toolId: "manyvidsAutofill",
      panel,
      lifecycleSignal: signal,
      maxActions: 40,
      maxDurationMs: 90000,
    });

    async function preview() {
      const form = activeForm();
      const plan = inspectForm(form, profile);
      panel.showPlan({
        summary: "Review every ManyVids edit before applying.",
        items: plan.items,
        confirmLabel: "Apply reviewed changes",
        onConfirm: () =>
          runner.run("Applying ManyVids plan", ({ signal, budget }) =>
            applyPlan(plan, signal, budget),
          ),
      });
      const unsafeModes = [
        plan.priceMode,
        plan.launchMode,
        plan.membership,
        plan.premium,
      ].filter((mode) => !mode.safe).length;
      panel.setStatus(
        unsafeModes
          ? `${unsafeModes} unverified mode control(s) will remain unchanged. Configure their exact labels in the workflow profile if needed.`
          : "Preview ready. Nothing has changed.",
        unsafeModes ? "warning" : "neutral",
      );
    }

    panel.addAction({
      id: "preview",
      label: "Preview edit plan",
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
      runner.stop("ManyVids tool disposed.");
      panel.destroy();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.manyvidsAutofill = Object.freeze({
    activeForm,
    selectedTags,
    suggestionSignature,
    inspectModeControl,
    inspectForm,
    addExactTag,
    applyPlan,
    failedResult,
  });

  if (!globalThis.CreatorToolkitMasterRun) {
    toolkit.mountTool({
      id: "manyvidsAutofill",
      match: (location) =>
        location.origin === "https://www.manyvids.com" &&
        location.pathname.startsWith("/Edit-vid/"),
      mount,
    });
  }
})();
