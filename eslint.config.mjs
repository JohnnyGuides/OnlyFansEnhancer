import js from "@eslint/js";
import tseslint from "typescript-eslint";

const browserGlobals = Object.fromEntries(
  [
    "AbortController",
    "CSS",
    "DOMParser",
    "Element",
    "Event",
    "FileReader",
    "FaceDetector",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "HTMLElement",
    "Image",
    "InputEvent",
    "KeyboardEvent",
    "MutationObserver",
    "Node",
    "OffscreenCanvas",
    "PerformanceObserver",
    "URL",
    "URLSearchParams",
    "cancelAnimationFrame",
    "chrome",
    "clearInterval",
    "clearTimeout",
    "confirm",
    "console",
    "createImageBitmap",
    "crypto",
    "document",
    "fetch",
    "getComputedStyle",
    "globalThis",
    "location",
    "performance",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
    "window",
  ].map((name) => [name, "readonly"]),
);

// Extension pages, workspace pages and content scripts share the DOM globals.
const pageGlobals = {
  ...browserGlobals,
  ...Object.fromEntries(
    [
      "BroadcastChannel",
      "Blob",
      "CustomEvent",
      "File",
      "Option",
      "ResizeObserver",
      "TextEncoder",
      "WheelEvent",
      "atob",
      "btoa",
      "localStorage",
      "navigator",
      "parent",
      "queueMicrotask",
      "structuredClone",
      "top",
    ].map((name) => [name, "readonly"]),
  ),
};

// Personal service worker: importScripts and the worker-only names, plus the
// DOM names its injected page functions (chrome.scripting.executeScript funcs)
// reference. Those functions run in the page, not in the worker.
const serviceWorkerGlobals = {
  ...pageGlobals,
  ...Object.fromEntries(
    ["importScripts", "self"].map((name) => [name, "readonly"]),
  ),
};

// Store service worker: no injected page functions, so only names a worker
// really has. The DOM names from pageGlobals are switched off.
const workerNames = new Set([
  "AbortController",
  "Blob",
  "BroadcastChannel",
  "File",
  "OffscreenCanvas",
  "TextEncoder",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "chrome",
  "clearInterval",
  "clearTimeout",
  "console",
  "createImageBitmap",
  "crypto",
  "fetch",
  "globalThis",
  "importScripts",
  "location",
  "navigator",
  "performance",
  "queueMicrotask",
  "self",
  "setInterval",
  "setTimeout",
  "structuredClone",
]);
const storeServiceWorkerGlobals = {
  ...Object.fromEntries(
    Object.keys(pageGlobals)
      .filter((name) => !workerNames.has(name))
      .map((name) => [name, "off"]),
  ),
  importScripts: "readonly",
  self: "readonly",
};

// Globals published by the scripts x-teaser.html loads before x-teaser.js.
const xTeaserPageGlobals = {
  ...pageGlobals,
  ...Object.fromEntries(
    ["CreatorCatalogueClient", "CreatorXTeaserContract"].map((name) => [
      name,
      "readonly",
    ]),
  ),
};

const appsScriptGlobals = Object.fromEntries(
  [
    "CacheService",
    "ContentService",
    "HtmlService",
    "LockService",
    "Logger",
    "PropertiesService",
    "Session",
    "SpreadsheetApp",
    "Utilities",
    "console",
  ].map((name) => [name, "readonly"]),
);

export default [
  {
    files: ["tools/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { Buffer: "readonly", process: "readonly", console: "readonly" },
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", ".local/**"],
  },
  {
    files: [
      "extensions/personal/*.js",
      "extensions/personal/workflows/**/*.js",
      "extensions/store/*.js",
      "shared/**/*.js",
    ],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: pageGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    files: ["extensions/personal/background.js"],
    languageOptions: { globals: serviceWorkerGlobals },
  },
  {
    files: ["extensions/store/background.js"],
    languageOptions: { globals: storeServiceWorkerGlobals },
  },
  {
    files: ["extensions/personal/x-teaser.js"],
    languageOptions: { globals: xTeaserPageGlobals },
  },
  {
    // Every file jsconfig.json type-checks gets the typed promise rules.
    files: [
      "extensions/personal/workflows/**/*.js",
      "extensions/personal/realbooru-parser.js",
      "extensions/personal/file-bridge.js",
      "extensions/personal/popup.js",
      "extensions/personal/identity-settings.js",
      "extensions/store/identity-settings.js",
      "extensions/store/popup.js",
      "shared/workspace/host-bridge.js",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./jsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
        },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: false,
        },
      ],
    },
  },
  {
    files: ["integrations/google-apps-script/*.gs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: appsScriptGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      // Top-level functions are Apps Script entry points (doPost) called by the host.
      "no-unused-vars": ["error", { vars: "local", caughtErrors: "none" }],
    },
  },
];
