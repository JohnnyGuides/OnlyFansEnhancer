using System.Net;
using System.Text;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleCatalogueSyncWorkerTests
{
    private const int CatalogueSheetId = 2126708696;
    private const string IntendedValue = "https://onlyfans.com/123456789/johnny_guides";
    private const string ForeignValue = "https://onlyfans.com/999999999/foreign";
    private const string EmptyFingerprint = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    private const string IntendedFingerprint = "bd08ab4a65c82aa016d2d495a901c8e2a5fb9cc184364a72047fce1663651844";
    private const string ForeignFingerprint = "a9fb65167b6dbe13c4c8fcdb34c916b1574efee4d33eb2015fe308efed12be34";
    private const string RedgifsFingerprint = "dd458d0b7d57a39bcabc5a2b4adfb022e27957653fd95ecb8c52fceb4522149d";
    private static readonly DateTimeOffset Clock = new(2026, 9, 4, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public async Task RowMoveUsesMetadataAndWritesOnlyTheResolvedOwnedCell()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), null);
        fixture.Google.OnMutation = () =>
        {
            Assert.AreEqual(SyncOutboxState.Attempted, fixture.Store.GetSyncOperation(operationId).State);
            fixture.Google.SetRow(fixture.ItemId("ashley"), 94);
            fixture.Google.SetCell(Range(94), IntendedValue);
        };

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Completed);
        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(1, fixture.Store.GetSyncOperation(operationId).AttemptCount);
        CollectionAssert.AreEqual(new[] { Range(93), Range(94) }, fixture.Google.CellReads.ToArray());
        Assert.AreEqual(1, fixture.Google.Mutations.Count);
        Assert.AreEqual(Range(93), fixture.Google.Mutations[0].Range);
        Assert.AreEqual(IntendedValue, fixture.Google.Mutations[0].Value);
        Assert.AreEqual(1, fixture.Google.Mutations[0].UpdateCount);
    }

    [TestMethod]
    public async Task SelectedSheetIdControlsTheCurrentTitleAndNeverTouchesAnUnrelatedPreferredTab()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetSheetTitle("Catalogue Copy", includeUnrelatedPreferredTab: true);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell("'Catalogue Copy'!J93", null);
        fixture.Google.SetCell(Range(93), ForeignValue);

        await fixture.RunSelectedAsync();

        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(2, fixture.Google.SheetPropertyReads);
        Assert.AreEqual(1, fixture.Google.Mutations.Count);
        Assert.AreEqual("'Catalogue Copy'!J93", fixture.Google.Mutations[0].Range);
        CollectionAssert.AreEqual(
            new[] { "'Catalogue Copy'!J93", "'Catalogue Copy'!J93" },
            fixture.Google.CellReads.ToArray()
        );
    }

    [TestMethod]
    public async Task AlreadyAppliedValueCompletesByReadWithoutMutation()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), IntendedValue);

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Completed);
        Assert.IsTrue(summary.RemoteVerificationOccurred);
        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        AssertNoMutationAttempt(fixture.Store, operationId);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task ExpectedFingerprintDriftConflictsWithoutMutation()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock, expectedFingerprint: new string('a', 64));
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), null);

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Conflicts);
        Assert.AreEqual("remote-fingerprint-changed", fixture.Store.GetSyncOperation(operationId).ErrorCode);
        AssertNoMutationAttempt(fixture.Store, operationId);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task NonEmptyForeignValueIsNeverOverwrittenEvenWhenFingerprintMatches()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock, expectedFingerprint: ForeignFingerprint);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), ForeignValue);

        await fixture.RunSelectedAsync();

        Assert.AreEqual(SyncOutboxState.Conflict, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual("remote-value-not-empty", fixture.Store.GetSyncOperation(operationId).ErrorCode);
        AssertNoMutationAttempt(fixture.Store, operationId);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task PayloadFingerprintMismatchConflictsBeforeMutation()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock, intendedFingerprint: new string('b', 64));
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), null);

        await fixture.RunSelectedAsync();

        Assert.AreEqual(SyncOutboxState.Conflict, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual("intended-fingerprint-invalid", fixture.Store.GetSyncOperation(operationId).ErrorCode);
        AssertNoMutationAttempt(fixture.Store, operationId);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task DuplicateMetadataRowsConflictWithoutChoosingOneToWrite()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetRows(fixture.ItemId("ashley"), 93, 94);
        fixture.Google.SetCell(Range(93), null);
        fixture.Google.SetCell(Range(94), null);

        await fixture.RunSelectedAsync();

        Assert.AreEqual(SyncOutboxState.Conflict, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual("metadata-row-ambiguous", fixture.Store.GetSyncOperation(operationId).ErrorCode);
        AssertNoMutationAttempt(fixture.Store, operationId);
        Assert.AreEqual(0, fixture.Google.CellReads.Count);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task EarlierConflictDoesNotBlockLaterSiblingAndOrderingIsStable()
    {
        using SyncFixture fixture = SyncFixture.Create("ashley", "claire");
        string laterId = fixture.Enqueue("claire", Clock.AddMinutes(1));
        string earlierId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), null);
        fixture.Google.SetRow(fixture.ItemId("claire"), 94);
        fixture.Google.SetCell(Range(94), null);

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        CollectionAssert.AreEqual(
            new[] { fixture.ItemId("ashley"), fixture.ItemId("claire"), fixture.ItemId("claire") },
            fixture.Google.MetadataSearches.ToArray()
        );
        Assert.AreEqual(SyncOutboxState.Conflict, fixture.Store.GetSyncOperation(earlierId).State);
        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(laterId).State);
        Assert.AreEqual(1, summary.Completed);
        Assert.AreEqual(1, summary.Conflicts);
    }

    [TestMethod]
    public async Task SelectedWorkbookRunNeverReadsOrMutatesPreservedWorkbookOperations()
    {
        using SyncFixture fixture = SyncFixture.Create("ashley", "claire");
        string preservedId = fixture.Enqueue("claire", Clock, workbookId: "workbook-one");
        string selectedId = fixture.Enqueue("ashley", Clock.AddMinutes(1), workbookId: "workbook-two");
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), IntendedValue);

        GoogleSyncSummary summary = await fixture.Worker.RunOnceAsync(
            "workbook-two",
            CatalogueSheetId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            CancellationToken.None
        );

        Assert.AreEqual(SyncOutboxState.Pending, fixture.Store.GetSyncOperation(preservedId).State);
        SyncOutboxItem selected = fixture.Store.GetSyncOperation(selectedId);
        Assert.AreEqual(SyncOutboxState.Completed, selected.State, selected.ErrorCode);
        CollectionAssert.AreEqual(
            new[] { fixture.ItemId("ashley") },
            fixture.Google.MetadataSearches.ToArray()
        );
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
        Assert.AreEqual(1, summary.Completed);
        Assert.AreEqual(0, summary.Pending);
    }

    [TestMethod]
    public async Task ConcurrentRunsAreSerializedAndCannotWriteOneOperationTwice()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), null);
        fixture.Google.PauseNextMetadataSearch();

        Task<GoogleSyncSummary> first = fixture.RunSelectedAsync();
        await fixture.Google.MetadataSearchPaused;
        Task<GoogleSyncSummary> second = fixture.RunSelectedAsync();

        Assert.AreEqual(1, fixture.Google.MetadataSearches.Count);
        fixture.Google.ReleaseMetadataSearch();
        await Task.WhenAll(first, second);

        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(1, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task AttemptedOperationWithIntendedValueCompletesByReadWithoutMutation()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.EnqueueAttempted("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), IntendedValue);

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Completed);
        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task AttemptedOperationWithDifferingValueConflictsByReadWithoutMutation()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.EnqueueAttempted("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), ForeignValue);

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Conflicts);
        Assert.AreEqual(SyncOutboxState.Conflict, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual("sync-readback-differed", fixture.Store.GetSyncOperation(operationId).ErrorCode);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task MissingAttemptedOperationBecomesUnresolvedThenLaterCompletesByReadOnly()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.EnqueueAttempted("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), null);

        GoogleSyncSummary first = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, first.Unresolved);
        Assert.AreEqual(SyncOutboxState.Unresolved, fixture.Store.GetSyncOperation(operationId).State);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), IntendedValue);

        GoogleSyncSummary second = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, second.Completed);
        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task MissingUnresolvedOperationStaysUnresolvedAndNeverMutates()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.EnqueueAttempted("ashley", Clock);
        fixture.Store.MarkSyncUnresolved(operationId, "network-uncertain", Clock.AddMinutes(1));
        fixture.Google.SetRow(fixture.ItemId("ashley"), null);

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Unresolved);
        Assert.AreEqual(SyncOutboxState.Unresolved, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(1, fixture.Google.MetadataSearches.Count);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task UncertainMutationReconcilesByReadWithoutSecondMutation()
    {
        using SyncFixture fixture = SyncFixture.Create();
        string operationId = fixture.Enqueue("ashley", Clock);
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        fixture.Google.SetCell(Range(93), null);
        fixture.Google.ThrowAfterAcceptingMutation = true;

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.AreEqual(1, summary.Completed);
        Assert.AreEqual(SyncOutboxState.Completed, fixture.Store.GetSyncOperation(operationId).State);
        Assert.AreEqual(1, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task UnsupportedDestinationIsRejectedBeforeTheWorkerCanLeaveItPending()
    {
        using SyncFixture fixture = SyncFixture.Create();
        fixture.Google.SetRow(fixture.ItemId("ashley"), 93);
        SyncOutboxException? rejection = null;
        try
        {
            fixture.Enqueue(
                "ashley",
                Clock,
                intendedFingerprint: RedgifsFingerprint,
                destination: "redgifs",
                payloadValue: "https://www.redgifs.com/watch/ashley-preview"
            );
        }
        catch (SyncOutboxException exception)
        {
            rejection = exception;
        }

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.IsNotNull(rejection);
        Assert.AreEqual(0, summary.Pending);
        Assert.IsFalse(summary.RemoteVerificationOccurred);
        Assert.AreEqual(0, fixture.Google.MetadataSearches.Count);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    [TestMethod]
    public async Task EmptyScopedOutboxReportsNoRemoteVerification()
    {
        using SyncFixture fixture = SyncFixture.Create();

        GoogleSyncSummary summary = await fixture.RunSelectedAsync();

        Assert.IsFalse(summary.RemoteVerificationOccurred);
        Assert.AreEqual(0, fixture.Google.MetadataSearches.Count);
        Assert.AreEqual(0, fixture.Google.CellReads.Count);
        Assert.AreEqual(0, fixture.Google.Mutations.Count);
    }

    private static string Range(int row) => $"'2026 Video Catalogue'!J{row}";

    private static void AssertNoMutationAttempt(CatalogueStore store, string operationId)
    {
        SyncOutboxItem operation = store.GetSyncOperation(operationId);
        Assert.AreEqual(0, operation.AttemptCount);
        Assert.IsNull(operation.AttemptedUtc);
    }

    private sealed class SyncFixture : IDisposable
    {
        private readonly TestDirectory _temp;
        private readonly HttpClient _httpClient;
        private readonly Dictionary<string, string> _items;

        private SyncFixture(
            TestDirectory temp,
            CatalogueStore store,
            FakeGoogleHandler google,
            HttpClient httpClient,
            Dictionary<string, string> items
        )
        {
            _temp = temp;
            Store = store;
            Google = google;
            _httpClient = httpClient;
            _items = items;
            GoogleWorkspaceClient workspace = new(httpClient, new FakeTokenSource());
            Worker = new GoogleCatalogueSyncWorker(workspace, store, () => Clock);
        }

        public CatalogueStore Store { get; }
        public FakeGoogleHandler Google { get; }
        public GoogleCatalogueSyncWorker Worker { get; }

        public static SyncFixture Create(params string[] sourceKeys)
        {
            if (sourceKeys.Length == 0)
                sourceKeys = ["ashley"];
            TestDirectory temp = new();
            CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            Dictionary<string, string> items = sourceKeys.ToDictionary(
                sourceKey => sourceKey,
                _ => Guid.NewGuid().ToString("D"),
                StringComparer.Ordinal
            );
            store.ImportWorkbookProjection(new WorkbookProjection(
                "workbook-one",
                CatalogueSheetId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                true,
                sourceKeys.Select((sourceKey, index) => new WorkbookCatalogueItem(
                    index + 2,
                    sourceKey,
                    $"{sourceKey} title",
                    "Description",
                    "2026-09-11",
                    sourceKey,
                    "01",
                    0,
                    0,
                    new Dictionary<string, string>(),
                    items[sourceKey]
                )).ToArray()
            ));
            FakeGoogleHandler google = new();
            HttpClient httpClient = new(google);
            return new(temp, store, google, httpClient, items);
        }

        public string ItemId(string sourceKey) => _items[sourceKey];

        public Task<GoogleSyncSummary> RunSelectedAsync() => Worker.RunOnceAsync(
            "workbook-one",
            CatalogueSheetId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            CancellationToken.None
        );

        public string Enqueue(
            string sourceKey,
            DateTimeOffset createdUtc,
            string expectedFingerprint = EmptyFingerprint,
            string intendedFingerprint = IntendedFingerprint,
            string destination = "onlyfans",
            string payloadValue = IntendedValue,
            string workbookId = "workbook-one"
        )
        {
            string itemId = ItemId(sourceKey);
            SyncOutboxItem item = Store.EnqueueProjection(new SyncOutboxItem(
                Guid.NewGuid().ToString("D"),
                $"sync-{sourceKey}-{Guid.NewGuid():N}",
                itemId,
                workbookId,
                CatalogueSheetId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "ofenhancer.item_id.v1",
                itemId,
                destination,
                payloadValue,
                expectedFingerprint,
                intendedFingerprint,
                SyncOutboxState.Pending,
                0,
                null,
                createdUtc,
                null,
                null,
                null
            ));
            return item.OperationId;
        }

        public string EnqueueAttempted(string sourceKey, DateTimeOffset createdUtc)
        {
            string operationId = Enqueue(sourceKey, createdUtc);
            Store.MarkSyncAttempted(operationId, createdUtc.AddSeconds(1));
            return operationId;
        }

        public void Dispose()
        {
            Store.Dispose();
            _httpClient.Dispose();
            _temp.Dispose();
        }
    }

    private sealed class FakeGoogleHandler : HttpMessageHandler
    {
        private readonly Dictionary<string, int?[]> _rows = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string?> _cells = new(StringComparer.Ordinal);
        private TaskCompletionSource? _metadataRelease;
        private TaskCompletionSource? _metadataPaused;
        private string _sheetTitle = "2026 Video Catalogue";
        private bool _includeUnrelatedPreferredTab;

        public List<string> MetadataSearches { get; } = [];
        public List<string> CellReads { get; } = [];
        public List<Mutation> Mutations { get; } = [];
        public Action? OnMutation { get; set; }
        public bool ThrowAfterAcceptingMutation { get; set; }
        public int SheetPropertyReads { get; private set; }
        public Task MetadataSearchPaused => _metadataPaused?.Task
            ?? throw new InvalidOperationException("Metadata search is not paused.");

        public void SetRow(string itemId, int? row) => _rows[itemId] = [row];
        public void SetRows(string itemId, params int?[] rows) => _rows[itemId] = rows;
        public void SetCell(string range, string? value) => _cells[range] = value;
        public void SetSheetTitle(string title, bool includeUnrelatedPreferredTab = false)
        {
            _sheetTitle = title;
            _includeUnrelatedPreferredTab = includeUnrelatedPreferredTab;
        }

        public void PauseNextMetadataSearch()
        {
            _metadataRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
            _metadataPaused = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public void ReleaseMetadataSearch() => _metadataRelease?.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            string path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/developerMetadata:search", StringComparison.Ordinal))
            {
                string body = await request.Content!.ReadAsStringAsync(cancellationToken);
                string itemId = JsonDocument.Parse(body).RootElement
                    .GetProperty("dataFilters")[0]
                    .GetProperty("developerMetadataLookup")
                    .GetProperty("metadataValue")
                    .GetString()!;
                MetadataSearches.Add(itemId);
                if (_metadataRelease is not null)
                {
                    _metadataPaused!.TrySetResult();
                    await _metadataRelease.Task.WaitAsync(cancellationToken);
                    _metadataRelease = null;
                }
                return Json(request, MetadataJson(itemId));
            }
            if (request.Method == HttpMethod.Get
                && path.Contains("/spreadsheets/workbook-", StringComparison.Ordinal)
                && !path.Contains("/values/", StringComparison.Ordinal))
            {
                SheetPropertyReads++;
                return Json(request, SheetPropertiesJson(path[(path.LastIndexOf('/') + 1)..]));
            }
            if (request.Method == HttpMethod.Get && path.Contains("/values/", StringComparison.Ordinal))
            {
                string range = Uri.UnescapeDataString(path[(path.LastIndexOf('/') + 1)..]);
                CellReads.Add(range);
                _cells.TryGetValue(range, out string? value);
                string values = value is null ? string.Empty : $",\"values\":[[{JsonSerializer.Serialize(value)}]]";
                return Json(request, $"{{\"range\":{JsonSerializer.Serialize(range)}{values}}}");
            }
            if (request.Method == HttpMethod.Post && path.EndsWith("/values:batchUpdate", StringComparison.Ordinal))
            {
                string body = await request.Content!.ReadAsStringAsync(cancellationToken);
                using JsonDocument json = JsonDocument.Parse(body);
                JsonElement data = json.RootElement.GetProperty("data");
                JsonElement update = data[0];
                string range = update.GetProperty("range").GetString()!;
                string value = update.GetProperty("values")[0][0].GetString()!;
                Mutations.Add(new(range, value, data.GetArrayLength()));
                _cells[range] = value;
                OnMutation?.Invoke();
                if (ThrowAfterAcceptingMutation)
                    throw new TaskCanceledException("The fake server accepted the values batch before timing out.");
                return Json(request, "{}");
            }
            throw new InvalidOperationException($"Unexpected fake request: {request.Method} {request.RequestUri}");
        }

        private string MetadataJson(string itemId)
        {
            _rows.TryGetValue(itemId, out int?[]? rows);
            return JsonSerializer.Serialize(new
            {
                matchedDeveloperMetadata = (rows ?? [])
                    .Where(row => row.HasValue)
                    .Select((row, index) => new
                    {
                        developerMetadata = new
                        {
                            metadataId = 7000 + index,
                            metadataKey = "ofenhancer.item_id.v1",
                            metadataValue = itemId,
                            visibility = "DOCUMENT",
                            location = new
                            {
                                dimensionRange = new
                                {
                                    sheetId = CatalogueSheetId,
                                    dimension = "ROWS",
                                    startIndex = row!.Value - 1,
                                    endIndex = row.Value,
                                },
                            },
                        },
                    }),
            });
        }

        private string SheetPropertiesJson(string workbookId)
        {
            List<object> sheets =
            [
                new
                {
                    properties = new
                    {
                        sheetId = CatalogueSheetId,
                        title = _sheetTitle,
                        hidden = false,
                        gridProperties = new { rowCount = 5_002, columnCount = 24 },
                    },
                },
            ];
            if (_includeUnrelatedPreferredTab)
            {
                sheets.Add(new
                {
                    properties = new
                    {
                        sheetId = 17,
                        title = "2026 Video Catalogue",
                        hidden = false,
                        gridProperties = new { rowCount = 100, columnCount = 24 },
                    },
                });
            }
            return JsonSerializer.Serialize(new
            {
                spreadsheetId = workbookId,
                properties = new { title = "Work" },
                sheets,
            });
        }

        private static HttpResponseMessage Json(HttpRequestMessage request, string body) => new(HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    private sealed record Mutation(string Range, string Value, int UpdateCount);

    private sealed class FakeTokenSource : IGoogleAccessTokenSource
    {
        public ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult("fake-access-token");
        }
    }

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-sync-worker-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
