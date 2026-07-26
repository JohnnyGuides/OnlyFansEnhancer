CreatorToolkit.runWhenEnabled("manyvidsAutofill", async () => {
(function () {
  'use strict';

  // ---------- CONFIG ----------
  const TAGS = [
    "MoaningFetish","ASMR","Masturbation","FuckMachine","CockTease",
    "RuinedOrgasms","Toys","Twink","EdgePlay","SoloMale"
  ];
  const PRICE = '19.99';
  const TIME_TEXT_PREF = '03:00 PM';
  const TIME_VALUE_FALLBACK = '15:00';

  // Human cadence
  const TYPE_MIN = 55, TYPE_MAX = 135;
  const SERVER_SETTLE_MS = 900;
  const SELECT_SETTLE_MS = 300;
  const SUGGESTION_TIMEOUT_MS = 3500;

  // Single-run guard (prevents double typers)
  if (window.__MV_AUTOFILL_RUNNING__) return;
  window.__MV_AUTOFILL_RUNNING__ = true;

  // ---------- utils ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rint = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;

  async function waitFor(sel, {timeout=20000, root=document} = {}) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const el = root.querySelector(sel);
      if (el) return el;
      await sleep(100);
    }
    throw new Error('Timeout for '+sel);
  }

  function setNativeValue(el, val) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
  }

  function dispatchKey(el, type, key, code) {
    el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true, key, code,
      keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      which: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
    }));
  }

  function pointerTap(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(12, r.width/2), y = r.top + Math.min(12, r.height/2);
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, clientY:y}));
    el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:x, clientY:y}));
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:x, clientY:y}));
  }

  function fireInput(el, dataChar) {
    el.dispatchEvent(new InputEvent('input', {bubbles:true, data: dataChar ?? null, inputType: dataChar ? 'insertText' : 'insertReplacementText'}));
  }
  function fireChange(el){ el.dispatchEvent(new Event('change', {bubbles:true})); }

  function visibleSuggestions() {
    const cont = document.querySelector('#dropdown-items-custom-tags');
    if (!cont) return [];
    const items = [...cont.querySelectorAll('li, a, div')].filter(el => {
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null;
    });
    return items.filter(el => !el.classList.contains('not-found-button-section-custom-tag'));
  }

  // ---------- steps ----------
  async function setCoPerformerNo() {
    const sel = await waitFor('select#co-performer').catch(()=>null);
    if (!sel) return;
    const opt = [...sel.options].find(o => o.text.trim() === 'No' || o.value === 'NO');
    if (opt) { sel.value = opt.value; fireChange(sel); }
  }

  async function setPrice() {
    const priceRadio = document.querySelector('#free_vid_0');
    if (priceRadio && !priceRadio.checked) priceRadio.click();
    const input = await waitFor('#appendedPrependedInput');
    setNativeValue(input, PRICE);
    fireInput(input); fireChange(input);
  }

  async function setLaunchTime() {
    const custom = document.querySelector('#launchCustom');
    if (custom && !custom.checked) custom.click();
    const sel = await waitFor('#available_time');
    let opt = [...sel.options].find(o => o.textContent.trim() === TIME_TEXT_PREF)
          || [...sel.options].find(o => (o.value||'').trim() === TIME_VALUE_FALLBACK);
    if (opt) { sel.value = opt.value; fireChange(sel); }
  }

  async function humanTypeWord(inputEl, word) {
    pointerTap(inputEl);
    setNativeValue(inputEl, '');
    fireInput(inputEl); fireChange(inputEl);

    // type each char: keydown -> (mutate value) -> keypress -> input -> keyup
    for (const ch of word) {
      dispatchKey(inputEl, 'keydown', ch, ch.match(/[a-z]/i) ? `Key${ch.toUpperCase()}` : 'Digit');
      setNativeValue(inputEl, inputEl.value + ch);
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      dispatchKey(inputEl, 'keypress', ch, ch.match(/[a-z]/i) ? `Key${ch.toUpperCase()}` : 'Digit');
      fireInput(inputEl, ch);
      dispatchKey(inputEl, 'keyup', ch, ch.match(/[a-z]/i) ? `Key${ch.toUpperCase()}` : 'Digit');
      await sleep(rint(TYPE_MIN, TYPE_MAX));
    }

    // extra keyup on last char (MV often debounces on keyup)
    const last = word.slice(-1) || '';
    if (last) {
      await sleep(60);
      dispatchKey(inputEl, 'keyup', last, last.match(/[a-z]/i) ? `Key${last.toUpperCase()}` : 'Digit');
    }
  }

  async function selectFirstSuggestion(inputEl) {
    const first = visibleSuggestions()[0];
    if (first) {
      first.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
      first.click();
      first.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
      await sleep(SELECT_SETTLE_MS);
      return true;
    }
    return false;
  }

  async function addTags(tags) {
    if (!tags?.length) return;
    const input = await waitFor('#input-new-custom-tag-filter');
    let addedCount = document.querySelectorAll('.multi-dropdown-list input[name="tags[]"]').length;

    for (const tag of tags) {
      if (addedCount >= 10) break;

      await humanTypeWord(input, tag);

      // wait for the server dropdown to appear (keyup-driven)
      let t0 = performance.now();
      while (performance.now() - t0 < SUGGESTION_TIMEOUT_MS) {
        if (visibleSuggestions().length) break;
        await sleep(60);
      }
      await sleep(SERVER_SETTLE_MS);

      // click first suggestion (mirrors your manual path)
      let ok = await selectFirstSuggestion(input);

      // if no suggestions, nudge: blur/focus + re-keyup last char, then try once more
      if (!ok) {
        input.blur();
        await sleep(120);
        pointerTap(input);
        const val = input.value || '';
        const last = val.slice(-1) || ' ';
        dispatchKey(input, 'keyup', last, last.match(/[a-z]/i) ? `Key${last.toUpperCase()}` : 'Space');
        await sleep(350);
        ok = await selectFirstSuggestion(input);
      }

      // verify increase
      const now = document.querySelectorAll('.multi-dropdown-list input[name="tags[]"]').length;
      if (now === addedCount) {
        // hard retry once more
        await sleep(200);
        await selectFirstSuggestion(input);
      }
      addedCount = document.querySelectorAll('.multi-dropdown-list input[name="tags[]"]').length;

      // clear field
      setNativeValue(input, '');
      fireInput(input); fireChange(input);
      await sleep(140);
    }
  }

  async function setBundleNotIncluded() {
    const radio = document.querySelector('#membership3');
    if (radio && !radio.checked) radio.click();
  }

  async function run() {
    try { await setCoPerformerNo(); }        catch(e){ console.warn('co-performer:', e); }
    try { await setPrice(); }                 catch(e){ console.warn('price:', e); }
    try { await setLaunchTime(); }            catch(e){ console.warn('time:', e); }
    try { await setBundleNotIncluded(); }     catch(e){ console.warn('bundle:', e); }
    try { await addTags(TAGS); }              catch(e){ console.warn('tags:', e); }
    console.log('[MV Autofill] done');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }

  // Manual refill hotkey (tags only): Alt+T
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 't') addTags(TAGS);
  });
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] manyvids-autofill.js failed:", error);
});
