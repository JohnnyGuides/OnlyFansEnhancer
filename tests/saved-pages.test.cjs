"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const extensionRoot = path.resolve(__dirname, "..");
const corePath = path.join(extensionRoot, "core.js");
const contentCssPath = path.join(extensionRoot, "content.css");
const postSnapshot = process.env.FIM_POST_SNAPSHOT;
const dmSnapshot = process.env.FIM_DM_SNAPSHOT;
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

function sanitizedSnapshot(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "");
}

const avatarSvg =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="pink"/></svg>'
  );

async function installCore(page, html) {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: fs.readFileSync(contentCssPath, "utf8") });
  await page.addScriptTag({ path: corePath });
}

async function applyFakeIdentities(page) {
  return page.evaluate((avatarUrl) => {
    const core = globalThis.FanIdentityMaskCore;
    const settings = { ownHandles: ["johnny_guides"] };
    const contexts = core.collectContexts(document, settings);
    const identityByKey = new Map();

    for (const context of contexts) {
      if (!identityByKey.has(context.primaryKey)) {
        const suffix = context.primaryKey.replace(/[^a-z0-9]/gi, "_");
        identityByKey.set(context.primaryKey, {
          displayName: `Girl ${suffix}`,
          handle: `girl_${suffix}`.toLowerCase(),
          avatarUrl
        });
      }
      core.maskContext(context, identityByKey.get(context.primaryKey));
    }

    return {
      contextCounts: contexts.reduce((counts, context) => {
        counts[context.kind] = (counts[context.kind] || 0) + 1;
        return counts;
      }, {}),
      keys: contexts.map((context) => ({
        kind: context.kind,
        primaryKey: context.primaryKey,
        aliases: context.aliases
      }))
    };
  }, avatarSvg);
}

async function testPostSnapshot(page) {
  const postHtml = sanitizedSnapshot(postSnapshot);
  await installCore(page, postHtml);
  const result = await applyFakeIdentities(page);

  assert.ok(result.contextCounts.comment >= 2, "Expected saved post comments.");

  const view = await page.evaluate(() => ({
    commentNames: [...document.querySelectorAll(".b-comments__item .g-user-name")]
      .filter((element) => !element.querySelector(".g-user-name"))
      .map((element) => element.textContent.trim()),
    maskedAvatars: document.querySelectorAll(
      ".b-comments__item img[data-fim-masked-avatar]"
    ).length,
    ownName: document.querySelector('[at-attr="my_profile"] .g-user-name')
      ?.textContent.trim()
  }));

  assert.ok(
    view.commentNames.every((name) => /^Girl user_\d+$/.test(name)),
    "Every visible comment author should be replaced, not concatenated."
  );
  assert.ok(view.maskedAvatars >= 2, "Comment avatars should be replaced.");
  assert.equal(view.ownName, "Johnny Guides", "The creator identity must remain unchanged.");

  const clickResult = await page.evaluate(() => {
    const image = document.querySelector(
      ".b-comments__item img[data-fim-masked-avatar]"
    );
    let eventDetail = null;
    let rerollEvents = 0;
    let siteAvatarClicks = 0;
    let siteNameClicks = 0;
    window.addEventListener(
      "fim:rotate-avatar",
      (event) => {
        eventDetail = event.detail;
        rerollEvents += 1;
      }
    );

    // Simulate OnlyFans' delegated document handler. The extension guard was
    // registered first and must keep avatar events from reaching this handler.
    document.addEventListener(
      "click",
      (event) => {
        if (event.target.closest("[data-fim-avatar-hit-target]")) {
          siteAvatarClicks += 1;
        }
        if (event.target.closest(".g-user-name")) siteNameClicks += 1;
        event.preventDefault();
      },
      true
    );

    image.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0
      })
    );
    image.click();
    const name = [...document.querySelectorAll(".b-comments__item .g-user-name")]
      .find((element) => !element.querySelector(".g-user-name"));
    name.click();
    const avatar = image.closest(".g-avatar");
    return {
      eventDetail,
      rerollEvents,
      siteAvatarClicks,
      siteNameClicks,
      avatarHref: avatar.getAttribute("href"),
      loading: image
        .closest(".g-avatar__img-wrapper")
        .classList.contains("fim-avatar-loading"),
      radius: getComputedStyle(image).borderRadius
    };
  });
  assert.ok(clickResult.eventDetail?.primaryKey, "Avatar clicks must request a reroll.");
  assert.equal(clickResult.rerollEvents, 1, "One pointer sequence must reroll only once.");
  assert.equal(
    clickResult.siteAvatarClicks,
    0,
    "OnlyFans' delegated handler must never receive masked-avatar clicks."
  );
  assert.equal(
    clickResult.siteNameClicks,
    1,
    "Name clicks must remain available to OnlyFans."
  );
  assert.equal(clickResult.avatarHref, null, "Masked avatars must not retain profile links.");
  assert.equal(clickResult.loading, true, "Avatar rerolls must show a loading state.");
  assert.notEqual(clickResult.radius, "0px", "Every masked avatar must be circular.");

  const skeleton = await page.evaluate(() => {
    const row = document.querySelector(".b-comments__item");
    row.classList.add("fim-identity-pending");
    const name = [...row.querySelectorAll(".g-user-name")].find(
      (element) => !element.querySelector(".g-user-name")
    );
    const avatar = row.querySelector(".g-avatar");
    return {
      nameColor: getComputedStyle(name).color,
      nameAnimation: getComputedStyle(name).animationName,
      avatarRadius: getComputedStyle(avatar).borderRadius
    };
  });
  assert.equal(
    skeleton.nameColor,
    "rgba(0, 0, 0, 0)",
    "Pending names must be visually replaced by a skeleton."
  );
  assert.match(skeleton.nameAnimation, /fim-skeleton-shimmer/);
  assert.notEqual(skeleton.avatarRadius, "0px");

  const fallbackSource = await page.evaluate(() => {
    const core = globalThis.FanIdentityMaskCore;
    const context = core.collectContexts(document, {
      ownHandles: ["johnny_guides"]
    }).find((item) => item.kind === "comment");
    core.maskContext(context, {
      displayName: "Fallback Girl",
      handle: "fallback_girl",
      avatarUrl: "http://127.0.0.1:9/fim-missing-avatar.png"
    });
    const image = context.container.querySelector("img[data-fim-masked-avatar]");
    image.dispatchEvent(new Event("error"));
    return image.getAttribute("src");
  });
  assert.match(
    fallbackSource,
    /^data:image\/svg\+xml/i,
    "A failed avatar image must be replaced by a generated fallback."
  );
}

