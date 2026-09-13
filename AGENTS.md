# Chrome testing preference

The owner authorizes using the connected personal Chrome profile through the
Chrome MCP tools for relevant development inspection and UI verification.
Do not treat the fact that it is a personal or signed-in profile as a blocker,
or require a disposable profile merely for that reason.

Preserve existing extension identities, load locations, Chrome storage, settings,
and upload checkpoints. This preference does not authorize removing/reinstalling
extensions, changing native-host registration, public publishing, live Google
mutation, real-media moves, or unrelated account actions. Follow the task's
explicit authorization for those operations.

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

Install the release when authorized and safely feasible, or provide the installer
link for the owner to run. State clearly whether installation actually occurred,
what was verified, and any remaining blockers. Preserve existing settings,
extension identities, load locations, storage, and upload checkpoints.

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
