"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const toolsRoot = path.join(repositoryRoot, "workflows");

const EXPECTED_TOOLS = Object.freeze({
  "c4s-upload.js": "c4sUpload",
  "ph-uploader.js": "phUploader",
  "fansly-prefill.js": "fanslyPrefill",
  "manyvids-autofill.js": "manyvidsAutofill",
  "sheer-tags.js": "sheerTags",
  "onlyfans-auto-select.js": "onlyfansAutoSelect",
  "onlyfans-auto-follow.js": "onlyfansAutoFollow",
  "reddit-banner-censor.js": "redditBannerCensor",
});

const STANDALONE_TOOLS = new Set([
  "c4s-upload.js",
  "sheer-tags.js",
  "onlyfans-auto-select.js",
  "onlyfans-auto-follow.js",
  "reddit-banner-censor.js",
]);

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function loadRegistry() {
  const context = vm.createContext({});
  vm.runInContext(read("workflows/registry.js"), context, {
    filename: "workflows/registry.js",
  });
  return context.CreatorToolkitRegistry;
}

test("personal manifest keeps every integrated creator helper active", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const personalBuild = JSON.stringify(
    require("../../packaging/extensions.json").personal,
  );
  assert.equal(manifest.name, "Creator Workflow Toolkit");
  assert.equal(manifest.version, "0.20.38");
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.equal(
    fs.existsSync(path.join(toolsRoot, "catalogue-proposal.js")),
    true,
  );
  const expectedCreatorOrigins = [
    "https://onlyfans.com/*",
    "https://workspace.clips4sale.com/*",
    "https://pornhub.mainhub.com/*",
    "https://fansly.com/*",
    "https://www.manyvids.com/*",
    "https://my.sheer.com/*",
    "https://www.reddit.com/*",
    "https://sh.reddit.com/*",
    "https://old.reddit.com/*",
    "https://www.redgifs.com/*",
    "https://studio.redgifs.com/*",
    "https://x.com/*",
  ];
  for (const origin of expectedCreatorOrigins) {
    assert.ok(
      manifest.host_permissions.includes(origin),
      `${origin} must be available without a separate options-page grant`,
    );
    assert.equal(manifest.optional_host_permissions.includes(origin), false);
  }
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.equal(
    manifest.optional_host_permissions.includes("http://127.0.0.1/*"),
    false,
  );
  assert.ok(fs.existsSync(path.join(repositoryRoot, "realbooru-parser.html")));
  assert.ok(fs.existsSync(path.join(repositoryRoot, "realbooru-parser.js")));
  for (const fileName of [
    "upload-console.html",
    "upload-console.css",
    "upload-console.js",
    "file-bridge.html",
    "file-bridge.js",
  ]) {
    assert.ok(fs.existsSync(path.join(repositoryRoot, fileName)));
    assert.match(personalBuild, new RegExp(fileName.replace(".", "\\.")));
  }
  assert.ok(fs.existsSync(path.join(toolsRoot, "upload-capability-probe.js")));
  for (const fileName of [
    "catalogue-client.js",
    "catalogue-contract.js",
    "upload-file-bridge.js",
    "local-file-attacher.js",
    "upload-platform-adapters.js",
    "upload-response-observer.js",
    "social-chrome-runtime.js",
    "social-trace-evidence.js",
  ]) {
    assert.ok(fs.existsSync(path.join(toolsRoot, fileName)));
    assert.match(personalBuild, new RegExp(fileName.replace(".", "\\.")));
  }
  const background = read("background.js");
  assert.match(background, /workflows\/local-file-attacher\.js/);
  assert.doesNotMatch(background, /message\.(?:filePath|path)/);
  assert.ok(fs.existsSync(require("../support/paths.cjs").catalogueBridge));
  assert.doesNotMatch(personalBuild, /catalogue-bridge\.gs/);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["file-bridge.html", "file-bridge.js"],
      matches: [
        "https://pornhub.mainhub.com/*",
        "https://onlyfans.com/*",
        "https://fansly.com/*",
        "https://www.manyvids.com/*",
        "https://studio.redgifs.com/*",
        "https://x.com/*",
      ],
    },
  ]);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "identity-settings.js",
    "core.js",
    "content.js",
  ]);

  const expectedOptionalOrigins = [
    "https://gelbooru.com/*",
    "https://*.gelbooru.com/*",
    "https://realbooru.com/*",
    "https://script.google.com/*",
    "https://script.googleusercontent.com/*",
  ];
  for (const origin of expectedOptionalOrigins) {
    assert.ok(
      manifest.optional_host_permissions.includes(origin),
      `${origin} must remain optional`,
    );
  }
  assert.equal(
    manifest.optional_host_permissions.some((origin) =>
      origin.startsWith("http://workspace.clips4sale.com"),
    ),
    false,
  );
});

