(() => {
  "use strict";

  if (globalThis.CreatorUploadCapabilityProbe) return;

  const SEMANTIC_TOKENS = new Set([
    "attachment",
    "calendar",
    "caption",
    "compose",
    "composer",
    "content",
    "date",
    "description",
    "file",
    "media",
    "message",
    "post",
    "publish",
    "schedule",
    "share",
    "submit",
    "text",
    "time",
    "upload",
    "video",
  ]);
  const TOKEN_ATTRIBUTES = [
    "id",
    "name",
    "role",
    "accept",
    "aria-label",
    "placeholder",
    "data-testid",
    "data-test",
  ];

  function platformFor(origin) {
    const host = String(origin || "").toLowerCase();
    if (host.includes("onlyfans.com")) return "onlyfans";
    if (host.includes("fansly.com")) return "fansly";
    if (host.includes("manyvids.com")) return "manyvids";
    if (host.includes("pornhub.mainhub.com")) return "pornhub";
    return "unknown";
  }

  function semanticTokens(element) {
    const parts = TOKEN_ATTRIBUTES.map(
      (name) => element.getAttribute(name) || "",
    );
    if (element.matches("button, [role='button'], input[type='submit']")) {
      parts.push(element.textContent || "");
    }
    return Array.from(
      new Set(
        parts
          .join(" ")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((token) => SEMANTIC_TOKENS.has(token)),
      ),
    ).slice(0, 8);
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        current.hidden ||
        current.matches("[inert]") ||
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
    }
    return true;
  }

  function enabled(element) {
    for (let current = element; current; current = current.parentElement) {
      if (
        current.matches(":disabled, [inert]") ||
        current.getAttribute("aria-disabled") === "true"
      ) {
        return false;
      }
    }
    return true;
  }

  function nearestComposerBoundary(element, documentRef) {
    for (
      let current = element.parentElement;
      current &&
      current !== documentRef.body &&
      current !== documentRef.documentElement;
      current = current.parentElement
    ) {
      const tokens = semanticTokens(current);
      if (
        current.matches("form, [role='form'], dialog, [role='dialog']") ||
        tokens.some((token) =>
          ["compose", "composer", "post", "upload"].includes(token),
        )
      ) {
        return current;
      }
    }
    return null;
  }

  function shareComposerContainer(elements, documentRef) {
    const boundaries = elements.map((element) =>
      nearestComposerBoundary(element, documentRef),
    );
    return boundaries.every(
      (boundary) => boundary && boundary === boundaries[0],
    );
  }

  function signature(element) {
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || "",
      role: element.getAttribute("role") || "",
      tokens: semanticTokens(element),
    };
  }

  function tokenScore(element, weights) {
    const tokens = semanticTokens(element);
    return tokens.reduce((score, token) => score + (weights[token] || 0), 0);
  }

  function scored(documentRef, selector, score, { allowHidden = false } = {}) {
    return Array.from(documentRef.querySelectorAll(selector))
      .filter(
        (element) => enabled(element) && (allowHidden || visible(element)),
      )
      .map((element) => ({ element, score: score(element) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
  }

  function choose(candidates) {
    if (!candidates.length)
      return { state: "missing", count: 0, signature: null };
    const tied =
      candidates.length > 1 && candidates[0].score === candidates[1].score;
    return {
      state: tied ? "ambiguous" : "detected",
      count: candidates.length,
      signature: tied ? null : signature(candidates[0].element),
    };
  }

  function inspect(documentRef, locationRef) {
    const origin = String(locationRef?.origin || "");
    const pathname = String(locationRef?.pathname || "/");
    const platform = platformFor(origin);
    const candidates = {
      file: scored(
        documentRef,
        "input[type='file']",
        (element) =>
          tokenScore(element, {
            video: 5,
            media: 4,
            upload: 4,
            file: 3,
            attachment: 2,
          }),
        { allowHidden: true },
      ),
      caption: scored(
        documentRef,
        "textarea, [contenteditable='true'], [role='textbox']",
        (element) =>
          tokenScore(element, {
            caption: 6,
            compose: 4,
            post: 3,
            message: 3,
            description: 2,
            text: 1,
            content: 1,
          }),
      ),
      schedule: scored(
        documentRef,
        "button, [role='button'], input[type='date'], input[type='datetime-local']",
        (element) =>
          (element.matches("input[type='date'], input[type='datetime-local']")
            ? 5
            : 0) +
          tokenScore(element, {
            schedule: 6,
            calendar: 5,
            date: 4,
            time: 2,
          }),
      ),
      commit: scored(
        documentRef,
        "button, [role='button'], input[type='submit']",
        (element) => {
          const tokens = semanticTokens(element);
          if (
            tokens.some((token) =>
              ["schedule", "calendar", "date", "time"].includes(token),
            )
          ) {
            return 0;
          }
          return tokenScore(element, {
            publish: 6,
            post: 4,
            share: 3,
            upload: 2,
          });
        },
      ),
    };
    const capabilities = Object.fromEntries(
      Object.entries(candidates).map(([key, value]) => [key, choose(value)]),
    );

    const loginRequired =
      /(?:^|\/)(?:login|signin|sign-in)(?:\/|$)/i.test(pathname) ||
      Array.from(documentRef.querySelectorAll("input[type='password']")).some(
        visible,
      );
    if (platform === "pornhub") {
      const metadataControls = {
        orientation: documentRef.querySelectorAll(
          'custom-dropdown[data-key="orientation"] .customSelectTrigger',
        ),
        tags: documentRef.querySelectorAll('input[name="tags"]'),
        categories: documentRef.querySelectorAll(
          'input[name="category"], input[name="categoryInput"]',
        ),
      };
      const metadataCapabilities = Object.fromEntries(
        Object.entries(metadataControls).map(([key, controls]) => [
          key,
          {
            state:
              controls.length === 1
                ? "detected"
                : controls.length
                  ? "ambiguous"
                  : "missing",
            count: controls.length,
            signature: controls.length === 1 ? signature(controls[0]) : null,
          },
        ]),
      );
      return {
        platform,
        route: `${origin}${pathname}`,
        status: loginRequired
          ? "login-required"
          : Object.values(metadataCapabilities).every(
                (capability) => capability.state === "detected",
              )
            ? "metadata-ready"
            : Object.values(metadataCapabilities).some(
                  (capability) => capability.state === "ambiguous",
                )
              ? "ambiguous"
              : "page-detected",
        capabilities: metadataCapabilities,
      };
    }
    const ambiguous = Object.values(capabilities).some(
      (capability) => capability.state === "ambiguous",
    );
    const requiredKeys = ["file", "caption", "commit"];
    const composerDetected =
      requiredKeys.every((key) => capabilities[key].state === "detected") &&
      shareComposerContainer(
        requiredKeys.map((key) => candidates[key][0].element),
        documentRef,
      );

    return {
      platform,
      route: `${origin}${pathname}`,
      status: loginRequired
        ? "login-required"
        : ambiguous
          ? "ambiguous"
          : composerDetected
            ? "composer-detected"
            : "page-detected",
      capabilities,
    };
  }

  function probe() {
    return inspect(document, location);
  }

  globalThis.CreatorUploadCapabilityProbe = Object.freeze({ inspect, probe });
})();

globalThis.CreatorUploadCapabilityProbe.probe();
