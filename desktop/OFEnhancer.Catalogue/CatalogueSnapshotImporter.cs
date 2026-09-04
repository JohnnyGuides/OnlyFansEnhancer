using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

internal static class CatalogueSnapshotImporter
{
    internal const int MaximumUtf8Bytes = 5 * 1024 * 1024;
    private const int MaximumItems = 10_000;
    private const string SnapshotHashSetting = "catalogue.snapshot.sha256";
    private static readonly HashSet<string> SupportedPlatforms =
    [
        "onlyfans",
        "fansly",
        "manyvids",
        "pornhubFree",
        "pornhubPaid",
        "clips4sale",
        "x",
        "reddit",
        "redgifs",
    ];
    private static readonly JsonSerializerOptions InputJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private static readonly JsonSerializerOptions StorageJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    internal static CatalogueImportSummary Import(SqliteConnection connection, string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        if (Encoding.UTF8.GetByteCount(json) > MaximumUtf8Bytes)
            throw new CatalogueSnapshotException(
                "snapshot-too-large",
                $"Catalogue snapshot exceeds {MaximumUtf8Bytes} UTF-8 bytes."
            );

        SnapshotEnvelope envelope;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            RejectDuplicateProperties(document.RootElement);
            envelope = JsonSerializer.Deserialize<SnapshotEnvelope>(json, InputJson)
                ?? throw new CatalogueSnapshotException("invalid-snapshot", "Catalogue snapshot is empty.");
        }
        catch (CatalogueSnapshotException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw new CatalogueSnapshotException(
                "invalid-snapshot",
                "Catalogue snapshot does not match the supported schema.",
                exception
            );
        }

        IReadOnlyList<ValidatedSnapshotItem> items = Validate(envelope);
        string fingerprint = Fingerprint(items);
        string? previousFingerprint = ReadSetting(connection, SnapshotHashSetting);
        if (string.Equals(previousFingerprint, fingerprint, StringComparison.Ordinal))
        {
            (int active, int archived) = ReadCounts(connection);
            return new CatalogueImportSummary(active, archived, Unchanged: true);
        }

        string now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        using SqliteTransaction transaction = connection.BeginTransaction();
        Execute(connection, transaction, "UPDATE catalogue_items SET archived = 1, updated_utc = $now", ("$now", now));

        foreach (ValidatedSnapshotItem item in items)
        {
            string linksJson = JsonSerializer.Serialize(item.PlatformLinks, StorageJson);
            using SqliteCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                """
                INSERT INTO catalogue_items(
                    item_id, source_key, source_row, title, description, planned_date,
                    series, episode, x_teasers, reddit_teasers, platform_links_json,
                    archived, updated_utc
                ) VALUES (
                    $itemId, $sourceKey, $sourceRow, $title, $description, $plannedDate,
                    $series, $episode, $xTeasers, $redditTeasers, $links, 0, $now
                )
                ON CONFLICT(source_key) DO UPDATE SET
                    source_row = excluded.source_row,
                    title = excluded.title,
                    description = excluded.description,
                    planned_date = excluded.planned_date,
                    series = excluded.series,
                    episode = excluded.episode,
                    x_teasers = excluded.x_teasers,
                    reddit_teasers = excluded.reddit_teasers,
                    platform_links_json = excluded.platform_links_json,
                    archived = 0,
                    updated_utc = excluded.updated_utc
                """;
            command.Parameters.AddWithValue("$itemId", Guid.NewGuid().ToString("D"));
            command.Parameters.AddWithValue("$sourceKey", item.SourceKey);
            command.Parameters.AddWithValue("$sourceRow", (object?)item.SourceRow ?? DBNull.Value);
            command.Parameters.AddWithValue("$title", item.Title);
            command.Parameters.AddWithValue("$description", item.Description);
            command.Parameters.AddWithValue("$plannedDate", (object?)item.PlannedDate ?? DBNull.Value);
            command.Parameters.AddWithValue("$series", (object?)item.Series ?? DBNull.Value);
            command.Parameters.AddWithValue("$episode", (object?)item.Episode ?? DBNull.Value);
            command.Parameters.AddWithValue("$xTeasers", item.XTeasers);
            command.Parameters.AddWithValue("$redditTeasers", item.RedditTeasers);
            command.Parameters.AddWithValue("$links", linksJson);
            command.Parameters.AddWithValue("$now", now);
            command.ExecuteNonQuery();
        }

