(function (global) {
  "use strict";
  function rank(videos, reference = {}, query = "") {
    const contract = global.CreatorCatalogueContract;
    const normalized = contract.normalizedText;
    const series = normalized(reference.seasonArc);
    const category = normalized(reference.category);
    const search = normalized(query);
    return videos
      .filter(
        (video) =>
          !search ||
          normalized(
            `${video.title} ${video.seasonArc || ""} ${video.category || ""}`,
          ).includes(search),
      )
      .map((video) => {
        const sameSeries = Boolean(
          series && series === normalized(video.seasonArc),
        );
        const sameCategory = Boolean(
          category && category === normalized(video.category),
        );
        const title = contract.similarity(reference.title, video.title);
        return {
          ...video,
          score:
            Number(sameSeries) * 100 +
            Number(sameCategory) * 20 +
            title * 50 +
            contract.similarity(reference.description, video.description) * 10,
          reason: sameSeries
            ? "Same series"
            : sameCategory
              ? "Same category"
              : title > 0
                ? "Similar title"
                : "Catalogue video",
        };
      })
      .sort(
        (a, b) =>
          Number(b.platform === "onlyfans") -
            Number(a.platform === "onlyfans") ||
          b.score - a.score ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      );
  }
  function mount({ select, getVideos, getReference, getOwnLinks, choose }) {
    const doc = select.ownerDocument;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "teaser-link-trigger";
    button.setAttribute("aria-label", "Choose reply link");
    const label = doc.createElement("span");
    button.append(label);
    button.insertAdjacentHTML(
      "beforeend",
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    );
    const panel = doc.createElement("div");
    panel.className = "teaser-link-picker";
    panel.id = "teaser-reply-link-picker";
    panel.setAttribute("popover", "auto");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Reply link suggestions");
    button.setAttribute("popovertarget", panel.id);
    const searchRow = doc.createElement("div");
    searchRow.className = "teaser-link-search";
    const search = doc.createElement("input");
    search.type = "search";
    search.placeholder = "Find a video";
    search.setAttribute("aria-label", "Find a reply video");
    const platform = doc.createElement("select");
    platform.setAttribute("aria-label", "Reply video platform");
    for (const [value, text] of [
      ["onlyfans", "OnlyFans"],
      ["fansly", "Fansly"],
      ["all", "All platforms"],
    ]) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = text;
      platform.append(option);
    }
    searchRow.append(search, platform);
    const results = doc.createElement("div");
    results.className = "teaser-link-results";
    const defaults = doc.createElement("div");
    defaults.className = "teaser-link-defaults";
    let videos = [],
      own = [],
      allowCustom = false;
    const pick = (value) => {
      choose(value);
      panel.hidePopover();
      button.focus();
    };
    const action = (text, value) => {
      const item = doc.createElement("button");
      item.type = "button";
      item.textContent = text;
      item.dataset.choice = value;
      item.addEventListener("click", () => pick(value));
      return item;
    };
    function render() {
      results.replaceChildren();
      if (!search.value)
        for (const link of own) {
          const item = action(`This video · ${link.service}`, link.url);
          item.className = "teaser-link-own";
          results.append(item);
        }
      const ranked = rank(videos, getReference(), search.value).filter(
        (video) =>
          platform.value === "all" || video.platform === platform.value,
      );
      for (const video of ranked) {
        const item = action("", `fallback:video:${video.id}`);
        item.className = "teaser-link-result";
        const title = doc.createElement("span");
        title.textContent = video.title;
        const detail = doc.createElement("small");
        detail.textContent = `${video.service} · ${video.reason}`;
        item.append(title, detail);
        results.append(item);
      }
      if (!ranked.length) {
        const empty = doc.createElement("p");
        empty.textContent =
          platform.value === "onlyfans"
            ? "No matching OnlyFans videos."
            : "No matching videos.";
        results.append(empty);
        if (platform.value !== "all") {
          const showAll = doc.createElement("button");
          showAll.type = "button";
          showAll.textContent = "Show all platforms";
          showAll.addEventListener("click", () => {
            platform.value = "all";
            render();
          });
          results.append(showAll);
        }
      }
    }
    search.addEventListener("input", render);
    platform.addEventListener("change", render);
    panel.addEventListener("beforetoggle", (event) => {
      if (event.newState !== "open") return;
      videos = getVideos();
      own = getOwnLinks();
      search.value = "";
      platform.value = "onlyfans";
      defaults.replaceChildren(
        action("OnlyFans profile", "fallback:onlyfans"),
        action("Fansly profile", "fallback:fansly"),
      );
      const random = action("Random video", "fallback:random");
      random.disabled = !videos.length;
      defaults.append(random);
      if (allowCustom) defaults.append(action("Custom URL", "custom"));
      render();
    });
    panel.addEventListener("toggle", (event) => {
      if (event.newState !== "open") return;
      const bounds = button.getBoundingClientRect();
      panel.style.width = `${Math.min(420, global.innerWidth - 24)}px`;
      panel.style.left = `${Math.max(12, Math.min(bounds.right - panel.offsetWidth, global.innerWidth - panel.offsetWidth - 12))}px`;
      panel.style.top = `${bounds.bottom + panel.offsetHeight + 8 < global.innerHeight - 12 ? bounds.bottom + 8 : Math.max(12, bounds.top - panel.offsetHeight - 8)}px`;
      search.focus({ preventScroll: true });
    });
    panel.append(searchRow, results, defaults);
    select.after(button);
    doc.body.append(panel);
    return {
      update(state) {
        select.hidden = true;
        label.textContent = state.label;
        button.disabled = state.disabled;
        allowCustom = state.allowCustom;
        if (button.disabled && panel.matches(":popover-open"))
          panel.hidePopover();
      },
    };
  }
  global.OFEnhancerTeaserLinkPicker = Object.freeze({ rank, mount });
})(globalThis);
