# Architecture and trust boundaries

## Runtime ownership

OFEnhancer deliberately separates local authority from authenticated browser
authority. [The product contract](product.md) owns the safety requirements; the
modules below implement them.

| Owner                                 | Responsibilities and entry points                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/personal`                 | Chrome service worker, uploader/recorder pages, settings, avatar services, and `workflows/` adapters/contracts/checkpoints                            |
| `extensions/store`                    | Independent consent/settings/background UI for the display-only product                                                                               |
| `shared/identity-mask`                | One masking engine and stylesheet. Each edition supplies `identity-settings.js` before shared content code; absent configuration defaults to disabled |
| `shared/workspace`                    | Browser-rendered workspace, host abstraction, and desktop upload transport. Used by the personal extension and linked into the Windows build          |
| `desktop/OFEnhancer.Desktop`          | WPF/WebView2 UI, per-user tray agent, Google integration, browser selection, thumbnail serving, and native file selection                             |
| `desktop/OFEnhancer.Catalogue`        | SQLite store, migrations, import, identity/matching, thumbnail inventory, upload records, and sync outbox                                             |
| `desktop/OFEnhancer.Protocol`         | Bounded request validation and current-user named-pipe framing                                                                                        |
| `native-host/OFEnhancerNativeBridge`  | Stateless per-message relay between Chrome native messaging and the local desktop agent                                                               |
| `native-host/CreatorTeaserNativeHost` | Separate X receipt/audit/file reconciliation authority; not replaced by the desktop relay                                                             |
| `integrations/google-apps-script`     | Optional existing creator-owned Sheet bridge, independently deployed from source                                                                      |

The desktop is the sole local database writer. Its shared UI sends allow-listed
operations to the native host bridge and receives bounded results, not arbitrary
SQL or filesystem authority. `WebMessageRouter`, `WebMessageDispatcher`,
`AgentProtocol`, and their tests are the executable message contracts.

## Desktop, WebView, and Chrome

The workspace runs at `https://app.ofenhancer.local/` in WebView2. Local thumbnails
are served as `https://thumbs.ofenhancer.local/<opaque-asset-id>`, never by exposing
an arbitrary `file://` URL. Native resource resolution verifies the configured
root and current file identity. The single-instance/tray lifetime is independent
of an individual Chrome extension worker or visible desktop window.

Chrome connects to `com.johnnyguides.ofenhancer`. The bridge uses native-messaging
stdio frames, forwards bounded JSON over a per-user `CurrentUserOnly` named pipe,
and correlates request IDs. Frames are capped at 1 MiB. It accepts repeated
requests while the native connection is alive but owns no catalogue or publishing
state and opens no inbound network listener.

`BrowserUploadChannel` binds queued commands to the explicitly selected Chrome
connection/generation. `desktop-upload-runtime.js` services that channel while
preserving the extension's existing publisher. A disconnected/stale browser is
not silently replaced by another tab or connection. Pending work must not replay
file attachment or public submission merely because a process reconnects.

Desktop file selection uses WebView2 additional native File objects.
`MainWindow` verifies name, size, and modification time against that native
selection before a short-lived authorized local path reaches the trusted
attachment command. JSON alone cannot invent a native file selection. Paths are
not persisted as Chrome publishing checkpoints, exposed in page messages, or
returned in errors. `local-file-attacher.js` uses the exact tab/origin/input and
always detaches the debugger. Extension-page `File` objects instead use the
session-scoped file bridge; they are not serialized into JSON.

`UploadCatalogueController` records verified upload outcomes locally. That return
value explicitly distinguishes local success from Google synchronization. The
local SQLite catalogue, the optional direct Google sync outbox, and the older
Apps Script client are distinct boundaries, not interchangeable success signals.

## Browser execution and state

The personal background worker owns registration, tab binding, shared settings,
message allow-lists, and durable progress. The console owns the current selected
Files and approved preview. Page adapters inspect the current signed-in DOM;
narrow page-world response observers accept only the expected successful final
response and canonical identity. They do not grant generic API interception or
trust a content-script-supplied URL as proof of successful submission.

Site helper files own exact inspection/application logic. The coordinator calls
those operations directly with an approved profile snapshot rather than clicking
helper-panel UI or keeping a second copy of their recipes. Standalone wrappers
remain useful for bounded manual correction. Registry normalization owns profile
defaults; adapters recheck form signatures before mutation.

