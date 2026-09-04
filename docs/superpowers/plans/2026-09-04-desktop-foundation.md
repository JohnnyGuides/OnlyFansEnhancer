# Desktop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver OFEnhancer 0.18.0 as a minimal Windows desktop foundation with a shared WebView2 shell, one current-user local agent, a stateless Chrome native bridge, a real Chromium local-file attachment proof, and a stageable per-user installer package.

**Architecture:** Add the desktop foundation alongside the working extension. `OFEnhancer.Desktop` owns a current-user named-pipe agent and serves the shared plain-web UI through WebView2; `OFEnhancer.NativeBridge` relays bounded Chrome messages to that pipe. The existing Chrome uploader and X teaser native host remain unchanged while the personal extension gains an internal, exact CDP file-attachment primitive.

**Tech Stack:** .NET 8 WPF, Microsoft Edge WebView2, `System.IO.Pipes`, `System.Text.Json`, plain HTML/CSS/JavaScript, Chrome Manifest V3, Chrome DevTools Protocol 1.3, Node test runner, Playwright Chromium, PowerShell, Inno Setup.

**Spec:** `docs/superpowers/specs/2026-09-04-desktop-foundation-design.md` (bounded Milestone 1), derived from `docs/superpowers/specs/2026-09-04-creator-workflow-platform-design.md` (approved programme)

## Global Constraints

- Work on `codex/desktop-foundation-m1`; never implement this milestone directly on `main`.
- Increment only the personal product/extension version from `0.17.1` to `0.18.0`; do not change the store version.
- Preserve every existing upload adapter, single-Yes gate, monotonic submission checkpoint, recovery rule, and no-repost safeguard.
- Preserve `CreatorTeaserNativeHost` until an explicit later migration.
- No real public post, Google Sheet write, registry mutation, installer run, Chrome profile mutation, or real-media move during automated verification.
- Use plain web assets for the shared UI; add no JavaScript framework or state library.
- Use one desktop process as local authority and one stateless native relay; add no Windows service.
- Pipe and native messages are one JSON object capped at 1 MiB and restricted to the current Windows user.
- The personal extension may use `debugger`; the store package must not contain that permission or desktop artifacts.
- The debugger attachment primitive never submits, clicks, logs, persists, or echoes a local path and always detaches.
- Treat the current unpacked extension ID as a migration source, not a key that can be reproduced in a new folder.

---

### Task 1: Add the protocol library and solution

**Files:**

- Create: `desktop/OFEnhancer.sln`
- Create: `desktop/OFEnhancer.Protocol/OFEnhancer.Protocol.csproj`
- Create: `desktop/OFEnhancer.Protocol/AgentProtocol.cs`
- Create: `desktop/OFEnhancer.Protocol/AgentPipe.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj`
- Create: `desktop/OFEnhancer.Protocol.Tests/AgentProtocolTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/AgentPipeTests.cs`

**Interfaces:**

- Produces: `AgentRequest.Parse(string json)`, `AgentResponse.Success(AgentRequest request, AgentStatus status)`, `AgentResponse.Failure(string requestId, string code)`, `AgentPipeServer.RunAsync(Func<AgentRequest, AgentResponse> handle, CancellationToken stop)`, and `AgentPipeClient.SendAsync(AgentRequest request, CancellationToken stop)`.
- Produces: protocol version `1`, product version `0.18.0`, maximum UTF-8 frame size `1_048_576`, and capabilities `desktop-shell`, `native-bridge`, `local-file-attach`.

- [ ] **Step 1: Create the solution, projects, and failing protocol tests**

Use `dotnet new` for the solution, class library, and MSTest project. Write tests that hand-derive these observable results:

