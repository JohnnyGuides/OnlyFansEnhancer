(() => {
  "use strict";

  const toolkit = globalThis.CreatorToolkit;
  if (!toolkit) throw new Error("CreatorToolkit runtime is unavailable.");

  const STATIC_STYLE_ID = "creator-toolkit-reddit-censor-static";
  const DYNAMIC_STYLE_ID = "creator-toolkit-reddit-censor-dynamic";
  const TARGET_ATTRIBUTE = "data-creator-toolkit-banner-target";
  const COVER_ATTRIBUTE = "data-creator-toolkit-banner-cover";
  const TARGET_SELECTORS = Object.freeze([
    "#subreddit-banner-img",
    '[data-testid="subreddit-banner"] img',
    '[data-testid="subreddit-banner"] [style*="background-image"]',
    "shreddit-subreddit-header img[alt*='banner' i]",
    "shreddit-subreddit-header [slot='banner'] img",
    "#sr-header-area + div img[alt*='banner' i]",
  ]);

  function ensureStaticStyle() {
    let style = document.getElementById(STATIC_STYLE_ID);
    if (style) return style;
    style = document.createElement("style");
    style.id = STATIC_STYLE_ID;
    style.textContent = `
      ${TARGET_SELECTORS.join(",\n")} {
        visibility: hidden !important;
        opacity: 0 !important;
        background-image: none !important;
      }
    `;
    (document.documentElement || document.head).appendChild(style);
    return style;
  }

  function openRoots(root = document) {
    /** @type {(Document | ShadowRoot)[]} */
    const roots = [root];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function findBannerTargets() {
    const targets = [];
    for (const root of openRoots()) {
      for (const selector of TARGET_SELECTORS) {
        targets.push(...root.querySelectorAll(selector));
      }
    }
    return Array.from(new Set(targets)).filter(
      (target) => target instanceof HTMLElement && target.isConnected,
    );
  }

  function chooseCoverContainer(target) {
    const explicit = target.closest(
      '[data-testid="subreddit-banner"], shreddit-subreddit-header, #header, [class*="banner"]',
    );
    return explicit || target.parentElement;
  }

  function coverTarget(target, label) {
    if (target.hasAttribute(TARGET_ATTRIBUTE)) return;
    const container = chooseCoverContainer(target);
    if (!(container instanceof HTMLElement)) return;

    target.setAttribute(TARGET_ATTRIBUTE, "true");
    const originalPosition = container.style.position;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
      container.dataset.creatorToolkitOriginalPosition = originalPosition;
    }

    const cover = document.createElement("div");
    cover.setAttribute(COVER_ATTRIBUTE, "true");
    cover.setAttribute("role", "img");
    cover.setAttribute("aria-label", label);
    cover.textContent = label;
    container.appendChild(cover);
  }

  function removeCovers() {
    for (const root of openRoots()) {
      for (const cover of root.querySelectorAll(`[${COVER_ATTRIBUTE}]`)) {
        const container = cover.parentElement;
        cover.remove();
        if (
          container instanceof HTMLElement &&
          Object.hasOwn(container.dataset, "creatorToolkitOriginalPosition")
        ) {
          container.style.position =
            container.dataset.creatorToolkitOriginalPosition || "";
          delete container.dataset.creatorToolkitOriginalPosition;
        }
      }
      for (const target of root.querySelectorAll(`[${TARGET_ATTRIBUTE}]`)) {
        target.removeAttribute(TARGET_ATTRIBUTE);
      }
    }
  }

  const initialStyle = ensureStaticStyle();
  toolkit
    .loadSettings()
    .then((settings) => {
      if (settings.tools.redditBannerCensor?.enabled !== true) {
        initialStyle.remove();
      }
    })
    .catch(() => {
      // Fail closed: keep the static censor if settings cannot be read.
    });

  async function mount({ signal, profile }) {
    ensureStaticStyle();
    let dynamicStyle = document.getElementById(DYNAMIC_STYLE_ID);
    if (!dynamicStyle) {
      dynamicStyle = document.createElement("style");
      dynamicStyle.id = DYNAMIC_STYLE_ID;
      dynamicStyle.textContent = `
        [${TARGET_ATTRIBUTE}] {
          visibility: hidden !important;
          opacity: 0 !important;
          background-image: none !important;
        }
        [${COVER_ATTRIBUTE}] {
          position: absolute !important;
          inset: 0 !important;
          z-index: 2147483000 !important;
          display: grid !important;
          place-items: center !important;
          min-height: 72px !important;
          overflow: hidden !important;
          background:
            repeating-linear-gradient(
              -45deg,
              #17141c 0,
              #17141c 14px,
              #24202b 14px,
              #24202b 28px
            ) !important;
          color: #f3eef9 !important;
          font: 700 14px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif !important;
          letter-spacing: .04em !important;
          text-transform: uppercase !important;
          pointer-events: none !important;
        }
      `;
      (document.documentElement || document.head).appendChild(dynamicStyle);
    }

    let scheduled = false;
    function scan() {
      if (signal.aborted) return;
      scheduled = false;
      for (const target of findBannerTargets()) {
        coverTarget(target, profile.label || "Banner censored");
      }
    }
    function scheduleScan() {
      if (scheduled || signal.aborted) return;
      scheduled = true;
      requestAnimationFrame(scan);
    }

    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      dynamicStyle?.remove();
      document.getElementById(STATIC_STYLE_ID)?.remove();
      removeCovers();
    };
  }

  globalThis.CreatorToolkitAdapters ||= {};
  globalThis.CreatorToolkitAdapters.redditBannerCensor = Object.freeze({
    TARGET_SELECTORS,
    findBannerTargets,
    chooseCoverContainer,
    coverTarget,
    removeCovers,
  });

  toolkit.mountTool({
    id: "redditBannerCensor",
    match: (location) =>
      ["www.reddit.com", "sh.reddit.com", "old.reddit.com"].includes(
        location.hostname,
      ) && location.pathname.startsWith("/r/"),
    mount,
  });
})();
