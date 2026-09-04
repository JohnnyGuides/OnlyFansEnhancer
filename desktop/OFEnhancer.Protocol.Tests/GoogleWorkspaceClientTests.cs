using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleWorkspaceClientTests
{
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
        CollectionAssert.AreEqual(
            new[]
            {
                "'2026 Video Catalogue'!A1:X5002",
                "'Creator''s Ledger'!A1:X5002",
            },
            dataQuery["ranges"].ToArray()
        );
        StringAssert.Contains(dataQuery["fields"].Single(), "developerMetadata(metadataId,metadataKey,metadataValue,visibility,location(dimensionRange(sheetId,dimension,startIndex,endIndex)))");
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
            {"matchedDeveloperMetadata":[{"developerMetadata":{"metadataId":77,"metadataKey":"ofenhancer.item_id.v1","metadataValue":"11111111-1111-4111-8111-111111111111","visibility":"DOCUMENT","location":{"dimensionRange":{"sheetId":2126708696,"dimension":"ROWS","startIndex":92,"endIndex":93}}}}]}
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
        Assert.AreEqual(2126708696, match.SheetId);
        Assert.AreEqual(93, match.RowNumber);

        Assert.AreEqual("https://sheets.googleapis.com/v4/spreadsheets/workbook%2Fone/values/%272026%20Video%20Catalogue%27%21J93", handler.Requests[1].Uri.GetLeftPart(UriPartial.Path));
        Dictionary<string, List<string>> cellQuery = ParseQuery(handler.Requests[1].Uri);
        Assert.AreEqual("ROWS", cellQuery["majorDimension"].Single());
        Assert.AreEqual("UNFORMATTED_VALUE", cellQuery["valueRenderOption"].Single());
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
