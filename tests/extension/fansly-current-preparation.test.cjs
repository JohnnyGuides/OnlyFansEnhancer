const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

for (const variant of [false, true, "calendar-drift"]) {
  const publicAlternative = variant === true;
  test(`Fansly current modal access alternatives variant=${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
      <app-post-creation>
        <div class="default-dropdown"><div class="dropdown-title">Media</div><div class="dropdown-item">Upload New</div></div>
        <input type="file" multiple hidden><textarea></textarea>
        <div class="icon-stack"><i class="fa-clock"></i><i class="fa-calendar"></i></div>
        <div class="new-post-btn">Post</div>
      </app-post-creation>
      <app-post-schedule-modal hidden><div class="modal"><div class="modal-content">
        <div class="timezone">Time Zone</div><div>Europe/Zurich</div>
        <div class="header"><div class="month">September 2026</div></div>
        <table><tr><td class="current-month-day">18</td></tr></table>
        <select data-time="hour">${Array.from({ length: 24 }, (_, i) => `<option>${String(i).padStart(2, "0")}</option>`).join("")}</select>
        <select data-time="minute"><option>00</option><option>30</option></select>
        <select><option>AM</option><option>24H</option></select>
        </div><div class="modal-footer"><div class="btn confirm-btn">Confirm Date</div></div>
      </div></app-post-schedule-modal>
      <script>
        window.actions = [];
        const composer = document.querySelector('app-post-creation');
        composer.querySelector('.dropdown-item').onclick = () => composer.querySelector('input[type=file]').click();
        const schedule = document.querySelector('app-post-schedule-modal');
        function openMedia(review=false) {
          const modal = document.createElement('app-account-media-upload');
          modal.className = 'active-modal';
          modal.innerHTML = '<app-account-media-template><input type="file" hidden><xd-localization-string>Add Free Preview</xd-localization-string><div class="dropdown-item" hidden>Upload New</div></app-account-media-template><div class="transparent-dropdown"><div class="btn">Load Preset</div><div class="dropdown-list" hidden><div class="dropdown-item">Default</div><div class="dropdown-item">Other</div></div></div><div class="permission-settings-container"></div><div class="btn">Upload</div><div class="btn">Cancel</div><input type="file" multiple hidden>';
          const card = modal.querySelector('app-account-media-template');
          function permissions() { modal.querySelector('.permission-settings-container').innerHTML = '<div class="flex-col"><div class="permission-flag">Subscribed</div></div>' + (${publicAlternative} ? '<div class="flex-col"><div class="permission-flag new-flag">New permission</div></div>' : ''); }
          function preview() { card.insertAdjacentHTML('beforeend','<div class="preview-image">Preview</div>'); }
          if (review) { permissions(); preview(); }
          card.querySelector('xd-localization-string').onclick = () => card.querySelector('.dropdown-item').hidden = false;
          card.querySelector('.dropdown-item').onclick = () => { card.querySelector('.dropdown-item').hidden = true; card.querySelector('input').click(); };
          card.querySelector('input').onchange = event => { actions.push('teaser'); preview(); event.target.value = ''; };
          const load = modal.querySelector('.transparent-dropdown .btn');
          load.onclick = () => modal.querySelector('.dropdown-list').hidden = false;
          modal.querySelectorAll('.dropdown-list .dropdown-item').forEach(item => item.onclick = () => { actions.push('preset:' + item.textContent); permissions(); modal.querySelector('.dropdown-list').hidden = true; });
          [...modal.querySelectorAll('.btn')].find(n=>n.textContent==='Cancel').onclick = () => modal.remove();
          [...modal.querySelectorAll('.btn')].find(n=>n.textContent==='Upload').onclick = () => {
            actions.push('upload');
            const attached = document.createElement('app-account-media-template');
            attached.textContent = 'Verifying'; composer.append(attached); modal.remove();
            setTimeout(()=>{attached.textContent=''; const edit=document.createElement('xd-localization-string'); edit.textContent='Edit Permissions'; edit.onclick=()=>openMedia(true); composer.append(edit);},80);
          };
          document.body.append(modal);
        }
        composer.querySelector('input').onchange = event => { actions.push('full'); event.target.value=''; setTimeout(()=>openMedia(),50); };
        composer.querySelector('.icon-stack').onclick=()=>schedule.hidden=false;
        schedule.querySelector('td').onclick=event=>event.target.classList.add('is-selected');
        if (${variant === "calendar-drift"}) schedule.querySelector('[data-time=minute]').onchange=()=>{schedule.querySelector('.month').textContent='October 2026';};
        schedule.querySelector('.confirm-btn').onclick=()=>{schedule.hidden=true; composer.querySelector('.new-post-btn').textContent='Schedule';};
        composer.querySelector('.new-post-btn').onclick=()=>actions.push('PUBLICATION');
        window.CreatorToolkit = { createBudget: () => ({}) };
        window.CreatorToolkitAdapters = { fanslyPrefill: { inspectComposer:()=>({}), applyPlan:async()=>({status:'success'}) } };
      </script>
    `);
      await page.addScriptTag({
        path: path.resolve(
          __dirname,
          "../../extensions/personal/workflows/upload-platform-adapters.js",
        ),
      });
      const result = await page.evaluate(async () => {
        const result = await CreatorUploadPlatformAdapters.runFansly({
          draft: {
            hasTeaser: true,
            fanslyPresetSelection: "first",
            scheduledIso: "2026-09-18T15:00:00Z",
            timeZone: "Europe/Zurich",
            profiles: { fanslyPrefill: {} },
          },
          attachFile: async (role, selector) => {
            const input = document.querySelector(selector);
            const transfer = new DataTransfer();
            transfer.items.add(
              new File(["test"], role + ".mp4", { type: "video/mp4" }),
            );
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return {
          result,
          actions,
          modals: document.querySelectorAll("app-account-media-upload").length,
          hour: document.querySelector('[data-time="hour"]').value,
        };
      });
      if (publicAlternative) {
        assert.equal(result.result.status, "failed");
        assert.match(result.result.error, /public access alternative/);
        assert.deepEqual(result.actions, ["full", "teaser", "preset:Default"]);
        return;
      }
      if (variant === "calendar-drift") {
        assert.equal(result.result.status, "failed");
        assert.match(result.result.error, /calendar date changed/);
        assert.equal(result.actions.includes("PUBLICATION"), false);
        return;
      }
      assert.equal(result.result.status, "manual-submit-required");
      assert.deepEqual(result.actions, [
        "full",
        "teaser",
        "preset:Default",
        "upload",
      ]);
      assert.equal(result.modals, 0);
      assert.equal(result.hour, "17");
    } finally {
      await browser.close();
    }
  });
}
