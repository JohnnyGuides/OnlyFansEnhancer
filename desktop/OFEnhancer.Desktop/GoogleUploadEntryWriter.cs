using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed record GoogleUploadEntryRequest(
    string Mode, string Title, string Description, string ReleaseDate,
    string? FileName = null, long? FileSize = null, long? FileLastModified = null,
    string? Id = null, string? ExpectedTitle = null, string? ExpectedDescription = null,
    string Category = "", string SeasonArc = "",
    string? ExpectedCategory = null, string? ExpectedSeasonArc = null);

internal sealed record GoogleUploadEntryResult(string Id, int Row, string Status,
    GoogleCatalogueImportPreview Preview);

internal sealed class GoogleUploadEntryWriter(
    string workbookId, int? preferredSheetId, GoogleWorkspaceClient workspace)
{
    internal async Task<GoogleUploadEntryResult> WriteAsync(
        GoogleUploadEntryRequest request, CancellationToken cancellationToken)
    {
        Validate(request);
        GoogleWorkbookSnapshot workbook = await workspace.ReadImportWorkbookAsync(workbookId, cancellationToken, preferredSheetId)
            .ConfigureAwait(false);
        GoogleCatalogueImportPreview before = GoogleCatalogueImportReader.Read(workbook, preferredSheetId);
        string id = request.Mode == "new" ? NewId(request, before.Projection.Items) : request.Id!;
        WorkbookCatalogueItem? existing = before.Projection.Items.SingleOrDefault(item => item.SourceKey == id);
        // In update mode Season/Arc and Category change only when the user moved them off the
        // selection baseline; an untouched or unknown baseline never blanks a sheet value.
        bool seriesRequested = request.Mode == "new" || (request.ExpectedSeasonArc is null
            ? request.SeasonArc.Length > 0 : request.SeasonArc != request.ExpectedSeasonArc);
        bool categoryRequested = request.Mode == "new" ? request.Category.Length > 0
            : request.ExpectedCategory is null
                ? request.Category.Length > 0 : request.Category != request.ExpectedCategory;
        if (request.Mode == "new")
        {
            if (!before.Columns.ContainsKey("plannedDate") || !before.Columns.ContainsKey("description"))
                throw new GoogleCatalogueException("catalogue-layout-changed");
            if (!string.IsNullOrEmpty(request.Category) && !before.Columns.ContainsKey("category")
                || !string.IsNullOrEmpty(request.SeasonArc) && !before.Columns.ContainsKey("series"))
                throw new GoogleCatalogueException("catalogue-layout-changed");
            if (existing is not null)
                return ExactNew(existing, request)
                    ? new(id, existing.SourceRow, "already-created", before)
                    : throw new GoogleCatalogueException("catalogue-new-entry-conflict");
            try
            {
                int? reservedRow = FindReservedDateRow(workbook, before, request.ReleaseDate);
                if (reservedRow is int row)
                    await workspace.WriteCatalogueRowAtAsync(workbookId, before.CatalogueSheetTitle,
                        before.Columns, row, id, request.Title, request.Description,
                        request.Category, request.SeasonArc, cancellationToken).ConfigureAwait(false);
                else
                    await workspace.AppendCatalogueRowAsync(workbookId, before.CatalogueSheetTitle,
                        before.HeaderRow, before.Columns, id, request.ReleaseDate,
                        request.Title, request.Description, request.Category, request.SeasonArc,
                        cancellationToken).ConfigureAwait(false);
            }
            catch (GoogleMutationUncertainException)
            {
                // Read back by the deterministic ID. Never blindly append again.
            }
        }
        else
        {
            if (existing is null) throw new GoogleCatalogueException("catalogue-entry-missing");
            string? currentCategory = categoryRequested
                ? await ReadFieldAsync(before, existing, "category", cancellationToken).ConfigureAwait(false)
                : null;
            if (existing.Title == request.Title && existing.Description == request.Description
                && (!seriesRequested || (existing.Series ?? "") == request.SeasonArc)
                && (!categoryRequested || currentCategory == request.Category))
                return new(id, existing.SourceRow, "already-updated", before);
            if (existing.Title != request.ExpectedTitle || existing.Description != request.ExpectedDescription)
                throw new GoogleCatalogueException("catalogue-entry-changed");
            List<GoogleValueUpdate> updates = [];
            if (existing.Title != request.Title)
                updates.Add(await CheckedUpdateAsync(before, existing, "title", request.Title,
                    request.ExpectedTitle!, cancellationToken).ConfigureAwait(false));
            if (existing.Description != request.Description)
                updates.Add(await CheckedUpdateAsync(before, existing, "description", request.Description,
                    request.ExpectedDescription!, cancellationToken).ConfigureAwait(false));
            if (seriesRequested && (existing.Series ?? "") != request.SeasonArc)
                updates.Add(await CheckedUpdateAsync(before, existing, "series", request.SeasonArc,
                    request.ExpectedSeasonArc ?? existing.Series ?? "", cancellationToken).ConfigureAwait(false));
            if (categoryRequested && currentCategory != request.Category)
                updates.Add(await CheckedUpdateAsync(before, existing, "category", request.Category,
                    request.ExpectedCategory ?? currentCategory!, cancellationToken).ConfigureAwait(false));
            if (updates.Count == 0)
                return new(id, existing.SourceRow, "already-updated", before);
            try
            {
                await workspace.UpdateValuesBatchAsync(new(workbookId, updates), cancellationToken, raw: true)
                    .ConfigureAwait(false);
            }
            catch (GoogleMutationUncertainException)
            {
                // A readback decides whether the one attempted write completed.
            }
        }
        GoogleCatalogueImportPreview after = await ReadAsync(cancellationToken).ConfigureAwait(false);
        if (!before.HasSameMapping(after)) throw new GoogleCatalogueException("catalogue-layout-changed");
        WorkbookCatalogueItem? written = after.Projection.Items.SingleOrDefault(item => item.SourceKey == id);
        if (written is null || written.Title != request.Title || written.Description != request.Description
            || seriesRequested && written.Series != (string.IsNullOrEmpty(request.SeasonArc) ? null : request.SeasonArc)
            || request.Mode == "new" && written.PlannedDate != request.ReleaseDate)
            throw new GoogleCatalogueException("google-row-write-unresolved");
        if (categoryRequested
            && await ReadFieldAsync(after, written, "category", cancellationToken).ConfigureAwait(false) != request.Category)
            throw new GoogleCatalogueException("google-row-write-unresolved");
        return new(id, written.SourceRow, request.Mode == "new" ? "created" : "updated", after);
    }

    private async Task<GoogleValueUpdate> CheckedUpdateAsync(GoogleCatalogueImportPreview preview,
        WorkbookCatalogueItem item, string field, string value, string expected,
        CancellationToken cancellationToken)
    {
        if (!preview.Columns.TryGetValue(field, out int column))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        string sheet = preview.CatalogueSheetTitle.Replace("'", "''", StringComparison.Ordinal);
        string range = $"'{sheet}'!{(char)('A' + column - 1)}{item.SourceRow}";
        GoogleProjectionCell cell = await workspace.ReadProjectionCellAsync(workbookId, range, cancellationToken)
            .ConfigureAwait(false);
        if (!SameCell(cell.Range, preview.CatalogueSheetTitle, range) || (cell.Value ?? "") != expected)
            throw new GoogleCatalogueException("catalogue-entry-changed");
        return new(range, value);
    }

    private async Task<string> ReadFieldAsync(GoogleCatalogueImportPreview preview,
        WorkbookCatalogueItem item, string field, CancellationToken cancellationToken)
    {
        if (!preview.Columns.TryGetValue(field, out int column))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        string sheet = preview.CatalogueSheetTitle.Replace("'", "''", StringComparison.Ordinal);
        string range = $"'{sheet}'!{(char)('A' + column - 1)}{item.SourceRow}";
        GoogleProjectionCell cell = await workspace.ReadProjectionCellAsync(workbookId, range, cancellationToken)
            .ConfigureAwait(false);
        if (!SameCell(cell.Range, preview.CatalogueSheetTitle, range)) throw new GoogleCatalogueException("catalogue-entry-changed");
        return cell.Value ?? "";
    }

    // Google quotes a sheet title in a returned range only when the title needs it.
    internal static bool SameCell(string returned, string sheetTitle, string requested)
    {
        int separator = returned.LastIndexOf('!');
        if (separator < 1) return false;
        string source = returned[..separator];
        if (source.Length >= 2 && source.StartsWith('\'') && source.EndsWith('\''))
            source = source[1..^1].Replace("''", "'", StringComparison.Ordinal);
        return source == sheetTitle && returned[(separator + 1)..] == requested[(requested.LastIndexOf('!') + 1)..];
    }

    private async Task<GoogleCatalogueImportPreview> ReadAsync(CancellationToken cancellationToken)
    {
        GoogleWorkbookSnapshot snapshot = await workspace.ReadImportWorkbookAsync(workbookId, cancellationToken, preferredSheetId)
            .ConfigureAwait(false);
        return GoogleCatalogueImportReader.Read(snapshot, preferredSheetId);
    }

    private static int? FindReservedDateRow(GoogleWorkbookSnapshot workbook,
        GoogleCatalogueImportPreview preview, string releaseDate)
    {
        if (!preview.Columns.TryGetValue("plannedDate", out int dateColumn)
            || !preview.Columns.TryGetValue("sourceKey", out int idColumn)) return null;
        GoogleSheetSnapshot sheet = workbook.Sheets.Single(s => s.SheetId == preview.CatalogueSheetId);
        int? selected = null;
        // Columns A-L plus every column of the detected mapping, which includes those the writer fills.
        int[] inspectedColumns = [.. Enumerable.Range(0, 12).Union(preview.Columns.Values.Select(column => column - 1))];
        foreach (GoogleWorkbookRowSnapshot row in sheet.Rows.Where(r => r.RowNumber > preview.HeaderRow))
        {
            string? date = row.Cells.ElementAtOrDefault(dateColumn - 1)?.Value;
            if (date != releaseDate) continue;
            // A date alone reserves a slot; any other content means it belongs to another entry.
            bool occupied = inspectedColumns
                .Where(index => index != dateColumn - 1)
                .Any(index => !string.IsNullOrWhiteSpace(row.Cells.ElementAtOrDefault(index)?.Value));
            if (occupied) continue;
            if (!string.IsNullOrWhiteSpace(row.Cells.ElementAtOrDefault(idColumn - 1)?.Value)) continue;
            selected ??= row.RowNumber;
        }
        return selected;
    }

    private static bool ExactNew(WorkbookCatalogueItem item, GoogleUploadEntryRequest request) =>
        item.Title == request.Title && item.Description == request.Description
        && item.PlannedDate == request.ReleaseDate && (item.Series ?? "") == request.SeasonArc;

    internal static string NewId(GoogleUploadEntryRequest request, IReadOnlyList<WorkbookCatalogueItem> items)
    {
        static string Slug(string value) => Regex.Replace(value.ToLowerInvariant().Normalize(NormalizationForm.FormKD),
            "[^a-z0-9]+", "-").Trim('-');
        NamingHints hints = ReadNamingHints(request.FileName ?? "", request.Title);
        string title = Slug(request.Title);
        string series = Slug(request.SeasonArc);
        if (series.Length > 0)
        {
            string? siblingPrefix = InferSiblingPrefix(request.SeasonArc, items);
            if (siblingPrefix is not null) series = siblingPrefix;
        }
        if (series.Length > 0 && hints.Episode is int number)
            title = $"ep{number:00}";
        if (title.StartsWith(series + "-", StringComparison.Ordinal)) title = title[(series.Length + 1)..];
        if (title.Length == 0) title = "video";
        string basis = series.Length == 0 ? title : series + "-" + title;
        if (basis.Length > 80) basis = basis[..80].TrimEnd('-');
        string candidate = basis;
        for (int suffix = 2; items.FirstOrDefault(item => item.SourceKey == candidate) is { } collision; suffix++)
        {
            if (ExactNew(collision, request)) return candidate;
            if (collision.Title == request.Title && collision.PlannedDate == request.ReleaseDate)
                throw new GoogleCatalogueException("catalogue-new-entry-conflict");
            string ending = "-" + suffix.ToString(CultureInfo.InvariantCulture);
            candidate = basis[..Math.Min(basis.Length, 80 - ending.Length)].TrimEnd('-') + ending;
        }
        return candidate;
    }

    private sealed record NamingHints(int? Episode, int? Season);

    private static NamingHints ReadNamingHints(string fileName, string title)
    {
        List<int> episodes = [];
        List<int> seasons = [];
        foreach (string source in new[] { fileName, title })
        {
            string normalized = source.Replace('_', ' ').Replace('-', ' ');
            AddPairs(Regex.Matches(normalized,
                @"\bs\s*(\d+)\s*[. ]*e(?:p(?:isode)?)?\s*(\d+)\b",
                RegexOptions.IgnoreCase), seasons, episodes);
            AddPairs(Regex.Matches(normalized,
                @"\bseason\s*(\d+)\s+(?:ep|episode)\s*[. ]*(\d+)\b",
                RegexOptions.IgnoreCase), seasons, episodes);
            foreach (Match match in Regex.Matches(normalized,
                @"\b(?:season\s*|s\s*)(\d+)\b",
                RegexOptions.IgnoreCase))
                seasons.Add(ParseHint(match.Groups[1].Value, 99, "catalogue-invalid-season-hint"));
            foreach (Match match in Regex.Matches(normalized,
                @"\b(?:ep|episode)\s*[. ]*(\d+)\b", RegexOptions.IgnoreCase))
                episodes.Add(ParseHint(match.Groups[1].Value, 999, "catalogue-invalid-episode-hint"));
        }

        return new(
            OneConsistentHint(episodes, "catalogue-new-entry-hint-conflict"),
            OneConsistentHint(seasons, "catalogue-new-entry-hint-conflict"));
    }

    private static void AddPairs(MatchCollection matches, List<int> seasons, List<int> episodes)
    {
        foreach (Match match in matches)
        {
            seasons.Add(ParseHint(match.Groups[1].Value, 99, "catalogue-invalid-season-hint"));
            episodes.Add(ParseHint(match.Groups[2].Value, 999, "catalogue-invalid-episode-hint"));
        }
    }

    private static int ParseHint(string value, int maximum, string errorCode)
    {
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int number)
            || number < 1 || number > maximum)
            throw new GoogleCatalogueException(errorCode);
        return number;
    }

    private static int? OneConsistentHint(IEnumerable<int> values, string conflictCode)
    {
        int[] distinct = values.Distinct().ToArray();
        if (distinct.Length > 1) throw new GoogleCatalogueException(conflictCode);
        return distinct.Length == 0 ? null : distinct[0];
    }

    private static string? InferSiblingPrefix(string seasonArc, IReadOnlyList<WorkbookCatalogueItem> items)
    {
        // Only explicit terminal episode forms establish an ID convention. Shared leading words
        // and trailing numeric fragments alone are not enough evidence to replace the season slug.
        Regex suffix = new(@"^(?<prefix>.+)-(?:ep(?<episode>\d{1,3})|episode-(?<longEpisode>\d{1,3})|s(?<season>\d{1,2})e(?<seasonEpisode>\d{1,3}))$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        WorkbookCatalogueItem[] siblings = items
            .Where(item => string.Equals(item.Series, seasonArc, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (siblings.Length < 2) return null;

        string? prefix = null;
        string? convention = null;
        HashSet<int> episodes = [];
        foreach (WorkbookCatalogueItem sibling in siblings)
        {
            Match match = suffix.Match(sibling.SourceKey);
            if (!match.Success) return null;
            Group episodeGroup = match.Groups["episode"].Success
                ? match.Groups["episode"]
                : match.Groups["longEpisode"].Success
                    ? match.Groups["longEpisode"] : match.Groups["seasonEpisode"];
            if (!int.TryParse(episodeGroup.Value, NumberStyles.None, CultureInfo.InvariantCulture, out int episode)
                || episode < 1 || episode > 999
                || match.Groups["season"].Success
                    && (!int.TryParse(match.Groups["season"].Value, NumberStyles.None,
                        CultureInfo.InvariantCulture, out int season) || season < 1 || season > 99))
                return null;

            string currentPrefix = match.Groups["prefix"].Value;
            string currentConvention = match.Groups["episode"].Success ? "ep"
                : match.Groups["longEpisode"].Success ? "episode" : "season-episode";
            if (prefix is not null && (!string.Equals(prefix, currentPrefix, StringComparison.OrdinalIgnoreCase)
                || convention != currentConvention)) return null;

            if (!string.IsNullOrWhiteSpace(sibling.Episode)
                && (!int.TryParse(sibling.Episode, NumberStyles.None, CultureInfo.InvariantCulture, out int declaredEpisode)
                    || declaredEpisode != episode)) return null;
            prefix = currentPrefix;
            convention = currentConvention;
            episodes.Add(episode);
        }
        return episodes.Count >= 2 ? prefix!.ToLowerInvariant() : null;
    }

    private static void Validate(GoogleUploadEntryRequest request)
    {
        if (request.Mode is not ("new" or "update")
            || request.Title is not { Length: > 0 and <= 300 }
            || request.Description is not { Length: <= 10_000 }
            || request.Category is not { Length: <= 200 }
            || request.SeasonArc is not { Length: <= 200 }
            || request.Title.Any(char.IsControl) || request.Description.Any(c => c is '\0' or '\r')
            || request.Category.Any(char.IsControl) || request.SeasonArc.Any(char.IsControl)
            || request.ExpectedCategory is { Length: > 200 } || request.ExpectedSeasonArc is { Length: > 200 }
            || !DateOnly.TryParseExact(request.ReleaseDate, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out _))
            throw new GoogleCatalogueException("invalid-catalogue-entry");
        if (request.Mode == "new")
        {
            if (request.FileName is not { Length: > 0 and <= 255 }
                || request.FileSize is not > 0 || request.FileLastModified is not > 0)
                throw new GoogleCatalogueException("invalid-catalogue-entry");
        }
        else if (request.Id is not { Length: > 0 and <= 200 }
            || request.ExpectedTitle is null || request.ExpectedDescription is null)
            throw new GoogleCatalogueException("invalid-catalogue-entry");
    }
}
