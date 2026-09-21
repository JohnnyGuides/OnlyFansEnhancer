"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
for (const variant of [
  "owned",
  "next-month",
  "wrong-month-navigation",
  "wrong-owner",
  "wrong-zone",
  "readback-failed",
  "duplicate-certification",
  "checkbox-noop",
  "already-checked",
]) {
  test("Pornhub UTC scheduling and certifications: " + variant, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
 <v-upload-video-details form-id="owned-upload"><form class="video-details-form">
 <input name="title"><input name="tags"><input name="category"><div class="dropdownElement" data-error="orientation"></div>
 <div data-error="videoPublishedDate"><div class="selectedValue">Publish Now</div><div data-key="date">Schedule date</div></div>
 <input type="checkbox" name="promotion"><input type="checkbox" name="reaction">
 <div id="termsWrapper"><v-checkbox id="selectAll"><input type="checkbox" id="selectAll"><label><span class="termsTitle">SELECT ALL AND CERTIFY.</span></label><div class="nested-checkboxes">
 ${["certifyDocumentationAndConsent", "certifyNoViolations", "acknowledgeReviewAndPublication"].map((id) => '<label for="' + id + '"><v-svg-icon name="checkMark" style="display:none">checked</v-svg-icon>Declaration</label>').join("")}
 </div></v-checkbox></div><button type="button" id="submit">Submit for Review</button></form></v-upload-video-details>
 <schedule-date form-id="owned-upload" hidden><button class="dp-nav-btn">›</button><div class="dp-current">September 2026</div><div class="dp-day">25</div><div class="dp-date-info"><div class="dp-info-value"></div></div>
 <div data-error="scheduleTime"><div class="selectedValue"></div><div class="c-drop-wrapper__option">03:00:00 PM</div></div><div class="dp-info-note">All upload times are in UTC.</div><button class="dp-schedule-btn">Schedule</button></schedule-date>
 `);
      const result = await page.evaluate(
        async ({ variant, source }) => {
          const form = document.querySelector("form"),
            picker = document.querySelector("schedule-date"),
            group = form.querySelector("v-checkbox");
          let submitted = 0,
            accepted = 0;
          if (["next-month", "wrong-month-navigation"].includes(variant))
            picker.querySelector(".dp-current").textContent = "August 2026";
          picker.querySelector(".dp-nav-btn").onclick = () => {
            picker.querySelector(".dp-current").textContent =
              variant === "wrong-month-navigation"
                ? "October 2026"
                : "September 2026";
          };
          if (variant === "wrong-owner")
            picker.setAttribute("form-id", "other-upload");
          if (variant === "wrong-zone")
            picker.querySelector(".dp-info-note").textContent =
              "All upload times are local.";
          if (variant === "duplicate-certification")
            group
              .querySelector(".nested-checkboxes")
              .append(
                group.querySelector(".nested-checkboxes label").cloneNode(true),
              );
          function check() {
            group.querySelector("input").checked = true;
            group
              .querySelectorAll("v-svg-icon")
              .forEach((e) => (e.style.display = "inline"));
          }
          if (variant === "already-checked") check();
          form.querySelector("[data-key=date]").onclick = () =>
            (picker.hidden = false);
          picker.querySelector(".dp-day").onclick = (e) => {
            e.target.classList.add("dp-selected");
            picker.querySelector(".dp-info-value").textContent =
              "25 September, 2026";
          };
          picker.querySelector(".c-drop-wrapper__option").onclick = () =>
            (picker.querySelector(".selectedValue").textContent =
              "03:00:00 PM");
          picker.querySelector(".dp-schedule-btn").onclick = () => {
            picker.hidden = true;
            form.insertAdjacentHTML(
              "beforeend",
              '<input name="scheduleDatePaid" readonly>',
            );
            form.querySelector("[name=scheduleDatePaid]").value =
              variant === "readback-failed"
                ? '26 September, 2026, 03:00:00 PM "UTC"'
                : '25 September, 2026, 03:00:00 PM "UTC"';
          };
          group.querySelector(".termsTitle").closest("label").onclick = () => {
            accepted++;
            if (variant !== "checkbox-noop") check();
          };
          form.querySelector("#submit").onclick = () => submitted++;
          window.CreatorToolkit = { createBudget: () => ({}) };
          window.CreatorToolkitAdapters = {
            phUploader: {
              resolvePreset: () => ({ name: "Neutral", preset: {} }),
              inspectPreset: () => ({}),
              applyPreset: async () => ({ status: "success" }),
            },
          };
          (0, eval)(source);
          const outcome = await CreatorUploadPlatformAdapters.runPornhub({
            signal: AbortSignal.timeout(1200),
            draft: {
              title: "Neutral test",
              scheduledIso: "2026-09-25T15:00:00Z",
              publishMode: "manual",
            },
            attachFile: async () => {},
          }).catch((e) => ({ status: "failed", error: e.message }));
          return {
            outcome,
            submitted,
            accepted,
            unrelated: Array.from(
              form.querySelectorAll("[name=promotion],[name=reaction]"),
            ).some((e) => e.checked),
            checked: group.querySelector("input").checked,
          };
        },
        {
          variant,
          source: require("fs").readFileSync(
            path.resolve(
              __dirname,
              "../../extensions/personal/workflows/upload-platform-adapters.js",
            ),
            "utf8",
          ),
        },
      );
      assert.equal(result.submitted, 0);
      assert.equal(result.unrelated, false);
      if (["owned", "already-checked", "next-month"].includes(variant)) {
        assert.equal(
          result.outcome.status,
          "manual-submit-required",
          result.outcome.error,
        );
        assert.deepEqual(result.outcome.manualFields, [
          "custom thumbnail (optional)",
          "final Submit",
        ]);
        assert.equal(result.checked, true);
        assert.equal(result.accepted, variant === "already-checked" ? 0 : 1);
      } else {
        assert.equal(result.outcome.status, "failed");
        if (variant !== "checkbox-noop") assert.equal(result.accepted, 0);
      }
    } finally {
      await browser.close();
    }
  });
}
