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
                    ["gridProperties"] = new JsonObject { ["rowCount"] = 50, ["columnCount"] = 6 },
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
