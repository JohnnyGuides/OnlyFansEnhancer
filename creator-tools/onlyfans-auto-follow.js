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
      let button;
      try {
        button = lists.followButton(row);
      } catch (error) {
        invalid.push({
          key: lists.stableUserKey(row) || "unidentified row",
          reason: error.message,
        });
        continue;
      }
      if (!button) continue;
      const key = lists.stableUserKey(row);
      if (!key) {
        invalid.push({
          key: "unidentified row",
          reason: "no stable profile/user identity",
        });
      } else {
        candidates.push({ key, row, button });
      }
    }
    return { candidates, invalid };
  }

  function assertNoBlockers() {
    const rateLimit = lists.visibleRateLimitMessage();
    if (rateLimit) {
      throw new toolkit.ToolkitError(
        "RATE_LIMIT",
        `OnlyFans reported a blocking condition: ${toolkit
          .displayText(rateLimit.textContent)
          .slice(0, 240)}`,
      );
    }
    const dialogs = lists.visibleBlockingDialogs();
    if (dialogs.length) {
      throw new toolkit.ToolkitError(
        "BLOCKING_MODAL",
        "A visible dialog is blocking the follow action. Close or resolve it manually, then preview again.",
      );
    }
  }

  async function followCandidate(candidate, signal, budget) {
    toolkit.throwIfAborted(signal);
    assertNoBlockers();

    const row = lists.findRowByKey(candidate.key);
    if (!row || !toolkit.isVisible(row)) {
      throw new toolkit.ToolkitError(
        "STALE_ROW",
        `${candidate.key} is no longer visible.`,
      );
    }
    if (lists.followingState(row) === "following") {
      return {
        label: candidate.key,
        status: "unchanged",
        detail: "already following",
      };
    }
    const button = lists.followButton(row);
    if (!button) {
      throw new toolkit.ToolkitError(
        "MISSING_FOLLOW",
        `No exact Follow control exists for ${candidate.key}.`,
      );
    }

    row.scrollIntoView({ block: "center", behavior: "instant" });
    await toolkit.sleep(80, signal);
    assertNoBlockers();
    budget.step();
    toolkit.clickElement(button, signal);

    const result = await toolkit.waitFor(
      () => {
        toolkit.throwIfAborted(signal);
        const rateLimit = lists.visibleRateLimitMessage();
        if (rateLimit) {
          throw new toolkit.ToolkitError(
            "RATE_LIMIT",
            toolkit.displayText(rateLimit.textContent).slice(0, 240),
          );
        }
        if (lists.visibleBlockingDialogs().length) {
          throw new toolkit.ToolkitError(
            "BLOCKING_MODAL",
            "A dialog appeared after Follow. The result is unknown, so the batch stopped.",
          );
        }
        const currentRow = lists.findRowByKey(candidate.key);
        if (!currentRow) {
          throw new toolkit.ToolkitError(
            "UNKNOWN_RESULT",
            "The row was virtualized or removed before success could be verified.",
          );
        }
        return lists.followingState(currentRow) === "following"
          ? currentRow
          : null;
      },
      {
        signal,
        timeoutMs: 5000,
        intervalMs: 100,
        description: `explicit Following state for ${candidate.key}`,
      },
    );

    if (!result) {
      throw new toolkit.ToolkitError(
        "POSTCONDITION_FAILED",
        `Could not verify Following state for ${candidate.key}.`,
      );
    }
    return {
      label: candidate.key,
      status: "changed",
      detail: "Following state verified",
    };
  }

  async function runFollow({ mode, signal, budget, profile, panel }) {
    lists.requireExpiredListContext();
    assertNoBlockers();
    const outcomes = [];
    const processed = new Set();
    let followed = 0;
    let stablePasses = 0;
    let scrollContainer = null;
    let fatalFailure = false;

    while (followed < profile.batchLimit && !fatalFailure) {
      toolkit.throwIfAborted(signal);
      budget.check();
      assertNoBlockers();
      const inspection = inspectVisibleRows();
      for (const invalid of inspection.invalid) {
        outcomes.push({
          label: invalid.key,
          status: "skipped",
          detail: invalid.reason,
        });
      }
      const pending = inspection.candidates.filter(
        (candidate) => !processed.has(candidate.key),
      );
      let changedThisPass = 0;

      for (const candidate of pending) {
        if (followed >= profile.batchLimit) break;
        processed.add(candidate.key);
        try {
          const outcome = await followCandidate(candidate, signal, budget);
          outcomes.push(outcome);
          if (outcome.status === "changed") {
            followed += 1;
            changedThisPass += 1;
          }
        } catch (error) {
          if (error?.name === "AbortError" || signal.aborted) throw error;
          outcomes.push({
            label: candidate.key,
            status: "failed",
            detail: error?.message || String(error),
          });
          fatalFailure = true;
          break;
        }
        panel.setStatus(
          `Following… ${followed}/${profile.batchLimit} explicitly verified.`,
          "neutral",
        );
        await toolkit.sleep(profile.delayMs, signal);
      }

      if (mode === "visible" || fatalFailure) break;
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

    const failures = outcomes.filter((item) => item.status === "failed").length;
    return {
      status: failures ? (followed ? "partial" : "failed") : "success",
      summary: failures
        ? `Stopped after ${followed} verified follow(s) because a result became unsafe or unverifiable.`
        : followed >= profile.batchLimit
          ? `Stopped at the configured ${profile.batchLimit}-follow cap.`
          : `Completed with ${followed} explicitly verified follow(s).`,
      items: outcomes,
    };
  }

  async function mount({ signal, profile }) {
    const panel = toolkit.createToolPanel({
      id: "onlyfansAutoFollow",
      title: "OnlyFans expired-list follow",
      description:
        "Bounded, confirmed, exact Follow actions. Unknown dialogs and unverifiable results stop the batch.",
    });
    const runner = toolkit.createActionRunner({
      toolId: "onlyfansAutoFollow",
      panel,
      lifecycleSignal: signal,
      maxActions: profile.batchLimit,
      maxDurationMs: profile.maxDurationMs,
    });

    async function preview(mode) {
      lists.requireExpiredListContext();
      assertNoBlockers();
      const inspection = inspectVisibleRows();
      panel.showPlan({
        summary:
          mode === "visible"
            ? "Review visible Follow actions."
            : "Review the bounded lazy-list Follow batch.",
        items: [
          `${inspection.candidates.length} visible exact Follow control(s) have stable user identities.`,
          `${inspection.invalid.length} ambiguous/unidentified row(s) will be skipped.`,
          `Hard cap: ${profile.batchLimit} follow(s).`,
          `Minimum delay: ${profile.delayMs} ms between verified actions.`,
          "Any modal, rate-limit signal, missing row, or unverified state stops the batch.",
        ],
        confirmLabel:
          mode === "visible"
            ? `Follow up to ${Math.min(
                inspection.candidates.length,
                profile.batchLimit,
              )} visible`
            : `Follow up to ${profile.batchLimit}`,
        onConfirm: () =>
          runner.run("Following OnlyFans users", ({ signal, budget }) =>
            runFollow({ mode, signal, budget, profile, panel }),
          ),
      });
      panel.setStatus(
        "Preview ready. No Follow action has occurred.",
        "neutral",
      );
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
      runner.stop("OnlyFans follow tool disposed.");
      panel.destroy();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.onlyfansAutoFollow = Object.freeze({
    inspectVisibleRows,
    assertNoBlockers,
    followCandidate,
  });

  toolkit.mountTool({
    id: "onlyfansAutoFollow",
    match: (location) =>
      location.origin === "https://onlyfans.com" &&
      location.pathname.startsWith("/my/collections/user-lists/"),
    mount,
  });
})();
