CreatorToolkit.runWhenEnabled("sheerTags", async () => {
(() => {
  'use strict';

  // === EDIT THIS LIST ===
  // Exact tag labels as they appear in the dropdown (case-insensitive).
  // Example values mirror your “filled” state: roleplay, small cock, etc.
  const TAGS = [
    "0% pussy","3D","alien girl","busty hentai","CBT","cock cage","cock rubbing",
    "commented gameplay","daddy","dating game","DL Site","domination","ecchi",
    "erogames","for women","futa","Gangbang (3D)","goth","guy-guy",
    "Japanese hentai game","male masseur","male solo anal","maledom","manga",
    "moaning","multiple orgasms","naked gaming","Netorare","Oppai","orgasm deprivation",
    "PC game","playing with 2 toys","porn game","prostitute","robot (3D)","roleplay",
    "RPG maker","sex toy","small cock","teen (3d)"
  ];

  // 'replace' = only these tags; 'append' = keep existing and add these
  const MODE = 'replace';

  const log = (...a) => console.log('[SheerTags]', ...a);

  function waitFor(fn, { timeout = 20000, interval = 100 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const id = setInterval(() => {
        try {
          const v = fn();
          if (v) { clearInterval(id); resolve(v); }
          else if (Date.now() - t0 > timeout) { clearInterval(id); reject(new Error('timeout')); }
        } catch (e) { clearInterval(id); reject(e); }
      }, interval);
    });
  }

  function normalize(s) { return (s || '').trim().toLowerCase(); }

  async function setTags(tagLabels) {
    const $ = window.jQuery;
    if (!$) throw new Error('jQuery not found');

    const select = await waitFor(() => document.querySelector('#contentproform-genres'));
    if (select.dataset.sheerTagsApplied === '1') {
      log('already applied; skipping');
      return;
    }

    // Build maps from visible option text -> value
    const options = Array.from(select.options);
    const byTextLower = new Map();
    for (const opt of options) byTextLower.set(normalize(opt.textContent), opt.value);

    // Current values in the select
    const currentVals = new Set((($(select).val()) || []).filter(Boolean));

    // Resolve desired values exactly by label (case-insensitive). No fuzzy guesses.
    const desired = [];
    for (const label of tagLabels) {
      const v = byTextLower.get(normalize(label));
      if (!v) {
        log('no exact match for tag label:', label);
        continue;
      }
      desired.push(v);
    }

    const finalVals = MODE === 'append'
      ? Array.from(new Set([...currentVals, ...desired]))
      : Array.from(new Set(desired));

    // Apply and notify Select2
    $(select).val(finalVals).trigger('change');

    select.dataset.sheerTagsApplied = '1';
    log('applied values:', finalVals);
  }

  // Run once after DOM is ready and Select2 has had a chance to init
  (async () => {
    try {
      await setTags(TAGS);
    } catch (e) {
      console.warn('[SheerTags] failed:', e);
    }
  })();

  // Optional: manual re-apply with Alt+T (useful if the form reloads part of itself)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'T') setTags(TAGS);
  });
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] sheer-tags.js failed:", error);
});
