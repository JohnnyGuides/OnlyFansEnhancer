# Catalogue Core Milestone 2A Implementation Plan

> Execute in the `codex/catalogue-core-m2a` worktree. Keep all fixtures inert
> and all database/filesystem tests inside temporary directories.

**Goal:** Deliver a recoverable local catalogue, deterministic thumbnail
matching, and a truthful desktop Catalogue interface without touching the live
Sheet or authenticated platforms.

**Architecture:** A small `OFEnhancer.Catalogue` library owns SQLite,
validation, inventory, and matching. The WPF host exposes bounded WebView
operations and opaque thumbnail resources. The existing plain HTML/CSS/JS app
renders those results.

**Stack:** .NET 8, Microsoft.Data.Sqlite 8.0.20, WPF/WebView2, plain JavaScript,
Node test runner, Playwright.

---

## Task 1: Establish the storage and migration contract

**Files:**

- Create: `desktop/OFEnhancer.Catalogue/OFEnhancer.Catalogue.csproj`
- Create: `desktop/OFEnhancer.Catalogue/CatalogueStore.cs`
- Create: `desktop/OFEnhancer.Catalogue/Migrations.cs`
- Create: `desktop/OFEnhancer.Catalogue/Models.cs`
- Create: `desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj`
- Create: `desktop/OFEnhancer.Catalogue.Tests/CatalogueStoreTests.cs`
- Modify: `desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj`

1. Write tests that require a fresh temporary store to create only the v1 core
   tables and report `user_version = 1`.
2. Run the new test project and observe the compile/test failure.
3. Implement the smallest store, schema, connection settings, and disposal.
4. Add a migration-failure test with a v0 database containing a sentinel row;
   require a verified backup, rollback/restore, and preserved sentinel.
5. Implement backup, integrity verification, transactional migration, and
   recovery. Keep the failure seam internal to the test assembly.
6. Run the storage tests and the existing desktop tests.

## Task 2: Import a bounded catalogue snapshot

**Files:**

- Create: `desktop/OFEnhancer.Catalogue/CatalogueSnapshotImporter.cs`
- Create: `desktop/OFEnhancer.Catalogue.Tests/CatalogueSnapshotImporterTests.cs`
- Modify: `desktop/OFEnhancer.Catalogue/Models.cs`
- Modify: `desktop/OFEnhancer.Catalogue/CatalogueStore.cs`

1. Write failing tests for one valid snapshot, stable opaque IDs on re-import,
   archive-not-delete behavior, and preserved confirmed bindings.
2. Add failing whole-transaction tests for duplicate keys, unknown fields,
   invalid dates/counts/URLs, and size/item limits.
3. Implement strict JSON DTOs and validation, then one import transaction.
4. Return a bounded import summary and append one meaningful audit event.
5. Run importer and storage tests.

## Task 3: Inventory and match curated thumbnails

**Files:**

- Create: `desktop/OFEnhancer.Catalogue/ThumbnailInventory.cs`
- Create: `desktop/OFEnhancer.Catalogue/CatalogueMatcher.cs`
- Create: `desktop/OFEnhancer.Catalogue.Tests/ThumbnailInventoryTests.cs`
- Create: `desktop/OFEnhancer.Catalogue.Tests/CatalogueMatcherTests.cs`
- Modify: `desktop/OFEnhancer.Catalogue/CatalogueStore.cs`

1. Write failing temporary-folder tests for allowed formats, role hints,
   SHA-256 identity, reparse/out-of-root rejection, limits, and unavailable
   files after a rescan.
2. Implement the read-only scanner and transactional asset upsert.
3. Write failing matching tests proving that text evidence returns a ranked
   ambiguity and never auto-binds, while an existing exact-hash binding does.
4. Implement deterministic normalization/scoring and the five-candidate cap.
5. Write and satisfy confirmation tests: one click persists, audits, and
   survives a same-content rename.
6. Run all catalogue tests.

## Task 4: Expose a strict desktop catalogue boundary

**Files:**

- Modify: `desktop/OFEnhancer.Desktop/WebMessageRouter.cs`
- Modify: `desktop/OFEnhancer.Desktop/MainWindow.xaml.cs`
- Modify: `desktop/OFEnhancer.Desktop/App.xaml.cs`
- Create: `desktop/OFEnhancer.Desktop/ThumbnailResourceHandler.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/WebMessageRouterTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/ThumbnailResourceHandlerTests.cs`

1. Write failing router tests for the four operations, strict payloads,
   bounded responses, unknown assets, and desktop-only errors.
2. Inject the real catalogue service into the router and implement the
   operations without returning paths.
3. Write failing resolver tests for a known image, traversal, unknown ID,
   unavailable file, and configured-root escape.
4. Implement opaque thumbnail resolution and wire the WebView resource event.
5. Run both desktop .NET test projects.

## Task 5: Build the Catalogue interface

**Files:**

- Modify: `app/index.html`
- Modify: `app/app.js`
- Modify: `app/app.css`
- Create: `tests/desktop-catalogue-ui.test.cjs`
- Modify: `package.json`

1. Load Impeccable's craft floor immediately before UI editing.
2. Write a failing Playwright test using the app's explicit test host. Cover
   first-run, populated, search/filter, needs-selection, confirmation, failure,
   keyboard, desktop/compact/mobile overflow, and console errors.
3. Replace the placeholder Catalogue panel with the compact operative layout.
   Keep copy short and render no absolute local path.
4. Implement state, escaping by DOM construction, operations, filters, status,
   and the native candidate dialog.
5. Run the UI test, then inspect 1440, 800, and 390 widths in one browser pass.
6. Run the Impeccable mechanical detector once and fix applicable findings.
7. Fetch the current Web Interface Guidelines, audit changed UI files, and fix
   applicable accessibility/usability findings.

## Task 6: Package, document, and prove the milestone

**Files:**

- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj`
- Modify: `README.md`
- Modify: `PRODUCT.md` only if implementation truth changes
- Modify: `scripts/build-desktop-package.ps1` only if the new runtime is not
  carried automatically
- Modify: `tests/desktop-package.test.cjs`

1. Bump the personal/desktop version to `0.19.0`; keep the store edition's
   independent product boundary unchanged.
2. Update README with database location, backup behavior, safe snapshot
   contract, thumbnail matching rules, and explicit M2B/live limits.
3. Extend package verification to require the SQLite runtime and prohibit
   database/backup/snapshot/test artifacts and the creator's absolute path.
4. Run formatting, lint, type checks, all JS tests, both .NET test projects,
   desktop stage, personal/store package builds, and package lifecycle tests.
5. Launch the staged desktop app with isolated local-app-data and WebView2
   folders; exercise Catalogue import/scan using inert fixtures only and verify
   the rendered UI and browser console.
6. Run a fresh code review, fix material findings, repeat affected checks, then
   merge the branch into local `main` without pushing.
