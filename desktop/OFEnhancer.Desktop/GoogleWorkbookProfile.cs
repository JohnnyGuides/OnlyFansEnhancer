using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal static class GoogleWorkbookProfile
{
    internal const string PreferredCatalogueTitle = "2026 Video Catalogue";
    internal const string ItemMetadataKey = "ofenhancer.item_id.v1";
    private const int MaximumRows = 5_000;
    private static readonly IReadOnlyDictionary<int, string> LegacyHeaders = new SortedDictionary<int, string>
    {
        [1] = "ID",
        [2] = "Release Date",
        [3] = "Title",
        [4] = "Description",
        [5] = "Season/Arc",
        [6] = "Episode",
        [8] = "Pornhub Free",
        [10] = "OnlyFans",
        [11] = "Fansly",
        [12] = "ManyVids",
        [14] = "X Teaser Count",
        [15] = "X Links",
        [17] = "Reddit Unique Teaser Count",
        [18] = "Reddit Links",
    };
    private static readonly string[] TechnicalHeaders =
        ["OFEnhancer ID", "Pornhub Paid", "Clips4Sale", "Last verified sync"];
    private static readonly IReadOnlyDictionary<string, string[]> CompanionHeaders =
        new SortedDictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["_Publications"] = ["Item ID", "Platform", "Publication URL", "Published UTC", "Operation ID", "Schema v1"],
            ["_Assets"] = ["Item ID", "Asset ID", "Role", "Fingerprint", "Verified UTC", "Schema v1"],
            ["_Audit"] = ["Operation ID", "Occurred UTC", "Item ID", "Action", "Outcome", "Details", "Schema v1"],
        };

    internal static string ColumnForDestination(string destination) => destination switch
    {
        "pornhubFree" => "H",
        "onlyfans" => "J",
        "fansly" => "K",
        "manyvids" => "L",
        "xTeasers" => "N",
        "x" => "O",
        "redditTeasers" => "Q",
        "reddit" => "R",
        "ofenhancerId" => "U",
        "pornhubPaid" => "V",
        "clips4sale" => "W",
        "lastVerifiedSync" => "X",
        _ => throw new GoogleCatalogueException("unsupported-workbook-destination"),
    };

    internal static WorkbookInspection Inspect(GoogleWorkbookSnapshot snapshot, CatalogueStore store)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(store);

        GoogleSheetSnapshot selected = SelectCatalogueSheet(snapshot);
        GoogleWorkbookRowSnapshot header = selected.Rows.SingleOrDefault(row => row.RowNumber == 1)
            ?? throw new GoogleCatalogueException("workbook-profile-not-found");
        GoogleWorkbookRowSnapshot[] bodyRows = selected.Rows
            .Where(row => row.RowNumber > 1)
            .OrderBy(row => row.RowNumber)
            .ToArray();
        GoogleWorkbookRowSnapshot[] populatedRows = bodyRows.Where(IsPopulated).ToArray();
        if (populatedRows.Length > MaximumRows)
            throw new GoogleCatalogueException("workbook-row-limit");

        List<WorkbookConflict> conflicts = [];
        bool[] ownedTechnicalColumns = InspectTechnicalHeaders(header, bodyRows, conflicts);
        bool technicalHeadersComplete = ownedTechnicalColumns.All(owned => owned);
        InspectCompanionTabs(snapshot, conflicts);

        Dictionary<int, string> metadataByRow = ValidateItemMetadata(snapshot, selected, populatedRows, conflicts);
        WorkbookProjection projection = BuildProjection(
            snapshot.WorkbookId,
            selected,
            populatedRows,
            metadataByRow,
            ownedTechnicalColumns
        );
        InspectSourceIdentityConflicts(projection, store.GetItems(includeArchived: true), conflicts);

        List<WorkbookMigrationOperation> operations = BuildStructuralOperations(
            snapshot,
            selected,
            technicalHeadersComplete,
            TechnicalColumnsConfigured(selected),
            conflicts.All(conflict => conflict.Code != "owned-range-conflict")
        );
        if (conflicts.Count > 0)
            return CompleteInspection(selected, projection, [], conflicts, operations);

        try
        {
            store.ImportWorkbookProjection(projection);
        }
        catch (WorkbookProjectionException error) when (error.Message.Contains("Platform link", StringComparison.Ordinal))
        {
            throw new GoogleCatalogueException("invalid-workbook-link");
        }
        catch (WorkbookProjectionException)
        {
            throw new GoogleCatalogueException("invalid-workbook-projection");
        }

        projection = NormalizeProjection(projection, store.GetItems(includeArchived: true));

        GoogleRowBinding[] bindings = store.GetGoogleBindings(snapshot.WorkbookId)
            .Where(binding => string.Equals(binding.SheetId, selected.SheetId.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
            .OrderBy(binding => binding.LastObservedRow)
            .ThenBy(binding => binding.ItemId, StringComparer.Ordinal)
            .ToArray();
        if (bindings.Length != populatedRows.Length)
            throw new GoogleCatalogueException("invalid-workbook-projection");

        foreach (GoogleWorkbookRowSnapshot row in populatedRows)
        {
            GoogleRowBinding binding = bindings.Single(candidate => candidate.LastObservedRow == row.RowNumber);
            string? stableCell = ownedTechnicalColumns[0] ? Cell(row, 21) : null;
            if (stableCell is not null)
            {
                string? canonicalCell = CanonicalGuidOrNull(stableCell);
                if (canonicalCell is null || !string.Equals(canonicalCell, binding.ItemId, StringComparison.Ordinal))
                    conflicts.Add(new("stable-id-conflict", $"U{row.RowNumber}"));
            }
            if (!metadataByRow.ContainsKey(row.RowNumber))
            {
                operations.Add(new(
                    "add-metadata",
                    $"{selected.SheetId}:{row.RowNumber}",
                    row.RowNumber,
                    [ItemMetadataKey, binding.ItemId]
                ));
            }
            if (stableCell is null)
            {
                operations.Add(new(
                    "set-stable-id",
                    $"'{EscapeSheetTitle(selected.Title)}'!U{row.RowNumber}",
                    row.RowNumber,
                    [binding.ItemId]
                ));
            }
        }
        return CompleteInspection(selected, projection, bindings, conflicts, operations);
    }

    private static WorkbookProjection NormalizeProjection(
        WorkbookProjection projection,
        IReadOnlyList<CatalogueItemSummary> storedItems
    )
    {
        Dictionary<string, CatalogueItemSummary> bySource = storedItems.ToDictionary(
            item => item.SourceKey,
            StringComparer.Ordinal
        );
        WorkbookCatalogueItem[] normalized = projection.Items.Select(item =>
        {
            CatalogueItemSummary stored = bySource[item.SourceKey];
            return new WorkbookCatalogueItem(
                item.SourceRow,
                stored.SourceKey,
                stored.Title,
                stored.Description,
                stored.PlannedDate,
                stored.Series,
                stored.Episode,
                stored.XTeasers,
                stored.RedditTeasers,
                stored.PlatformLinks,
                item.MetadataId
            );
        }).ToArray();
        return projection with { Items = normalized };
    }

    private static WorkbookInspection CompleteInspection(
        GoogleSheetSnapshot selected,
        WorkbookProjection projection,
        IReadOnlyList<GoogleRowBinding> bindings,
        IReadOnlyList<WorkbookConflict> conflicts,
        IReadOnlyList<WorkbookMigrationOperation> operations
    )
    {
        WorkbookMigrationOperation[] sorted = operations
            .OrderBy(operation => operation.Kind, StringComparer.Ordinal)
            .ThenBy(operation => operation.Target, StringComparer.Ordinal)
            .ThenBy(operation => operation.RowNumber ?? -1)
            .ThenBy(operation => string.Join('\u001f', operation.Values), StringComparer.Ordinal)
            .ToArray();
        WorkbookMigrationPlan plan = new(
            projection.WorkbookId,
            selected.SheetId,
            selected.Title,
            ProjectionFingerprint(projection, selected),
            sorted
        );
        string hash = Hash(plan);
        return new(
            selected.SheetId,
            selected.Title,
            projection,
            bindings,
            conflicts.OrderBy(conflict => conflict.Code, StringComparer.Ordinal)
                .ThenBy(conflict => conflict.Target, StringComparer.Ordinal)
                .ToArray(),
            plan,
            hash,
            conflicts.Count == 0 && sorted.Length == 0
        );
    }

    private static GoogleSheetSnapshot SelectCatalogueSheet(GoogleWorkbookSnapshot snapshot)
    {
        GoogleSheetSnapshot[] credible = snapshot.Sheets.Where(MatchesLegacyProfile).ToArray();
        if (credible.Length == 0)
            throw new GoogleCatalogueException("workbook-profile-not-found");
        if (credible.Length == 1)
            return credible[0];
        GoogleSheetSnapshot[] preferred = credible
            .Where(sheet => string.Equals(sheet.Title, PreferredCatalogueTitle, StringComparison.Ordinal))
            .ToArray();
        if (preferred.Length == 1)
            return preferred[0];
        throw new GoogleCatalogueException("workbook-profile-ambiguous");
    }

    private static bool MatchesLegacyProfile(GoogleSheetSnapshot sheet)
    {
        GoogleWorkbookRowSnapshot? header = sheet.Rows.SingleOrDefault(row => row.RowNumber == 1);
        return header is not null && LegacyHeaders.All(pair =>
            string.Equals(Cell(header, pair.Key), pair.Value, StringComparison.Ordinal));
    }

    private static bool[] InspectTechnicalHeaders(
        GoogleWorkbookRowSnapshot header,
        IReadOnlyList<GoogleWorkbookRowSnapshot> rows,
        ICollection<WorkbookConflict> conflicts
    )
    {
        bool[] ownedColumns = new bool[TechnicalHeaders.Length];
        for (int offset = 0; offset < TechnicalHeaders.Length; offset++)
        {
            int column = 21 + offset;
            string? actual = Cell(header, column);
            if (string.Equals(actual, TechnicalHeaders[offset], StringComparison.Ordinal))
            {
                ownedColumns[offset] = true;
                continue;
            }
            if (actual is not null)
                conflicts.Add(new("owned-range-conflict", $"{ColumnName(column)}1"));
            foreach (GoogleWorkbookRowSnapshot row in rows.Where(row => Cell(row, column) is not null))
                conflicts.Add(new("owned-range-conflict", $"{ColumnName(column)}{row.RowNumber}"));
        }
        return ownedColumns;
    }

    private static void InspectCompanionTabs(
        GoogleWorkbookSnapshot snapshot,
        ICollection<WorkbookConflict> conflicts
    )
    {
        foreach ((string title, string[] expectedHeaders) in CompanionHeaders)
        {
            GoogleSheetSnapshot? sheet = snapshot.Sheets.SingleOrDefault(candidate =>
                string.Equals(candidate.Title, title, StringComparison.Ordinal));
            if (sheet is null)
                continue;
            GoogleWorkbookRowSnapshot? header = sheet.Rows.SingleOrDefault(row => row.RowNumber == 1);
            bool exact = header is not null
                && expectedHeaders.Select((value, index) => string.Equals(Cell(header, index + 1), value, StringComparison.Ordinal)).All(value => value)
                && header.Cells.Skip(expectedHeaders.Length).All(cell => string.IsNullOrWhiteSpace(cell.Value));
            if (!exact)
                conflicts.Add(new("companion-tab-conflict", title));
        }
    }

    private static Dictionary<int, string> ValidateItemMetadata(
        GoogleWorkbookSnapshot snapshot,
        GoogleSheetSnapshot selected,
        IReadOnlyList<GoogleWorkbookRowSnapshot> populatedRows,
        ICollection<WorkbookConflict> conflicts
    )
    {
        HashSet<int> populatedRowNumbers = populatedRows.Select(row => row.RowNumber).ToHashSet();
        HashSet<int> metadataIds = [];
        HashSet<string> itemIds = new(StringComparer.Ordinal);
        Dictionary<int, string> byRow = [];
        foreach (GoogleDeveloperMetadataSnapshot metadata in snapshot.DeveloperMetadata.Where(candidate =>
            string.Equals(candidate.Key, ItemMetadataKey, StringComparison.Ordinal)))
        {
            string? itemId = CanonicalGuidOrNull(metadata.Value);
            int rowNumber = metadata.StartRowIndex + 1;
            bool valid = metadata.MetadataId > 0
                && metadataIds.Add(metadata.MetadataId)
                && itemId is not null
                && string.Equals(metadata.Value, itemId, StringComparison.Ordinal)
                && string.Equals(metadata.Visibility, "DOCUMENT", StringComparison.Ordinal)
                && metadata.LocationKind == GoogleDeveloperMetadataLocationKind.DimensionRange
                && metadata.SheetId == selected.SheetId
                && string.Equals(metadata.Dimension, "ROWS", StringComparison.Ordinal)
                && metadata.StartRowIndex >= 1
                && metadata.EndRowIndex == metadata.StartRowIndex + 1
                && populatedRowNumbers.Contains(rowNumber);
            if (!valid)
            {
                conflicts.Add(new("invalid-item-metadata", metadata.MetadataId.ToString(CultureInfo.InvariantCulture)));
                continue;
            }
            if (!itemIds.Add(itemId!) || !byRow.TryAdd(rowNumber, itemId!))
            {
                conflicts.Add(new("duplicate-item-metadata", rowNumber.ToString(CultureInfo.InvariantCulture)));
            }
        }
        return byRow;
    }

    private static void InspectSourceIdentityConflicts(
        WorkbookProjection projection,
        IReadOnlyList<CatalogueItemSummary> localItems,
        ICollection<WorkbookConflict> conflicts
    )
    {
        Dictionary<string, CatalogueItemSummary> bySource = localItems.ToDictionary(
            item => item.SourceKey,
            StringComparer.Ordinal
        );
        Dictionary<string, CatalogueItemSummary> byItemId = localItems.ToDictionary(
            item => item.ItemId,
            StringComparer.Ordinal
        );
        foreach (WorkbookCatalogueItem row in projection.Items.Where(row => row.MetadataId is not null))
        {
            bySource.TryGetValue(row.SourceKey, out CatalogueItemSummary? sourceItem);
            byItemId.TryGetValue(row.MetadataId!, out CatalogueItemSummary? metadataItem);
            if ((metadataItem is null && sourceItem is not null)
                || (metadataItem is not null
                    && sourceItem is not null
                    && !string.Equals(metadataItem.ItemId, sourceItem.ItemId, StringComparison.Ordinal)))
            {
                conflicts.Add(new("metadata-source-identity-conflict", $"A{row.SourceRow}"));
            }
        }
    }

    private static WorkbookProjection BuildProjection(
        string workbookId,
        GoogleSheetSnapshot sheet,
        IReadOnlyList<GoogleWorkbookRowSnapshot> rows,
        IReadOnlyDictionary<int, string> metadataByRow,
        IReadOnlyList<bool> ownedTechnicalColumns
    )
    {
        List<WorkbookCatalogueItem> items = new(rows.Count);
        foreach (GoogleWorkbookRowSnapshot row in rows)
        {
            string? rawDate = Cell(row, 2);
            string? plannedDate = null;
            if (rawDate is not null)
            {
                if (!DateOnly.TryParseExact(rawDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
                    throw new GoogleCatalogueException("invalid-workbook-date");
                plannedDate = rawDate;
            }
            string? verified = ownedTechnicalColumns[3] ? Cell(row, 24) : null;
            if (verified is not null
                && !DateTimeOffset.TryParseExact(verified, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _))
            {
                throw new GoogleCatalogueException("invalid-workbook-sync-time");
            }
            SortedDictionary<string, string> links = new(StringComparer.Ordinal);
            AddLink(links, "pornhubFree", Link(row, 8));
            AddLink(links, "onlyfans", Link(row, 10));
            AddLink(links, "fansly", Link(row, 11));
            AddLink(links, "manyvids", Link(row, 12));
            AddLink(links, "x", Link(row, 15));
            AddLink(links, "reddit", Link(row, 18));
            if (ownedTechnicalColumns[1])
                AddLink(links, "pornhubPaid", Link(row, 22));
            if (ownedTechnicalColumns[2])
                AddLink(links, "clips4sale", Link(row, 23));
            items.Add(new(
                sourceRow: row.RowNumber,
                sourceKey: RequiredCell(row, 1, "source-key", 200),
                title: RequiredCell(row, 3, "title", 300),
                description: Cell(row, 4) ?? string.Empty,
                plannedDate: plannedDate,
                series: Cell(row, 5),
                episode: Cell(row, 6),
                xTeasers: Count(row, 14),
                redditTeasers: Count(row, 17),
                platformLinks: links,
                metadataId: metadataByRow.GetValueOrDefault(row.RowNumber)
            ));
        }
        return new(workbookId, sheet.SheetId.ToString(CultureInfo.InvariantCulture), true, items);
    }

    private static List<WorkbookMigrationOperation> BuildStructuralOperations(
        GoogleWorkbookSnapshot snapshot,
        GoogleSheetSnapshot selected,
        bool technicalHeadersComplete,
        bool technicalColumnsConfigured,
        bool allowTechnicalChanges
    )
    {
        List<WorkbookMigrationOperation> operations = [];
        foreach ((string title, string[] headers) in CompanionHeaders)
        {
            GoogleSheetSnapshot? sheet = snapshot.Sheets.SingleOrDefault(candidate =>
                string.Equals(candidate.Title, title, StringComparison.Ordinal));
            if (sheet is null)
                operations.Add(new("create-companion", title, null, headers));
            else if (!sheet.Hidden)
                operations.Add(new("hide-companion", title, null, []));
        }
        if (allowTechnicalChanges && !technicalHeadersComplete)
        {
            operations.Add(new(
                "set-headers",
                $"'{EscapeSheetTitle(selected.Title)}'!U1:X1",
                1,
                TechnicalHeaders
            ));
        }
        if (allowTechnicalChanges && !technicalColumnsConfigured)
        {
            operations.Add(new(
                "configure-technical-columns",
                $"{selected.SheetId}:U:X",
                null,
                []
            ));
        }
        return operations;
    }

    private static bool TechnicalColumnsConfigured(GoogleSheetSnapshot sheet)
    {
        IReadOnlySet<int>? hidden = sheet.HiddenColumnIndexes;
        IReadOnlyList<GoogleDimensionGroupSnapshot>? groups = sheet.ColumnGroups;
        return hidden is not null
            && Enumerable.Range(20, 4).All(hidden.Contains)
            && groups is not null
            && groups.Any(group => group.StartIndex == 20 && group.EndIndex == 24);
    }

    private static string Hash(WorkbookMigrationPlan plan)
    {
        using MemoryStream output = new();
        using (Utf8JsonWriter writer = new(output))
        {
            writer.WriteStartObject();
            writer.WriteString("workbookId", plan.WorkbookId);
            writer.WriteNumber("sheetId", plan.SheetId);
            writer.WriteString("sheetTitle", plan.SheetTitle);
            writer.WriteString("sourceFingerprint", plan.SourceFingerprint);
            writer.WritePropertyName("operations");
            writer.WriteStartArray();
            foreach (WorkbookMigrationOperation operation in plan.Operations)
            {
                writer.WriteStartObject();
                writer.WriteString("kind", operation.Kind);
                writer.WriteString("target", operation.Target);
                if (operation.RowNumber is int rowNumber)
                    writer.WriteNumber("rowNumber", rowNumber);
                else
                    writer.WriteNull("rowNumber");
                writer.WritePropertyName("values");
                writer.WriteStartArray();
                foreach (string value in operation.Values)
                    writer.WriteStringValue(value);
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Convert.ToHexString(SHA256.HashData(output.ToArray())).ToLowerInvariant();
    }

    private static string ProjectionFingerprint(
        WorkbookProjection projection,
        GoogleSheetSnapshot selected
    )
    {
        using MemoryStream output = new();
        using (Utf8JsonWriter writer = new(output))
        {
            writer.WriteStartObject();
            writer.WriteString("workbookId", projection.WorkbookId);
            writer.WriteString("sheetId", projection.SheetId);
            writer.WriteBoolean("complete", projection.Complete);
            writer.WritePropertyName("items");
            writer.WriteStartArray();
            foreach (WorkbookCatalogueItem item in projection.Items.OrderBy(item => item.SourceRow))
            {
                writer.WriteStartObject();
                writer.WriteNumber("sourceRow", item.SourceRow);
                writer.WriteString("sourceKey", item.SourceKey);
                writer.WriteString("title", item.Title);
                writer.WriteString("description", item.Description);
                WriteNullable(writer, "plannedDate", item.PlannedDate);
                WriteNullable(writer, "series", item.Series);
                WriteNullable(writer, "episode", item.Episode);
                writer.WriteNumber("xTeasers", item.XTeasers);
                writer.WriteNumber("redditTeasers", item.RedditTeasers);
                WriteNullable(writer, "metadataId", item.MetadataId);
                writer.WritePropertyName("platformLinks");
                writer.WriteStartObject();
                foreach ((string platform, string url) in item.PlatformLinks.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                    writer.WriteString(platform, url);
                writer.WriteEndObject();
                GoogleWorkbookRowSnapshot row = selected.Rows.Single(candidate => candidate.RowNumber == item.SourceRow);
                writer.WritePropertyName("technicalCells");
                writer.WriteStartArray();
                foreach (int column in Enumerable.Range(21, 4))
                {
                    string? value = Cell(row, column);
                    if (value is null)
                        writer.WriteNullValue();
                    else
                        writer.WriteStringValue(value);
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Convert.ToHexString(SHA256.HashData(output.ToArray())).ToLowerInvariant();
    }

    private static void WriteNullable(Utf8JsonWriter writer, string property, string? value)
    {
        if (value is null)
            writer.WriteNull(property);
        else
            writer.WriteString(property, value);
    }

    private static bool IsPopulated(GoogleWorkbookRowSnapshot row) =>
        Enumerable.Range(1, 18).Any(column => Cell(row, column) is not null);

    private static string RequiredCell(
        GoogleWorkbookRowSnapshot row,
        int column,
        string field,
        int maximumLength
    )
    {
        string? value = Cell(row, column);
        if (value is null || value.Length > maximumLength)
            throw new GoogleCatalogueException($"invalid-workbook-{field}");
        return value;
    }

    private static int Count(GoogleWorkbookRowSnapshot row, int column)
    {
        string? value = Cell(row, column);
        if (value is null)
            return 0;
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int result)
            || result is < 0 or > 1_000_000)
        {
            throw new GoogleCatalogueException("invalid-workbook-count");
        }
        return result;
    }

    private static void AddLink(IDictionary<string, string> links, string platform, string? value)
    {
        if (value is not null)
            links.Add(platform, value);
    }

    private static string? Link(GoogleWorkbookRowSnapshot row, int column)
    {
        GoogleWorkbookCellSnapshot? cell = row.Cells.ElementAtOrDefault(column - 1);
        string? value = string.IsNullOrWhiteSpace(cell?.Hyperlink) ? cell?.Value : cell.Hyperlink;
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string? Cell(GoogleWorkbookRowSnapshot row, int column)
    {
        string? value = row.Cells.ElementAtOrDefault(column - 1)?.Value;
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string? CanonicalGuidOrNull(string value) =>
        Guid.TryParseExact(value, "D", out Guid parsed) ? parsed.ToString("D") : null;

    private static string EscapeSheetTitle(string title) => title.Replace("'", "''", StringComparison.Ordinal);

    private static string ColumnName(int oneBasedColumn)
    {
        StringBuilder result = new();
        int value = oneBasedColumn;
        while (value > 0)
        {
            value--;
            result.Insert(0, (char)('A' + value % 26));
            value /= 26;
        }
        return result.ToString();
    }
}

internal sealed record WorkbookInspection(
    int CatalogueSheetId,
    string CatalogueSheetTitle,
    WorkbookProjection Projection,
    IReadOnlyList<GoogleRowBinding> Bindings,
    IReadOnlyList<WorkbookConflict> Conflicts,
    WorkbookMigrationPlan MigrationPlan,
    string PlanHash,
    bool AlreadyMigrated
);

internal sealed record WorkbookConflict(string Code, string Target);

internal sealed record WorkbookMigrationPlan(
    string WorkbookId,
    int SheetId,
    string SheetTitle,
    string SourceFingerprint,
    IReadOnlyList<WorkbookMigrationOperation> Operations
);

internal sealed class WorkbookMigrationOperation : IEquatable<WorkbookMigrationOperation>
{
    internal WorkbookMigrationOperation(
        string kind,
        string target,
        int? rowNumber,
        IReadOnlyList<string> values
    )
    {
        Kind = kind;
        Target = target;
        RowNumber = rowNumber;
        Values = values.ToArray();
    }

    internal string Kind { get; }
    internal string Target { get; }
    internal int? RowNumber { get; }
    internal IReadOnlyList<string> Values { get; }

    public bool Equals(WorkbookMigrationOperation? other) =>
        other is not null
        && string.Equals(Kind, other.Kind, StringComparison.Ordinal)
        && string.Equals(Target, other.Target, StringComparison.Ordinal)
        && RowNumber == other.RowNumber
        && Values.SequenceEqual(other.Values, StringComparer.Ordinal);

    public override bool Equals(object? obj) => Equals(obj as WorkbookMigrationOperation);

    public override int GetHashCode()
    {
        HashCode hash = new();
        hash.Add(Kind, StringComparer.Ordinal);
        hash.Add(Target, StringComparer.Ordinal);
        hash.Add(RowNumber);
        foreach (string value in Values)
            hash.Add(value, StringComparer.Ordinal);
        return hash.ToHashCode();
    }
}
