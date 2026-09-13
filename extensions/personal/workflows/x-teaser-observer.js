(() => {
  "use strict";
  if (globalThis.CreatorXTeaserObserver) return;
  function canonical(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})$/,
      );
      return url.origin === "https://x.com" && match
        ? `https://x.com/${match[1]}/status/${match[2]}`
        : null;
    } catch {
      return null;
    }
  }
  function capture(document, href) {
    const target = canonical(href);
    const articles = [...document.querySelectorAll("article")].filter(
      (article) =>
        [...article.querySelectorAll("a[href]")].some(
          (anchor) => canonical(anchor.href) === target,
        ),
    );
    const warningGate = articles.some(
      (article) =>
        [...article.querySelectorAll("button")].some((button) =>
          /^(show|view)$/i.test(String(button.textContent || "").trim()),
        ) && /warning|sensitive/i.test(String(article.innerText || "")),
    );
    const article = articles.length === 1 ? articles[0] : null;
    const time = article?.querySelector("time[datetime]");
    const video = article?.querySelector("video");
    return {
      url: href,
      articleCount: articles.length,
      warningGate,
      video: Boolean(video),
      caption: String(
        article?.querySelector("div[lang]")?.textContent || "",
      ).trim(),
      timestamp: String(
        time?.dateTime || time?.getAttribute?.("datetime") || "",
      ),
      duration: Number(video?.duration || 0),
      poster: String(video?.poster || ""),
    };
  }
  globalThis.CreatorXTeaserObserver = Object.freeze({ capture });
})();