async function testDmSnapshot(page) {
  await installCore(page, sanitizedSnapshot(dmSnapshot));
  const result = await applyFakeIdentities(page);

  assert.ok(result.contextCounts["chat-list"] >= 8, "Expected DM conversation rows.");
  assert.equal(result.contextCounts["chat-header"], 1, "Expected one active DM header.");
  assert.ok(
    result.contextCounts["incoming-message"] >= 1,
    "Expected incoming DM messages."
  );

  const view = await page.evaluate(() => ({
    selectedListName: document.querySelector(
      ".b-chats__item.current [at-attr='chat_list_user_name']"
    )?.textContent.trim(),
    selectedListHandle: document.querySelector(
      ".b-chats__item.current .g-user-username"
    )?.textContent.trim(),
    headerName: document.querySelector(
      ".b-chat__header__title .g-user-name .g-user-name"
    )?.textContent.trim(),
    incomingAvatarKeys: [
      ...document.querySelectorAll(
        ".b-chat__message:not(.m-from-me) img[data-fim-masked-avatar]"
      )
    ].map((image) => image.dataset.fimMaskedAvatar),
    ownName: document.querySelector('[at-attr="my_profile"] .g-user-name')
      ?.textContent.trim()
  }));

  assert.equal(view.selectedListName, "Girl user_538073641");
  assert.equal(view.selectedListHandle, "@girl_user_538073641");
  assert.equal(view.headerName, "Girl user_538073641");
  assert.ok(
    view.incomingAvatarKeys.every((key) => key === "user:538073641"),
    "The active fan must keep one identity across the list, header, and messages."
  );
  assert.equal(view.ownName, "Johnny Guides", "The creator identity must remain unchanged.");
}

(async () => {
  for (const [label, filePath] of [
    ["FIM_POST_SNAPSHOT", postSnapshot],
    ["FIM_DM_SNAPSHOT", dmSnapshot],
    ["core.js", corePath],
    ["content.css", contentCssPath]
  ]) {
    assert.ok(filePath, `Set ${label} to the required saved-page HTML file.`);
    assert.ok(fs.existsSync(filePath), `Missing test input: ${filePath}`);
  }

  const chromePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {})
  });
  const page = await browser.newPage();

  try {
    await testPostSnapshot(page);
    await testDmSnapshot(page);
    console.log("PASS: saved post and DM identity masking");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
