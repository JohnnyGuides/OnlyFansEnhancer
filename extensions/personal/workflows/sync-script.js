"use strict";

// JohnnyGuides toy-sync script upload: .funscript validation, platform video
// keys, lead-in alignment and the website POST. Bytes are never persisted.
(() => {
  const SETTINGS_KEY = "johnnyGuidesSyncScriptV1";
  const DEFAULT_ORIGIN = "https://johnnyguides.com";
  const KEY = /^[a-z0-9_-]{1,40}$/i;
  const MAX_BYTES = 8 * 1024 * 1024;
  const PLATFORMS = ["onlyfans", "fansly", "manyvids", "pornhub"];
  const MAX_ACTIONS = 500_000;
  const MAX_AT = 86_400_000;
  // The desktop relay refuses commands over 64 KB, so the script travels to
  // the worker in base64 parts of 30,000 bytes (40,000 characters).
  const PART_BYTES = 30_000;
  const MAX_PARTS = 600;
  const UPLOAD_ID = /^[a-f0-9]{32}$/;
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

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
      !value.actions.length
    )
      throw new Error("The script has no actions list.");
    if (value.actions.length > MAX_ACTIONS)
      throw new Error(
        `The script has ${value.actions.length.toLocaleString("en-US")} actions; the limit is 500,000.`,
      );
    // Matches the website: only {at, pos} points and an optional inverted flag are sent.
    const actions = value.actions.map((action, index) => {
      if (!Number.isInteger(action?.at) || action.at < 0 || action.at > MAX_AT)
        throw new Error(
          `Action ${index + 1}: at must be a whole number of ms from 0 to 86,400,000.`,
        );
      if (!Number.isFinite(action.pos) || action.pos < 0 || action.pos > 100)
        throw new Error(`Action ${index + 1}: pos must be from 0 to 100.`);
      return { at: action.at, pos: action.pos };
    });
    return typeof value.inverted === "boolean"
      ? { actions, inverted: value.inverted }
      : { actions };
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
      .slice(0, 120)
      .replace(/[\uD800-\uDBFF]$/, "");
    if (!cleanTitle) throw new Error("Enter a title for the script.");
    // eslint-disable-next-line no-control-regex -- control characters are the rejected input
    if (/[\x00-\x1f\x7f]/.test(cleanTitle))
      throw new Error("The title contains control characters.");
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

  function base64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192)
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return btoa(binary);
  }

  // Sends {title, uploads} to the worker as ordered parts; returns the id to
  // commit with UPLOAD_SYNC_SCRIPT.
  async function sendScriptParts(sendMessage, payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const total = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
    if (total > MAX_PARTS) throw new Error("The script is too large to send.");
    const uploadId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    for (let index = 0; index < total; index++)
      await sendMessage({
        type: "UPLOAD_SYNC_SCRIPT_PART",
        uploadId,
        index,
        total,
        data: base64(
          bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES),
        ),
      });
    return uploadId;
  }

  // Worker side: accepts parts strictly in order, drops stale or broken
  // uploads, and returns the validated {title, uploads} once complete.
  function createScriptAssembler({
    now = () => Date.now(),
    ttlMs = 5 * 60_000,
    maxUploads = 4,
  } = {}) {
    const pending = new Map();
    const expire = () => {
      for (const [id, entry] of pending)
        if (now() - entry.updatedAt > ttlMs) pending.delete(id);
    };
    const damaged = () =>
      new Error("The script arrived damaged. Send the script again.");
    return {
      /** @param {{uploadId?: string, index?: number, total?: number, data?: string}} part */
      add({ uploadId, index, total, data } = {}) {
        expire();
        if (
          !UPLOAD_ID.test(String(uploadId)) ||
          !Number.isSafeInteger(total) ||
          total < 1 ||
          total > MAX_PARTS ||
          !Number.isSafeInteger(index) ||
          typeof data !== "string" ||
          data.length > Math.ceil(PART_BYTES / 3) * 4 ||
          !BASE64.test(data)
        )
          throw new Error("The script part is invalid.");
        let entry = pending.get(uploadId);
        if (!entry && index === 0) {
          if (pending.size >= maxUploads)
            throw new Error("Too many script uploads are in progress.");
          entry = { total, parts: [], updatedAt: now() };
          pending.set(uploadId, entry);
        }
        if (!entry || entry.total !== total || index !== entry.parts.length) {
          pending.delete(uploadId);
          throw new Error(
            "Script parts arrived out of order or twice. Send the script again.",
          );
        }
        entry.parts.push(data);
        entry.updatedAt = now();
        return entry.parts.length;
      },
      take(uploadId) {
        expire();
        const entry = pending.get(uploadId);
        pending.delete(uploadId);
        if (!entry || entry.parts.length !== entry.total)
          throw new Error(
            "The script did not arrive completely. Send the script again.",
          );
        const chunks = entry.parts.map((part) =>
          Uint8Array.from(atob(part), (character) => character.charCodeAt(0)),
        );
        const bytes = new Uint8Array(
          chunks.reduce((size, chunk) => size + chunk.length, 0),
        );
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let value;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          throw damaged();
        }
        if (
          typeof value?.title !== "string" ||
          !Array.isArray(value.uploads) ||
          !value.uploads.length ||
          value.uploads.length > 4
        )
          throw damaged();
        return {
          title: value.title,
          uploads: value.uploads.map((upload) => ({
            keys: upload?.keys,
            funscript: parseFunscript(JSON.stringify(upload?.funscript)),
          })),
        };
      },
    };
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
    sendScriptParts,
    createScriptAssembler,
  });
})();