Upload session state is bounded and serializable because Manifest V3 workers can
be suspended. It may include approved metadata, basenames, plan signatures,
canonical outcomes, fingerprints, and monotonic stage flags, but not File bytes,
cookies, request bodies, or raw media paths. The open uploader still has to retain
or deliberately reselect the exact File. X recorder/distributor checkpoints use
their own durable allow-listed records. A persisted final-attempt marker is not
cleared on restart or storage retry. The local `creatorUploadActionsV1` journal retains final intent and canonical receipts independently of session metadata. Preparation records retain hashed work/plan identity, command, platform, frame and document, including an issued file-delivery phase. New sessions cannot bypass an existing action for the same work; full journals reject new work without evicting unresolved records. Legacy records remain visible.

Privileged preparation messages recheck the exact document, route, frame and current connection object before and after durable writes. Only the recorded ManyVids editor handoff can replace that document binding. File assignment and upload-start actions are not transport retries. Idempotent checkpoint/progress acknowledgements may resume; explicit refusals fail once.

Final response observation is armed at the durable final-action boundary. Earlier requests are excluded and preparation time does not consume its timeout. A canonical receipt is checkpointed independently of the adapter return. Ambiguous identities and application errors do not establish acceptance. `recorded-local` is terminal independently of sibling platforms and never implies Google synchronization, including an idempotent local record.

## Catalogue and reconciliation

Stable local item IDs and verified content identity survive row moves and file
renames. A filename is a search hint, not a key. `CatalogueSnapshotImporter` and
migrations use transactions and verified sibling backups where required;
`ThumbnailInventory` rejects unsafe filesystem traversal. Current thumbnail
matching is deterministic, not a perceptual media engine.

Direct Google import and reviewed sync have different acceptance criteria.
`GoogleCatalogueImportReader` recognizes bounded headers read-only;
`GoogleWorkbookProfile` and `GoogleWorkbookMigrator` enforce the stricter write-back
layout. Developer metadata locates stable item rows; fingerprints protect fields.
The outbox never rewinds an attempted mutation to pending. Details, recovery, and
operator procedures are maintained only in [Google catalogue](google-catalogue.md).

The separate X host uses a basename plus identity proof within configured roots,
not a caller-provided arbitrary path. Representative frames come from the selected
local File, avoiding page overlays and cross-origin screenshot ambiguity. It
writes validated audit frames/data and a durable receipt, then the extension
performs the protected Sheet append, and only then requests the exact Done move.
Retries accept identical existing artifacts; conflicting files or destinations
stop. The receipt, hash/root checks, and audit → Sheet → move ordering are all
required. Neither native host owns Chrome cookies or authenticated site sessions.

## Source and generated boundaries

[The composition recipe](../packaging/extensions.json) maps runtime paths to
canonical files. The Node builder validates manifest/HTML closure and store
isolation, then generates both unpacked trees and deterministic ZIPs. It refuses
source replacement, traversal, symlink outputs, and non-runtime files. The Apps
Script is deliberately not embedded in either extension.

Desktop `.csproj` Content links compose the same workspace and uploader source
into its runtime `app/` directory. The nested `app/app/upload-host.js` output is a
link of the same source needed by the uploader's relative HTML reference, not an
independently edited implementation. The uploader marks Chrome-only setup links;
its desktop host removes those links and displays guidance to configure the
optional bridge in Chrome, rather than navigating to unavailable desktop options.
Windows staging consumes the Node builder's
validated inventory; it has no second hand-maintained extension file list.

`packaging/windows` owns installer input; `packaging/store` owns public listing
assets/copy. These are not runtime forks. `docs/privacy.html` and `docs/index.html`
retain their public-site paths; the store package copies that same privacy HTML.
The source tree contains no generated packages or native binaries.

## Wire and evidence limits

`ChromeIntegration` owns bounded local setup diagnostics and fixed-package
preparation. Readiness messages bypass the catalogue/Google dispatcher. Only the
desktop WebView advertises `chrome-readiness`; the narrower extension-hosted
workspace does not infer Chrome absence from unsupported desktop diagnostics.
The native relay replaces `bridgeExtensionId` with Chrome's invocation origin.
`BrowserUploadChannel` requires matching effective identity plus a current setup
challenge before counting traffic as live. This is local diagnostic evidence,
not authentication against another process running as the same user. Setup
changes invalidate old liveness and pending channel work. Reconnect never releases
offline UI mutations, and retired connection generations cannot consume commands.

Lifecycle persistence has two disjoint authorities. The Windows maintenance
record owns consented roots, package identity, and completed uninstall/purge/copy/
verification effects. It contains no Chrome-ready claim and is retired after a
verified package acknowledges the durable Chrome obligation. The Chrome reset
record lives beside that transaction, outside purge roots, and is the only owner
of removal requests/rejections, user reports, retired receipts, replacement stage,
and admitted receipt. It is never copied into the desktop data root.

