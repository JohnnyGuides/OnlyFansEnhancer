CreatorToolkit.runWhenEnabled("onlyfansAutoFollow", async () => {
(function () {
  'use strict';

  const PANEL_ID = 'vm-of-autofollow-panel';
  const STATUS_ID = 'vm-of-autofollow-status';
  const ROW_SELECTOR = '.b-users__item.m-fans';

  let running = false;
  let stopRequested = false;
  let popupWatchTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

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
    return username || name || '';
  }

  function getRows({ visibleOnly = false } = {}) {
    let rows = [...document.querySelectorAll(ROW_SELECTOR)];
    if (visibleOnly) rows = rows.filter(isVisible);
    return rows;
  }

  function getButtonText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getFollowButton(row) {
    if (!row) return null;

    const candidates = [...row.querySelectorAll('.g-btn, [role="button"], button, a')];
    for (const el of candidates) {
      const text = getButtonText(el);
      if (text === 'Follow') return el;
    }

    return null;
  }

  function rowNeedsFollow(row) {
    return !!getFollowButton(row);
  }

  function fireClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.max(4, Math.min(rect.width / 2, rect.width - 4));
    const y = rect.top + Math.max(4, Math.min(rect.height / 2, rect.height - 4));

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }));
    }
  }

  function updateStatus(text) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = text;
  }

  function getSubscribeModal() {
    return document.querySelector('#ModalSubscribe.show, #ModalSubscribe[style*="display: block"]');
  }

  function getSubscribeModalCloseButton() {
    const modal = getSubscribeModal();
    if (!modal) return null;

    const buttons = [...modal.querySelectorAll('button, .g-btn')];
    return buttons.find((btn) => getButtonText(btn) === 'Close') || null;
  }

  async function dismissBlockingPopup() {
    const modal = getSubscribeModal();
    if (!modal) return false;

    const closeBtn = getSubscribeModalCloseButton();
    if (!closeBtn) return false;

    fireClick(closeBtn);
    await sleep(rand(180, 320));

    const stillOpen = !!getSubscribeModal();
    if (!stillOpen) {
      updateStatus('Closed blocking popup. Continuing…');
      return true;
    }

    // fallback
    closeBtn.click();
    await sleep(rand(180, 320));
    const gone = !getSubscribeModal();
    if (gone) updateStatus('Closed blocking popup. Continuing…');
    return gone;
  }

  async function ensureNoPopup() {
    // Sometimes body stays modal-open briefly after dismissal
    for (let i = 0; i < 3; i++) {
      const closed = await dismissBlockingPopup();
      if (!getSubscribeModal()) return true;
      if (!closed) await sleep(120);
    }
    return !getSubscribeModal();
  }

async function clickFollow(row) {
  if (!row || !rowNeedsFollow(row)) return false;

  const userId = getUserId(row);

  await ensureNoPopup();

  row.scrollIntoView({ block: 'center', behavior: 'instant' });
  await sleep(rand(80, 160));

  const btn = getFollowButton(row);
  if (!btn) return false;

  fireClick(btn);
  await sleep(rand(350, 650));

  // If the follow click triggered a subscribe popup, close it
  if (getSubscribeModal()) {
    await dismissBlockingPopup();
    await sleep(rand(150, 300));
  }

  // OF may rerender the row, so re-find it by user id if possible
  const matchingRow = [...document.querySelectorAll(ROW_SELECTOR)].find((r) => getUserId(r) === userId) || row;

  // Count as success if the row no longer has a visible "Follow" button
  if (!matchingRow.isConnected) return true;
  return !rowNeedsFollow(matchingRow);
}

  async function followVisible() {
    if (running) return;
    running = true;
    stopRequested = false;

    try {
      let followed = 0;
      await ensureNoPopup();

      const rows = getRows({ visibleOnly: true });
      for (const row of rows) {
        if (stopRequested) break;

        await ensureNoPopup();
        if (!rowNeedsFollow(row)) continue;

        const ok = await clickFollow(row);
        if (ok) followed += 1;
      }

      updateStatus(`Followed ${followed} visible user(s).`);
    } finally {
      running = false;
    }
  }

  async function autoFollowAll() {
    if (running) return;
    running = true;
    stopRequested = false;

    try {
      const touched = new Set();
      let totalFollowed = 0;
      let stablePasses = 0;
      let lastScrollY = -1;

      updateStatus('Running…');
      await ensureNoPopup();

      while (!stopRequested) {
        let followedThisPass = 0;

        const visibleRows = getRows({ visibleOnly: true });
        for (const row of visibleRows) {
          if (stopRequested) break;

          await ensureNoPopup();
          if (!rowNeedsFollow(row)) continue;

          const id = getUserId(row);
          if (id && touched.has(id)) continue;

          const ok = await clickFollow(row);
          if (id) touched.add(id);
          if (ok) {
            followedThisPass += 1;
            totalFollowed += 1;
          }
        }

        updateStatus(`Running… followed ${totalFollowed} so far`);

        await ensureNoPopup();

        const before = window.scrollY;
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: 'instant' });
        await sleep(rand(450, 700));

        await ensureNoPopup();

        const after = window.scrollY;
        const remainingVisibleFollowButtons = getRows({ visibleOnly: true }).filter(rowNeedsFollow).length;

        const noProgress =
          followedThisPass === 0 &&
          remainingVisibleFollowButtons === 0 &&
          (after === before || after === lastScrollY);

        if (noProgress) {
          stablePasses += 1;
        } else {
          stablePasses = 0;
        }

        lastScrollY = after;

        if (stablePasses >= 4) break;
      }

      updateStatus(
        stopRequested
          ? `Stopped. Followed ${totalFollowed} user(s).`
          : `Done. Followed ${totalFollowed} user(s).`
      );
    } finally {
      running = false;
    }
  }

  function stopRun() {
    stopRequested = true;
    updateStatus('Stopping…');
  }

  function makeButton(label, onClick, bg = '#00aff0') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = `
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      background: ${bg};
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
      bottom: 16px;
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
    title.textContent = 'Expired follow helper';
    title.style.cssText = 'font-weight: 700; margin-bottom: 8px;';

    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.textContent = 'Ready.';
    status.style.cssText = 'opacity: 0.9; margin-bottom: 10px; min-height: 34px;';

    const row1 = document.createElement('div');
    row1.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;';
    row1.append(
      makeButton('Follow visible', followVisible),
      makeButton('Auto-follow all', autoFollowAll)
    );

    const row2 = document.createElement('div');
    row2.style.cssText = 'display: grid; grid-template-columns: 1fr; gap: 8px;';
    row2.append(makeButton('Stop', stopRun, '#666'));

    const note = document.createElement('div');
    note.textContent = 'Auto-closes the blocking subscribe popup and keeps going.';
    note.style.cssText = 'margin-top: 10px; opacity: 0.7; font-size: 12px;';

    panel.append(title, status, row1, row2, note);
    document.body.appendChild(panel);
  }

  function startPopupWatcher() {
    if (popupWatchTimer) return;
    popupWatchTimer = window.setInterval(() => {
      if (!running) return;
      if (getSubscribeModal()) {
        dismissBlockingPopup().catch(() => {});
      }
    }, 500);
  }

  function init() {
    mountPanel();
    updateStatus('Ready.');
    startPopupWatcher();
  }

  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) mountPanel();
    if (running && getSubscribeModal()) {
      dismissBlockingPopup().catch(() => {});
    }
  });

  init();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] onlyfans-auto-follow.js failed:", error);
});
