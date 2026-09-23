"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
for (const variant of [
  "owned",
  "hidden-timezone-note",
  "hidden-wrong-zone",
  "delayed-time-menu",
  "delayed-time-control",
  "time-menu-noop",
  "next-month",
  "wrong-month-navigation",
  "wrong-owner",
  "wrong-zone",
  "readback-failed",
  "duplicate-certification",
  "checkbox-noop",
  "already-checked",
  "thumbnail",
  "thumbnail-no-ack",
  "paid",
  "paid-stale-label",
  "unconfirmed",
]) {
  test("Pornhub UTC scheduling and certifications: " + variant, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
 <v-upload-video-details form-id="owned-upload"><form class="video-details-form">
 <div data-error="videoType" class="dropdownElement"><div class="selectedValue">Free To View</div><div class="c-drop-wrapper__list" hidden><div class="c-drop-wrapper__option">Pay To View</div></div></div><input name="p2vPrice" hidden><p id="p2vNotice" hidden>This video will be pay to view on Fancentro.</p>
 <input name="title"><input name="tags"><input name="category"><div class="dropdownElement" data-error="orientation"></div>
 <div data-error="videoPublishedDate"><div class="selectedValue">Publish Now</div><div data-key="date">Schedule date</div></div>
 <input type="checkbox" name="promotion"><input type="checkbox" name="reaction">
 <div class="custom-thumbnails pcView"><input class="uploadFile" type="file"><p class="thumbSuccess" hidden>Custom thumbnail added</p></div>
 <div id="termsWrapper"><v-checkbox id="selectAll"><input type="checkbox" id="selectAll"><label><span class="termsTitle">SELECT ALL AND CERTIFY.</span></label><div class="nested-checkboxes">
 ${["certifyDocumentationAndConsent", "certifyNoViolations", "acknowledgeReviewAndPublication"].map((id) => '<label for="' + id + '"><v-svg-icon name="checkMark" style="display:none">checked</v-svg-icon>Declaration</label>').join("")}
 </div></v-checkbox></div><button type="button" id="submit">Submit for Review</button></form></v-upload-video-details>
 <schedule-date form-id="owned-upload" hidden><button class="dp-nav-btn">›</button><div class="dp-current">September 2026</div><div class="dp-day">25</div><div class="dp-date-info"><div class="dp-info-value"></div></div>
 <div class="dp-info"><div data-error="scheduleTime"><div class="c-drop-wrapper__selected selectedValue"></div><div class="c-drop-wrapper__list" hidden><div class="c-drop-wrapper__option">03:00:00 PM</div></div></div><div class="dp-info-note">All upload times are in UTC.</div><button class="dp-schedule-btn">Schedule</button></div></schedule-date>
 `);
      const result = await page.evaluate(
        async ({ variant, source }) => {
          const form = document.querySelector("form"),
            picker = document.querySelector("schedule-date"),
            group = form.querySelector("v-checkbox");
          let submitted = 0,
            accepted = 0;
          let inspectedMode = "";
          let typeChoices = 0;
          const attached = [];
          const typeHost = form.querySelector('[data-error="videoType"]');
          typeHost.querySelector(".selectedValue").onclick = () =>
            (typeHost.querySelector(".c-drop-wrapper__list").hidden = false);
          typeHost.querySelector(".c-drop-wrapper__option").onclick = () => {
            typeChoices++;
            if (variant !== "paid-stale-label" || typeChoices > 1)
              typeHost.querySelector(".selectedValue").textContent =
                "Pay To View";
            typeHost.querySelector(".c-drop-wrapper__list").hidden = true;
            form.querySelector('[name="p2vPrice"]').hidden = false;
            form.querySelector("#p2vNotice").hidden = false;
            form.querySelector('[name="title"]').value = "";
          };
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
          if (
            variant.startsWith("hidden-") ||
            variant === "delayed-time-control"
          ) {
            picker.querySelector(".dp-info").style.visibility = "hidden";
            picker.querySelector(".dp-info").style.opacity = "0";
          }
          if (["wrong-zone", "hidden-wrong-zone"].includes(variant))
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
            setTimeout(
              () => {
                picker.querySelector(".dp-info-value").textContent =
                  "25 September, 2026";
                picker.querySelector(".dp-info").style.visibility = "visible";
                picker.querySelector(".dp-info").style.opacity = "1";
              },
              variant === "delayed-time-control" ? 40 : 0,
            );
          };
          const timeList = picker.querySelector(".c-drop-wrapper__list");
          picker.querySelector(".c-drop-wrapper__selected").onclick = () => {
            if (variant !== "time-menu-noop")
              setTimeout(
                () => (timeList.hidden = false),
                variant === "delayed-time-menu" ? 30 : 0,
              );
          };
          picker.querySelector(".c-drop-wrapper__option").onclick = () => {
            picker.querySelector(".c-drop-wrapper__selected").textContent =
              "03:00:00 PM";
            timeList.hidden = true;
          };
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
              inspectPreset: (_name, _preset, options) => {
                inspectedMode = options.mode;
                return {};
              },
              applyPreset: async () => ({ status: "success" }),
            },
          };
          (0, eval)(source);
          const outcome = await CreatorUploadPlatformAdapters.runPornhub({
            signal: AbortSignal.timeout(
              variant === "paid-stale-label" ? 5000 : 1200,
            ),
            draft: {
              title: "Neutral test",
              scheduledIso: "2026-09-25T15:00:00Z",
              publishMode: "manual",
              pornhubThumbnail: variant.startsWith("thumbnail"),
              pornhubMode: variant.startsWith("paid") ? "paid" : "free",
              pornhubCertificationsConfirmed: variant !== "unconfirmed",
              profiles: { manyvidsAutofill: { price: "19.99" } },
            },
            attachFile: async (role) => {
              attached.push(role);
              if (role !== "thumbnail") return { name: "neutral-full.mp4" };
              const input = form.querySelector(".custom-thumbnails input");
              const transfer = new DataTransfer();
              transfer.items.add(
                new File(["neutral image"], "neutral-thumbnail-valid.png", {
                  type: "image/png",
                }),
              );
              input.files = transfer.files;
              if (variant !== "thumbnail-no-ack")
                form.querySelector(".thumbSuccess").hidden = false;
              return { name: "neutral-thumbnail-valid.png" };
            },
          }).catch((e) => ({ status: "failed", error: e.message }));
          return {
            outcome,
            submitted,
            accepted,
            unrelated: Array.from(
              form.querySelectorAll("[name=promotion],[name=reaction]"),
            ).some((e) => e.checked),
            checked: group.querySelector("input").checked,
            price: form.querySelector('[name="p2vPrice"]').value,
            title: form.querySelector('[name="title"]').value,
            inspectedMode,
            typeChoices,
            attached,
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
      if (
        [
          "owned",
          "hidden-timezone-note",
          "delayed-time-menu",
          "delayed-time-control",
          "already-checked",
          "next-month",
          "thumbnail",
          "paid",
          "paid-stale-label",
          "unconfirmed",
        ].includes(variant)
      ) {
        assert.equal(
          result.outcome.status,
          "manual-submit-required",
          result.outcome.error,
        );
        assert.deepEqual(
          result.outcome.manualFields,
          variant === "thumbnail"
            ? ["final Submit"]
            : variant.startsWith("paid")
              ? ["final Submit"]
              : variant === "unconfirmed"
                ? [
                    "custom thumbnail (optional)",
                    "site certifications",
                    "final Submit",
                  ]
                : ["custom thumbnail (optional)", "final Submit"],
        );
        assert.deepEqual(
          result.attached,
          variant === "thumbnail" ? ["pornhub", "thumbnail"] : ["pornhub"],
        );
        assert.equal(result.checked, variant !== "unconfirmed");
        assert.equal(
          result.accepted,
          ["already-checked", "unconfirmed"].includes(variant) ? 0 : 1,
        );
        if (variant.startsWith("paid")) {
          assert.equal(result.price, "19.99");
          assert.equal(result.title, "Neutral test");
          assert.equal(result.inspectedMode, "paid");
          assert.equal(result.typeChoices, variant === "paid" ? 1 : 2);
        }
      } else {
        assert.equal(result.outcome.status, "failed");
        if (variant === "thumbnail-no-ack") {
          assert.match(
            result.outcome.error,
            /Upload cancelled|accepted custom thumbnail/i,
          );
          assert.deepEqual(result.attached, ["pornhub", "thumbnail"]);
          assert.equal(result.accepted, 0);
        }
        if (["wrong-zone", "hidden-wrong-zone"].includes(variant))
          assert.match(result.outcome.error, /timezone is unverified/);
        if (variant !== "checkbox-noop") assert.equal(result.accepted, 0);
      }
    } finally {
      await browser.close();
    }
  });
}