        UpsertSetting(connection, transaction, SnapshotHashSetting, fingerprint);
        (int activeItems, int archivedItems) = ReadCounts(connection, transaction);
        string details = JsonSerializer.Serialize(
            new { activeItems, archivedItems },
            StorageJson
        );
        Execute(
            connection,
            transaction,
            "INSERT INTO audit_events(occurred_utc, kind, details_json) VALUES ($now, 'catalogue-imported', $details)",
            ("$now", now),
            ("$details", details)
        );
        transaction.Commit();
        return new CatalogueImportSummary(activeItems, archivedItems, Unchanged: false);
    }

    private static IReadOnlyList<ValidatedSnapshotItem> Validate(SnapshotEnvelope envelope)
    {
        if (envelope.Version != 1 || envelope.Items is null)
            throw Invalid("Unsupported catalogue snapshot version.");
        if (envelope.Items.Count > MaximumItems)
            throw new CatalogueSnapshotException(
                "too-many-items",
                $"Catalogue snapshot contains more than {MaximumItems} items."
            );

        HashSet<string> sourceKeys = new(StringComparer.Ordinal);
        List<ValidatedSnapshotItem> result = new(envelope.Items.Count);
        foreach (SnapshotItem? candidate in envelope.Items)
        {
            if (candidate is null)
                throw Invalid("Catalogue item cannot be null.");
            SnapshotItem item = candidate;
            string sourceKey = RequiredText(item.SourceKey, 200, "sourceKey");
            if (!sourceKeys.Add(sourceKey))
                throw Invalid("Catalogue source keys must be unique.");
            if (item.SourceRow is <= 0 or > 1_000_000)
                throw Invalid("sourceRow must be a positive worksheet row.");

            string title = RequiredText(item.Title, 300, "title");
            string description = RequiredText(item.Description, 10_000, "description", allowEmpty: true);
            string? plannedDate = OptionalText(item.PlannedDate, 10, "plannedDate");
            if (
                plannedDate is not null
                && !DateOnly.TryParseExact(
                    plannedDate,
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out _
                )
            )
                throw Invalid("plannedDate must use YYYY-MM-DD.");
            string? series = OptionalText(item.Series, 200, "series");
            string? episode = OptionalText(item.Episode, 100, "episode");
            if (item.XTeasers is null || item.RedditTeasers is null)
                throw Invalid("Teaser counts are required.");
            if (item.XTeasers.Value < 0 || item.RedditTeasers.Value < 0)
                throw Invalid("Teaser counts cannot be negative.");
            if (item.XTeasers.Value > 1_000_000 || item.RedditTeasers.Value > 1_000_000)
                throw Invalid("Teaser counts are unreasonably large.");
            if (item.PlatformLinks is null || item.PlatformLinks.Count > SupportedPlatforms.Count)
                throw Invalid("platformLinks is missing or too large.");

            SortedDictionary<string, string> links = new(StringComparer.Ordinal);
            foreach ((string platform, string? value) in item.PlatformLinks)
            {
                if (!SupportedPlatforms.Contains(platform))
                    throw Invalid($"Unsupported platform: {platform}");
                string url = RequiredText(value, 2_048, $"platformLinks.{platform}");
                if (
                    !Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed)
                    || parsed.Scheme != Uri.UriSchemeHttps
                    || !string.IsNullOrEmpty(parsed.UserInfo)
                    || string.IsNullOrWhiteSpace(parsed.Host)
                    || !parsed.IsDefaultPort
                )
                    throw Invalid(
                        $"Platform link for {platform} must use its canonical credential-free HTTPS post URL."
                    );
                string? canonical = CanonicalPlatformLink(platform, parsed);
                if (canonical is null)
                    throw Invalid(
                        $"Platform link for {platform} must use its canonical credential-free HTTPS post URL."
                    );
                links.Add(platform, canonical);
            }

            result.Add(
                new ValidatedSnapshotItem(
                    sourceKey,
                    item.SourceRow,
                    title,
                    description,
                    plannedDate,
                    series,
                    episode,
                    item.XTeasers.Value,
                    item.RedditTeasers.Value,
                    links
                )
            );
        }
        return result;
    }

    internal static string? CanonicalPlatformLink(string platform, Uri uri) =>
        platform switch
        {
            "onlyfans" => CanonicalPath(
                uri,
                "onlyfans.com",
                @"^/(?<id>[0-9]{1,30})(?:/(?<handle>[A-Za-z0-9._]{1,64}))?/?$",
                match =>
                    $"https://onlyfans.com/{match.Groups["id"].Value}"
                    + (match.Groups["handle"].Success ? $"/{match.Groups["handle"].Value}" : "")
            ),
            "fansly" => CanonicalPath(
                uri,
                "fansly.com",
                @"^/post/(?<id>[0-9]{1,30})/?$",
                match => $"https://fansly.com/post/{match.Groups["id"].Value}"
            ),
            "manyvids" => CanonicalPath(
                uri,
                "www.manyvids.com",
                @"^/Video/(?<id>[0-9]{1,30})(?:/[A-Za-z0-9_-]+)?/?$",
                match => $"https://www.manyvids.com/Video/{match.Groups["id"].Value}",
                ignoreCase: true
            ),
            "pornhubFree" or "pornhubPaid" => CanonicalPornhub(uri),
            "clips4sale" => CanonicalPath(
                uri,
                ["clips4sale.com", "www.clips4sale.com"],
                @"^/studio/(?<studio>[0-9]{1,20})/(?<clip>[0-9]{1,20})(?:/(?<slug>[A-Za-z0-9_-]+))?/?$",
                match =>
                    $"https://www.clips4sale.com/studio/{match.Groups["studio"].Value}/{match.Groups["clip"].Value}"
                    + (match.Groups["slug"].Success ? $"/{match.Groups["slug"].Value}" : ""),
                ignoreCase: true
            ),
            "x" => CanonicalPath(
                uri,
                "x.com",
                @"^/(?<handle>[A-Za-z0-9_]{1,15})/status/(?<id>[0-9]{1,30})/?$",
                match =>
                    string.Equals(match.Groups["handle"].Value, "i", StringComparison.OrdinalIgnoreCase)
                        ? null
                        : $"https://x.com/{match.Groups["handle"].Value}/status/{match.Groups["id"].Value}"
            ),
            "reddit" => CanonicalPath(
                uri,
                "www.reddit.com",
                @"^/r/(?<subreddit>[A-Za-z0-9_]{2,21})/comments/(?<id>[A-Za-z0-9]{3,12})/(?<slug>[A-Za-z0-9_-]+)/?$",
                match =>
                    $"https://www.reddit.com/r/{match.Groups["subreddit"].Value}/comments/{match.Groups["id"].Value.ToLowerInvariant()}/{match.Groups["slug"].Value}"
            ),
            "redgifs" => CanonicalPath(
                uri,
                ["redgifs.com", "www.redgifs.com"],
                @"^/watch/(?<slug>[A-Za-z0-9-]{2,100})/?$",
                match => $"https://www.redgifs.com/watch/{match.Groups["slug"].Value}"
            ),
            _ => null,
        };

    private static string? CanonicalPornhub(Uri uri)
    {
        if (
            !string.Equals(uri.IdnHost, "www.pornhub.com", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(uri.AbsolutePath, "/view_video.php", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.Fragment)
        )
            return null;
        Match match = Regex.Match(
            uri.Query,
            @"^\?viewkey=(?<id>[A-Za-z0-9_-]{1,100})$",
            RegexOptions.CultureInvariant
        );
        return match.Success
            ? $"https://www.pornhub.com/view_video.php?viewkey={match.Groups["id"].Value}"
            : null;
    }

    private static string? CanonicalPath(
        Uri uri,
        string host,
        string pattern,
        Func<Match, string?> format,
        bool ignoreCase = false
    ) => CanonicalPath(uri, [host], pattern, format, ignoreCase);

    private static string? CanonicalPath(
        Uri uri,
        IReadOnlyList<string> hosts,
        string pattern,
        Func<Match, string?> format,
        bool ignoreCase = false
    )
    {
        if (
            !hosts.Any(host => string.Equals(uri.IdnHost, host, StringComparison.OrdinalIgnoreCase))
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
        )
            return null;
        RegexOptions options = RegexOptions.CultureInvariant;
        if (ignoreCase)
            options |= RegexOptions.IgnoreCase;
        Match match = Regex.Match(uri.AbsolutePath, pattern, options);
        return match.Success ? format(match) : null;
    }

    private static string Fingerprint(IReadOnlyList<ValidatedSnapshotItem> items)
    {
        var canonical = items
            .OrderBy(item => item.SourceKey, StringComparer.Ordinal)
            .Select(item => new
            {
                item.SourceKey,
                item.SourceRow,
                item.Title,
                item.Description,
                item.PlannedDate,
                item.Series,
                item.Episode,
                item.XTeasers,
                item.RedditTeasers,
                item.PlatformLinks,
            });
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(canonical, StorageJson);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    private static string RequiredText(
        string? value,
        int maximumLength,
        string field,
        bool allowEmpty = false
    )
    {
        if (value is null)
            throw Invalid($"{field} is required.");
        string trimmed = value.Trim();
        if ((!allowEmpty && trimmed.Length == 0) || trimmed.Length > maximumLength)
            throw Invalid($"{field} is empty or too long.");
        return trimmed;
    }

    private static string? OptionalText(string? value, int maximumLength, string field)
    {
        if (value is null)
            return null;
        string trimmed = value.Trim();
        if (trimmed.Length == 0)
            return null;
        if (trimmed.Length > maximumLength)
            throw Invalid($"{field} is too long.");
        return trimmed;
    }

    private static CatalogueSnapshotException Invalid(string message) =>
        new("invalid-snapshot", message);

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            HashSet<string> names = new(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw Invalid($"Duplicate JSON property: {property.Name}");
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
                RejectDuplicateProperties(item);
        }
    }

    private static string? ReadSetting(SqliteConnection connection, string key)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key = $key";
        command.Parameters.AddWithValue("$key", key);
        return command.ExecuteScalar() as string;
    }

    private static void UpsertSetting(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string key,
        string value
    ) =>
        Execute(
            connection,
            transaction,
            "INSERT INTO settings(key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("$key", key),
            ("$value", value)
        );

    private static (int Active, int Archived) ReadCounts(
        SqliteConnection connection,
        SqliteTransaction? transaction = null
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT sum(CASE WHEN archived = 0 THEN 1 ELSE 0 END), sum(CASE WHEN archived = 1 THEN 1 ELSE 0 END) FROM catalogue_items";
        using SqliteDataReader reader = command.ExecuteReader();
        reader.Read();
        int active = reader.IsDBNull(0) ? 0 : reader.GetInt32(0);
        int archived = reader.IsDBNull(1) ? 0 : reader.GetInt32(1);
        return (active, archived);
    }

    private static void Execute(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sql,
        params (string Name, object Value)[] parameters
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach ((string name, object value) in parameters)
            command.Parameters.AddWithValue(name, value);
        command.ExecuteNonQuery();
    }

    private sealed record SnapshotEnvelope(int Version, IReadOnlyList<SnapshotItem?>? Items);

    private sealed record SnapshotItem(
        string? SourceKey,
        int? SourceRow,
        string? Title,
        string? Description,
        string? PlannedDate,
        string? Series,
        string? Episode,
        int? XTeasers,
        int? RedditTeasers,
        IReadOnlyDictionary<string, string?>? PlatformLinks
    );

    private sealed record ValidatedSnapshotItem(
        string SourceKey,
        int? SourceRow,
        string Title,
        string Description,
        string? PlannedDate,
        string? Series,
        string? Episode,
        int XTeasers,
        int RedditTeasers,
        IReadOnlyDictionary<string, string> PlatformLinks
    );
}

