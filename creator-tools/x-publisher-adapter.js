(() => {
  "use strict";

  if (globalThis.CreatorXPublisherAdapter) return;

  const MAIN_COMPOSER = '[data-testid="tweetTextarea_0"][role="textbox"]';
  const FILE_INPUT = "input[data-testid='fileInput'][type='file']";
  const MAIN_POST = '[data-testid="tweetButton"]';
  const REPLY_POST = '[data-testid="tweetButtonInline"]';

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

  function replyFor(main) {
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
    const unique = [
      ...new Map(matches.map((item) => [item.resultId, item])).values(),
    ];
    if (unique.length > 1)
      throw new Error("The first X reply result is ambiguous.");
    return unique[0] || null;
  }

  function onlyFansPreview() {
    const cards = [...document.querySelectorAll("a[href]")]
      .filter((anchor) => {
        try {
          return (
            anchor instanceof HTMLAnchorElement &&
            visible(anchor) &&
            new URL(anchor.href).hostname === "onlyfans.com"
          );
        } catch {
          return false;
        }
      })
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
    await waitFor(() => {
      const progress = [
        ...document.querySelectorAll('[role="progressbar"]'),
      ].some(
        (element) =>
          visible(element) &&
          Number(element.getAttribute("aria-valuenow")) === 100,
      );
      return progress && one(MAIN_POST, "The X Post button", enabled);
    }, "The X upload-ready state");
    return { platform: "x", status: "prepared", upload: "ready" };
  }

  async function submit({ beforeCommit }) {
    if (typeof beforeCommit !== "function")
      throw new Error("The durable submit gate is unavailable.");
    const button = one(MAIN_POST, "The X Post button", enabled);
    const authorization = await beforeCommit();
    if (authorization?.armed !== true)
      throw new Error("The X post was not durably armed.");
    button.click();
    return { platform: "x", status: "submitted" };
  }

  async function captureResult({
    mode,
    paidUrl,
    beforeReplyCommit,
    allowReplySubmit = true,
  }) {
    const main = currentMain();
    const existingReply = replyFor(main);
    if (existingReply) {
      return {
        resultId: main.resultId,
        resultUrl: main.resultUrl,
        replyResultId: existingReply.resultId,
        replyResultUrl: existingReply.resultUrl,
      };
    }
    if (allowReplySubmit === false) {
      throw new Error(
        "The X reply was already attempted; recovery may capture it but cannot post it again.",
      );
    }

    const editor = one(MAIN_COMPOSER, "The X reply composer");
    fillEditor(editor, paidUrl);
    const preview = await waitFor(onlyFansPreview, "The OnlyFans preview");
    preview.dismiss.click();
    await waitFor(
      () => !preview.card.isConnected || !visible(preview.card),
      "OnlyFans preview removal",
    );

    if (mode === "manual") {
      return {
        status: "reply-prepared",
        resultId: main.resultId,
        resultUrl: main.resultUrl,
      };
    }
    if (mode !== "autonomous")
      throw new Error("The X execution mode is invalid.");
    if (typeof beforeReplyCommit !== "function") {
      throw new Error("The durable X reply gate is unavailable.");
    }
    const button = one(REPLY_POST, "The X Reply button", enabled);
    const authorization = await beforeReplyCommit({
      resultId: main.resultId,
      resultUrl: main.resultUrl,
    });
    if (authorization?.armed !== true)
      throw new Error("The X reply was not durably armed.");
    button.click();
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

  globalThis.CreatorXPublisherAdapter = Object.freeze({
    prepare,
    submit,
    captureResult,
  });
})();
