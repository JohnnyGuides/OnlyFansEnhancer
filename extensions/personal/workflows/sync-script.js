"use strict";

// JohnnyGuides toy-sync script upload: .funscript validation, platform video
// keys, lead-in alignment and the website POST. Bytes are never persisted.
(() => {
  const SETTINGS_KEY = "johnnyGuidesSyncScriptV1";
  const DEFAULT_ORIGIN = "https://johnnyguides.com";
  const KEY = /^[a-z0-9_-]{1,40}$/i;
  const MAX_BYTES = 8 * 1024 * 1024;
  const PLATFORMS = ["onlyfans", "fansly", "manyvids", "pornhub"];

  function parseFunscript(text) {
    let value;
    try {
      value = JSON.parse(String(text));
    } catch {
      throw new Error("The script is not valid .funscript JSON.");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Array.isArray(value.actions) ||
      !value.actions.length ||
      !value.actions.every(
        (action) =>
          action &&
          Number.isFinite(action.at) &&
          action.at >= 0 &&
          Number.isFinite(action.pos) &&
          action.pos >= 0 &&
          action.pos <= 100,
      )
    )
      throw new Error(
        "The script needs an actions list of {at, pos} points (pos 0-100).",
      );
    return value;
  }

  function isScriptFile(file) {
    return Boolean(
      file &&
      /\.funscript$/i.test(String(file.name || "")) &&
      Number(file.size) > 0 &&
      Number(file.size) <= MAX_BYTES,
    );
  }

  // Platform video id used by the website, or "" when the link has none.
  function scriptKey(platform, link) {
    let url;
    try {
      url = new URL(String(link || ""));
    } catch {
      return "";
    }
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    const key =
      platform === "onlyfans" && host === "onlyfans.com"
        ? url.pathname.match(/^\/(\d{1,30})(?:\/[^/]+)?\/?$/)?.[1]
        : platform === "fansly" && host === "fansly.com"
          ? url.pathname.match(/^\/post\/(\d{1,30})\/?$/)?.[1]
          : platform === "manyvids" && host === "www.manyvids.com"
            ? url.pathname.match(/^\/Video\/(\d{1,30})(?:\/|$)/i)?.[1]
            : platform === "pornhub" &&
                host === "www.pornhub.com" &&
                /^\/(?:view_video\.php|video\/show)$/i.test(url.pathname)
              ? url.searchParams.get("viewkey")
              : "";
    return KEY.test(key || "") ? key : "";
  }

  function shiftFunscript(funscript, leadInMs = 0) {
    const shift = Number(leadInMs) || 0;
    if (!Number.isSafeInteger(shift) || shift < 0 || shift > 60_000)
      throw new Error("The video lead-in is invalid.");
    return {
      ...funscript,
      actions: funscript.actions.map((action) => ({
        ...action,
        at: action.at + shift,
      })),
    };
  }

  // One upload per distinct lead-in: each key gets a script aligned to the
  // video actually published on its platform.
  function scriptUploads(links, funscript, leadIns = {}) {
    const groups = new Map();
    for (const { platform, postUrl } of links || []) {
      if (!PLATFORMS.includes(platform)) continue;
      const key = scriptKey(platform, postUrl);
      if (!key) continue;
      const leadIn = Number(leadIns[platform]) || 0;
      const group = groups.get(leadIn) || { leadInMs: leadIn, keys: [] };
      if (!group.keys.includes(key)) group.keys.push(key);
      groups.set(leadIn, group);
    }
    return [...groups.values()].map((group) => ({
      leadInMs: group.leadInMs,
      keys: group.keys.slice(0, 10),
      funscript: shiftFunscript(funscript, group.leadInMs),
    }));
  }

  function normalizeSettings(value = {}) {
    const errors = [];
    let origin = String(value.origin || DEFAULT_ORIGIN).trim();
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        (url.pathname !== "/" && url.pathname !== "") ||
        url.search ||
        url.hash ||
        !/^(?:[a-z0-9-]+\.)*johnnyguides\.com$/i.test(url.hostname)
      )
        throw new Error();
      origin = url.origin;
    } catch {
      errors.push("Use an https://johnnyguides.com site origin.");
    }
    const token = String(value.token || "").trim();
    if (!/^[\x21-\x7e]{8,4096}$/.test(token))
      errors.push("Enter the website upload token.");
    return { valid: !errors.length, errors, value: { origin, token } };
  }

  async function uploadScript(
    { origin, token, keys, title, funscript },
    fetchImpl = globalThis.fetch,
  ) {
    const settings = normalizeSettings({ origin, token });
    if (!settings.valid) throw new Error(settings.errors.join(" "));
    const cleanKeys = [...new Set(keys || [])].filter((key) => KEY.test(key));
    if (!cleanKeys.length || cleanKeys.length > 10)
      throw new Error("No platform video id is available for the script.");
    const cleanTitle = String(title || "")
      .trim()
      .slice(0, 120);
    if (!cleanTitle) throw new Error("Enter a title for the script.");
    const body = JSON.stringify({
      keys: cleanKeys,
      title: cleanTitle,
      funscript: parseFunscript(JSON.stringify(funscript)),
    });
    if (new TextEncoder().encode(body).length > MAX_BYTES)
      throw new Error("The script is larger than 8 MB.");
    const response = await fetchImpl(`${settings.value.origin}/sync/scripts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.value.token}`,
        "Content-Type": "application/json",
      },
      body,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        {
          400: "The website rejected the script.",
          401: "The website rejected the upload token.",
          404: "Script upload is turned off on the website.",
          413: "The script is too large for the website.",
        }[response.status] ||
          `The website script upload failed (${response.status}).`,
      );
    const result = await response.json().catch(() => null);
    let url;
    try {
      url = new URL(String(result?.url || ""));
    } catch {
      url = null;
    }
    if (
      !url ||
      url.protocol !== "https:" ||
      !/^(?:[a-z0-9-]+\.)*johnnyguides\.com$/i.test(url.hostname) ||
      !/^\/sync\/scripts\/[^/]+\.funscript$/i.test(url.pathname)
    )
      throw new Error("The website returned an invalid script link.");
    return {
      file: String(result.file || ""),
      keys: cleanKeys,
      url: url.href,
    };
  }

  // Each upload and its sheet record stand alone: one refusal never stops the
  // others, and a sheet failure never hides a stored script link.
  /**
   * @param {{settings: {origin: string, token: string}, title: string, uploads: any}} run
   * @param {{commit?: (url: string) => Promise<string>, fetchImpl?: typeof fetch}} [options]
   */
  async function uploadScripts(
    { settings, title, uploads },
    { commit = undefined, fetchImpl = globalThis.fetch } = {},
  ) {
    const scripts = [];
    for (const upload of (Array.isArray(uploads) ? uploads : []).slice(0, 4)) {
      let sent;
      try {
        sent = await uploadScript(
          {
            ...settings,
            keys: upload?.keys,
            title,
            funscript: upload?.funscript,
          },
          fetchImpl,
        );
      } catch (error) {
        scripts.push({ keys: [], error: error.message });
        continue;
      }
      const sheetError = await Promise.resolve()
        .then(() => commit?.(sent.url))
        .then(
          (message) => message || "",
          (error) => `Script link not written to the sheet (${error.message}).`,
        );
      scripts.push({ url: sent.url, keys: sent.keys, sheetError });
    }
    return scripts;
  }

  globalThis.CreatorSyncScript = Object.freeze({
    SETTINGS_KEY,
    DEFAULT_ORIGIN,
    MAX_BYTES,
    isScriptFile,
    normalizeSettings,
    parseFunscript,
    scriptKey,
    scriptUploads,
    shiftFunscript,
    uploadScript,
    uploadScripts,
  });
})();
