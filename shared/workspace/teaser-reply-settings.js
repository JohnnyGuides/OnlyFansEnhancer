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
      '<header><h2 id="replySettingsTitle">Reply text</h2><button type="button" data-close aria-label="Close reply settings">×</button></header><p class="hint">Shared by all X replies.</p><div class="teaser-reply-controls"><label>Wording<select aria-label="Reply wording"><option value="rotate">Rotate saved replies</option><option value="link">Link only</option></select></label><label data-entries>Saved reply<span class="teaser-reply-variants"><select aria-label="Saved reply"></select><button type="button" data-add aria-label="Add reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><button type="button" data-remove aria-label="Remove reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7"/></svg></button></span></label></div><label data-message>Message<textarea aria-label="Reply message" rows="3" maxlength="200" placeholder="Write the complete reply. The video link is added below."></textarea></label><label>Preview<pre aria-label="Reply preview"></pre></label><p role="status"></p><footer><button type="button" data-apply>Apply</button></footer>';
    document.body.append(dialog);
    const mode = dialog.querySelector("select"),
      lines = dialog.querySelector("textarea"),
      preview = dialog.querySelector("pre"),
      status = dialog.querySelector('[role="status"]'),
      apply = dialog.querySelector("[data-apply]");
    const entries = dialog.querySelector('[aria-label="Saved reply"]'),
      add = dialog.querySelector("[data-add]"),
      remove = dialog.querySelector("[data-remove]");
    let variants = [],
      selected = 0;
    const value = () => ({
      mode: mode.value,
      variants,
    });
    function renderEntries() {
      entries.replaceChildren(
        ...variants.map((reply, index) => {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = `${index + 1} · ${reply.split("\n")[0].slice(0, 48) || "New reply"}`;
          return option;
        }),
      );
      entries.value = String(selected);
      add.disabled = variants.length >= 20;
      remove.disabled = variants.length <= 1;
    }
    function render() {
      dialog.querySelector("[data-entries]").hidden = mode.value === "link";
      dialog.querySelector("[data-message]").hidden = mode.value === "link";
      const phrase = mode.value === "link" ? "" : variants[selected] || "";
      preview.textContent = global.CreatorXReplyPolicy.format(
        phrase,
        paidUrl() || "[video link]",
      );
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
        variants = [...config.variants];
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
      variants[selected] = lines.value;
      renderEntries();
      render();
    });
    entries.addEventListener("change", () => {
      selected = Number(entries.value);
      lines.value = variants[selected];
      render();
    });
    add.addEventListener("click", () => {
      if (variants.length >= 20) return;
      variants.push("");
      selected = variants.length - 1;
      lines.value = "";
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
      .querySelector("[data-close]")
      .addEventListener("click", () => dialog.close());
    apply.addEventListener("click", async () => {
      if (busy()) return;
      status.textContent = "";
      try {
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
