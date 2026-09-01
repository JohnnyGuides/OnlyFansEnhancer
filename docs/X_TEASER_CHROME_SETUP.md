# Chrome X teaser setup

This workflow belongs to the personal Chrome extension only. It does not alter the Chrome Web Store edition.

1. Build the extension with `npm run build:personal` and load this repository (or the unpacked ZIP contents) from `chrome://extensions` with Developer mode enabled.
2. Build the helper with `npm run build:x-teaser-host`.
3. Extract the native-host ZIP into a permanent directory.
4. Copy `config.example.json` to `config.json`. Set `teaserRoot` to the directory containing pending teasers and `auditRoot` to a prepared audit fixture. Both roots and `<teaserRoot>/Done` must already exist. Do not point the first rehearsal at real media.
5. Read the extension ID on `chrome://extensions`, then run `install-current-user.ps1 -ExtensionId <exact-id>` from the extracted native-host directory. This is the only step that writes HKCU.
6. Reload the extension. Open **X teaser recorder**, select a teaser, explicitly choose its catalogue row, and confirm.

The recorder holds the selected file and its three JPEG audit frames only in that tab. It stores only basename, size, modified time, duration, SHA-256, catalogue identity, and bounded X status metadata.

Reconciliation is ordered and fail-closed: local audit, catalogue column O, then move to `Done`. A failure stops the later stages. The extension never overwrites a Sheet link, audit frame, receipt, or destination file.
