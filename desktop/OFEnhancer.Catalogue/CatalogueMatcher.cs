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
        (MediaAssetSummary Asset, string Stem)[] unboundStems =
        [
            .. assets
                .Where(asset => asset.BoundItemId is null)
                .Select(asset => (asset, Path.GetFileNameWithoutExtension(asset.FileName))),
        ];
        for (int index = 0; index < items.Count; index++)
        {
            CatalogueItemSummary item = items[index];
            if (primaryAssets.TryGetValue(item.ItemId, out string? assetId))
                items[index] = item with { ThumbnailAssetId = assetId, ThumbnailStatus = "bound" };
            else
            {
                string prefix = item.SourceKey + "_";
                MediaAssetSummary? preview = unboundStems
                    .Where(entry => entry.Stem == item.SourceKey
                        || entry.Stem.StartsWith(prefix, StringComparison.Ordinal))
                    .OrderBy(entry => entry.Stem == item.SourceKey ? 0 : 1)
                    .ThenBy(entry => entry.Asset.FileName, StringComparer.Ordinal)
                    .Select(entry => entry.Asset)
                    .FirstOrDefault();
                items[index] = item with
                {
                    ThumbnailAssetId = preview?.AssetId,
                    ThumbnailStatus = preview is null ? "missing" : "suggested",
                };
            }
        }

        List<UnmatchedAssetSummary> unmatched = [];
        ItemFeatures[] features = BuildFeatures(items);
        foreach ((MediaAssetSummary asset, _) in unboundStems)
        {
            IReadOnlyList<CatalogueCandidate> candidates = Rank(asset.FileName, features);
            unmatched.Add(new UnmatchedAssetSummary(asset.AssetId, asset.FileName, asset.Role, candidates));
        }

        string status = store.ConfiguredThumbnailRoot is null
            ? "not-scanned"
            : assets.Length == 0
                ? "empty"
                : "ready";
        return new CatalogueView(items, unmatched, assets.Length, status);
    }

    internal static IReadOnlyList<CatalogueCandidate> Rank(
        string fileName,
        IReadOnlyList<CatalogueItemSummary> items
    ) => Rank(fileName, BuildFeatures(items));

    private static IReadOnlyList<CatalogueCandidate> Rank(string fileName, ItemFeatures[] items)
    {
        HashSet<string> fileTokens = Tokens(Path.GetFileNameWithoutExtension(fileName));
        DateOnly? fileDate = ExtractDate(fileName);
        return items
            .Select(features => new { Item = features.Item, Score = Score(fileTokens, fileDate, features) })
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
        ItemFeatures features
    )
    {
        int score = 0;
        if (features.SourceTokens.Count > 0 && features.SourceTokens.All(fileTokens.Contains))
            score += 100;
        score += features.TitleTokens.Count(fileTokens.Contains) * 12;
        score += features.SeriesTokens.Count(fileTokens.Contains) * 10;
        if (features.EpisodeTokens.Count > 0 && features.EpisodeTokens.All(fileTokens.Contains))
            score += 30;
        if (features.Item.PlannedDate is not null)
        {
            if (fileTokens.Contains(features.Item.PlannedDate) || fileTokens.Contains(features.CompactDate!))
                score += 10;
            if (fileDate is not null && features.PlannedDay is not null)
            {
                int distance = Math.Abs(features.PlannedDay.Value.DayNumber - fileDate.Value.DayNumber);
                score += Math.Max(0, 30 - distance);
            }
        }
        return score;
    }

    private static ItemFeatures[] BuildFeatures(IReadOnlyList<CatalogueItemSummary> items)
    {
        ItemFeatures[] result = new ItemFeatures[items.Count];
        for (int index = 0; index < items.Count; index++)
        {
            CatalogueItemSummary item = items[index];
            string? compactDate = item.PlannedDate?.Replace("-", "", StringComparison.Ordinal);
            DateOnly? plannedDay = null;
            if (
                item.PlannedDate is not null
                && DateOnly.TryParseExact(
                    item.PlannedDate,
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out DateOnly parsed
                )
            )
                plannedDay = parsed;
            result[index] = new ItemFeatures(
                item,
                Tokens(item.SourceKey),
                Tokens(item.Title),
                Tokens(item.Series),
                Tokens(item.Episode),
                compactDate,
                plannedDay
            );
        }
        return result;
    }

    private sealed record ItemFeatures(
        CatalogueItemSummary Item,
        HashSet<string> SourceTokens,
        HashSet<string> TitleTokens,
        HashSet<string> SeriesTokens,
        HashSet<string> EpisodeTokens,
        string? CompactDate,
        DateOnly? PlannedDay
    );

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
