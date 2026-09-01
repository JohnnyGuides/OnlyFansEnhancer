(() => {
  "use strict";
  if (globalThis.CreatorXTeaserObserver) return;
  function capture(document, href) {
    const articles = [...document.querySelectorAll("article")];
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
