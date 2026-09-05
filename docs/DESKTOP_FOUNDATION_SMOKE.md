# Desktop foundation smoke test

This checklist verifies the current OFEnhancer 0.20.5 desktop candidate
without publishing, writing the catalogue, changing Chrome profiles,
registering a native host, running the installer, or moving real media.

## Automated gate

Run these commands from the repository root:

```powershell
dotnet test desktop\OFEnhancer.sln -c Release
dotnet build desktop\OFEnhancer.sln -c Release
npm run check
```

The gate must prove all of the following:

- the strict protocol and current-user pipe pass their .NET tests;
- the real desktop executable and stateless bridge complete one status request;
- the shared UI renders at 1440×900, 800×700, and 390×844 without horizontal
  overflow or console errors;
- a real isolated Chromium profile attaches one inert temporary file to one
  synthetic upload control, observes one input and one change event, and can
  attach again after a failed selector;
- the stage-only package checks `--status-json`, launches the real WebView2
  shell, rejects a second authority, survives a window close in the tray,
  verifies every staged hash, and contains no test traces, private settings,
  tokens, workbook IDs, media roots, or repository metadata;
- the personal and store ZIPs both validate, while the store manifest still
  excludes `debugger`, `nativeMessaging`, desktop code, and the local file
  attacher.

The automated tests create only disposable profiles, inert temporary files,
and disposable package directories. They do not visit an authenticated creator
page or click any platform control.

## Safe desktop launch

1. Start `desktop\OFEnhancer.Desktop\bin\Release\net8.0-windows\OFEnhancer.Desktop.exe`.
2. Confirm one process opens and a second launch exits instead of creating a
   second authority.
3. Confirm the window uses the supplied logo and shows Uploads, Catalogue,
   Teasers, Attention, and Settings.
4. Close the window. Confirm the process remains in the tray.
5. Use tray **Open**, then tray **Exit**. Confirm the process ends.

This launch does not install anything. Do not run the registration scripts for
this inspection.

## Human authenticated gate

This gate requires the creator to be signed in. It remains inspection-only.

1. Load the exact staged `extension` folder in Chrome and copy its 32-letter
   ID. Do not remove the current working extension until migration data has
   been exported in a later milestone.
2. Start the staged desktop app. For the first controlled setup only, run the
   registration script with the exact staged root and copied ID. Read back the
   HKCU native-host value before continuing.
3. Open one supported site's real upload page and select a harmless local test
   file in OFEnhancer.
4. Confirm the expected real file control receives the file and the debugger
   banner disappears after attachment.
5. Review the prepared form. Do not press Save, Schedule, Post, Submit, or any
   equivalent final control.
6. Repeat only on sites whose current trace evidence is complete. Stop on a
   missing, duplicate, hidden, renamed, or ambiguous control.

The human pass must separately record Chrome version, extension ID, site,
route, observed filename, whether attachment completed, whether the debugger
detached, and that no final platform action occurred. Do not record account
identifiers, captions, cookies, headers, request bodies, or private page HTML.

## Installer status

`npm run stage:desktop` is the authoritative package proof for
`dist\ofenhancer-desktop-v0.20.5\`. `npm run build:desktop` compiles
`OFEnhancer-Setup-0.20.5.exe` only when Inno Setup 6 is installed. A successful
stage followed by `INNO_COMPILER_MISSING` is not an installer build and must
not be reported as one.