```csharp
[TestMethod]
public void Parse_accepts_one_status_request()
{
    AgentRequest request = AgentRequest.Parse("""{"protocolVersion":1,"requestId":"9b8dcfd6-30c7-4dc0-b6da-fb4aec1c5a9c","operation":"getStatus"}""");
    Assert.AreEqual("getStatus", request.Operation);
}

[TestMethod]
public void Parse_rejects_unknown_protocol()
{
    Assert.ThrowsException<AgentProtocolException>(() =>
        AgentRequest.Parse("""{"protocolVersion":2,"requestId":"9b8dcfd6-30c7-4dc0-b6da-fb4aec1c5a9c","operation":"getStatus"}"""));
}

[TestMethod]
public void Parse_rejects_unknown_operation()
{
    Assert.ThrowsException<AgentProtocolException>(() =>
        AgentRequest.Parse("""{"protocolVersion":1,"requestId":"9b8dcfd6-30c7-4dc0-b6da-fb4aec1c5a9c","operation":"deleteEverything"}"""));
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj`

Expected: FAIL because the protocol types do not exist.

- [ ] **Step 3: Implement the minimal strict protocol**

Use records with `System.Text.Json`. Reject nulls, additional top-level values, non-UUID request IDs, protocol versions other than `1`, operations other than `getStatus`, and serialized responses over 1 MiB. Errors expose stable codes such as `invalid-request`, `unsupported-protocol`, and `unsupported-operation`, never the rejected JSON.

- [ ] **Step 4: Add failing current-user pipe tests**

Start a server with a unique pipe name and assert a real client round-trip returns:

```csharp
Assert.AreEqual("0.18.0", response.Status!.ProductVersion);
CollectionAssert.AreEqual(
    new[] { "desktop-shell", "local-file-attach", "native-bridge" },
    response.Status.Capabilities);
```

Add separate tests for an oversized frame and cancellation while waiting for a client.

- [ ] **Step 5: Run the pipe tests and verify RED**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter AgentPipeTests`

Expected: FAIL because `AgentPipeServer` and `AgentPipeClient` are absent.

- [ ] **Step 6: Implement one-request pipe framing**

Use a four-byte little-endian length followed by UTF-8 JSON. Construct the server with `PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly`. Read exactly one request, write exactly one response, flush, disconnect, and accept the next client until cancelled.

- [ ] **Step 7: Run the protocol tests and verify GREEN**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj -c Release`

Expected: PASS with zero warnings and failures.

- [ ] **Step 8: Commit**

```powershell
git add desktop/OFEnhancer.sln desktop/OFEnhancer.Protocol desktop/OFEnhancer.Protocol.Tests
git commit -m "Add the desktop agent protocol"
```

### Task 2: Build the shared desktop shell

**Files:**

- Create: `app/index.html`
- Create: `app/app.css`
- Create: `app/app.js`
- Create: `app/host-bridge.js`
- Create: `desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj`
- Create: `desktop/OFEnhancer.Desktop/App.xaml`
- Create: `desktop/OFEnhancer.Desktop/App.xaml.cs`
- Create: `desktop/OFEnhancer.Desktop/MainWindow.xaml`
- Create: `desktop/OFEnhancer.Desktop/MainWindow.xaml.cs`
- Create: `desktop/OFEnhancer.Desktop/DesktopAgent.cs`
- Create: `desktop/OFEnhancer.Desktop/WebMessageRouter.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/WebMessageRouterTests.cs`
- Create: `tests/desktop-shell-ui.test.cjs`
- Modify: `desktop/OFEnhancer.sln`
- Modify: `desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj`
- Modify: `scripts/build-personal-package.ps1`
- Modify: `tests/creator-tools.test.cjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 1 `AgentRequest`, `AgentResponse`, and `AgentPipeServer`.
- Produces: browser contract `OFEnhancerHost.request(operation, payload = {}) -> Promise<object>`.
- Produces: WebView2 message `{ requestId, operation, payload }` and response `{ requestId, ok, result?, error? }`.

- [ ] **Step 1: Write failing web-message routing tests**

Add C# tests for `getStatus`, `openChromeUploader`, malformed JSON, and unknown operations. `openChromeUploader` returns a command result to a supplied `Action<Uri>` test seam; it does not start a process inside the test.

- [ ] **Step 2: Run the router tests and verify RED**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter WebMessageRouterTests`

