# Google catalogue setup

OFEnhancer 0.20.5 connects the Windows app to one Google spreadsheet. Complete
this setup in the desktop app.

## Create Google access

1. In Google Cloud, create an OAuth client for a Desktop app.
2. Enable the Google Picker API, Google Drive API, and Google Sheets API for the
   same project.
3. Copy the client ID. Do not paste a client secret into OFEnhancer.

## Connect a spreadsheet

1. Open **Settings**, then expand **Google setup**.
2. Paste only the client ID and select **Save setup**.
3. Open **Catalogue** and select **Connect Google Sheet**.
4. Finish consent in the system browser and select one spreadsheet.
5. Return to OFEnhancer and select **Check workbook**.
6. Read the proposed row and structure changes, then select **Review changes**.
7. Check the workbook name, sheet name, row count, change count, and conflicts.
8. Select **Yes, update the workbook** only when the review matches the copy you
   intend to change.

The first real migration requires a disposable-copy acceptance before the live
workbook. Copy the workbook, complete the full migration and sync check on that
copy, and verify the result before connecting the live workbook.
