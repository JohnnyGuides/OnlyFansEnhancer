(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const SELECTOR = "#contentproform-genres";

  function inspectSelect(select, profile) {
    const optionGroups = new Map();
    for (const option of Array.from(select.options)) {
      const label = toolkit.displayText(option.textContent);
      const key = toolkit.normalizeText(label);
      if (!key || option.value === "") continue;
      const group = optionGroups.get(key) || [];
      group.push({ option, label, value: String(option.value) });
      optionGroups.set(key, group);
    }

    const currentValues = new Set(toolkit.selectedOptionValues(select));
    const resolved = [];
    const missing = [];
    const ambiguous = [];

    for (const requestedLabel of profile.tags) {
      const matches =
        optionGroups.get(toolkit.normalizeText(requestedLabel)) || [];
      if (matches.length === 1) {
        resolved.push({
          requestedLabel,
          label: matches[0].label,
          value: matches[0].value,
        });
      } else if (matches.length > 1) {
        ambiguous.push(requestedLabel);
      } else {
        missing.push(requestedLabel);
      }
    }

    const resolvedValues = new Set(resolved.map((entry) => entry.value));
    const finalValues =
      profile.mode === "replace"
        ? resolvedValues
        : new Set([...currentValues, ...resolvedValues]);
    const additions = resolved.filter(
      (entry) => !currentValues.has(entry.value),
    );
    const removals =
      profile.mode === "replace"
        ? Array.from(select.selectedOptions)
            .filter((option) => !finalValues.has(String(option.value)))
            .map((option) => toolkit.displayText(option.textContent))
        : [];

    return {
      select,
      mode: profile.mode,
      currentValues,
      finalValues,
      resolved,
      additions,
      removals,
      missing,
      ambiguous,
      signature: Array.from(select.options)
        .map(
          (option) =>
            `${option.value}\u0000${toolkit.displayText(option.textContent)}\u0000${
              option.selected ? "1" : "0"
            }`,
        )
        .join("\u0001"),
    };
  }

  async function locateSelect(signal) {
    return toolkit.waitForStable(
      () => {
        const select = document.querySelector(SELECTOR);
        if (
          !(select instanceof HTMLSelectElement) ||
          !select.isConnected ||
          select.options.length < 2
        ) {
          return null;
        }
        return select;
      },
      {
        signal,
        timeoutMs: 15000,
        stableMs: 500,
        description: "the populated Sheer tag taxonomy",
        signature: (select) =>
          Array.from(select.options)
            .map(
              (option) =>
                `${option.value}\u0000${toolkit.displayText(option.textContent)}`,
            )
            .join("\u0001"),
      },
    );
  }

  function validatePlan(plan, profile) {
    if (!plan.resolved.length) {
      throw new toolkit.ToolkitError(
        "NO_RESOLVED_TAGS",
        "None of the configured Sheer tags exists in the current taxonomy.",
      );
    }
    if (plan.ambiguous.length) {
      throw new toolkit.ToolkitError(
        "AMBIGUOUS_TAGS",
        `Ambiguous Sheer tags: ${plan.ambiguous.join(", ")}.`,
      );
    }
    if (
      plan.mode === "replace" &&
      profile.requireAllForReplace &&
      plan.missing.length
    ) {
      throw new toolkit.ToolkitError(
        "INCOMPLETE_REPLACE",
        `Replace cancelled because these exact tags are missing: ${plan.missing.join(
          ", ",
        )}.`,
      );
    }
  }

  async function mount({ signal, profile }) {
    const panel = toolkit.createToolPanel({
      id: "sheerTags",
      title: "Sheer tag assistant",
      description:
        "Exact matches only. Append is safe by default; replacement requires a complete preview.",
    });
    const runner = toolkit.createActionRunner({
      toolId: "sheerTags",
      panel,
      lifecycleSignal: signal,
      maxActions: Math.max(10, profile.tags.length + 2),
      maxDurationMs: 30000,
    });

    async function preview() {
      const select = await locateSelect(signal);
      const plan = inspectSelect(select, profile);
      validatePlan(plan, profile);

      const items = [
        `Mode: ${plan.mode}`,
        `Add ${plan.additions.length}: ${
          plan.additions.map((entry) => entry.label).join(", ") || "none"
        }`,
      ];
      if (plan.removals.length) {
        items.push(
          `Remove ${plan.removals.length}: ${plan.removals.join(", ")}`,
        );
      }
      if (plan.missing.length) {
        items.push(
          `Skip ${plan.missing.length} unavailable exact matches: ${plan.missing.join(
            ", ",
          )}`,
        );
      }

      panel.showPlan({
        summary: `Review ${plan.mode} changes before applying.`,
        items,
        confirmLabel:
          plan.mode === "replace" ? "Confirm replacement" : "Append exact tags",
        onConfirm: () =>
          runner.run(
            "Applying Sheer tags",
            async ({ signal: runSignal, budget }) => {
              const currentSelect = await locateSelect(runSignal);
              const currentPlan = inspectSelect(currentSelect, profile);
              validatePlan(currentPlan, profile);
              if (currentPlan.signature !== plan.signature) {
                throw new toolkit.ToolkitError(
                  "STALE_PREVIEW",
                  "The tag form changed after the preview. Preview again before applying.",
                );
              }

              budget.step();
              toolkit.setSelectValues(
                currentSelect,
                Array.from(currentPlan.finalValues),
              );
              await toolkit.sleep(100, runSignal);

              const actual = new Set(
                toolkit.selectedOptionValues(currentSelect),
              );
              const expected = currentPlan.finalValues;
              const verified =
                actual.size === expected.size &&
                Array.from(expected).every((value) => actual.has(value));
              if (!verified) {
                throw new toolkit.ToolkitError(
                  "POSTCONDITION_FAILED",
                  "Sheer did not retain the exact selected values after the change event.",
                );
              }

              const resultItems = [
                ...currentPlan.additions.map((entry) => ({
                  label: entry.label,
                  status: "changed",
                  detail: "added",
                })),
                ...currentPlan.removals.map((label) => ({
                  label,
                  status: "changed",
                  detail: "removed after confirmed replacement",
                })),
                ...currentPlan.missing.map((label) => ({
                  label,
                  status: "skipped",
                  detail: "no exact taxonomy match",
                })),
              ];
              return {
                status: currentPlan.missing.length ? "partial" : "success",
                summary: `Sheer ${currentPlan.mode} completed and was verified.`,
                items: resultItems,
              };
            },
          ),
      });
      panel.setStatus(
        `${plan.additions.length} addition(s), ${plan.removals.length} removal(s), ${plan.missing.length} skipped.`,
        plan.missing.length ? "warning" : "neutral",
      );
    }

    panel.addAction({
      id: "preview",
      label: "Preview tags",
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
      runner.stop("Sheer tool disposed.");
      panel.destroy();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.sheerTags = Object.freeze({
    inspectSelect,
    validatePlan,
  });

  toolkit.mountTool({
    id: "sheerTags",
    match: (location) =>
      location.origin === "https://my.sheer.com" &&
      location.pathname.startsWith("/content/update/"),
    mount,
  });
})();
