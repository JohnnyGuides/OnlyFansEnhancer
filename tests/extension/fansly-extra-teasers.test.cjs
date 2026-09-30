const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

// Current Fansly layout: every media file opens its own upload modal whose
// card offers Add Free Preview. Each extra video gets its own teaser role.
test("Fansly current layout attaches a distinct free preview per extra video and none for images", async () => {
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
        function openMedia(mediaName, review=false, previewName='') {
          const modal = document.createElement('app-account-media-upload');
          modal.className = 'active-modal';
          modal.innerHTML = '<app-account-media-template><input type="file" hidden><xd-localization-string>Add Free Preview</xd-localization-string><div class="dropdown-item" hidden>Upload New</div></app-account-media-template><div class="transparent-dropdown"><div class="btn">Load Preset</div><div class="dropdown-list" hidden><div class="dropdown-item">Default</div></div></div><div class="permission-settings-container"></div><div class="btn">Upload</div><div class="btn">Cancel</div><input type="file" multiple hidden>';
          const card = modal.querySelector('app-account-media-template');
          let attachedPreview = previewName;
          function permissions() { modal.querySelector('.permission-settings-container').innerHTML = '<div class="flex-col"><div class="permission-flag">Subscribed</div></div>'; }
          function preview() { card.insertAdjacentHTML('beforeend','<div class="preview-image">Preview</div>'); }
          if (review) { permissions(); if (previewName) preview(); }
          card.querySelector('xd-localization-string').onclick = () => card.querySelector('.dropdown-item').hidden = false;
          card.querySelector('.dropdown-item').onclick = () => { card.querySelector('.dropdown-item').hidden = true; card.querySelector('input').click(); };
          card.querySelector('input').onchange = event => { attachedPreview = event.target.files[0].name; actions.push('preview:' + mediaName + '<-' + attachedPreview); preview(); event.target.value = ''; };
          const load = modal.querySelector('.transparent-dropdown .btn');
          load.onclick = () => modal.querySelector('.dropdown-list').hidden = false;
          modal.querySelectorAll('.dropdown-list .dropdown-item').forEach(item => item.onclick = () => { permissions(); modal.querySelector('.dropdown-list').hidden = true; });
          [...modal.querySelectorAll('.btn')].find(n=>n.textContent==='Cancel').onclick = () => modal.remove();
          [...modal.querySelectorAll('.btn')].find(n=>n.textContent==='Upload').onclick = () => {
            actions.push('upload:' + mediaName);
            const attached = document.createElement('app-account-media-template');
            attached.dataset.media = mediaName;
            attached.dataset.preview = attachedPreview;
            attached.textContent = 'Verifying'; composer.append(attached); modal.remove();
            setTimeout(()=>{attached.textContent=''; const edit=document.createElement('xd-localization-string'); edit.textContent='Edit Permissions'; edit.onclick=()=>openMedia(mediaName, true, attachedPreview); attached.append(edit);},80);
          };
          document.body.append(modal);
        }
        composer.querySelector('input').onchange = event => { const name = event.target.files[0].name; actions.push('file:' + name); event.target.value=''; setTimeout(()=>openMedia(name),50); };
        composer.querySelector('.icon-stack').onclick=()=>schedule.hidden=false;
        schedule.querySelector('td').onclick=event=>event.target.classList.add('is-selected');
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
    const outcome = await page.evaluate(async () => {
      const proof = (name) => ({
        name,
        size: 4,
        lastModified: 1000,
        type: "video/mp4",
      });
      const requested = [];
      const result = await CreatorUploadPlatformAdapters.runFansly({
        draft: {
          hasTeaser: true,
          fullFilename: "full.mp4",
          mediaFiles: [
            { role: "media1", name: "media1.mp4", kind: "video" },
            { role: "media2", name: "media2.mp4", kind: "video" },
            { role: "media3", name: "media3.png", kind: "image" },
          ],
          fileProof: {
            full: proof("full.mp4"),
            teaser: proof("teaser.mp4"),
            media1: proof("media1.mp4"),
            media2: proof("media2.mp4"),
            media3: proof("media3.png"),
            media1Teaser: proof("media1Teaser.mp4"),
            media2Teaser: proof("media2Teaser.mp4"),
          },
          fanslyPresetSelection: "first",
          scheduledIso: "2026-09-18T15:00:00Z",
          timeZone: "Europe/Zurich",
          profiles: { fanslyPrefill: {} },
        },
        attachFile: async (role, selector) => {
          requested.push(role);
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          const image = role === "media3";
          transfer.items.add(
            new File(["test"], role + (image ? ".png" : ".mp4"), {
              type: image ? "image/png" : "video/mp4",
            }),
          );
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
      }).catch((error) => ({ status: "failed", error: error.message }));
      return {
        result,
        requested,
        actions,
        attached: [
          ...document.querySelectorAll(
            "app-post-creation > app-account-media-template",
          ),
        ].map((card) => [card.dataset.media, card.dataset.preview]),
      };
    });
    assert.equal(
      outcome.result.status,
      "manual-submit-required",
      outcome.result.error,
    );
    assert.deepEqual(outcome.requested, [
      "full",
      "teaser",
      "media1",
      "media1Teaser",
      "media2",
      "media2Teaser",
      "media3",
    ]);
    assert.deepEqual(outcome.attached, [
      ["full.mp4", "teaser.mp4"],
      ["media1.mp4", "media1Teaser.mp4"],
      ["media2.mp4", "media2Teaser.mp4"],
      ["media3.png", ""],
    ]);
    assert.equal(outcome.actions.includes("PUBLICATION"), false);
  } finally {
    await browser.close();
  }
});
