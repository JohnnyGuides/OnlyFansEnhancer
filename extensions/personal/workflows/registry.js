(() => {
  "use strict";

  if (globalThis.CreatorToolkitRegistry) return;

  const STORAGE_KEY = "creatorToolkitV2";
  const LEGACY_STORAGE_KEY = "creatorToolkitV1";
  const ACTION_LOG_KEY = "creatorToolkitActionLogV1";
  const SCHEMA_VERSION = 3;

  const TOOL_DEFINITIONS = Object.freeze({
    uploadTraceRecorder: Object.freeze({
      id: "uploadTraceRecorder",
      title: "Upload trace recorder",
      mutates: false,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    c4sUpload: Object.freeze({
      id: "c4sUpload",
      title: "Clips4Sale upload assistant",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    phUploader: Object.freeze({
      id: "phUploader",
      title: "Pornhub uploader presets",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    fanslyPrefill: Object.freeze({
      id: "fanslyPrefill",
      title: "Fansly post prefill",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    manyvidsAutofill: Object.freeze({
      id: "manyvidsAutofill",
      title: "ManyVids edit assistant",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    sheerTags: Object.freeze({
      id: "sheerTags",
      title: "Sheer tag assistant",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    onlyfansAutoSelect: Object.freeze({
      id: "onlyfansAutoSelect",
      title: "OnlyFans list selection assistant",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    onlyfansAutoFollow: Object.freeze({
      id: "onlyfansAutoFollow",
      title: "OnlyFans follow assistant",
      mutates: true,
      defaultEnabled: true,
      defaultAutorun: false,
    }),
    redditBannerCensor: Object.freeze({
      id: "redditBannerCensor",
      title: "Reddit banner censor",
      mutates: false,
      defaultEnabled: true,
      defaultAutorun: true,
    }),
  });

  const DEFAULT_PROFILES = Object.freeze({
    c4sUpload: Object.freeze({
      category: "",
      relatedCategories: Object.freeze([]),
      performer: "Johnny Guides",
      audience: "Bisexual",
      videoType: "1080p",
      prices: Object.freeze({
        Teaser: "2.99",
        "1080p": "14.99",
        "4k": "19.99",
        Cumshots: "9.99",
      }),
      descriptionPrefixes: Object.freeze({
        Teaser:
          "NOTE: this is only the teaser and will be free in two weeks! supporter edition.\n\n",
        "1080p": "",
        "4k": "",
        Cumshots:
          "–note: this episode only includes the cumshots/gameplay-cumshots of the full episode, i highly advise buying the full version first!–\n\n",
      }),
      keywordsByAudience: Object.freeze({
        Bisexual: Object.freeze([
          "Johnny Guides",
          "Solo Male",
          "Interactive",
          "POV",
          "JOI",
          "Edging",
          "Orgasm Control",
          "ASMR",
          "Moaning",
          "Gooning",
          "Gaming",
          "Twink",
          "Femboy",
          "Robot",
          "Stud",
        ]),
        Gay: Object.freeze([
          "Whimpering",
          "Male/Male",
          "Twink",
          "Jock",
          "Daddy",
          "Robot",
          "Hentai",
          "Femboy",
          "Cock Worship",
          "JOI",
          "Edging",
          "Ruined Orgasm",
          "Cum Play",
          "Mutual Masturbation",
          "Johnny Guides",
        ]),
        Lesbian: Object.freeze([
          "Moaning",
          "Gaming",
          "Bondage",
          "Girl/Girl",
          "Tribbing",
          "Scissoring",
          "Strap-On",
          "Lesbian Kissing",
          "Squirting",
          "Hentai",
          "Edging",
          "JOI",
          "Femdom",
          "Robot",
          "Johnny Guides",
        ]),
        Straight: Object.freeze([
          "Femdom",
          "Gaming",
          "JOI",
          "Edging",
          "Hentai",
          "Ruined Orgasm",
          "Robot",
          "Assisted Masturbation",
          "Masturbation",
          "Fleshlight",
          "Premature Ejaculation",
          "Cum Countdown",
          "ASMR",
          "Gooning",
          "Johnny Guides",
        ]),
        Transgender: Object.freeze([
          "Fucking Machines",
          "Trans Woman",
          "Trans Man",
          "Trans Solo",
          "Hentai",
          "Bondage",
          "Trans Domination",
          "Edging",
          "Ruined Orgasm",
          "Gaming",
          "Cock Worship",
          "Robot",
          "Uncut",
          "Interactive",
          "Johnny Guides",
        ]),
      }),
    }),
    phUploader: Object.freeze({
      presets: Object.freeze({
        Straight: Object.freeze({
          orientation: "Straight",
          tags: Object.freeze([
            "Femdom",
            "Gaming",
            "JOI",
            "Edging",
            "Hentai",
            "Ruined Orgasm",
            "Robot",
            "Assisted Masturbation",
            "Masturbation",
            "Fleshlight",
            "Premature Ejaculation",
            "Cum Countdown",
            "ASMR",
            "Gooning",
            "Johnny Guides",
          ]),
          categories: Object.freeze([
            "fetish",
            "solo male",
            "reaction",
            "cartoon",
            "pov",
            "gaming",
            "hentai",
            "masturbation",
          ]),
        }),
        Gay: Object.freeze({
          orientation: "Gay",
          tags: Object.freeze([
            "Whimpering",
            "Male/Male",
            "Twink",
            "Jock",
            "Daddy",
            "Robot",
            "Hentai",
            "Femboy",
            "Cock Worship",
            "JOI",
            "Edging",
            "Ruined Orgasm",
            "Cum Play",
            "Mutual Masturbation",
            "Johnny Guides",
          ]),
          categories: Object.freeze([
            "cartoon",
            "daddy",
            "gaming",
            "japanese",
            "solo male",
            "straight guys",
            "uncut",
            "twink",
            "reaction",
          ]),
        }),
        Lesbian: Object.freeze({
          orientation: "Lesbian",
          tags: Object.freeze([
            "Moaning",
            "Gaming",
            "Bondage",
            "Girl/Girl",
            "Tribbing",
            "Scissoring",
            "Strap-On",
            "Lesbian Kissing",
            "Squirting",
            "Hentai",
            "Edging",
            "JOI",
            "Femdom",
            "Robot",
            "Johnny Guides",
          ]),
          categories: Object.freeze([
            "hentai",
            "uncensored",
            "cartoon",
            "toys",
            "reaction",
            "gaming",
            "cosplay",
          ]),
        }),
        "Bisexual Male": Object.freeze({
          orientation: "Bisexual Male",
          tags: Object.freeze([
            "Johnny Guides",
            "Solo Male",
            "Interactive",
            "POV",
            "JOI",
            "Edging",
            "Orgasm Control",
            "ASMR",
            "Moaning",
            "Gooning",
            "Gaming",
            "Twink",
            "Femboy",
            "Robot",
            "Stud",
          ]),
          categories: Object.freeze([
            "solo male",
            "reality",
            "reaction",
            "podcast",
            "masturbation",
            "hardcore",
            "gaming",
            "cosplay",
          ]),
        }),
        Transgender: Object.freeze({
          orientation: "Transgender",
          tags: Object.freeze([
            "Fucking Machines",
            "Trans Woman",
            "Trans Man",
            "Trans Solo",
            "Hentai",
            "Bondage",
            "Trans Domination",
            "Edging",
            "Ruined Orgasm",
            "Gaming",
            "Cock Worship",
            "Robot",
            "Uncut",
            "Interactive",
            "Johnny Guides",
          ]),
          categories: Object.freeze([
            "transgender",
            "trans male",
            "toys",
            "solo male",
            "role play",
            "reaction",
            "hardcore",
            "cosplay",
          ]),
        }),
      }),
      seriesPresets: Object.freeze({}),
    }),
    fanslyPrefill: Object.freeze({
      message:
        "#GameSync #JohnnyGuides #Season2 #Solo #SoloMale #Masturbation #Hentai #Anime #Masturbator #Moaning #Whimpering #MaleMoaning #ASMR #RuinedOrgasm #Edging #twink #gaming #JOI #TryNotToCum #Gooning #FemdomControl #Femdom #Femboy #FemboyGamer #POV",
      fillMode: "empty-only",
      toggles: Object.freeze({
        "Post to FYP": false,
        "Post to Walls": true,
        "Lock Replies": false,
      }),
    }),
    manyvidsAutofill: Object.freeze({
      coPerformer: "No",
      price: "19.99",
      launchTimeLabel: "03:00 PM",
      launchTimeValue: "15:00",
      priceModeSelector: "#free_vid_0",
      priceModeExpectedLabel: "Set Your Price",
      launchModeSelector: "#launchCustom",
      launchModeExpectedLabel: "Custom launch date",
      membershipSelector: "#membership3",
      membershipExpectedLabel: "This vid is not included in your Vid Bundle",
      premiumSelector: "#premium2",
      premiumExpectedLabel: "Include this Vid to Premium",
      tags: Object.freeze([
        "MoaningFetish",
        "ASMR",
        "Masturbation",
        "FuckMachine",
        "CockTease",
        "RuinedOrgasms",
        "Toys",
        "Twink",
        "EdgePlay",
        "SoloMale",
      ]),
    }),
    sheerTags: Object.freeze({
      mode: "append",
      requireAllForReplace: true,
      tags: Object.freeze([
        "0% pussy",
        "3D",
        "alien girl",
        "busty hentai",
        "CBT",
        "cock cage",
        "cock rubbing",
        "commented gameplay",
        "daddy",
        "dating game",
        "DL Site",
        "domination",
        "ecchi",
        "erogames",
        "for women",
        "futa",
        "Gangbang (3D)",
        "goth",
        "guy-guy",
        "Japanese hentai game",
        "male masseur",
        "male solo anal",
        "maledom",
        "manga",
        "moaning",
        "multiple orgasms",
        "naked gaming",
        "Netorare",
        "Oppai",
        "orgasm deprivation",
        "PC game",
        "playing with 2 toys",
        "porn game",
        "prostitute",
        "robot (3D)",
        "roleplay",
        "RPG maker",
        "sex toy",
        "small cock",
        "teen (3d)",
      ]),
    }),
    onlyfansAutoSelect: Object.freeze({
      batchLimit: 50,
      delayMs: 250,
      maxDurationMs: 120000,
      maxRetries: 1,
    }),
    onlyfansAutoFollow: Object.freeze({
      batchLimit: 20,
      delayMs: 1200,
      maxDurationMs: 120000,
      maxRetries: 1,
    }),
    redditBannerCensor: Object.freeze({
      failClosed: true,
      label: "Banner censored",
    }),
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeString(value, fallback, maximumLength = 5000) {
    return typeof value === "string" ? value.slice(0, maximumLength) : fallback;
  }

  function normalizeStringList(value, fallback, maximumItems = 100) {
    if (!Array.isArray(value)) return [...fallback];
    const seen = new Set();
    const result = [];
    for (const candidate of value) {
      if (typeof candidate !== "string") continue;
      const item = candidate.trim().slice(0, 200);
      const key = item.normalize("NFKC").toLocaleLowerCase("en-US");
      if (!item || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= maximumItems) break;
    }
    return result;
  }

  function clampInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function normalizePrice(value, fallback) {
    const candidate = normalizeString(value, fallback, 20).trim();
    return /^(?:0|[1-9]\d{0,5})(?:\.\d{2})$/.test(candidate)
      ? candidate
      : fallback;
  }

  function mergeProfiles(rawProfiles, errors) {
    const profiles = clone(DEFAULT_PROFILES);
    if (!isPlainObject(rawProfiles)) return profiles;

    const c4s = rawProfiles.c4sUpload;
    if (isPlainObject(c4s)) {
      profiles.c4sUpload.category = normalizeString(
        c4s.category,
        profiles.c4sUpload.category,
        200,
      ).trim();
      profiles.c4sUpload.relatedCategories = normalizeStringList(
        c4s.relatedCategories,
        profiles.c4sUpload.relatedCategories,
        10,
      );
      profiles.c4sUpload.performer = normalizeString(
        c4s.performer,
        profiles.c4sUpload.performer,
        200,
      ).trim();
      profiles.c4sUpload.audience = normalizeString(
        c4s.audience,
        profiles.c4sUpload.audience,
        100,
      ).trim();
      profiles.c4sUpload.videoType = normalizeString(
        c4s.videoType,
        profiles.c4sUpload.videoType,
        100,
      ).trim();
      if (isPlainObject(c4s.prices)) {
        for (const key of Object.keys(profiles.c4sUpload.prices)) {
          const normalizedPrice = normalizePrice(
            c4s.prices[key],
            profiles.c4sUpload.prices[key],
          );
          if (
            Object.hasOwn(c4s.prices, key) &&
            normalizedPrice !== String(c4s.prices[key]).trim()
          ) {
            errors.push(
              `Clips4Sale price ${key} must be a nonnegative decimal with exactly two places.`,
            );
          }
          profiles.c4sUpload.prices[key] = normalizedPrice;
        }
      }
      if (isPlainObject(c4s.descriptionPrefixes)) {
        for (const key of Object.keys(profiles.c4sUpload.descriptionPrefixes)) {
          profiles.c4sUpload.descriptionPrefixes[key] = normalizeString(
            c4s.descriptionPrefixes[key],
            profiles.c4sUpload.descriptionPrefixes[key],
            5000,
          );
        }
      }
      if (isPlainObject(c4s.keywordsByAudience)) {
        for (const key of Object.keys(profiles.c4sUpload.keywordsByAudience)) {
          profiles.c4sUpload.keywordsByAudience[key] = normalizeStringList(
            c4s.keywordsByAudience[key],
            profiles.c4sUpload.keywordsByAudience[key],
            25,
          );
        }
      }
    }

    const ph = rawProfiles.phUploader;
    if (isPlainObject(ph)) {
      if (isPlainObject(ph.presets)) {
        for (const [name, preset] of Object.entries(ph.presets)) {
          if (!isPlainObject(preset) || !name.trim()) continue;
          profiles.phUploader.presets[name.slice(0, 100)] = {
            orientation: normalizeString(preset.orientation, name, 100).trim(),
            tags: normalizeStringList(preset.tags, [], 50),
            categories: normalizeStringList(preset.categories, [], 30),
          };
        }
      }
      if (isPlainObject(ph.seriesPresets)) {
        profiles.phUploader.seriesPresets = {};
        for (const [rawSeries, rawPreset] of Object.entries(ph.seriesPresets)) {
          if (Object.keys(profiles.phUploader.seriesPresets).length >= 100)
            break;
          const series = normalizeString(rawSeries, "", 200).trim();
          const preset = normalizeString(rawPreset, "", 100).trim();
          if (!series) continue;
          if (!Object.hasOwn(profiles.phUploader.presets, preset)) {
            errors.push(
              `Pornhub series mapping “${series}” names an unknown Pornhub preset.`,
            );
            continue;
          }
          profiles.phUploader.seriesPresets[series] = preset;
        }
      }
    }

    const fansly = rawProfiles.fanslyPrefill;
    if (isPlainObject(fansly)) {
      profiles.fanslyPrefill.message = normalizeString(
        fansly.message,
        profiles.fanslyPrefill.message,
        10000,
      );
      if (
        Object.hasOwn(fansly, "fillMode") &&
        !["replace", "empty-only"].includes(fansly.fillMode)
      ) {
        errors.push("Fansly fillMode must be “empty-only” or “replace”.");
      }
      profiles.fanslyPrefill.fillMode =
        fansly.fillMode === "replace" ? "replace" : "empty-only";
      if (isPlainObject(fansly.toggles)) {
        for (const key of Object.keys(profiles.fanslyPrefill.toggles)) {
          if (typeof fansly.toggles[key] === "boolean") {
            profiles.fanslyPrefill.toggles[key] = fansly.toggles[key];
          }
        }
      }
    }

    const manyvids = rawProfiles.manyvidsAutofill;
    if (isPlainObject(manyvids)) {
      profiles.manyvidsAutofill.coPerformer = normalizeString(
        manyvids.coPerformer,
        profiles.manyvidsAutofill.coPerformer,
        100,
      ).trim();
      const manyvidsPrice = normalizePrice(
        manyvids.price,
        profiles.manyvidsAutofill.price,
      );
      if (
        Object.hasOwn(manyvids, "price") &&
        manyvidsPrice !== String(manyvids.price).trim()
      ) {
        errors.push(
          "ManyVids price must be a nonnegative decimal with exactly two places.",
        );
      }
      profiles.manyvidsAutofill.price = manyvidsPrice;
      profiles.manyvidsAutofill.launchTimeLabel = normalizeString(
        manyvids.launchTimeLabel,
        profiles.manyvidsAutofill.launchTimeLabel,
        100,
      ).trim();
      profiles.manyvidsAutofill.launchTimeValue = normalizeString(
        manyvids.launchTimeValue,
        profiles.manyvidsAutofill.launchTimeValue,
        100,
      ).trim();
      for (const key of [
        "priceModeExpectedLabel",
        "launchModeExpectedLabel",
        "membershipExpectedLabel",
        "premiumExpectedLabel",
      ]) {
        const fallback = profiles.manyvidsAutofill[key];
        const normalized = normalizeString(manyvids[key], fallback, 200).trim();
        profiles.manyvidsAutofill[key] =
          key === "launchModeExpectedLabel"
            ? normalized || fallback
            : normalized;
      }
      profiles.manyvidsAutofill.tags = normalizeStringList(
        manyvids.tags,
        profiles.manyvidsAutofill.tags,
        20,
      );
    }

    const sheer = rawProfiles.sheerTags;
    if (isPlainObject(sheer)) {
      if (
        Object.hasOwn(sheer, "mode") &&
        !["append", "replace"].includes(sheer.mode)
      ) {
        errors.push("Sheer mode must be “append” or “replace”.");
      }
      profiles.sheerTags.mode = sheer.mode === "replace" ? "replace" : "append";
      profiles.sheerTags.requireAllForReplace =
        sheer.requireAllForReplace !== false;
      profiles.sheerTags.tags = normalizeStringList(
        sheer.tags,
        profiles.sheerTags.tags,
        100,
      );
    }

    for (const toolId of ["onlyfansAutoSelect", "onlyfansAutoFollow"]) {
      const raw = rawProfiles[toolId];
      if (!isPlainObject(raw)) continue;
      const limits =
        toolId === "onlyfansAutoFollow"
          ? {
              batchLimit: [1, 50],
              delayMs: [1000, 10000],
              maxDurationMs: [10000, 300000],
              maxRetries: [0, 2],
            }
          : {
              batchLimit: [1, 200],
              delayMs: [100, 5000],
              maxDurationMs: [10000, 300000],
              maxRetries: [0, 2],
            };
      for (const [key, [minimum, maximum]] of Object.entries(limits)) {
        if (Object.hasOwn(raw, key)) {
          const number = Number(raw[key]);
          if (
            !Number.isInteger(number) ||
            number < minimum ||
            number > maximum
          ) {
            errors.push(
              `${toolId}.${key} must be an integer from ${minimum} to ${maximum}.`,
            );
          }
        }
        profiles[toolId][key] = clampInteger(
          raw[key],
          profiles[toolId][key],
          minimum,
          maximum,
        );
      }
    }

    const reddit = rawProfiles.redditBannerCensor;
    if (isPlainObject(reddit)) {
      profiles.redditBannerCensor.failClosed = reddit.failClosed !== false;
      profiles.redditBannerCensor.label = normalizeString(
        reddit.label,
        profiles.redditBannerCensor.label,
        100,
      ).trim();
    }

    if (
      profiles.sheerTags.mode === "replace" &&
      !profiles.sheerTags.tags.length
    ) {
      errors.push("Sheer replace mode requires at least one tag.");
      profiles.sheerTags.mode = "append";
    }

    return profiles;
  }

  function normalizeSettings(rawSettings) {
    const errors = [];
    const raw = isPlainObject(rawSettings) ? rawSettings : {};
    const activateIntegratedHelpers = Number(raw.schemaVersion || 0) < 3;
    const tools = {};

    for (const [id, definition] of Object.entries(TOOL_DEFINITIONS)) {
      const candidate = isPlainObject(raw.tools) ? raw.tools[id] : null;
      tools[id] = {
        enabled: activateIntegratedHelpers
          ? definition.defaultEnabled
          : candidate && typeof candidate.enabled === "boolean"
            ? candidate.enabled
            : definition.defaultEnabled,
        autorun:
          !definition.mutates &&
          candidate &&
          typeof candidate.autorun === "boolean"
            ? candidate.autorun
            : definition.defaultAutorun,
      };
    }

    return {
      value: {
        schemaVersion: SCHEMA_VERSION,
        tools,
        profiles: mergeProfiles(raw.profiles, errors),
      },
      errors,
    };
  }

  function migrateLegacySettings(legacy) {
    const raw = { schemaVersion: 2, tools: {}, profiles: {} };
    const source = isPlainObject(legacy) ? legacy : {};
    for (const [id, definition] of Object.entries(TOOL_DEFINITIONS)) {
      raw.tools[id] = {
        enabled: Object.hasOwn(source, id)
          ? source[id] === true
          : definition.defaultEnabled,
        autorun: !definition.mutates && definition.defaultAutorun,
      };
    }
    return normalizeSettings(raw).value;
  }

  globalThis.CreatorToolkitRegistry = Object.freeze({
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    ACTION_LOG_KEY,
    SCHEMA_VERSION,
    TOOL_DEFINITIONS,
    DEFAULT_PROFILES,
    clone,
    isPlainObject,
    normalizeSettings,
    migrateLegacySettings,
  });
})();
