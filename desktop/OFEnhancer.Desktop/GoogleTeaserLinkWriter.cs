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
        "catalogue-row-moved", "teaser-status-elsewhere",
    };

    internal Task<GoogleTeaserLinkResult> AppendAsync(string sourceKey, string url,
        CancellationToken cancellationToken) => WriteAsync(sourceKey, url, "x", null, null, cancellationToken);

    internal Task<GoogleTeaserLinkResult> WriteResultAsync(UploadSheetWriteback intent,
        Action<int> beforeWrite, CancellationToken cancellationToken) =>
        WriteAsync(intent.SourceKey, intent.Url, intent.Platform, intent, beforeWrite, cancellationToken);

    private async Task<GoogleTeaserLinkResult> WriteAsync(string sourceKey, string url, string platform,
        UploadSheetWriteback? intent, Action<int>? beforeWrite, CancellationToken cancellationToken)
    {
        bool teaser = platform == "x";
        // X teasers and toy-sync scripts may hold several links in one cell.
        bool append = teaser || platform == "script";
        string LinkKey(string value) => platform == "onlyfans" ? new Uri(value).AbsolutePath.Split('/')[1] : value;
        string statusId = (teaser ? CatalogueStore.XStatusIdFromUrl(url)
            : Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)
                && platform is "onlyfans" or "fansly" or "manyvids" or "script"
                ? CatalogueSnapshotImporter.CanonicalPlatformLink(platform, uri) : null) is { } id
            && url.Length <= 2048 && !url.Any(char.IsWhiteSpace)
            ? id : throw new GoogleCatalogueException("invalid-teaser-link");
        if (!teaser) statusId = LinkKey(statusId);
        (GoogleWorkbookSnapshot workbook, GoogleCatalogueImportPreview before) = await ReadAsync(cancellationToken)
            .ConfigureAwait(false);
        if (intent is not null && (intent.WorkbookId != before.Projection.WorkbookId ||
            intent.SheetId is not null && intent.SheetId != before.Projection.SheetId))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        if (!before.Columns.TryGetValue(platform, out int column))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        WorkbookCatalogueItem item = before.Projection.Items.SingleOrDefault(candidate => candidate.SourceKey == sourceKey)
            ?? throw new GoogleCatalogueException("catalogue-entry-missing");
        GoogleSheetSnapshot sheet = workbook.Sheets.Single(candidate => candidate.SheetId == before.CatalogueSheetId);
        GoogleWorkbookCellSnapshot? cell = CellAt(sheet, item.SourceRow, column);
        string text = cell?.Value ?? "";
        HashSet<string> Links(string value) => teaser ? StatusIds(value) :
            [.. CellUrl.Matches(value).Select(match => Uri.TryCreate(match.Value, UriKind.Absolute, out Uri? parsed)
                ? CatalogueSnapshotImporter.CanonicalPlatformLink(platform, parsed) : null).OfType<string>().Select(LinkKey)];
        if (intent is not null && (item.Title != intent.Title || item.Description != intent.Description))
            throw new GoogleCatalogueException("catalogue-entry-changed");
        if (intent is not null && item.SourceLinkCells is { } sourceCells
            && sourceCells.TryGetValue(platform, out CatalogueSourceLinkCell? sourceCell) && sourceCell.IssueCode is not null)
            throw new GoogleCatalogueException("platform-link-conflict");
        if (Links(text).Contains(statusId)
            || cell?.Hyperlink is { } target && Links(target).Contains(statusId))
            return new("already-present", before);
        if (!append && (!string.IsNullOrWhiteSpace(text) || cell?.Hyperlink is not null))
            throw new GoogleCatalogueException("platform-link-conflict");
        // A status already linked from another row is never duplicated here.
        if (sheet.Rows.Any(row => row.RowNumber > before.HeaderRow && row.RowNumber != item.SourceRow
            && (Links(row.Cells.ElementAtOrDefault(column - 1)?.Value ?? "").Contains(statusId)
                || Links(row.Cells.ElementAtOrDefault(column - 1)?.Hyperlink ?? "").Contains(statusId))))
            throw new GoogleCatalogueException("teaser-status-elsewhere");
        if (text.Any(c => c is '\r' or '\t'))
            throw new GoogleCatalogueException("teaser-cell-unreadable");
        // A whole-cell link on non-link text would be lost by a value write.
        if (cell?.Hyperlink is not null)
            throw new GoogleCatalogueException("teaser-cell-linked");

        string existing = text.Trim();
        string updated = existing.Length == 0 ? url : existing + DetectSeparator(sheet, before, column, text) + url;
        if (updated.Length > 10_000) throw new GoogleCatalogueException("teaser-cell-full");
        string prefix = $"'{before.CatalogueSheetTitle.Replace("'", "''", StringComparison.Ordinal)}'!";
        string range = $"{prefix}{(char)('A' + column - 1)}{item.SourceRow}";
        string idRange = $"{prefix}{(char)('A' + before.Columns["sourceKey"] - 1)}{item.SourceRow}";
        // The row's ID and teaser cell are read together just before the write,
        // so a row inserted, deleted or sorted since the full read is refused.
        List<(string Range, string Expected)> guards = [];
        if (intent is not null)
        {
            string headerRange = $"{prefix}{(char)('A' + column - 1)}{before.HeaderRow}";
            guards.Add((headerRange, CellAt(sheet, before.HeaderRow, column)?.Value ?? ""));
            foreach ((string field, string expected) in new[] { ("title", intent.Title), ("description", intent.Description) })
                if (before.Columns.TryGetValue(field, out int fieldColumn))
                    guards.Add(($"{prefix}{(char)('A' + fieldColumn - 1)}{item.SourceRow}", expected));
                else if (expected.Length > 0) throw new GoogleCatalogueException("catalogue-layout-changed");
        }
        IReadOnlyList<GoogleProjectionCell> cells = await workspace.ReadProjectionCellsAsync(workbookId,
            [idRange, range, .. guards.Select(guard => guard.Range)],
            cancellationToken, allowTextWhitespace: true).ConfigureAwait(false);
        GoogleProjectionCell liveId = cells[0], live = cells[1];
        if (!GoogleUploadEntryWriter.SameCell(liveId.Range, before.CatalogueSheetTitle, idRange)
            || !GoogleUploadEntryWriter.SameCell(live.Range, before.CatalogueSheetTitle, range))
            throw new GoogleCatalogueException("catalogue-entry-changed");
        if ((liveId.Value ?? "").Trim() != sourceKey) throw new GoogleCatalogueException("catalogue-row-moved");
        if ((live.Value ?? "").StartsWith('=')) throw new GoogleCatalogueException("teaser-cell-formula");
        if ((live.Value ?? "").Trim() != existing) throw new GoogleCatalogueException("catalogue-entry-changed");
        for (int index = 0; index < guards.Count; index++)
            if (!GoogleUploadEntryWriter.SameCell(cells[index + 2].Range, before.CatalogueSheetTitle, guards[index].Range)
                || (cells[index + 2].Value ?? "").Trim() != guards[index].Expected.Trim())
                throw new GoogleCatalogueException("catalogue-entry-changed");
        if (intent is not null && intent.State != "pending")
            throw new GoogleCatalogueException("google-row-write-unresolved");
        beforeWrite?.Invoke(before.CatalogueSheetId);
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
        if (written is null || written.SourceRow != item.SourceRow || writtenText?.Trim() != updated
            || intent is not null && (written.Title != intent.Title || written.Description != intent.Description
                || written.SourceLinkCells is { } writtenCells && writtenCells.TryGetValue(platform, out CatalogueSourceLinkCell? writtenCell)
                    && writtenCell.IssueCode is not null))
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
