using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed class GoogleWorkbookMigrator
{
    private const string ItemMetadataKey = "ofenhancer.item_id.v1";
    private static readonly string[] TechnicalHeaders =
        ["OFEnhancer ID", "Pornhub Paid", "Clips4Sale", "Last verified sync"];
    private static readonly IReadOnlyDictionary<string, string[]> CompanionHeaders =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["_Assets"] = ["Item ID", "Asset ID", "Role", "Fingerprint", "Verified UTC", "Schema v1"],
            ["_Audit"] = ["Operation ID", "Occurred UTC", "Item ID", "Action", "Outcome", "Details", "Schema v1"],
            ["_Publications"] = ["Item ID", "Platform", "Publication URL", "Published UTC", "Operation ID", "Schema v1"],
        };

    private readonly string _workbookId;
    private readonly GoogleWorkspaceClient _workspace;
    private readonly CatalogueStore _store;
    private readonly Func<int> _newSheetId;

    internal GoogleWorkbookMigrator(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store
    ) : this(
        workbookId,
        workspace,
        store,
        static () => RandomNumberGenerator.GetInt32(1, int.MaxValue)
    )
    {
    }

    internal GoogleWorkbookMigrator(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store,
        Func<int> newSheetId
    )
    {
        _workbookId = RequiredWorkbookId(workbookId);
        _workspace = workspace ?? throw new ArgumentNullException(nameof(workspace));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _newSheetId = newSheetId ?? throw new ArgumentNullException(nameof(newSheetId));
    }

    internal async Task<WorkbookMigrationResult> ApplyAsync(
        string expectedPlanHash,
        CancellationToken cancellationToken
    )
    {
        (GoogleWorkbookSnapshot snapshot, WorkbookInspection inspection) =
            await ReadInspectionAsync(cancellationToken).ConfigureAwait(false);
        if (!PlanHashMatches(expectedPlanHash, inspection.PlanHash))
            throw new GoogleCatalogueException("stale-migration-plan");
        if (inspection.Conflicts.Count > 0)
            throw new GoogleCatalogueException("workbook-migration-conflict");
        if (inspection.AlreadyMigrated)
        {
            _store.ReplaceGoogleBindings(_workbookId, inspection.Bindings);
            return new("already-migrated", inspection);
        }

        GoogleStructuralBatch batch = BuildBatch(snapshot, inspection.MigrationPlan);
        try
        {
            await _workspace.ApplyStructuralBatchAsync(batch, cancellationToken).ConfigureAwait(false);
        }
        catch (GoogleMutationUncertainException)
        {
            return await ReconcileAsync(inspection, "reconciled", cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return new("unresolved", null);
        }
        return await ReconcileAsync(inspection, "applied", cancellationToken).ConfigureAwait(false);
    }

    private async Task<WorkbookMigrationResult> ReconcileAsync(
        WorkbookInspection intended,
        string verifiedStatus,
        CancellationToken cancellationToken
    )
    {
        try
        {
            (_, WorkbookInspection readback) = await ReadInspectionAsync(cancellationToken).ConfigureAwait(false);
            if (!IsCompleteReadback(intended, readback))
                return new("unresolved", readback);
            _store.ReplaceGoogleBindings(_workbookId, readback.Bindings);
            return new(verifiedStatus, readback);
        }
        catch (GoogleCatalogueException)
        {
            return new("unresolved", null);
        }
        catch (OperationCanceledException)
        {
            return new("unresolved", null);
        }
    }

    private async Task<(GoogleWorkbookSnapshot Snapshot, WorkbookInspection Inspection)> ReadInspectionAsync(
        CancellationToken cancellationToken
    )
    {
        GoogleWorkbookSnapshot snapshot = await _workspace.ReadWorkbookAsync(_workbookId, cancellationToken)
            .ConfigureAwait(false);
        return (snapshot, GoogleWorkbookProfile.Inspect(snapshot, _store));
    }

    private GoogleStructuralBatch BuildBatch(
        GoogleWorkbookSnapshot snapshot,
        WorkbookMigrationPlan plan
    )
    {
        if (!string.Equals(plan.WorkbookId, _workbookId, StringComparison.Ordinal)
            || plan.SheetId < 0
            || snapshot.Sheets.All(sheet => sheet.SheetId != plan.SheetId))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }

        HashSet<int> usedSheetIds = snapshot.Sheets.Select(sheet => sheet.SheetId).ToHashSet();
        List<JsonElement> requests = [];
        foreach (WorkbookMigrationOperation operation in plan.Operations)
        {
            switch (operation.Kind)
            {
                case "add-metadata":
                    AddMetadataRequest(requests, operation, plan);
                    break;
                case "configure-technical-columns":
                    AddTechnicalColumnRequests(requests, operation, snapshot, plan);
                    break;
                case "create-companion":
                    AddCompanionRequests(requests, operation, snapshot, usedSheetIds);
                    break;
                case "hide-companion":
                    AddHideCompanionRequest(requests, operation, snapshot);
                    break;
                case "set-headers":
                    AddHeaderRequest(requests, operation, plan);
                    break;
                case "set-stable-id":
                    AddStableIdRequest(requests, operation, plan);
                    break;
                default:
                    throw new GoogleCatalogueException("invalid-migration-plan");
            }
        }
        if (requests.Count == 0)
            throw new GoogleCatalogueException("invalid-migration-plan");
        return new(_workbookId, requests);
    }

    private static void AddMetadataRequest(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        WorkbookMigrationPlan plan
    )
    {
        int row = RequiredRow(operation);
        if (operation.Values.Count != 2
            || !string.Equals(operation.Values[0], ItemMetadataKey, StringComparison.Ordinal)
            || !string.Equals(operation.Target, $"{plan.SheetId}:{row}", StringComparison.Ordinal))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        string itemId = RequiredItemId(operation.Values[1]);
        requests.Add(JsonSerializer.SerializeToElement(new
        {
            createDeveloperMetadata = new
            {
                developerMetadata = new
                {
                    metadataKey = ItemMetadataKey,
                    metadataValue = itemId,
                    visibility = "DOCUMENT",
                    location = new
                    {
                        dimensionRange = new
                        {
                            sheetId = plan.SheetId,
                            dimension = "ROWS",
                            startIndex = row - 1,
                            endIndex = row,
                        },
                    },
                },
            },
        }));
    }

    private static void AddTechnicalColumnRequests(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        GoogleWorkbookSnapshot snapshot,
        WorkbookMigrationPlan plan
    )
    {
        if (operation.RowNumber is not null
            || operation.Values.Count != 0
            || !string.Equals(operation.Target, $"{plan.SheetId}:U:X", StringComparison.Ordinal))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        GoogleSheetSnapshot sheet = snapshot.Sheets.Single(candidate => candidate.SheetId == plan.SheetId);
        if (sheet.HiddenColumnIndexes is null || !Enumerable.Range(20, 4).All(sheet.HiddenColumnIndexes.Contains))
        {
            requests.Add(JsonSerializer.SerializeToElement(new
            {
                updateDimensionProperties = new
                {
                    range = ColumnRange(plan.SheetId),
                    properties = new { hiddenByUser = true },
                    fields = "hiddenByUser",
                },
            }));
        }
        if (sheet.ColumnGroups is null
            || !sheet.ColumnGroups.Any(group => group.StartIndex == 20 && group.EndIndex == 24))
        {
            requests.Add(JsonSerializer.SerializeToElement(new
            {
                addDimensionGroup = new { range = ColumnRange(plan.SheetId) },
            }));
        }
    }

    private void AddCompanionRequests(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        GoogleWorkbookSnapshot snapshot,
        ISet<int> usedSheetIds
    )
    {
        if (operation.RowNumber is not null
            || !CompanionHeaders.TryGetValue(operation.Target, out string[]? expectedHeaders)
            || !operation.Values.SequenceEqual(expectedHeaders, StringComparer.Ordinal)
            || snapshot.Sheets.Any(sheet => string.Equals(sheet.Title, operation.Target, StringComparison.Ordinal)))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        int sheetId = NextSheetId(usedSheetIds);
        requests.Add(JsonSerializer.SerializeToElement(new
        {
            addSheet = new
            {
                properties = new
                {
                    sheetId,
                    title = operation.Target,
                    hidden = true,
                    gridProperties = new { rowCount = 1_000, columnCount = expectedHeaders.Length },
                },
            },
        }));
        requests.Add(UpdateCells(sheetId, 0, 0, expectedHeaders));
    }

    private static void AddHideCompanionRequest(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        GoogleWorkbookSnapshot snapshot
    )
    {
        if (operation.RowNumber is not null
            || operation.Values.Count != 0
            || !CompanionHeaders.ContainsKey(operation.Target))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        GoogleSheetSnapshot sheet = snapshot.Sheets.Single(candidate =>
            string.Equals(candidate.Title, operation.Target, StringComparison.Ordinal));
        requests.Add(JsonSerializer.SerializeToElement(new
        {
            updateSheetProperties = new
            {
                properties = new { sheetId = sheet.SheetId, hidden = true },
                fields = "hidden",
            },
        }));
    }

    private static void AddHeaderRequest(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        WorkbookMigrationPlan plan
    )
    {
        if (operation.RowNumber != 1
            || !operation.Values.SequenceEqual(TechnicalHeaders, StringComparer.Ordinal)
            || !string.Equals(
                operation.Target,
                $"'{EscapeSheetTitle(plan.SheetTitle)}'!U1:X1",
                StringComparison.Ordinal
            ))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        requests.Add(UpdateCells(plan.SheetId, 0, 20, TechnicalHeaders));
    }

    private static void AddStableIdRequest(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        WorkbookMigrationPlan plan
    )
    {
        int row = RequiredRow(operation);
        if (operation.Values.Count != 1
            || !string.Equals(
                operation.Target,
                $"'{EscapeSheetTitle(plan.SheetTitle)}'!U{row}",
                StringComparison.Ordinal
            ))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        string itemId = RequiredItemId(operation.Values[0]);
        requests.Add(UpdateCells(plan.SheetId, row - 1, 20, [itemId]));
    }

    private int NextSheetId(ISet<int> usedSheetIds)
    {
        for (int attempt = 0; attempt < 1_024; attempt++)
        {
            int candidate = _newSheetId();
            if (candidate > 0 && usedSheetIds.Add(candidate))
                return candidate;
        }
        throw new GoogleCatalogueException("companion-sheet-id-unavailable");
    }

    private static JsonElement UpdateCells(
        int sheetId,
        int rowIndex,
        int columnIndex,
        IReadOnlyList<string> values
    ) => JsonSerializer.SerializeToElement(new
    {
        updateCells = new
        {
            start = new { sheetId, rowIndex, columnIndex },
            rows = new[]
            {
                new
                {
                    values = values.Select(value => new
                    {
                        userEnteredValue = new { stringValue = value },
                    }).ToArray(),
                },
            },
            fields = "userEnteredValue",
        },
    });

    private static object ColumnRange(int sheetId) => new
    {
        sheetId,
        dimension = "COLUMNS",
        startIndex = 20,
        endIndex = 24,
    };

    private static bool IsCompleteReadback(WorkbookInspection intended, WorkbookInspection readback) =>
        readback.Conflicts.Count == 0
        && readback.AlreadyMigrated
        && readback.MigrationPlan.Operations.Count == 0
        && string.Equals(readback.Projection.WorkbookId, intended.Projection.WorkbookId, StringComparison.Ordinal)
        && readback.CatalogueSheetId == intended.CatalogueSheetId
        && string.Equals(readback.CatalogueSheetTitle, intended.CatalogueSheetTitle, StringComparison.Ordinal)
        && readback.Bindings.Count == readback.Projection.Items.Count;

    private static int RequiredRow(WorkbookMigrationOperation operation)
    {
        if (operation.RowNumber is not int row || row <= 1 || row > 1_000_000)
            throw new GoogleCatalogueException("invalid-migration-plan");
        return row;
    }

    private static string RequiredItemId(string? value)
    {
        if (!Guid.TryParse(value, out Guid parsed))
            throw new GoogleCatalogueException("invalid-migration-plan");
        return parsed.ToString("D");
    }

    private static bool PlanHashMatches(string? expected, string actual) =>
        expected is not null
        && expected.Length == 64
        && expected.All(character => char.IsAsciiHexDigit(character) && !char.IsUpper(character))
        && string.Equals(expected, actual, StringComparison.Ordinal);

    private static string RequiredWorkbookId(string? value)
    {
        string normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length is 0 or > 256 || normalized.Any(char.IsControl))
            throw new ArgumentException("Workbook ID is invalid.", nameof(value));
        return normalized;
    }

    private static string EscapeSheetTitle(string title) => title.Replace("'", "''", StringComparison.Ordinal);
}

internal sealed record WorkbookMigrationResult(string Status, WorkbookInspection? Inspection);
