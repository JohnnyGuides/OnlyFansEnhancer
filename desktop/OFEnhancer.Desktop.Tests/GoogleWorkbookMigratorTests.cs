using OFEnhancer.Protocol;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

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
        Assert.AreEqual(0, fixture.Store.GetItems(includeArchived: true).Count);
        Assert.AreEqual(0, fixture.Store.GetGoogleBindings("workbook-legacy").Count);
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
        Assert.AreEqual(11, requests.Length);
        AssertCompanionTabs(requests);
        AssertMigrationReceipt(requests, fixture.ApprovedInspection);
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
    public async Task ReplayRejectsAHashWithoutAnExactCurrentReceipt()
    {
        using MigrationFixture fixture = MigrationFixture.CreateAlreadyMigrated();
        string unrelatedHash = new('a', 64);
        if (string.Equals(unrelatedHash, fixture.ApprovedHash, StringComparison.Ordinal))
            unrelatedHash = new string('b', 64);

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() =>
            fixture.Migrator.ApplyAsync(unrelatedHash, CancellationToken.None)
        );

        Assert.AreEqual("stale-migration-plan", error.Code);
        Assert.AreEqual(0, fixture.Handler.MutationCount);
        Assert.AreEqual(0, fixture.Store.GetItems(includeArchived: true).Count);
        Assert.AreEqual(0, fixture.Store.GetGoogleBindings("workbook-legacy").Count);
    }

    [TestMethod]
    public async Task RestartWithReceiptButIncompleteStateReturnsUnresolvedWithoutRetryOrPersistence()
    {
        using MigrationFixture fixture = MigrationFixture.CreateIncompleteReceiptReplay();

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("unresolved", result.Status);
        Assert.IsNotNull(result.Inspection);
        Assert.IsFalse(result.Inspection.AlreadyMigrated);
        Assert.AreEqual(1, result.Inspection.MigrationReceipts.Count);
        Assert.AreEqual(0, fixture.Handler.MutationCount);
        Assert.AreEqual(0, fixture.Store.GetItems(includeArchived: true).Count);
        Assert.AreEqual(0, fixture.Store.GetGoogleBindings("workbook-legacy").Count);
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
        Assert.AreEqual(0, fixture.Store.GetItems(includeArchived: true).Count);
        Assert.AreEqual(0, fixture.Store.GetGoogleBindings("workbook-legacy").Count);
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

    [TestMethod]
    public async Task ConcurrentSourceAndItemSubstitutionReturnsUnresolvedWithoutPersistence()
    {
        using MigrationFixture fixture = MigrationFixture.CreateSubstitutedReadback();

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("unresolved", result.Status);
        Assert.AreEqual(1, fixture.Handler.MutationCount);
        Assert.AreEqual(2, fixture.Handler.InspectionCount);
        Assert.AreEqual(0, fixture.Store.GetItems(includeArchived: true).Count);
        Assert.AreEqual(0, fixture.Store.GetGoogleBindings("workbook-legacy").Count);
    }

    [TestMethod]
    [Timeout(30_000)]
    public async Task FiveThousandRowsFitOneBoundedAtomicBatchWithoutForeignWrites()
    {
        using MigrationFixture fixture = MigrationFixture.CreateMaximumRows();

        WorkbookMigrationResult result = await fixture.Migrator.ApplyAsync(
            fixture.ApprovedHash,
            CancellationToken.None
        );

        Assert.AreEqual("applied", result.Status);
        Assert.AreEqual(1, fixture.Handler.MutationCount);
        Assert.IsNotNull(fixture.Handler.MutationBody);
        Assert.IsTrue(
            Encoding.UTF8.GetByteCount(fixture.Handler.MutationBody)
            <= GoogleWorkspaceClient.MaximumStructuralRequestBytes
        );
        using JsonDocument batch = JsonDocument.Parse(fixture.Handler.MutationBody);
        JsonElement[] requests = batch.RootElement.GetProperty("requests").EnumerateArray().ToArray();
        Assert.IsTrue(requests.Length <= GoogleWorkspaceClient.MaximumStructuralRequestCount);
        Assert.AreEqual(5_000, requests.Count(request => request.TryGetProperty("createDeveloperMetadata", out _)));
        JsonElement[] stableWrites = requests.Where(request =>
            request.TryGetProperty("updateCells", out JsonElement update)
            && update.GetProperty("start").GetProperty("sheetId").GetInt32() == CatalogueSheetId
            && update.GetProperty("start").GetProperty("rowIndex").GetInt32() > 0
        ).ToArray();
        Assert.AreEqual(1, stableWrites.Length);
        Assert.AreEqual(
            5_000,
            stableWrites[0].GetProperty("updateCells").GetProperty("rows").GetArrayLength()
        );
        AssertOnlyOwnedRanges(requests);
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

    private static void AssertMigrationReceipt(
        IReadOnlyList<JsonElement> requests,
        WorkbookInspection approved
    )
    {
        JsonElement auditWrite = requests.Single(request =>
            request.TryGetProperty("updateCells", out JsonElement update)
            && update.GetProperty("start").GetProperty("sheetId").GetInt32() == 1002
        );
        JsonElement[] rows = auditWrite.GetProperty("updateCells").GetProperty("rows").EnumerateArray().ToArray();
        Assert.AreEqual(2, rows.Length);
        string[] receipt = ReadRowValues(rows[1]);
        Assert.AreEqual(7, receipt.Length);
        Assert.IsTrue(Guid.TryParseExact(receipt[0], "D", out _));
        Assert.IsTrue(DateTimeOffset.TryParseExact(receipt[1], "O", null, System.Globalization.DateTimeStyles.RoundtripKind, out _));
        Assert.AreEqual(string.Empty, receipt[2]);
        Assert.AreEqual("workbook-migration", receipt[3]);
        Assert.AreEqual("completed", receipt[4]);
        Assert.AreEqual(
            $"plan-sha256={approved.PlanHash};identity-sha256={approved.MigrationIdentityFingerprint}",
            receipt[5]
        );
        Assert.AreEqual("Schema v1", receipt[6]);
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
        Assert.AreEqual(1, stableIds.Length);
        JsonElement stableIdsUpdate = stableIds[0].GetProperty("updateCells");
        JsonElement start = stableIdsUpdate.GetProperty("start");
        Assert.AreEqual(bindings.Min(binding => binding.LastObservedRow) - 1, start.GetProperty("rowIndex").GetInt32());
        Assert.AreEqual(20, start.GetProperty("columnIndex").GetInt32());
        JsonElement[] rows = stableIdsUpdate.GetProperty("rows").EnumerateArray().ToArray();
        Assert.AreEqual(bindings.Count, rows.Length);
        for (int offset = 0; offset < rows.Length; offset++)
        {
            int rowNumber = start.GetProperty("rowIndex").GetInt32() + offset + 1;
            Assert.AreEqual(
                bindings.Single(binding => binding.LastObservedRow == rowNumber).ItemId,
                ReadRowValues(rows[offset]).Single()
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
        ReadRowValues(updateCellsRequest.GetProperty("updateCells").GetProperty("rows")[0]);

    private static string[] ReadRowValues(JsonElement row) =>
        row.GetProperty("values")
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

    private static string MaximumRowsJson(string source)
    {
        JsonObject root = JsonNode.Parse(source)!.AsObject();
        JsonArray rowData = root["sheets"]![0]!["data"]![0]!["rowData"]!.AsArray();
        JsonNode header = rowData[0]!.DeepClone();
        rowData.Clear();
        rowData.Add(header);
        for (int index = 1; index <= 5_000; index++)
        {
            JsonArray values =
            [
                new JsonObject { ["formattedValue"] = $"item-{index:D4}" },
                new JsonObject(),
                new JsonObject { ["formattedValue"] = $"Episode {index:D4}" },
                new JsonObject { ["formattedValue"] = string.Empty },
            ];
            if (index == 1)
            {
                while (values.Count < 18)
                    values.Add(new JsonObject());
                values[17] = new JsonObject { ["formattedValue"] = "Foreign boundary retained" };
            }
            rowData.Add(new JsonObject { ["values"] = values });
        }
        root["developerMetadata"] = new JsonArray();
        return root.ToJsonString();
    }

    private static string WorkbookMetadataJson(string source)
    {
        JsonObject workbook = JsonNode.Parse(source)!.AsObject();
        return new JsonObject
        {
            ["spreadsheetId"] = workbook["spreadsheetId"]!.DeepClone(),
            ["properties"] = workbook["properties"]!.DeepClone(),
            ["sheets"] = new JsonArray(workbook["sheets"]!.AsArray()
                .Select(sheet => (JsonNode?)new JsonObject
                {
                    ["properties"] = sheet!["properties"]!.DeepClone(),
                })
                .ToArray()),
        }.ToJsonString();
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

    private static string WithMigrationReceipt(string migrated, WorkbookInspection approved)
    {
        JsonObject root = JsonNode.Parse(migrated)!.AsObject();
        JsonObject audit = root["sheets"]!.AsArray()
            .Select(node => node!.AsObject())
            .Single(sheet => string.Equals(sheet["properties"]!["title"]!.GetValue<string>(), "_Audit", StringComparison.Ordinal));
        JsonArray rowData = audit["data"]![0]!["rowData"]!.AsArray();
        string details = $"plan-sha256={approved.PlanHash};identity-sha256={approved.MigrationIdentityFingerprint}";
        string[] values =
        [
            ReceiptOperationId(approved.PlanHash, approved.MigrationIdentityFingerprint),
            "2026-09-04T12:00:00.0000000+00:00",
            string.Empty,
            "workbook-migration",
            "completed",
            details,
            "Schema v1",
        ];
        rowData.Add(new JsonObject
        {
            ["values"] = new JsonArray(values.Select(value =>
                (JsonNode)new JsonObject { ["formattedValue"] = value }).ToArray()),
        });
        return root.ToJsonString();
    }

    private static string ReceiptOperationId(string planHash, string identityHash)
    {
        byte[] bytes = System.Security.Cryptography.SHA256.HashData(
            Encoding.UTF8.GetBytes($"ofenhancer.workbook-migration-receipt.v1\0{planHash}\0{identityHash}")
        )[..16];
        bytes[7] = (byte)((bytes[7] & 0x0f) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
        return new Guid(bytes).ToString("D");
    }

    private static string SubstitutedMigratedJson(
        string source,
        WorkbookInspection approved,
        IReadOnlyList<int> companionIds
    )
    {
        const string substitutedId = "22222222-2222-4222-8222-222222222222";
        string migrated = FullyMigratedJson(source, approved.Bindings, companionIds);
        JsonObject root = JsonNode.Parse(WithMigrationReceipt(migrated, approved))!.AsObject();
        JsonArray firstRow = root["sheets"]![0]!["data"]![0]!["rowData"]![1]!["values"]!.AsArray();
        firstRow[0] = new JsonObject { ["formattedValue"] = "claire" };
        firstRow[20] = new JsonObject { ["formattedValue"] = substitutedId };
        JsonObject metadata = root["developerMetadata"]!.AsArray()
            .Select(node => node!.AsObject())
            .Single(node => node["location"]!["dimensionRange"]!["startIndex"]!.GetValue<int>() == 1);
        metadata["metadataValue"] = substitutedId;
        return root.ToJsonString();
    }

    private static string IncompleteMigratedJson(
        string source,
        WorkbookInspection approved,
        IReadOnlyList<int> companionIds
    )
    {
        JsonObject root = JsonNode.Parse(WithMigrationReceipt(
            FullyMigratedJson(source, approved.Bindings, companionIds),
            approved
        ))!.AsObject();
        root["sheets"]![0]!["data"]![0]!["rowData"]![1]!["values"]![20] = new JsonObject();
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
            string migrated = WithMigrationReceipt(
                FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds),
                approved
            );
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
            string migrated = WithMigrationReceipt(
                FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds),
                approved
            );
            return Create(temp, store, approved, [legacy, migrated], CompanionSheetIds);
        }

        public static MigrationFixture CreateAlreadyMigrated()
        {
            string legacy = FixtureText();
            WorkbookInspection approved;
            using (TestDirectory planningTemp = new())
            using (CatalogueStore planningStore = CatalogueStore.Open(Path.Combine(planningTemp.Path, "catalogue.db")))
                approved = GoogleWorkbookProfile.Inspect(Parse(legacy), planningStore);
            string migrated = WithMigrationReceipt(
                FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds),
                approved
            );
            TestDirectory temp = new();
            CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            return Create(temp, store, approved, [migrated], CompanionSheetIds);
        }

        public static MigrationFixture CreateIncompleteReceiptReplay()
        {
            string legacy = FixtureText();
            WorkbookInspection approved;
            using (TestDirectory planningTemp = new())
            using (CatalogueStore planningStore = CatalogueStore.Open(Path.Combine(planningTemp.Path, "catalogue.db")))
                approved = GoogleWorkbookProfile.Inspect(Parse(legacy), planningStore);
            string incomplete = IncompleteMigratedJson(legacy, approved, CompanionSheetIds);
            TestDirectory temp = new();
            CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            return Create(temp, store, approved, [incomplete], CompanionSheetIds);
        }

        public static MigrationFixture CreateUncertain(bool applied)
        {
            string legacy = FixtureText();
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            string readback = applied
                ? WithMigrationReceipt(
                    FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds),
                    approved
                )
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

        public static MigrationFixture CreateSubstitutedReadback()
        {
            string legacy = FixtureText();
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            string substituted = SubstitutedMigratedJson(legacy, approved, CompanionSheetIds);
            return Create(temp, store, approved, [legacy, substituted], CompanionSheetIds);
        }

        public static MigrationFixture CreateMaximumRows()
        {
            string legacy = MaximumRowsJson(FixtureText());
            (TestDirectory temp, CatalogueStore store, WorkbookInspection approved) = Approved(legacy);
            string migrated = WithMigrationReceipt(
                FullyMigratedJson(legacy, approved.Bindings, CompanionSheetIds),
                approved
            );
            return Create(temp, store, approved, [legacy, migrated], CompanionSheetIds);
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
                else
                {
                    body = WorkbookMetadataJson(body);
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
