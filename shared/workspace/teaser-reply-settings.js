(function (global) {
  "use strict";
  function mount({ label, paidUrl, send, busy }) {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "teaser-ending-gear teaser-reply-trigger";
    trigger.setAttribute("aria-label", "Reply settings");
    trigger.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const heading = document.createElement("span");
    heading.className = "teaser-reply-heading";
    heading.append(label.firstChild, trigger);
    label.prepend(heading);
    const dialog = document.createElement("dialog");
    dialog.className = "teaser-ending-dialog teaser-reply-dialog";
    dialog.id = "teaserReplyDialog";
    dialog.setAttribute("aria-labelledby", "replySettingsTitle");
    dialog.innerHTML =
      '<header><h2 id="replySettingsTitle">Reply text</h2><button type="button" data-close aria-label="Close reply settings">×</button></header><div class="teaser-reply-toolbar"><label>Wording<select aria-label="Reply wording"><option value="rotate">Rotate saved replies</option><option value="link">Link only</option></select></label><button type="button" data-open>Open .txt</button><button type="button" data-save>Save .txt</button><input type="file" accept=".txt,text/plain" aria-label="Open reply text file" hidden></div><div class="teaser-reply-workspace" data-entries><section><div class="teaser-reply-section-heading"><strong>Saved replies</strong><button type="button" data-add aria-label="Add reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div><nav class="teaser-link-results teaser-reply-list" aria-label="Saved replies"></nav></section><section class="teaser-reply-editor"><label class="teaser-reply-section-heading">Message <small>{link} = video URL</small><button type="button" data-remove aria-label="Remove reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7"/></svg></button></label><textarea aria-label="Reply message" rows="3" maxlength="200" placeholder="Use {link} where the selected video URL should appear."></textarea><label>Preview<pre aria-label="Reply preview"></pre></label></section></div><p role="status"></p><footer><small>Shared by all X replies.</small><button type="button" data-apply>Apply</button></footer>';
    document.body.append(dialog);
    const mode = dialog.querySelector("select"),
      lines = dialog.querySelector("textarea"),
      preview = dialog.querySelector("pre"),
      status = dialog.querySelector('[role="status"]'),
      apply = dialog.querySelector("[data-apply]");
    const entries = dialog.querySelector('[aria-label="Saved replies"]'),
      add = dialog.querySelector("[data-add]"),
      remove = dialog.querySelector("[data-remove]");
    const fileInput = dialog.querySelector('input[type="file"]');
    let variants = [],
      selected = 0;
    const value = () => ({
      mode: mode.value,
      variants,
    });
    function renderEntries() {
      entries.replaceChildren(
        ...variants.map((reply, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "teaser-link-result";
          button.setAttribute("aria-pressed", String(index === selected));
          const title = document.createElement("span"),
            detail = document.createElement("small");
          title.textContent = `${index + 1} · ${reply.split("\n")[0] || "New reply"}`;
          detail.textContent = reply.split("\n").slice(1).join("\n");
          button.append(title, detail);
          button.addEventListener("click", () => {
            status.textContent = "";
            selected = index;
            lines.value = variants[selected];
            renderEntries();
            render();
            entries.children[index]?.focus();
          });
          return button;
        }),
      );
      add.disabled = variants.length >= 20;
      remove.disabled = variants.length <= 1;
    }
    function render() {
      dialog.classList.toggle("reply-link-only", mode.value === "link");
      const phrase = mode.value === "link" ? "" : variants[selected] || "";
      preview.textContent =
        mode.value === "link" || phrase.includes("{link}")
          ? global.CreatorXReplyPolicy.format(
              phrase,
              paidUrl() || "[video link]",
            )
          : phrase;
    }
    trigger.addEventListener("click", async (event) => {
      event.preventDefault();
      if (busy()) return;
      status.textContent = "";
      apply.disabled = true;
      dialog.showModal();
      try {
        const response = await send({ type: "GET_X_REPLY_POLICY" });
        if (!response?.replyPolicy)
          throw new Error(
            "Reply settings are unavailable. Check the Chrome connection.",
          );
        const config = response.replyPolicy;
        mode.value = config.mode;
        variants = config.variants.map(global.CreatorXReplyPolicy.template);
        selected = config.nextIndex % variants.length;
        lines.value = variants[selected];
        renderEntries();
        render();
        apply.disabled = false;
      } catch (error) {
        status.textContent = error.message;
      }
    });
    mode.addEventListener("change", render);
    lines.addEventListener("input", () => {
      status.textContent = "";
      variants[selected] = lines.value;
      renderEntries();
      render();
    });
    add.addEventListener("click", () => {
      if (variants.length >= 20) return;
      variants.push("{link}");
      selected = variants.length - 1;
      lines.value = variants[selected];
      renderEntries();
      render();
      lines.focus();
    });
    remove.addEventListener("click", () => {
      if (variants.length <= 1) return;
      variants.splice(selected, 1);
      selected = Math.min(selected, variants.length - 1);
      lines.value = variants[selected];
      renderEntries();
      render();
    });
    dialog
      .querySelector("[data-open]")
      .addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file || busy()) return;
      status.textContent = "";
      try {
        if (file.size > 64 * 1024)
          throw new Error("Choose a text file smaller than 64 KB.");
        const imported = global.CreatorXReplyPolicy.fromText(await file.text());
        variants = imported;
        selected = 0;
        mode.value = "rotate";
        lines.value = variants[0];
        renderEntries();
        render();
        status.textContent = "Replies loaded. Apply to use them.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        fileInput.value = "";
      }
    });
    dialog.querySelector("[data-save]").addEventListener("click", () => {
      status.textContent = "";
      try {
        const text = global.CreatorXReplyPolicy.toText(variants);
        const url = URL.createObjectURL(
          new Blob([text], { type: "text/plain;charset=utf-8" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "x-replies.txt";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        status.textContent = error.message;
      }
    });
    dialog
      .querySelector("[data-close]")
      .addEventListener("click", () => dialog.close());
    apply.addEventListener("click", async () => {
      if (busy()) return;
      status.textContent = "";
      try {
        if (variants.some((reply) => !reply.includes("{link}")))
          throw new Error("Include {link} in each saved reply.");
        const config = global.CreatorXReplyPolicy.normalize(value());
        apply.disabled = true;
        const response = await send({
          type: "SET_X_REPLY_POLICY",
          replyPolicy: config,
        });
        if (!response?.replyPolicy)
          throw new Error("Reply settings could not be saved.");
        dialog.close();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        apply.disabled = false;
      }
    });
  }
  global.OFEnhancerTeaserReplySettings = Object.freeze({ mount });
})(globalThis);
