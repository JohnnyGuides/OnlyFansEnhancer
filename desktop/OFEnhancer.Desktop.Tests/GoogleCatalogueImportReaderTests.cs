using OFEnhancer.Protocol;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleCatalogueImportReaderTests
{
    private static readonly string[] WorkHeaders =
    [
        "ID", "Release Date", "Title", "Description", "Season / Arc", "Category", "Episode",
        "PornHub Link", "Tags", "Onlyfans Link", "Fansly Link", "ManyVids Link",
        "# teasers unposted", "# teasers", "Twitter Teaser(s)", "Clips4Sale Link", "Cost",
    ];

    [TestMethod]
    public void DetectReadsOnlyHeaderAndBindsExactMappingForLaterRead()
    {
        GoogleWorkbookSnapshot workbook = Workbook(Sheet(1, "Videos", Row(1, "ID", "Title")));
        GoogleCatalogueImportPreview preview = GoogleCatalogueImportReader.Detect(workbook);
        Assert.AreEqual(0, preview.Projection.Items.Count);
        Assert.AreEqual(1, preview.HeaderRow);
        Assert.IsTrue(preview.HasSameMapping(GoogleCatalogueImportReader.Detect(workbook)));
        Assert.IsFalse(preview.HasSameMapping(GoogleCatalogueImportReader.Detect(Workbook(
            Sheet(1, "Videos", Row(1, "Title", "ID"))))));
        Assert.IsFalse(preview.HasSameMapping(GoogleCatalogueImportReader.Detect(Workbook(
            Sheet(2, "Videos", Row(1, "ID", "Title"))))));
        Assert.IsFalse(preview.HasSameMapping(GoogleCatalogueImportReader.Detect(workbook with { WorkbookId = "other" })));
    }

    [TestMethod]
    public void ReadsActualWorkHeadersAndFindsCatalogueAmongUnrelatedTabs()
    {
        GoogleSheetSnapshot catalogue = Sheet(12, "2026 uploads",
            Row(1, WorkHeaders),
            Row(2, "item-1", "11.09.2026", "Example", "Description", "Arc", "Category", "04",
                "https://www.pornhub.com/view_video.php?viewkey=ph123", "tags",
                "https://onlyfans.com/123/example", "https://fansly.com/post/234",
                "https://www.manyvids.com/Video/345/title", "8", "2",
                "https://x.com/example/status/456", "https://www.clips4sale.com/studio/12/567/example", "0"));
        GoogleCatalogueImportPreview result = GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Home", Row(1, "Welcome", "Notes")), catalogue));

        Assert.AreEqual(12, result.CatalogueSheetId);
        Assert.AreEqual("2026 uploads", result.CatalogueSheetTitle);
        Assert.AreEqual(1, result.HeaderRow);
        Assert.AreEqual(3, result.Columns["title"]);
        WorkbookCatalogueItem item = result.Projection.Items.Single();
        Assert.AreEqual("item-1", item.SourceKey);
        Assert.AreEqual("2026-09-11", item.PlannedDate);
        Assert.AreEqual("Arc", item.Series);
        Assert.AreEqual("04", item.Episode);
        Assert.AreEqual(2, item.XTeasers);
        Assert.AreEqual(0, item.RedditTeasers);
        Assert.AreEqual(6, item.PlatformLinks.Count);
        Assert.AreEqual("https://www.manyvids.com/Video/345", item.PlatformLinks["manyvids"]);
        Assert.AreEqual("https://www.clips4sale.com/studio/12/567/example", item.PlatformLinks["clips4sale"]);
    }

    [TestMethod]
    public void FindsReorderedAliasesBelowNotesAndDefaultsMissingOptionalFields()
    {
        GoogleCatalogueImportPreview result = GoogleCatalogueImportReader.Read(Workbook(Sheet(2, "Videos",
            Row(1, "Some notes"), Row(3, "  NAME  ", "Video-ID", "release_date"),
            Row(4, "Title", "v1", "2026-09-12"), Row(5, "Note without an ID"), Row(6))));

        Assert.AreEqual(3, result.HeaderRow);
        WorkbookCatalogueItem item = result.Projection.Items.Single();
        Assert.AreEqual("v1", item.SourceKey);
        Assert.AreEqual("Title", item.Title);
        Assert.AreEqual(4, item.SourceRow);
        Assert.AreEqual("", item.Description);
        Assert.AreEqual(0, item.XTeasers);
        Assert.AreEqual(0, item.PlatformLinks.Count);
    }

    [TestMethod]
    public void RejectsMultipleCredibleTabsUntilOneIsExplicitlySelected()
    {
        GoogleWorkbookSnapshot workbook = Workbook(
            Sheet(1, "2026 Video Catalogue", Row(1, "ID", "Title"), Row(2, "a", "A")),
            Sheet(2, "Other catalogue", Row(1, "ID", "Name"), Row(2, "b", "B")));
        AssertCode("catalogue-tab-ambiguous", () => GoogleCatalogueImportReader.Read(workbook));
        Assert.AreEqual(2, GoogleCatalogueImportReader.Read(workbook, 2).CatalogueSheetId);
        AssertCode("catalogue-tab-not-found", () => GoogleCatalogueImportReader.Read(workbook, 9));
    }

    [DataTestMethod]
    [DataRow("2026 Video Catalogue")]
    [DataRow("2026_VIDEO_CATALOG")]
    public void NamedCatalogueTakesPriorityOverUnrelatedDuplicateAliasTimeline(string title)
    {
        GoogleWorkbookSnapshot workbook = Workbook(
            Sheet(1, "JV Timeline", Row(1, "Video ID", "Episode", "", "Video-ID", "Title", "", "", "", "Release date")),
            Sheet(2, title, Row(1, WorkHeaders), Row(2, "v1", "2026-09-01", "Example")));
        Assert.AreEqual(2, GoogleCatalogueImportReader.Detect(workbook).CatalogueSheetId);
        Assert.AreEqual(2, GoogleCatalogueImportReader.Read(workbook).CatalogueSheetId);
        AssertCode("catalogue-header-ambiguous", () => GoogleCatalogueImportReader.Detect(workbook, 1));
    }

    [TestMethod]
    public void NamedCatalogueTakesPriorityOverValidNonCatalogueTab()
    {
        GoogleWorkbookSnapshot workbook = Workbook(
            Sheet(1, "Timeline", Row(1, "ID", "Title")),
            Sheet(2, "Video Catalogue", Row(1, "ID", "Title")));
        Assert.AreEqual(2, GoogleCatalogueImportReader.Detect(workbook).CatalogueSheetId);
        Assert.AreEqual(1, GoogleCatalogueImportReader.Detect(workbook, 1).CatalogueSheetId);
    }

    [TestMethod]
    public void UniqueValidUnnamedTabIgnoresInvalidHeadersOnUnrelatedTab()
    {
        GoogleWorkbookSnapshot workbook = Workbook(
            Sheet(1, "JV Timeline", Row(1, "Video ID", "Video-ID", "Title")),
            Sheet(2, "Videos", Row(1, "ID", "Title")));
        Assert.AreEqual(2, GoogleCatalogueImportReader.Detect(workbook).CatalogueSheetId);
    }

    [TestMethod]
    public void InvalidNamedCatalogueDoesNotFallBackToUnrelatedValidTimeline()
    {
        GoogleSheetSnapshot timeline = Sheet(1, "Timeline", Row(1, "ID", "Title"));
        AssertCode("catalogue-header-ambiguous", () => GoogleCatalogueImportReader.Detect(Workbook(timeline,
            Sheet(2, "Video Catalogue", Row(1, "ID", "Title", "Name")))));
        AssertCode("catalogue-header-ambiguous", () => GoogleCatalogueImportReader.Detect(Workbook(timeline,
            Sheet(2, "Video Catalogue", Row(1, "ID", "Title"), Row(3, "ID", "Title")))));
        AssertCode("catalogue-tab-not-found", () => GoogleCatalogueImportReader.Detect(Workbook(timeline,
            Sheet(2, "Video Catalogue", Row(1, "Missing required headers")))));
    }

    [DataTestMethod]
    [DataRow("Videos")]
    [DataRow("Cataloguing notes")]
    public void MultipleValidUnnamedTabsRemainAmbiguous(string title)
    {
        AssertCode("catalogue-tab-ambiguous", () => GoogleCatalogueImportReader.Detect(Workbook(
            Sheet(1, title, Row(1, "ID", "Title")), Sheet(2, "Timeline", Row(1, "ID", "Title")))));
    }

    [TestMethod]
    public void RejectsDuplicateHeaderAliasesAndMultipleHeaderRows()
    {
        AssertCode("catalogue-header-ambiguous", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title", "Name"), Row(2, "v1", "A", "B")))));
        AssertCode("catalogue-header-ambiguous", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title"), Row(3, "ID", "Title")))));
        AssertCode("catalogue-header-ambiguous", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title", "OnlyFans", "Onlyfans Link")))));
    }

    [TestMethod]
    public void IgnoresHiddenTabsAndDoesNotScanHeadersPastTwentyRows()
    {
        AssertCode("catalogue-tab-not-found", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Hidden", Row(1, "ID", "Title")) with { Hidden = true },
            Sheet(2, "Late", Row(21, "ID", "Title")))));
    }

    [TestMethod]
    public void RejectsMissingTitlesDuplicateIdsAndOversizedTitles()
    {
        AssertCode("invalid-workbook-projection", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title"), Row(2, "id")))));
        AssertCode("invalid-workbook-projection", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title"), Row(2, "id", "A"), Row(3, "id", "B")))));
        AssertCode("invalid-workbook-projection", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title"), Row(2, "id", new string('x', 301))))));
    }

    [DataTestMethod]
    [DataRow("https://evil.example/post/123")]
    [DataRow("http://onlyfans.com/123")]
    [DataRow("https://user:password@onlyfans.com/123")]
    public void PreservesMalformedLinkAsInertSourceAndReportsOnlyLocation(string link)
    {
        GoogleCatalogueImportPreview preview = GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title", "Onlyfans Link"), Row(2, "id", "A", link))));
        WorkbookCatalogueItem item = preview.Projection.Items.Single();
        Assert.IsFalse(item.PlatformLinks.ContainsKey("onlyfans"));
        Assert.AreEqual(link, item.SourceLinkCells!["onlyfans"].Text);
        Assert.AreEqual(0, item.SourceLinkCells["onlyfans"].Urls.Count);
        GoogleCatalogueImportIssue issue = preview.Issues!.Single();
        Assert.AreEqual("invalid-workbook-link", issue.Code);
        Assert.AreEqual(2, issue.Row);
        Assert.AreEqual(3, issue.Column);
    }

    [TestMethod]
    public void ReadsHyperlinkLabelAndPreservesBothConflictingTargetsWithoutChoosingOne()
    {
        GoogleWorkbookRowSnapshot row = new(2,
            [new("v1", null), new("Title", null), new("Open post", "https://onlyfans.com/123")]);
        GoogleSheetSnapshot sheet = Sheet(1, "Videos", Row(1, "ID", "Title", "Onlyfans Link"), row);
        Assert.AreEqual("https://onlyfans.com/123", GoogleCatalogueImportReader.Read(Workbook(sheet)).Projection.Items.Single().PlatformLinks["onlyfans"]);
        row = row with { Cells = [new("v1", null), new("Title", null), new("https://onlyfans.com/456", "https://onlyfans.com/123")] };
        GoogleCatalogueImportPreview preview = GoogleCatalogueImportReader.Read(Workbook(sheet with { Rows = [sheet.Rows[0], row] }));
        WorkbookCatalogueItem item = preview.Projection.Items.Single();
        Assert.IsFalse(item.PlatformLinks.ContainsKey("onlyfans"));
        Assert.AreEqual(2, item.SourceLinkCells!["onlyfans"].Urls.Count);
        Assert.AreEqual("https://onlyfans.com/456", item.SourceLinkCells["onlyfans"].Text);
        Assert.AreEqual("https://onlyfans.com/123", item.SourceLinkCells["onlyfans"].Hyperlink);
        Assert.AreEqual("catalogue-link-conflict", preview.Issues!.Single().Code);
    }

    [TestMethod]
    public void PreservesAllTeaserUrlsAndRaisesCountWithoutPickingAPrimary()
    {
        const string text = "https://x.com/example/status/123,\nhttps://x.com/example/status/456; https://x.com/example/status/123";
        GoogleCatalogueImportPreview preview = GoogleCatalogueImportReader.Read(Workbook(Sheet(1, "Videos",
            Row(1, "ID", "Title", "Twitter Teaser(s)", "# teasers"), Row(2, "id", "A", text, "1"))));
        WorkbookCatalogueItem item = preview.Projection.Items.Single();
        Assert.IsFalse(item.PlatformLinks.ContainsKey("x"));
        Assert.AreEqual(text, item.SourceLinkCells!["x"].Text);
        CollectionAssert.AreEqual(new[] { "https://x.com/example/status/123", "https://x.com/example/status/456" }, item.SourceLinkCells["x"].Urls.ToArray());
        Assert.AreEqual(2, item.XTeasers);
        Assert.AreEqual(0, preview.Issues!.Count);
    }

    [DataTestMethod]
    [DataRow("09/11/2026", "0", "invalid-workbook-date")]
    [DataRow("31.02.2026", "0", "invalid-workbook-date")]
    [DataRow("", "-1", "invalid-workbook-count")]
    [DataRow("", "1.5", "invalid-workbook-count")]
    public void RejectsAmbiguousDatesAndInvalidCounts(string date, string count, string code)
    {
        AssertCode(code, () => GoogleCatalogueImportReader.Read(Workbook(Sheet(1, "Videos",
            Row(1, "ID", "Title", "Release Date", "# teasers"), Row(2, "id", "A", date, count)))));
    }

    [TestMethod]
    public void RejectsTruncatedSnapshotsAndEmptyCatalogues()
    {
        AssertCode("workbook-row-limit", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title")) with { RowCount = 5003 })));
        AssertCode("catalogue-empty", () => GoogleCatalogueImportReader.Read(Workbook(
            Sheet(1, "Videos", Row(1, "ID", "Title")))));
    }

    [TestMethod]
    public void ReimportKeepsLocalIdentityWhenRowsMove()
    {
        string directory = Path.Combine(Path.GetTempPath(), "ofenhancer-import-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            using CatalogueStore store = CatalogueStore.Open(Path.Combine(directory, "catalogue.db"));
            GoogleSheetSnapshot sheet = Sheet(1, "Videos", Row(1, "ID", "Title"), Row(2, "id", "A"));
            store.ImportWorkbookProjection(GoogleCatalogueImportReader.Read(Workbook(sheet)).Projection);
            string identity = store.GetItems().Single().ItemId;
            sheet = sheet with { Rows = [Row(1, "Title", "ID"), Row(5, "Updated", "id")] };
            store.ImportWorkbookProjection(GoogleCatalogueImportReader.Read(Workbook(sheet)).Projection);
            Assert.AreEqual(identity, store.GetItems().Single().ItemId);
            Assert.AreEqual(5, store.GetItems().Single().SourceRow);
            Assert.AreEqual("Updated", store.GetItems().Single().Title);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(directory, recursive: true);
        }
    }

    private static GoogleCatalogueException AssertCode(string code, Action action)
    {
        try { action(); }
        catch (GoogleCatalogueException error)
        {
            Assert.AreEqual(code, error.Code);
            return error;
        }
        Assert.Fail("Expected GoogleCatalogueException: " + code);
        throw new InvalidOperationException();
    }

    private static GoogleWorkbookSnapshot Workbook(params GoogleSheetSnapshot[] sheets) => new("workbook", "Work", sheets, []);
    private static GoogleSheetSnapshot Sheet(int id, string title, params GoogleWorkbookRowSnapshot[] rows) => new(id, title, false, 1000, 24, rows);
    private static GoogleWorkbookRowSnapshot Row(int number, params string[] values) => new(number, values.Select(value => new GoogleWorkbookCellSnapshot(value, null)).ToArray());
}
