using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

internal static partial class CatalogueMatcher
{
    internal static CatalogueView BuildView(CatalogueStore store)
    {
        List<CatalogueItemSummary> items = [.. store.GetItems()];
        Dictionary<string, string> primaryAssets = ReadPrimaryAssets(store.Connection);
        MediaAssetSummary[] assets = [.. store.GetAssets()];
        for (int index = 0; index < items.Count; index++)
        {
            CatalogueItemSummary item = items[index];
            if (primaryAssets.TryGetValue(item.ItemId, out string? assetId))
                items[index] = item with { ThumbnailAssetId = assetId, ThumbnailStatus = "bound" };
            else
            {
                MediaAssetSummary? preview = assets
                    .Where(asset => asset.BoundItemId is null
                        && (Path.GetFileNameWithoutExtension(asset.FileName) == item.SourceKey
                            || Path.GetFileNameWithoutExtension(asset.FileName).StartsWith(item.SourceKey + "_", StringComparison.Ordinal)))
                    .OrderBy(asset => Path.GetFileNameWithoutExtension(asset.FileName) == item.SourceKey ? 0 : 1)
                    .ThenBy(asset => asset.FileName, StringComparer.Ordinal)
                    .FirstOrDefault();
                items[index] = item with
                {
                    ThumbnailAssetId = preview?.AssetId,
                    ThumbnailStatus = preview is null ? "missing" : "suggested",
                };
            }
        }

        List<UnmatchedAssetSummary> unmatched = [];
        foreach (MediaAssetSummary asset in store.GetAssets().Where(asset => asset.BoundItemId is null))
        {
            IReadOnlyList<CatalogueCandidate> candidates = Rank(asset.FileName, items);
            unmatched.Add(new UnmatchedAssetSummary(asset.AssetId, asset.FileName, asset.Role, candidates));
        }

        string status = store.ConfiguredThumbnailRoot is null
            ? "not-scanned"
            : store.GetAssets().Count == 0
                ? "empty"
                : "ready";
        return new CatalogueView(items, unmatched, store.GetAssets().Count, status);
    }

    internal static IReadOnlyList<CatalogueCandidate> Rank(
        string fileName,
        IReadOnlyList<CatalogueItemSummary> items
    )
    {
        HashSet<string> fileTokens = Tokens(Path.GetFileNameWithoutExtension(fileName));
        DateOnly? fileDate = ExtractDate(fileName);
        return items
            .Select(item => new { Item = item, Score = Score(fileTokens, fileDate, item) })
            .Where(result => result.Score > 0)
            .OrderByDescending(result => result.Score)
            .ThenBy(result => result.Item.ItemId, StringComparer.Ordinal)
            .Take(5)
            .Select(result =>
                new CatalogueCandidate(
                    result.Item.ItemId,
                    result.Item.Title,
                    result.Item.PlannedDate,
                    result.Score,
                    result.Item.ThumbnailAssetId
                )
            )
            .ToArray();
    }

    private static int Score(
        HashSet<string> fileTokens,
        DateOnly? fileDate,
        CatalogueItemSummary item
    )
    {
        int score = 0;
        HashSet<string> sourceTokens = Tokens(item.SourceKey);
        if (sourceTokens.Count > 0 && sourceTokens.All(fileTokens.Contains))
            score += 100;
        score += Tokens(item.Title).Count(fileTokens.Contains) * 12;
        score += Tokens(item.Series).Count(fileTokens.Contains) * 10;
        HashSet<string> episodeTokens = Tokens(item.Episode);
        if (episodeTokens.Count > 0 && episodeTokens.All(fileTokens.Contains))
            score += 30;
        if (item.PlannedDate is not null)
        {
            string compactDate = item.PlannedDate.Replace("-", "", StringComparison.Ordinal);
            if (fileTokens.Contains(item.PlannedDate) || fileTokens.Contains(compactDate))
                score += 10;
            if (
                fileDate is not null
                && DateOnly.TryParseExact(
                    item.PlannedDate,
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out DateOnly plannedDate
                )
            )
            {
                int distance = Math.Abs(plannedDate.DayNumber - fileDate.Value.DayNumber);
                score += Math.Max(0, 30 - distance);
            }
        }
        return score;
    }

    private static DateOnly? ExtractDate(string fileName)
    {
        Match match = DatePattern().Match(Path.GetFileNameWithoutExtension(fileName));
        if (!match.Success)
            return null;
        string value = $"{match.Groups[1].Value}-{match.Groups[2].Value}-{match.Groups[3].Value}";
        return DateOnly.TryParseExact(
            value,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out DateOnly date
        )
            ? date
            : null;
    }

