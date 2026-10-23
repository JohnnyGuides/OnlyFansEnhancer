using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleWorkflowLedgerWriterTests
{
    [TestMethod]
    public async Task NewLedgerRowPreservesSourceAndPromotionSeparatelyAndIsIdempotent()
    {
        FakeWorkbook workbook = new();
        GoogleWorkflowLedgerWriter writer = Writer(workbook);
        CreatorWorkflowProjectionIntent intent = Intent();
        int attempts = 0;
        int ledgerSheetId = 0;
        GoogleWorkflowLedgerResult first = await writer.WriteAsync(intent, sheetId =>
        {
            attempts++;
            Assert.IsTrue(sheetId > 0);
            ledgerSheetId = sheetId;
        }, CancellationToken.None);
        Assert.AreEqual("completed", first.State);
        Assert.AreEqual(1, attempts);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);

        GoogleWorkflowLedgerResult duplicate = await writer.WriteAsync(intent with { State = "attempted", LedgerSheetId = ledgerSheetId },
            _ => Assert.Fail("An existing immutable row must reconcile without another write"), CancellationToken.None);
        Assert.AreEqual("completed", duplicate.State);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);
        string[] row = workbook.Row(GoogleWorkflowLedgerWriter.SheetTitle, 1);
        Assert.AreEqual("episode-source", row[4]);
        Assert.AreEqual("catalogue-item-guid", row[5]);
        Assert.AreEqual("Episode source", row[6]);
        Assert.AreEqual("https://fansly.com/Creator/posts", row[8]);
        Assert.IsTrue(row[7].Contains("https://onlyfans.com/123/johnny_guides", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task AcknowledgementLostAfterAtomicWriteIsResolvedByReadback()
    {
        FakeWorkbook workbook = new() { FailAfterCommit = true };
        int attempts = 0;
        GoogleWorkflowLedgerResult result = await Writer(workbook).WriteAsync(Intent(), _ => attempts++, CancellationToken.None);
        Assert.AreEqual("completed", result.State);
        Assert.AreEqual(1, attempts);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task UncertainUncommittedAddSheetRemainsReadbackOnlyOnRetry()
    {
        FakeWorkbook workbook = new() { FailBeforeCommit = true };
        GoogleWorkflowLedgerWriter writer = Writer(workbook);
        int attemptedSheetId = 0;
        CreatorWorkflowProjectionIntent intent = Intent();
        GoogleWorkflowLedgerResult first = await writer.WriteAsync(intent, id => attemptedSheetId = id, CancellationToken.None);
        Assert.AreEqual("unresolved", first.State);
        Assert.IsTrue(attemptedSheetId > 0);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);

        GoogleWorkflowLedgerResult retry = await writer.WriteAsync(
            intent with { State = "unresolved", LedgerSheetId = attemptedSheetId },
            _ => Assert.Fail("An attempted add-sheet operation must only reconcile by readback"), CancellationToken.None);
        Assert.AreEqual("unresolved", retry.State);
        Assert.AreEqual("google-workflow-ledger-write-not-confirmed", retry.ErrorCode);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task FailedDurableAttemptCallbackAbortsBeforeAnyProviderMutation()
    {
        FakeWorkbook workbook = new();
        GoogleWorkflowLedgerWriter writer = Writer(workbook);
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => writer.WriteAsync(Intent(),
            _ => throw new InvalidOperationException("synthetic local persistence failure"), CancellationToken.None));
        Assert.AreEqual(0, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task OversizedSnapshotCellIsRejectedBeforeAttemptCallbackOrMutation()
    {
        FakeWorkbook workbook = new();
        CreatorWorkflowProjectionIntent oversized = Intent() with
        {
            Snapshot = Intent().Snapshot with { Script = new("uploaded", Error: new string('x', GoogleWorkflowLedgerWriter.MaximumCellCharacters + 1)) },
        };
        int attempts = 0;
        GoogleWorkflowLedgerResult result = await Writer(workbook).WriteAsync(oversized, _ => attempts++, CancellationToken.None);
        Assert.AreEqual("conflict", result.State);
        Assert.AreEqual("google-workflow-ledger-cell-too-large", result.ErrorCode);
        Assert.AreEqual(0, attempts);
        Assert.AreEqual(0, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task FullInitialGridCanGrowByOneAppendCellRow()
    {
        FakeWorkbook workbook = new(withLedger: true, foreignHeaders: false);
        workbook.FillLedgerToGridLimit();
        int attempts = 0;

        GoogleWorkflowLedgerResult result = await Writer(workbook).WriteAsync(Intent(), _ => attempts++, CancellationToken.None);

        Assert.AreEqual("completed", result.State);
        Assert.AreEqual(1, attempts);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);
        Assert.AreEqual("run-ledger-001", workbook.Row(GoogleWorkflowLedgerWriter.SheetTitle, 1000)[1]);
    }

    [TestMethod]
    public async Task ReadLimitCapacityConflictIsReturnedBeforeAttemptOrMutation()
    {
        FakeWorkbook workbook = new(withLedger: true, foreignHeaders: false);
        workbook.SetLedgerRowCount(GoogleWorkflowLedgerWriter.MaximumReadableRows);
        workbook.FillLedgerToGridLimit();
        int attempts = 0;

        GoogleWorkflowLedgerResult result = await Writer(workbook).WriteAsync(Intent(), _ => attempts++, CancellationToken.None);

        Assert.AreEqual("conflict", result.State);
        Assert.AreEqual("google-workflow-ledger-full", result.ErrorCode);
        Assert.AreEqual(0, attempts);
        Assert.AreEqual(0, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task ByteCapacityStopsBeforeAttemptAndOversizedExistingLedgerRemainsVisible()
    {
        foreach (int padding in new[] { GoogleWorkflowLedgerWriter.MaximumReadableResponseBytes, GoogleWorkspaceClient.MaximumWorkflowLedgerResponseBytes + 1 })
        {
            FakeWorkbook workbook = new(withLedger: true, foreignHeaders: false) { GridResponsePadding = padding };
            GoogleWorkflowLedgerResult result = await Writer(workbook).WriteAsync(Intent(), _ => Assert.Fail("Capacity must stop before dispatch"), CancellationToken.None);
            Assert.AreEqual("conflict", result.State);
            Assert.AreEqual("google-workflow-ledger-full", result.ErrorCode);
            Assert.AreEqual(0, workbook.StructuralBatches.Count);
        }
    }

    [TestMethod]
    public async Task ExactGoogleAutoHyperlinksReconcileButChangedLinksBlockAnAppend()
    {
        FakeWorkbook workbook = new() { AutoHyperlinks = true };
        GoogleWorkflowLedgerWriter writer = Writer(workbook);
        CreatorWorkflowProjectionIntent intent = Intent();
        Assert.AreEqual("completed", (await writer.WriteAsync(intent, _ => { }, CancellationToken.None)).State);
        workbook.ForeignHyperlinks = true;
        CreatorWorkflowProjectionIntent next = intent with { Revision = 2, Snapshot = intent.Snapshot with { Revision = 2 } };
        GoogleWorkflowLedgerResult result = await writer.WriteAsync(next, _ => Assert.Fail("Foreign hyperlink must block dispatch"), CancellationToken.None);
        Assert.AreEqual("conflict", result.State);
        Assert.AreEqual("google-workflow-ledger-foreign-row", result.ErrorCode);
        Assert.AreEqual(1, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task NewRevisionAppendsAndDuplicateIdentityIsRefusedWithoutOverwrite()
    {
        FakeWorkbook workbook = new();
        GoogleWorkflowLedgerWriter writer = Writer(workbook);
        CreatorWorkflowProjectionIntent first = Intent();
        Assert.AreEqual("completed", (await writer.WriteAsync(first, _ => { }, CancellationToken.None)).State);

        CreatorWorkflowSnapshot nextSnapshot = first.Snapshot with
        {
            Revision = 2,
            Targets = [new("onlyfans", "uploaded", "https://onlyfans.com/123/johnny_guides", Submitted: true),
                new("fansly", "uploaded", "https://fansly.com/post/500", Submitted: true)],
        };
        CreatorWorkflowProjectionIntent next = first with { Revision = 2, Snapshot = nextSnapshot };
        Assert.AreEqual("completed", (await writer.WriteAsync(next, _ => { }, CancellationToken.None)).State);
        Assert.AreEqual(2, workbook.StructuralBatches.Count);
        Assert.AreEqual("2", workbook.Row(GoogleWorkflowLedgerWriter.SheetTitle, 2)[2]);

        workbook.DuplicateLedgerRow(2);
        GoogleWorkflowLedgerResult duplicate = await writer.WriteAsync(next, _ => Assert.Fail("Duplicate identity must not be rewritten"), CancellationToken.None);
        Assert.AreEqual("conflict", duplicate.State);
        Assert.AreEqual("google-workflow-ledger-duplicate-identity", duplicate.ErrorCode);
        Assert.AreEqual(2, workbook.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task ForeignHeadersWrongWorkbookAndChangedIdentityAreNeverOverwritten()
    {
        FakeWorkbook foreign = new(withLedger: true, foreignHeaders: true);
        int attempts = 0;
        GoogleWorkflowLedgerResult foreignResult = await Writer(foreign).WriteAsync(Intent(), _ => attempts++, CancellationToken.None);
        Assert.AreEqual("conflict", foreignResult.State);
        Assert.AreEqual("google-workflow-ledger-foreign-headers", foreignResult.ErrorCode);
        Assert.AreEqual(0, attempts);
        Assert.AreEqual(0, foreign.StructuralBatches.Count);

        FakeWorkbook wrongBook = new();
        GoogleWorkflowLedgerResult wrongBookResult = await Writer(wrongBook).WriteAsync(Intent() with { WorkbookId = "workbook-two" }, _ => attempts++, CancellationToken.None);
        Assert.AreEqual("conflict", wrongBookResult.State);
        Assert.AreEqual(0, wrongBook.StructuralBatches.Count);

        FakeWorkbook occupied = new();
        GoogleWorkflowLedgerWriter writer = Writer(occupied);
        CreatorWorkflowProjectionIntent original = Intent();
        Assert.AreEqual("completed", (await writer.WriteAsync(original, _ => { }, CancellationToken.None)).State);
        CreatorWorkflowSnapshot different = original.Snapshot with
        {
            Targets = [new("fansly", "uploaded", "https://fansly.com/post/500", Submitted: true)],
        };
        GoogleWorkflowLedgerResult changed = await writer.WriteAsync(original with { Snapshot = different }, _ => attempts++, CancellationToken.None);
        Assert.AreEqual("conflict", changed.State);
        Assert.AreEqual("google-workflow-ledger-payload-conflict", changed.ErrorCode);
        Assert.AreEqual(1, occupied.StructuralBatches.Count);
    }

    [TestMethod]
    public async Task ReadbackMustMatchTheExpectedLedgerSheetId()
    {
        FakeWorkbook replacedDuringWrite = new() { ReplaceLedgerIdAfterCommit = true };
        GoogleWorkflowLedgerResult postWrite = await Writer(replacedDuringWrite).WriteAsync(Intent(), _ => { }, CancellationToken.None);
        Assert.AreEqual("conflict", postWrite.State);
        Assert.AreEqual("google-workflow-ledger-sheet-changed", postWrite.ErrorCode);

        FakeWorkbook replacedBeforeRetry = new();
        GoogleWorkflowLedgerWriter writer = Writer(replacedBeforeRetry);
        int originalId = 0;
        Assert.AreEqual("completed", (await writer.WriteAsync(Intent(), id => originalId = id, CancellationToken.None)).State);
        replacedBeforeRetry.ChangeLedgerId(originalId + 1);
        GoogleWorkflowLedgerResult retry = await writer.WriteAsync(Intent() with { State = "attempted", LedgerSheetId = originalId },
            _ => Assert.Fail("A changed ledger ID must not be written"), CancellationToken.None);
        Assert.AreEqual("conflict", retry.State);
        Assert.AreEqual("google-workflow-ledger-sheet-changed", retry.ErrorCode);
        Assert.AreEqual(1, replacedBeforeRetry.StructuralBatches.Count);
    }

    private static GoogleWorkflowLedgerWriter Writer(FakeWorkbook workbook) => new("workbook-one",
        new GoogleWorkspaceClient(new HttpClient(workbook), new FakeTokenSource()));

    private static CreatorWorkflowProjectionIntent Intent()
    {
        CreatorWorkflowSnapshot snapshot = new("run-ledger-001", "social", 1, "episode-source",
            [new("onlyfans", "uploaded", "https://onlyfans.com/123/johnny_guides", Submitted: true)],
            [new("video", "episode.mp4", 1024, new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero), new string('a', 64))],
            new("uploaded", "episode.funscript", new string('b', 64), ["https://johnnyguides.com/sync/scripts/episode.funscript"]),
            new("https://fansly.com/Creator/posts", true, 15, "New episode: {{link}}", "https://x.com/owner/status/123"));
        return new(new string('c', 64), "workbook-one", snapshot.RunId, snapshot.Revision, snapshot,
            "Episode source", SourceItemId: "catalogue-item-guid");
    }

    private sealed class FakeWorkbook : HttpMessageHandler
    {
        private sealed class FakeSheet(int id, string title, int columns)
        {
            internal int Id { get; set; } = id;
            internal string Title { get; } = title;
            internal int Columns { get; } = columns;
            internal int RowCount { get; set; } = 1000;
            internal List<string[]> Rows { get; } = [];
        }

        private readonly List<FakeSheet> _sheets = [];
        internal List<JsonElement> StructuralBatches { get; } = [];
        internal bool FailBeforeCommit { get; init; }
        internal bool FailAfterCommit { get; init; }
        internal bool ReplaceLedgerIdAfterCommit { get; init; }
        internal int GridResponsePadding { get; init; }
        internal bool AutoHyperlinks { get; init; }
        internal bool ForeignHyperlinks { get; set; }

        internal FakeWorkbook() => AddBaseSheet();

        internal FakeWorkbook(bool withLedger, bool foreignHeaders)
        {
            AddBaseSheet();
            if (withLedger)
            {
                FakeSheet ledger = new(8, GoogleWorkflowLedgerWriter.SheetTitle, GoogleWorkflowLedgerWriter.Headers.Length);
                ledger.Rows.Add(foreignHeaders ? ["Not our ledger"] : GoogleWorkflowLedgerWriter.Headers);
                _sheets.Add(ledger);
            }
        }

        private void AddBaseSheet()
        {
            _sheets.Add(new(7, "2026 Video Catalogue", 2));
            _sheets[0].Rows.Add(["ID", "Title"]);
            _sheets[0].Rows.Add(["episode-source", "Episode source"]);
        }

        internal string[] Row(string title, int index) => _sheets.Single(value => value.Title == title).Rows[index];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string requestPath = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath);
            if (request.Method == HttpMethod.Post && requestPath.EndsWith(":batchUpdate", StringComparison.Ordinal))
            {
                JsonElement body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken)).RootElement.Clone();
                StructuralBatches.Add(body);
                if (FailBeforeCommit) throw new TaskCanceledException("Synthetic unknown outcome before commit.");
                Apply(body);
                if (ReplaceLedgerIdAfterCommit) ChangeLedgerId(999);
                if (FailAfterCommit) throw new TaskCanceledException("Synthetic lost acknowledgement after commit.");
                return Json(request, "{}");
            }
            bool includeGrid = request.RequestUri.Query.Contains("includeGridData=true", StringComparison.Ordinal);
            bool enteredOnly = !Uri.UnescapeDataString(request.RequestUri.Query).Contains("effectiveValue", StringComparison.Ordinal);
            return Json(request, Workbook(includeGrid, enteredOnly).ToJsonString() + (includeGrid ? new string(' ', GridResponsePadding) : ""));
        }

        private void Apply(JsonElement body)
        {
            foreach (JsonElement request in body.GetProperty("requests").EnumerateArray())
            {
                if (request.TryGetProperty("addSheet", out JsonElement add))
                {
                    JsonElement properties = add.GetProperty("properties");
                    _sheets.Add(new(properties.GetProperty("sheetId").GetInt32(),
                        properties.GetProperty("title").GetString()!,
                        properties.GetProperty("gridProperties").GetProperty("columnCount").GetInt32()));
                }
                else if (request.TryGetProperty("updateCells", out JsonElement update))
                {
                    int id = update.GetProperty("start").GetProperty("sheetId").GetInt32();
                    int row = update.GetProperty("start").GetProperty("rowIndex").GetInt32();
                    FakeSheet sheet = _sheets.Single(value => value.Id == id);
                    while (sheet.Rows.Count <= row) sheet.Rows.Add(Enumerable.Repeat("", sheet.Columns).ToArray());
                    sheet.Rows[row] = update.GetProperty("rows")[0].GetProperty("values").EnumerateArray()
                        .Select(cell => cell.GetProperty("userEnteredValue").GetProperty("stringValue").GetString() ?? "").ToArray();
                }
                else if (request.TryGetProperty("appendCells", out JsonElement append))
                {
                    int id = append.GetProperty("sheetId").GetInt32();
                    FakeSheet sheet = _sheets.Single(value => value.Id == id);
                    sheet.Rows.Add(append.GetProperty("rows")[0].GetProperty("values").EnumerateArray()
                        .Select(cell => cell.GetProperty("userEnteredValue").GetProperty("stringValue").GetString() ?? "").ToArray());
                    sheet.RowCount = Math.Max(sheet.RowCount, sheet.Rows.Count);
                }
            }
        }

        internal void DuplicateLedgerRow(int index)
        {
            FakeSheet ledger = _sheets.Single(value => value.Title == GoogleWorkflowLedgerWriter.SheetTitle);
            ledger.Rows.Add([.. ledger.Rows[index]]);
        }

        internal void ChangeLedgerId(int id) => _sheets.Single(value => value.Title == GoogleWorkflowLedgerWriter.SheetTitle).Id = id;

        internal void FillLedgerToGridLimit()
        {
            FakeSheet ledger = _sheets.Single(value => value.Title == GoogleWorkflowLedgerWriter.SheetTitle);
            for (int index = 1; index < ledger.RowCount; index++)
            {
                string[] row = ["v1", $"existing-{index}", "1", "social", "", "", "", "[]", "", "null", "null", "[]", "null", ""];
                row[^1] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(row[..^1]))));
                ledger.Rows.Add(row);
            }
        }

        internal void SetLedgerRowCount(int rowCount) =>
            _sheets.Single(value => value.Title == GoogleWorkflowLedgerWriter.SheetTitle).RowCount = rowCount;

        private JsonObject Workbook(bool includeGrid, bool enteredOnly)
        {
            JsonArray sheets = new();
            foreach (FakeSheet sheet in _sheets)
            {
                JsonObject properties = new()
                {
                    ["sheetId"] = sheet.Id,
                    ["title"] = sheet.Title,
                    ["hidden"] = false,
                    ["gridProperties"] = new JsonObject { ["rowCount"] = sheet.RowCount, ["columnCount"] = sheet.Columns },
                };
                JsonObject entry = new() { ["properties"] = properties };
                if (includeGrid)
                    entry["data"] = new JsonArray(new JsonObject
                    {
                        ["startRow"] = 0,
                        ["startColumn"] = 0,
                        ["rowData"] = new JsonArray([.. sheet.Rows.Select(row => (JsonNode)new JsonObject
                        {
                            ["values"] = new JsonArray([.. row.Select(value => (JsonNode)new JsonObject
                            {
                                ["userEnteredValue"] = new JsonObject { ["stringValue"] = value },
                                ["effectiveValue"] = new JsonObject { ["stringValue"] = value },
                                ["formattedValue"] = value,
                            })]),
                        })]),
                    });
                if (includeGrid && enteredOnly)
                    foreach (JsonNode? row in entry["data"]![0]!["rowData"]!.AsArray())
                        foreach (JsonNode? cell in row!["values"]!.AsArray())
                        {
                            cell!.AsObject().Remove("effectiveValue");
                            cell.AsObject().Remove("formattedValue");
                        }
                if (includeGrid && AutoHyperlinks && sheet.Title == GoogleWorkflowLedgerWriter.SheetTitle)
                    foreach (JsonNode? row in entry["data"]![0]!["rowData"]!.AsArray().Skip(1))
                        foreach (JsonNode? cell in row!["values"]!.AsArray())
                            if (cell!["userEnteredValue"]!["stringValue"]!.GetValue<string>() is string value && value.StartsWith("https://", StringComparison.Ordinal))
                                cell["hyperlink"] = ForeignHyperlinks ? "https://example.invalid/changed" : value;
                sheets.Add(entry);
            }
            return new JsonObject
            {
                ["spreadsheetId"] = "workbook-one",
                ["properties"] = new JsonObject { ["title"] = "Synthetic workbook" },
                ["sheets"] = sheets,
            };
        }

        private static HttpResponseMessage Json(HttpRequestMessage request, string content) => new(HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new StringContent(content, Encoding.UTF8, "application/json"),
        };
    }

    private sealed class FakeTokenSource : IGoogleAccessTokenSource
    {
        public ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken) =>
            ValueTask.FromResult("synthetic-token");
    }
}
