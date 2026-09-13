using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleSheetReferenceTests
{
    [DataTestMethod]
    [DataRow("https://docs.google.com/spreadsheets/d/workbook-123/edit", "workbook-123", null)]
    [DataRow("  https://docs.google.com/spreadsheets/d/workbook_ABC-123/edit#gid=2126708696  ", "workbook_ABC-123", 2126708696)]
    [DataRow("https://docs.google.com/spreadsheets/d/workbook-123/edit?usp=sharing#gid=17", "workbook-123", 17)]
    public void ParseAcceptsGoogleSpreadsheetUrlsAndPreservesWorksheetGid(
        string value,
        string workbookId,
        int? sheetId
    )
    {
        GoogleSheetReference result = GoogleSheetReference.Parse(value);

        Assert.AreEqual(workbookId, result.WorkbookId);
        Assert.AreEqual(sheetId, result.SheetId);
        Assert.AreEqual(
            sheetId is null
                ? $"https://docs.google.com/spreadsheets/d/{workbookId}/edit"
                : $"https://docs.google.com/spreadsheets/d/{workbookId}/edit#gid={sheetId}",
            result.CanonicalUrl
        );
    }

    [DataTestMethod]
    [DataRow("")]
    [DataRow("https://docs.google.com/document/d/workbook-123/edit")]
    [DataRow("https://evil.example/spreadsheets/d/workbook-123/edit")]
    [DataRow("http://docs.google.com/spreadsheets/d/workbook-123/edit")]
    [DataRow("https://user:password@docs.google.com/spreadsheets/d/workbook-123/edit")]
    [DataRow("https://docs.google.com:444/spreadsheets/d/workbook-123/edit")]
    [DataRow("https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=-1")]
    [DataRow("https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=not-a-number")]
    [DataRow("https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=1&gid=2")]
    public void ParseRejectsAnythingThatIsNotASafeGoogleSpreadsheetUrl(string value)
    {
        GoogleSheetReferenceException error = Assert.ThrowsException<GoogleSheetReferenceException>(
            () => GoogleSheetReference.Parse(value)
        );

        Assert.AreEqual("invalid-google-sheet-url", error.Code);
    }
}
