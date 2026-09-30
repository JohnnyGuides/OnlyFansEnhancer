using OFEnhancer.Protocol;
using OFEnhancer.Catalogue;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleWorkspaceClientTests
{
    [TestMethod]
    public void NewCatalogueIdsFollowExistingSeriesAndUseReadableCollisionNumbers()
    {
        static WorkbookCatalogueItem Item(string id, string title, string series, int row) =>
            new(row, id, title, "Other description", "2026-08-01", series, null, 0, 0,
                new Dictionary<string, string>(), null);
        WorkbookCatalogueItem[] existing = [
            Item("toy-reviews-cheap-chinese-toy-01", "Review one", "Toy Reviews", 1),
            Item("toy-reviews-fake-ass-creampie", "Review two", "Toy Reviews", 2),
            Item("setaria-ep20", "Episode 20", "Setaria", 3),
            Item("setaria-ep21", "Episode 21", "Setaria", 4),
        ];
        Assert.AreEqual("toy-reviews-pair-of-legs", GoogleUploadEntryWriter.NewId(
            new("new", "fucking a pair of legs", "Description", "2026-09-25",
                "clip.mp4", 5, 123, Category: "Review", SeasonArc: "Toy Reviews"), existing));
        Assert.AreEqual("setaria-ep22", GoogleUploadEntryWriter.NewId(
            new("new", "Final battle", "Description", "2026-09-25",
                "S5E22 - final.mp4", 5, 123, Category: "GameSync", SeasonArc: "Setaria"), existing));
        Assert.AreEqual("toy-reviews-pair-of-legs-2", GoogleUploadEntryWriter.NewId(
            new("new", "fucking a pair of legs", "Description", "2026-09-26",
                "clip2.mp4", 5, 123, Category: "Review", SeasonArc: "Toy Reviews"),
            [.. existing, Item("toy-reviews-pair-of-legs", "Different review", "Toy Reviews", 5)]));
    }

    [TestMethod]
    public async Task UploadRowAppendUsesRawValuesAndDetectedCatalogueColumns()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, "{}");
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        await client.AppendCatalogueRowAsync("workbook-one", "2026 Video Catalogue", 1,
            new Dictionary<string, int> { ["sourceKey"] = 1, ["plannedDate"] = 2,
                ["title"] = 3, ["description"] = 4, ["category"] = 5, ["series"] = 6 },
            "new-video-123", "2026-09-25", "=A1", "Preview\ntext", "GameSync", "Setaria", CancellationToken.None);

        Assert.AreEqual(1, handler.Requests.Count);
        Assert.AreEqual(HttpMethod.Post, handler.Requests[0].Method);
        StringAssert.Contains(Uri.UnescapeDataString(handler.Requests[0].Uri.AbsolutePath),
            "/values/'2026 Video Catalogue'!A2:F:append");
        Assert.AreEqual("RAW", ParseQuery(handler.Requests[0].Uri)["valueInputOption"].Single());
        using JsonDocument body = JsonDocument.Parse(handler.Requests[0].Body);
        Assert.AreEqual("=A1", body.RootElement.GetProperty("values")[0][2].GetString());
        Assert.AreEqual("Preview\ntext", body.RootElement.GetProperty("values")[0][3].GetString());
        Assert.AreEqual("GameSync", body.RootElement.GetProperty("values")[0][4].GetString());
        Assert.AreEqual("Setaria", body.RootElement.GetProperty("values")[0][5].GetString());
    }

    [TestMethod]
    public async Task UploadEntryWriterCreatesOneWorkRowAndVerifiesReadback()
    {
        string id = "new-video";
        JsonObject discovery = UploadWorkbookResponse(null, includeNotes: true);
        JsonObject before = UploadWorkbookResponse(null);
        JsonObject after = UploadWorkbookResponse(id);
        RecordingHandler handler = new();
        foreach (string response in new[] { WorkbookMetadataJson, discovery.ToJsonString(), before.ToJsonString(), "{}",
            WorkbookMetadataJson, discovery.ToJsonString(), after.ToJsonString() })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));

        GoogleUploadEntryResult result = await writer.WriteAsync(
            new("new", "New video", "Preview text", "2026-09-25", "clip.mp4", 5, 123),
            CancellationToken.None);

        Assert.AreEqual("created", result.Status);
        Assert.AreEqual(id, result.Id);
        Assert.AreEqual(3, result.Row);
        Assert.AreEqual(1, handler.Requests.Count(request => request.Method == HttpMethod.Post));
    }

    [TestMethod]
    public async Task UploadEntryWriterUsesMatchingPredatedRowWithoutMovingItsDate()
    {
        string id = "new-video";
        JsonObject discovery = UploadWorkbookResponse(null, includeNotes: true);
        JsonObject before = UploadWorkbookResponse(null);
        JsonObject after = UploadWorkbookResponse(null);
        before["sheets"]![0]!["data"]![0]!["rowData"]!.AsArray().Add(JsonSerializer.SerializeToNode(new {
            values = new[] { new { formattedValue = "" }, new { formattedValue = "2026-09-25" } }
        }));
        after["sheets"]![0]!["data"]![0]!["rowData"]!.AsArray().Add(JsonSerializer.SerializeToNode(new {
            values = new[] { new { formattedValue = id }, new { formattedValue = "2026-09-25" },
                new { formattedValue = "New video" }, new { formattedValue = "Preview text" } }
        }));
        RecordingHandler handler = new();
        foreach (string response in new[] { WorkbookMetadataJson, discovery.ToJsonString(), before.ToJsonString(), "{}",
            WorkbookMetadataJson, discovery.ToJsonString(), after.ToJsonString() })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));

        GoogleUploadEntryResult result = await writer.WriteAsync(
            new("new", "New video", "Preview text", "2026-09-25", "clip.mp4", 5, 123),
            CancellationToken.None);

        Assert.AreEqual(3, result.Row);
        RecordedRequest mutation = handler.Requests.Single(request => request.Method == HttpMethod.Post);
        StringAssert.Contains(mutation.Uri.AbsolutePath, "values:batchUpdate");
        using JsonDocument body = JsonDocument.Parse(mutation.Body);
        string[] ranges = body.RootElement.GetProperty("data").EnumerateArray()
            .Select(update => update.GetProperty("range").GetString()!).ToArray();
        CollectionAssert.AreEquivalent(new[] { "'2026 Video Catalogue'!A3", "'2026 Video Catalogue'!C3",
            "'2026 Video Catalogue'!D3" }, ranges);
    }

    [TestMethod]
    public async Task UploadEntryWriterReconcilesUncertainAppendWithoutRetrying()
    {
        string id = "new-video";
        JsonObject discovery = UploadWorkbookResponse(null, includeNotes: true);
        RecordingHandler handler = new();
        foreach (string response in new[] { WorkbookMetadataJson, discovery.ToJsonString(),
            UploadWorkbookResponse(null).ToJsonString() })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        handler.Enqueue(_ => throw new TaskCanceledException("The append completed before acknowledgement."));
        foreach (string response in new[] { WorkbookMetadataJson, discovery.ToJsonString(),
            UploadWorkbookResponse(id).ToJsonString() })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));

        GoogleUploadEntryResult result = await writer.WriteAsync(
            new("new", "New video", "Preview text", "2026-09-25", "clip.mp4", 5, 123),
            CancellationToken.None);

        Assert.AreEqual("created", result.Status);
        Assert.AreEqual(id, result.Id);
        Assert.AreEqual(1, handler.Requests.Count(request => request.Method == HttpMethod.Post));
    }

    [TestMethod]
    public async Task UploadEntryWriterUpdatesOnlyChosenTextCellsAfterExactRead()
    {
        JsonObject discovery = UploadWorkbookResponse(null, includeNotes: true);
        JsonObject before = UploadWorkbookResponse(null);
        JsonObject after = UploadWorkbookResponse(null);
        JsonArray cells = after["sheets"]![0]!["data"]![0]!["rowData"]![1]!["values"]!.AsArray();
        cells[2]!["formattedValue"] = "Changed video";
        cells[3]!["formattedValue"] = "Changed description";
        RecordingHandler handler = new();
        foreach (string response in new[] { WorkbookMetadataJson, discovery.ToJsonString(), before.ToJsonString(),
            """{"range":"'2026 Video Catalogue'!C2","values":[["Old video"]]}""",
            """{"range":"'2026 Video Catalogue'!D2","values":[["Old description"]]}""",
            "{}", WorkbookMetadataJson, discovery.ToJsonString(), after.ToJsonString() })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));

        GoogleUploadEntryResult result = await writer.WriteAsync(
            new("update", "Changed video", "Changed description", "2026-09-18",
                Id: "old-video", ExpectedTitle: "Old video", ExpectedDescription: "Old description"),
            CancellationToken.None);

        Assert.AreEqual("updated", result.Status);
        Assert.AreEqual(2, result.Row);
        RecordedRequest mutation = handler.Requests.Single(request => request.Method == HttpMethod.Post);
        Assert.AreEqual("RAW", JsonDocument.Parse(mutation.Body).RootElement.GetProperty("valueInputOption").GetString());
        Assert.AreEqual(2, JsonDocument.Parse(mutation.Body).RootElement.GetProperty("data").GetArrayLength());
    }

    [DataTestMethod]
    [DataRow("Videos!C2", "Videos!D2", true)]
    [DataRow("'Videos'!C2", "Videos!D2", true)]
    [DataRow("Other!C2", "Videos!D2", false)]
    [DataRow("'Other'!C2", "Videos!D2", false)]
    [DataRow("Videos!C3", "Videos!D2", false)]
    [DataRow("Videos!D2", "Videos!D2", false)]
    public async Task UploadEntryWriterAcceptsQuotedOrUnquotedFormOfTheSameCheckedCell(
        string titleRange, string descriptionRange, bool accepted)
    {
        string Rename(JsonObject json) => json.ToJsonString().Replace("2026 Video Catalogue", "Videos", StringComparison.Ordinal);
        string metadata = WorkbookMetadataJson.Replace("2026 Video Catalogue", "Videos", StringComparison.Ordinal);
        JsonObject after = UploadWorkbookResponse(null);
        JsonArray cells = after["sheets"]![0]!["data"]![0]!["rowData"]![1]!["values"]!.AsArray();
        cells[2]!["formattedValue"] = "Changed video";
        cells[3]!["formattedValue"] = "Changed description";
        RecordingHandler handler = new();
        foreach (string response in new[] { metadata, Rename(UploadWorkbookResponse(null, includeNotes: true)),
            Rename(UploadWorkbookResponse(null)),
            $$"""{"range":"{{titleRange}}","values":[["Old video"]]}""",
            $$"""{"range":"{{descriptionRange}}","values":[["Old description"]]}""",
            "{}", metadata, Rename(UploadWorkbookResponse(null, includeNotes: true)), Rename(after) })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));
        GoogleUploadEntryRequest request = new("update", "Changed video", "Changed description", "2026-09-18",
            Id: "old-video", ExpectedTitle: "Old video", ExpectedDescription: "Old description");

        if (accepted)
        {
            GoogleUploadEntryResult result = await writer.WriteAsync(request, CancellationToken.None);
            Assert.AreEqual("updated", result.Status);
            Assert.AreEqual(1, handler.Requests.Count(item => item.Method == HttpMethod.Post));
            return;
        }
        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            writer.WriteAsync(request, CancellationToken.None));
        Assert.AreEqual("catalogue-entry-changed", error.Code);
        Assert.AreEqual(0, handler.Requests.Count(item => item.Method == HttpMethod.Post));
    }

    [DataTestMethod]
    [DataRow("Videos!E2", true)]
    [DataRow("'Videos'!E2", true)]
    [DataRow("Other!E2", false)]
    [DataRow("Videos!E3", false)]
    public async Task UploadEntryWriterAcceptsQuotedOrUnquotedFormOfTheSameReadField(string categoryRange, bool accepted)
    {
        JsonObject before = UploadWorkbookResponse(null);
        JsonArray rows = before["sheets"]![0]!["data"]![0]!["rowData"]!.AsArray();
        rows[0]!["values"]!.AsArray().Add(JsonSerializer.SerializeToNode(new { formattedValue = "Category" }));
        rows[1]!["values"]!.AsArray().Add(JsonSerializer.SerializeToNode(new { formattedValue = "GameSync" }));
        JsonObject discovery = JsonNode.Parse(before.ToJsonString())!.AsObject();
        discovery["sheets"]!.AsArray().Add(UploadWorkbookResponse(null, includeNotes: true)["sheets"]![1]!.DeepClone());
        RecordingHandler handler = new();
        foreach (string response in new[] { WorkbookMetadataJson, discovery.ToJsonString(), before.ToJsonString(),
            $$"""{"range":"{{categoryRange}}","values":[["GameSync"]]}""" })
            handler.EnqueueJson(HttpStatusCode.OK, response.Replace("2026 Video Catalogue", "Videos", StringComparison.Ordinal));
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));
        GoogleUploadEntryRequest request = new("update", "Old video", "Old description", "2026-09-18",
            Id: "old-video", ExpectedTitle: "Old video", ExpectedDescription: "Old description", Category: "GameSync");

        if (accepted)
        {
            Assert.AreEqual("already-updated", (await writer.WriteAsync(request, CancellationToken.None)).Status);
            return;
        }
        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            writer.WriteAsync(request, CancellationToken.None));
        Assert.AreEqual("catalogue-entry-changed", error.Code);
    }

    private static JsonObject UploadWorkbookResponse(string? addedId, bool includeNotes = false)
    {
        JsonObject response = ImportWorkbookResponse(["ID", "Release", "Title", "Description"],
            includeNotes ? ["Notes"] : null);
        JsonArray rows = response["sheets"]![0]!["data"]![0]!["rowData"]!.AsArray();
        rows.Add(JsonSerializer.SerializeToNode(new { values = new[] {
            new { formattedValue = "old-video" }, new { formattedValue = "2026-09-18" },
            new { formattedValue = "Old video" }, new { formattedValue = "Old description" },
        } }));
        if (addedId is not null)
            rows.Add(JsonSerializer.SerializeToNode(new { values = new[] {
                new { formattedValue = addedId }, new { formattedValue = "2026-09-25" },
                new { formattedValue = "New video" }, new { formattedValue = "Preview text" },
            } }));
        return response;
    }

    [TestMethod]
    public async Task StructuralReaderBoundsRangesToSmallCompanionGrid()
    {
        var metadata = JsonNode.Parse(WorkbookMetadataJson)!;
        metadata["sheets"]![0]!["properties"]!["gridProperties"]!["rowCount"] = 10;
        metadata["sheets"]![0]!["properties"]!["gridProperties"]!["columnCount"] = 6;
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        using HttpClient http = new(handler);
        await new GoogleWorkspaceClient(http, new FakeTokenSource("access")).ReadWorkbookAsync("workbook-one", CancellationToken.None);
        StringAssert.Contains(Uri.UnescapeDataString(handler.Requests[1].Uri.Query), "!A1:F10");
    }

    [DataTestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task SubredditPresetsReadExactDetectedTabAndRecheckIdentity(bool renamed)
    {
        JsonObject metadata=JsonNode.Parse(WorkbookMetadataJson)!.AsObject();
        metadata["sheets"]![0]!["properties"]!["gridProperties"]!["columnCount"]=28;
        JsonObject headers=ImportWorkbookResponse(["ID","Title"],["Notes"]);
        headers["sheets"]![0]!["properties"]!["gridProperties"]!["columnCount"]=28;
        RecordingHandler handler=new();
        handler.EnqueueJson(HttpStatusCode.OK,metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK,headers.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK,"""{"range":"'2026 Video Catalogue'!Z1:AB501","values":[["Subreddit","Status","Notes"],["TestSub","Approved","Verified"]]}""");
        if(renamed) metadata["sheets"]![0]!["properties"]!["title"]="Changed";
        handler.EnqueueJson(HttpStatusCode.OK,metadata.ToJsonString());
        using HttpClient http=new(handler);
        GoogleWorkspaceClient client=new(http,new FakeTokenSource("access"));
        if(renamed)
        {
            var error=await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(()=>client.ReadSubredditPresetsAsync("workbook-one",CancellationToken.None));
            Assert.AreEqual("subreddit-source-mismatch",error.Code);
        }
        else Assert.AreEqual("TestSub",(await client.ReadSubredditPresetsAsync("workbook-one",CancellationToken.None)).Rows.Single().Subreddit);
        StringAssert.EndsWith(Uri.UnescapeDataString(handler.Requests[2].Uri.AbsolutePath),"/values/'2026 Video Catalogue'!Z1:AB501");
        Assert.IsTrue(handler.Requests.All(request=>request.Method==HttpMethod.Get));
    }
    [DataTestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ImportReadsHeaderSamplesThenOnlyTheChosenTabAndKeepsUnrelatedMetadata(bool duplicateTimelineHeaders)
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, WorkbookMetadataJson);
        JsonObject discovery = ImportWorkbookResponse(["ID", "Name"], duplicateTimelineHeaders
            ? ["Video ID", "Episode", "", "Video-ID", "Title", "", "", "", "Release date"]
            : [new string('x', 10_001)]);
        handler.EnqueueJson(HttpStatusCode.OK, discovery.ToJsonString());
        JsonObject body = ImportWorkbookResponse(["ID", "Name"]);
        ((JsonArray)body["sheets"]![0]!["data"]![0]!["rowData"]!).Add(JsonSerializer.SerializeToNode(new
        {
            values = new[] { new { formattedValue = "item-one" }, new { formattedValue = "Video one" } },
        }));
        handler.EnqueueJson(HttpStatusCode.OK, body.ToJsonString());
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        GoogleWorkbookSnapshot snapshot = await client.ReadImportWorkbookAsync("workbook-one", CancellationToken.None);

        CollectionAssert.AreEqual(new[] { "'2026 Video Catalogue'!A1:X20", "'Creator''s Ledger'!A1:L20" },
            ParseQuery(handler.Requests[1].Uri)["ranges"].ToArray());
        CollectionAssert.AreEqual(new[] { "'2026 Video Catalogue'!A1:X5002" },
            ParseQuery(handler.Requests[2].Uri)["ranges"].ToArray());
        Assert.AreEqual("spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(formattedValue))))",
            ParseQuery(handler.Requests[1].Uri)["fields"].Single());
        Assert.AreEqual("spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(effectiveValue,formattedValue,hyperlink,effectiveFormat(numberFormat(type))))))",
            ParseQuery(handler.Requests[2].Uri)["fields"].Single());
        Assert.AreEqual(2, snapshot.Sheets.Count);
        Assert.AreEqual(0, snapshot.Sheets.Single(sheet => sheet.SheetId == 44).Rows.Count);
        Assert.AreEqual("Video one", GoogleCatalogueImportReader.Read(snapshot).Projection.Items.Single().Title);
        Assert.IsTrue(handler.Requests.All(request => request.Method == HttpMethod.Get));
    }

    [TestMethod]
    public async Task ImportPreservesAmbiguityWithoutFetchingAnyBody()
    {
        RecordingHandler handler = new();
        JsonObject metadata = JsonNode.Parse(WorkbookMetadataJson)!.AsObject();
        metadata["sheets"]![1]!["properties"]!["title"] = "Other catalogue";
        JsonObject discovery = ImportWorkbookResponse(["ID", "Name"], ["ID", "Title"]);
        discovery["sheets"]![1]!["properties"]!["title"] = "Other catalogue";
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, discovery.ToJsonString());
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ReadImportWorkbookAsync("workbook-one", CancellationToken.None));

        Assert.AreEqual("catalogue-tab-ambiguous", error.Code);
        Assert.AreEqual(2, handler.Requests.Count);
    }

    [TestMethod]
    public async Task ImportRejectsMappingChangesBetweenDiscoveryAndSelectedBody()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, WorkbookMetadataJson);
        handler.EnqueueJson(HttpStatusCode.OK, ImportWorkbookResponse(["ID", "Name"], ["Notes"]).ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, ImportWorkbookResponse(["Name", "ID"]).ToJsonString());
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ReadImportWorkbookAsync("workbook-one", CancellationToken.None));

        Assert.AreEqual("catalogue-layout-changed", error.Code);
    }

    [TestMethod]
    public async Task ImportClampsSmallGridsAndDoesNotRequestHiddenTabs()
    {
        JsonObject metadata = JsonNode.Parse(WorkbookMetadataJson)!.AsObject();
        metadata["sheets"]![0]!["properties"]!["gridProperties"]!["rowCount"] = 10;
        metadata["sheets"]![0]!["properties"]!["gridProperties"]!["columnCount"] = 2;
        metadata["sheets"]![1]!["properties"]!["hidden"] = true;
        JsonObject sampled = ImportWorkbookResponse(["ID", "Name"]);
        sampled["sheets"]![0]!["properties"] = metadata["sheets"]![0]!["properties"]!.DeepClone();
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, sampled.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, sampled.ToJsonString());
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        GoogleWorkbookSnapshot result = await client.ReadImportWorkbookAsync("workbook-one", CancellationToken.None);

        foreach (RecordedRequest request in handler.Requests.Skip(1))
            CollectionAssert.AreEqual(new[] { "'2026 Video Catalogue'!A1:B10" }, ParseQuery(request.Uri)["ranges"].ToArray());
        Assert.IsTrue(result.Sheets.Single(sheet => sheet.SheetId == 44).Hidden);
        Assert.AreEqual(0, result.Sheets.Single(sheet => sheet.SheetId == 44).Rows.Count);
    }

    private static JsonObject SecondTabResponse(string secondTitle, string[] headers, bool withItem, int secondSheetId = 44)
    {
        JsonObject response = ImportWorkbookResponse(["ID", "Title"], ["ID", "Title"]);
        JsonArray sheets = response["sheets"]!.AsArray();
        sheets.RemoveAt(0);
        JsonObject only = sheets[0]!.AsObject();
        only["properties"]!["title"] = secondTitle;
        only["properties"]!["sheetId"] = secondSheetId;
        JsonArray rows = only["data"]![0]!["rowData"]!.AsArray();
        rows.Clear();
        rows.Add(JsonSerializer.SerializeToNode(new { values = headers.Select(value => new { formattedValue = value }).ToArray() }));
        if (withItem)
            rows.Add(JsonSerializer.SerializeToNode(new { values = new[] { new { formattedValue = "item-two" }, new { formattedValue = "Video two" } } }));
        return response;
    }

    private static JsonObject TwoValidTabsMetadata(string first, string second, int secondSheetId = 44)
    {
        JsonObject metadata = JsonNode.Parse(WorkbookMetadataJson)!.AsObject();
        metadata["sheets"]![0]!["properties"]!["title"] = first;
        metadata["sheets"]![1]!["properties"]!["title"] = second;
        metadata["sheets"]![1]!["properties"]!["sheetId"] = secondSheetId;
        return metadata;
    }

    [DataTestMethod]
    [DataRow("First tab", "Second tab", 44)]
    [DataRow("2026 Video Catalogue", "Creator's Ledger", 44)]
    [DataRow("First tab", "Second tab", 0)]
    public async Task ImportWithApprovedSheetRequestsAndImportsOnlyThatTab(string first, string second, int secondSheetId)
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, TwoValidTabsMetadata(first, second, secondSheetId).ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, SecondTabResponse(second, ["ID", "Title"], false, secondSheetId).ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, SecondTabResponse(second, ["ID", "Title"], true, secondSheetId).ToJsonString());
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        GoogleWorkbookSnapshot snapshot = await client.ReadImportWorkbookAsync("workbook-one", CancellationToken.None, secondSheetId);

        Assert.AreEqual(3, handler.Requests.Count);
        string escapedSecond = second.Replace("'", "''", StringComparison.Ordinal);
        CollectionAssert.AreEqual(new[] { $"'{escapedSecond}'!A1:L20" }, ParseQuery(handler.Requests[1].Uri)["ranges"].ToArray());
        CollectionAssert.AreEqual(new[] { $"'{escapedSecond}'!A1:L200" }, ParseQuery(handler.Requests[2].Uri)["ranges"].ToArray());
        GoogleCatalogueImportPreview preview = GoogleCatalogueImportReader.Read(snapshot, secondSheetId);
        Assert.AreEqual(secondSheetId, preview.CatalogueSheetId);
        Assert.AreEqual("Video two", preview.Projection.Items.Single().Title);
    }

    [DataTestMethod]
    [DataRow("missing", 1)]
    [DataRow("hidden", 1)]
    [DataRow("invalid-layout", 2)]
    public async Task ImportWithUnusableApprovedSheetFailsClosedWithoutFallbackOrBodyFetch(string kind, int expectedRequests)
    {
        JsonObject metadata = TwoValidTabsMetadata("First tab", "Second tab");
        int preferred = kind == "missing" ? 999 : 44;
        if (kind == "hidden")
            metadata["sheets"]![1]!["properties"]!["hidden"] = true;
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, SecondTabResponse("Second tab", ["Notes"], false).ToJsonString());
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ReadImportWorkbookAsync("workbook-one", CancellationToken.None, preferred));

        Assert.AreEqual("catalogue-tab-not-found", error.Code);
        Assert.AreEqual(expectedRequests, handler.Requests.Count);
        Assert.IsTrue(handler.Requests.All(request => !Uri.UnescapeDataString(request.Uri.Query).Contains("First tab", StringComparison.Ordinal)));
    }

    [TestMethod]
    public async Task SubredditPresetsAreReadFromTheApprovedTab()
    {
        JsonObject metadata = TwoValidTabsMetadata("2026 Video Catalogue", "Creator's Ledger");
        metadata["sheets"]![1]!["properties"]!["gridProperties"]!["columnCount"] = 28;
        JsonObject headers = SecondTabResponse("Creator's Ledger", ["ID", "Title"], false);
        headers["sheets"]![0]!["properties"]!["gridProperties"]!["columnCount"] = 28;
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, headers.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, """{"range":"'Creator''s Ledger'!Z1:AB200","values":[["Subreddit","Status","Notes"],["TestSub","Approved","Verified"]]}""");
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        GoogleSubredditPresetSnapshot presets = await client.ReadSubredditPresetsAsync("workbook-one", CancellationToken.None, 44);

        Assert.AreEqual("TestSub", presets.Rows.Single().Subreddit);
        StringAssert.EndsWith(Uri.UnescapeDataString(handler.Requests[2].Uri.AbsolutePath), "/values/'Creator''s Ledger'!Z1:AB200");
        Assert.IsTrue(handler.Requests.All(request => !Uri.UnescapeDataString(request.Uri.Query).Contains("2026 Video Catalogue", StringComparison.Ordinal)));
    }

    private static JsonObject WideUploadWorkbook(string fourteenthHeader, string? reservedFourteenth, bool withNewRow, bool includeNotes = false)
    {
        string[] header = ["ID", "Release", "Title", "Description", "", "", "", "", "", "", "", "", "", fourteenthHeader];
        JsonObject response = ImportWorkbookResponse(header, includeNotes ? ["Notes"] : null);
        JsonArray rows = response["sheets"]![0]!["data"]![0]!["rowData"]!.AsArray();
        rows.Add(JsonSerializer.SerializeToNode(new { values = new[] {
            new { formattedValue = "old-video" }, new { formattedValue = "2026-09-18" },
            new { formattedValue = "Old video" }, new { formattedValue = "Old description" } } }));
        var reserved = new List<object> { new { formattedValue = "" }, new { formattedValue = "2026-09-25" } };
        if (reservedFourteenth is not null)
        {
            for (int index = 2; index < 13; index++) reserved.Add(new { formattedValue = "" });
            reserved.Add(new { formattedValue = reservedFourteenth });
        }
        rows.Add(JsonSerializer.SerializeToNode(new { values = reserved }));
        if (withNewRow)
            rows.Add(JsonSerializer.SerializeToNode(new { values = new[] {
                new { formattedValue = "new-video" }, new { formattedValue = "2026-09-25" },
                new { formattedValue = "New video" }, new { formattedValue = "Preview text" } } }));
        return response;
    }

    [DataTestMethod]
    [DataRow("Fansly", "https://fansly.com/post/1")]
    [DataRow("Category", "Existing category")]
    public async Task ReservedDateRowWithContentInAMappedColumnBeyondLIsNotReused(string header, string content)
    {
        RecordingHandler handler = new();
        foreach (string response in new[] { WorkbookMetadataJson, WideUploadWorkbook(header, content, false, true).ToJsonString(),
            WideUploadWorkbook(header, content, false).ToJsonString(), "{}", WorkbookMetadataJson,
            WideUploadWorkbook(header, content, false, true).ToJsonString(), WideUploadWorkbook(header, content, true).ToJsonString() })
            handler.EnqueueJson(HttpStatusCode.OK, response);
        using HttpClient http = new(handler);
        GoogleUploadEntryWriter writer = new("workbook-one", 2126708696,
            new GoogleWorkspaceClient(http, new FakeTokenSource("access")));

        GoogleUploadEntryResult result = await writer.WriteAsync(
            new("new", "New video", "Preview text", "2026-09-25", "clip.mp4", 5, 123),
            CancellationToken.None);

        RecordedRequest[] mutations = handler.Requests.Where(request => request.Method == HttpMethod.Post).ToArray();
        Assert.AreEqual(1, mutations.Length);
        StringAssert.EndsWith(Uri.UnescapeDataString(mutations[0].Uri.AbsolutePath), ":append");
        Assert.IsFalse(mutations.Any(request => request.Uri.AbsolutePath.Contains("values:batchUpdate", StringComparison.Ordinal)));
        Assert.AreEqual("created", result.Status);
    }

    private static async Task AssertEndsAsync(Task task, CancellationTokenSource release)
    {
        Task finished = await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(10)));
        if (!ReferenceEquals(finished, task))
        {
            release.Cancel();
            Assert.Fail("The operation did not end at its own deadline.");
        }
    }

    [TestMethod]
    public async Task ReadWithFastHeadersAndStalledBodyFailsAtTheDeadlineAndTheClientStaysUsable()
    {
        RecordingHandler handler = new();
        handler.Enqueue(request => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { RequestMessage = request, Content = new StalledContent() }));
        handler.EnqueueJson(HttpStatusCode.OK, WorkbookMetadataJson);
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"), TimeSpan.FromMilliseconds(200));
        using CancellationTokenSource caller = new();

        Task<GoogleCatalogueException> first = Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ReadSheetIdentityAsync("workbook-one", 44, caller.Token));
        await AssertEndsAsync(first, caller);

        Assert.AreEqual("google-request-timeout", (await first).Code);
        Assert.AreEqual(44, (await client.ReadSheetIdentityAsync("workbook-one", 44, CancellationToken.None)).SheetId);
    }

    [TestMethod]
    public async Task StalledTokenAcquisitionFailsAtTheDeadlineForReadsAndMutationsWithoutDispatch()
    {
        RecordingHandler handler = new();
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new StallingTokenSource(), TimeSpan.FromMilliseconds(200));
        using CancellationTokenSource caller = new();

        Task<GoogleCatalogueException> read = Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ReadSheetIdentityAsync("workbook-one", 44, caller.Token));
        await AssertEndsAsync(read, caller);
        Assert.AreEqual("google-request-timeout", (await read).Code);

        Task<GoogleCatalogueException> write = Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.UpdateValuesBatchAsync(new("workbook-one", [new("Sheet1!A1", "value")]), caller.Token));
        await AssertEndsAsync(write, caller);
        Assert.AreEqual("google-request-timeout", (await write).Code);
        Assert.AreEqual(0, handler.Requests.Count);
    }

    [TestMethod]
    public async Task StalledBodyAfterADispatchedMutationIsUncertainAndNeverRetried()
    {
        RecordingHandler handler = new();
        handler.Enqueue(request => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { RequestMessage = request, Content = new StalledContent() }));
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access", "unused"), TimeSpan.FromMilliseconds(200));
        using CancellationTokenSource caller = new();

        Task<GoogleMutationUncertainException> write = Assert.ThrowsExceptionAsync<GoogleMutationUncertainException>(() =>
            client.UpdateValuesBatchAsync(new("workbook-one", [new("Sheet1!A1", "value")]), caller.Token));
        await AssertEndsAsync(write, caller);
        await write;

        Assert.AreEqual(1, handler.Requests.Count(request => request.Method == HttpMethod.Post));
        Assert.AreEqual(1, handler.Requests.Count);
    }

    [DataTestMethod]
    [DataRow("reset")]
    [DataRow("declared-oversize")]
    [DataRow("streamed-oversize")]
    [DataRow("wrong-origin")]
    public async Task FailureToReadOrValidateADispatchedMutationResponseIsUncertain(string failure)
    {
        RecordingHandler handler = new();
        handler.Enqueue(request => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            RequestMessage = failure == "wrong-origin"
                ? new(HttpMethod.Post, "https://example.invalid/v4/spreadsheets/workbook-one/values:batchUpdate")
                : request,
            Content = failure switch
            {
                "reset" => new StreamContent(new UnseekableStream(16, reset: true)),
                "declared-oversize" => new ByteArrayContent(new byte[1024 * 1024 + 1]),
                "streamed-oversize" => new StreamContent(new UnseekableStream(1024 * 1024 + 1, reset: false)),
                _ => new StringContent("{}", Encoding.UTF8, "application/json"),
            },
        }));
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access", "unused"));

        await Assert.ThrowsExceptionAsync<GoogleMutationUncertainException>(() =>
            client.UpdateValuesBatchAsync(new("workbook-one", [new("Sheet1!A1", "value")]), CancellationToken.None));

        Assert.AreEqual(1, handler.Requests.Count);
    }

    [TestMethod]
    public async Task RejectedMutationStatusStaysADefiniteFailure()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.BadRequest, "{}");
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.UpdateValuesBatchAsync(new("workbook-one", [new("Sheet1!A1", "value")]), CancellationToken.None));

        Assert.AreEqual("google-request-failed", error.Code);
    }

    private sealed class UnseekableStream(int length, bool reset) : Stream
    {
        private int _position;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            int count = Math.Min(buffer.Length, length - _position);
            if (count == 0 && reset)
                throw new HttpIOException(HttpRequestError.ResponseEnded, "The connection was reset.");
            buffer[..count].Clear();
            _position += count;
            return count;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(Read(buffer.Span));
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [DataTestMethod]
    [DataRow("""{"sheetId":9,"title":"Chart","hidden":false}""")]
    [DataRow("""{"sheetId":9,"title":"Chart","hidden":false,"gridProperties":{"rowCount":0,"columnCount":5}}""")]
    [DataRow("""{"sheetId":9,"title":"Chart","hidden":false,"gridProperties":{"rowCount":5,"columnCount":0}}""")]
    public async Task WorkbookReadSkipsSheetsWithoutAGridAndKeepsTheirIdentity(string properties)
    {
        JsonObject metadata = JsonNode.Parse(WorkbookMetadataJson)!.AsObject();
        metadata["sheets"]!.AsArray().Add(new JsonObject { ["properties"] = JsonNode.Parse(properties) });
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, EmptyWorkbookJson);
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        GoogleWorkbookSnapshot snapshot = await client.ReadWorkbookAsync("workbook-one", CancellationToken.None);

        CollectionAssert.AreEqual(
            new[] { "'2026 Video Catalogue'!A1:X5002", "'Creator''s Ledger'!A1:L200" },
            ParseQuery(handler.Requests[1].Uri)["ranges"].ToArray());
        CollectionAssert.AreEqual(new[] { 2126708696, 44, 9 }, snapshot.Sheets.Select(sheet => sheet.SheetId).ToArray());
        Assert.AreEqual("Chart", snapshot.Sheets[2].Title);
    }

    [TestMethod]
    public async Task WorkbookReadStillRejectsAResponseMissingARequestedSheet()
    {
        JsonObject metadata = JsonNode.Parse(WorkbookMetadataJson)!.AsObject();
        metadata["sheets"]!.AsArray().Add(JsonNode.Parse("""{"properties":{"sheetId":9,"title":"Chart","hidden":false}}"""));
        JsonObject data = JsonNode.Parse(EmptyWorkbookJson)!.AsObject();
        data["sheets"]!.AsArray().RemoveAt(1);
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, metadata.ToJsonString());
        handler.EnqueueJson(HttpStatusCode.OK, data.ToJsonString());
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ReadWorkbookAsync("workbook-one", CancellationToken.None));

        Assert.AreEqual("invalid-google-response", error.Code);
    }

    [TestMethod]
    public async Task CallerCancellationAfterAMutationWasDispatchedIsReportedAsUncertain()
    {
        WaitingForCancellationHandler handler = new();
        using HttpClient http = new(handler);
        GoogleWorkspaceClient client = new(http, new FakeTokenSource("access"));
        using CancellationTokenSource caller = new();

        Task<GoogleMutationUncertainException> write = Assert.ThrowsExceptionAsync<GoogleMutationUncertainException>(() =>
            client.UpdateValuesBatchAsync(new("workbook-one", [new("Sheet1!A1", "value")]), caller.Token));
        await handler.Dispatched.Task.WaitAsync(TimeSpan.FromSeconds(10));
        caller.Cancel();
        await AssertEndsAsync(write, caller);
        await write;
    }

    private sealed class StalledContent : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => Task.Delay(Timeout.Infinite);
        protected override bool TryComputeLength(out long length) { length = -1; return false; }
        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new StalledStream());
        protected override Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken) =>
            Task.FromResult<Stream>(new StalledStream());
    }

    private sealed class StalledStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
            return 0;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class StallingTokenSource : IGoogleAccessTokenSource
    {
        public async ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
            return "never";
        }
    }

    private sealed class WaitingForCancellationHandler : HttpMessageHandler
    {
        public TaskCompletionSource Dispatched { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Dispatched.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException("unreachable");
        }
    }

    private static JsonObject ImportWorkbookResponse(string[] catalogueHeaders, string[]? noteHeaders = null)
    {
        JsonObject response = JsonNode.Parse(EmptyWorkbookJson)!.AsObject();
        JsonArray sheets = response["sheets"]!.AsArray();
        string[][] headers = noteHeaders is null ? [catalogueHeaders] : [catalogueHeaders, noteHeaders];
        if (noteHeaders is null)
            sheets.RemoveAt(1);
        for (int index = 0; index < headers.Length; index++)
            sheets[index]!["data"]![0]!["rowData"] = JsonSerializer.SerializeToNode(new[]
            {
                new { values = headers[index].Select(value => new { formattedValue = value }).ToArray() },
            });
        return response;
    }

    [DataTestMethod]
    [DataRow("{\"formattedValue\":\"First line\\r\\nSecond\\tline\"}")]
    [DataRow("{\"effectiveValue\":{\"stringValue\":\"First line\\r\\nSecond\\tline\"}}")]
    public void WorkbookCellTextPreservesOrdinaryLineBreaksAndTabs(string cellJson)
    {
        Assert.AreEqual("First line\r\nSecond\tline", ParseWorkbookCell(cellJson).Value);
    }

    [DataTestMethod]
    [DataRow("DATE", 45292d, "01.01.2024", "2024-01-01")]
    [DataRow("DATE_TIME", 45292.75d, "1/1/2024 18:00", "2024-01-01")]
    [DataRow("DATE", 2d, "01/01/1900", "1900-01-01")]
    [DataRow("NUMBER", 45292d, "45,292", "45,292")]
    [DataRow("TIME", 0.75d, "18:00", "18:00")]
    public void WorkbookNormalizesOnlyNativeDateCells(string type, double serial, string display, string expected)
    {
        string cellJson = JsonSerializer.Serialize(new
        {
            effectiveValue = new { numberValue = serial },
            formattedValue = display,
            effectiveFormat = new { numberFormat = new { type } },
        });
        Assert.AreEqual(expected, ParseWorkbookCell(cellJson).Value);
    }

    [DataTestMethod]
    [DataRow("{\"formattedValue\":\"bad\\u0000text\"}")]
    [DataRow("{\"formattedValue\":\"safe\",\"hyperlink\":\"https://example.com/\\nunsafe\"}")]
    public void WorkbookStillRejectsUnsafeControlCharactersAndMultilineHyperlinks(string cellJson)
    {
        GoogleCatalogueException error = Assert.ThrowsException<GoogleCatalogueException>(() => ParseWorkbookCell(cellJson));
        Assert.AreEqual("invalid-google-response", error.Code);
    }

    [TestMethod]
    public void WorkbookStillBoundsCellTextAndNativeDates()
    {
        Assert.ThrowsException<GoogleCatalogueException>(() => ParseWorkbookCell(
            JsonSerializer.Serialize(new { formattedValue = new string('x', 10_001) })));
        Assert.ThrowsException<GoogleCatalogueException>(() => ParseWorkbookCell(
            "{\"effectiveValue\":{\"numberValue\":1e100},\"formattedValue\":\"date\",\"effectiveFormat\":{\"numberFormat\":{\"type\":\"DATE\"}}}"));
    }

    [TestMethod]
    public void WorkbookMetadataAndProjectionReadsKeepStrictWhitespaceValidation()
    {
        string metadata = WorkbookMetadataJson.Replace("\"Work\"", "\"Work\\nunsafe\"", StringComparison.Ordinal);
        Assert.ThrowsException<GoogleCatalogueException>(() => GoogleWorkbookSnapshot.Parse(Encoding.UTF8.GetBytes(metadata)));
        JsonElement cell = JsonSerializer.SerializeToElement("https://example.com/\tunsafe");
        Assert.ThrowsException<GoogleCatalogueException>(() => GoogleWorkbookSnapshot.CellValue(cell, 10_000));
    }

    private static GoogleWorkbookCellSnapshot ParseWorkbookCell(string cellJson)
    {
        byte[] json = Encoding.UTF8.GetBytes("""
            {"spreadsheetId":"workbook-one","properties":{"title":"Work"},"sheets":[{"properties":{"sheetId":0,"title":"Notes","gridProperties":{"rowCount":100,"columnCount":24}},"data":[{"rowData":[{"values":[
            """ + cellJson + "]}]}]}]}");
        return GoogleWorkbookSnapshot.Parse(json).Sheets[0].Rows[0].Cells[0];
    }

    [TestMethod]
    public async Task ValidationUsesEncodedDriveEndpointBearerAndExactFields()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, """
            {"id":"workbook/one","name":"Creator workbook","mimeType":"application/vnd.google-apps.spreadsheet","capabilities":{"canEdit":true}}
            """);
        FakeTokenSource tokens = new("access-one", "access-two");
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, tokens);

        GoogleSpreadsheetIdentity identity = await client.ValidateSpreadsheetAsync("workbook/one", CancellationToken.None);

        RecordedRequest request = AssertSingle(handler.Requests);
        Assert.AreEqual(HttpMethod.Get, request.Method);
        Assert.AreEqual("https://www.googleapis.com/drive/v3/files/workbook%2Fone", request.Uri.GetLeftPart(UriPartial.Path));
        Assert.AreEqual("id,name,mimeType,capabilities(canEdit)", ParseQuery(request.Uri)["fields"].Single());
        Assert.AreEqual("Bearer", request.Authorization?.Scheme);
        Assert.AreEqual("access-one", request.Authorization?.Parameter);
        Assert.AreEqual("workbook/one", identity.Id);
        Assert.AreEqual("Creator workbook", identity.Title);
        CollectionAssert.AreEqual(new[] { false }, tokens.RefreshRequests.ToArray());
    }

    [TestMethod]
    public async Task WorkbookReadBoundsEverySheetRangeAndRefreshesOnceAfterReadOnlyUnauthorized()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.Unauthorized, "{}", requestMessage: true);
        handler.EnqueueJson(HttpStatusCode.OK, WorkbookMetadataJson, requestMessage: true);
        handler.EnqueueJson(HttpStatusCode.OK, EmptyWorkbookJson, requestMessage: true);
        FakeTokenSource tokens = new("expired-access", "fresh-access");
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, tokens);

        GoogleWorkbookSnapshot snapshot = await client.ReadWorkbookAsync("workbook-one", CancellationToken.None);

        Assert.AreEqual(3, handler.Requests.Count);
        Assert.AreEqual("expired-access", handler.Requests[0].Authorization?.Parameter);
        Assert.AreEqual("fresh-access", handler.Requests[1].Authorization?.Parameter);
        Assert.AreEqual("fresh-access", handler.Requests[2].Authorization?.Parameter);
        CollectionAssert.AreEqual(new[] { false, true, false }, tokens.RefreshRequests.ToArray());

        RecordedRequest metadata = handler.Requests[1];
        Assert.AreEqual("https://sheets.googleapis.com/v4/spreadsheets/workbook-one", metadata.Uri.GetLeftPart(UriPartial.Path));
        Dictionary<string, List<string>> metadataQuery = ParseQuery(metadata.Uri);
        Assert.AreEqual("spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))", metadataQuery["fields"].Single());
        Assert.IsFalse(metadataQuery.ContainsKey("includeGridData"));

        RecordedRequest data = handler.Requests[2];
        Dictionary<string, List<string>> dataQuery = ParseQuery(data.Uri);
        Assert.AreEqual("true", dataQuery["includeGridData"].Single());
        StringAssert.Contains(dataQuery["fields"].Single(), "effectiveFormat(numberFormat(type))");
        CollectionAssert.AreEqual(
            new[]
            {
                "'2026 Video Catalogue'!A1:X5002",
                "'Creator''s Ledger'!A1:L200",
            },
            dataQuery["ranges"].ToArray()
        );
        StringAssert.Contains(
            dataQuery["fields"].Single(),
            "developerMetadata(metadataId,metadataKey,metadataValue,visibility,location(spreadsheet,sheetId,dimensionRange(sheetId,dimension,startIndex,endIndex)))"
        );
        Assert.AreEqual("workbook-one", snapshot.WorkbookId);
        Assert.AreEqual(2, snapshot.Sheets.Count);
    }

    [TestMethod]
    public async Task ReadOnlyUnauthorizedIsRetriedOnlyOnce()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.Unauthorized, "{}");
        handler.EnqueueJson(HttpStatusCode.Unauthorized, "{}");
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("expired", "fresh"));

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ValidateSpreadsheetAsync("workbook-one", CancellationToken.None)
        );

        Assert.AreEqual("google-request-failed", error.Code);
        Assert.AreEqual(2, handler.Requests.Count);
    }

    [TestMethod]
    public async Task WorkbookReadAcceptsGoogleSheetIdZero()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, """
            {"spreadsheetId":"workbook-zero","properties":{"title":"Work"},"sheets":[{"properties":{"sheetId":0,"title":"First Sheet","hidden":false,"gridProperties":{"rowCount":100,"columnCount":24}}}]}
            """);
        handler.EnqueueJson(HttpStatusCode.OK, """
            {"spreadsheetId":"workbook-zero","properties":{"title":"Work"},"sheets":[{"properties":{"sheetId":0,"title":"First Sheet","hidden":false,"gridProperties":{"rowCount":100,"columnCount":24}},"data":[{"startRow":0,"startColumn":0,"rowData":[]}]}],"developerMetadata":[{"metadataId":7,"metadataKey":"ofenhancer.item_id.v1","metadataValue":"11111111-1111-4111-8111-111111111111","visibility":"DOCUMENT","location":{"dimensionRange":{"sheetId":0,"dimension":"ROWS","startIndex":1,"endIndex":2}}}]}
            """);
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        GoogleWorkbookSnapshot snapshot = await client.ReadWorkbookAsync("workbook-zero", CancellationToken.None);

        Assert.AreEqual(0, AssertSingle(snapshot.Sheets).SheetId);
        Assert.AreEqual(0, AssertSingle(snapshot.DeveloperMetadata).SheetId);
    }

    [TestMethod]
    public async Task WorkbookReadIgnoresValidUnrelatedMetadataLocationScopes()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, """
            {"spreadsheetId":"workbook-metadata","properties":{"title":"Work"},"sheets":[{"properties":{"sheetId":0,"title":"First Sheet","hidden":false,"gridProperties":{"rowCount":100,"columnCount":24}}}]}
            """);
        handler.EnqueueJson(HttpStatusCode.OK, """
            {
              "spreadsheetId":"workbook-metadata",
              "properties":{"title":"Work"},
              "sheets":[{"properties":{"sheetId":0,"title":"First Sheet","hidden":false,"gridProperties":{"rowCount":100,"columnCount":24}},"data":[{"startRow":0,"startColumn":0,"rowData":[]}]}],
              "developerMetadata":[
                {"metadataId":1,"metadataKey":"other.spreadsheet","metadataValue":"v1","visibility":"DOCUMENT","location":{"spreadsheet":true}},
                {"metadataId":2,"metadataKey":"other.sheet","metadataValue":"v2","visibility":"DOCUMENT","location":{"sheetId":0}},
                {"metadataId":3,"metadataKey":"other.column","metadataValue":"v3","visibility":"DOCUMENT","location":{"dimensionRange":{"sheetId":0,"dimension":"COLUMNS","startIndex":0,"endIndex":1}}},
                {"metadataId":4,"metadataKey":"ofenhancer.item_id.v1","metadataValue":"11111111-1111-4111-8111-111111111111","visibility":"DOCUMENT","location":{"dimensionRange":{"sheetId":0,"dimension":"ROWS","startIndex":1,"endIndex":2}}}
              ]
            }
            """);
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        GoogleWorkbookSnapshot snapshot = await client.ReadWorkbookAsync("workbook-metadata", CancellationToken.None);

        Assert.AreEqual(4, snapshot.DeveloperMetadata.Count);
        GoogleDeveloperMetadataSnapshot owned = snapshot.DeveloperMetadata.Single(metadata => metadata.Key == "ofenhancer.item_id.v1");
        Assert.AreEqual("ROWS", owned.Dimension);
        Assert.AreEqual(0, owned.SheetId);
        Dictionary<string, List<string>> query = ParseQuery(handler.Requests[1].Uri);
        StringAssert.Contains(
            query["fields"].Single(),
            "location(spreadsheet,sheetId,dimensionRange(sheetId,dimension,startIndex,endIndex))"
        );
    }

    [TestMethod]
    public async Task ReadRejectsRedirectedAndOversizedResponses()
    {
        RecordingHandler redirectedHandler = new();
        redirectedHandler.Enqueue(request => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            RequestMessage = new(HttpMethod.Get, "https://example.invalid/drive/v3/files/workbook-one"),
            Content = new StringContent(
                """{"id":"workbook-one","name":"Workbook","mimeType":"application/vnd.google-apps.spreadsheet","capabilities":{"canEdit":true}}""",
                Encoding.UTF8,
                "application/json"
            )
        }));
        using (HttpClient redirectedHttp = new(redirectedHandler))
        {
            GoogleWorkspaceClient redirectedClient = new(redirectedHttp, new FakeTokenSource("access"));
            GoogleCatalogueException redirected = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
                redirectedClient.ValidateSpreadsheetAsync("workbook-one", CancellationToken.None)
            );
            Assert.AreEqual("unexpected-google-origin", redirected.Code);
        }

        RecordingHandler oversizedHandler = new();
        oversizedHandler.Enqueue(request =>
        {
            ByteArrayContent content = new([]);
            content.Headers.ContentLength = 65_537;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = content });
        });
        using HttpClient oversizedHttp = new(oversizedHandler);
        GoogleWorkspaceClient oversizedClient = new(oversizedHttp, new FakeTokenSource("access"));

        GoogleCatalogueException oversized = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            oversizedClient.ValidateSpreadsheetAsync("workbook-one", CancellationToken.None)
        );

        Assert.AreEqual("google-response-too-large", oversized.Code);
    }

    [TestMethod]
    public async Task MetadataAndCellReadsUseEncodedSheetsEndpointsAndReturnBoundedValues()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, """
            {"matchedDeveloperMetadata":[{"developerMetadata":{"metadataId":77,"metadataKey":"ofenhancer.item_id.v1","metadataValue":"11111111-1111-4111-8111-111111111111","visibility":"DOCUMENT","location":{"dimensionRange":{"sheetId":0,"dimension":"ROWS","startIndex":92,"endIndex":93}}}}]}
            """);
        handler.EnqueueJson(HttpStatusCode.OK, """{"range":"'2026 Video Catalogue'!J93","majorDimension":"ROWS","values":[["https://onlyfans.com/123456789/johnny_guides"]]}""");
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));

        IReadOnlyList<GoogleMetadataMatch> metadata = await client.SearchItemMetadataAsync(
            "workbook/one",
            "11111111-1111-4111-8111-111111111111",
            CancellationToken.None
        );
        GoogleProjectionCell cell = await client.ReadProjectionCellAsync(
            "workbook/one",
            "'2026 Video Catalogue'!J93",
            CancellationToken.None
        );

        Assert.AreEqual("https://sheets.googleapis.com/v4/spreadsheets/workbook%2Fone/developerMetadata:search", handler.Requests[0].Uri.GetLeftPart(UriPartial.Path));
        using (JsonDocument search = JsonDocument.Parse(handler.Requests[0].Body))
        {
            JsonElement lookup = search.RootElement.GetProperty("dataFilters")[0].GetProperty("developerMetadataLookup");
            Assert.AreEqual("ofenhancer.item_id.v1", lookup.GetProperty("metadataKey").GetString());
            Assert.AreEqual("11111111-1111-4111-8111-111111111111", lookup.GetProperty("metadataValue").GetString());
            Assert.AreEqual("ROW", lookup.GetProperty("locationType").GetString());
        }
        GoogleMetadataMatch match = AssertSingle(metadata);
        Assert.AreEqual(0, match.SheetId);
        Assert.AreEqual(93, match.RowNumber);

        Assert.AreEqual("https://sheets.googleapis.com/v4/spreadsheets/workbook%2Fone/values/%272026%20Video%20Catalogue%27%21J93", handler.Requests[1].Uri.GetLeftPart(UriPartial.Path));
        Dictionary<string, List<string>> cellQuery = ParseQuery(handler.Requests[1].Uri);
        Assert.AreEqual("ROWS", cellQuery["majorDimension"].Single());
        Assert.AreEqual("FORMULA", cellQuery["valueRenderOption"].Single());
        Assert.AreEqual("FORMATTED_STRING", cellQuery["dateTimeRenderOption"].Single());
        Assert.AreEqual("https://onlyfans.com/123456789/johnny_guides", cell.Value);
        Assert.AreEqual(64, cell.Fingerprint.Length);
    }

    [TestMethod]
    public async Task MutationsUseExactSheetsEndpointsAndBoundedBodies()
    {
        RecordingHandler handler = new();
        handler.EnqueueJson(HttpStatusCode.OK, "{}", requestMessage: true);
        handler.EnqueueJson(HttpStatusCode.OK, "{}", requestMessage: true);
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));
        JsonElement addSheet = JsonDocument.Parse("""{"addSheet":{"properties":{"title":"_Audit"}}}""").RootElement.Clone();

        await client.ApplyStructuralBatchAsync(
            new GoogleStructuralBatch("workbook/one", [addSheet]),
            CancellationToken.None
        );
        await client.UpdateValuesBatchAsync(
            new GoogleValuesBatch(
                "workbook/one",
                [new GoogleValueUpdate("'2026 Video Catalogue'!J93", "https://onlyfans.com/123456789/johnny_guides")]
            ),
            CancellationToken.None
        );

        Assert.AreEqual("https://sheets.googleapis.com/v4/spreadsheets/workbook%2Fone:batchUpdate", handler.Requests[0].Uri.AbsoluteUri);
        Assert.AreEqual("https://sheets.googleapis.com/v4/spreadsheets/workbook%2Fone/values:batchUpdate", handler.Requests[1].Uri.AbsoluteUri);
        Assert.AreEqual("Bearer", handler.Requests[0].Authorization?.Scheme);
        Assert.AreEqual("access", handler.Requests[0].Authorization?.Parameter);

        using JsonDocument structural = JsonDocument.Parse(handler.Requests[0].Body);
        Assert.AreEqual("_Audit", structural.RootElement.GetProperty("requests")[0].GetProperty("addSheet").GetProperty("properties").GetProperty("title").GetString());
        using JsonDocument values = JsonDocument.Parse(handler.Requests[1].Body);
        Assert.AreEqual("USER_ENTERED", values.RootElement.GetProperty("valueInputOption").GetString());
        JsonElement update = values.RootElement.GetProperty("data")[0];
        Assert.AreEqual("'2026 Video Catalogue'!J93", update.GetProperty("range").GetString());
        Assert.AreEqual("ROWS", update.GetProperty("majorDimension").GetString());
        Assert.AreEqual("https://onlyfans.com/123456789/johnny_guides", update.GetProperty("values")[0][0].GetString());

        string oversizedValue = new('x', 1_048_577);
        await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() => client.UpdateValuesBatchAsync(
            new GoogleValuesBatch("workbook-one", [new GoogleValueUpdate("Sheet1!A1", oversizedValue)]),
            CancellationToken.None
        ));
        Assert.AreEqual(2, handler.Requests.Count);
    }

    [TestMethod]
    public async Task MutationTimeoutIsReturnedForReconciliationWithoutSecondPost()
    {
        TimeoutAfterAcceptingMutationHandler handler = new();
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access", "unused-refresh"));
        GoogleValuesBatch batch = new(
            "workbook-one",
            [new GoogleValueUpdate("'2026 Video Catalogue'!J93", "https://onlyfans.com/123456789/johnny_guides")]
        );

        await Assert.ThrowsExceptionAsync<GoogleMutationUncertainException>(() =>
            client.UpdateValuesBatchAsync(batch, CancellationToken.None)
        );

        Assert.AreEqual(1, handler.PostCount);
    }

    [TestMethod]
    public async Task StructuralMutationRejectsRequestsBeyondExplicitCountAndBodyBoundsWithoutPost()
    {
        RecordingHandler handler = new();
        using HttpClient httpClient = new(handler);
        GoogleWorkspaceClient client = new(httpClient, new FakeTokenSource("access"));
        JsonElement request = JsonDocument.Parse("""{"deleteSheet":{"sheetId":1}}""").RootElement.Clone();

        await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ApplyStructuralBatchAsync(
                new GoogleStructuralBatch(
                    "workbook-one",
                    Enumerable.Repeat(request, GoogleWorkspaceClient.MaximumStructuralRequestCount + 1).ToArray()
                ),
                CancellationToken.None
            )
        );

        JsonElement oversized = JsonSerializer.SerializeToElement(new
        {
            addSheet = new
            {
                properties = new
                {
                    title = new string('x', GoogleWorkspaceClient.MaximumStructuralRequestBytes),
                },
            },
        });
        await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            client.ApplyStructuralBatchAsync(
                new GoogleStructuralBatch("workbook-one", [oversized]),
                CancellationToken.None
            )
        );

        Assert.AreEqual(0, handler.Requests.Count);
    }

    private const string WorkbookMetadataJson = """
        {
          "spreadsheetId":"workbook-one",
          "properties":{"title":"Work"},
          "sheets":[
            {"properties":{"sheetId":2126708696,"title":"2026 Video Catalogue","hidden":false,"gridProperties":{"rowCount":5002,"columnCount":24}}},
            {"properties":{"sheetId":44,"title":"Creator's Ledger","hidden":false,"gridProperties":{"rowCount":200,"columnCount":12}}}
          ]
        }
        """;

    private const string EmptyWorkbookJson = """
        {
          "spreadsheetId":"workbook-one",
          "properties":{"title":"Work"},
          "sheets":[
            {"properties":{"sheetId":2126708696,"title":"2026 Video Catalogue","hidden":false,"gridProperties":{"rowCount":5002,"columnCount":24}},"data":[{"startRow":0,"startColumn":0,"rowData":[]}]},
            {"properties":{"sheetId":44,"title":"Creator's Ledger","hidden":false,"gridProperties":{"rowCount":200,"columnCount":12}},"data":[{"startRow":0,"startColumn":0,"rowData":[]}]}
          ],
          "developerMetadata":[]
        }
        """;

    private static T AssertSingle<T>(IReadOnlyList<T> values)
    {
        Assert.AreEqual(1, values.Count);
        return values[0];
    }

    private static Dictionary<string, List<string>> ParseQuery(Uri uri)
    {
        Dictionary<string, List<string>> values = new(StringComparer.Ordinal);
        foreach (string part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            string[] pair = part.Split('=', 2);
            string key = Uri.UnescapeDataString(pair[0].Replace('+', ' '));
            string value = Uri.UnescapeDataString(pair.ElementAtOrDefault(1)?.Replace('+', ' ') ?? string.Empty);
            if (!values.TryGetValue(key, out List<string>? entries))
            {
                entries = [];
                values.Add(key, entries);
            }
            entries.Add(value);
        }
        return values;
    }

    private sealed class FakeTokenSource(params string[] tokens) : IGoogleAccessTokenSource
    {
        private int _next;
        public List<bool> RefreshRequests { get; } = [];

        public ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RefreshRequests.Add(forceRefresh);
            string token = tokens[Math.Min(_next, tokens.Length - 1)];
            _next++;
            return ValueTask.FromResult(token);
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Queue<Func<HttpRequestMessage, Task<HttpResponseMessage>>> _responses = [];
        public List<RecordedRequest> Requests { get; } = [];

        public void Enqueue(Func<HttpRequestMessage, Task<HttpResponseMessage>> response) => _responses.Enqueue(response);

        public void EnqueueJson(HttpStatusCode status, string body, bool requestMessage = true) =>
            Enqueue(request => Task.FromResult(new HttpResponseMessage(status)
            {
                RequestMessage = requestMessage ? request : null,
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            }));

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new(request.Method, request.RequestUri!, request.Headers.Authorization, body));
            if (_responses.Count == 0)
                throw new InvalidOperationException("No fake response was queued.");
            return await _responses.Dequeue()(request);
        }
    }

    private sealed class TimeoutAfterAcceptingMutationHandler : HttpMessageHandler
    {
        public int PostCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Post)
                PostCount++;
            throw new TaskCanceledException("The fake server accepted the mutation before the timeout.");
        }
    }

    private sealed record RecordedRequest(
        HttpMethod Method,
        Uri Uri,
        AuthenticationHeaderValue? Authorization,
        string Body
    );
}