Expected: FAIL because `WebMessageRouter` is absent.

- [ ] **Step 3: Implement the minimal desktop application**

Create a `net8.0-windows` WPF application with `UseWPF=true`,
`UseWindowsForms=true`, and pinned `Microsoft.Web.WebView2`. Map the repository
`app` output folder to `https://app.ofenhancer.local/` using
`SetVirtualHostNameToFolderMapping(..., CoreWebView2HostResourceAccessKind.DenyCors)`.
Start one `DesktopAgent` pipe loop after app startup. Route WebView2 messages
through `WebMessageRouter`. Closing the window hides it; the tray menu has
Open and Exit. The tray tooltip is only `OFEnhancer`. Support
`--agent-once --pipe-name <unique>` for the native-bridge integration test and
`--status-json` for package verification; neither mode opens a window or tray.

Read the Chrome extension ID from `%LocalAppData%\OFEnhancer\settings.json` or
an explicit `--extension-id` development argument. `openChromeUploader`
returns `extension-not-configured` when neither exists. It never hardcodes the
current personal ID.

- [ ] **Step 4: Run the desktop tests and build**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj -c Release`

Run: `dotnet build desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj -c Release`

Expected: both exit `0`; build reports zero warnings.

- [ ] **Step 5: Write a failing rendered shell test**

Serve `app/` locally and use Playwright to assert:

```js
assert.equal(await page.getByRole("navigation").count(), 1);
assert.equal(
  await page.getByRole("button", { name: "Open Chrome uploader" }).count(),
  1,
);
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  true,
);
```

Exercise keyboard navigation at 1440x900, 800x700, and 390x844. Capture console errors and require an empty array. The test injects a truthful `getStatus` test transport and labels it test data.

- [ ] **Step 6: Run the UI test and verify RED**

Run: `node tests/desktop-shell-ui.test.cjs`

Expected: FAIL because the shared assets and package script are not wired.

- [ ] **Step 7: Implement the shared shell and host transport**

Use the existing uploader's dark tokens and supplied logo. Keep one strong page title, compact status, and five-item navigation. Do not show sample catalogue rows or fake metrics. Humanize every visible string. Disable the Chrome action with a direct status if no host transport exists.

Package the same `app/` files in the personal ZIP and assert the store package
does not contain them.

- [ ] **Step 8: Run the rendered shell test and verify GREEN**

Run: `npm run test:desktop-shell-ui`

Expected: PASS at all three widths with no overflow or console error.

- [ ] **Step 9: Commit**

```powershell
git add PRODUCT.md app desktop/OFEnhancer.Desktop desktop/OFEnhancer.Protocol.Tests tests/desktop-shell-ui.test.cjs scripts/build-personal-package.ps1 tests/creator-tools.test.cjs package.json desktop/OFEnhancer.sln
git commit -m "Add the shared desktop shell"
```

### Task 3: Add the stateless Chrome native bridge

**Files:**

- Create: `native-host/OFEnhancerNativeBridge/OFEnhancerNativeBridge.csproj`
- Create: `native-host/OFEnhancerNativeBridge/Program.cs`
- Create: `native-host/ofenhancer-native-host.json.template`
- Create: `tests/desktop-native-bridge.test.cjs`
- Modify: `desktop/OFEnhancer.sln`
- Modify: `background.js`
- Modify: `tests/background.test.cjs`

**Interfaces:**

- Consumes: Task 1 `AgentPipeClient` and native-message four-byte framing.
- Produces: native host name `com.johnnyguides.ofenhancer`.
- Produces: background request `GET_DESKTOP_STATUS` returning `{ desktopStatus }`.

- [ ] **Step 1: Write the failing native bridge integration test**

Start `OFEnhancer.Desktop.exe --agent-once --pipe-name <unique>` so the real
`AgentPipeServer` accepts one request without opening UI. Spawn the bridge with
`--request <pipeName> <request.json>`, then assert exit `0`, matching
request ID, version `0.18.0`, and the exact capability list. Add failure cases
for no agent, malformed JSON, and unsupported operation; their output must not
contain the supplied JSON or local request-file path.

- [ ] **Step 2: Run the bridge test and verify RED**

Run: `node --test tests/desktop-native-bridge.test.cjs`

Expected: FAIL because the bridge project is absent.

- [ ] **Step 3: Implement the bridge**

Use the protocol library for validation and pipe framing. In native mode, read
one Chrome frame capped at 1 MiB, forward it, write one Chrome frame, and exit.
If the desktop agent is absent, return `{ ok:false, error:{ code:
"desktop-unavailable" } }` without launching another authority process.

- [ ] **Step 4: Add the background status request with a failing test**

Extend the existing Chrome API fake with `sendNativeMessage`. Assert
`GET_DESKTOP_STATUS` targets `com.johnnyguides.ofenhancer`, returns the bounded
status, and converts `chrome.runtime.lastError` into `desktop-unavailable`.

- [ ] **Step 5: Run the background test and verify RED**

Run: `node --test tests/background.test.cjs`

Expected: FAIL because the new message and host name are absent.

- [ ] **Step 6: Implement the background status bridge**

Add one `sendDesktopNative` helper parallel to the existing X teaser helper.
It accepts only `getStatus`; it never forwards arbitrary caller objects.

- [ ] **Step 7: Run bridge, background, and existing native-host tests**

Run: `node --test tests/desktop-native-bridge.test.cjs tests/background.test.cjs tests/x-teaser-native-host.test.cjs`

Expected: PASS. The existing X teaser audit/move tests remain unchanged.

- [ ] **Step 8: Commit**

```powershell
git add native-host/OFEnhancerNativeBridge native-host/ofenhancer-native-host.json.template tests/desktop-native-bridge.test.cjs background.js tests/background.test.cjs desktop/OFEnhancer.sln
git commit -m "Connect Chrome to the desktop agent"
```

### Task 4: Prove exact local-file attachment in Chromium

**Files:**

- Create: `creator-tools/local-file-attacher.js`
- Create: `tests/local-file-attacher.test.cjs`
- Create: `tests/local-file-attacher-chrome.test.cjs`
- Modify: `manifest.json`
- Modify: `background.js`
- Modify: `scripts/build-personal-package.ps1`
- Modify: `tests/creator-tools.test.cjs`
- Modify: `tests/store-edition.test.cjs`
- Modify: `tests/extension-load.test.cjs`
- Modify: `tests/x-teaser-chrome.test.cjs`
- Modify: `tests/x-teaser-package.test.cjs`

**Interfaces:**

- Produces: `CreatorLocalFileAttacher.attach({ tabId, selector, filePath, allowedOrigins }, chromeApi)`.
- Consumes: `chrome.debugger.attach`, `sendCommand`, and `detach`; `chrome.tabs.get`.

- [ ] **Step 1: Write failing unit tests against a complete Chrome fake**

Test a successful exact input, wrong origin, multiple selector matches, non-file
input, non-absolute path, attach failure, command failure, and detach failure.
Assert detach occurs once after every successful attach. Assert serialized
errors and call logs never contain `C:\private\episode.mp4`.

- [ ] **Step 2: Run the unit tests and verify RED**

Run: `node --test tests/local-file-attacher.test.cjs`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the minimal CDP adapter**

Validate all inputs before attaching. Read the tab URL, compare its exact
origin with `allowedOrigins`, attach protocol `1.3`, resolve one exact
`input[type=file]`, call `DOM.setFileInputFiles`, dispatch `input` and `change`
through `Runtime.callFunctionOn`, and detach in `finally`. Export test hooks by
the repository's existing global/module pattern.

- [ ] **Step 4: Run the unit tests and verify GREEN**

Run: `node --test tests/local-file-attacher.test.cjs`

Expected: PASS.

- [ ] **Step 5: Write the failing real-Chromium proof**

Launch the unpacked personal extension in an isolated profile and a temporary
HTTP server with one `input[type=file]`. Create one inert temporary file. From
the extension service worker, call the internal attacher with the temporary
tab ID, exact selector, path, and loopback origin. Assert the page reports the
filename plus one input and one change event. Repeat with a missing selector
and assert the debugger detached. Delete all temporary files and the profile.

- [ ] **Step 6: Run the Chromium proof and verify RED**

Run: `node tests/local-file-attacher-chrome.test.cjs`

Expected: FAIL until the manifest imports the module and grants `debugger`.

- [ ] **Step 7: Wire only the personal extension**

Add `debugger` to root `manifest.json`, import the module in `background.js`,
package it in the personal ZIP, and increment personal version assertions to
`0.18.0`. Do not add a runtime message that accepts file paths. Assert the
store manifest has no `debugger`, `nativeMessaging`, desktop bridge, or local
file attacher.

- [ ] **Step 8: Run the real Chromium and store-isolation gates**

Run: `node tests/local-file-attacher-chrome.test.cjs`

Run: `node --test tests/creator-tools.test.cjs tests/store-edition.test.cjs tests/extension-load.test.cjs tests/x-teaser-chrome.test.cjs tests/x-teaser-package.test.cjs`

Expected: both commands pass; the real page receives the inert file and the
store edition remains narrow.

- [ ] **Step 9: Commit**

```powershell
git add creator-tools/local-file-attacher.js tests/local-file-attacher.test.cjs tests/local-file-attacher-chrome.test.cjs manifest.json background.js scripts/build-personal-package.ps1 tests/creator-tools.test.cjs tests/store-edition.test.cjs tests/extension-load.test.cjs tests/x-teaser-chrome.test.cjs tests/x-teaser-package.test.cjs
git commit -m "Prove local file attachment in Chrome"
```

### Task 5: Stage the per-user desktop package and installer

**Files:**

- Create: `installer/OFEnhancer.iss`
- Create: `installer/extension-setup.html`
- Create: `scripts/build-desktop-package.ps1`
- Create: `scripts/register-native-host.ps1`
- Create: `scripts/unregister-native-host.ps1`
- Create: `tests/desktop-package.test.cjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**