    private static HashSet<string> Tokens(string? value)
    {
        HashSet<string> result = new(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(value))
            return result;
        string decomposed = value.Normalize(NormalizationForm.FormD).ToLowerInvariant();
        StringBuilder clean = new(decomposed.Length);
        foreach (char character in decomposed)
        {
            UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(character);
            if (category != UnicodeCategory.NonSpacingMark)
                clean.Append(character);
        }
        foreach (Match match in TokenPattern().Matches(clean.ToString()))
        {
            string token = match.Value;
            if (token is not ("thumb" or "thumbnail" or "cover" or "33" or "4k"))
                result.Add(token);
        }
        return result;
    }

    private static Dictionary<string, string> ReadPrimaryAssets(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT b.item_id, a.asset_id
            FROM asset_bindings b
            JOIN media_assets a ON a.asset_id = b.asset_id AND a.available = 1
            ORDER BY b.item_id,
                     CASE a.role WHEN 'curated' THEN 0 WHEN 'pornhub-33' THEN 1 ELSE 2 END,
                     a.file_name COLLATE NOCASE,
                     a.asset_id
            """;
        using SqliteDataReader reader = command.ExecuteReader();
        Dictionary<string, string> result = new(StringComparer.Ordinal);
        while (reader.Read())
            result.TryAdd(reader.GetString(0), reader.GetString(1));
        return result;
    }

    [GeneratedRegex("[a-z0-9]+", RegexOptions.CultureInvariant)]
    private static partial Regex TokenPattern();

    [GeneratedRegex(@"(?<!\d)(\d{4})[-_]?([01]\d)[-_]?([0-3]\d)(?!\d)", RegexOptions.CultureInvariant)]
    private static partial Regex DatePattern();
}

public sealed partial class CatalogueStore
{
    public CatalogueView GetCatalogue() => CatalogueMatcher.BuildView(this);

    public BindingSummary ConfirmAssetBinding(string assetId, string itemId)
    {
        if (!Guid.TryParse(assetId, out _) || !Guid.TryParse(itemId, out _))
            throw new CatalogueBindingException("invalid-binding", "Asset and catalogue IDs are invalid.");

        string? existing = null;
        using (SqliteCommand lookup = connection.CreateCommand())
        {
            lookup.CommandText =
                """
                SELECT b.item_id
                FROM media_assets a
                LEFT JOIN asset_bindings b ON b.asset_id = a.asset_id
                WHERE a.asset_id = $assetId AND a.available = 1
                """;
            lookup.Parameters.AddWithValue("$assetId", assetId);
            object? value = lookup.ExecuteScalar();
            if (value is null)
                throw new CatalogueBindingException("asset-not-found", "Thumbnail is unavailable.");
            existing = value is DBNull ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }
        using (SqliteCommand itemLookup = connection.CreateCommand())
        {
            itemLookup.CommandText =
                "SELECT count(*) FROM catalogue_items WHERE item_id = $itemId AND archived = 0";
            itemLookup.Parameters.AddWithValue("$itemId", itemId);
            if (Convert.ToInt32(itemLookup.ExecuteScalar(), CultureInfo.InvariantCulture) != 1)
                throw new CatalogueBindingException("item-not-found", "Catalogue item is unavailable.");
        }

        if (string.Equals(existing, itemId, StringComparison.Ordinal))
            return new BindingSummary(assetId, itemId, Changed: false);

        string now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        using SqliteTransaction transaction = connection.BeginTransaction();
        using (SqliteCommand command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText =
                """
                INSERT INTO asset_bindings(asset_id, item_id, confirmed_utc, evidence)
                VALUES ($assetId, $itemId, $now, 'user-confirmed')
                ON CONFLICT(asset_id) DO UPDATE SET
                    item_id = excluded.item_id,
                    confirmed_utc = excluded.confirmed_utc,
                    evidence = excluded.evidence
                """;
            command.Parameters.AddWithValue("$assetId", assetId);
            command.Parameters.AddWithValue("$itemId", itemId);
            command.Parameters.AddWithValue("$now", now);
            command.ExecuteNonQuery();
        }
        using (SqliteCommand audit = connection.CreateCommand())
        {
            audit.Transaction = transaction;
            audit.CommandText =
                "INSERT INTO audit_events(occurred_utc, kind, item_id, asset_id, details_json) VALUES ($now, 'asset-bound', $itemId, $assetId, $details)";
            audit.Parameters.AddWithValue("$now", now);
            audit.Parameters.AddWithValue("$itemId", itemId);
            audit.Parameters.AddWithValue("$assetId", assetId);
            audit.Parameters.AddWithValue("$details", JsonSerializer.Serialize(new { previousItemId = existing }));
            audit.ExecuteNonQuery();
        }
        transaction.Commit();
        return new BindingSummary(assetId, itemId, Changed: true);
    }
}

public sealed class CatalogueBindingException : Exception
{
    public CatalogueBindingException(string code, string message)
        : base(message) => Code = code;

    public string Code { get; }
}
