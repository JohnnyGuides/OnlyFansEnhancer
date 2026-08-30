(() => {
  "use strict";

  if (globalThis.CreatorToolkitOnlyFansLists) return;
  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const ROW_SELECTOR = ".b-selection-user, .b-users__item.m-fans";

  function profilePathFromRow(row) {
    const preserved = row.querySelector("[data-fim-original-href]")?.dataset
      .fimOriginalHref;
    const href =
      preserved ||
      row
        .querySelector('a[href*="onlyfans.com/"], a[href^="/"]')
        ?.getAttribute("href");
    if (!href) return "";
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return "";
      return `${url.pathname.replace(/\/+$/, "")}${url.search}` || "/";
    } catch {
      return "";
    }
  }

  function stableUserKey(row) {
    const explicit =
      row.getAttribute("data-user-id") ||
      row.getAttribute("data-id") ||
      row.querySelector("[data-user-id]")?.getAttribute("data-user-id") ||
      row.querySelector("[data-id]")?.getAttribute("data-id");
    if (explicit) return `id:${explicit}`;

    const maskedKey =
      row.querySelector("[data-fim-masked-handle]")?.dataset.fimMaskedHandle ||
      row.querySelector("[data-fim-masked-name]")?.dataset.fimMaskedName ||
      row.dataset.fimIdentity;
    if (maskedKey) return `fim:${maskedKey}`;

    const profilePath = profilePathFromRow(row);
    return profilePath ? `profile:${profilePath}` : "";
  }

  function rows({ visibleOnly = false } = {}) {
    const result = Array.from(document.querySelectorAll(ROW_SELECTOR));
    return visibleOnly ? result.filter(toolkit.isVisible) : result;
  }

  function contextEvidence() {
    const headings = Array.from(
      document.querySelectorAll(
        'h1, h2, h3, [role="heading"], [role="dialog"] header, [role="dialog"] [class*="title"]',
      ),
    )
      .filter(toolkit.isVisible)
      .map((element) => toolkit.displayText(element.textContent))
      .filter(Boolean);
    const normalized = toolkit.normalizeText(headings.join(" | "));
    return {
      headings,
      normalized,
      hasExpiredLabel: /\bexpired\b/.test(normalized),
      hasAddUsersLabel: /\badd users?(?: to list)?\b/.test(normalized),
    };
  }

  function requireExpiredListContext() {
    if (
      location.origin !== "https://onlyfans.com" ||
      !location.pathname.startsWith("/my/collections/user-lists/")
    ) {
      throw new toolkit.ToolkitError(
        "WRONG_ROUTE",
        "This helper only runs on an OnlyFans user-list route.",
      );
    }
    const evidence = contextEvidence();
    if (!evidence.hasExpiredLabel) {
      throw new toolkit.ToolkitError(
        "UNPROVEN_CONTEXT",
        "The visible page does not identify this as the expired-user workflow. No action was taken.",
        evidence.headings,
      );
    }
    return evidence;
  }

  function selectionState(row) {
    const input = row.querySelector('input[type="checkbox"]');
    if (input instanceof HTMLInputElement) return input.checked;
    const role = row.querySelector('[role="checkbox"]');
    if (role) {
      const aria = role.getAttribute("aria-checked");
      if (aria === "true") return true;
      if (aria === "false") return false;
    }
    return row.classList.contains("selected");
  }

  function selectionControl(row) {
    const selectors = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      ".checkbox-item__inside",
      ".checkbox-item",
    ];
    for (const selector of selectors) {
      const candidates = Array.from(row.querySelectorAll(selector)).filter(
        toolkit.isEnabledElement,
      );
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        throw new toolkit.ToolkitError(
          "AMBIGUOUS_CONTROL",
          `Expected one visible selection control; found ${candidates.length}.`,
        );
      }
    }
    throw new toolkit.ToolkitError(
      "MISSING_CONTROL",
      "No visible semantic selection control exists for this user.",
    );
  }

  function followButton(row) {
    const buttons = Array.from(
      row.querySelectorAll('button, [role="button"]'),
    ).filter(
      (element) =>
        toolkit.isEnabledElement(element) &&
        toolkit.normalizeText(toolkit.accessibleName(element)) === "follow",
    );
    if (buttons.length === 1) return buttons[0];
    if (!buttons.length) return null;
    throw new toolkit.ToolkitError(
      "AMBIGUOUS_FOLLOW",
      `Expected one exact Follow control; found ${buttons.length}.`,
    );
  }

  function findRowByKey(key) {
    return rows().find((row) => stableUserKey(row) === key) || null;
  }

  function followingState(row) {
    if (!row?.isConnected) return "unknown";
    const actions = Array.from(
      row.querySelectorAll('button, [role="button"]'),
    ).filter(toolkit.isVisible);
    const names = actions.map((element) =>
      toolkit.normalizeText(toolkit.accessibleName(element)),
    );
    if (names.includes("unfollow") || names.includes("following"))
      return "following";
    if (names.includes("follow")) return "not-following";
    return "unknown";
  }

  function nearestScrollContainer(element) {
    let current = element?.parentElement || null;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        current.scrollHeight > current.clientHeight
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function advanceScroll(container, signal) {
    toolkit.throwIfAborted(signal);
    const before =
      container === document.scrollingElement ||
      container === document.documentElement
        ? window.scrollY
        : container.scrollTop;
    const amount = Math.max(
      200,
      Math.floor(
        (container === document.scrollingElement ||
        container === document.documentElement
          ? window.innerHeight
          : container.clientHeight) * 0.8,
      ),
    );
    if (
      container === document.scrollingElement ||
      container === document.documentElement
    ) {
      window.scrollBy({ top: amount, behavior: "instant" });
    } else {
      container.scrollBy({ top: amount, behavior: "instant" });
    }
    await toolkit.sleep(450, signal);
    const after =
      container === document.scrollingElement ||
      container === document.documentElement
        ? window.scrollY
        : container.scrollTop;
    return { before, after, moved: after !== before };
  }

  function visibleBlockingDialogs() {
    return Array.from(
      document.querySelectorAll(
        '[role="dialog"], .b-modal, .modal, .MuiDialog-root',
      ),
    ).filter(toolkit.isVisible);
  }

  function visibleRateLimitMessage() {
    const candidates = Array.from(
      document.querySelectorAll(
        '[role="alert"], [role="status"], .toast, .notification, .b-notification, [role="dialog"]',
      ),
    ).filter(toolkit.isVisible);
    return (
      candidates.find((element) =>
        /\b(?:rate limit|too many|try again later|temporarily blocked|error occurred)\b/i.test(
          toolkit.displayText(element.textContent),
        ),
      ) || null
    );
  }

  globalThis.CreatorToolkitOnlyFansLists = Object.freeze({
    ROW_SELECTOR,
    stableUserKey,
    rows,
    contextEvidence,
    requireExpiredListContext,
    selectionState,
    selectionControl,
    followButton,
    findRowByKey,
    followingState,
    nearestScrollContainer,
    advanceScroll,
    visibleBlockingDialogs,
    visibleRateLimitMessage,
  });
})();
