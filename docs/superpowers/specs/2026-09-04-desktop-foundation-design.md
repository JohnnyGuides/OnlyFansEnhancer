# Desktop Foundation Design

**Parent design:** `docs/superpowers/specs/2026-09-04-creator-workflow-platform-design.md`

## Goal

Create the smallest durable Windows foundation for the approved desktop-first
architecture without replacing or weakening the current Chrome uploader. The
milestone proves one shared web UI can run inside a desktop shell, one local
agent can answer both desktop and Chrome, the personal extension can attach a
local file through Chrome's supported debugger backend, and a per-user package
can be staged for an installer.

No real platform post, Google Sheet write, registry mutation, installer run, or
real-media move is part of automated verification.

## Existing behavior to preserve

The current personal extension remains the publishing authority during this
milestone. Its exact selectors, single confirmation, monotonic
`submitAttempted` checkpoint, restart recovery, link capture, and no-repost
behavior are unchanged. The Chrome Web Store edition remains the narrow
identity-mask product.

The existing `CreatorTeaserNativeHost` continues to own its receipt-protected
X teaser audit and final move until a later migration explicitly replaces it.
The new desktop bridge is additive and cannot perform those operations.

## Process ownership

One per-user `OFEnhancer.Desktop.exe` process owns the desktop window and local
agent. The process remains available when the window is closed and exits only
through its tray command. It is the only process allowed to own the later
SQLite connection, scheduler, file inventory, and media queue.

The Chrome native messaging executable is a short-lived relay. It reads one
bounded native message, forwards it to the desktop process through a
current-user-only named pipe, returns one bounded response, and exits. It has
no database, schedule, platform logic, or local state.

Milestone 1 supports one read-only operation:

```json
{ "protocolVersion": 1, "requestId": "<uuid>", "operation": "getStatus" }
```

The response contains the same request ID, product version, protocol version,
and the capabilities `desktop-shell`, `native-bridge`, and
`local-file-attach`. Unknown versions, operations, oversized frames, malformed
JSON, duplicate request IDs, and non-current-user pipe clients fail closed.

## Shared desktop UI

The shared frontend lives under `app/` as plain HTML, CSS, and JavaScript. It
does not introduce a framework. WebView2 maps that folder to
`https://app.ofenhancer.local/` rather than granting arbitrary `file://`
access. The same folder is packaged with the personal extension.

The first shell is functional but deliberately narrow:

- persistent navigation for Catalogue, Uploads, Teasers, Attention, and
  Settings;
- a truthful connection/status summary from the local agent;
- an Uploads action that opens the existing Chrome uploader rather than
  recreating it;
- no synthetic catalogue rows, metrics, or fake platform success;
- neutral tray state and no sensitive notification text.

The shell inherits the existing dark uploader's typography, spacing, color,
and control language. It is an extension of the incumbent interface, not a
rebrand. Desktop-only transport uses `window.chrome.webview`; extension
transport uses `chrome.runtime`. Both implement the same `request(operation,
payload)` promise contract.

## Local file attachment proof

The personal manifest adds the mandatory `debugger` permission. The store
manifest does not change.

`creator-tools/local-file-attacher.js` exposes one narrow operation that:

1. validates one positive tab ID, one bounded exact selector, and one absolute
   Windows path;
2. reads the current tab and accepts only the caller-provided exact origin
   allow-list;
3. attaches Chrome Debugger Protocol 1.3;
4. enables DOM inspection, resolves exactly one `input[type=file]`, and rejects
   every other target;
5. invokes `DOM.setFileInputFiles` with the path;
6. dispatches the normal input and change events on that exact element; and
7. detaches in `finally`, including every failure path.

The function never logs, persists, echoes, or includes the local path in an
error. It does not submit a form or click a platform control.

The real-Chrome proof uses an isolated Chromium profile, a temporary local
page, and a temporary inert file. The service worker calls the internal module
directly, so no production runtime message exposes arbitrary path attachment.
The test asserts the page received the file and both events, then removes its
temporary data. The loopback origin is passed only to the internal test call;
it is not added to manifest host permissions.

## Packaging and extension identity

The desktop publish is self-contained for `win-x64`. The staged package
contains the desktop executable, native bridge, shared UI, personal extension,
logo, version manifest, license notices, and installer input. User media,
tokens, Sheets data, test fixtures, and source-control metadata are excluded.

The Inno Setup definition is per-user and uses a stable AppId. It supports
fresh install, update, repair/reinstall, and uninstall while preserving user
data by default. Native Messaging registration and startup entries use HKCU.
Automated verification stages the package but does not write the registry or
run the installer.

Chrome does not permit a normal local installer to silently enable an unpacked
extension. The installer therefore opens a short guided load/update page. It
does not apply enterprise policy.

The currently loaded extension has no recoverable manifest public key. It
keeps running from the repository during this milestone. A later migration
exports bounded settings and history, guides the user to load the stable
installer-owned path, verifies the import, and only then retires the old
identity. Milestone 1 does not claim that transition is seamless.

## Versioning

The first production change increments the personal extension and desktop
product version from `0.17.1` to `0.18.0`. Store versioning remains independent.
Protocol version `1` is independent of product version.

## Security boundaries

- Named pipes use `PipeOptions.CurrentUserOnly` and a per-user pipe name.
- Native and pipe messages are capped at 1 MiB and require one JSON object.
- Request IDs are UUIDs and are returned unchanged.
- The bridge cannot accept inbound network connections.
- The desktop app does not receive Chrome cookies, credentials, headers, or
  request bodies.
- Local paths may cross the bridge only inside an already authorized upload
  plan in a later milestone. The Milestone 1 production UI does not request a
  path attachment.
- The debugger module accepts only explicit origins, selectors, paths, and tab
  IDs and always detaches.
- Store packaging fails if desktop, debugger, native bridge, or personal
  publishing artifacts enter the store bundle.

## Verification

The milestone is complete only when all of these are fresh and green:

- TDD unit tests for protocol validation, bounded framing, current-user pipe
  round-trip, unknown-operation refusal, and web-message routing;
- native bridge integration test against a real in-process named-pipe server;
- WebView2 desktop build with zero warnings;
- shared UI render tests at desktop, compact, and mobile widths with keyboard
  navigation, no horizontal overflow, and no browser console errors;
- actual Chromium extension test proving debugger file attachment and detach on
  success and failure;
- staged desktop package inventory and store-isolation tests;
- current personal and store Node suites;
- personal and store package builds; and
- a manual launch of the desktop app that stops before installation, registry
  writes, Chrome profile changes, or platform actions.

The lack of Inno Setup on a development machine may block compiling the final
installer executable, but it cannot weaken staging or package-content tests.
That limitation must be reported rather than hidden.

## Out of scope

- SQLite schema, Google OAuth, Sheet migration, media generation, scheduler,
  social metrics, catalogue matching, and tray attention logic;
- moving the existing uploader's full behavior into the desktop shell;
- replacing the current X teaser native host;
- initiating a real site upload from a desktop filepath;
- silent Chrome extension installation or enterprise policy;
- live posting, live Sheet writes, real-media moves, and production installer
  execution; and
- public/store distribution of the debugger-enabled personal extension.
