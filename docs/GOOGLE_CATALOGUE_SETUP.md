# Google catalogue setup

OFEnhancer 0.20.6 connects the Windows app to one Google spreadsheet. The
personal installer already contains its public Google app ID; it never contains
a client secret.

## Connect a spreadsheet

1. Open **Settings** and select **Connect Google Sheet**.
2. Finish consent in Chrome and select one spreadsheet.
3. Return to OFEnhancer and select **Check workbook**.
4. Read the proposed row and structure changes, then select **Review changes**.
5. Check the workbook name, sheet name, row count, change count, and conflicts.
6. Select **Yes, update the workbook** only when the review matches the copy you
   intend to change.

The first real migration requires a disposable-copy acceptance before the live
workbook. Copy the workbook, complete the full migration and sync check on that
copy, and verify the result before connecting the live workbook.

## Build a personalized installer

Create `.local/personal-installer.json` with a Desktop OAuth client from a
Google Cloud project that has the Google Picker, Drive, and Sheets APIs enabled:

```json
{
  "extensionId": "your-32-letter-extension-id",
  "googleOAuthClientId": "your-public-desktop-client-id.apps.googleusercontent.com"
}
```

`npm run build:desktop` reads this ignored local profile automatically. A
generic build without that profile exposes **Developer setup** for entering the
public client ID manually. Never paste or package a client secret.
