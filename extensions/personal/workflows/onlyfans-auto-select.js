(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  const lists = globalThis.CreatorToolkitOnlyFansLists;
  if (!toolkit || !lists) {
    throw new Error("OnlyFans list runtime dependencies are unavailable.");
  }

  function inspectVisibleRows() {
    const candidates = [];
    const invalid = [];
    for (const row of lists.rows({ visibleOnly: true })) {
      if (lists.selectionState(row)) continue;
      const key = lists.stableUserKey(row);
      if (!key) invalid.push(row);
      else candidates.push({ key, row });
    }
    return { candidates, invalid };
  }

  async function selectCandidate(candidate, signal, budget) {
    toolkit.throwIfAborted(signal);
    const currentRow = lists.findRowByKey(candidate.key);
    if (!currentRow || !toolkit.isVisible(currentRow)) {
      return {
        label: candidate.key,
        status: "failed",
        detail: "row is no longer visible",
      };
    }
    if (lists.selectionState(currentRow)) {
      return {
        label: candidate.key,
        status: "unchanged",
        detail: "already selected",
      };
    }

    const control = lists.selectionControl(currentRow);
    budget.step();
    toolkit.clickElement(control, signal);
    await toolkit.waitFor(() => lists.selectionState(currentRow), {
      signal,
      timeoutMs: 1800,
      intervalMs: 60,
      description: `selected state for ${candidate.key}`,
    });
    return {
      label: candidate.key,
      status: "changed",
      detail: "selected and verified",
    };
  }

  async function runSelection({ mode, signal, budget, profile, panel }) {
    lists.requireExpiredListContext();
    const outcomes = [];
    const processed = new Set();
    let selected = 0;
    let stablePasses = 0;
    let scrollContainer = null;

    while (selected < profile.batchLimit) {
      toolkit.throwIfAborted(signal);
      budget.check();
      const inspection = inspectVisibleRows();
      for (let index = 0; index < inspection.invalid.length; index += 1) {
        outcomes.push({
          label: "unidentified row",
          status: "skipped",
          detail: "no stable profile/user identity",
        });
      }

      const pending = inspection.candidates.filter(
        (candidate) => !processed.has(candidate.key),
      );
      if (mode === "visible" && !outcomes.length && !pending.length) {
        return {
          status: "success",
          summary: "No visible unselected users required a change.",
          items: [],
        };
      }

      let changedThisPass = 0;
      for (const candidate of pending) {
        if (selected >= profile.batchLimit) break;
        toolkit.throwIfAborted(signal);
        processed.add(candidate.key);
        try {
          const outcome = await selectCandidate(candidate, signal, budget);
          outcomes.push(outcome);
          if (outcome.status === "changed") {
            selected += 1;
            changedThisPass += 1;
          }
        } catch (error) {
          if (error?.name === "AbortError" || signal.aborted) throw error;
          outcomes.push({
            label: candidate.key,
            status: "failed",
            detail: error?.message || String(error),
          });
        }
        panel.setStatus(
          `Selecting… ${selected}/${profile.batchLimit} verified.`,
          "neutral",
        );
        await toolkit.sleep(profile.delayMs, signal);
      }

      if (mode === "visible") break;
      if (!scrollContainer) {
        scrollContainer = lists.nearestScrollContainer(
          inspection.candidates[0]?.row || lists.rows()[0],
        );
      }
      const scroll = await lists.advanceScroll(scrollContainer, signal);
      if (!changedThisPass && !pending.length && !scroll.moved) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }
      if (stablePasses >= 3) break;
    }

    const failures = outcomes.filter((item) =>
      ["failed", "ambiguous"].includes(item.status),
    ).length;
    const status = failures ? (selected ? "partial" : "failed") : "success";
    return {
      status,
      summary:
        selected >= profile.batchLimit
          ? `Stopped at the configured ${profile.batchLimit}-selection cap. Review the selection and click OnlyFans Add manually.`
          : `Selected and verified ${selected} user(s). Review the selection and click OnlyFans Add manually.`,
      items: outcomes,
    };
  }

  async function mount({ signal, profile }) {
    const panel = toolkit.createToolPanel({
      id: "onlyfansAutoSelect",
      title: "OnlyFans expired-list selector",
      description:
        "Selections are bounded and verified. This extension never clicks Add.",
    });
    const runner = toolkit.createActionRunner({
      toolId: "onlyfansAutoSelect",
      panel,
      lifecycleSignal: signal,
      maxActions: profile.batchLimit,
      maxDurationMs: profile.maxDurationMs,
    });

    async function preview(mode) {
      lists.requireExpiredListContext();
      const inspection = inspectVisibleRows();
      const count = Math.min(inspection.candidates.length, profile.batchLimit);
      panel.showPlan({
        summary:
          mode === "visible"
            ? "Review visible-user selection."
            : "Review bounded lazy-list selection.",
        items: [
          `${inspection.candidates.length} visible unselected user(s) have stable identities.`,
          `${inspection.invalid.length} visible row(s) will be skipped because no stable identity exists.`,
          `Hard cap: ${profile.batchLimit} selection(s).`,
          "Final OnlyFans Add remains a manual action.",
        ],
        confirmLabel:
          mode === "visible"
            ? `Select ${count} visible`
            : `Select up to ${profile.batchLimit}`,
        onConfirm: () =>
          runner.run("Selecting OnlyFans users", ({ signal, budget }) =>
            runSelection({ mode, signal, budget, profile, panel }),
          ),
      });
      panel.setStatus("Preview ready. No selection has changed.", "neutral");
    }

    panel.addAction({
      id: "preview-visible",
      label: "Preview visible",
      onClick: () => preview("visible"),
    });
    panel.addAction({
      id: "preview-all",
      label: "Preview bounded all",
      variant: "primary",
      onClick: () => preview("all"),
    });
    panel.addAction({
      id: "stop",
      label: "Stop",
      variant: "danger",
      allowWhileRunning: true,
      onClick: () => runner.stop(),
    });

    return () => {
      runner.stop("OnlyFans selector disposed.");
      panel.destroy();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.onlyfansAutoSelect = Object.freeze({
    inspectVisibleRows,
    selectCandidate,
  });

  toolkit.mountTool({
    id: "onlyfansAutoSelect",
    match: (location) =>
      location.origin === "https://onlyfans.com" &&
      location.pathname.startsWith("/my/collections/user-lists/"),
    mount,
  });
})();
