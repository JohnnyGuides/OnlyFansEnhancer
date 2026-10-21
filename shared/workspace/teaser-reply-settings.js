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
    dialog.setAttribute("aria-labelledby", "replySettingsTitle");
    dialog.innerHTML =
      '<header><h2 id="replySettingsTitle">Reply text</h2><button type="button" data-close aria-label="Close reply settings">×</button></header><p class="hint">Shared by all X replies.</p><label>Wording<select aria-label="Reply wording"><option value="rotate">Rotate through lines</option><option value="link">Link only</option></select></label><label data-lines>Reply lines<textarea aria-label="Reply lines" rows="3" placeholder="One phrase per line"></textarea></label><label>Next reply<pre aria-label="Next reply preview"></pre></label><p role="status"></p><footer><button type="button" data-apply>Apply</button></footer>';
    document.body.append(dialog);
    const mode = dialog.querySelector("select"),
      lines = dialog.querySelector("textarea"),
      preview = dialog.querySelector("pre"),
      status = dialog.querySelector('[role="status"]'),
      apply = dialog.querySelector("[data-apply]");
    let nextIndex = 0;
    const value = () => ({
      mode: mode.value,
      variants: lines.value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    });
    function render() {
      dialog.querySelector("[data-lines]").hidden = mode.value === "link";
      const config = value(),
        phrase =
          config.mode === "link"
            ? ""
            : config.variants[nextIndex % config.variants.length] || "";
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
        lines.value = config.variants.join("\n");
        nextIndex = config.nextIndex;
        render();
        apply.disabled = false;
      } catch (error) {
        status.textContent = error.message;
      }
    });
    mode.addEventListener("change", render);
    lines.addEventListener("input", render);
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
