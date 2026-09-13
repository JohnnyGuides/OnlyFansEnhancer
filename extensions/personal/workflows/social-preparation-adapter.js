(() => {
  "use strict";
  if (globalThis.CreatorSocialPreparationAdapter) return;

  // Observed in the signed-in Reddit and RedGIFs Studio composers on 2026-09-08.
  // This adapter only prepares fields; it deliberately exposes no publish action.
  const REDGIFS_FILE = "input[type='file'][accept='video/*']";
  const REDDIT_TITLE =
    'div[slot="editor"][contenteditable="true"][role="textbox"]';

  function visible(element) {
    return (
      element &&
      !element.hidden &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden"
    );
  }

  function one(root, selector, label, predicate = visible) {
    const matches = [...(root?.querySelectorAll(selector) || [])].filter(
      predicate,
    );
    if (matches.length !== 1)
      throw new Error(
        `${label} is ${matches.length ? "ambiguous" : "missing"}.`,
      );
    return matches[0];
  }

  async function waitFor(read) {
    let error;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return read();
      } catch (caught) {
        if (/ambiguous|subreddit|composer/i.test(caught.message)) throw caught;
        error = caught;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw error;
  }

  function assertReddit(subreddit) {
    if (
      !/^[A-Za-z0-9_]{2,21}$/.test(subreddit || "") ||
      location.origin !== "https://www.reddit.com" ||
      location.pathname.replace(/\/$/, "").toLowerCase() !==
        `/r/${subreddit.toLowerCase()}/submit` ||
      new URL(location.href).searchParams.get("type") !== "LINK"
    )
      throw new Error("The selected subreddit Link composer is not open.");
    const selected = document.querySelector('input[name="subredditName"]');
    if (
      selected instanceof HTMLInputElement &&
      selected.value &&
      selected.value.toLowerCase() !== subreddit.toLowerCase()
    )
      throw new Error("The selected subreddit changed.");
  }

  function titleEditor() {
    return one(document, REDDIT_TITLE, "Reddit title");
  }

  function linkEditor() {
    const host = one(
      document,
      'faceplate-textarea-input[name="link"]',
      "Reddit link field",
    );
    const input = one(
      host.shadowRoot,
      'textarea[name="link"]',
      "Reddit link input",
    );
    if (input.disabled || host.getAttribute("aria-disabled") === "true")
      throw new Error("Reddit link input is disabled.");
    return input;
  }

  function fillTitle(editor, title) {
    if (editor.textContent === title) return;
    if (editor.textContent.trim())
      throw new Error(
        "An existing draft title is present. Review it in Reddit first.",
      );
    editor.focus();
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    if (
      !document.execCommand("insertText", false, title) ||
      editor.textContent !== title
    )
      throw new Error(
        "Reddit did not accept the draft title. Enter it in Reddit.",
      );
  }

  async function run(args) {
    if (!new Set(["inspect", "prepare", "link"]).has(args.action))
      throw new Error("Unknown preparation action. Publication is manual.");
    if (args.platform === "redgifs") {
      if (
        location.origin !== "https://studio.redgifs.com" ||
        location.pathname !== "/upload"
      )
        throw new Error("Redgifs Studio upload is not open.");
      if (args.action === "link")
        throw new Error("Redgifs link insertion is unsupported.");
      if (args.action === "inspect") {
        await waitFor(() =>
          one(
            document,
            REDGIFS_FILE,
            "Redgifs video input",
            (input) => input instanceof HTMLInputElement && !input.disabled,
          ),
        );
        return { platform: "redgifs", status: "available" };
      }
      const file = await globalThis.CreatorUploadFileBridge.waitFor(
        args.sessionId,
        "social",
      );
      return {
        platform: "redgifs",
        status: "review-required",
        upload: "file-attached",
        fileName: file.name,
        manualFields: [...(args.caption ? ["caption"] : []), "tags", "publish"],
      };
    }
    if (args.platform !== "reddit")
      throw new Error("Unsupported preparation platform.");
    assertReddit(args.subreddit);
    const title = await waitFor(titleEditor);
    if (args.action === "inspect")
      return { platform: "reddit", status: "available" };
    if (args.action === "prepare") {
      if (
        typeof args.title !== "string" ||
        !args.title.trim() ||
        args.title.length > 300
      )
        throw new Error("A Reddit title of up to 300 characters is required.");
      fillTitle(title, args.title);
      return {
        platform: "reddit",
        status: "waiting-for-redgifs",
        manualFields: [
          ...(args.body ? ["body"] : []),
          ...(args.flair ? ["flair"] : []),
          ...(args.nsfw ? ["nsfw"] : []),
          "publish",
        ],
      };
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(title.textContent),
    );
    const hash = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== args.titleHash)
      throw new Error(
        "The Reddit draft title changed. Review it before inserting the link.",
      );
    const url = new URL(args.redgifsUrl);
    if (
      url.origin !== "https://www.redgifs.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/watch\/[A-Za-z0-9-]{2,100}$/.test(url.pathname)
    )
      throw new Error("A canonical Redgifs URL is required.");
    const input = await waitFor(linkEditor);
    if (input.value && input.value !== url.href)
      throw new Error(
        "An existing draft link is present. Review it in Reddit first.",
      );
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    ).set.call(input, url.href);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (input.value !== url.href)
      throw new Error("Reddit did not accept the Redgifs link.");
    return {
      platform: "reddit",
      status: "ready-for-review",
      manualFields: ["publish"],
    };
  }

  globalThis.CreatorSocialPreparationAdapter = Object.freeze({ run });
})();
