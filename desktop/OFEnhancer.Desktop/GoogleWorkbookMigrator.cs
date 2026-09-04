using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed class GoogleWorkbookMigrator
{
    private const string ItemMetadataKey = "ofenhancer.item_id.v1";

    private readonly string _workbookId;
    private readonly GoogleWorkspaceClient _workspace;
    private readonly CatalogueStore _store;
    private readonly Func<int> _newSheetId;
    private readonly Func<DateTimeOffset> _utcNow;

    internal GoogleWorkbookMigrator(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store
    ) : this(
        workbookId,
        workspace,
        store,
        static () => RandomNumberGenerator.GetInt32(1, int.MaxValue),
        static () => DateTimeOffset.UtcNow
    )
    {
    }

    internal GoogleWorkbookMigrator(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store,
        Func<int> newSheetId
    ) : this(workbookId, workspace, store, newSheetId, static () => DateTimeOffset.UtcNow)
    {
    }

    internal GoogleWorkbookMigrator(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store,
        Func<int> newSheetId,
        Func<DateTimeOffset> utcNow
    )
    {
        _workbookId = RequiredWorkbookId(workbookId);
        _workspace = workspace ?? throw new ArgumentNullException(nameof(workspace));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _newSheetId = newSheetId ?? throw new ArgumentNullException(nameof(newSheetId));
        _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
    }

    internal async Task<WorkbookMigrationResult> ApplyAsync(
        string expectedPlanHash,
        CancellationToken cancellationToken
    )
    {
        (GoogleWorkbookSnapshot snapshot, WorkbookInspection inspection) =
            await ReadInspectionAsync(cancellationToken).ConfigureAwait(false);
        bool hasExpectedReceipt = inspection.MigrationReceipts.Any(receipt =>
            string.Equals(receipt.PlanHash, expectedPlanHash, StringComparison.Ordinal));
        if (!PlanHashMatches(expectedPlanHash, inspection.PlanHash))
        {
            if (CanReplay(inspection, expectedPlanHash))
            {
                inspection = PersistVerifiedInspection(inspection);
                return new("already-migrated", inspection);
            }
            if (hasExpectedReceipt)
                return new("unresolved", inspection);
            throw new GoogleCatalogueException("stale-migration-plan");
        }
        if (inspection.Conflicts.Count > 0)
            throw new GoogleCatalogueException("workbook-migration-conflict");
        if (inspection.AlreadyMigrated)
        {
            inspection = PersistVerifiedInspection(inspection);
            return new("already-migrated", inspection);
        }
        if (hasExpectedReceipt)
            return new("unresolved", inspection);

        WorkbookMigrationReceipt intendedReceipt = new(
            GoogleWorkbookContract.ReceiptOperationId(
                inspection.PlanHash,
                inspection.MigrationIdentityFingerprint
            ),
            inspection.PlanHash,
            inspection.MigrationIdentityFingerprint,
            0
        );
        GoogleStructuralBatch batch = BuildBatch(
            snapshot,
            inspection.MigrationPlan,
            intendedReceipt,
            _utcNow().ToUniversalTime()
        );
        try
        {
            await _workspace.ApplyStructuralBatchAsync(batch, cancellationToken).ConfigureAwait(false);
        }
        catch (GoogleMutationUncertainException)
        {
            return await ReconcileAsync(inspection, intendedReceipt, "reconciled", cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return new("unresolved", null);
        }
        return await ReconcileAsync(inspection, intendedReceipt, "applied", cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<WorkbookMigrationResult> ReconcileAsync(
        WorkbookInspection intended,
        WorkbookMigrationReceipt intendedReceipt,
        string verifiedStatus,
        CancellationToken cancellationToken
    )
    {
        try
        {
            (_, WorkbookInspection readback) = await ReadInspectionAsync(cancellationToken).ConfigureAwait(false);
            if (!IsCompleteReadback(intended, intendedReceipt, readback))
                return new("unresolved", readback);
            readback = PersistVerifiedInspection(readback);
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

    private WorkbookInspection PersistVerifiedInspection(WorkbookInspection inspection)
    {
        _store.ImportWorkbookProjection(inspection.Projection);
        DateTimeOffset verifiedUtc = _utcNow().ToUniversalTime();
        GoogleRowBinding[] bindings = inspection.Bindings
            .Select(binding => binding with { VerifiedUtc = verifiedUtc })
            .ToArray();
        _store.ReplaceGoogleBindings(
            _workbookId,
            bindings
        );
        return inspection with { Bindings = bindings };
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
        WorkbookMigrationPlan plan,
        WorkbookMigrationReceipt receipt,
        DateTimeOffset occurredUtc
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
        IReadOnlyList<string> receiptValues = ReceiptValues(receipt, occurredUtc);
        bool receiptWritten = false;
        WorkbookMigrationOperation[] stableIdOperations = plan.Operations
            .Where(operation => string.Equals(operation.Kind, "set-stable-id", StringComparison.Ordinal))
            .ToArray();
        bool stableIdsWritten = false;
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
                    receiptWritten |= AddCompanionRequests(
                        requests,
                        operation,
                        snapshot,
                        usedSheetIds,
                        receiptValues
                    );
                    break;
                case "hide-companion":
                    AddHideCompanionRequest(requests, operation, snapshot);
                    break;
                case "set-headers":
                    AddHeaderRequest(requests, operation, plan);
                    break;
                case "set-stable-id":
                    if (!stableIdsWritten)
                    {
                        AddStableIdRequests(requests, stableIdOperations, plan);
                        stableIdsWritten = true;
                    }
                    break;
                default:
                    throw new GoogleCatalogueException("invalid-migration-plan");
            }
        }
        if (!receiptWritten)
            AddReceiptToExistingAudit(requests, snapshot, receiptValues);
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

    private bool AddCompanionRequests(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        GoogleWorkbookSnapshot snapshot,
        ISet<int> usedSheetIds,
        IReadOnlyList<string> receiptValues
    )
    {
        if (operation.RowNumber is not null
            || !GoogleWorkbookContract.CompanionHeaders.TryGetValue(operation.Target, out string[]? expectedHeaders)
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
        bool isAudit = string.Equals(
            operation.Target,
            GoogleWorkbookContract.AuditTitle,
            StringComparison.Ordinal
        );
        requests.Add(UpdateCellsRows(
            sheetId,
            0,
            0,
            isAudit ? [expectedHeaders, receiptValues] : [expectedHeaders]
        ));
        return isAudit;
    }

    private static void AddHideCompanionRequest(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        GoogleWorkbookSnapshot snapshot
    )
    {
        if (operation.RowNumber is not null
            || operation.Values.Count != 0
            || !GoogleWorkbookContract.CompanionHeaders.ContainsKey(operation.Target))
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

    private static void AddReceiptToExistingAudit(
        ICollection<JsonElement> requests,
        GoogleWorkbookSnapshot snapshot,
        IReadOnlyList<string> receiptValues
    )
    {
        GoogleSheetSnapshot audit = snapshot.Sheets.Single(sheet =>
            string.Equals(sheet.Title, GoogleWorkbookContract.AuditTitle, StringComparison.Ordinal)
        );
        int rowNumber = Math.Max(2, audit.Rows.Select(row => row.RowNumber).DefaultIfEmpty(1).Max() + 1);
        if (rowNumber > audit.RowCount || rowNumber > 5_002)
            throw new GoogleCatalogueException("migration-receipt-capacity");
        requests.Add(UpdateCellsRows(audit.SheetId, rowNumber - 1, 0, [receiptValues]));
    }

    private static void AddHeaderRequest(
        ICollection<JsonElement> requests,
        WorkbookMigrationOperation operation,
        WorkbookMigrationPlan plan
    )
    {
        if (operation.RowNumber != 1
            || !operation.Values.SequenceEqual(GoogleWorkbookContract.TechnicalHeaders, StringComparer.Ordinal)
            || !string.Equals(
                operation.Target,
                $"'{EscapeSheetTitle(plan.SheetTitle)}'!U1:X1",
                StringComparison.Ordinal
            ))
        {
            throw new GoogleCatalogueException("invalid-migration-plan");
        }
        requests.Add(UpdateCells(plan.SheetId, 0, 20, GoogleWorkbookContract.TechnicalHeaders));
    }

    private static void AddStableIdRequests(
        ICollection<JsonElement> requests,
        IReadOnlyList<WorkbookMigrationOperation> operations,
        WorkbookMigrationPlan plan
    )
    {
        List<(int Row, string ItemId)> values = [];
        HashSet<int> rows = [];
        foreach (WorkbookMigrationOperation operation in operations)
        {
            int row = RequiredRow(operation);
            if (operation.Values.Count != 1
                || !rows.Add(row)
                || !string.Equals(
                    operation.Target,
                    $"'{EscapeSheetTitle(plan.SheetTitle)}'!U{row}",
                    StringComparison.Ordinal
                ))
            {
                throw new GoogleCatalogueException("invalid-migration-plan");
            }
            values.Add((row, RequiredItemId(operation.Values[0])));
        }

        foreach (IGrouping<int, (int Row, string ItemId)> run in values
            .OrderBy(value => value.Row)
            .Select((value, index) => (value, index))
            .GroupBy(entry => entry.value.Row - entry.index, entry => entry.value))
        {
            (int Row, string ItemId)[] contiguous = run.ToArray();
            requests.Add(UpdateCellsRows(
                plan.SheetId,
                contiguous[0].Row - 1,
                20,
                contiguous.Select(value => (IReadOnlyList<string>)[value.ItemId]).ToArray()
            ));
        }
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
    ) => UpdateCellsRows(sheetId, rowIndex, columnIndex, [values]);

    private static JsonElement UpdateCellsRows(
        int sheetId,
        int rowIndex,
        int columnIndex,
        IReadOnlyList<IReadOnlyList<string>> rows
    ) => JsonSerializer.SerializeToElement(new
    {
        updateCells = new
        {
            start = new { sheetId, rowIndex, columnIndex },
            rows = rows.Select(values => new
            {
                values = values.Select(value => new
                {
                    userEnteredValue = new { stringValue = value },
                }).ToArray(),
            }).ToArray(),
            fields = "userEnteredValue",
        },
    });

    private static IReadOnlyList<string> ReceiptValues(
        WorkbookMigrationReceipt receipt,
        DateTimeOffset occurredUtc
    ) =>
    [
        receipt.OperationId,
        occurredUtc.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
        string.Empty,
        GoogleWorkbookContract.MigrationAction,
        GoogleWorkbookContract.MigrationOutcome,
        GoogleWorkbookContract.ReceiptDetails(receipt.PlanHash, receipt.IdentityHash),
        GoogleWorkbookContract.SchemaVersion,
    ];

    private static object ColumnRange(int sheetId) => new
    {
        sheetId,
        dimension = "COLUMNS",
        startIndex = 20,
        endIndex = 24,
    };

    private static bool CanReplay(WorkbookInspection inspection, string expectedPlanHash) =>
        inspection.Conflicts.Count == 0
        && inspection.AlreadyMigrated
        && inspection.MigrationIdentityFingerprint.Length == 64
        && inspection.MigrationReceipts.Any(receipt =>
            string.Equals(receipt.PlanHash, expectedPlanHash, StringComparison.Ordinal)
            && string.Equals(
                receipt.IdentityHash,
                inspection.MigrationIdentityFingerprint,
                StringComparison.Ordinal
            ));

    private static bool IsCompleteReadback(
        WorkbookInspection intended,
        WorkbookMigrationReceipt intendedReceipt,
        WorkbookInspection readback
    ) =>
        readback.Conflicts.Count == 0
        && readback.AlreadyMigrated
        && readback.MigrationPlan.Operations.Count == 0
        && intended.MigrationIdentityFingerprint.Length == 64
        && string.Equals(
            readback.MigrationIdentityFingerprint,
            intended.MigrationIdentityFingerprint,
            StringComparison.Ordinal
        )
        && string.Equals(readback.Projection.WorkbookId, intended.Projection.WorkbookId, StringComparison.Ordinal)
        && readback.CatalogueSheetId == intended.CatalogueSheetId
        && string.Equals(readback.CatalogueSheetTitle, intended.CatalogueSheetTitle, StringComparison.Ordinal)
        && readback.Bindings.Count == readback.Projection.Items.Count
        && readback.MigrationReceipts.Any(receipt =>
            string.Equals(receipt.OperationId, intendedReceipt.OperationId, StringComparison.Ordinal)
            && string.Equals(receipt.PlanHash, intendedReceipt.PlanHash, StringComparison.Ordinal)
            && string.Equals(receipt.IdentityHash, intendedReceipt.IdentityHash, StringComparison.Ordinal));

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
        GoogleWorkbookContract.IsSha256(expected)
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
