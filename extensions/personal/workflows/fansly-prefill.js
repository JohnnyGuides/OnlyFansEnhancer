(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  function activeComposer() {
    const composers = Array.from(
      document.querySelectorAll("app-post-creation"),
    ).filter(toolkit.isVisible);
    if (composers.length !== 1) {
      throw new toolkit.ToolkitError(
        composers.length ? "AMBIGUOUS_COMPOSER" : "COMPOSER_NOT_FOUND",
        composers.length
          ? `Expected one visible Fansly composer; found ${composers.length}.`
          : "Open one Fansly post composer before previewing.",
      );
    }
    return composers[0];
  }

  function toggleRow(composer, expectedLabel) {
    const rows = Array.from(
      composer.querySelectorAll(".post-option, .post-option-chip"),
    ).filter(toolkit.isVisible);
    const resolution = toolkit.resolveExact(rows, expectedLabel, (row) =>
      toolkit.displayText(
        row.querySelector("label, .label, .title, xd-localization-string")
          ?.textContent || row.textContent,
      ),
    );
    if (resolution.status !== "found") {
      throw new toolkit.ToolkitError(
        resolution.status === "ambiguous"
          ? "AMBIGUOUS_TOGGLE"
          : "MISSING_TOGGLE",
        `${
          resolution.status === "ambiguous" ? "Multiple" : "No"
        } exact Fansly toggle rows match “${expectedLabel}”.`,
      );
    }
    return resolution.element;
  }

  function toggleControl(row) {
    if (row.matches(".post-option-chip") && toolkit.isEnabledElement(row)) {
      return row;
    }
    const selectors = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      ".checkbox",
    ];
    for (const selector of selectors) {
      const controls = Array.from(row.querySelectorAll(selector)).filter(
        toolkit.isEnabledElement,
      );
      if (controls.length === 1) return controls[0];
      if (controls.length > 1) {
        throw new toolkit.ToolkitError(
          "AMBIGUOUS_TOGGLE_CONTROL",
          `Found ${controls.length} visible controls in one Fansly toggle row.`,
        );
      }
    }
    throw new toolkit.ToolkitError(
      "MISSING_TOGGLE_CONTROL",
      "The Fansly toggle row has no visible actionable control.",
    );
  }

  function toggleState(row) {
    if (row.matches(".post-option-chip"))
      return row.classList.contains("active");
    const input = row.querySelector('input[type="checkbox"]');
    if (input instanceof HTMLInputElement) return input.checked;
    const role = row.querySelector('[role="checkbox"]');
    if (role?.getAttribute("aria-checked") === "true") return true;
    if (role?.getAttribute("aria-checked") === "false") return false;
    return (
      row.querySelector(".checkbox")?.classList.contains("selected") || false
    );
  }

  function composerSignature(composer, profile) {
    const textarea = composer.querySelector("textarea");
    const toggles = {};
    for (const label of Object.keys(profile.toggles)) {
      try {
        toggles[label] = toggleState(toggleRow(composer, label));
      } catch {
        toggles[label] = null;
      }
    }
    return JSON.stringify({ text: textarea?.value || "", toggles });
  }

  function composeMasterCaption(description, message) {
    const base = String(description || "").trim();
    const block = String(message || "").trim();
    if (!base) return block;
    if (!block || base === block || base.endsWith(`\n\n${block}`)) return base;
    return `${base}\n\n${block}`;
  }

  function inspectComposer(composer, profile, options = {}) {
    const textarea = toolkit.queryUnique("textarea", composer, {
      description: "visible Fansly composer textarea",
    });
    const currentText = textarea.value || "";
    const desiredText = Object.hasOwn(options, "desiredText")
      ? String(options.desiredText || "")
      : profile.message;
    const shouldWrite =
      options.forceWrite === true ||
      profile.fillMode === "replace" ||
      currentText.trim().length === 0;
    const toggles = Object.entries(profile.toggles).map(([label, desired]) => {
      const row = toggleRow(composer, label);
      return {
        label,
        desired,
        current: toggleState(row),
        row,
      };
    });
    return {
      composer,
      textarea,
      currentText,
      desiredText,
      shouldWrite,
      toggles,
      signature: composerSignature(composer, profile),
      items: [
        shouldWrite
          ? `Caption: ${currentText.trim() ? "replace existing text" : "fill empty composer"} with the configured message`
          : "Caption: preserve existing user text (empty-only mode)",
        ...toggles.map(
          (toggle) =>
            `${toggle.label}: ${toggle.current ? "on" : "off"} → ${
              toggle.desired ? "on" : "off"
            }`,
        ),
        options.finalAction || "Post will never be focused or activated.",
      ],
    };
  }

  async function applyPlan(plan, profile, signal, budget) {
    if (composerSignature(plan.composer, profile) !== plan.signature) {
      throw new toolkit.ToolkitError(
        "STALE_PREVIEW",
        "The Fansly composer changed after preview. Preview again to respect the latest user edits.",
      );
    }
    const outcomes = [];

    if (plan.shouldWrite) {
      budget.step();
      toolkit.throwIfAborted(signal);
      toolkit.setControlValue(plan.textarea, plan.desiredText);
      if (plan.textarea.value !== plan.desiredText) {
        throw new toolkit.ToolkitError(
          "POSTCONDITION_FAILED",
          "The Fansly caption did not retain the configured message.",
        );
      }
      outcomes.push({
        label: "Caption",
        status: "changed",
        detail: "exact configured text applied",
      });
    } else {
      outcomes.push({
        label: "Caption",
        status: "unchanged",
        detail: "existing user text preserved",
      });
    }

    for (const toggle of plan.toggles) {
      toolkit.throwIfAborted(signal);
      const row = toggleRow(plan.composer, toggle.label);
      if (toggleState(row) === toggle.desired) {
        outcomes.push({
          label: toggle.label,
          status: "unchanged",
          detail: toggle.desired ? "on" : "off",
        });
        continue;
      }
      const control = toggleControl(row);
      budget.step();
      toolkit.clickElement(control, signal);
      await toolkit.waitFor(() => toggleState(row) === toggle.desired, {
        signal,
        timeoutMs: 1500,
        intervalMs: 60,
        description: `Fansly toggle “${toggle.label}”`,
      });
      outcomes.push({
        label: toggle.label,
        status: "changed",
        detail: toggle.desired ? "on" : "off",
      });
    }

    return {
      status: "success",
      summary:
        "Fansly composer changes were applied and verified. Review and click Post manually.",
      items: outcomes,
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.fanslyPrefill = Object.freeze({
    activeComposer,
    toggleRow,
    toggleState,
    composeMasterCaption,
    inspectComposer,
    applyPlan,
  });
})();
