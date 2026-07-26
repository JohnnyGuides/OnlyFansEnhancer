CreatorToolkit.runWhenEnabled("redditBannerCensor", async () => {
(() => {
  'use strict';

  const STYLE_ID = 'reddit-banner-censor-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #subreddit-banner-img,
      div.community-banner {
        position: relative !important;
        overflow: hidden !important;
        background: #000 !important;
        background-image: none !important;
        isolation: isolate !important;
      }

      #subreddit-banner-img::before,
      div.community-banner::before {
        content: "" !important;
        position: absolute !important;
        inset: 0 !important;
        z-index: 1 !important;
        background:
          linear-gradient(rgba(0, 0, 0, 0.92), rgba(0, 0, 0, 0.92)),
          repeating-linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.05) 0px,
            rgba(255, 255, 255, 0.05) 14px,
            rgba(0, 0, 0, 0.18) 14px,
            rgba(0, 0, 0, 0.18) 28px
          ) !important;
        pointer-events: none !important;
      }

      #subreddit-banner-img::after,
      div.community-banner::after {
        content: "Banner censored" !important;
        position: absolute !important;
        inset: 0 !important;
        z-index: 2 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font: 700 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0.08em !important;
        text-transform: uppercase !important;
        color: rgba(255, 255, 255, 0.88) !important;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45) !important;
        pointer-events: none !important;
        user-select: none !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  injectStyle();
})();
}).catch((error) => {
  console.error("[Creator Workflow Toolkit] reddit-banner-censor.js failed:", error);
});
