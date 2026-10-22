(() => {
  "use strict";
  const SETTINGS_KEY = "creatorXReplyPolicyV1";
  const STATE_KEY = "creatorXReplyReservationsV1";
  const DEFAULT_VARIANTS = Object.freeze([
    "full vid (no ppv)",
    "full session",
    "full vid :)",
  ]);
  function normalize(value = {}) {
    const input = value.variants ?? [...DEFAULT_VARIANTS];
    if (!Array.isArray(input))
      throw new Error("Use 1–20 saved replies, up to 200 characters each.");
    const variants = input.map((reply) =>
      typeof reply === "string" ? reply.replace(/\r\n?/g, "\n").trim() : null,
    );
    if (
      !variants.length ||
      variants.length > 20 ||
      variants.some(
        (line) =>
          typeof line !== "string" ||
          !line.trim() ||
          [...line.trim()].length > 200,
      )
    )
      throw new Error("Use 1–20 saved replies, up to 200 characters each.");
    if (value.mode !== undefined && !["rotate", "link"].includes(value.mode))
      throw new Error("Choose rotating text or link only.");
    return {
      mode: value.mode || "rotate",
      variants: variants.map((line) => line.trim()),
    };
  }
  function format(line, url) {
    return line ? `${line}\n-> ${url}` : url;
  }
  const services = new WeakMap();
  function forStorage(storage) {
    if (services.has(storage)) return services.get(storage);
    let chain = Promise.resolve();
    const serialized = (run) => {
      const result = chain.then(run);
      chain = result.catch(() => {});
      return result;
    };
    const settings = async () =>
      normalize((await storage.get(SETTINGS_KEY))[SETTINGS_KEY]);
    const state = async () => {
      const value = (await storage.get(STATE_KEY))[STATE_KEY];
      return { next: value?.next || 0, items: { ...(value?.items || {}) } };
    };
    const service = {
      lookup: (statusId) =>
        serialized(async () => (await state()).items[statusId] || null),
      view: () =>
        serialized(async () => {
          const config = await settings(),
            current = await state();
          return {
            ...config,
            nextIndex: current.next,
            nextLine:
              config.mode === "link"
                ? ""
                : config.variants[current.next % config.variants.length],
          };
        }),
      save: (value) =>
        serialized(async () => {
          const config = normalize(value);
          await storage.set({ [SETTINGS_KEY]: config });
          return config;
        }),
      allocate: () =>
        serialized(async () => {
          const config = await settings(),
            current = await state();
          const line =
            config.mode === "link"
              ? ""
              : config.variants[current.next % config.variants.length];
          current.next += 1;
          await storage.set({ [STATE_KEY]: current });
          return line;
        }),
      reserve: (statusId, paidUrl, frozen = null) =>
        serialized(async () => {
          if (!/^\d{1,25}$/.test(statusId))
            throw new Error("Invalid X reply post.");
          const current = await state();
          const existing = current.items[statusId];
          if (existing) {
            if (existing.paidUrl !== paidUrl)
              throw new Error("The reserved reply link changed.");
            return existing;
          }
          const config = await settings();
          const line =
            frozen?.line ??
            (config.mode === "link"
              ? ""
              : config.variants[current.next % config.variants.length]);
          const item = {
            owner: frozen?.owner || "scanner",
            line,
            paidUrl,
            text: format(line, paidUrl),
            attempted: false,
          };
          current.items[statusId] = item;
          if (!frozen) current.next += 1;
          await storage.set({ [STATE_KEY]: current });
          return item;
        }),
      claim: (statusId, text) =>
        serialized(async () => {
          const current = await state(),
            item = current.items[statusId];
          if (!item || item.text !== text)
            throw new Error("The reserved reply text changed.");
          if (item.attempted) return false;
          item.attempted = true;
          await storage.set({ [STATE_KEY]: current });
          return true;
        }),
    };
    services.set(storage, service);
    return service;
  }
  globalThis.CreatorXReplyPolicy = Object.freeze({
    DEFAULT_VARIANTS,
    normalize,
    format,
    forStorage,
  });
})();