Inno Setup invokes only Windows plan/checkpoint/cleanup/finalization operations.
The installed app owns all Chrome guidance and admission. The extension owns only
its resumable genuine-install initialization record. The native bridge remains a
transport: it stamps Chrome's actual invocation origin on every browser request,
while the desktop applies the reset/admission barrier to upload exchange and to
direct catalogue/result operations. Diagnostics may remain reachable while a
reset is pending; general catalogue and upload authority does not.

Fresh installs use `extension-keyed`; `extension` remains the keyless compatibility
composition from the same runtime sources. `packaging/personal-identity.json`
contains only the fixed public key and derived ID. Private key material is neither
needed nor distributed. Setup verifies the installed package inventory, refuses
foreign registration targets, writes only exact current-user origins, and leaves
Google preferences and Chrome storage intact. A command-line extension override
remains effective for that process and disables saved-setup changes.

The relay accepts Chrome's Windows origin plus decimal parent-window handle,
including zero for service workers. Frames remain bounded to 1 MiB of UTF-8.
Oversized replies return a correlated `frame-too-large` error, never a truncated
snapshot. Each connected pipe has a 90-second lifetime; a failed connection does
not remove a listener worker. Browser command queues enforce byte and count bounds.

Public WebView JSON commands cannot contain a file command or nested `filePath`.
Only the native AdditionalObject selection path creates privileged file commands.
Missing AdditionalObjects are normal for ordinary WebView messages.

Catalogue URL evidence requires HTTPS, exact platform authority, no credentials
or nondefault port, and exact route identity. Query/fragment ambiguity is rejected;
Pornhub allows one `viewkey` parameter on `view_video.php` or `video/show`.
Creator-specific legacy OnlyFans normalization remains unchanged.

## Upload Hub action and acquisition contracts

Action identity includes independent accessible labels, scoped ownership, a
unique candidate and the expected post-click surface. Conflicting names do not
fall back to a nearby action. OnlyFans checks for expiration before interacting
with the supported scheduler. Fansly requires file-input activation caused by
its exact Upload New click, not merely the existence of a visible file modal.
Pre-file errors carry the composer/media-menu/upload-new/file-input stage into
the existing per-platform Upload Hub error presentation.

Pornhub acquisition starts at the signed-in Upload Video session entry
`https://www.pornhub.com/upload/videodata`; no execution is injected there.
Execution is permitted only on `https://pornhub.mainhub.com/upload/uploader`,
with either no query or the sole `site=ph` parameter, after positive unambiguous
device capability validation. Login/non-uploader pages, unknown redirects and
occupied uploaders fail closed. The final URL is stored exactly; accepting two
acquisition URL forms never makes those URLs interchangeable during execution.
Top frame, tab, document ID, active session and live connection checks remain.
This narrow contract is not a claim of complete authenticated live acceptance;
see the dated limitations in [acceptance](acceptance.md).

## Upload runtime versions and foreground observation

The desktop browser exchange requires a matching extension product version in
addition to the existing identity, native-origin, connection and setup-generation
proofs. An incompatible worker receives no new commands and the UI requests a
reload of the existing extension. Pending commands are rejected, not replayed
when a compatible worker later connects. Page adapters carry a product-coupled
revision and must match before file-bridge installation or adapter execution.

A version transition archives preparation records and durably preserves final
attempts before removing only transient upload-session bindings. Archived steps
still participate in same-work conflict checks. Same-version startup changes
nothing; malformed version state and downgrades fail without adopting a queue.
A durable final receipt without an approved draft is review evidence, not an
executable session. No broad browser-storage or catalogue reset is involved.

ManyVids foreground assistance is a privileged upload-observation request. It
revalidates the exact session, port, top frame, tab, document and route before and
after real Chrome tab/window activation. A short lease prevents overlap with
file handoff; pending files and sibling composer/editor work defer activation.
The adapter verifies actual visibility/focus, throttles subsequent requests and
retains the same-card/exact-destination guard at Edit. Focus transport failures
are not automatically retried. Other platform workflows do not receive a generic
button-click or navigation facility.

New draft retires only a settled Upload Hub view and its file/port handles. Late
old-port, retry and social-observation replies cannot populate the next view.
Active runs and unresolved handoffs refuse the reset. Remote drafts, archived
preparation and durable final-attempt evidence are not deleted.
