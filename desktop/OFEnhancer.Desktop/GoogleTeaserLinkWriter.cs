using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed record GoogleTeaserLinkResult(string Status, GoogleCatalogueImportPreview Preview);

internal sealed record XSheetWritebackRun(bool Connected, int Appended, int AlreadyPresent, int Failed);

// Appends one discovered X status link to a row's Twitter Teaser(s) cell.
// Existing cell content is kept verbatim apart from surrounding whitespace;
// the link joins it with the sheet's own separator. The live cell is checked
// against the snapshot just before the write and the whole row is read back.
internal sealed class GoogleTeaserLinkWriter(
    string workbookId, int? preferredSheetId, GoogleWorkspaceClient workspace)
{
    private static readonly Regex CellUrl = new(@"https?://[^\s,;]+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // Row-specific refusals; anything else stops the current write-back run.
    internal static readonly IReadOnlySet<string> RowCodes = new HashSet<string>(StringComparer.Ordinal)
    {
        "catalogue-entry-missing", "catalogue-entry-changed", "google-row-write-unresolved", "invalid-teaser-link",
        "teaser-cell-unreadable", "teaser-cell-formula", "teaser-cell-linked", "teaser-cell-full",
    };

    internal async Task<GoogleTeaserLinkResult> AppendAsync(string sourceKey, string url,
        CancellationToken cancellationToken)
    {
        string statusId = CatalogueStore.XStatusIdFromUrl(url) is { } id && url.Length <= 2048 && !url.Any(char.IsWhiteSpace)
            ? id : throw new GoogleCatalogueException("invalid-teaser-link");
        (GoogleWorkbookSnapshot workbook, GoogleCatalogueImportPreview before) = await ReadAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!before.Columns.TryGetValue("x", out int column))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        WorkbookCatalogueItem item = before.Projection.Items.SingleOrDefault(candidate => candidate.SourceKey == sourceKey)
            ?? throw new GoogleCatalogueException("catalogue-entry-missing");
        GoogleSheetSnapshot sheet = workbook.Sheets.Single(candidate => candidate.SheetId == before.CatalogueSheetId);
        GoogleWorkbookCellSnapshot? cell = CellAt(sheet, item.SourceRow, column);
        string text = cell?.Value ?? "";
        if (StatusIds(text).Contains(statusId)
            || cell?.Hyperlink is { } target && CatalogueStore.XStatusIdFromUrl(target) == statusId)
            return new("already-present", before);
        if (text.Any(c => c is '\r' or '\t'))
            throw new GoogleCatalogueException("teaser-cell-unreadable");
        // A whole-cell link on non-link text would be lost by a value write.
        if (cell?.Hyperlink is { } link && !StatusIds(text).Contains(CatalogueStore.XStatusIdFromUrl(link) ?? ""))
            throw new GoogleCatalogueException("teaser-cell-linked");

        string existing = text.Trim();
        string updated = existing.Length == 0 ? url : existing + DetectSeparator(sheet, before, column, text) + url;
        if (updated.Length > 10_000) throw new GoogleCatalogueException("teaser-cell-full");
        string range = $"'{before.CatalogueSheetTitle.Replace("'", "''", StringComparison.Ordinal)}'!{(char)('A' + column - 1)}{item.SourceRow}";
        GoogleProjectionCell live = await workspace.ReadProjectionCellAsync(workbookId, range, cancellationToken,
            allowTextWhitespace: true).ConfigureAwait(false);
        if (!GoogleUploadEntryWriter.SameCell(live.Range, before.CatalogueSheetTitle, range))
            throw new GoogleCatalogueException("catalogue-entry-changed");
        if ((live.Value ?? "").StartsWith('=')) throw new GoogleCatalogueException("teaser-cell-formula");
        if ((live.Value ?? "").Trim() != existing) throw new GoogleCatalogueException("catalogue-entry-changed");
        try
        {
            await workspace.UpdateValuesBatchAsync(new(workbookId, [new(range, updated)]), cancellationToken, raw: true)
                .ConfigureAwait(false);
        }
        catch (GoogleMutationUncertainException)
        {
            // The readback decides whether the one attempted write completed.
        }

        (GoogleWorkbookSnapshot readback, GoogleCatalogueImportPreview after) = await ReadAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!before.HasSameMapping(after)) throw new GoogleCatalogueException("catalogue-layout-changed");
        WorkbookCatalogueItem? written = after.Projection.Items.SingleOrDefault(candidate => candidate.SourceKey == sourceKey);
        string? writtenText = written is null ? null
            : CellAt(readback.Sheets.Single(candidate => candidate.SheetId == after.CatalogueSheetId), written.SourceRow, column)?.Value;
        if (written is null || written.SourceRow != item.SourceRow || writtenText?.Trim() != updated)
            throw new GoogleCatalogueException("google-row-write-unresolved");
        return new("appended", after);
    }

    private async Task<(GoogleWorkbookSnapshot, GoogleCatalogueImportPreview)> ReadAsync(CancellationToken cancellationToken)
    {
        GoogleWorkbookSnapshot snapshot = await workspace.ReadImportWorkbookAsync(workbookId, cancellationToken, preferredSheetId)
            .ConfigureAwait(false);
        return (snapshot, GoogleCatalogueImportReader.Read(snapshot, preferredSheetId));
    }

    private static HashSet<string> StatusIds(string text) =>
        [.. CellUrl.Matches(text).Select(match => CatalogueStore.XStatusIdFromUrl(match.Value)).OfType<string>()];

    // The cell's own separator wins; otherwise the most common one among the
    // column's multi-link cells; otherwise a line break.
    internal static string DetectSeparator(GoogleSheetSnapshot sheet, GoogleCatalogueImportPreview preview, int column, string text) =>
        Separator(text) ?? sheet.Rows.Where(row => row.RowNumber > preview.HeaderRow)
            .Select(row => Separator(row.Cells.ElementAtOrDefault(column - 1)?.Value ?? "")).OfType<string>()
            .GroupBy(separator => separator, StringComparer.Ordinal)
            .OrderByDescending(group => group.Count()).ThenBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => group.Key).FirstOrDefault() ?? "\n";

    private static string? Separator(string text)
    {
        MatchCollection matches = CellUrl.Matches(text);
        if (matches.Count < 2) return null;
        string separator = text[(matches[0].Index + matches[0].Length)..matches[1].Index];
        return separator.Length is >= 1 and <= 4 && separator.All(c => c is ' ' or ',' or ';' or '\n') ? separator : null;
    }

    private static GoogleWorkbookCellSnapshot? CellAt(GoogleSheetSnapshot sheet, int row, int column) =>
        sheet.Rows.SingleOrDefault(candidate => candidate.RowNumber == row)?.Cells.ElementAtOrDefault(column - 1);
}
