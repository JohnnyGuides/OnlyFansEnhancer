using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed record GoogleWorkflowLedgerResult(string State, string? ErrorCode = null);

// Owns only the versioned _Workflows tab; each immutable run revision gets one row.
internal sealed class GoogleWorkflowLedgerWriter(string workbookId, GoogleWorkspaceClient workspace)
{
    internal const string SheetTitle = "_Workflows";
    internal const int MaximumCellCharacters = 10_000;
    internal const int MaximumReadableRows = GoogleWorkspaceClient.MaximumWorkflowLedgerReadableRows;
    internal const int MaximumReadableResponseBytes = 12 * 1024 * 1024;
    internal static readonly string[] Headers =
    [
        "OFEnhancer Workflows v1", "Run ID", "Revision", "Kind", "Source key", "Source item ID", "Source title",
        "Target results JSON", "Promoted paid URL", "Reply JSON", "Script JSON", "Asset fingerprints JSON",
        "Clip JSON", "Snapshot SHA-256",
    ];

    internal async Task<GoogleWorkflowLedgerResult> WriteAsync(CreatorWorkflowProjectionIntent intent,
        Action<int> beforeWrite, CancellationToken cancellationToken)
    {
        if (intent.WorkbookId != workbookId || intent.Snapshot.RunId != intent.RunId
            || intent.Snapshot.Revision != intent.Revision)
            return new("conflict", "google-workflow-ledger-identity-changed");
        string[] values = Values(intent);
        if (values.Any(value => value.Length > MaximumCellCharacters))
            return new("conflict", "google-workflow-ledger-cell-too-large");
        GoogleWorkflowLedgerRead ledgerRead;
        try { ledgerRead = await workspace.ReadWorkflowLedgerAsync(workbookId, cancellationToken).ConfigureAwait(false); }
        catch (GoogleCatalogueException error) when (error.Code == "google-workflow-ledger-full")
        {
            return intent.State is "attempted" or "unresolved"
                ? new("unresolved", "google-workflow-ledger-full")
                : new("conflict", "google-workflow-ledger-full");
        }
        catch (Exception error) { return new(intent.State is "attempted" or "unresolved" ? "unresolved" : "pending", Code(error)); }
        GoogleWorkbookSnapshot workbook = ledgerRead.Workbook;

        GoogleSheetSnapshot[] candidates = [.. workbook.Sheets.Where(sheet => sheet.Title == SheetTitle)];
        if (candidates.Length > 1) return new("conflict", "google-workflow-ledger-ambiguous");
        GoogleSheetSnapshot? ledger = candidates.SingleOrDefault();
        int? ledgerSheetId = ledger?.SheetId;

        if (ledger is null)
        {
            if (intent.State is "attempted" or "unresolved")
                return new("unresolved", "google-workflow-ledger-write-not-confirmed");
            if (intent.LedgerSheetId is not null)
                return new("conflict", "google-workflow-ledger-sheet-changed");
            if (intent.State == "conflict") return new("conflict", intent.ErrorCode);
            ledgerSheetId = NewSheetId(workbook);
        }
        else
        {
            if (intent.LedgerSheetId is not null && intent.LedgerSheetId != ledgerSheetId)
                return new("conflict", "google-workflow-ledger-sheet-changed");
            string? problem = ValidateSheet(ledger);
            if (problem is not null) return new("conflict", problem);
            int[] matches = [.. ledger.Rows.Where(row => Cell(row, 1) == intent.RunId && Cell(row, 2) == intent.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture))
                .Select(row => row.RowNumber - 1)];
            if (matches.Length > 1) return new("conflict", "google-workflow-ledger-duplicate-identity");
            if (matches.Length == 1)
            {
                GoogleWorkbookRowSnapshot existing = ledger.Rows.Single(row => row.RowNumber - 1 == matches[0]);
                if (RowValues(existing).SequenceEqual(values, StringComparer.Ordinal))
                    return new("completed");
                return new("conflict", "google-workflow-ledger-payload-conflict");
            }
            if (intent.State is "attempted" or "unresolved")
                return new("unresolved", "google-workflow-ledger-write-not-confirmed");
            int lastUsedRow = ledger.Rows.Where(row => HasContent(row)).Select(row => row.RowNumber).DefaultIfEmpty(1).Max();
            if (ledgerRead.RowsBeyondReadLimit || lastUsedRow >= MaximumReadableRows
                || ledgerRead.ResponseBytes + EstimateAppendResponseBytes(values) > MaximumReadableResponseBytes)
                return new("conflict", "google-workflow-ledger-full");
            if (intent.State == "conflict") return new("conflict", intent.ErrorCode);
        }

