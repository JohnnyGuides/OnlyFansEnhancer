CreatorToolkit.runWhenEnabled("onlyfansAutoSelect", async () => {
(function () {
  'use strict';

  const ROW_SELECTOR = '.b-selection-user';
  const UNSELECTED_SELECTOR = '.b-selection-user:not(.selected)';
  const ADD_BUTTON_SELECTOR = '.b-row-selected__controls .g-btn';
  const PANEL_ID = 'vm-of-autoselect-panel';
  const STATUS_ID = 'vm-of-autoselect-status';

  let stopRequested = false;
  let running = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  }

  function getUserId(row) {
    const username = row.querySelector('.g-user-username')?.textContent?.trim();
    const name = row.querySelector('.g-user-name')?.textContent?.trim();
    return username || name || row.getAttribute('aria-label') || '';
  }

  function getRows({ visibleOnly = false, unselectedOnly = false } = {}) {
    let rows = [...document.querySelectorAll(unselectedOnly ? UNSELECTED_SELECTOR : ROW_SELECTOR)];
    if (visibleOnly) rows = rows.filter(isVisible);
    return rows;
  }

  function getAddButton() {
    return document.querySelector(ADD_BUTTON_SELECTOR);
  }

  function updateStatus(text) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = text;
  }

  function fireClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4));
    const y = rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4));

    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of events) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }));
    }
  }

  async function clickRow(row) {
    if (!row || row.classList.contains('selected')) return false;
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(40);
    fireClick(row);
    await sleep(80);

    // Fallback: click the checkbox area if row click did not stick
    if (!row.classList.contains('selected')) {
      const checkbox = row.querySelector('.checkbox-item__inside') || row.querySelector('.checkbox-item');
      if (checkbox) {
        fireClick(checkbox);
        await sleep(80);
      }
    }

    return row.classList.contains('selected');
  }

  async function selectVisible() {
    if (running) return;
    running = true;
    stopRequested = false;

    try {
      const rows = getRows({ visibleOnly: true, unselectedOnly: true });
      let clicked = 0;

      for (const row of rows) {
        if (stopRequested) break;
        const ok = await clickRow(row);
        if (ok) clicked += 1;
      }

      updateStatus(`Selected ${clicked} visible row(s).`);
    } finally {
      running = false;
    }
  }

  async function autoSelectAll() {
    if (running) return;
    running = true;
    stopRequested = false;

    try {
      const seen = new Set();
      let totalSelectedByScript = 0;
      let stablePasses = 0;
      let lastScrollY = -1;

      updateStatus('Running…');

      while (!stopRequested) {
        let clickedThisPass = 0;

        const rows = getRows({ visibleOnly: true, unselectedOnly: true });
        for (const row of rows) {
          if (stopRequested) break;

          const id = getUserId(row);
          // Still try again if not selected, but avoid hammering the same visible node too much
          if (id && seen.has(id)) continue;

          const ok = await clickRow(row);
          if (id) seen.add(id);
          if (ok) {
            clickedThisPass += 1;
            totalSelectedByScript += 1;
          }
        }

        updateStatus(`Running… selected ${totalSelectedByScript} so far`);

        // Scroll down to load more
        const before = window.scrollY;
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: 'instant' });
        await sleep(450);

        const after = window.scrollY;
        const remainingVisible = getRows({ visibleOnly: true, unselectedOnly: true }).length;

        const noProgress =
          clickedThisPass === 0 &&
          remainingVisible === 0 &&
          (after === before || after === lastScrollY);

        if (noProgress) {
          stablePasses += 1;
        } else {
          stablePasses = 0;
        }

        lastScrollY = after;

        // Need a few stable passes because the scroller is virtualized / lazy-loaded
        if (stablePasses >= 4) break;
      }

      updateStatus(
        stopRequested
          ? `Stopped. Selected ${totalSelectedByScript} row(s).`
          : `Done. Selected ${totalSelectedByScript} row(s). Review, then click Add.`
      );
    } finally {
      running = false;
    }
  }

  function stopRun() {
    stopRequested = true;
    updateStatus('Stopping…');
  }

  function clickAdd() {
    const btn = getAddButton();
    if (!btn) {
      updateStatus('Add button not found.');
      return;
    }
    fireClick(btn);
    updateStatus('Clicked Add.');
  }

  function makeButton(label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.type = 'button';
    btn.style.cssText = `
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      background: #00aff0;
      color: white;
      font: 600 13px/1.2 system-ui, sans-serif;
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 244px;
      z-index: 999999;
      width: 260px;
      background: rgba(20,20,20,0.96);
      color: white;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      padding: 12px;
      font: 13px/1.35 system-ui, sans-serif;
    `;

    const title = document.createElement('div');
    title.textContent = 'Expired list helper';
    title.style.cssText = 'font-weight: 700; margin-bottom: 8px;';

    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.textContent = 'Ready.';
    status.style.cssText = 'opacity: 0.9; margin-bottom: 10px; min-height: 34px;';

    const row1 = document.createElement('div');
    row1.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;';
    row1.append(
      makeButton('Select visible', selectVisible),
      makeButton('Auto-select all', autoSelectAll)
    );

    const row2 = document.createElement('div');
    row2.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;';
    const stopBtn = makeButton('Stop', stopRun);
    stopBtn.style.background = '#666';
    const addBtn = makeButton('Click Add', clickAdd);
    addBtn.style.background = '#1fa971';
    row2.append(stopBtn, addBtn);

    const note = document.createElement('div');
    note.textContent = 'Run on the “Add users to list” page. Review the count before clicking Add.';
    note.style.cssText = 'margin-top: 10px; opacity: 0.7; font-size: 12px;';

    panel.append(title, status, row1, row2, note);
    document.body.appendChild(panel);
  }

  function init() {
    mountPanel();
    updateStatus('Ready.');
  }

  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) mountPanel();
  });

  init();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] onlyfans-auto-select.js failed:", error);
});
