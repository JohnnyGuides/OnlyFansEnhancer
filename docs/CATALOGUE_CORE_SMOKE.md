# Catalogue core smoke test

This milestone is offline and read-only outside its own local database. Use
fixtures or disposable folders only. Do not connect a live Google Sheet, open
an authenticated creator-site workflow, post, install, or move real media.

## Automated gate

From the repository root, run:

```powershell
dotnet test desktop\OFEnhancer.Catalogue.Tests\OFEnhancer.Catalogue.Tests.csproj
dotnet test desktop\OFEnhancer.Protocol.Tests\OFEnhancer.Protocol.Tests.csproj
npm run test:desktop-catalogue-ui
npm run test:desktop-package
npm run stage:desktop
```

Expected results:

- a fresh database contains only the approved v1 catalogue tables;
- failed migrations restore a verified sibling backup;
- malformed, duplicate, unsafe, non-canonical, or over-limit snapshots change
  nothing;
- thumbnail scans retain SHA-256 identity across renames and never leave their
  configured root, including if a queued directory is replaced by a junction;
- filename and catalogue wording rank at most five choices but never bind by
  themselves;
- the UI exposes only opaque thumbnail URLs and remains usable at desktop,
  compact, and mobile widths;
- the staged package contains the SQLite runtime but no database, backup,
  snapshot, test fixture, or creator media path.

## Inert desktop check

1. Start the staged desktop app with temporary data and WebView folders:

   ```powershell
   $env:OFENHANCER_DATA_ROOT = Join-Path $env:TEMP "ofenhancer-catalogue-smoke"
   $env:OFENHANCER_WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:TEMP "ofenhancer-webview-smoke"
   .\dist\ofenhancer-desktop-v0.20.1\desktop\OFEnhancer.Desktop.exe
   ```

2. Open **Catalogue**. With no import, it must say **No videos yet** rather
   than showing sample data.
3. Import a small fixture snapshot, click **Scan thumbnails**, and choose a
   disposable folder in the native picker. Check the rows, X/Reddit counts,
   platform badges, and missing-match list.
4. Rename or remove that disposable folder, scan again, and confirm the native
   picker lets you choose its replacement.
5. Open **Choose video**. Escape must close the picker and restore focus. Reopen
   it, choose one candidate, and verify the match persists after renaming the
   fixture image and rescanning.
6. Stop if the UI reveals an absolute path, silently binds an uncertain image,
   reports false success, or logs an uncaught browser error.

Delete only the temporary folders created for this check when finished.
