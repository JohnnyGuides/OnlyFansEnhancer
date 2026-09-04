using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleWorkbookMigratorTests
{
    private const int CatalogueSheetId = 2126708696;
    private static readonly int[] CompanionSheetIds = [1001, 1002, 1003];

    [TestMethod]
    public async Task ChangedWorkbookInvalidatesApprovedPlanBeforeMutation()
    {
        using MigrationFixture fixture = MigrationFixture.CreateForStalePlan();

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            fixture.Migrator.ApplyAsync(fixture.ApprovedHash, CancellationToken.None)
        );

        Assert.AreEqual("stale-migration-plan", error.Code);
        Assert.AreEqual(1, fixture.Handler.InspectionCount);
        Assert.AreEqual(0, fixture.Handler.MutationCount);
    }

    [TestMethod]
    public async Task FreshReinspectionPrecedesOneMutationAndVerifiedBindingPersistence()
    {
        using MigrationFixture fixture = MigrationFixture.CreateSuccessful();

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("applied", result.Status);
        CollectionAssert.AreEqual(
            new[] { "inspect", "mutate", "inspect" },
            fixture.Handler.Events.ToArray()
        );
        Assert.AreEqual(1, fixture.Handler.MutationCount);
        Assert.IsNotNull(result.Inspection);
        Assert.IsTrue(result.Inspection.AlreadyMigrated);
        CollectionAssert.AreEqual(
            result.Inspection.Bindings.ToArray(),
            fixture.Store.GetGoogleBindings("workbook-legacy").ToArray()
        );
    }

    [TestMethod]
    public async Task MigrationBatchCreatesExactOwnedStructureWithoutForeignRangeMutation()
    {
        using MigrationFixture fixture = MigrationFixture.CreateSuccessful();

        _ = await fixture.Migrator.ApplyAsync(fixture.ApprovedHash, CancellationToken.None);

        using JsonDocument batch = JsonDocument.Parse(fixture.Handler.MutationBody!);
        JsonElement[] requests = batch.RootElement.GetProperty("requests").EnumerateArray().ToArray();
        Assert.AreEqual(12, requests.Length);
        AssertCompanionTabs(requests);
        AssertTechnicalColumns(requests);
        AssertRowBindings(requests, fixture.ApprovedInspection.Bindings);
        AssertOnlyOwnedRanges(requests);
    }

    [TestMethod]
    public async Task GeneratedCompanionSheetIdsRejectNonPositiveExistingAndDuplicateCandidates()
    {
        int[] candidates = [0, -1, CatalogueSheetId, 1001, 1001, 73, 1002, 1003];
        using MigrationFixture fixture = MigrationFixture.CreateSuccessful(candidates);

        _ = await fixture.Migrator.ApplyAsync(fixture.ApprovedHash, CancellationToken.None);

        using JsonDocument batch = JsonDocument.Parse(fixture.Handler.MutationBody!);
        int[] generated = batch.RootElement.GetProperty("requests").EnumerateArray()
            .Where(request => request.TryGetProperty("addSheet", out _))
            .Select(request => request.GetProperty("addSheet").GetProperty("properties").GetProperty("sheetId").GetInt32())
            .ToArray();
        CollectionAssert.AreEqual(CompanionSheetIds, generated);
        Assert.IsTrue(generated.All(sheetId => sheetId > 0));
        Assert.AreEqual(generated.Length, generated.Distinct().Count());
        Assert.IsFalse(generated.Contains(CatalogueSheetId));
        Assert.IsFalse(generated.Contains(73));
    }

    [TestMethod]
    public async Task CatalogueSheetIdZeroIsAValidMigrationTarget()
    {
        using MigrationFixture fixture = MigrationFixture.CreateWithZeroCatalogueSheetId();

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("applied", result.Status);
        Assert.IsNotNull(result.Inspection);
        Assert.AreEqual(0, result.Inspection.CatalogueSheetId);
        Assert.AreEqual(1, fixture.Handler.MutationCount);
    }

    [TestMethod]
    public async Task CompleteReplayIsIdempotentAndPersistsBindingsWithoutMutation()
    {
        using MigrationFixture fixture = MigrationFixture.CreateAlreadyMigrated();

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("already-migrated", result.Status);
        Assert.AreEqual(1, fixture.Handler.InspectionCount);
        Assert.AreEqual(0, fixture.Handler.MutationCount);
        Assert.IsNotNull(result.Inspection);
        CollectionAssert.AreEqual(
            result.Inspection.Bindings.ToArray(),
            fixture.Store.GetGoogleBindings("workbook-legacy").ToArray()
        );
    }

    [TestMethod]
    public async Task UncertainAppliedBatchReconcilesByReadWithoutRetry()
    {
        using MigrationFixture fixture = MigrationFixture.CreateUncertain(applied: true);

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("reconciled", result.Status);
        Assert.AreEqual(1, fixture.Handler.MutationCount);
        Assert.AreEqual(2, fixture.Handler.InspectionCount);
        CollectionAssert.AreEqual(
            new[] { "inspect", "mutate", "inspect" },
            fixture.Handler.Events.ToArray()
        );
        Assert.IsNotNull(result.Inspection);
        Assert.IsTrue(result.Inspection.AlreadyMigrated);
        CollectionAssert.AreEqual(
            result.Inspection.Bindings.ToArray(),
            fixture.Store.GetGoogleBindings("workbook-legacy").ToArray()
        );
    }

    [TestMethod]
    public async Task UncertainIncompleteReadbackReturnsUnresolvedWithoutRetry()
    {
        using MigrationFixture fixture = MigrationFixture.CreateUncertain(applied: false);

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("unresolved", result.Status);
        Assert.AreEqual(1, fixture.Handler.MutationCount);
        Assert.AreEqual(2, fixture.Handler.InspectionCount);
        Assert.IsNotNull(result.Inspection);
        Assert.IsFalse(result.Inspection.AlreadyMigrated);
        Assert.IsTrue(result.Inspection.MigrationPlan.Operations.Count > 0);
    }

    [TestMethod]
    public async Task CallerCancellationAfterBatchAcceptanceReturnsUnresolvedWithoutRetry()
    {
        using CancellationTokenSource cancellation = new();
        using MigrationFixture fixture = MigrationFixture.CreateCancelledMutation(cancellation);

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            cancellation.Token
        );

        Assert.AreEqual("unresolved", result.Status);
        Assert.IsNull(result.Inspection);
        Assert.AreEqual(1, fixture.Handler.MutationCount);
        Assert.AreEqual(1, fixture.Handler.InspectionCount);
    }

    private static void AssertCompanionTabs(IReadOnlyList<JsonElement> requests)
    {
        Dictionary<string, string[]> expected = new(StringComparer.Ordinal)
        {
            ["_Assets"] = ["Item ID", "Asset ID", "Role", "Fingerprint", "Verified UTC", "Schema v1"],
            ["_Audit"] = ["Operation ID", "Occurred UTC", "Item ID", "Action", "Outcome", "Details", "Schema v1"],
            ["_Publications"] = ["Item ID", "Platform", "Publication URL", "Published UTC", "Operation ID", "Schema v1"],
        };
        JsonElement[] addSheets = requests.Where(request => request.TryGetProperty("addSheet", out _)).ToArray();
        Assert.AreEqual(3, addSheets.Length);
        foreach ((JsonElement addSheet, int expectedId) in addSheets.Zip(CompanionSheetIds))
        {
            JsonElement properties = addSheet.GetProperty("addSheet").GetProperty("properties");
            string title = properties.GetProperty("title").GetString()!;
            Assert.AreEqual(expectedId, properties.GetProperty("sheetId").GetInt32());
            Assert.IsTrue(properties.GetProperty("hidden").GetBoolean());
            Assert.AreEqual(1_000, properties.GetProperty("gridProperties").GetProperty("rowCount").GetInt32());
            Assert.AreEqual(expected[title].Length, properties.GetProperty("gridProperties").GetProperty("columnCount").GetInt32());

            JsonElement headerRequest = requests.Single(request =>
                request.TryGetProperty("updateCells", out JsonElement update)
                && update.GetProperty("start").GetProperty("sheetId").GetInt32() == expectedId
            );
            CollectionAssert.AreEqual(expected[title], ReadValues(headerRequest));
        }
    }

    private static void AssertTechnicalColumns(IReadOnlyList<JsonElement> requests)
    {
        JsonElement headerRequest = requests.Single(request =>
            request.TryGetProperty("updateCells", out JsonElement update)
            && update.GetProperty("start").GetProperty("sheetId").GetInt32() == CatalogueSheetId
            && update.GetProperty("start").GetProperty("rowIndex").GetInt32() == 0
            && update.GetProperty("start").GetProperty("columnIndex").GetInt32() == 20
        );
        CollectionAssert.AreEqual(
            new[] { "OFEnhancer ID", "Pornhub Paid", "Clips4Sale", "Last verified sync" },
            ReadValues(headerRequest)
        );

        JsonElement hiddenRequest = requests.Single(request => request.TryGetProperty("updateDimensionProperties", out _));
        JsonElement hidden = hiddenRequest.GetProperty("updateDimensionProperties");
        Assert.AreEqual("hiddenByUser", hidden.GetProperty("fields").GetString());
        Assert.IsTrue(hidden.GetProperty("properties").GetProperty("hiddenByUser").GetBoolean());
        AssertOwnedColumnRange(hidden.GetProperty("range"));

        JsonElement groupRequest = requests.Single(request => request.TryGetProperty("addDimensionGroup", out _));
        AssertOwnedColumnRange(groupRequest.GetProperty("addDimensionGroup").GetProperty("range"));
    }

    private static void AssertRowBindings(
        IReadOnlyList<JsonElement> requests,
        IReadOnlyList<GoogleRowBinding> bindings
    )
    {
        JsonElement[] metadata = requests.Where(request => request.TryGetProperty("createDeveloperMetadata", out _)).ToArray();
        Assert.AreEqual(1, metadata.Length);
        GoogleRowBinding missing = bindings.Single(binding => binding.LastObservedRow == 2);
        JsonElement developerMetadata = metadata[0].GetProperty("createDeveloperMetadata").GetProperty("developerMetadata");
        Assert.AreEqual("ofenhancer.item_id.v1", developerMetadata.GetProperty("metadataKey").GetString());
        Assert.AreEqual(missing.ItemId, developerMetadata.GetProperty("metadataValue").GetString());
        Assert.AreEqual("DOCUMENT", developerMetadata.GetProperty("visibility").GetString());
        JsonElement metadataRange = developerMetadata.GetProperty("location").GetProperty("dimensionRange");
        Assert.AreEqual(CatalogueSheetId, metadataRange.GetProperty("sheetId").GetInt32());
        Assert.AreEqual("ROWS", metadataRange.GetProperty("dimension").GetString());
        Assert.AreEqual(1, metadataRange.GetProperty("startIndex").GetInt32());
        Assert.AreEqual(2, metadataRange.GetProperty("endIndex").GetInt32());

        JsonElement[] stableIds = requests.Where(request =>
            request.TryGetProperty("updateCells", out JsonElement update)
            && update.GetProperty("start").GetProperty("sheetId").GetInt32() == CatalogueSheetId
            && update.GetProperty("start").GetProperty("rowIndex").GetInt32() > 0
        ).ToArray();
        Assert.AreEqual(2, stableIds.Length);
        foreach (JsonElement request in stableIds)
        {
            JsonElement start = request.GetProperty("updateCells").GetProperty("start");
            int rowNumber = start.GetProperty("rowIndex").GetInt32() + 1;
            Assert.AreEqual(20, start.GetProperty("columnIndex").GetInt32());
            Assert.AreEqual(
                bindings.Single(binding => binding.LastObservedRow == rowNumber).ItemId,
                ReadValues(request).Single()
            );
        }
    }

    private static void AssertOnlyOwnedRanges(IReadOnlyList<JsonElement> requests)
    {
        foreach (JsonElement request in requests)
        {
            Assert.IsFalse(request.TryGetProperty("deleteSheet", out _));
            Assert.IsFalse(request.TryGetProperty("deleteDimension", out _));
            Assert.IsFalse(request.TryGetProperty("copyPaste", out _));
            if (request.TryGetProperty("updateCells", out JsonElement update))
            {
                JsonElement start = update.GetProperty("start");
                if (start.GetProperty("sheetId").GetInt32() == CatalogueSheetId)
                    Assert.AreEqual(20, start.GetProperty("columnIndex").GetInt32());
            }
            if (request.TryGetProperty("updateDimensionProperties", out JsonElement dimensions))
                AssertOwnedColumnRange(dimensions.GetProperty("range"));
            if (request.TryGetProperty("addDimensionGroup", out JsonElement group))
                AssertOwnedColumnRange(group.GetProperty("range"));
            if (request.TryGetProperty("createDeveloperMetadata", out JsonElement metadata))
            {
                JsonElement range = metadata.GetProperty("developerMetadata").GetProperty("location").GetProperty("dimensionRange");
                Assert.AreEqual(CatalogueSheetId, range.GetProperty("sheetId").GetInt32());
                Assert.AreEqual("ROWS", range.GetProperty("dimension").GetString());
            }
        }
    }

    private static void AssertOwnedColumnRange(JsonElement range)
    {
        Assert.AreEqual(CatalogueSheetId, range.GetProperty("sheetId").GetInt32());
        Assert.AreEqual("COLUMNS", range.GetProperty("dimension").GetString());
        Assert.AreEqual(20, range.GetProperty("startIndex").GetInt32());
        Assert.AreEqual(24, range.GetProperty("endIndex").GetInt32());
    }

    private static string[] ReadValues(JsonElement updateCellsRequest) =>
        updateCellsRequest.GetProperty("updateCells").GetProperty("rows")[0].GetProperty("values")
            .EnumerateArray()
            .Select(value => value.GetProperty("userEnteredValue").GetProperty("stringValue").GetString()!)
            .ToArray();

    private static string FixtureText() => File.ReadAllText(
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "Fixtures", "google-workbook-legacy.json"))
    );

    private static string ChangedWorkbookJson(string source)
    {
        JsonObject root = JsonNode.Parse(source)!.AsObject();
        JsonArray values = root["sheets"]![0]!["data"]![0]!["rowData"]![1]!["values"]!.AsArray();
        values[2]!["formattedValue"] = "Resident Evil Ashley changed after approval";
        return root.ToJsonString();
    }

    private static string ZeroCatalogueSheetIdJson(string source)
    {
        JsonObject root = JsonNode.Parse(source)!.AsObject();
        root["sheets"]![0]!["properties"]!["sheetId"] = 0;
        foreach (JsonNode? metadata in root["developerMetadata"]!.AsArray())
            metadata!["location"]!["dimensionRange"]!["sheetId"] = 0;
        return root.ToJsonString();
    }

    private static string FullyMigratedJson(
        string source,
        IReadOnlyList<GoogleRowBinding> bindings,
        IReadOnlyList<int> companionIds
    )
    {
        JsonObject root = JsonNode.Parse(source)!.AsObject();
        JsonArray sheets = root["sheets"]!.AsArray();
        JsonObject main = sheets[0]!.AsObject();
        int catalogueSheetId = main["properties"]!["sheetId"]!.GetValue<int>();
        JsonObject grid = main["data"]![0]!.AsObject();
        JsonArray rows = grid["rowData"]!.AsArray();
        string[] technicalHeaders = ["OFEnhancer ID", "Pornhub Paid", "Clips4Sale", "Last verified sync"];
        for (int offset = 0; offset < technicalHeaders.Length; offset++)
            SetFormattedValue(rows[0]!.AsObject(), 20 + offset, technicalHeaders[offset]);
        foreach (GoogleRowBinding binding in bindings)
            SetFormattedValue(rows[binding.LastObservedRow - 1]!.AsObject(), 20, binding.ItemId);

        JsonArray columnMetadata = [];
        for (int column = 0; column < 24; column++)
            columnMetadata.Add(column >= 20 ? new JsonObject { ["hiddenByUser"] = true } : new JsonObject());
        grid["columnMetadata"] = columnMetadata;
        main["columnGroups"] = new JsonArray(new JsonObject
        {
            ["range"] = new JsonObject
            {
                ["sheetId"] = catalogueSheetId,
                ["dimension"] = "COLUMNS",
                ["startIndex"] = 20,
                ["endIndex"] = 24,
            },
            ["depth"] = 1,
            ["collapsed"] = false,
        });

        JsonArray metadata = root["developerMetadata"]!.AsArray();
        foreach (GoogleRowBinding binding in bindings.Where(binding =>
            !metadata.Any(node => string.Equals(node!["metadataValue"]?.GetValue<string>(), binding.ItemId, StringComparison.Ordinal))))
        {
            metadata.Add(new JsonObject
            {
                ["metadataId"] = 8_000 + binding.LastObservedRow,
                ["metadataKey"] = "ofenhancer.item_id.v1",
                ["metadataValue"] = binding.ItemId,
                ["visibility"] = "DOCUMENT",
                ["location"] = new JsonObject
                {
                    ["dimensionRange"] = new JsonObject
                    {
                        ["sheetId"] = catalogueSheetId,
                        ["dimension"] = "ROWS",
                        ["startIndex"] = binding.LastObservedRow - 1,
                        ["endIndex"] = binding.LastObservedRow,
                    },
                },
            });
        }

        string[][] headers =
        [
            ["Item ID", "Asset ID", "Role", "Fingerprint", "Verified UTC", "Schema v1"],
            ["Operation ID", "Occurred UTC", "Item ID", "Action", "Outcome", "Details", "Schema v1"],
            ["Item ID", "Platform", "Publication URL", "Published UTC", "Operation ID", "Schema v1"],
        ];
        string[] titles = ["_Assets", "_Audit", "_Publications"];
        for (int index = 0; index < titles.Length; index++)
            sheets.Add(CompanionSheet(companionIds[index], titles[index], headers[index]));
        return root.ToJsonString();
    }

    private static JsonObject CompanionSheet(int sheetId, string title, IReadOnlyList<string> headers) =>
        new()
        {
            ["properties"] = new JsonObject
            {
                ["sheetId"] = sheetId,
                ["title"] = title,
                ["hidden"] = true,
                ["gridProperties"] = new JsonObject
                {
                    ["rowCount"] = 1_000,
                    ["columnCount"] = headers.Count,
                },
            },
            ["data"] = new JsonArray(new JsonObject
            {
                ["startRow"] = 0,
                ["startColumn"] = 0,
                ["rowData"] = new JsonArray(new JsonObject
                {
                    ["values"] = new JsonArray(headers.Select(value =>
                        (JsonNode)new JsonObject { ["formattedValue"] = value }).ToArray()),
                }),
            }),
        };

    private static void SetFormattedValue(JsonObject row, int zeroBasedColumn, string value)
    {
        JsonArray values = row["values"]!.AsArray();
        while (values.Count <= zeroBasedColumn)
            values.Add(new JsonObject());
        values[zeroBasedColumn] = new JsonObject { ["formattedValue"] = value };
    }

    private sealed class MigrationFixture : IDisposable
    {
        private readonly TestDirectory _temp;
        private readonly HttpClient _httpClient;

        private MigrationFixture(
            TestDirectory temp,
            CatalogueStore store,
            WorkbookInspection approvedInspection,
            MigrationHandler handler,
            HttpClient httpClient,
            GoogleWorkbookMigrator migrator
        )
        {
            _temp = temp;
            Store = store;
            ApprovedInspection = approvedInspection;
            Handler = handler;
            _httpClient = httpClient;
            Migrator = migrator;
        }

        public CatalogueStore Store { get; }
        public WorkbookInspection ApprovedInspection { get; }
        public string ApprovedHash => ApprovedInspection.PlanHash;
        public MigrationHandler Handler { get; }
        public GoogleWorkbookMigrator Migrator { get; }

        public static MigrationFixture CreateSuccessful(IEnumerable<int>? candidates = null)
        {
            string legacy = FixtureText();
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            string migrated = FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds);
            return Create(temp, store, approved, [legacy, migrated], candidates ?? CompanionSheetIds);
        }

        public static MigrationFixture CreateForStalePlan()
        {
            string legacy = FixtureText();
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            return Create(temp, store, approved, [ChangedWorkbookJson(legacy)], CompanionSheetIds);
        }

        public static MigrationFixture CreateWithZeroCatalogueSheetId()
        {
            string legacy = ZeroCatalogueSheetIdJson(FixtureText());
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            string migrated = FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds);
            return Create(temp, store, approved, [legacy, migrated], CompanionSheetIds);
        }

        public static MigrationFixture CreateAlreadyMigrated()
        {
            string legacy = FixtureText();
            TestDirectory temp = new();
            CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            WorkbookInspection legacyInspection = GoogleWorkbookProfile.Inspect(Parse(legacy), store);
            string migrated = FullyMigratedJson(legacy, legacyInspection.Bindings, CompanionSheetIds);
            WorkbookInspection approved = GoogleWorkbookProfile.Inspect(Parse(migrated), store);
            return Create(temp, store, approved, [migrated], CompanionSheetIds);
        }

        public static MigrationFixture CreateUncertain(bool applied)
        {
            string legacy = FixtureText();
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            string readback = applied
                ? FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds)
                : legacy;
            return Create(
                temp,
                store,
                approved,
                [legacy, readback],
                CompanionSheetIds,
                timeoutMutation: true
            );
        }

        public static MigrationFixture CreateCancelledMutation(CancellationTokenSource cancellation)
        {
            string legacy = FixtureText();
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            return Create(
                temp,
                store,
                approved,
                [legacy],
                CompanionSheetIds,
                cancelMutation: cancellation.Cancel
            );
        }

        private static (TestDirectory Temp, CatalogueStore Store, WorkbookInspection Inspection) Approved(string json)
        {
            TestDirectory temp = new();
            CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(Parse(json), store);
            return (temp, store, inspection);
        }

        private static MigrationFixture Create(
            TestDirectory temp,
            CatalogueStore store,
            WorkbookInspection approved,
            IEnumerable<string> snapshots,
            IEnumerable<int> candidates,
            bool timeoutMutation = false,
            Action? cancelMutation = null
        )
        {
            MigrationHandler handler = new(snapshots, timeoutMutation, cancelMutation);
            HttpClient httpClient = new(handler);
            GoogleWorkspaceClient workspace = new(httpClient, new FakeTokenSource());
            IEnumerator<int> generated = candidates.GetEnumerator();
            GoogleWorkbookMigrator migrator = new(
                "workbook-legacy",
                workspace,
                store,
                () => generated.MoveNext() ? generated.Current : throw new InvalidOperationException("No fake sheet ID remains.")
            );
            return new(temp, store, approved, handler, httpClient, migrator);
        }

        public void Dispose()
        {
            Store.Dispose();
            _httpClient.Dispose();
            _temp.Dispose();
        }
    }

    private sealed class MigrationHandler(
        IEnumerable<string> snapshots,
        bool timeoutMutation = false,
        Action? cancelMutation = null
    ) : HttpMessageHandler
    {
        private readonly Queue<string> _snapshots = new(snapshots);

        public int InspectionCount { get; private set; }
        public int MutationCount { get; private set; }
        public string? MutationBody { get; private set; }
        public List<string> Events { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            if (request.Method == HttpMethod.Get)
            {
                if (_snapshots.Count == 0)
                    throw new InvalidOperationException("No fake workbook snapshot remains.");
                string body = _snapshots.Peek();
                if (request.RequestUri!.Query.Contains("includeGridData=true", StringComparison.Ordinal))
                {
                    _snapshots.Dequeue();
                    InspectionCount++;
                    Events.Add("inspect");
                }
                return Json(request, body);
            }
            if (request.Method == HttpMethod.Post)
            {
                MutationCount++;
                Events.Add("mutate");
                MutationBody = await request.Content!.ReadAsStringAsync(cancellationToken);
                if (cancelMutation is not null)
                {
                    cancelMutation();
                    throw new OperationCanceledException(cancellationToken);
                }
                if (timeoutMutation)
                    throw new TaskCanceledException("The fake server accepted the batch before timing out.");
                return Json(request, "{}");
            }
            throw new InvalidOperationException($"Unexpected fake method: {request.Method}");
        }

        private static HttpResponseMessage Json(HttpRequestMessage request, string body) => new(HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    private sealed class FakeTokenSource : IGoogleAccessTokenSource
    {
        public ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult("fake-access-token");
        }
    }

    private static GoogleWorkbookSnapshot Parse(string json) =>
        GoogleWorkbookSnapshot.Parse(Encoding.UTF8.GetBytes(json));

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-migrator-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
