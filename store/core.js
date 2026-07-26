(() => {
  "use strict";

  const PROFILE_RESERVED_SEGMENTS = new Set([
    "",
    "about",
    "account",
    "api",
    "collections",
    "contact",
    "help",
    "home",
    "login",
    "logout",
    "messages",
    "my",
    "notifications",
    "privacy",
    "search",
    "settings",
    "signup",
    "terms"
  ]);

  function keyFromHref(href, origin = "https://onlyfans.com") {
    if (!href) return null;

    let url;
    try {
      url = /^[a-z][a-z0-9+.-]*:/i.test(href)
        ? new URL(href)
        : new URL(href, origin);
    } catch {
      return null;
    }

    if (!/(^|\.)onlyfans\.com$/i.test(url.hostname)) return null;

    const chatMatch = url.pathname.match(/^\/my\/chats\/chat\/(\d+)(?:\/|$)/i);
    if (chatMatch) return `user:${chatMatch[1]}`;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;

    const segment = decodeURIComponent(parts[0]).trim();
    if (!segment || PROFILE_RESERVED_SEGMENTS.has(segment.toLowerCase())) return null;

    const numericMatch = segment.match(/^u(\d+)$/i);
    if (numericMatch) return `user:${numericMatch[1]}`;

    if (!/^[a-z0-9_.-]{2,64}$/i.test(segment)) return null;
    return `handle:${segment.toLowerCase()}`;
  }

  function normalizeOwnHandles(settings = {}) {
    const handles = Array.isArray(settings.ownHandles)
      ? settings.ownHandles
      : String(settings.ownHandle || "").split(",");

    return new Set(
      handles
        .map((value) => String(value).trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean)
        .map((value) => `handle:${value}`)
    );
  }

  function linkKeys(container) {
    const keys = new Set();
    if (!(container instanceof Element)) return keys;

    for (const link of container.querySelectorAll("a[href]")) {
      const key = keyFromHref(link.getAttribute("href"), location.origin);
      if (key) keys.add(key);
    }

    return keys;
  }

  function contextFor(kind, container, settings = {}) {
    if (!(container instanceof Element)) return null;

    const aliases = linkKeys(container);
    const ownHandles = normalizeOwnHandles(settings);

    let primaryKey = null;
    if (kind === "chat-list") {
      const chatLink = container.querySelector('a[href*="/my/chats/chat/"]');
      primaryKey = keyFromHref(chatLink?.getAttribute("href"), location.origin);
    }

    if (!primaryKey) {
      primaryKey =
        [...aliases].find((key) => key.startsWith("user:")) ||
        [...aliases].find((key) => key.startsWith("handle:")) ||
        null;
    }

    if (!primaryKey) return null;

    const nonOwnAliases = [...aliases].filter((key) => !ownHandles.has(key));
    if (ownHandles.has(primaryKey) && nonOwnAliases.length === 0) return null;

    if (ownHandles.has(primaryKey)) {
      primaryKey =
        nonOwnAliases.find((key) => key.startsWith("user:")) ||
        nonOwnAliases[0] ||
        null;
    }

    if (!primaryKey) return null;

    aliases.delete(primaryKey);
    for (const ownKey of ownHandles) aliases.delete(ownKey);

    return {
      kind,
      container,
      primaryKey,
      aliases: [...aliases]
    };
  }

  function queryContainers(root, selector) {
    const containers = [];
    if (root instanceof Element && root.matches(selector)) containers.push(root);
    if (root?.querySelectorAll) containers.push(...root.querySelectorAll(selector));
    return containers;
  }

  function collectContexts(root = document, settings = {}) {
    const definitions = [
      ["comment", ".b-comments__item"],
      ["chat-list", ".b-chats__item"],
      ["chat-header", ".b-chat__header"],
      ["incoming-message", '.b-chat__message:not(.m-from-me)'],
      ["fan-card", ".b-fans__item, .b-users__item"]
    ];

    const seen = new WeakSet();
    const contexts = [];

    for (const [kind, selector] of definitions) {
      for (const container of queryContainers(root, selector)) {
        if (seen.has(container)) continue;
        const context = contextFor(kind, container, settings);
        if (!context) continue;
        seen.add(container);
        contexts.push(context);
      }
    }

    return contexts;
  }

  function deepestElements(container, selector) {
    const elements = [...container.querySelectorAll(selector)];
    return elements.filter((element) => !element.querySelector(selector));
  }

  function replaceVisibleText(element, text) {
    if (!(element instanceof Element)) return;

    if (!element.querySelector("svg, button, [role='img']")) {
      if (element.textContent !== text) element.textContent = text;
      return;
    }

    const directTextNodes = [...element.childNodes].filter(
      (node) => node.nodeType === Node.TEXT_NODE
    );

    if (directTextNodes.length === 0) {
      element.prepend(document.createTextNode(text));
      return;
    }

    if (directTextNodes[0].nodeValue !== text) {
      directTextNodes[0].nodeValue = text;
    }
    for (const extraNode of directTextNodes.slice(1)) {
      if (extraNode.nodeValue !== "") extraNode.nodeValue = "";
    }
  }

  function maskNames(context, identity) {
    const displaySelectors = {
      "chat-list": '[at-attr="chat_list_user_name"], .b-chats__item__user .g-user-name',
      "chat-header": ".b-chat__header__title .g-user-name",
      comment: ".b-comments__item-text .g-user-name, .b-username .g-user-name",
      "fan-card": ".g-user-name",
      "incoming-message": ""
    };

    const selector = displaySelectors[context.kind];
    let displayCount = 0;
    if (selector) {
      for (const element of deepestElements(context.container, selector)) {
        replaceVisibleText(element, identity.displayName);
        element.dataset.fimMaskedName = context.primaryKey;
        displayCount += 1;
      }
    }

    let handleCount = 0;
    if (context.kind !== "incoming-message") {
      for (const element of deepestElements(context.container, ".g-user-username")) {
        replaceVisibleText(element, `@${identity.handle}`);
        element.dataset.fimMaskedHandle = context.primaryKey;
        handleCount += 1;
      }
    }

    return { displayCount, handleCount };
  }

  function emergencyAvatar(identity, key) {
    let hash = 2166136261;
    for (const character of String(key || identity.handle || "avatar")) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const firstHue = (hash >>> 0) % 360;
    const secondHue = (firstHue + 68) % 360;
    const initials =
      String(identity.displayName || identity.handle || "?")
        .match(/[a-z0-9]/gi)
        ?.slice(0, 2)
        .join("")
        .toUpperCase() || "?";
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">',
      "<defs>",
      `<linearGradient id="g"><stop stop-color="hsl(${firstHue} 78% 67%)"/><stop offset="1" stop-color="hsl(${secondHue} 76% 48%)"/></linearGradient>`,
      "</defs>",
      '<rect width="160" height="160" rx="80" fill="url(#g)"/>',
      `<text x="80" y="96" text-anchor="middle" fill="white" font-family="system-ui,sans-serif" font-size="48" font-weight="700">${initials}</text>`,
      "</svg>"
    ].join("");
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function requestAvatarRotation(image) {
    if (!image) return;
    const currentWrapper = image.closest(".g-avatar__img-wrapper");
    if (currentWrapper?.classList.contains("fim-avatar-loading")) return;
    currentWrapper?.classList.add("fim-avatar-loading");
    image.classList.remove("fim-avatar-pop");

    let aliases = [];
    try {
      aliases = JSON.parse(image.dataset.fimAvatarAliases || "[]");
    } catch {
      aliases = [];
    }
    window.dispatchEvent(
      new CustomEvent("fim:rotate-avatar", {
        detail: {
          primaryKey: image.dataset.fimAvatarPrimary,
          aliases
        }
      })
    );
  }

  function maskedAvatarFromEvent(event) {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.matches("img[data-fim-avatar-hit-target]")) return node;
      if (!node.matches("[data-fim-avatar-hit-target]")) continue;
      const image = node.matches("img")
        ? node
        : node.querySelector("img[data-fim-avatar-primary]");
      if (image) return image;
    }
    return null;
  }

  function suppressAvatarNavigation(event) {
    const image = maskedAvatarFromEvent(event);
    if (!image) return;

    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const plainPrimary =
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;
    if (plainPrimary && ["pointerup", "click"].includes(event.type)) {
      requestAvatarRotation(image);
    }
  }

  for (const eventType of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "auxclick",
    "dblclick"
  ]) {
    window.addEventListener(eventType, suppressAvatarNavigation, true);
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      const image = maskedAvatarFromEvent(event);
      if (!image) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      requestAvatarRotation(image);
    },
    true
  );

  function ensureAvatarImage(avatar, identity, context) {
    let wrapper = avatar.querySelector(".g-avatar__img-wrapper");
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "g-avatar__img-wrapper fim-avatar-wrapper";
      avatar.appendChild(wrapper);
    }

    let image = wrapper.querySelector("img");
    if (!image) {
      image = document.createElement("img");
      wrapper.appendChild(image);
    }

    image.classList.add("fim-avatar-image");
    image.referrerPolicy = "no-referrer";
    image.removeAttribute("srcset");
    image.dataset.fimMaskedAvatar = context.primaryKey;
    image.dataset.fimAvatarPrimary = context.primaryKey;
    image.dataset.fimAvatarAliases = JSON.stringify([...context.aliases]);
    avatar.dataset.fimAvatarHitTarget = "true";
    wrapper.dataset.fimAvatarHitTarget = "true";
    image.dataset.fimAvatarHitTarget = "true";
    avatar.dataset.fimOriginalHref =
      avatar.getAttribute("href") || avatar.dataset.fimOriginalHref || "";
    avatar.removeAttribute("href");
    avatar.removeAttribute("target");
    avatar.setAttribute("role", "button");
    if (!avatar.hasAttribute("tabindex")) avatar.tabIndex = 0;
    avatar.setAttribute("aria-label", "Choose another profile picture");
    image.title = "Click to choose another picture";

    if (!image.dataset.fimRotateBound) {
      image.dataset.fimRotateBound = "true";
      image.addEventListener(
        "click",
        (event) => {
          if (
            event.button !== 0 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();

          requestAvatarRotation(image);
        },
        true
      );
    }

    const fallbackUrl = emergencyAvatar(identity, context.primaryKey);
    const requestedUrl =
      image.dataset.fimFailedAvatarUrl === identity.avatarUrl
        ? fallbackUrl
        : identity.avatarUrl;
    const finishLoading = () => {
      const wasLoading = wrapper.classList.contains("fim-avatar-loading");
      wrapper.classList.remove("fim-avatar-loading");
      if (!wasLoading) return;
      image.classList.remove("fim-avatar-pop");
      requestAnimationFrame(() => image.classList.add("fim-avatar-pop"));
      window.setTimeout(() => image.classList.remove("fim-avatar-pop"), 360);
    };
    image.onload = finishLoading;
    image.onerror = () => {
      image.dataset.fimFailedAvatarUrl = identity.avatarUrl;
      image.onerror = null;
      image.onload = finishLoading;
      image.src = fallbackUrl;
    };
    if (image.getAttribute("src") !== requestedUrl) {
      image.src = requestedUrl;
      if (image.complete && image.naturalWidth > 0) {
        queueMicrotask(finishLoading);
      }
    }
    if (image.alt !== identity.displayName) image.alt = identity.displayName;

    for (const placeholder of avatar.querySelectorAll(".g-avatar__placeholder")) {
      placeholder.classList.add("fim-hidden-placeholder");
    }
  }

  function maskAvatars(context, identity) {
    if (!identity.avatarUrl) return 0;

    const acceptableKeys = new Set([context.primaryKey, ...context.aliases]);
    const avatars = [...context.container.querySelectorAll(".g-avatar")];
    let avatarCount = 0;

    for (const avatar of avatars) {
      const key = keyFromHref(
        avatar.getAttribute("href") || avatar.dataset.fimOriginalHref,
        location.origin
      );
      if (key && !acceptableKeys.has(key)) continue;
      ensureAvatarImage(avatar, identity, context);
      avatarCount += 1;
    }

    return avatarCount;
  }

  function maskContext(context, identity) {
    if (!context || !identity) {
      return { displayCount: 0, handleCount: 0, avatarCount: 0 };
    }

    const nameCounts = maskNames(context, identity);
    const avatarCount = maskAvatars(context, identity);
    context.container.dataset.fimIdentity = context.primaryKey;
    context.container.classList.remove("fim-identity-pending");

    return {
      ...nameCounts,
      avatarCount
    };
  }

  globalThis.FanIdentityMaskCore = Object.freeze({
    collectContexts,
    contextFor,
    keyFromHref,
    maskContext
  });
})();