public sealed partial class CatalogueStore
{
    public CatalogueImportSummary ImportSnapshot(string json) =>
        CatalogueSnapshotImporter.Import(connection, json);

    public IReadOnlyList<CatalogueItemSummary> GetItems(bool includeArchived = false)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT item_id, source_key, source_row, title, description, planned_date,
                   series, episode, x_teasers, reddit_teasers, platform_links_json, archived
            FROM catalogue_items
            WHERE $includeArchived = 1 OR archived = 0
            ORDER BY CASE WHEN planned_date IS NULL THEN 1 ELSE 0 END, planned_date, title, item_id
            """;
        command.Parameters.AddWithValue("$includeArchived", includeArchived ? 1 : 0);
        using SqliteDataReader reader = command.ExecuteReader();
        List<CatalogueItemSummary> items = [];
        while (reader.Read())
        {
            Dictionary<string, string> links =
                JsonSerializer.Deserialize<Dictionary<string, string>>(reader.GetString(10))
                ?? [];
            items.Add(
                new CatalogueItemSummary(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.IsDBNull(2) ? null : reader.GetInt32(2),
                    reader.GetString(3),
                    reader.GetString(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5),
                    reader.IsDBNull(6) ? null : reader.GetString(6),
                    reader.IsDBNull(7) ? null : reader.GetString(7),
                    reader.GetInt32(8),
                    reader.GetInt32(9),
                    links,
                    reader.GetInt32(11) == 1
                )
            );
        }
        return items;
    }
}