- Produces: `npm run build:desktop` and `npm run test:desktop-package`.
- Produces: stage `dist/ofenhancer-desktop-v0.18.0/` and optional signed-later installer `dist/OFEnhancer-Setup-0.18.0.exe`.
- Produces: HKCU host registration for `com.johnnyguides.ofenhancer` with one exact `allowed_origins` extension ID supplied at install time.

- [ ] **Step 1: Write the failing package behavior test**

Run the stage-only build in a temporary output root. Assert the staged product
starts the desktop executable with `--status-json`, receives version `0.18.0`,
and contains the desktop publish, native bridge, shared `app/`, personal
extension, logo, host manifest template, setup guide, and version manifest.
Assert it excludes `.git`, tests, fixture traces, `node_modules`, config files,
Sheet IDs, tokens, and all files under user media paths.

- [ ] **Step 2: Run the package test and verify RED**

Run: `node --test tests/desktop-package.test.cjs`

Expected: FAIL because the staging script and installer inputs are absent.

- [ ] **Step 3: Implement the stage-only package build**

Publish `OFEnhancer.Desktop` and `OFEnhancer.NativeBridge` self-contained for
`win-x64`. Copy an explicit allow-list of extension and app files. Generate a
JSON manifest with product version and SHA-256 for every staged executable and
script. Fail on unexpected files rather than copying repository globs.

