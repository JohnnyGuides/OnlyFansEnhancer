"use strict";

// Edition defaults are loaded before the shared masking content script.
globalThis.FanIdentityMaskDefaults = Object.freeze({
  enabled: false,
  consentAccepted: false,
  ownHandles: ["johnny_guides"],
});
