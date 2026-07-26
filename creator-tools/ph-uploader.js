CreatorToolkit.runWhenEnabled("phUploader", async () => {
(async function () {
  "use strict";

  // ---------------- utils ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => [...r.querySelectorAll(s)];
  const now = () => performance.now();
  const norm = (s) => (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");

  async function waitFor(sel, timeout = 20000) {
    const t0 = now();
    while (!qs(sel)) {
      if (now() - t0 > timeout) return null;
      await sleep(80);
    }
    return qs(sel);
  }

  async function waitForFn(fn, timeout = 12000, tick = 80) {
    const t0 = now();
    while (true) {
      const v = fn();
      if (v) return v;
      if (now() - t0 > timeout) return null;
      await sleep(tick);
    }
  }

  function fire(el, type, init) {
    let ev;
    if (type.startsWith("key")) ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    else if (type === "input") ev = new InputEvent(type, { bubbles: true, cancelable: true, ...init });
    else ev = new Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }

  function clickLikeUser(el) {
    if (!el) return;
    el.scrollIntoView?.({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = desc && desc.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  async function clearInput(input) {
    input.focus();
    clickLikeUser(input);
    setNativeValue(input, "");
    fire(input, "input", { data: "", inputType: "deleteContentBackward" });
    fire(input, "change");
    await sleep(60);
  }

  async function typeHuman(input, text, perChar = 28) {
    input.focus();
    clickLikeUser(input);

    for (const ch of text) {
      const keyCode = ch.charCodeAt(0) || 0;

      fire(input, "keydown", { key: ch, keyCode, which: keyCode });
      fire(input, "keypress", { key: ch, keyCode, which: keyCode });

      setNativeValue(input, (input.value || "") + ch);
      fire(input, "input", { data: ch, inputType: "insertText" });

      fire(input, "keyup", { key: ch, keyCode, which: keyCode });
      await sleep(perChar);
    }
    fire(input, "change");
  }

  // ---------------- stable autocomplete clicker ----------------
  function getUl(ulId) {
    return qs(`ul#${CSS.escape(ulId)}`);
  }

  function getListItemsByUlId(ulId) {
    const ul = getUl(ulId);
    if (!ul) return [];
    return qsa("li", ul).filter((li) => norm(li.textContent).length > 0);
  }

  function pickBestItem(items, token) {
    const t = norm(token);

    const exact = items.find((li) => norm(li.textContent) === t);
    if (exact) return exact;

    const contains = items.find((li) => norm(li.textContent).includes(t));
    if (contains) return contains;

    // if token doesn't exist, user asked: click first entry
    return items[0] || null;
  }

  async function waitForListAnyItems(ulId, timeout = 6000) {
    return await waitForFn(() => {
      const items = getListItemsByUlId(ulId);
      return items.length ? items : null;
    }, timeout, 80);
  }

  function listSignature(ulId) {
    const ul = getUl(ulId);
    if (!ul) return "";
    const txt = norm(ul.textContent);
    // short signature to detect a change; good enough
    return `${txt.slice(0, 80)}|${txt.slice(-80)}|len:${txt.length}`;
  }

  async function addTokenViaUlList({ input, token, ulId, settleMinMs = 450, listTimeoutMs = 6000 }) {
    const wrapper = input.closest(".c-input-container") || input.closest(".c-input-wrapper") || input.parentElement;
    if (wrapper) clickLikeUser(wrapper);
    await sleep(80);

    const beforeSig = listSignature(ulId);

    await clearInput(input);
    await typeHuman(input, token, 32);

    // give debounce/network a moment
    await sleep(settleMinMs);

    // Wait for dropdown list to populate (or change). If it doesn't, skip.
    const items = await waitForFn(() => {
      const ul = getUl(ulId);
      if (!ul) return null;

      const its = getListItemsByUlId(ulId);
      if (!its.length) return null;

      // Prefer list that changed after typing; but don't stall if it doesn't.
      const sig = listSignature(ulId);
      if (sig !== beforeSig) return its;

      // If unchanged but has items, still usable (some UIs reuse list container)
      return its;
    }, listTimeoutMs, 80);

    if (!items || !items.length) {
      console.warn(`[autofill] No suggestions for "${token}" in #${ulId} -> skipping`);
      return false;
    }

    const best = pickBestItem(items, token);
    if (!best) return false;

    clickLikeUser(best);

    // Fast settle (avoid the “~8s” feel)
    await sleep(160);
    return true;
  }

  // ---------------- orientation dropdown ----------------
  async function selectCustomDropdown(dataKey, visibleText) {
    const host = await waitFor(`custom-dropdown[data-key="${dataKey}"]`);
    if (!host) return false;

    const trigger = host.querySelector(".customSelectTrigger");
    clickLikeUser(trigger);
    await sleep(150);

    const optsLocal = qsa(".customOptions .customOption", host);
    let match = optsLocal.find((o) => norm(o.textContent) === norm(visibleText));

    if (!match) {
      const optsGlobal = qsa(".customOptions .customOption").filter((o) => o.offsetParent !== null);
      match = optsGlobal.find((o) => norm(o.textContent) === norm(visibleText));
    }

    if (match) {
      clickLikeUser(match);
      await sleep(250);
      return true;
    }

    console.warn(`[autofill] orientation option not found: ${visibleText}`);
    return false;
  }

  // ---------------- Inputs ----------------
  async function getTagsInput() {
    return await waitFor('input[name="tags"]');
  }

  async function getCategoryInput() {
    return (
      qs('input[name="category"]') ||
      qs('input[name="categoryInput"]') ||
      (await waitFor('input[name="category"], input[name="categoryInput"]'))
    );
  }

  // ---------------- Presets (EDIT FREELY) ----------------
  const PRESETS = {
    Straight: {
      orientation: "Straight",
      tags: [
        "Femdom","Gaming","JOI","Edging","Hentai","Ruined Orgasm","Robot",
        "Assisted Masturbation","Masturbation","Fleshlight","Premature Ejaculation",
        "Cum Countdown","ASMR","Gooning","Johnny Guides"
      ],
      categories: ["fetish","solo male","reaction","cartoon","pov","gaming","hentai","masturbation"]
    },
    Gay: {
      orientation: "Gay",
      tags: [
        "Whimpering","Gaming","Twink","Jock","Daddy","Robot","Hentai","Femboy",
        "Cock Worship","JOI","Edging","Ruined Orgasm","Cum Play",
        "Mutual Masturbation","Johnny Guides"
      ],
      categories: ["cartoon","daddy","gaming","japanese","solo male","straight guys","uncut","twink","reaction"]
    },
    Lesbian: {
      orientation: "Lesbian",
      tags: [
        "Moaning","Gaming","Bondage","Girl/Girl","Tribbing","Scissoring",
        "Strap-On","Lesbian Kissing","Squirting","Hentai","Edging","JOI",
        "Femdom","Robot","Johnny Guides"
      ],
      categories: ["hentai","uncensored","cartoon","toys","reaction","gaming","cosplay"]
    },
    "Bisexual Male": {
      orientation: "Bisexual Male",
      tags: [
        "Johnny Guides","Solo Male","Interactive","POV","JOI","Edging",
        "Orgasm Control","ASMR","Moaning","Gooning","Gaming","Twink",
        "Femboy","Robot","Stud"
      ],
      categories: ["solo male","reality","reaction","podcast","masturbation","hardcore","gaming","cosplay"]
    },
    Transgender: {
      orientation: "Transgender",
      tags: [
        "Fucking Machines","Trans Woman","Trans Man","Trans Solo","Hentai","Bondage",
        "Trans Domination","Edging","Ruined Orgasm","Gaming","Cock Worship","Robot",
        "Uncut","Interactive","Johnny Guides"
      ],
      categories: ["transgender","trans male","toys","solo male","role play","reaction","hardcore","cosplay"]
    }
  };

  // ---------------- Runner ----------------
  let busy = false;

  async function applyPreset(name) {
    if (busy) return;
    busy = true;

    try {
      const preset = PRESETS[name];
      if (!preset) return;

      // Solo/Animation
      const solo = qs('input[type="radio"][value="solo"]');
      if (solo && !solo.checked) clickLikeUser(solo);

      // Orientation
      await selectCustomDropdown("orientation", preset.orientation);

      // Tags (ul#inputTag)
      const tagInput = await getTagsInput();
      if (tagInput) {
        for (const t of preset.tags) {
          // For tags: keep a bit more settle time (server-side delay)
          // If tag doesn't exist: click first entry; if none: skip (handled)
          await addTokenViaUlList({
            input: tagInput,
            token: t,
            ulId: "inputTag",
            settleMinMs: 650,
            listTimeoutMs: 6500
          });
          await sleep(160);
        }
      } else {
        console.warn("[autofill] tag input not found");
      }

      // Categories (ul#f2vCategory) — faster timing
      const catInput = await getCategoryInput();
      if (catInput) {
        for (const c of preset.categories) {
          await addTokenViaUlList({
            input: catInput,
            token: c,
            ulId: "f2vCategory",
            settleMinMs: 220,
            listTimeoutMs: 4500
          });
          await sleep(140);
        }
      } else {
        console.warn("[autofill] category input not found");
      }

      console.log(`[autofill] Applied preset: ${name} ✅`);
    } catch (e) {
      console.error("[autofill] error:", e);
    } finally {
      busy = false;
    }
  }

  // ---------------- UI panel ----------------
  function mountPanel() {
    if (qs("#ph-autofill-panel")) return;

    const panel = document.createElement("div");
    panel.id = "ph-autofill-panel";
    panel.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:999999;" +
      "background:#0f0f0f;padding:10px;border:1px solid #444;border-radius:12px;" +
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
      "display:flex;gap:8px;flex-wrap:wrap;max-width:380px";

    const header = document.createElement("div");
    header.textContent = "Autofill Presets";
    header.style.cssText = "width:100%;color:#ddd;font-size:12px;opacity:.9;margin-bottom:2px";
    panel.appendChild(header);

    Object.keys(PRESETS).forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.style.cssText =
        "padding:8px 10px;border:1px solid #555;border-radius:10px;" +
        "background:#1b1b1b;color:#fff;cursor:pointer;font-size:13px";
      b.addEventListener("click", () => applyPreset(name));
      panel.appendChild(b);
    });

    const tip = document.createElement("div");
    tip.textContent = "Tags: waits for suggestions; if missing, clicks first or skips. Categories: faster.";
    tip.style.cssText = "width:100%;color:#aaa;font-size:11px;opacity:.85;margin-top:4px";
    panel.appendChild(tip);

    document.body.appendChild(panel);
  }

  // ---------------- boot ----------------
  await sleep(1200);
  mountPanel();
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] ph-uploader.js failed:", error);
});
