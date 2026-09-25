using System.Globalization;
using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

// Read-only header mapping is deliberately separate from the fixed, inspected write-back profile.
internal static class GoogleCatalogueImportReader
{
    private const int MaximumHeaderRow = 20;
    private const int MaximumColumns = 24;
    private const int MaximumFetchedRow = 5002;
    private static readonly string[] Platforms =
        ["pornhubFree", "pornhubPaid", "onlyfans", "fansly", "manyvids", "x", "reddit", "clips4sale", "redgifs"];

    internal static GoogleCatalogueImportPreview Detect(GoogleWorkbookSnapshot snapshot, int? preferredSheetId = null)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        List<GoogleCatalogueImportPreview> candidates = [];
        List<GoogleCatalogueImportException> errors = [];
        GoogleSheetSnapshot[] eligible = snapshot.Sheets.Where(sheet =>
            !sheet.Hidden && (preferredSheetId is null || sheet.SheetId == preferredSheetId)).ToArray();
        GoogleSheetSnapshot[] named = eligible.Where(sheet => Regex.IsMatch(sheet.Title,
            @"(?:^|[^\p{L}\p{N}])catalog(?:ue)?(?:$|[^\p{L}\p{N}])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToArray();
        // A clearly named catalogue is authoritative; never substitute an unrelated tab when it is invalid.
        foreach (GoogleSheetSnapshot sheet in named.Length > 0 ? named : eligible)
        {
            GoogleCatalogueImportPreview? candidate = null;
            GoogleCatalogueImportException? error = null;
            int matchingHeaders = 0;
            foreach (GoogleWorkbookRowSnapshot row in sheet.Rows.Where(row => row.RowNumber is >= 1 and <= MaximumHeaderRow))
            {
                var recognized = row.Cells.Take(MaximumColumns)
                    .Select((cell, index) => (Field: Field(cell.Value), Column: index + 1))
                    .Where(cell => cell.Field is not null).ToArray();
                if (!recognized.Any(cell => cell.Field == "sourceKey") || !recognized.Any(cell => cell.Field == "title"))
                    continue;
                matchingHeaders++;
                if (recognized.GroupBy(cell => cell.Field).Any(group => group.Count() > 1)
                    || matchingHeaders > 1)
                {
                    error ??= new("catalogue-header-ambiguous", row.RowNumber);
                    continue;
                }
                candidate = new(
                    new(snapshot.WorkbookId, sheet.SheetId.ToString(CultureInfo.InvariantCulture), true, []),
                    sheet.SheetId, sheet.Title, row.RowNumber,
                    recognized.ToDictionary(cell => cell.Field!, cell => cell.Column, StringComparer.Ordinal));
            }
            if (error is not null)
                errors.Add(error);
            else if (candidate is not null)
                candidates.Add(candidate);
        }
        if (errors.Count > 0 && (named.Length > 0 || preferredSheetId is not null || candidates.Count == 0))
            throw errors[0];
        if (candidates.Count == 0)
            throw new GoogleCatalogueException("catalogue-tab-not-found");
        if (candidates.Count != 1)
            throw new GoogleCatalogueException("catalogue-tab-ambiguous");
        return candidates[0];
    }

    internal static GoogleCatalogueImportPreview Read(GoogleWorkbookSnapshot snapshot, int? preferredSheetId = null)
    {
        GoogleCatalogueImportPreview selected = Detect(snapshot, preferredSheetId);
        GoogleSheetSnapshot catalogue = snapshot.Sheets.Single(sheet => sheet.SheetId == selected.CatalogueSheetId);
        if (catalogue.RowCount > MaximumFetchedRow || catalogue.Rows.Any(row => row.RowNumber > MaximumFetchedRow))
            throw new GoogleCatalogueException("workbook-row-limit");
        List<WorkbookCatalogueItem> items = [];
        List<GoogleCatalogueImportIssue> issues = [];
        HashSet<string> keys = new(StringComparer.Ordinal);
        foreach (GoogleWorkbookRowSnapshot row in catalogue.Rows.Where(row => row.RowNumber > selected.HeaderRow).OrderBy(row => row.RowNumber))
        {
            string? sourceKey = Value(row, selected.Columns, "sourceKey");
            // Notes and blank separator rows have no source identity and are not catalogue entries.
            if (sourceKey is null)
                continue;
            string? title = Value(row, selected.Columns, "title");
            string description = Value(row, selected.Columns, "description") ?? "";
            string? series = Value(row, selected.Columns, "series");
            string? episode = Value(row, selected.Columns, "episode");
            if (sourceKey.Length > 200 || !keys.Add(sourceKey) || title is null || title.Length > 300
                || description.Length > 10_000 || series?.Length > 200 || episode?.Length > 100)
                throw new GoogleCatalogueImportException("invalid-workbook-projection", row.RowNumber);

            string? date = Value(row, selected.Columns, "plannedDate");
            if (date is not null)
            {
                if (!DateOnly.TryParseExact(date, ["yyyy-MM-dd", "dd.MM.yyyy"], CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out DateOnly parsed))
                    throw Error("invalid-workbook-date", row, selected.Columns, "plannedDate");
                date = parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            }

            SortedDictionary<string, string> links = new(StringComparer.Ordinal);
            SortedDictionary<string, CatalogueSourceLinkCell> sourceLinks = new(StringComparer.Ordinal);
            foreach (string platform in Platforms)
            {
                GoogleWorkbookCellSnapshot? cell = Cell(row, selected.Columns, platform);
                if (Text(cell?.Value) is null && Text(cell?.Hyperlink) is null)
                    continue;
                CatalogueSourceLinkCell source = ReadLinkCell(cell!, platform, row.RowNumber, selected.Columns[platform]);
                sourceLinks.Add(platform, source);
                if (source.IssueCode is not null)
                    issues.Add(new(row.RowNumber, selected.Columns[platform], source.IssueCode));
                else if (source.Urls.Count == 1)
                    links.Add(platform, source.Urls[0]);
            }
            items.Add(new(row.RowNumber, sourceKey, title, description, date, series, episode,
                Math.Max(Count(row, selected.Columns, "xTeasers"), sourceLinks.GetValueOrDefault("x")?.Urls.Count ?? 0),
                Count(row, selected.Columns, "redditTeasers"), links, null, sourceLinks));
        }
        if (items.Count > 5000)
            throw new GoogleCatalogueException("workbook-row-limit");
        if (items.Count == 0)
            throw new GoogleCatalogueException("catalogue-empty");
        return selected with { Projection = selected.Projection with { Items = items }, Issues = issues };
    }

    private static string? Field(string? header)
    {
        string key = new((header ?? "").Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        return key switch
        {
            "id" or "videoid" or "itemid" or "sourcekey" => "sourceKey",
            "title" or "name" or "videotitle" or "videoname" => "title",
            "release" or "releasedate" or "planneddate" or "publicationdate" => "plannedDate",
            "description" or "videodescription" => "description",
            "seasonarc" or "season" or "arc" or "series" => "series",
            "episode" or "episodenumber" => "episode",
            "pornhub" or "pornhublink" or "pornhubfree" or "pornhubfreelink" => "pornhubFree",
            "pornhubpaid" or "pornhubpaidlink" => "pornhubPaid",
            "onlyfans" or "onlyfanslink" or "onlyfansurl" => "onlyfans",
            "fansly" or "fanslylink" or "fanslyurl" => "fansly",
            "manyvids" or "manyvidslink" or "manyvidsurl" => "manyvids",
            "clips4sale" or "clips4salelink" or "clips4saleurl" => "clips4sale",
            "redgifs" or "redgifslink" or "redgifsurl" => "redgifs",
            "twitterteasers" or "twitterteaser" or "twitterlink" or "xlink" or "xpost" => "x",
            "redditposts" or "redditpost" or "redditlink" => header?.TrimStart().StartsWith('#') == true ? "redditTeasers" : "reddit",
            "teasers" or "xteasers" or "teasercount" or "twitterteasercount" => "xTeasers",
            "redditpostcount" or "redditcount" => "redditTeasers",
            _ => null,
        };
    }

    private static CatalogueSourceLinkCell ReadLinkCell(GoogleWorkbookCellSnapshot cell, string platform, int row, int column)
    {
        string text = cell.Value ?? "";
        string? hyperlink = Text(cell.Hyperlink);
        if (text.Length > 10_000 || cell.Hyperlink?.Length > 2048)
            throw new GoogleCatalogueImportException("invalid-workbook-projection", row, column);
        MatchCollection matches = Regex.Matches(text, @"https?://[^\s,;]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (matches.Count > 100)
            throw new GoogleCatalogueImportException("invalid-workbook-projection", row, column);
        List<string> urls = [];
        bool invalid = false;
        foreach (Match match in matches)
        {
            string? canonical = CanonicalLink(match.Value, platform);
            if (canonical is null)
                invalid = true;
            else if (!urls.Contains(canonical, StringComparer.Ordinal))
                urls.Add(canonical);
        }
        string? target = hyperlink is null ? null : CanonicalLink(hyperlink, platform);
        if (hyperlink is not null && target is null)
            invalid = true;
        bool conflict = target is not null && urls.Any(url => !string.Equals(url, target, StringComparison.Ordinal));
        if (target is not null && !urls.Contains(target, StringComparer.Ordinal))
            urls.Add(target);
        if (urls.Count > 100)
            throw new GoogleCatalogueImportException("invalid-workbook-projection", row, column);
        string? issue = invalid || urls.Count == 0 ? "invalid-workbook-link" : conflict ? "catalogue-link-conflict" : null;
        return new(text, cell.Hyperlink, urls, issue);
    }

    private static string? CanonicalLink(string candidate, string platform)
    {
        if (candidate.Length > 2048 || candidate.Any(char.IsWhiteSpace)
            || !Uri.TryCreate(candidate, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort)
            return null;
        return CatalogueSnapshotImporter.CanonicalPlatformLink(platform, uri);
    }

    private static int Count(GoogleWorkbookRowSnapshot row, IReadOnlyDictionary<string, int> columns, string field)
    {
        string? value = Value(row, columns, field);
        if (value is null)
            return 0;
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int count) || count is < 0 or > 1_000_000)
            throw Error("invalid-workbook-count", row, columns, field);
        return count;
    }

    private static GoogleCatalogueImportException Error(string code, GoogleWorkbookRowSnapshot row,
        IReadOnlyDictionary<string, int> columns, string field) => new(code, row.RowNumber, columns[field]);

    private static GoogleWorkbookCellSnapshot? Cell(GoogleWorkbookRowSnapshot row,
        IReadOnlyDictionary<string, int> columns, string field) =>
        columns.TryGetValue(field, out int column) && column <= row.Cells.Count ? row.Cells[column - 1] : null;

    private static string? Value(GoogleWorkbookRowSnapshot row, IReadOnlyDictionary<string, int> columns, string field) => Text(Cell(row, columns, field)?.Value);
    private static string? Text(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

internal sealed record GoogleCatalogueImportPreview(
    WorkbookProjection Projection,
    int CatalogueSheetId,
    string CatalogueSheetTitle,
    int HeaderRow,
    IReadOnlyDictionary<string, int> Columns,
    IReadOnlyList<GoogleCatalogueImportIssue>? Issues = null
)
{
    internal bool HasSameMapping(GoogleCatalogueImportPreview other) =>
        Projection.WorkbookId == other.Projection.WorkbookId
        && CatalogueSheetId == other.CatalogueSheetId && HeaderRow == other.HeaderRow
        && Columns.Count == other.Columns.Count
        && Columns.All(pair => other.Columns.TryGetValue(pair.Key, out int column) && column == pair.Value);
}

public sealed record GoogleCatalogueImportIssue(int Row, int? Column, string Code);

internal sealed class GoogleCatalogueImportException(string code, int rowNumber, int? column = null) : GoogleCatalogueException(code)
{
    internal int RowNumber { get; } = rowNumber;
    internal int? Column { get; } = column;
}
