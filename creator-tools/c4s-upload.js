CreatorToolkit.runWhenEnabled("c4sUpload", async () => {
(() => {
  'use strict';

  // ==================== CONFIG ====================
  const CONFIG = {
    // Description prefixes by type (requested change)
    descriptionPrefixesByType: {
      Teaser: 'NOTE: this is only the teaser and will be free in two weeks! supporter edition.\n\n',
      Cumshots: '–note: this episode only includes the cumshots/gameplay-cumshots of the full episode, i highly advise buying the full version first!–\n\n',
    },

    // These get overridden from file before the first tick()
    categoryText: "ANIMATION",
    relatedToAdd: ["3D", "ABS", "ANIME", "BLACKMAIL FANTASY", "ADULT DIAPER"],

    performerName: "Johnny Guides",

    // Default general keywords (used for 'Bisexual' unless you change below)
    keywords: [
      "Johnny Guides","Solo Male","Masturbation","Toys","Interactive","POV","JOI",
      "Edging","Orgasm Control","Ruined Orgasm","ASMR","Moaning","Gooning","Gaming",
      "Twink","Femboy"
    ],

    // Audience-specific keyword sets (adjust if you like).
    keywordsByAudience: {
      "Bisexual": [
        "Johnny Guides","Solo Male","Interactive","POV","JOI","Edging","Orgasm Control",
        "ASMR","Moaning","Gooning","Gaming","Twink","Femboy","Robot","Stud"
      ],
      "Gay": [
        "Whimpering","Male/Male","Twink","Jock","Daddy","Robot","Hentai","Femboy",
        "Cock Worship","JOI","Edging","Ruined Orgasm",
        "Cum Play","Mutual Masturbation","Johnny Guides"
      ],
      "Lesbian": [
        "Moaning","Gaming","Bondage","Girl/Girl","Tribbing","Scissoring",
        "Strap-On","Lesbian Kissing","Squirting","Hentai",
        "Edging","JOI","Femdom","Robot","Johnny Guides"
      ],
      "Straight": [
        "Femdom","Gaming","JOI",
        "Edging","Hentai","Ruined Orgasm","Robot","Assisted Masturbation",
        "Masturbation","Fleshlight","Premature Ejaculation","Cum Countdown",
        "ASMR", "Gooning", "Johnny Guides"
      ],
      "Transgender": [
        "Fucking Machines","Trans Woman","Trans Man","Trans Solo","Hentai","Bondage",
        "Trans Domination","Edging","Ruined Orgasm",
        "Gaming","Cock Worship","Robot",
        "Uncut","Interactive","Johnny Guides"
      ],
    },

    // Video Type → Price mapping
    videoTypePrices: {
      "Teaser": 2.99,
      "1080p": 14.99,
      "4k": 19.99,
      "Cumshots": 9.99,
    },

    sel: {
      // Description (textarea)
      description: '#description-input',
      // Keywords
      keywordsInput: '#keywords-input',

      // Category + related
      categoryComboId: 'mui-component-select-category_id',
      categoryMenuId:  'menu-category_id',
      categorySearchName: 'category_id',

      relatedComboId: 'mui-component-select-related_categories',
      relatedMenuId:  'menu-related_categories',
      relatedSearchName: 'related_categories',

      // Performer
      performersComboId: 'performers-dropdown-select',
      performersSearchId: 'search-performers-dropdown',
      performersRadioGroup: '[data-testid="edit-clip_radio-group_performers"]',
      performersRadioValue0: 'input[type="radio"][value="0"]',
      performersListItem: 'ul[role="listbox"][aria-labelledby="performers-dropdown-label"] li[role="menuitem"]',

      // Audience (Primary Audience select) — tolerant to missing search box
      orientationComboId: 'mui-component-select-orientation_id',
      orientationMenuId:  'menu-orientation_id',
      orientationSearchName: 'orientation_id',

      // Price field
      priceInputId: 'price-input',
    },

    timing: {
      // ⬅️ IMPORTANT: was 60_000; that killed keyword filling if you waited ~1 min before clicking Apply.
      observeMaxMs: 30 * 60_000, // 30 minutes
      waitStepMs: 50,
      defaultTimeoutMs: 5_000,
      keywordDelayMs: 350,
      relatedTypeDelayMs: 250,
      // periodic driver (handles “no more mutations” situations)
      tickIntervalMs: 500,
      keywordWaitMs: 15_000,
    },
  };

  // ==================== STATE ====================
  const State = {
    // original steps
    keywordsAdded: false, addingKeywords: false,
    pickingCategory: false, pickedCategory: false,
    pickingRelated: false,  pickedRelated: false,
    pickingPerformer: false, pickedPerformer: false,
    clickingAssign: false, assignClicked: false,
    overlaysClosed: false,

    // dialog-driven audience/type
    dialogShown: false,
    orientationConfirmed: false,
    selectedAudience: 'Bisexual',
    selectedKeywords: null,
    selectedVideoType: null,
    priceSet: false,

    // upload detection (to show dialog after a video is chosen)
    videoDetected: false,
  };

  // ==================== UTILS ====================
  const LOG = (...a) => console.log('[C4S Autofill]', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const up = (s) => (s || '').toUpperCase();

  async function waitFor(fn, timeout = CONFIG.timing.defaultTimeoutMs, step = CONFIG.timing.waitStepMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function setValue(el, val) {
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function openComboById(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }

  function currentMenu(menuId) {
    return document.getElementById(menuId) || document.querySelector('.MuiPopover-root .MuiMenu-paper');
  }

  async function closeMenu({ comboId, menuId }) {
    const isOpen = () => !!document.getElementById(menuId) || !!document.querySelector('.MuiPopover-root .MuiMenu-paper');
    if (!isOpen()) return true;

    const focused = document.activeElement;
    if (focused && typeof focused.blur === 'function') focused.blur();
    ['keydown', 'keyup'].forEach(type => {
      const ev = new KeyboardEvent(type, { key: 'Escape', code: 'Escape', which: 27, keyCode: 27, bubbles: true });
      (focused || document).dispatchEvent(ev);
      document.dispatchEvent(ev);
    });
    await waitFor(() => !isOpen(), 250);
    if (!isOpen()) return true;

    const combo = document.getElementById(comboId);
    combo?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    combo?.click();
    await waitFor(() => !isOpen(), 400);
    if (!isOpen()) return true;

    const container = document.getElementById(menuId) || document.querySelector('.MuiPopover-root.MuiMenu-root.MuiModal-root');
    const bd = container?.querySelector('.MuiBackdrop-root');
    if (bd) {
      bd.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      bd.click();
      await waitFor(() => !isOpen(), 400);
      if (!isOpen()) return true;
    }

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.click();
    await waitFor(() => !isOpen(), 300);

    return !isOpen();
  }

  async function closeAnyOverlay() {
    const isOpen = () =>
      !!(document.querySelector('.MuiPopover-root .MuiMenu-paper, .MuiAutocomplete-popper, .MuiMenu-paper') ||
         document.querySelector('[role="dialog"], .MuiDialog-root, .MuiModal-root'));

    for (let i = 0; i < 3 && isOpen(); i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', which: 27, keyCode: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', which: 27, keyCode: 27, bubbles: true }));
      await sleep(60);

      let btn = document.querySelector('button[aria-label*="close" i], button[title*="close" i]');
      if (!btn) {
        const icon = document.querySelector('svg[data-testid="CloseIcon"], svg[aria-label*="close" i]');
        btn = icon?.closest('button') || null;
      }
      btn?.click();
      await sleep(60);

      const backs = Array.from(document.querySelectorAll('.MuiBackdrop-root'));
      if (backs.length) {
        const top = backs[backs.length - 1];
        top.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        top.click();
      }

      await waitFor(() => !isOpen(), 600);
    }
    return !isOpen();
  }

  function findButtonByText(text) {
    const needle = text.trim().toLowerCase();
    for (const el of document.querySelectorAll('button[type="button"], button, [role="button"]')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === needle || t.includes(needle)) return el;
    }
    return null;
  }

  // ==================== CATEGORY FILE LOADER ====================
  function parseLines(txt) {
    return String(txt || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !/^#/.test(s));
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pickRelated(pool, n, exclude) {
    const p = pool.filter(x => up(x) !== up(exclude));
    const take = shuffle(p.slice()).slice(0, Math.min(n, p.length));
    while (take.length < n && pool.length) take.push(pool[(Math.random() * pool.length) | 0]);
    return take.slice(0, n);
  }
  async function overrideConfigFromFile() {
    const bundled = globalThis.CreatorToolkitC4SCategories;
    const lines = Array.isArray(bundled)
      ? bundled.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!lines.length) return;
    const main = lines[(Math.random() * lines.length) | 0];
    const related = pickRelated(lines, 5, main);
    CONFIG.categoryText = main;
    CONFIG.relatedToAdd = related;
    LOG('Chosen from bundled category list →', CONFIG.categoryText, '| related:', CONFIG.relatedToAdd.join(', '));
  }

  // ==================== PAGE HELPERS ====================
  function getActiveKeywords() {
    return State.selectedKeywords || CONFIG.keywords;
  }

  function isVideoChosen() {
    // robust signals: upload bar or title filled, or explicit “Upload complete”
    const titleEl = document.getElementById('title-input');
    const titleFilled = !!(titleEl && (titleEl.value || '').trim());
    const uploadBar = document.getElementById('uploading-bar');
    const uploadText = (uploadBar?.textContent || '');
    const hasUploadSignal = /Upload complete|Hooray!\s*Upload\s*Completed/i.test(uploadText) ||
                            !!document.querySelector('[aria-label="Upload complete"]');
    return titleFilled || hasUploadSignal;
  }

  function setPriceForType(type) {
    const price = CONFIG.videoTypePrices[type];
    const el = document.getElementById(CONFIG.sel.priceInputId);
    if (!el || price == null) return false;
    // force .99 just in case
    const asStr = (Math.floor(price) + 0.99).toFixed(2);
    setValue(el, asStr);
    State.priceSet = true;
    LOG(`Price set → ${asStr} for type ${type}`);
    return true;
  }

  // ==================== DESCRIPTION (NEW BEHAVIOR) ====================
  function ensureDescriptionForType() {
    const el = document.querySelector(CONFIG.sel.description);
    if (!el || el.disabled || el.readOnly) return false;
    const type = State.selectedVideoType;
    if (!type) return false;

    const prefix = CONFIG.descriptionPrefixesByType[type] || '';
    if (!prefix) return false; // 1080p / 4k → do not prefill anymore

    const curr = el.value || '';
    if (curr.startsWith(prefix)) return true;

    // Strip other known prefixes if present
    const otherPrefixes = Object.values(CONFIG.descriptionPrefixesByType).filter(p => p !== prefix);
    let stripped = curr;
    for (const other of otherPrefixes) {
      if (stripped.startsWith(other)) {
        stripped = stripped.slice(other.length).replace(/^\n+/, '');
        break;
      }
    }

    const remainder = stripped.trim().length ? '\n' + stripped : '';
    setValue(el, prefix + remainder);
    LOG('Description set for type:', type);
    return true;
  }

  // ==================== STEPS (original, with minimal edits) ====================
  async function addOneKeyword(input, kw) {
    input.focus();
    setValue(input, kw);
    const E = { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true };
    input.dispatchEvent(new KeyboardEvent('keydown', E));
    input.dispatchEvent(new KeyboardEvent('keyup', E));
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      if (!input.value) break;
      await sleep(50);
    }
    await sleep(CONFIG.timing.keywordDelayMs);
  }

  async function addKeywordsSequential() {
    if (State.keywordsAdded || State.addingKeywords) return false;
    if (!State.orientationConfirmed) return false; // wait for dialog

    // ⬅️ IMPORTANT: make this robust even if UI mounts late
    const input = await waitFor(
      () => {
        const el = document.querySelector(CONFIG.sel.keywordsInput);
        if (!el) return null;
        if (el.disabled || el.readOnly) return null;
        return el;
      },
      CONFIG.timing.keywordWaitMs
    );
    if (!input) return false;

    State.addingKeywords = true;
    try {
      const list = getActiveKeywords()
        .map(s => (s || '').trim().replace(/,+$/, ''))
        .filter(Boolean)
        .slice(0, 15);

      for (const kw of list) await addOneKeyword(input, kw);
      State.keywordsAdded = true;
      LOG('Keywords added.');
    } finally {
      State.addingKeywords = false;
    }
    return true;
  }

  // selectFromMenu: tolerates menus without a search box (orientation)
  async function selectFromMenu({ comboId, menuId, searchName, queryText, multi = false }) {
    const combo = document.getElementById(comboId);
    if (!combo) return false;
    if (up(combo.textContent || '').includes(up(queryText))) return true;

    openComboById(comboId);
    const menu = await waitFor(() => currentMenu(menuId));
    if (!menu) return false;

    const search = menu.querySelector(`input[placeholder*="search" i]${searchName ? `[name="${searchName}"]` : ''}`) ||
                   menu.querySelector('input[placeholder*="search" i]') ||
                   menu.querySelector('input[type="text"]') || null;

    if (search) {
      setValue(search, queryText);
      if (multi) await sleep(CONFIG.timing.relatedTypeDelayMs);
    }

    const item = await waitFor(() => {
      const items = Array.from(menu.querySelectorAll('li[role="menuitem"], li[role="option"]'));
      const exact = items.find(li => {
        const t = (li.textContent || '').trim();
        return up(t) === up(queryText) || up(t).startsWith(up(queryText) + '\n');
      });
      return exact || items.find(li => (li.textContent || '').trim()) || null;
    }, 3000);
    if (!item) return false;

    if (multi) {
      const cb = item.querySelector('input[type="checkbox"]');
      if (!(cb && cb.checked)) {
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        item.click();
        const ok = await waitFor(() => item.querySelector('input[type="checkbox"]')?.checked, 1000);
        return !!ok;
      }
      return true;
    } else {
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      item.click();
      const ok = await waitFor(() => up(combo.textContent || '').includes(up(queryText)), 2000);
      return !!ok;
    }
  }

  async function ensureCategory() {
    if (State.pickedCategory || State.pickingCategory) return;
    const hidden = document.querySelector('input[name="category_id"].MuiSelect-nativeInput');
    if (hidden && hidden.value && hidden.value !== '0') { State.pickedCategory = true; return; }

    State.pickingCategory = true;
    const ok = await selectFromMenu({
      comboId: CONFIG.sel.categoryComboId,
      menuId:  CONFIG.sel.categoryMenuId,
      searchName: CONFIG.sel.categorySearchName,
      queryText: CONFIG.categoryText,
      multi: false
    });
    State.pickedCategory = !!ok;
    State.pickingCategory = false;
    if (ok) LOG('Category set:', CONFIG.categoryText);
  }

  async function ensureRelated() {
    if (State.pickedRelated || State.pickingRelated) return;
    const combo = document.getElementById(CONFIG.sel.relatedComboId);
    if (!combo) return;

    const hasAll = () => {
      const txt = up(combo.textContent || '');
      return CONFIG.relatedToAdd.every(t => txt.includes(up(t)));
    };
    if (hasAll()) { State.pickedRelated = true; return; }

    State.pickingRelated = true;

    for (const term of CONFIG.relatedToAdd) {
      if (up(combo.textContent || '').includes(up(term))) continue;
      const ok = await selectFromMenu({
        comboId: CONFIG.sel.relatedComboId,
        menuId:  CONFIG.sel.relatedMenuId,
        searchName: CONFIG.sel.relatedSearchName,
        queryText: term,
        multi: true
      });
      if (!ok) continue;

      await closeMenu({ comboId: CONFIG.sel.relatedComboId, menuId: CONFIG.sel.relatedMenuId });
      await sleep(60);
    }

    State.pickedRelated = hasAll();
    State.pickingRelated = false;

    if (State.pickedRelated) {
      await closeMenu({ comboId: CONFIG.sel.relatedComboId, menuId: CONFIG.sel.relatedMenuId });
      LOG('Related ensured:', CONFIG.relatedToAdd.join(', '));
    }
  }

  function ensurePerformersRadio() {
    const group = document.querySelector(CONFIG.sel.performersRadioGroup);
    const radio = group?.querySelector(CONFIG.sel.performersRadioValue0);
    if (radio && !radio.checked) {
      radio.click();
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function ensurePerformer() {
    if (State.pickedPerformer || State.pickingPerformer) return;

    const combo = document.getElementById(CONFIG.sel.performersComboId);
    if (!combo) return;
    if (up(combo.textContent || '').includes(up(CONFIG.performerName))) { State.pickedPerformer = true; return; }

    State.pickingPerformer = true;

    openComboById(CONFIG.sel.performersComboId);

    const search = await waitFor(() => document.getElementById(CONFIG.sel.performersSearchId), 4000);
    if (!search) { State.pickingPerformer = false; return; }
    setValue(search, CONFIG.performerName);

    const firstItem = await waitFor(() => document.querySelector(CONFIG.sel.performersListItem), 5000);
    if (!firstItem) { State.pickingPerformer = false; return; }

    firstItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    firstItem.click();

    await waitFor(() => up(combo.textContent || '').includes(up(CONFIG.performerName)), 1000);
    State.pickedPerformer = up(combo.textContent || '').includes(up(CONFIG.performerName));

    await closeMenu({ comboId: CONFIG.sel.performersComboId, menuId: '' });

    State.pickingPerformer = false;
    if (State.pickedPerformer) LOG('Performer selected:', CONFIG.performerName);
  }

  async function ensureAssignPerformer() {
    if (State.assignClicked || State.clickingAssign) return;
    if (!State.pickedPerformer) return;

    State.clickingAssign = true;

    let btn = await waitFor(() => findButtonByText('Assign Performer'), 5000);
    if (!btn) { State.clickingAssign = false; return; }

    if (btn.disabled) {
      btn = await waitFor(() => {
        const b = findButtonByText('Assign Performer');
        return b && !b.disabled ? b : null;
      }, 4000) || btn;
    }

    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.click();

    const ok = await waitFor(() => {
      const b = findButtonByText('Assign Performer');
      return !b || b.disabled;
    }, 2000);

    State.assignClicked = !!ok;

    const closed = await closeAnyOverlay();
    State.overlaysClosed = closed;

    State.clickingAssign = false;
    if (ok) LOG('Assign Performer clicked.');
    if (closed) LOG('All overlays closed after assigning performer.');
  }

  // ==================== DIALOG (audience + video type) ====================
  function buildDialog() {
    if (State.dialogShown) return;
    State.dialogShown = true;

    const wrapper = document.createElement('div');
    wrapper.id = 'c4s-mini-dialog';
    wrapper.style.cssText = `
      position:fixed; z-index:999999; inset:auto 16px 16px auto;
      background:#1f1b27; color:#fff; border:1px solid #3a314b; border-radius:12px;
      box-shadow:0 12px 32px rgba(0,0,0,.4); width:360px; font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    `;
    wrapper.innerHTML = `
      <div style="padding:14px 16px; border-bottom:1px solid #312a3b">
        <div style="font-weight:700; font-size:14px;">Clip Setup</div>
        <div style="font-size:12px; opacity:.8; margin-top:4px;">Choose Primary Audience & Video Type (price/description will update).</div>
      </div>
      <div style="padding:14px 16px;">
        <div style="font-size:12px; margin-bottom:6px; opacity:.9;">Primary Audience</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px;">
          ${['Bisexual','Gay','Lesbian','Straight','Transgender'].map(a =>
            `<label style="display:flex;align-items:center;gap:6px;background:#2a2334;border:1px solid #3a314b;padding:6px 8px;border-radius:8px;cursor:pointer;">
               <input type="radio" name="c4s-audience" value="${a}" ${a==='Bisexual'?'checked':''} />
               <span style="font-size:12px">${a}</span>
             </label>`).join('')}
        </div>

        <div style="font-size:12px; margin-bottom:6px; opacity:.9;">Video Type</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">
          ${['Teaser','1080p','4k','Cumshots'].map((t) =>
            `<label style="display:flex;align-items:center;gap:6px;background:#2a2334;border:1px solid #3a314b;padding:6px 8px;border-radius:8px;cursor:pointer;">
               <input type="radio" name="c4s-vtype" value="${t}" ${t==='1080p'?'checked':''} />
               <span style="font-size:12px">${t}</span>
             </label>`).join('')}
        </div>
      </div>
      <div style="padding:12px 16px; display:flex; gap:8px; justify-content:flex-end; border-top:1px solid #312a3b;">
        <button id="c4s-mini-cancel" style="background:#2a2334;color:#ddd;border:1px solid #3a314b;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;">Cancel</button>
        <button id="c4s-mini-apply" style="background:#7b5cf5;color:#fff;border:1px solid #7b5cf5;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;">Apply</button>
      </div>
    `;

    document.body.appendChild(wrapper);

    wrapper.querySelector('#c4s-mini-cancel')?.addEventListener('click', () => {
      wrapper.remove();
    });

    wrapper.querySelector('#c4s-mini-apply')?.addEventListener('click', async () => {
      const aud = wrapper.querySelector('input[name="c4s-audience"]:checked')?.value || 'Bisexual';
      const vtype = wrapper.querySelector('input[name="c4s-vtype"]:checked')?.value || '1080p';

      State.selectedAudience = aud;
      State.selectedVideoType = vtype;

      // 1) Set Primary Audience select
      await selectFromMenu({
        comboId: CONFIG.sel.orientationComboId,
        menuId:  CONFIG.sel.orientationMenuId,
        searchName: CONFIG.sel.orientationSearchName,
        queryText: aud,
        multi: false
      });
      await closeMenu({ comboId: CONFIG.sel.orientationComboId, menuId: CONFIG.sel.orientationMenuId });

      // 2) Swap keywords for audience
      const pack = CONFIG.keywordsByAudience[aud] || CONFIG.keywords;
      State.selectedKeywords = pack.slice(0);
      State.orientationConfirmed = true;

      // 3) Set price by video type
      setPriceForType(vtype);

      // 4) Ensure description prefix based on type (Teaser/Cumshots only)
      ensureDescriptionForType();

      // ✅ CRITICAL FIX: add keywords *right here* too (not only via MutationObserver),
      // so it still works even if the page sat idle for a while.
      await addKeywordsSequential();

      wrapper.remove();
      LOG(`Dialog applied → Audience: ${aud} | Type: ${vtype}`);
    });
  }

  // ==================== ORCHESTRATION ====================
  function isAllDone() {
    return (
      State.keywordsAdded &&
      State.pickedCategory &&
      State.pickedRelated &&
      State.pickedPerformer &&
      State.assignClicked &&
      State.overlaysClosed
    );
  }

  function tick() {
    let alive = false;

    // Independent pieces can run ASAP
    ensureCategory();
    ensureRelated();
    ensurePerformersRadio();
    ensurePerformer();
    ensureAssignPerformer();

    // Detect chosen video; then show dialog once
    if (!State.videoDetected && isVideoChosen()) {
      State.videoDetected = true;
      buildDialog();
      alive = true;
    }

    // Keep enforcing description prefix after confirmation (in case user edits/clears)
    if (State.orientationConfirmed) {
      ensureDescriptionForType();
    }

    // Add keywords only after dialog confirmed
    addKeywordsSequential();

    if (
      !State.keywordsAdded ||
      State.pickingCategory || !State.pickedCategory ||
      State.pickingRelated  || !State.pickedRelated  ||
      State.pickingPerformer|| !State.pickedPerformer||
      State.clickingAssign  || !State.assignClicked  ||
      !State.overlaysClosed ||
      (!State.dialogShown && !State.videoDetected)
    ) alive = true;

    return alive;
  }

  (async () => {
    await overrideConfigFromFile();

    // kick off once
    tick();

    // ✅ Robust driver: MutationObserver + periodic tick (prevents “idle for 1 min” breakage)
    let stopped = false;
    const cleanup = (why) => {
      if (stopped) return;
      stopped = true;
      obs.disconnect();
      clearInterval(interval);
      clearTimeout(kill);
      LOG(why);
    };

    const drive = (why) => {
      if (stopped) return;
      const alive = tick();
      if (!alive && isAllDone()) cleanup('All tasks completed. Driver stopped.');
      // else keep running
    };

    const obs = new MutationObserver(() => drive('mutation'));
    obs.observe(document.documentElement, { childList: true, subtree: true });

    const interval = setInterval(() => drive('interval'), CONFIG.timing.tickIntervalMs);

    const kill = setTimeout(() => {
      cleanup(`Driver stopped (timeout ${CONFIG.timing.observeMaxMs}ms).`);
    }, CONFIG.timing.observeMaxMs);
  })();
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] c4s-upload.js failed:", error);
});
