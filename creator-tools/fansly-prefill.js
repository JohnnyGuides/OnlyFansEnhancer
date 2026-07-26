CreatorToolkit.runWhenEnabled("fanslyPrefill", async () => {
(function () {
  "use strict";

  // --- CONFIG ---
  const MESSAGE = `\n\n #GameSync #JohnnyGuides #Season2 #Solo #SoloMale #Masturbation #Hentai #Anime #Masturbator #Moaning #Whimpering #MaleMoaning #ASMR #RuinedOrgasm #Edging #twink #gaming #JOI #TryNotToCum #Gooning #FemdomControl #Femdom #Femboy #FemboyGamer #POV`;

  // Toggle these to your defaults
  const TOGGLE_OPTS = {
    "Post to FYP": false,   // true = check, false = uncheck
    "Post to Walls": true,
    "Lock Replies": false
  };

  // Only write if empty to avoid overwriting drafts
  const ONLY_IF_EMPTY = true;

  // --- CORE ---
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setTextareaValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function toggleCheckboxByLabel(rootEl, labelText, desiredChecked) {
    // Find the .post-option container whose text includes the label
    const row = qa(".post-option", rootEl).find(r => r.textContent?.trim().includes(labelText));
    if (!row) return;
    const box = q(".checkbox", row);
    if (!box) return;
    const isSelected = box.classList.contains("selected");
    if (desiredChecked !== undefined && desiredChecked !== isSelected) {
      // Click the visual checkbox; Angular listens on it
      box.click();
    }
  }

  function fillOnce(root = document) {
    const composer = q("app-post-creation");
    if (!composer) return false;

    const textarea = q("textarea", composer);
    if (!textarea) return false;

    if (ONLY_IF_EMPTY && (textarea.value?.trim().length || textarea.getAttribute("value"))) {
      return true; // already filled or user typed
    }

    setTextareaValue(textarea, MESSAGE);

    // Optional: flip the three common toggles if present
    Object.entries(TOGGLE_OPTS).forEach(([label, val]) =>
      toggleCheckboxByLabel(composer, label, val)
    );

    // Try to focus the Post button so you can hit Enter/Space quickly
    const postBtn = qa(".new-post-btn", composer).find(b => /Post/i.test(b.textContent || ""));
    if (postBtn) postBtn.focus();

    return true;
  }

  // Observe for Angular route changes / re-renders
  const obs = new MutationObserver(() => {
    fillOnce();
  });

  function start() {
    // Run immediately and then observe
    fillOnce();
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Safety: delay a bit to let the app boot
  setTimeout(start, 800);

  // Hotkey: Alt+F to re-fill on demand
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "f") {
      fillOnce();
    }
  });
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] fansly-prefill.js failed:", error);
});
