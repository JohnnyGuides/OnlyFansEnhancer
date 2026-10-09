using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleTeaserLinkWriterTests
{
    private const string Sheet = "2026 Video Catalogue";
    private const string NewLink = "https://x.com/Owner_Handle/status/500";

    [DataTestMethod]
    [DataRow("onlyfans", "OnlyFans", "https://onlyfans.com/500/johnny_guides")]
    [DataRow("fansly", "Fansly", "https://fansly.com/post/500")]
    [DataRow("manyvids", "ManyVids", "https://www.manyvids.com/Video/500")]
    public async Task VerifiedPlatformLinkWritesOnlyItsEmptyCellAndNeverRepeatsAnAttempt(string platform, string header, string url)
    {
        FakeSheet sheet = Workbook();
        sheet.SetCell(1, 4, header);
        var intent = new OFEnhancer.Catalogue.UploadSheetWriteback("key", "workbook-one", "7", "ep-a",
            platform, url, "Episode A", "");
        int attempts = 0;
        GoogleTeaserLinkResult result = await Writer(sheet).WriteResultAsync(intent, _ => attempts++, CancellationToken.None);
        Assert.AreEqual("appended", result.Status);
        Assert.AreEqual(1, attempts);
        Assert.AreEqual(url, sheet.Cell(2, 4));
        Assert.AreEqual(1, sheet.Posts.Single().GetProperty("data").GetArrayLength());
        Assert.AreEqual("already-present", (await Writer(sheet).WriteResultAsync(intent with { State = "attempted" },
            _ => Assert.Fail("Reconciliation must not write"), CancellationToken.None)).Status);

        FakeSheet unresolved = Workbook();
        unresolved.SetCell(1, 4, header);
        Assert.AreEqual("google-row-write-unresolved", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(unresolved).WriteResultAsync(intent with { State = "attempted" }, _ => Assert.Fail(), CancellationToken.None))).Code);
        Assert.AreEqual(0, unresolved.Posts.Count);
    }

    [TestMethod]
    public async Task ScriptLinksAppendToColumnYThroughTheSameRowGuards()
    {
        const string first = "https://johnnyguides.com/sync/scripts/episode-a.funscript";
        const string second = "https://johnnyguides.com/sync/scripts/episode-a-intro.funscript";
        static string[] Row(params string[] start) => [.. start, .. Enumerable.Repeat("", 25 - start.Length)];
        string[] header = Row("ID", "Title", "Release");
        header[24] = "Script";
        FakeSheet sheet = new([header, Row("ep-a", "Episode A"), Row("ep-b", "Episode B")]);
        var intent = new OFEnhancer.Catalogue.UploadSheetWriteback("key", "workbook-one", "7", "ep-a",
            "script", first, "Episode A", "");

        Assert.AreEqual("appended", (await Writer(sheet).WriteResultAsync(intent, _ => { }, CancellationToken.None)).Status);
        Assert.AreEqual($"'{Sheet}'!Y2", sheet.Posts.Single().GetProperty("data")[0].GetProperty("range").GetString());
        Assert.AreEqual(first, sheet.Cell(2, 25));
        Assert.AreEqual("already-present", (await Writer(sheet).WriteResultAsync(intent,
            _ => Assert.Fail("An existing script link is not written again"), CancellationToken.None)).Status);
        // A second lead-in variant joins the cell instead of being a conflict.
        await Writer(sheet).WriteResultAsync(intent with { Key = "key-2", Url = second }, _ => { }, CancellationToken.None);
        Assert.AreEqual(first + "\n" + second, sheet.Cell(2, 25));

        sheet.BeforeCellRead = () => sheet.SetCell(2, 25, "owner edit");
        Assert.AreEqual("catalogue-entry-changed", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).WriteResultAsync(intent with { Key = "key-3", Url = first.Replace("a.funscript", "a3.funscript",
                StringComparison.Ordinal) }, _ => Assert.Fail(), CancellationToken.None))).Code);
        sheet.BeforeCellRead = null;
        sheet.SetCell(2, 25, first);
        Assert.AreEqual("teaser-status-elsewhere", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).WriteResultAsync(intent with { SourceKey = "ep-b", Title = "Episode B" }, _ => Assert.Fail(),
                CancellationToken.None))).Code);
        Assert.AreEqual("invalid-teaser-link", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).WriteResultAsync(intent with { Url = "https://example.com/sync/scripts/a.funscript" }, _ => Assert.Fail(),
                CancellationToken.None))).Code);
        Assert.AreEqual(2, sheet.Posts.Count);
    }

    [TestMethod]
    public async Task PlatformResultRefusesConflictingCellChangedMetadataAndWrongSheet()
    {
        FakeSheet sheet = Workbook();
        sheet.SetCell(1, 4, "Fansly");
        var intent = new OFEnhancer.Catalogue.UploadSheetWriteback("key", "workbook-one", "7", "ep-a",
            "fansly", "https://fansly.com/post/500", "Episode A", "");
        async Task Refused(OFEnhancer.Catalogue.UploadSheetWriteback job, string code) =>
            Assert.AreEqual(code, (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
                Writer(sheet).WriteResultAsync(job, _ => Assert.Fail(), CancellationToken.None))).Code);
        await Refused(intent with { SheetId = "99" }, "catalogue-layout-changed");
        await Refused(intent with { Title = "Different episode" }, "catalogue-entry-changed");
        sheet.SetCell(2, 4, "https://fansly.com/post/400");
        await Refused(intent, "platform-link-conflict");
        sheet.SetCell(2, 4, "", "https://fansly.com/post/400");
        await Refused(intent, "platform-link-conflict");
        sheet.SetCell(2, 4, intent.Url, "https://fansly.com/post/400");
        await Refused(intent, "platform-link-conflict");
        sheet.SetCell(2, 4, intent.Url);
        await Refused(intent with { State = "attempted", Title = "Different episode" }, "catalogue-entry-changed");
        Assert.AreEqual(0, sheet.Posts.Count);
    }

    [TestMethod]
    public async Task MetadataChangedAfterDispatchLeavesTheWriteUnresolved()
    {
        FakeSheet sheet = Workbook();
        sheet.SetCell(1, 4, "Fansly");
        sheet.AfterWrite = () => sheet.SetCell(2, 2, "Changed episode");
        var intent = new OFEnhancer.Catalogue.UploadSheetWriteback("key", "workbook-one", "7", "ep-a",
            "fansly", "https://fansly.com/post/500", "Episode A", "");
        Assert.AreEqual("google-row-write-unresolved", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).WriteResultAsync(intent, _ => { }, CancellationToken.None))).Code);
        Assert.AreEqual(1, sheet.Posts.Count);
    }

    [TestMethod]
    public async Task AppendingToAWholeCellLinkedUrlIsRefused()
    {
        FakeSheet sheet = Workbook();
        sheet.SetCell(4, 4, "https://x.com/Owner_Handle/status/13", "https://x.com/Owner_Handle/status/13");
        Assert.AreEqual("teaser-cell-linked", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).AppendAsync("ep-c", NewLink, CancellationToken.None))).Code);
        Assert.AreEqual(0, sheet.Posts.Count);
    }

    [TestMethod]
    public async Task AppendsToAnEmptyCellAsTheOnlyLink()
    {
        FakeSheet sheet = Workbook();
        GoogleTeaserLinkResult result = await Writer(sheet).AppendAsync("ep-a", NewLink, CancellationToken.None);

        Assert.AreEqual("appended", result.Status);
        Assert.AreEqual(NewLink, sheet.Cell(2, 4));
        Assert.AreEqual(NewLink, result.Preview.Projection.Items.Single(item => item.SourceKey == "ep-a").SourceLinkCells!["x"].Urls.Single());
        Assert.AreEqual(1, sheet.Posts.Count);
        Assert.AreEqual("RAW", sheet.Posts[0].GetProperty("valueInputOption").GetString());
        Assert.AreEqual($"'{Sheet}'!D2", sheet.Posts[0].GetProperty("data")[0].GetProperty("range").GetString());
        Assert.AreEqual(1, sheet.Posts[0].GetProperty("data").GetArrayLength(), "no other column is written");
        Assert.AreEqual("0", sheet.Cell(2, 5), "the teaser count column is left alone");
    }

    [TestMethod]
    public async Task AppendsAfterExistingLinksWithTheCellsOwnSeparator()
    {
        FakeSheet sheet = Workbook();
        await Writer(sheet).AppendAsync("ep-b", NewLink, CancellationToken.None);
        Assert.AreEqual("https://x.com/Owner_Handle/status/11, https://twitter.com/Owner_Handle/status/12, " + NewLink,
            sheet.Cell(3, 4));
    }

    [TestMethod]
    public async Task SingleLinkCellFollowsTheColumnConventionOrDefaultsToALineBreak()
    {
        FakeSheet sheet = Workbook();
        await Writer(sheet).AppendAsync("ep-c", NewLink, CancellationToken.None);
        Assert.AreEqual("https://x.com/Owner_Handle/status/13, " + NewLink, sheet.Cell(4, 4));

        FakeSheet plain = Workbook();
        plain.SetCell(3, 4, "https://x.com/Owner_Handle/status/11");
        await Writer(plain).AppendAsync("ep-c", NewLink, CancellationToken.None);
        Assert.AreEqual("https://x.com/Owner_Handle/status/13\n" + NewLink, plain.Cell(4, 4));
        Assert.AreEqual("https://x.com/Owner_Handle/status/11", plain.Cell(3, 4), "other rows are untouched");
    }

    [DataTestMethod]
    [DataRow("https://x.com/Owner_Handle/status/12")]
    [DataRow("https://x.com/Other_Name/status/12")]
    public async Task AnAlreadyPresentStatusIsNotWrittenAgain(string link)
    {
        FakeSheet sheet = Workbook();
        string before = sheet.Cell(3, 4);
        GoogleTeaserLinkResult result = await Writer(sheet).AppendAsync("ep-b", link, CancellationToken.None);
        Assert.AreEqual("already-present", result.Status);
        Assert.AreEqual(before, sheet.Cell(3, 4));
        Assert.AreEqual(0, sheet.Posts.Count);
        Assert.AreEqual(0, sheet.CellReads, "no live cell read is needed");
    }

    [TestMethod]
    public async Task AConcurrentCellChangeIsRefusedWithoutWriting()
    {
        FakeSheet sheet = Workbook();
        sheet.BeforeCellRead = () => sheet.SetCell(4, 4, "https://x.com/Owner_Handle/status/13 owner edit");
        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).AppendAsync("ep-c", NewLink, CancellationToken.None));
        Assert.AreEqual("catalogue-entry-changed", error.Code);
        Assert.AreEqual(0, sheet.Posts.Count);
        Assert.AreEqual("https://x.com/Owner_Handle/status/13 owner edit", sheet.Cell(4, 4));
    }

    [TestMethod]
    public async Task ARowInsertedBeforeTheWriteIsRefusedWithoutWriting()
    {
        FakeSheet sheet = Workbook();
        sheet.BeforeCellRead = () => sheet.InsertRow(2, ["ep-new", "Episode New", "", "https://x.com/Owner_Handle/status/13", "1"]);
        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).AppendAsync("ep-c", NewLink, CancellationToken.None));
        Assert.AreEqual("catalogue-row-moved", error.Code);
        Assert.AreEqual(0, sheet.Posts.Count);
        Assert.IsTrue(GoogleTeaserLinkWriter.RowCodes.Contains(error.Code), "retried on a later run");
    }

    [TestMethod]
    public async Task AStatusLinkedFromAnotherRowIsNotDuplicated()
    {
        FakeSheet sheet = Workbook();
        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).AppendAsync("ep-a", "https://x.com/Owner_Handle/status/13", CancellationToken.None));
        Assert.AreEqual("teaser-status-elsewhere", error.Code);
        Assert.AreEqual(0, sheet.Posts.Count);
        Assert.AreEqual("", sheet.Cell(2, 4));
    }

    [TestMethod]
    public async Task AReadbackMismatchIsUnresolved()
    {
        FakeSheet sheet = Workbook();
        sheet.ApplyWrites = false;
        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).AppendAsync("ep-c", NewLink, CancellationToken.None));
        Assert.AreEqual("google-row-write-unresolved", error.Code);
        Assert.AreEqual(1, sheet.Posts.Count);
    }

    [TestMethod]
    public async Task AnUncertainWriteIsSettledByTheReadback()
    {
        FakeSheet sheet = Workbook();
        sheet.FailAfterWrite = true;
        GoogleTeaserLinkResult result = await Writer(sheet).AppendAsync("ep-a", NewLink, CancellationToken.None);
        Assert.AreEqual("appended", result.Status);
        Assert.AreEqual(1, sheet.Posts.Count);
    }

    [TestMethod]
    public async Task FormulaAndLinkedTextCellsAreNeverRewritten()
    {
        FakeSheet formula = Workbook();
        formula.FormulaOverride = "=HYPERLINK(\"https://x.com/Owner_Handle/status/13\")";
        Assert.AreEqual("teaser-cell-formula", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(formula).AppendAsync("ep-c", NewLink, CancellationToken.None))).Code);

        FakeSheet linked = Workbook();
        linked.SetCell(4, 4, "teaser", "https://x.com/Owner_Handle/status/99");
        Assert.AreEqual("teaser-cell-linked", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(linked).AppendAsync("ep-c", NewLink, CancellationToken.None))).Code);
        Assert.AreEqual(0, formula.Posts.Count + linked.Posts.Count);
    }

    [TestMethod]
    public async Task AMissingRowIsReported()
    {
        FakeSheet sheet = Workbook();
        Assert.AreEqual("catalogue-entry-missing", (await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            Writer(sheet).AppendAsync("ep-z", NewLink, CancellationToken.None))).Code);
    }

    private static GoogleTeaserLinkWriter Writer(FakeSheet sheet) =>
        new("workbook-one", null, new GoogleWorkspaceClient(new HttpClient(sheet), new FakeTokenSource()));

    private static FakeSheet Workbook() => new([
        ["ID", "Title", "Release", "Twitter Teaser(s)", "# teasers"],
        ["ep-a", "Episode A", "", "", "0"],
        ["ep-b", "Episode B", "", "https://x.com/Owner_Handle/status/11, https://twitter.com/Owner_Handle/status/12", "2"],
        ["ep-c", "Episode C", "", "https://x.com/Owner_Handle/status/13", "1"],
    ]);

    // A one-tab spreadsheet that serves the import reads, single-cell reads
    // and value writes the client issues.
    private sealed class FakeSheet(List<string[]> rows) : HttpMessageHandler
    {
        private readonly Dictionary<(int Row, int Column), string> _links = [];
        internal List<JsonElement> Posts { get; } = [];
        internal int CellReads { get; private set; }
        internal Action? BeforeCellRead { get; set; }
        internal bool ApplyWrites { get; set; } = true;
        internal bool FailAfterWrite { get; set; }
        internal Action? AfterWrite { get; set; }
        internal string? FormulaOverride { get; set; }

        internal string Cell(int row, int column) => row <= rows.Count ? rows[row - 1][column - 1] : "";

        internal void InsertRow(int row, string[] cells) => rows.Insert(row - 1, cells);

        internal void SetCell(int row, int column, string value, string? hyperlink = null)
        {
            rows[row - 1][column - 1] = value;
            if (hyperlink is null) _links.Remove((row, column));
            else _links[(row, column)] = hyperlink;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string path = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath);
            if (request.Method == HttpMethod.Post && path.EndsWith("/values:batchUpdate", StringComparison.Ordinal))
            {
                JsonElement body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken)).RootElement.Clone();
                Posts.Add(body);
                if (ApplyWrites)
                    foreach (JsonElement update in body.GetProperty("data").EnumerateArray())
                    {
                        (int row, int column) = Address(update.GetProperty("range").GetString()!);
                        SetCell(row, column, update.GetProperty("values")[0][0].GetString()!);
                    }
                AfterWrite?.Invoke();
                if (FailAfterWrite) throw new TaskCanceledException("Accepted before the acknowledgement was lost.");
                return Json(request, "{}");
            }
            if (request.Method == HttpMethod.Get && path.EndsWith("/values:batchGet", StringComparison.Ordinal))
            {
                CellReads++;
                BeforeCellRead?.Invoke();
                string[] ranges = [.. request.RequestUri.Query.TrimStart('?').Split('&')
                    .Where(pair => pair.StartsWith("ranges=", StringComparison.Ordinal))
                    .Select(pair => Uri.UnescapeDataString(pair["ranges=".Length..]))];
                return Json(request, JsonSerializer.Serialize(new
                {
                    spreadsheetId = "workbook-one",
                    valueRanges = ranges.Select(range =>
                    {
                        (int row, int column) = Address(range);
                        string value = column == 4 && FormulaOverride is not null ? FormulaOverride : Cell(row, column);
                        return value.Length == 0 ? (object)new { range } : new { range, values = new[] { new[] { value } } };
                    }),
                }));
            }
            bool data = request.RequestUri.Query.Contains("ranges=", StringComparison.Ordinal);
            JsonObject sheet = new()
            {
                ["properties"] = new JsonObject
                {
                    ["sheetId"] = 7, ["title"] = Sheet, ["hidden"] = false,
                    ["gridProperties"] = new JsonObject { ["rowCount"] = 50, ["columnCount"] = Math.Max(6, rows.Max(row => row.Length)) },
                },
            };
            if (data)
                sheet["data"] = new JsonArray(new JsonObject
                {
                    ["startRow"] = 0, ["startColumn"] = 0,
                    ["rowData"] = new JsonArray([.. rows.Select((cells, rowIndex) => (JsonNode)new JsonObject
                    {
                        ["values"] = new JsonArray([.. cells.Select((value, columnIndex) =>
                        {
                            JsonObject cell = new() { ["formattedValue"] = value };
                            if (_links.TryGetValue((rowIndex + 1, columnIndex + 1), out string? link)) cell["hyperlink"] = link;
                            return (JsonNode)cell;
                        })]),
                    })]),
                });
            JsonObject workbook = new()
            {
                ["spreadsheetId"] = "workbook-one",
                ["properties"] = new JsonObject { ["title"] = "Work" },
                ["sheets"] = new JsonArray(sheet),
            };
            return Json(request, workbook.ToJsonString());
        }

        private static (int Row, int Column) Address(string range)
        {
            string cell = range[(range.LastIndexOf('!') + 1)..];
            return (int.Parse(cell[1..], System.Globalization.CultureInfo.InvariantCulture), cell[0] - 'A' + 1);
        }

        private static HttpResponseMessage Json(HttpRequestMessage request, string body) => new(HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    private sealed class FakeTokenSource : IGoogleAccessTokenSource
    {
        public ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken) =>
            ValueTask.FromResult("fake-access-token");
    }
}
