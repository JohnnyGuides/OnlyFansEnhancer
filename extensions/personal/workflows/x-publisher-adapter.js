(() => {
  "use strict";

  if (globalThis.CreatorXPublisherAdapter) return;

  const MAIN_COMPOSER = '[data-testid="tweetTextarea_0"][role="textbox"]';
  const FILE_INPUT = "input[data-testid='fileInput'][type='file']";
  const MAIN_POST = '[data-testid="tweetButton"]';
  const REPLY_POST = '[data-testid="tweetButtonInline"]';
  const replyBaselines = new Map();
  const mainObservation = {
    button: null,
    clicked: false,
    identity: null,
    timer: null,
  };

  function visible(element) {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function enabled(element) {
    return (
      visible(element) &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true"
    );
  }

  function one(selector, label, predicate = visible) {
    const matches = [...document.querySelectorAll(selector)].filter(predicate);
    if (matches.length !== 1) {
      throw new Error(
        `${label} is ${matches.length ? "ambiguous" : "missing"}.`,
      );
    }
    return matches[0];
  }

  async function waitFor(read, label, timeoutMs = 5000) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        if (/ambiguous/i.test(String(error?.message || error))) throw error;
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (lastError) throw lastError;
    throw new Error(`${label} was not observed.`);
  }

  function fillEditor(editor, text) {
    editor.focus();
    editor.textContent = String(text || "");
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: String(text || ""),
      }),
    );
  }

  function statusIdentity(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== "https://x.com" || url.search || url.hash) return null;
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
      if (!match) return null;
      return {
        handle: match[1].toLowerCase(),
        resultId: match[2],
        resultUrl: `https://x.com/${match[1]}/status/${match[2]}`,
      };
    } catch {
      return null;
    }
  }

  function currentMain() {
    const identity = statusIdentity(location.href);
    if (!identity) throw new Error("The canonical X status URL is missing.");
    return identity;
  }

  function captureObservedMain() {
    if (mainObservation.identity) return true;
    const identity = statusIdentity(location.href);
    if (!identity) return false;
    mainObservation.identity = identity;
    if (mainObservation.timer) clearInterval(mainObservation.timer);
    mainObservation.timer = null;
    return true;
  }

  function observePreparedPost(button) {
    if (mainObservation.button === button) return;
    mainObservation.button = button;
    button.addEventListener(
      "click",
      () => {
        mainObservation.clicked = true;
        if (captureObservedMain()) return;
        mainObservation.timer = setInterval(captureObservedMain, 25);
        setTimeout(() => {
          if (mainObservation.timer) clearInterval(mainObservation.timer);
          mainObservation.timer = null;
        }, 30_000);
      },
      { once: true },
    );
  }

  async function mainIdentity() {
    if (!mainObservation.clicked) {
      throw new Error("The prepared X Post was not clicked in this tab.");
    }
    const identity = await waitFor(
      () => mainObservation.identity,
      "The X status reached from the prepared Post",
    );
    if (currentMain().resultUrl !== identity.resultUrl) {
      throw new Error("The current X status no longer matches this run.");
    }
    return identity;
  }

  function sameAuthorStatuses(main) {
    const matches = [...document.querySelectorAll('a[href*="/status/"]')]
      .filter(
        (anchor) => anchor instanceof HTMLAnchorElement && visible(anchor),
      )
      .map((anchor) => statusIdentity(anchor.getAttribute("href")))
      .filter(
        (identity) =>
          identity &&
          identity.handle === main.handle &&
          identity.resultId !== main.resultId,
      );
    return [...new Map(matches.map((item) => [item.resultId, item])).values()];
  }

  function replyFor(main) {
    const baseline = replyBaselines.get(main.resultId);
    if (!baseline) return null;
    const unique = sameAuthorStatuses(main).filter(
      (identity) => !baseline.has(identity.resultId),
    );
    if (unique.length > 1)
      throw new Error("The first X reply result is ambiguous.");
    return unique[0] || null;
  }

  function rememberReplyBaseline(main) {
    if (!replyBaselines.has(main.resultId)) {
      replyBaselines.set(
        main.resultId,
        new Set(sameAuthorStatuses(main).map((item) => item.resultId)),
      );
    }
  }

  function visibleOnlyFansAnchors(root = document) {
    return [...root.querySelectorAll("a[href]")].filter((anchor) => {
      try {
        return (
          anchor instanceof HTMLAnchorElement &&
          visible(anchor) &&
          new URL(anchor.href).hostname === "onlyfans.com"
        );
      } catch {
        return false;
      }
    });
  }

  function onlyFansPreview(root = document) {
    const cards = visibleOnlyFansAnchors(root)
      .map((anchor) => anchor.parentElement)
      .filter(
        (card) =>
          visible(card) && card.textContent.toLowerCase().includes("onlyfans"),
      );
    const unique = [...new Set(cards)];
    if (unique.length !== 1) {
      throw new Error(
        `The OnlyFans preview is ${unique.length ? "ambiguous" : "missing"}.`,
      );
    }
    const buttons = [...unique[0].querySelectorAll("button")].filter(
      (button) =>
        visible(button) &&
        !button.textContent.trim() &&
        !button.getAttribute("aria-label") &&
        !button.getAttribute("title") &&
        !button.dataset.testid,
    );
    if (buttons.length !== 1) {
      throw new Error(
        `The OnlyFans preview dismissal is ${buttons.length ? "ambiguous" : "missing"}.`,
      );
    }
    return { card: unique[0], dismiss: buttons[0] };
  }

  async function prepare({ caption, attachFile }) {
    if (
      location.origin !== "https://x.com" ||
      location.pathname !== "/compose/post"
    ) {
      throw new Error("Open the X post composer before preparing a post.");
    }
    if (typeof attachFile !== "function")
      throw new Error("The social file bridge is unavailable.");
    const editor = one(MAIN_COMPOSER, "The X composer");
    one(FILE_INPUT, "The X media input", () => true);
    fillEditor(editor, caption);
    await attachFile("social", FILE_INPUT);
    const postButton = await waitFor(() => {
      const progress = [
        ...document.querySelectorAll('[role="progressbar"]'),
      ].some(
        (element) =>
          visible(element) &&
          Number(element.getAttribute("aria-valuenow")) === 100,
      );
      return progress && one(MAIN_POST, "The X Post button", enabled);
    }, "The X upload-ready state");
    const preparedText = one(MAIN_COMPOSER, "The X composer").textContent;
    if (
      preparedText.replace(/\s+/g, "") !==
      String(caption || "").replace(/\s+/g, "")
    ) {
      throw new Error("The X composer does not hold the approved caption.");
    }
    const preparedCaptionSha256 = await sha256Text(preparedText);
    if (one(MAIN_COMPOSER, "The X composer").textContent !== preparedText) {
      throw new Error("The X caption changed while preparation finished.");
    }
    observePreparedPost(postButton);
    return {
      platform: "x",
      status: "prepared",
      upload: "ready",
      preparedCaptionSha256,
    };
  }

  async function sha256Text(value) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(value || "")),
    );
    return [...new Uint8Array(digest)]
      .map((item) => item.toString(16).padStart(2, "0"))
      .join("");
  }

  async function submit({ beforeCommit, captionSha256 }) {
    if (typeof beforeCommit !== "function")
      throw new Error("The durable submit gate is unavailable.");
    if (!/^[0-9a-f]{64}$/.test(String(captionSha256 ?? "")))
      throw new Error("The prepared X caption hash is missing or malformed.");
    one(MAIN_POST, "The X Post button", enabled);
    const authorization = await beforeCommit();
    if (authorization?.armed !== true)
      throw new Error("The X post was not durably armed.");
    const onCompose = () =>
      location.origin === "https://x.com" &&
      location.pathname === "/compose/post";
    if (!onCompose())
      throw new Error("The X composer changed after the post was armed.");
    const text = one(MAIN_COMPOSER, "The X composer").textContent;
    const hash = await sha256Text(text);
    // No await below: the text, route and button are checked and clicked in one turn.
    if (one(MAIN_COMPOSER, "The X composer").textContent !== text)
      throw new Error("The X caption changed after the post was armed.");
    if (hash !== captionSha256)
      throw new Error("The X caption changed after the post was armed.");
    if (!onCompose())
      throw new Error("The X composer changed after the post was armed.");
    const button = one(MAIN_POST, "The X Post button", enabled);
    button.click();
    return { platform: "x", status: "submitted" };
  }

  function capturedReply(main) {
    const reply = replyFor(main);
    return reply
      ? {
          resultId: main.resultId,
          resultUrl: main.resultUrl,
          replyResultId: reply.resultId,
          replyResultUrl: reply.resultUrl,
        }
      : null;
  }

  async function prepareReply({ paidUrl }) {
    const main = currentMain();
    const captured = capturedReply(main);
    if (captured) return captured;
    rememberReplyBaseline(main);
    const editor = one(MAIN_COMPOSER, "The X reply composer");
    if (
      editor.textContent.trim() !== String(paidUrl || "").trim() ||
      visibleOnlyFansAnchors().length > 0
    ) {
      fillEditor(editor, paidUrl);
      const preview = await waitFor(onlyFansPreview, "The OnlyFans preview");
      preview.dismiss.click();
      await waitFor(
        () => !preview.card.isConnected || !visible(preview.card),
        "OnlyFans preview removal",
      );
    }
    return {
      status: "reply-prepared",
      resultId: main.resultId,
      resultUrl: main.resultUrl,
    };
  }

  async function submitReply({ beforeCommit, resultId, paidUrl }) {
    if (typeof resultId !== "string" || !resultId)
      throw new Error("The armed X result id is required.");
    if (typeof paidUrl !== "string")
      throw new Error("The armed X paid URL is required.");
    const main = currentMain();
    const captured = capturedReply(main);
    if (captured) return captured;
    if (typeof beforeCommit !== "function") {
      throw new Error("The durable X reply gate is unavailable.");
    }
    one(REPLY_POST, "The X Reply button", enabled);
    const authorization = await beforeCommit({
      resultId: main.resultId,
      resultUrl: main.resultUrl,
    });
    if (authorization?.armed !== true)
      throw new Error("The X reply was not durably armed.");
    if (currentMain().resultId !== resultId)
      throw new Error("The X status changed after the reply was armed.");
    if (
      one(MAIN_COMPOSER, "The X reply composer").textContent.trim() !==
      paidUrl.trim()
    )
      throw new Error("The X reply changed after it was armed.");
    one(REPLY_POST, "The X Reply button", enabled).click();
    const reply = await waitFor(
      () => replyFor(main),
      "The canonical first X reply",
    );
    return {
      resultId: main.resultId,
      resultUrl: main.resultUrl,
      replyResultId: reply.resultId,
      replyResultUrl: reply.resultUrl,
    };
  }

  async function captureResult({
    mode,
    paidUrl,
    beforeReplyCommit,
    allowReplySubmit = true,
  }) {
    const main = currentMain();
    const captured = capturedReply(main);
    if (captured) return captured;
    if (allowReplySubmit === false) {
      throw new Error(
        "The X reply was already attempted; recovery may capture it but cannot post it again.",
      );
    }

    const prepared = await prepareReply({ paidUrl });
    if (prepared.replyResultId || mode === "manual") return prepared;
    if (mode !== "autonomous")
      throw new Error("The X execution mode is invalid.");
    return submitReply({
      beforeCommit: beforeReplyCommit,
      resultId: prepared.resultId,
      paidUrl,
    });
  }

  // Automatic first reply on an already posted teaser's status page. The
  // composer must hold exactly the reply text with no link card before the
  // background records its durable checkpoint and asks for the click.
  const FIRST_REPLY_TIMING = Object.freeze({
    elementWaitMs: 20_000,
    conversationSettleMs: 2_000,
    cardWaitMs: 8_000,
    removalWaitMs: 5_000,
    settleMs: 1_500,
    confirmWaitMs: 20_000,
  });
  const FIRST_REPLY_ATTEMPTS = 3;

  function firstReplyTiming(value) {
    const timing = { ...FIRST_REPLY_TIMING };
    for (const key of Object.keys(timing)) {
      const number = Number(value?.[key]);
      if (Number.isFinite(number) && number >= 0 && number <= 60_000)
        timing[key] = number;
    }
    return timing;
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function ownerTeaser({ statusId, ownerHandle }) {
    const main = statusIdentity(location.href);
    if (
      !main ||
      main.resultId !== String(statusId || "") ||
      main.handle !== String(ownerHandle || "").toLowerCase()
    )
      throw new Error("not-owner-teaser: this is not the owner's teaser page.");
    return main;
  }

  // The signed-in account, read from X's own profile tab link (the same
  // source as the collector's owner check); every such link must agree.
  function signedInHandle() {
    const handles = new Set(
      [
        ...document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"]'),
      ].map((link) => {
        const match = String(link.getAttribute("href") || "").match(
          /^\/([A-Za-z0-9_]{1,15})$/,
        );
        return match ? match[1].toLowerCase() : "";
      }),
    );
    return handles.size === 1 ? [...handles][0] : "";
  }

  function requireOwnerAccount(ownerHandle) {
    const owner = String(ownerHandle || "").toLowerCase();
    if (!owner || signedInHandle() !== owner)
      throw new Error("wrong-account: X is not signed in as the owner.");
  }

  function ownerArticles(main) {
    return [...document.querySelectorAll("article")].filter(
      (article) =>
        visible(article) &&
        [...article.querySelectorAll('a[href*="/status/"]')].some((anchor) => {
          const identity = statusIdentity(anchor.getAttribute("href"));
          return (
            identity?.handle === main.handle &&
            identity.resultId === main.resultId
          );
        }),
    );
  }

  // Owner statuses newer than the teaser are treated as replies in its
  // conversation; any of them stops the automatic reply.
  function ownerRepliesAfter(main) {
    return sameAuthorStatuses(main).filter(
      (identity) => BigInt(identity.resultId) > BigInt(main.resultId),
    );
  }

  function composerRoot(editor) {
    for (let node = editor.parentElement; node; node = node.parentElement) {
      if (node.querySelector(REPLY_POST)) return node;
    }
    throw new Error("composer-missing: the X reply composer has no Reply.");
  }

  function composerText(editor) {
    return String(editor.innerText ?? editor.textContent ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/\n+$/, "");
  }

  function linkCards(root) {
    return [
      ...[...root.querySelectorAll('[data-testid="card.wrapper"]')].filter(
        visible,
      ),
      ...visibleOnlyFansAnchors(root),
    ];
  }

  function firstReplyGate(editor, root, text, paidUrl) {
    if (
      !/^https:\/\/onlyfans\.com\/\d{1,30}\/johnny_guides$/.test(
        String(paidUrl || ""),
      ) ||
      !text.endsWith(`\n-> ${paidUrl}`)
    )
      throw new Error("mismatch: the reply does not carry the episode link.");
    if (linkCards(root).length)
      throw new Error("card-not-removed: a link card is still attached.");
    if (composerText(editor) !== text)
      throw new Error("mismatch: the composer does not hold the reply text.");
  }

  function pasteText(editor, text) {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const handled = !editor.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    if (!handled) fillEditor(editor, text);
  }

  async function prepareFirstReply({
    statusId,
    ownerHandle,
    text,
    paidUrl,
    timing,
  }) {
    const limits = firstReplyTiming(timing);
    const expected = String(text || "");
    if (!expected) throw new Error("mismatch: the reply text is missing.");
    const main = ownerTeaser({ statusId, ownerHandle });
    await waitFor(
      () => signedInHandle(),
      "The signed-in X account",
      limits.elementWaitMs,
    ).catch(() => {});
    requireOwnerAccount(ownerHandle);
    await waitFor(
      () => ownerArticles(main).length > 0,
      "The teaser post",
      limits.elementWaitMs,
    ).catch(() => {
      throw new Error("not-owner-teaser: the teaser post was not shown.");
    });
    const editor = await waitFor(
      () => one(MAIN_COMPOSER, "The X reply composer"),
      "The X reply composer",
      limits.elementWaitMs,
    ).catch(() => {
      throw new Error("composer-missing: the X reply composer was not shown.");
    });
    await pause(limits.conversationSettleMs);
    if (ownerArticles(main).length !== 1)
      throw new Error("not-owner-teaser: the teaser post is ambiguous.");
    const existing = ownerRepliesAfter(main);
    if (existing.length)
      return { status: "existing-reply", replyId: existing[0].resultId };
    replyBaselines.set(
      main.resultId,
      new Set(sameAuthorStatuses(main).map((item) => item.resultId)),
    );
    const root = composerRoot(editor);
    let failure = null;
    const removeCard = async () => {
      const preview = onlyFansPreview(root);
      preview.dismiss.click();
      await waitFor(
        () => !preview.card.isConnected || !visible(preview.card),
        "Link card removal",
        limits.removalWaitMs,
      );
    };
    for (let attempt = 0; attempt < FIRST_REPLY_ATTEMPTS; attempt += 1) {
      try {
        // A card left by the previous attempt goes before the re-paste.
        if (linkCards(root).length) await removeCard();
        pasteText(editor, expected);
        const appeared = await waitFor(
          () => linkCards(root).length > 0,
          "The link card",
          limits.cardWaitMs,
        ).catch(() => false);
        if (appeared) await removeCard();
        await pause(limits.settleMs);
        firstReplyGate(editor, root, expected, paidUrl);
        requireOwnerAccount(ownerHandle);
        one(REPLY_POST, "The X Reply button", enabled);
        return {
          status: "ready",
          resultId: main.resultId,
          attempts: attempt + 1,
        };
      } catch (error) {
        if (/^wrong-account:/.test(String(error?.message))) throw error;
        failure = error;
      }
    }
    if (linkCards(root).length)
      throw new Error("card-not-removed: the link card could not be removed.");
    throw /^mismatch:/.test(String(failure?.message))
      ? failure
      : new Error(
          `mismatch: ${String(failure?.message || "the reply was not prepared.")}`,
        );
  }

  async function submitFirstReply({
    statusId,
    ownerHandle,
    text,
    paidUrl,
    timing,
  }) {
    const limits = firstReplyTiming(timing);
    const expected = String(text || "");
    const main = ownerTeaser({ statusId, ownerHandle });
    if (!expected || !replyBaselines.has(main.resultId))
      throw new Error("mismatch: the reply was not prepared in this page.");
    if (ownerRepliesAfter(main).length)
      throw new Error("existing-reply: an owner reply appeared.");
    const editor = one(MAIN_COMPOSER, "The X reply composer");
    const root = composerRoot(editor);
    // No await between the final gate and the click.
    requireOwnerAccount(ownerHandle);
    firstReplyGate(editor, root, expected, paidUrl);
    one(REPLY_POST, "The X Reply button", enabled).click();
    const reply = await waitFor(
      () => replyFor(main),
      "The posted X reply",
      limits.confirmWaitMs,
    ).catch((error) => {
      throw new Error(
        `unconfirmed: ${String(error?.message || "the reply was not observed.")}`,
      );
    });
    return {
      resultId: main.resultId,
      replyId: reply.resultId,
      replyUrl: reply.resultUrl,
    };
  }

  globalThis.CreatorXPublisherAdapter = Object.freeze({
    prepare,
    prepareReply,
    submit,
    submitReply,
    captureResult,
    mainIdentity,
    prepareFirstReply,
    submitFirstReply,
  });
})();
