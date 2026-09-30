# OFEnhancer working constraints

This file contains repository-specific authority, privacy, release, and verification boundaries. Keep assistant-, model-, skill-, and orchestration-specific policy outside this file.

## Sources of truth

- `docs/product.md` and `docs/architecture.md` own product and system boundaries.
- `docs/development.md` owns build, browser, extension/native-host, packaging, and verification procedures.
- `docs/acceptance.md` owns acceptance evidence and unresolved qualification.
- `docs/google-catalogue.md` owns Google catalogue/OAuth recovery procedure and history.
- `docs/production-handoff.md` owns production handoff/release details.
- Privacy documents under `docs/` own the corresponding privacy commitments.

Load only the authority relevant to the task. Current source and fresh runtime evidence establish what is implemented.

## Browser and account authorization

The owner authorizes relevant development inspection and UI verification through the connected personal Chrome profile. A signed-in personal profile is not by itself a blocker.

Preserve existing extension identities, load locations, Chrome storage, settings, and upload checkpoints where practical. Standing authorization includes installing this repository's versioned Windows release as a normal update and interrupting or retrying an in-progress live upload when needed for relevant verification.

This does not authorize a fresh reinstall, removing/reinstalling extensions, unrelated account actions, public publishing, live Google mutation, real-media moves, changing OAuth clients/scopes/workbook selection, or bypassing browser/OS consent reserved for the human.

## Content-neutral engineering boundary

OFEnhancer may integrate with creator platforms containing sensitive material, but ordinary repository work is software engineering: extension/native-host integration, authenticated UI automation, file handoff, metadata mapping, draft preparation, diagnostics, testing, packaging, and release delivery.

Use generated benign test media and metadata whenever practical. Inspect only the account/page state needed to diagnose the software behavior. Stop at an unpublished prepared draft unless publication is explicitly authorized.
A platform-specific browser or site restriction applies only to the restricted interaction. Continue independent permissible engineering, diagnostics, mocks, recorder/trace/capture analysis, and work on other supported platforms.

Treat browser connection state as authoritative. Do not report an upload or preparation as active when the selected Chrome connection is missing, stale, disconnected, or unable to receive commands.

## Protected actions and tooling

The owner authorizes review and exact-file unblocking of trusted repository scripts when an Internet-download marker prevents required build/test tooling from running. Review the script first and scope `Unblock-File` to the exact repository file.

This does not authorize changing machine-wide execution policy, disabling security protections, public publishing, or unrelated installed integration.

Google credentials and tokens remain private. Follow `docs/google-catalogue.md`; check the existing DPAPI configuration before requesting replacement credentials. Never commit or log secrets or tokens.

## Verification and release

For browser-driven behavior, local/unit/transport tests are supporting evidence, not proof of the live workflow. Exercise the actual OFEnhancer/Chrome path when authorized access is available, or use the documented recorder/trace/capture evidence bridge when direct inspection is unavailable.

For user-facing UI changes, render the actual proposed interface and obtain the owner's requested visual review before packaging the release. Nonvisual fixes can follow the normal release path.

For a completed product release, follow the versioning, packaging, installation, and verification procedure in the owning development/production-handoff documentation. Preserve existing settings, extension identities, load locations, and storage.

A source change, passing test, packaged installer, installed update, live-site workflow, and publication are distinct evidence levels. Report only what was actually established.

## GitHub identity
This repository belongs to the `JohnnyGuides` GitHub account. Use repository-local `JohnnyGuides` authentication and `146333925+JohnnyGuides@users.noreply.github.com` for commits and pushes.

Do not replace the machine-wide `O-Marmullaku` credential used by other projects.

## Concurrent work and shared state

Concurrent work must not mutate the same Chrome profile state, extension identity, upload/draft state, OAuth/DPAPI state, installed native integration, or release artifact without deliberate isolation and ownership.

## Stop conditions

Stop the affected operation and preserve evidence when browser connection, extension identity, upload ownership, OAuth credential state, publication authority, or installed-release identity is uncertain.
