using System.Text;
using System.Text.Json.Nodes;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleWorkbookProfileTests
{
    private const string ExistingBiancaId = "11111111-1111-4111-8111-111111111111";

    [DataTestMethod]
    [DataRow("pornhubFree", "H")]
    [DataRow("onlyfans", "J")]
    [DataRow("fansly", "K")]
    [DataRow("manyvids", "L")]
    [DataRow("xTeasers", "N")]
    [DataRow("x", "O")]
    [DataRow("redditTeasers", "S")]
    [DataRow("reddit", "T")]
    [DataRow("ofenhancerId", "U")]
    [DataRow("pornhubPaid", "V")]
    [DataRow("clips4sale", "W")]
    [DataRow("lastVerifiedSync", "X")]
    public void SyncDestinationsUseTheInspectedProfileColumns(string destination, string expectedColumn)
    {
        Assert.AreEqual(expectedColumn, GoogleWorkbookProfile.ColumnForDestination(destination));
    }

    [TestMethod]
    public void UnmappedSyncDestinationFailsClosed()
    {
        GoogleCatalogueException error = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.ColumnForDestination("redgifs")
        );

        Assert.AreEqual("unsupported-workbook-destination", error.Code);
    }

    [TestMethod]
    public void LegacyProfileProducesNormalizedProjectionBindingsAndMigrationPlan()
    {
        GoogleWorkbookSnapshot snapshot = LegacySnapshot();
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(snapshot, store);

        Assert.AreEqual(2126708696, inspection.CatalogueSheetId);
        Assert.AreEqual("2026 Video Catalogue", inspection.CatalogueSheetTitle);
        Assert.AreEqual("workbook-legacy", inspection.Projection.WorkbookId);
        Assert.AreEqual("2126708696", inspection.Projection.SheetId);
        Assert.IsTrue(inspection.Projection.Complete);
        Assert.AreEqual(2, inspection.Projection.Items.Count);
        Assert.AreEqual(0, inspection.Conflicts.Count);
        Assert.IsFalse(inspection.AlreadyMigrated);

        WorkbookCatalogueItem ashley = inspection.Projection.Items.Single(item => item.SourceKey == "ashley");
        Assert.AreEqual(2, ashley.SourceRow);
        Assert.AreEqual("2026-09-11", ashley.PlannedDate);
        Assert.AreEqual("Resident Evil Ashley", ashley.Title);
        Assert.AreEqual("Resident Evil", ashley.Series);
        Assert.AreEqual("04", ashley.Episode);
        Assert.AreEqual(2, ashley.XTeasers);
        Assert.AreEqual(1, ashley.RedditTeasers);
        Assert.AreEqual("https://www.pornhub.com/view_video.php?viewkey=phashley01", ashley.PlatformLinks["pornhubFree"]);
        Assert.AreEqual("https://onlyfans.com/123456789/johnny_guides", ashley.PlatformLinks["onlyfans"]);
        Assert.AreEqual("https://fansly.com/post/987654321", ashley.PlatformLinks["fansly"]);
        Assert.AreEqual("https://www.manyvids.com/Video/1234567", ashley.PlatformLinks["manyvids"]);
        Assert.AreEqual("https://x.com/Johnny_Guides/status/2094523397057237306", ashley.PlatformLinks["x"]);
        Assert.AreEqual("https://www.reddit.com/r/cosplay/comments/abc123/ashley_teaser", ashley.PlatformLinks["reddit"]);

        WorkbookCatalogueItem bianca = inspection.Projection.Items.Single(item => item.SourceKey == "bianca");
        Assert.AreEqual(ExistingBiancaId, bianca.MetadataId);
        GoogleRowBinding biancaBinding = inspection.Bindings.Single(binding => binding.MetadataId == ExistingBiancaId);
        Assert.AreEqual(ExistingBiancaId, biancaBinding.ItemId);
        Assert.AreEqual(3, biancaBinding.LastObservedRow);
        Assert.AreEqual(64, inspection.PlanHash.Length);
        StringAssert.Matches(inspection.PlanHash, new("^[0-9a-f]{64}$"));
    }

    [TestMethod]
    public void InspectionAssignsScopedDeterministicProvisionalIdsWithoutMutatingCatalogue()
    {
        GoogleWorkbookSnapshot snapshot = LegacySnapshot();
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection first = GoogleWorkbookProfile.Inspect(snapshot, store);
        WorkbookInspection second = GoogleWorkbookProfile.Inspect(snapshot, store);

        GoogleRowBinding firstAshley = first.Bindings.Single(binding => binding.LastObservedRow == 2);
        GoogleRowBinding secondAshley = second.Bindings.Single(binding => binding.LastObservedRow == 2);
        Assert.AreEqual(firstAshley.ItemId, secondAshley.ItemId);
        Assert.IsTrue(Guid.TryParseExact(firstAshley.ItemId, "D", out _));
        Assert.AreEqual(0, store.GetItems(includeArchived: true).Count);
        Assert.AreEqual(0, store.GetGoogleBindings("workbook-legacy").Count);

        GoogleWorkbookSnapshot otherWorkbook = snapshot with { WorkbookId = "workbook-other" };
        WorkbookInspection other = GoogleWorkbookProfile.Inspect(otherWorkbook, store);
        Assert.AreNotEqual(
            firstAshley.ItemId,
            other.Bindings.Single(binding => binding.LastObservedRow == 2).ItemId
        );
    }

    [TestMethod]
    public void PreferredTabNameBreaksOnlyARealSchemaTie()
    {
        GoogleWorkbookSnapshot ambiguous = AmbiguousSnapshot();
        GoogleWorkbookSnapshot preferredTie = ambiguous with
        {
            Sheets =
            [
                ambiguous.Sheets[0] with { Title = "2026 Video Catalogue" },
                ambiguous.Sheets[1],
            ]
        };
        using TestDirectory firstTemp = new();
        using CatalogueStore firstStore = CatalogueStore.Open(Path.Combine(firstTemp.Path, "catalogue.db"));

        WorkbookInspection tied = GoogleWorkbookProfile.Inspect(preferredTie, firstStore);

        Assert.AreEqual(101, tied.CatalogueSheetId);

        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleWorkbookSnapshot nameWithoutSchema = legacy with
        {
            Sheets =
            [
                legacy.Sheets[0] with { Title = "Catalogue Copy" },
                legacy.Sheets[1] with { Title = "2026 Video Catalogue" },
            ]
        };
        using TestDirectory secondTemp = new();
        using CatalogueStore secondStore = CatalogueStore.Open(Path.Combine(secondTemp.Path, "catalogue.db"));

        WorkbookInspection schemaWins = GoogleWorkbookProfile.Inspect(nameWithoutSchema, secondStore);

        Assert.AreEqual(2126708696, schemaWins.CatalogueSheetId);
        Assert.AreEqual("Catalogue Copy", schemaWins.CatalogueSheetTitle);
    }

    [TestMethod]
    public void ZeroOrMultipleCredibleProfilesFailClosed()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleWorkbookSnapshot none = legacy with
        {
            Sheets = [legacy.Sheets[1]],
            DeveloperMetadata = [],
        };
        using TestDirectory noneTemp = new();
        using CatalogueStore noneStore = CatalogueStore.Open(Path.Combine(noneTemp.Path, "catalogue.db"));
        GoogleCatalogueException missing = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.Inspect(none, noneStore)
        );
        Assert.AreEqual("workbook-profile-not-found", missing.Code);

        using TestDirectory ambiguousTemp = new();
        using CatalogueStore ambiguousStore = CatalogueStore.Open(Path.Combine(ambiguousTemp.Path, "catalogue.db"));
        GoogleCatalogueException ambiguous = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.Inspect(AmbiguousSnapshot(), ambiguousStore)
        );
        Assert.AreEqual("workbook-profile-ambiguous", ambiguous.Code);
    }

    [TestMethod]
    public void MoreThanFiveThousandPopulatedRowsFailsBeforeLocalImport()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleSheetSnapshot main = legacy.Sheets[0];
        GoogleWorkbookRowSnapshot template = main.Rows[1];
        List<GoogleWorkbookRowSnapshot> rows = [main.Rows[0]];
        for (int index = 0; index < 5_001; index++)
        {
            GoogleWorkbookRowSnapshot row = SetCell(
                template with { RowNumber = index + 2 },
                1,
                $"item-{index:D4}"
            );
            rows.Add(row);
        }
        GoogleWorkbookSnapshot oversized = legacy with
        {
            Sheets = [main with { Rows = rows }, legacy.Sheets[1]],
            DeveloperMetadata = [],
        };
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        GoogleCatalogueException error = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.Inspect(oversized, store)
        );

        Assert.AreEqual("workbook-row-limit", error.Code);
        Assert.AreEqual(0, store.GetItems(includeArchived: true).Count);
    }

    [TestMethod]
    public void Rows_beyond_the_bounded_read_fail_closed_instead_of_claiming_a_complete_projection()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleSheetSnapshot main = legacy.Sheets[0] with { RowCount = 5_003 };
        GoogleWorkbookSnapshot potentiallySparse = legacy with
        {
            Sheets = [main, .. legacy.Sheets.Skip(1)],
        };
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        GoogleCatalogueException error = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.Inspect(potentiallySparse, store)
        );

        Assert.AreEqual("workbook-row-limit", error.Code);
        Assert.AreEqual(0, store.GetItems(includeArchived: true).Count);
    }

    [TestMethod]
    public void MalformedDatesAndLinksFailBeforeAnyLocalCatalogueChange()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleWorkbookSnapshot badDate = ReplaceMainRow(
            legacy,
            SetCell(legacy.Sheets[0].Rows[1], 2, "09/11/2026")
        );
        using TestDirectory dateTemp = new();
        using CatalogueStore dateStore = CatalogueStore.Open(Path.Combine(dateTemp.Path, "catalogue.db"));
        GoogleCatalogueException dateError = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.Inspect(badDate, dateStore)
        );
        Assert.AreEqual("invalid-workbook-date", dateError.Code);
        Assert.AreEqual(0, dateStore.GetItems(includeArchived: true).Count);

        GoogleWorkbookSnapshot badLink = ReplaceMainRow(
            legacy,
            SetCell(legacy.Sheets[0].Rows[1], 8, "http://www.pornhub.com/view_video.php?viewkey=phashley01")
        );
        using TestDirectory linkTemp = new();
        using CatalogueStore linkStore = CatalogueStore.Open(Path.Combine(linkTemp.Path, "catalogue.db"));
        GoogleCatalogueException linkError = Assert.ThrowsException<GoogleCatalogueException>(() =>
            GoogleWorkbookProfile.Inspect(badLink, linkStore)
        );
        Assert.AreEqual("invalid-workbook-link", linkError.Code);
        Assert.AreEqual(0, linkStore.GetItems(includeArchived: true).Count);
    }

    [TestMethod]
    public void DuplicateAndMalformedItemMetadataAreReportedWithoutImportingRows()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleDeveloperMetadataSnapshot existing = legacy.DeveloperMetadata.Single();
        GoogleWorkbookSnapshot duplicate = legacy with
        {
            DeveloperMetadata =
            [
                existing,
                existing with { MetadataId = 7002, StartRowIndex = 1, EndRowIndex = 2 },
            ]
        };
        using TestDirectory duplicateTemp = new();
        using CatalogueStore duplicateStore = CatalogueStore.Open(Path.Combine(duplicateTemp.Path, "catalogue.db"));

        WorkbookInspection duplicateInspection = GoogleWorkbookProfile.Inspect(duplicate, duplicateStore);

        Assert.IsTrue(duplicateInspection.Conflicts.Any(conflict => conflict.Code == "duplicate-item-metadata"));
        Assert.AreEqual(0, duplicateStore.GetItems(includeArchived: true).Count);

        GoogleWorkbookSnapshot malformed = legacy with
        {
            DeveloperMetadata =
            [
                existing with
                {
                    Value = "not-a-guid",
                    Visibility = "PROJECT",
                    Dimension = "COLUMNS",
                    EndRowIndex = existing.StartRowIndex + 2,
                },
            ]
        };
        using TestDirectory malformedTemp = new();
        using CatalogueStore malformedStore = CatalogueStore.Open(Path.Combine(malformedTemp.Path, "catalogue.db"));

        WorkbookInspection malformedInspection = GoogleWorkbookProfile.Inspect(malformed, malformedStore);

        Assert.IsTrue(malformedInspection.Conflicts.Any(conflict => conflict.Code == "invalid-item-metadata"));
        Assert.AreEqual(0, malformedStore.GetItems(includeArchived: true).Count);
    }

    [TestMethod]
    public void MetadataIdentityFollowsAnItemAfterItsPhysicalRowMoves()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleWorkbookRowSnapshot movedBianca = legacy.Sheets[0].Rows[2] with { RowNumber = 10 };
        GoogleSheetSnapshot movedMain = legacy.Sheets[0] with
        {
            Rows = [legacy.Sheets[0].Rows[0], legacy.Sheets[0].Rows[1], movedBianca],
        };
        GoogleDeveloperMetadataSnapshot movedMetadata = legacy.DeveloperMetadata.Single() with
        {
            StartRowIndex = 9,
            EndRowIndex = 10,
        };
        GoogleWorkbookSnapshot moved = legacy with
        {
            Sheets = [movedMain, legacy.Sheets[1]],
            DeveloperMetadata = [movedMetadata],
        };
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(moved, store);

        GoogleRowBinding binding = inspection.Bindings.Single(candidate => candidate.MetadataId == ExistingBiancaId);
        Assert.AreEqual(ExistingBiancaId, binding.ItemId);
        Assert.AreEqual(10, binding.LastObservedRow);
    }

    [TestMethod]
    public void RemoteMetadataThatContradictsLocalSourceIdentityReturnsAnExactConflict()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleDeveloperMetadataSnapshot conflictingAshley = legacy.DeveloperMetadata.Single() with
        {
            MetadataId = 7002,
            Value = "22222222-2222-4222-8222-222222222222",
            StartRowIndex = 1,
            EndRowIndex = 2,
        };
        GoogleWorkbookSnapshot conflicting = legacy with
        {
            DeveloperMetadata = [.. legacy.DeveloperMetadata, conflictingAshley],
        };
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(LocalCatalogueSnapshot("ashley"));
        CatalogueItemSummary original = store.GetItems(includeArchived: true).Single();

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(conflicting, store);

        CollectionAssert.Contains(
            inspection.Conflicts.ToArray(),
            new WorkbookConflict("metadata-source-identity-conflict", "A2")
        );
        CatalogueItemSummary retained = store.GetItems(includeArchived: true).Single();
        Assert.AreEqual(original.ItemId, retained.ItemId);
        Assert.AreEqual("ashley", retained.SourceKey);
        Assert.AreEqual(0, inspection.Bindings.Count);
    }

    [TestMethod]
    public void NonEmptyForeignTechnicalCellsBlockMigration()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleWorkbookSnapshot foreignHeader = ReplaceMainRow(
            legacy,
            SetCell(legacy.Sheets[0].Rows[0], 21, "Foreign owner")
        );
        using TestDirectory headerTemp = new();
        using CatalogueStore headerStore = CatalogueStore.Open(Path.Combine(headerTemp.Path, "catalogue.db"));

        WorkbookInspection headerInspection = GoogleWorkbookProfile.Inspect(foreignHeader, headerStore);

        Assert.IsTrue(headerInspection.Conflicts.Any(conflict => conflict.Code == "owned-range-conflict"));
        Assert.AreEqual(0, headerStore.GetItems(includeArchived: true).Count);

        GoogleWorkbookSnapshot stableHeader = ReplaceMainRow(
            legacy,
            SetCell(legacy.Sheets[0].Rows[0], 21, "OFEnhancer ID")
        );
        GoogleWorkbookSnapshot foreignStableId = ReplaceMainRow(
            stableHeader,
            SetCell(stableHeader.Sheets[0].Rows[1], 21, "22222222-2222-4222-8222-222222222222")
        );
        using TestDirectory rowTemp = new();
        using CatalogueStore rowStore = CatalogueStore.Open(Path.Combine(rowTemp.Path, "catalogue.db"));

        WorkbookInspection rowInspection = GoogleWorkbookProfile.Inspect(foreignStableId, rowStore);

        Assert.IsTrue(rowInspection.Conflicts.Any(conflict => conflict.Code == "stable-id-conflict"));
    }

    [DataTestMethod]
    [DataRow(22, "https://www.pornhub.com/view_video.php?viewkey=foreign-paid", "V2")]
    [DataRow(23, "https://www.clips4sale.com/studio/123/456/foreign", "W2")]
    [DataRow(24, "2026-09-04T12:00:00.0000000+00:00", "X2")]
    public void MissingTechnicalHeaderNeverClaimsNonEmptyCells(
        int column,
        string foreignValue,
        string expectedTarget
    )
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleWorkbookSnapshot foreignCell = ReplaceMainRow(
            legacy,
            SetCell(legacy.Sheets[0].Rows[1], column, foreignValue)
        );
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(foreignCell, store);

        CollectionAssert.Contains(
            inspection.Conflicts.ToArray(),
            new WorkbookConflict("owned-range-conflict", expectedTarget)
        );
        Assert.IsFalse(inspection.MigrationPlan.Operations.Any(operation =>
            operation.Kind is "set-headers" or "configure-technical-columns"));
        Assert.AreEqual(0, store.GetItems(includeArchived: true).Count);
    }

    [TestMethod]
    public void EmptyMissingTechnicalColumnsRemainAnAdditiveMigration()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(LegacySnapshot(), store);

        Assert.AreEqual(0, inspection.Conflicts.Count);
        SingleOperation(inspection, "set-headers", "'2026 Video Catalogue'!U1:X1");
        Assert.IsTrue(inspection.MigrationPlan.Operations.Any(operation =>
            operation.Kind == "configure-technical-columns"));
    }

    [TestMethod]
    public void MissingTechnicalHeaderFindsForeignCellOutsideCatalogueRows()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        GoogleSheetSnapshot main = legacy.Sheets[0];
        GoogleWorkbookRowSnapshot technicalOnly = SetCell(
            new GoogleWorkbookRowSnapshot(25, []),
            22,
            "foreign"
        );
        GoogleWorkbookSnapshot foreignCell = legacy with
        {
            Sheets =
            [
                main with { Rows = [.. main.Rows, technicalOnly] },
                .. legacy.Sheets.Skip(1),
            ],
        };
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(foreignCell, store);

        CollectionAssert.Contains(
            inspection.Conflicts.ToArray(),
            new WorkbookConflict("owned-range-conflict", "V25")
        );
        Assert.IsFalse(inspection.MigrationPlan.Operations.Any(operation =>
            operation.Kind is "set-headers" or "configure-technical-columns"));
    }

    [TestMethod]
    public void MissingCompanionTabsAndTechnicalFieldsProduceExactAdditiveOperations()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(LegacySnapshot(), store);

        WorkbookMigrationOperation publications = SingleOperation(inspection, "create-companion", "_Publications");
        CollectionAssert.AreEqual(
            new[] { "Item ID", "Platform", "Publication URL", "Published UTC", "Operation ID", "Schema v1" },
            publications.Values.ToArray()
        );
        WorkbookMigrationOperation assets = SingleOperation(inspection, "create-companion", "_Assets");
        CollectionAssert.AreEqual(
            new[] { "Item ID", "Asset ID", "Role", "Fingerprint", "Verified UTC", "Schema v1" },
            assets.Values.ToArray()
        );
        WorkbookMigrationOperation audit = SingleOperation(inspection, "create-companion", "_Audit");
        CollectionAssert.AreEqual(
            new[] { "Operation ID", "Occurred UTC", "Item ID", "Action", "Outcome", "Details", "Schema v1" },
            audit.Values.ToArray()
        );
        WorkbookMigrationOperation headers = SingleOperation(inspection, "set-headers", "'2026 Video Catalogue'!U1:X1");
        CollectionAssert.AreEqual(
            new[] { "OFEnhancer ID", "Pornhub Paid", "Clips4Sale", "Last verified sync" },
            headers.Values.ToArray()
        );
        Assert.AreEqual(1, inspection.MigrationPlan.Operations.Count(operation => operation.Kind == "add-metadata"));
        Assert.AreEqual(2, inspection.MigrationPlan.Operations.Count(operation => operation.Kind == "set-stable-id"));
        Assert.IsTrue(inspection.MigrationPlan.Operations.Any(operation => operation.Kind == "configure-technical-columns"));
    }

    [TestMethod]
    public void AlreadyMigratedWorkbookProducesNoOperations()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        WorkbookInspection first = GoogleWorkbookProfile.Inspect(legacy, store);
        GoogleWorkbookSnapshot migrated = FullyMigrated(legacy, first.Bindings);

        WorkbookInspection second = GoogleWorkbookProfile.Inspect(migrated, store);

        Assert.IsTrue(second.AlreadyMigrated);
        Assert.AreEqual(0, second.Conflicts.Count);
        Assert.AreEqual(0, second.MigrationPlan.Operations.Count);
    }

    [TestMethod]
    public void TechnicalHeadersWithoutHiddenGroupedColumnsStillRequireConfiguration()
    {
        GoogleWorkbookSnapshot legacy = LegacySnapshot();
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        WorkbookInspection first = GoogleWorkbookProfile.Inspect(legacy, store);
        GoogleWorkbookSnapshot migrated = FullyMigrated(legacy, first.Bindings);
        GoogleSheetSnapshot unprotectedMain = migrated.Sheets[0] with
        {
            HiddenColumnIndexes = new HashSet<int>(),
            ColumnGroups = [],
        };
        migrated = migrated with { Sheets = [unprotectedMain, .. migrated.Sheets.Skip(1)] };

        WorkbookInspection inspection = GoogleWorkbookProfile.Inspect(migrated, store);

        Assert.IsFalse(inspection.AlreadyMigrated);
        Assert.AreEqual(
            1,
            inspection.MigrationPlan.Operations.Count(operation => operation.Kind == "configure-technical-columns")
        );
    }

    [TestMethod]
    public void PlanHashDoesNotDependOnGoogleJsonPropertyOrder()
    {
        string originalJson = FixtureText("google-workbook-legacy.json");
        JsonNode original = JsonNode.Parse(originalJson)!;
        string reorderedJson = ReverseObjectProperties(original).ToJsonString();
        GoogleWorkbookSnapshot firstSnapshot = GoogleWorkbookSnapshot.Parse(Encoding.UTF8.GetBytes(originalJson));
        GoogleWorkbookSnapshot secondSnapshot = GoogleWorkbookSnapshot.Parse(Encoding.UTF8.GetBytes(reorderedJson));
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection first = GoogleWorkbookProfile.Inspect(firstSnapshot, store);
        WorkbookInspection second = GoogleWorkbookProfile.Inspect(secondSnapshot, store);

        Assert.AreEqual(first.PlanHash, second.PlanHash);
        CollectionAssert.AreEqual(first.MigrationPlan.Operations.ToArray(), second.MigrationPlan.Operations.ToArray());
    }

    [TestMethod]
    public void PlanHashChangesWhenTheInspectedWorkbookProjectionChanges()
    {
        GoogleWorkbookSnapshot original = LegacySnapshot();
        GoogleWorkbookSnapshot changed = ReplaceMainRow(
            original,
            SetCell(original.Sheets[0].Rows[1], 3, "Resident Evil Ashley revised")
        );
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        WorkbookInspection first = GoogleWorkbookProfile.Inspect(original, store);
        WorkbookInspection second = GoogleWorkbookProfile.Inspect(changed, store);

        Assert.AreNotEqual(first.PlanHash, second.PlanHash);
    }

    private static WorkbookMigrationOperation SingleOperation(WorkbookInspection inspection, string kind, string target) =>
        inspection.MigrationPlan.Operations.Single(operation => operation.Kind == kind && operation.Target == target);

    private static GoogleWorkbookSnapshot FullyMigrated(
        GoogleWorkbookSnapshot legacy,
        IReadOnlyList<GoogleRowBinding> bindings
    )
    {
        GoogleSheetSnapshot main = legacy.Sheets[0];
        GoogleWorkbookRowSnapshot header = main.Rows[0];
        string[] technicalHeaders = ["OFEnhancer ID", "Pornhub Paid", "Clips4Sale", "Last verified sync"];
        for (int column = 21; column <= 24; column++)
            header = SetCell(header, column, technicalHeaders[column - 21]);

        List<GoogleWorkbookRowSnapshot> rows = [header];
        foreach (GoogleWorkbookRowSnapshot row in main.Rows.Skip(1))
        {
            string itemId = bindings.Single(binding => binding.LastObservedRow == row.RowNumber).ItemId;
            rows.Add(SetCell(row, 21, itemId));
        }

        List<GoogleDeveloperMetadataSnapshot> metadata = [.. legacy.DeveloperMetadata];
        foreach (GoogleRowBinding binding in bindings.Where(binding =>
            !metadata.Any(item => item.Value == binding.MetadataId && item.StartRowIndex + 1 == binding.LastObservedRow)))
        {
            metadata.Add(new(
                MetadataId: 8000 + binding.LastObservedRow,
                Key: "ofenhancer.item_id.v1",
                Value: binding.ItemId,
                Visibility: "DOCUMENT",
                SheetId: main.SheetId,
                Dimension: "ROWS",
                StartRowIndex: binding.LastObservedRow - 1,
                EndRowIndex: binding.LastObservedRow
            ));
        }

        return legacy with
        {
            Sheets =
            [
                main with
                {
                    Rows = rows,
                    HiddenColumnIndexes = new HashSet<int> { 20, 21, 22, 23 },
                    ColumnGroups = [new GoogleDimensionGroupSnapshot(20, 24, 1, false)],
                },
                legacy.Sheets[1],
                CompanionSheet(1001, "_Publications", ["Item ID", "Platform", "Publication URL", "Published UTC", "Operation ID", "Schema v1"]),
                CompanionSheet(1002, "_Assets", ["Item ID", "Asset ID", "Role", "Fingerprint", "Verified UTC", "Schema v1"]),
                CompanionSheet(1003, "_Audit", ["Operation ID", "Occurred UTC", "Item ID", "Action", "Outcome", "Details", "Schema v1"]),
            ],
            DeveloperMetadata = metadata,
        };
    }

    private static GoogleSheetSnapshot CompanionSheet(int sheetId, string title, string[] headers) =>
        new(
            SheetId: sheetId,
            Title: title,
            Hidden: true,
            RowCount: 1000,
            ColumnCount: headers.Length,
            Rows: [new GoogleWorkbookRowSnapshot(1, headers.Select(value => new GoogleWorkbookCellSnapshot(value, null)).ToArray())]
        );

    private static GoogleWorkbookSnapshot ReplaceMainRow(
        GoogleWorkbookSnapshot snapshot,
        GoogleWorkbookRowSnapshot replacement
    )
    {
        GoogleSheetSnapshot main = snapshot.Sheets[0];
        return snapshot with
        {
            Sheets =
            [
                main with
                {
                    Rows = main.Rows.Select(row => row.RowNumber == replacement.RowNumber ? replacement : row).ToArray(),
                },
                .. snapshot.Sheets.Skip(1),
            ]
        };
    }

    private static GoogleWorkbookRowSnapshot SetCell(
        GoogleWorkbookRowSnapshot row,
        int oneBasedColumn,
        string? value
    )
    {
        List<GoogleWorkbookCellSnapshot> cells = [.. row.Cells];
        while (cells.Count < oneBasedColumn)
            cells.Add(new(null, null));
        cells[oneBasedColumn - 1] = new(value, null);
        return row with { Cells = cells };
    }

    private static GoogleWorkbookSnapshot LegacySnapshot() =>
        GoogleWorkbookSnapshot.Parse(Encoding.UTF8.GetBytes(FixtureText("google-workbook-legacy.json")));

    private static GoogleWorkbookSnapshot AmbiguousSnapshot() =>
        GoogleWorkbookSnapshot.Parse(Encoding.UTF8.GetBytes(FixtureText("google-workbook-ambiguous.json")));

    private static string FixtureText(string fileName) => File.ReadAllText(
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "Fixtures", fileName))
    );

    private static string LocalCatalogueSnapshot(string sourceKey) =>
        System.Text.Json.JsonSerializer.Serialize(new
        {
            version = 1,
            items = new[]
            {
                new
                {
                    sourceKey,
                    sourceRow = 42,
                    title = "Existing Ashley",
                    description = "Existing description",
                    plannedDate = "2026-09-11",
                    series = "Resident Evil",
                    episode = "04",
                    xTeasers = 0,
                    redditTeasers = 0,
                    platformLinks = new Dictionary<string, string>(),
                },
            },
        });

    private static JsonNode ReverseObjectProperties(JsonNode node)
    {
        if (node is JsonObject valueObject)
        {
            JsonObject reversed = [];
            foreach ((string key, JsonNode? value) in valueObject.Reverse())
                reversed.Add(key, value is null ? null : ReverseObjectProperties(value));
            return reversed;
        }
        if (node is JsonArray valueArray)
        {
            JsonArray reversedChildren = [];
            foreach (JsonNode? value in valueArray)
                reversedChildren.Add(value is null ? null : ReverseObjectProperties(value));
            return reversedChildren;
        }
        return node.DeepClone();
    }

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-profile-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