        int targetSheetId = ledgerSheetId!.Value;
        beforeWrite(targetSheetId);
        try
        {
            JsonElement[] requests = ledger is null
                ? NewLedgerRequests(targetSheetId, values)
                : [AppendRowRequest(targetSheetId, values)];
            await workspace.ApplyStructuralBatchAsync(new(workbookId, requests), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            GoogleWorkflowLedgerResult readback = await ReconcileAsync(intent, values, targetSheetId, cancellationToken).ConfigureAwait(false);
            return readback.State == "completed" ? readback
                : readback.State == "conflict" ? readback
                : new("unresolved", Code(error));
        }

        return await ReconcileAsync(intent, values, targetSheetId, cancellationToken).ConfigureAwait(false);
    }

    private async Task<GoogleWorkflowLedgerResult> ReconcileAsync(CreatorWorkflowProjectionIntent intent,
        string[] values, int expectedSheetId, CancellationToken cancellationToken)
    {
        try
        {
            GoogleWorkflowLedgerRead read = await workspace.ReadWorkflowLedgerAsync(workbookId, cancellationToken).ConfigureAwait(false);
            GoogleWorkbookSnapshot readback = read.Workbook;
            GoogleSheetSnapshot[] sheets = [.. readback.Sheets.Where(sheet => sheet.Title == SheetTitle)];
            if (sheets.Length != 1) return new("unresolved", "google-workflow-ledger-readback-missing");
            GoogleSheetSnapshot sheet = sheets[0];
            if (sheet.SheetId != expectedSheetId)
                return new("conflict", "google-workflow-ledger-sheet-changed");
            string? problem = ValidateSheet(sheet);
            if (problem is not null) return new("conflict", problem);
            GoogleWorkbookRowSnapshot[] matches = [.. sheet.Rows.Where(row => Cell(row, 1) == intent.RunId
                && Cell(row, 2) == intent.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture))];
            if (matches.Length == 1 && RowValues(matches[0]).SequenceEqual(values, StringComparer.Ordinal))
                return new("completed");
            if (matches.Length > 1 || matches.Length == 1)
                return new("conflict", "google-workflow-ledger-payload-conflict");
            return new("unresolved", "google-workflow-ledger-readback-missing");
        }
        catch (Exception error) { return new("unresolved", Code(error)); }
    }

    private static string? ValidateSheet(GoogleSheetSnapshot sheet)
    {
        if (sheet.Hidden || sheet.ColumnCount != Headers.Length)
            return "google-workflow-ledger-foreign-sheet";
        GoogleWorkbookRowSnapshot? header = sheet.Rows.SingleOrDefault(row => row.RowNumber == 1);
        if (header is null || header.Cells.Count != Headers.Length
            || header.Cells.Any(cell => cell.Formula is not null || cell.Hyperlink is not null)
            || !RowValues(header).SequenceEqual(Headers, StringComparer.Ordinal))
            return "google-workflow-ledger-foreign-headers";
        foreach (GoogleWorkbookRowSnapshot row in sheet.Rows.Where(row => row.RowNumber > 1 && HasContent(row)))
        {
            if (row.Cells.Any(cell => cell.Formula is not null || IsForeignHyperlink(cell))
                || row.Cells.Count != Headers.Length || Cell(row, 0) != "v1"
                || string.IsNullOrWhiteSpace(Cell(row, 1))
                || !long.TryParse(Cell(row, 2), out long revision) || revision <= 0
                || Cell(row, 3) is not ("upload" or "social")
                || Cell(row, 13) is not { Length: 64 } hash || !hash.All(Uri.IsHexDigit))
                return "google-workflow-ledger-foreign-row";
            string[] prefix = RowValues(row)[..13];
            string expectedHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(prefix))));
            if (!string.Equals(expectedHash, hash, StringComparison.OrdinalIgnoreCase))
                return "google-workflow-ledger-row-invalid";
        }
        return null;
    }

    private static string[] Values(CreatorWorkflowProjectionIntent intent)
    {
        CreatorWorkflowSnapshot snapshot = intent.Snapshot;
        string[] values =
        [
            "v1", snapshot.RunId, snapshot.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture), snapshot.Kind,
            snapshot.SourceKey ?? "", intent.SourceItemId ?? "", intent.SourceTitle ?? "", JsonSerializer.Serialize(snapshot.Targets),
            snapshot.Reply?.PaidUrl ?? "", JsonSerializer.Serialize(snapshot.Reply), JsonSerializer.Serialize(snapshot.Script),
            JsonSerializer.Serialize(snapshot.Assets.Select(asset => new { asset.Role, asset.Name, asset.Size, asset.LastModified, asset.Sha256 })),
            JsonSerializer.Serialize(snapshot.Clip), "",
        ];
        values[^1] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(values[..^1]))));
        return values;
    }

    private static JsonElement[] NewLedgerRequests(int sheetId, string[] values)
    {
        JsonElement add = JsonSerializer.SerializeToElement(new
        {
            addSheet = new { properties = new { sheetId, title = SheetTitle,
                gridProperties = new { rowCount = 1000, columnCount = Headers.Length } } },
        });
        return [add, UpdateRowRequest(sheetId, 0, Headers), UpdateRowRequest(sheetId, 1, values)];
    }

    private static JsonElement UpdateRowRequest(int sheetId, int rowIndex, string[] values) =>
        JsonSerializer.SerializeToElement(new
        {
            updateCells = new
            {
                start = new { sheetId, rowIndex, columnIndex = 0 },
                rows = new[] { new { values = values.Select(value => new { userEnteredValue = new { stringValue = value } }).ToArray() } },
                fields = "userEnteredValue",
            },
        });

    private static JsonElement AppendRowRequest(int sheetId, string[] values) =>
        JsonSerializer.SerializeToElement(new
        {
            appendCells = new
            {
                sheetId,
                rows = new[] { new { values = values.Select(value => new { userEnteredValue = new { stringValue = value } }).ToArray() } },
                fields = "userEnteredValue",
            },
        });

    private static int NewSheetId(GoogleWorkbookSnapshot workbook)
    {
        HashSet<int> ids = workbook.Sheets.Select(sheet => sheet.SheetId).ToHashSet();
        int candidate;
        do candidate = RandomNumberGenerator.GetInt32(1, int.MaxValue); while (ids.Contains(candidate));
        return candidate;
    }

    private static bool HasContent(GoogleWorkbookRowSnapshot row) => row.Cells.Any(cell =>
        cell.Value is not null || cell.Formula is not null || cell.Hyperlink is not null);

    private static string? Cell(GoogleWorkbookRowSnapshot row, int column) =>
        row.Cells.Count > column ? row.Cells[column].Value : null;

    private static string[] RowValues(GoogleWorkbookRowSnapshot row) => [.. row.Cells.Select(cell => cell.Value ?? "")];

    private static bool IsForeignHyperlink(GoogleWorkbookCellSnapshot cell) => cell.Hyperlink is not null
        && (cell.Hyperlink != cell.Value || !Uri.TryCreate(cell.Hyperlink, UriKind.Absolute, out Uri? link)
            || link.Scheme != Uri.UriSchemeHttps || !link.IsDefaultPort || !string.IsNullOrEmpty(link.UserInfo));

    private static long EstimateAppendResponseBytes(IReadOnlyList<string> values)
    {
        // A returned string cell can be represented as entered, effective, and
        // formatted values, with a possible hyperlink field as well. This
        // intentionally overestimates JSON escaping and row metadata so the
        // append stays well inside the dedicated reader's byte limit.
        long estimate = 1_024;
        foreach (string value in values)
            estimate += (long)JsonSerializer.SerializeToUtf8Bytes(value).Length * 4 + 128;
        return estimate;
    }

    private static string Code(Exception error) => error switch
    {
        GoogleCatalogueException google => google.Code,
        OperationCanceledException => "google-workflow-ledger-cancelled",
        _ => "google-workflow-ledger-write-failed",
    };
}