test("every adapter parses and remains dynamically registered", () => {
  const background = read("background.js");
  for (const [fileName, settingKey] of Object.entries(EXPECTED_TOOLS)) {
    const source = read(`workflows/${fileName}`);
    assert.doesNotThrow(() => new vm.Script(source, { filename: fileName }));
    if (STANDALONE_TOOLS.has(fileName)) {
      assert.match(source, /toolkit\.mountTool\(\{/);
      assert.match(source, new RegExp(`id:\\s*"${settingKey}"`));
    }
    assert.match(
      background,
      new RegExp(`workflows/${fileName.replace(".", "\\.")}`),
    );
  }
  for (const sharedFile of [
    "registry.js",
    "common.js",
    "onlyfans-list-common.js",
  ]) {
    assert.doesNotThrow(
      () =>
        new vm.Script(read(`workflows/${sharedFile}`), {
          filename: sharedFile,
        }),
    );
  }
});

test("the registry defaults every integrated helper on without autorunning mutations", () => {
  const registry = loadRegistry();
  const defaults = registry.normalizeSettings({}).value;
  for (const [id, definition] of Object.entries(registry.TOOL_DEFINITIONS)) {
    assert.equal(typeof defaults.tools[id].enabled, "boolean");
    assert.equal(typeof defaults.tools[id].autorun, "boolean");
    assert.equal(defaults.tools[id].enabled, true, `${id} must default on`);
    if (definition.mutates) {
      assert.equal(
        defaults.tools[id].autorun,
        false,
        `${id} must never autorun`,
      );
    }
  }
  assert.equal(defaults.tools.redditBannerCensor.enabled, true);
  assert.equal(defaults.tools.redditBannerCensor.autorun, true);
  assert.deepEqual(
    {
      price: defaults.profiles.manyvidsAutofill.priceModeExpectedLabel,
      membership: defaults.profiles.manyvidsAutofill.membershipExpectedLabel,
      premium: defaults.profiles.manyvidsAutofill.premiumExpectedLabel,
    },
    {
      price: "Set Your Price",
      membership: "This vid is not included in your Vid Bundle",
      premium: "Include this Vid to Premium",
    },
  );

  const malformed = registry.normalizeSettings({
    tools: {
      c4sUpload: { enabled: "yes", autorun: true },
      typoTool: { enabled: true },
    },
  }).value;
  assert.equal(malformed.tools.c4sUpload.enabled, true);
  assert.equal(malformed.tools.c4sUpload.autorun, false);
  assert.equal(Object.hasOwn(malformed.tools, "typoTool"), false);
});

test("schema 2 enables every helper once and schema 3 preserves later choices", () => {
  const registry = loadRegistry();
  const oldSettings = registry.normalizeSettings({
    schemaVersion: 2,
    tools: Object.fromEntries(
      Object.keys(registry.TOOL_DEFINITIONS).map((id) => [
        id,
        { enabled: false, autorun: false },
      ]),
    ),
    profiles: { fanslyPrefill: { message: "kept" } },
  }).value;

  assert.equal(oldSettings.schemaVersion, 3);
  assert.equal(
    Object.values(oldSettings.tools).every((tool) => tool.enabled === true),
    true,
  );
  assert.equal(oldSettings.profiles.fanslyPrefill.message, "kept");

  const changedInUploader = registry.normalizeSettings({
    ...oldSettings,
    tools: {
      ...oldSettings.tools,
      c4sUpload: { enabled: false, autorun: false },
    },
  }).value;
  assert.equal(changedInUploader.tools.c4sUpload.enabled, false);
  assert.equal(changedInUploader.tools.fanslyPrefill.enabled, true);
});

test("Pornhub series mappings retain only bounded exact preset names", () => {
  const registry = loadRegistry();
  const excessive = Object.fromEntries(
    Array.from({ length: 105 }, (_, index) => [
      `Series ${String(index).padStart(3, "0")}`,
      "Straight",
    ]),
  );
  const normalized = registry.normalizeSettings({
    profiles: {
      phUploader: {
        seriesPresets: {
          " GameSync Season Two ": "Bisexual Male",
          Unknown: "Not A Preset",
          ...excessive,
        },
      },
    },
  });

  assert.equal(
    normalized.value.profiles.phUploader.seriesPresets["GameSync Season Two"],
    "Bisexual Male",
  );
  assert.equal(
    Object.hasOwn(
      normalized.value.profiles.phUploader.seriesPresets,
      "Unknown",
    ),
    false,
  );
  assert.equal(
    Object.keys(normalized.value.profiles.phUploader.seriesPresets).length,
    100,
  );
  assert.match(normalized.errors.join(" "), /unknown Pornhub preset/i);
});

test("profile validation rejects destructive or malformed policy", () => {
  const registry = loadRegistry();
  const invalid = registry.normalizeSettings({
    profiles: {
      sheerTags: { mode: "erase-everything", tags: [] },
      manyvidsAutofill: { price: "free" },
      onlyfansAutoFollow: {
        batchLimit: 10000,
        delayMs: 1,
        maxDurationMs: 99999999,
        maxRetries: 50,
      },
    },
  });
  assert.ok(invalid.errors.length >= 5);
  assert.equal(invalid.value.profiles.sheerTags.mode, "append");
  assert.equal(invalid.value.profiles.manyvidsAutofill.price, "19.99");
  assert.equal(invalid.value.profiles.onlyfansAutoFollow.batchLimit, 50);
  assert.equal(invalid.value.profiles.onlyfansAutoFollow.delayMs, 1000);
});

test("known unsafe userscript patterns and corrupt taxonomy are absent", () => {
  const toolFiles = fs
    .readdirSync(toolsRoot)
    .filter((fileName) => fileName.endsWith(".js"));
  const searchable = toolFiles
    .map((fileName) => fs.readFileSync(path.join(toolsRoot, fileName), "utf8"))
    .join("\n");

  assert.equal(fs.existsSync(path.join(toolsRoot, "c4s-categories.js")), false);
  assert.doesNotMatch(
    searchable,
    /FOR TESTING ONLY|GLAWIVUR CARIUUINS|WIA LURUALIIVIN|VULIIVIIVL GLUT/,
  );
  assert.doesNotMatch(searchable, /window\.jQuery/);
  assert.doesNotMatch(searchable, /closeAnyOverlay/);
  assert.doesNotMatch(searchable, /clickAdd|ADD_BUTTON_SELECTOR/);
  assert.doesNotMatch(searchable, /pickBestItem|selectFirstSuggestion/);
  assert.doesNotMatch(
    searchable,
    /Bypass All Shortlinks|bypass\.city|adbypass\.org/i,
  );
  assert.doesNotMatch(searchable, /keypress|keyCode|which/);
});

test("runtime and documentation sources are valid UTF-8 without mojibake", () => {
  const sourceFiles = [
    "background.js",
    "realbooru-parser.html",
    "realbooru-parser.js",
    "manifest.json",
    "options.html",
    "options.js",
    "PRIVACY.md",
    ...fs
      .readdirSync(toolsRoot)
      .filter((fileName) => fileName.endsWith(".js"))
      .map((fileName) => `workflows/${fileName}`),
  ];

  for (const relativePath of sourceFiles) {
    const source = read(relativePath);
    assert.doesNotMatch(
      source,
      /\uFFFD|[\u0080-\u009F]|(?:Ã.|Â.|â€|â†|ï¿½)/u,
      `${relativePath} contains replacement, C1-control, or common mojibake text`,
    );
  }
});

test("OnlyFans actions are capped, confirmed, stable-ID based, and manually committed", () => {
  const registry = loadRegistry();
  const follow = read("workflows/onlyfans-auto-follow.js");
  const select = read("workflows/onlyfans-auto-select.js");
  const shared = read("workflows/onlyfans-list-common.js");
  assert.ok(registry.DEFAULT_PROFILES.onlyfansAutoFollow.batchLimit <= 20);
  assert.ok(registry.DEFAULT_PROFILES.onlyfansAutoFollow.delayMs >= 1000);
  assert.match(follow, /showPlan/);
  assert.match(follow, /visibleBlockingDialogs/);
  assert.match(follow, /followingState/);
  assert.match(select, /click OnlyFans Add manually/);
  assert.doesNotMatch(select, /\.g-btn/);
  assert.match(shared, /data-fim-masked-handle/);
  assert.match(shared, /data-fim-original-href/);
});

test("the Chrome Web Store edition remains the narrow identity-mask product", () => {
  const storeManifest = JSON.parse(
    fs.readFileSync(
      path.join(require("../support/paths.cjs").storeRoot, "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(storeManifest.name, "Fan Identity Mask");
  assert.deepEqual(storeManifest.host_permissions, ["https://onlyfans.com/*"]);
  assert.equal(storeManifest.permissions.includes("scripting"), false);
  assert.equal(
    storeManifest.content_scripts.some((entry) =>
      (entry.js || []).some((fileName) => fileName.includes("workflows")),
    ),
    false,
  );
});
