# Development, packaging, and installation

## Toolchains and commands

Use Node.js 22.13+ (22.x) or 24+ and the exact dev dependency versions in `package-lock.json`.
`npm ci` installs them locally; `npx playwright install chromium` installs the
matching test browser.

Windows work requires .NET 8 SDK, Windows PowerShell, and the WebView2 Runtime.
Inno Setup 6 is needed to compile the installer; StageOnly does not require it.
The X teaser host is framework-dependent and needs the .NET 8 Windows runtime;
the desktop installer stages a self-contained win-x64 desktop and relay.

If supported tools are installed in this checkout's ignored `.local` directory,
select them for the current PowerShell process before running checks:

```powershell
$env:DOTNET_ROOT = Join-Path $PWD '.local/toolchains/dotnet'
$env:PATH = $env:DOTNET_ROOT + ';' + $env:PATH
$env:DOTNET_CLI_HOME = Join-Path $PWD '.local/toolchains/cli'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PWD '.local/playwright'
```

These settings do not change machine-wide tool selection or security policy.
An Internet-marked unsigned PowerShell script may still be refused by
RemoteSigned; preserve that restriction and obtain a trusted signed script when
required. Do not modify policy merely to pass a registration test.

| Command                                   | Scope                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run lint`                            | Configured typed workflow/static JavaScript rules                                    |
| `npm run typecheck`                       | Checked JavaScript project in `jsconfig.json`                                        |
| `npm run format:check` / `npm run format` | Maintained text source/config/docs formatting                                        |
| `npm run test:structure`                  | Source/recipe, manifest, HTML, documentation, project and packaging reference checks |
| `npm run test:unit`                       | All browser-independent JavaScript tests, including desktop transport                |
| `npm run test:browser`                    | All synthetic browser/extension/shared-UI tests; builds both editions first          |
| `npm test`                                | Structure, unit, extension packaging, and browser suites                             |
| `npm run test:dotnet`                     | Catalogue and desktop/Chrome-protocol tests in the solution                          |
| `npm run check:web`                       | Static gates and all portable JavaScript/browser checks                              |
| `npm run check:windows`                   | .NET, native integration, registration/release/package gates                         |
| `npm run check`                           | Both aggregates; intentionally fails when required tools are unavailable             |

Tests live by verified subsystem under `tests/`; .NET tests sit beside their
owning projects in `desktop/`. `OFEnhancer.Desktop.Tests` covers the Windows app
and its Chrome protocol boundary; `OFEnhancer.Catalogue.Tests` covers storage and
identity. The test runner discovers test files rather than
maintaining a partial list of current implementations. Standalone UI checks are
also part of the browser group. `OFENHANCER_CHROME_PATH` may select an explicit
compatible test browser and `OFENHANCER_HEADLESS=1` requests headless operation.
Browser policy that prohibits extensions/navigation is a blocker, not a reason
to disable the policy or weaken tests.

The opt-in `npm run test:snapshots` requires `FIM_POST_SNAPSHOT` and `FIM_DM_SNAPSHOT` pointing to private saved
HTML pages. Keep them in ignored `tests/fixtures/private` or another deliberately
private location; they are not provided or packaged. No default check
should use a real signed-in profile, live workbook, real media root, or installed
native registration. Native/installer tests use temporary fixtures and test-only
registration roots; manual installed-product acceptance is separate.

## Extension source composition

```sh
npm run build:personal
npm run build:store
node tools/build-extensions.mjs personal --list
node tools/build-extensions.mjs store --output-root /chosen/output/directory
```

[packaging/extensions.json](../packaging/extensions.json) is the single composition
recipe. Edit owning source, never `dist/`. Builds validate their exact manifest
and HTML references, enforce the store boundary, and generate deterministic ZIPs
and unpacked folders. The store privacy page comes from `docs/privacy.html`; its
public URL remains compatible with the existing docs-hosted site. Apps Script is
source for separate deployment, not an extension asset.

Build output belongs in `dist/` or an explicitly chosen output directory. Cleanup
only removes other recognized versioned releases of the same family. Unsafe paths, symlinks,
or unexpected release objects fail instead of being followed or overwritten.
Generated `dist/extensions/*` folders are suitable for new unpacked test installs.

The existing personal composition remains keyless for compatible updates at its
original load path. New desktop personal installs use a separate keyed composition:

`node tools/build-extensions.mjs personal-keyed --output-root dist`

The public key in `packaging/personal-identity.json` derives the fixed ID
`aocoaajmhccmefmfebgiiogfdojciild`. The builder validates this derivation. A
Chrome runtime load must independently verify that ID before release acceptance.
No private key is stored or shipped. Both compositions use the same runtime source;
the store edition remains separate. Never add the key to an existing keyless load
folder, relocate it, remove its Chrome installation, or migrate its storage.
Existing settings/checkpoints belong to its old ID. Insufficient legacy evidence
stops setup with advanced-repair guidance.

## Windows packages

```powershell
npm run stage:desktop
npm run build:desktop
npm run build:x-teaser-host
```

The desktop stage is `dist\ofenhancer-desktop-v<version>`, with `desktop`, `native`,
`extension`, `assets`, `tools`, setup/reload pages, `version.json`, and a hashed
`package-manifest.json`. Its extension inventory comes from the Node builder, not
another file list. Product/extension versions and native protocol compatibility
are checked separately. The full build compiles `packaging/windows/OFEnhancer.iss`
and emits the Setup executable. Missing Inno Setup is reported explicitly.

A local personal installer profile can preconfigure the actual extension ID and
public Google client ID; see [Google catalogue](google-catalogue.md). Stage-only
and generic builds never embed tokens, client secrets, database files, private
fixtures, or real media. Check the staged manifest and both extension ZIP contents
before distribution. Listing input is in `packaging/store`, not the runtime source.

## Install, update, and remove

The per-user installer targets `%LocalAppData%\Programs\OFEnhancer`; owned user
data lives separately under `%LocalAppData%\OFEnhancer`. It manages only its own
HKCU startup/native entries. The Connect Chrome shortcut opens desktop setup;
users enable/load/reload the personal extension in Chrome themselves. Setup must never
modify a Chrome profile or enable the extension through enterprise policy.

Updates use Restart Manager, replace owned binaries, preserve desktop and Chrome
state, and guide Reload only when the live runtime is outdated. Normal
repair/reinstall preserves the extension identity and load location. The explicit
Fresh reinstall option stages one Windows coordinator outside every purge root,
durably seeds the separate app-owned Chrome obligation, runs the verified old
uninstaller, purges only proven OFEnhancer-owned Windows roots, verifies the clean
package, and retires the Windows transaction. It does not open, wait for, or make
claims about Chrome.

The installed app then resumes the same Chrome task. Removal evidence remains
truthful and browser access stays closed until a canonical current-version genuine
install receipt completes initialization and a current bridge exchange. See
[the reset contract](product.md#normal-update-versus-fresh-reset). Interactive
uninstall defaults to keeping data and routes explicit cleanup through the same
owned-root/reparse protections, including configured roots. Silent uninstall
keeps data. External media and Chrome profiles are outside installer ownership.

For a manual desktop relay registration, use `tools/register-native-host.ps1`
with the actual extension ID and permanent install root. `tools/unregister-native-host.ps1`
removes only the matching owned registration. These are explicit installation
operations, never implicit consequences of building or testing.

The **separate X teaser host** has its own package/registration. Extract it to a
permanent directory, copy `config.example.json` to a private `config.json`, and
configure existing teaser/audit/Done directories. Its audit input requires
`catalogue.json`, `frame-data.json`, and `report-template.html` containing exactly
one `__AUDIT_DATA__` marker. Start with the synthetic fixture structure from the
native tests, not real media. Run the packaged `install-current-user.ps1` with the
exact personal extension ID, then reload Chrome. Do not substitute this host for
the desktop relay: their permissions and responsibilities differ.

## Release acceptance

Automated passing results are necessary, not a claim of live-platform support or
store approval. Follow [acceptance](acceptance.md) for authorized desktop lifecycle,
Google copy, and current platform trace checks. Preserve successful siblings and
unresolved attempted outcomes throughout. Validate the published privacy page
and listing declarations against the built store ZIP, and obtain current platform
and distribution-policy review before submission. Do not submit the personal ZIP
as the display-only product. Public desktop signing/timestamping and the
self-update boundary are stated in [the product contract](product.md).

## Failure containment

Windows builders validate output ancestors and owned release trees before
replacement. They publish into unique staging directories and promote completed
output; failed publish/archive/compile preserves the previous deliverable.
Failed staging directories remain in ignored output for diagnosis. Chrome setup
shortcuts open the desktop's shared setup experience, which checks Chrome before launching it.
The installer does not infer extension loading or register the bridge from a
compiled personal profile. Native preparation happens through the desktop setup UI.

The Node runner bounds tests to 120 seconds so a failed browser launch cannot
leave a fixture server holding a gate open indefinitely. Browser-policy and
script-signature failures are blockers; do not relax machine policy to test.

## Chrome setup and readiness

Desktop path attachment requires **Allow access to file URLs** in the personal
extension's Chrome details. The uploader checks this permission before attaching
the debugger and reports missing permission without changing Chrome preferences.
Chrome displays its normal debugging warning while OFEnhancer assigns the selected
file to the approved input. Do not suppress that warning. The extension-console
entry point continues to use the original selected File through structured cloning.

**Stop preparation** stops subsequent automated preparation actions and preserves
the draft. Uploads already started by the site may continue. Inspect the existing
draft before retrying an interrupted upload; a missing acknowledgement does not
establish that the upload was never started.

Preparation recovery retains bounded, non-secret step intents and outcomes in
local extension storage. Same-document retry inspects the original execution and
can continue a paused acknowledgement/observation without replaying file delivery.
After a browser restart, inspect the preserved site draft and reauthorize assets;
an unavailable or changed document is an attention-required condition, never an
instruction to create another draft. Diagnostic export is previewed before saving.

The local-path primitive supports explicitly scoped open shadow roots and
same-origin in-process frames. Cross-origin or out-of-process frame scopes stop
with an unsupported-frame error; they are not silently redirected to the main
document. Existing observed platform recipes use their main document controls.

For authenticated smoke verification, choose **Prepare the form; I will publish**,
select the approved full/teaser/thumbnail roles, and confirm the preparation run.
Check ManyVids assets and saved recipe, Fansly full-media permissions/free preview
and caption/toggles/date, and OnlyFans full attachment/description/date with labels
unchanged. Leave the final publication control untouched. Use Stop to preserve an
interrupted draft, and use the diagnostic preview/export for any failed step.
Synthetic browser tests do not establish authenticated upload acceptance.

The stabilization fixtures cover actual Pornhub uploader activation when its hidden input already exists or is replaced, one-shot ManyVids upload initiation, the readonly `#dp1` calendar and `#available_time`, OnlyFans' scoped time tab while Next remains present, and Fansly's first Schedule boundary without a global Post fallback. The recorder captures bounded click ancestry, label source, hidden/directory file controls and disabled/busy state; unknown labels, identifiers and classes use document-local opaque tokens.

Release 0.20.21 uses Node 24.19.0, the locked npm dependencies, .NET SDK 8.0.425/runtime 8.0.31, and SQLitePCLRaw.lib.e_sqlite3 2.1.13. Current npm and transitive NuGet audits were clean on September 14, 2026. The native SQLite regression executes `sqlite_version()` and requires the aggregate-memory-corruption fix (3.50.2 or later). .NET 8 is in maintenance and reaches end of support November 10, 2026; migrate to a supported major before then. Verify the actual self-contained runtime and native library again in the release stage.

Use the sidebar Chrome action or Start menu **Connect Chrome**. Preparation is
restricted to a permanent current-user installation with a verified package
inventory. It prepares only OFEnhancer-owned current-user native registration;
Chrome still requires Developer mode, Load unpacked and folder selection. The
exact fresh folder is `extension-keyed`. Opening Chrome or completing preparation
is reported separately from receiving fresh matching relay messages. The running
desktop rereads the saved identity and detects connection without a restart.
Existing keyless installs should reload their existing entry, not load this folder.

Advanced `register-native-host.ps1` remains available for deliberate legacy repair.
It checks both registry views before changing owned registration; normal fresh
setup needs neither an ID copied from Chrome nor a PowerShell command. Google
browser preferences are independent of Chrome uploader discovery.

Personal package defaults now ship in `installer-defaults.json` and seed only
absent desktop settings. Existing settings are preserved. A configured ID is not
proof of completed Chrome setup. The installer does not automatically register a
host or assume a reload is needed based on its compile-time profile.

For isolated builds, always supply a synthetic `-PersonalProfilePath` and a
separate `-OutputRoot`; the default command otherwise reads the owner's local
profile. Build/stage operations never register native hosts. Real installation,
registration, actual Chrome loading and update/uninstall acceptance remain
separately authorized runtime checks.

Uploader recovery preserves launcher identity and legacy publication hashes. Fansly home-route aliases require the original composer and top document. ManyVids continuation requires completion on the owned upload card and an exact Edit destination; missing destination evidence stops preparation before Edit. Pornhub uses one device activation per transport and the confirmed optional file or full-file fallback. Current semantic ownership fixtures are reconstructed, not authenticated captures.

## Repository-local browser cache

When Playwright browsers have been installed under `.local/playwright`, point
the verification process at that cache before running the gates:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path .local/playwright).Path
$env:OFENHANCER_HEADLESS = '1'
npm run build:extensions
npm run check
```

Use the Playwright Chromium/Chrome for Testing binary for fixture extension
loading, not regular branded Chrome's removed side-loading flags. See the
[official Playwright extension guide](https://playwright.dev/docs/chrome-extensions).
These process-local settings do not modify the installed personal Chrome profile
or establish authenticated browser acceptance.