- [ ] **Step 4: Implement current-user registration scripts**

Require an extension ID matching `^[a-p]{32}$`. Generate the Native Messaging
manifest under the installed app directory with one exact allowed origin.
Write only `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.johnnyguides.ofenhancer`.
Unregister only when the registry value still points inside the exact installed
root supplied to the script.

- [ ] **Step 5: Add the Inno definition**

Use a stable AppId, `PrivilegesRequired=lowest`, `%LocalAppData%\Programs`, and
the staged allow-list. Existing installs offer Update, Reinstall/repair, or
Uninstall. User data is excluded from uninstall by default. The post-install
action opens `extension-setup.html`; it never writes Chrome enterprise policy
or edits the Chrome profile.

- [ ] **Step 6: Run the package test and verify GREEN**

Run: `npm run test:desktop-package`

Expected: PASS and print the stage path plus manifest SHA-256.

- [ ] **Step 7: Compile the installer when Inno Setup is available**

Run: `npm run build:desktop`

Expected on this machine: staging succeeds, then the command reports
`INNO_COMPILER_MISSING` with the official installer prerequisite and exits
non-zero. If `ISCC.exe` is installed before execution, require a successful
compile and verify the generated installer signature state without claiming it
is signed.

- [ ] **Step 8: Commit**

