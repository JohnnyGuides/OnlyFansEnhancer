(() => {
  "use strict";

  const REALBOORU_ORIGIN = "https://realbooru.com";
  const MAX_HTML_LENGTH = 2_000_000;

  function normalizeUrl(value, allowedPath) {
    try {
      const url = new URL(String(value || ""), REALBOORU_ORIGIN);
      if (
        url.origin !== REALBOORU_ORIGIN ||
        !allowedPath.test(url.pathname.replace(/^\/+/, "/"))
      ) {
        return "";
      }
      url.hash = "";
      return url.href;
    } catch {
      return "";
    }
  }

  function parseDocument(html) {
    if (typeof html !== "string" || html.length > MAX_HTML_LENGTH) {
      throw new Error("Realbooru HTML is missing or exceeds the parser limit.");
    }
    return new DOMParser().parseFromString(html, "text/html");
  }

  function postIdFromUrl(value) {
    try {
      const url = new URL(value, REALBOORU_ORIGIN);
      const id = url.searchParams.get("id") || "";
      return /^\d+$/.test(id) ? id : "";
    } catch {
      return "";
    }
  }

  function parseListing(html) {
    const document = parseDocument(html);
    const posts = [];
    const seen = new Set();

    for (const anchor of document.querySelectorAll(".thumb a[href]")) {
      const postUrl = normalizeUrl(
        anchor.getAttribute("href"),
        /^\/index\.php$/,
      );
      const parsedPostUrl = postUrl ? new URL(postUrl) : null;
      const id = postIdFromUrl(postUrl);
      const image = anchor.querySelector("img");
      const thumbnailUrl = normalizeUrl(
        image?.getAttribute("src"),
        /^\/thumbnails\//,
      );
      if (
        !id ||
        !postUrl ||
        parsedPostUrl.searchParams.get("page") !== "post" ||
        parsedPostUrl.searchParams.get("s") !== "view" ||
        !thumbnailUrl ||
        seen.has(id)
      ) {
        continue;
      }
      seen.add(id);
      posts.push({
        id,
        postUrl,
        thumbnailUrl,
        tags: String(image?.getAttribute("title") || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 500),
      });
      if (posts.length >= 100) break;
    }

    let maxPid = 0;
    for (const anchor of document.querySelectorAll("#paginator a[href]")) {
      try {
        const url = new URL(
          anchor.getAttribute("href"),
          `${REALBOORU_ORIGIN}/index.php`,
        );
        const pid = Number(url.searchParams.get("pid"));
        if (
          url.origin === REALBOORU_ORIGIN &&
          url.pathname === "/index.php" &&
          url.searchParams.get("page") === "post" &&
          url.searchParams.get("s") === "list" &&
          Number.isSafeInteger(pid) &&
          pid >= 0 &&
          pid <= 1_000_000
        ) {
          maxPid = Math.max(maxPid, pid);
        }
      } catch {
        // Ignore malformed pagination URLs.
      }
    }

    return { posts, maxPid };
  }

  function parseDetail(html, expectedId) {
    const document = parseDocument(html);
    const image = document.querySelector("img#image");
    const url = normalizeUrl(image?.getAttribute("src"), /^\/images\//);
    if (!url || !/\/[a-f0-9]{32}\.(?:avif|gif|jpe?g|png|webp)$/i.test(url)) {
      throw new Error("Realbooru detail page has no supported original image.");
    }
    const fingerprint =
      new URL(url).pathname.match(
        /\/([a-f0-9]{32})\.(?:avif|gif|jpe?g|png|webp)$/i,
      )?.[1] || "";
    const id = String(expectedId || "");
    if (!/^\d+$/.test(id)) {
      throw new Error("Realbooru detail parser received an invalid post ID.");
    }
    return {
      id,
      url,
      fingerprint: fingerprint.toLowerCase(),
      postUrl: `${REALBOORU_ORIGIN}/index.php?page=post&s=view&id=${id}`,
    };
  }

  const api = Object.freeze({ parseListing, parseDetail });
  globalThis.RealbooruParser = api;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message?.target !== "realbooru-offscreen-parser" ||
      sender.id !== chrome.runtime.id
    ) {
      return false;
    }
    try {
      const result =
        message.kind === "listing"
          ? parseListing(message.html)
          : message.kind === "detail"
            ? parseDetail(message.html, message.expectedId)
            : (() => {
                throw new Error("Unknown Realbooru parser operation.");
              })();
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  });
})();
