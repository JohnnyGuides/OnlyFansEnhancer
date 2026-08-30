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

export default [
  {
    ignores: ["dist/**", "node_modules/**", "store/**"],
  },
  {
    files: ["creator-tools/**/*.js", "options.js", "realbooru-parser.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: browserGlobals,
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
    files: ["creator-tools/**/*.js"],
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
];