```powershell
git add installer scripts/build-desktop-package.ps1 scripts/register-native-host.ps1 scripts/unregister-native-host.ps1 tests/desktop-package.test.cjs package.json .gitignore README.md
git commit -m "Stage the desktop installer package"
```

### Task 6: Audit, verify, and document the milestone

**Files:**

- Create: `docs/DESKTOP_FOUNDATION_SMOKE.md`
- Modify: `docs/CREATOR_TOOLS_ARCHITECTURE.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: Tasks 1 through 5.
- Produces: an exact manual smoke procedure that never posts, installs, writes
  the registry, changes Chrome profiles, or moves real media.

- [ ] **Step 1: Run the Impeccable detector once**

Run:

```powershell
node C:\Users\osi_c\.codex\skills\impeccable\scripts\detect.mjs --json app\index.html app\app.css app\app.js app\host-bridge.js
```

Fix its mechanical findings in one batch and do not run the detector again.

- [ ] **Step 2: Fetch and apply the current web interface guidelines**

Fetch the current official guideline file required by the
`web-design-guidelines` skill. Audit the four `app/` files, fix applicable
accessibility and interaction findings, and record no waived critical issue.

- [ ] **Step 3: Inspect the rendered shell with Playwright**

Open the real `app/` surface at 1440x900, 800x700, and 390x844. Exercise every
navigation item and the disabled/connected uploader states with keyboard.
Check the console and horizontal overflow. Capture desktop and mobile evidence
under `.impeccable/review/` and inspect both images once.

- [ ] **Step 4: Run the complete verification gate**

Run:

```powershell
dotnet test desktop\OFEnhancer.sln -c Release
dotnet build desktop\OFEnhancer.sln -c Release
npm run lint
npm run typecheck
npm run format:check
npm test
npm run test:desktop-shell-ui
node tests\local-file-attacher-chrome.test.cjs
npm run test:desktop-package
npm run build:personal
npm run build:store
```

Expected: every command exits `0`, except the separate optional Inno compile
when `ISCC.exe` is unavailable. Report exact test counts and artifact hashes.

- [ ] **Step 5: Launch the desktop app without installation**

Run the Release desktop executable from the worktree. Verify one instance, the
shared shell, tray Open/Exit, `getStatus`, and Open Chrome uploader. Close it
through Exit. Do not run registration scripts, the installer, a live platform
action, or a media operation.

- [ ] **Step 6: Update architecture and smoke documentation**

Document process ownership, protocol version, debugger permission scope,
extension-ID migration limitation, installer prerequisite, and the exact safe
smoke procedure. State that Milestone 1 proves plumbing only and does not make
desktop publishing live-ready.

- [ ] **Step 7: Commit**

```powershell
git add docs README.md .impeccable/review
git commit -m "Document the desktop foundation"
```

- [ ] **Step 8: Complete the branch**

Use `superpowers:finishing-a-development-branch`, merge the verified branch
back to local `main` per the user's standing preference, and do not push.
