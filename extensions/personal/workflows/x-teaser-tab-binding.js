(() => {
  "use strict";
  if (globalThis.CreatorXTeaserTabBinding) return;
  function choose(tabs, canonicalStatusUrl) {
    const candidates = (Array.isArray(tabs) ? tabs : []).filter((tab) =>
      Number.isInteger(tab?.id),
    );
    if (!candidates.length) return { action: "open-compose" };
    if (candidates.length !== 1) return { action: "ambiguous" };
    const tab = candidates[0];
    const statusUrl = canonicalStatusUrl(tab.url);
    return statusUrl
      ? { action: "confirm-status", tabId: tab.id, statusUrl }
      : { action: "bind", tabId: tab.id };
  }
  globalThis.CreatorXTeaserTabBinding = Object.freeze({ choose });
})();
