# Upload Trace Recorder Implementation Plan

**Goal:** Add a bounded, sanitized upload-flow recorder to the existing
personal Creator Workflow Toolkit without changing the store edition.

**Spec:**
`docs/superpowers/specs/2026-08-21-upload-trace-recorder-design.md`

## Tasks

- [x] Write sanitizer and browser lifecycle tests for a two-click recorder.
- [x] Implement local trace storage, refresh persistence, observers, limits,
      Shadow DOM controls, and JSON download.
- [x] Replace the standalone diagnostic-extension boundary with an integrated
      personal-tool boundary after user approval.
- [x] Define `uploadTraceRecorder` as read-only, enabled by default, and never
      autorun.
- [x] Register the recorder independently for OnlyFans, Fansly, ManyVids, and
      Pornhub so one missing optional permission cannot disable another site.
- [x] Add the settings control and personal-package validation entry.
- [x] Remove the obsolete standalone diagnostic manifest and script.
- [x] Add provenance-aware structured control events and shared-runtime
      markers for helper panel actions, control mutations, and outcomes.
- [x] Keep the recorder on the bottom-left so bottom-right autofill panels
      cannot cover its Start/Stop controls.
- [x] Exercise the complete unpacked extension on intercepted, zero-network
      fixtures for all four supported origins, including helper provenance,
      refresh resume, download, link capture, and privacy exclusions.
- [x] Run focused tests, formatting, lint, typecheck, all repository tests, and
      both validated package builds.
- [ ] Reload extension ID `cfkenejbehihjmeokedjfccmhffeahgh` in Chrome.
- [ ] Record one real upload on each platform and derive permanent adapters
      from the resulting evidence.
