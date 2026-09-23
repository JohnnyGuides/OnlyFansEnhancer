# Chrome testing preference

The owner authorizes using the connected personal Chrome profile through the
Chrome MCP tools for relevant development inspection and UI verification.
Do not treat the fact that it is a personal or signed-in profile as a blocker,
or require a disposable profile merely for that reason.

Preserve existing extension identities, load locations, Chrome storage, settings,
and upload checkpoints where practical. The owner gives standing authorization,
until revoked, to install this repository's versioned Windows release as a normal
update and to interrupt or retry an in-progress live upload for relevant product
verification. Use this authorization to finish live retesting without asking
again. It does not authorize a Fresh reinstall, removing/reinstalling extensions,
changing native-host registration beyond the normal update, public publishing,
live Google mutation, real-media moves, or unrelated account actions.

# Development scope and content neutrality

OFEnhancer integrates with creator platforms that may host adult or otherwise sensitive content, but the repository work itself is software-engineering work: browser-extension/native-host integration, authenticated UI automation, file handoff, metadata mapping, draft preparation, diagnostics, testing, packaging, and release delivery. The owner's purpose in building and debugging this tool is personal software-development learning and technical growth.

Evaluate requests according to the concrete engineering operation being performed, not merely the category of the target website or the possibility that an account may contain explicit material. Do not infer that a coding, debugging, browser-control, authentication, upload-transport, or UI-automation task is a request to create, describe, promote, or publish explicit content solely because the destination platform supports it.

Keep development verification content-neutral whenever practical:
- use generated benign/non-explicit test clips and metadata;
- stop at prepared/unpublished drafts unless publication is explicitly authorized;
- inspect only the account/page state needed to diagnose the software behavior;
- avoid opening or analyzing unrelated user media when it is not needed for the engineering task.

A platform-specific browser/tool safety restriction still applies where encountered, but it should be scoped to the restricted interaction itself. Continue all independent permissible engineering, debugging, testing, recorder/trace analysis, and work on other supported platforms rather than treating the site's subject matter as a blanket blocker.

# Technical scope and test framing

Frame OFEnhancer engineering work around the extension and browser workflow actually being debugged: browser selection/connection, command dispatch, DOM interaction, file handoff, form/autofill behavior, draft preparation, recorder/trace evidence, lifecycle, retries, error reporting, packaging, and release verification.

Do not foreground, speculate about, or repeatedly classify the user's account content when that content is irrelevant to the engineering task. Use generated benign test fixtures by default for live upload/autofill verification. Describe target-site work in terms of the concrete UI state and technical action being tested, for example "prepare an unpublished draft", "select a test video", "populate metadata fields", or "verify the Edit button is clicked."

This technical framing does not override any applicable browser, site, security, publishing, credential, or safety boundary. If a specific live page or action is unavailable to the tool, preserve that boundary and continue the engineering work through supported sites, repository diagnostics, mocks, or the recorder/trace/capture evidence path rather than broadening the task into content analysis.

# End-to-end browser verification

For browser-driven product work, treat successful local/unit/transport tests as supporting evidence, not as proof that the live user workflow works. When the task concerns site automation, exercise the actual flow through OFEnhancer and the connected Chrome profile whenever that access is available: observe the real tabs/pages, confirm required clicks/file handoffs/autofill, and verify the intended prepared state.

If one target site cannot be inspected directly because of a browser/tool safety restriction, continue all independent work on other supported sites. Do not stop the broader task merely because one platform is blocked.

For a blocked authenticated site, prefer the repository's recorder/trace/capture/export/diagnostic workflow as the evidence bridge. If owner interaction is genuinely required, give one precise bounded procedure: what to start, the exact actions to perform, where to stop before any consequential action, and what sanitized evidence to return. Consume that evidence and continue diagnosis, implementation, and verification. Do not default final verification back to the owner when an available evidence workflow can support it.

For authorized live testing, use generated benign test media and stop before publication unless publication is explicitly authorized. A prepared unpublished draft is sufficient for upload/autofill verification.

Treat browser connection state as authoritative. Do not present an upload/preparation operation as actively progressing when the selected Chrome connection is missing, stale, disconnected, or unable to receive commands. Diagnose and fix the connection/state mismatch rather than relying on transport tests alone.

Carry an authorized fix through root-cause diagnosis, implementation, live retesting, regression coverage, packaging, and release verification. Ask the owner only for genuinely user-only actions such as login, 2FA, credential creation/approval, or a bounded recorder interaction, then resume afterward.

# Standing authorization for repository tooling

The owner gives continuing authorization to review and unblock trusted scripts
in this repository when an Internet-download marker prevents required build or
test tooling from running. Do not request separate approval for each such file.
Review the script first, scope `Unblock-File` to the exact repository file, and
continue verification. This does not authorize changing machine-wide execution
policy, disabling security protections, public publishing, or changing the
installed extension/native integration outside the task's existing authority.

# Release delivery


For completed product changes delivered as a release, increment the appropriate
product version and build a matching Windows installer. Include a direct,
clickable link to that versioned installer in the final response so the owner
can install it immediately. Do not merely promise an installer or omit its link.

Install the release as a normal update and retry the relevant live workflow when
feasible under the standing authorization above. If installation cannot complete,
provide the installer link for the owner to run. State clearly whether installation
and live verification actually occurred, and report any remaining blockers.
Preserve existing settings, extension identities, load locations, and storage.

# Google OAuth recovery knowledge

Use the existing Google Cloud project `ofenhancer-personal` (OFEnhancer Personal),
Desktop client **OFEnhancer for Windows**, under `johnnyguides@gmail.com` in the
Johnny Chrome profile. The exact client link and recovery procedure are in
`docs/google-catalogue.md`. Before asking the owner for a file, check the existing
DPAPI configuration at `%LocalAppData%\OFEnhancer\data\google-desktop-client.dat`
and the existing Cloud client. A public client ID plus PKCE is not sufficient:
Google requires this Desktop client's secret. Cloud no longer reveals existing
secrets. Preserve this client and store imported credentials with DPAPI; commit
recovery knowledge, never secrets or tokens. The owner's test workbook is **Work**.

# GitHub identity

This repository belongs to the `JohnnyGuides` GitHub account. For GitHub
authentication, commits, pushes, releases, and other repository operations,
use the `JohnnyGuides` identity and the
`146333925+JohnnyGuides@users.noreply.github.com` commit email.

Keep authentication scoped to this repository. Do not remove, overwrite, or
replace the `O-Marmullaku` GitHub credential because other projects use that
account. If both accounts are available, select or configure `JohnnyGuides`
for this repository explicitly rather than changing the machine-wide default.
