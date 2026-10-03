using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XArchiveImportResult(
    bool Applied,
    int ArchivePosts,
    int DuplicateArchiveRows,
    int MissingPosts,
    int ExistingPosts,
    int ImportedPosts,
    int RowsMissingLikes,
    int RowsMissingReposts,
    string? OldestPostUtc,
    string? NewestPostUtc);

public sealed partial class CatalogueStore
{
    private sealed record ArchivePost(string Id, DateTimeOffset Posted, string Text, string? ReplyTo,
        bool IsRetweet, IReadOnlyList<XObservedMedia> Media, IReadOnlyList<string> Urls);
    private static readonly Regex ArchiveTweetPart = new("^tweets-part(?<part>[0-9]+)\\.js$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private const int MaxArchiveBytes = 256 * 1024 * 1024;

    /// <summary>Imports missing owner posts from a standard Twitter/X archive without inventing metric sample times.</summary>
    public XArchiveImportResult ImportXArchive(string folder, DateTimeOffset now, bool apply)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
            throw new XObservationException("archive-folder-invalid");
        XStoredOwner? owner = GetXOwner();
        if (owner?.AccountId is null) throw new XObservationException("archive-owner-not-established");

        string data = Path.Combine(Path.GetFullPath(folder), "data");
        string accountFile = Path.Combine(data, "account.js");
        if (!File.Exists(accountFile)) throw new XObservationException("archive-account-missing");
        string accountId = ReadAccountId(accountFile);
        if (!string.Equals(accountId, owner.AccountId, StringComparison.Ordinal))
            throw new XObservationException("x-owner-mismatch");

        string[] files = Directory.GetFiles(data, "*.js", SearchOption.TopDirectoryOnly)
            .Where(path => IsTweetFile(Path.GetFileName(path)))
            .OrderBy(path => PartNumber(Path.GetFileName(path)))
            .ThenBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (files.Length == 0) throw new XObservationException("archive-tweets-missing");

        var posts = new Dictionary<string, ArchivePost>(StringComparer.Ordinal);
        int duplicateRows = 0, missingLikes = 0, missingReposts = 0;
        foreach (string file in files)
        {
            JsonDocument doc = ParseYtdFile(file, "tweets");
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Array)
                    throw new XObservationException("archive-json-invalid");
                foreach (JsonElement item in doc.RootElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("tweet", out JsonElement tweet)
                        || tweet.ValueKind != JsonValueKind.Object)
                        throw new XObservationException("archive-tweet-invalid");
                    ArchivePost post = ParsePost(tweet);
                    if (posts.TryGetValue(post.Id, out ArchivePost? prior))
                    {
                        if (!Equivalent(prior, post)) throw new XObservationException("archive-duplicate-conflict");
                        duplicateRows++;
                    }
                    else
                    {
                        posts.Add(post.Id, post);
                        if (!HasCount(tweet, "favorite_count", "like_count")) missingLikes++;
                        if (!HasCount(tweet, "retweet_count", "repost_count")) missingReposts++;
                    }
                }
            }
        }
        if (posts.Count == 0) throw new XObservationException("archive-tweets-empty");

        string? oldest = posts.Values.MinBy(post => post.Posted)!.Posted.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        string? newest = posts.Values.MaxBy(post => post.Posted)!.Posted.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        string importedAt = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        int existing = 0, imported = 0;
        int missing = 0;
        using SqliteTransaction transaction = connection.BeginTransaction();
        foreach (ArchivePost post in posts.Values)
        {
            using SqliteCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT OR IGNORE INTO x_posts
                    (status_id, author_id, posted_utc, text, in_reply_to, conversation_id, is_retweet,
                     media_json, urls_json, first_seen_utc, last_seen_utc)
                VALUES ($id, $author, $posted, $text, $reply, NULL, $retweet, $media, $urls, $seen, $seen)
                """;
            command.Parameters.AddWithValue("$id", post.Id);
            command.Parameters.AddWithValue("$author", owner.AccountId);
            command.Parameters.AddWithValue("$posted", post.Posted.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            command.Parameters.AddWithValue("$text", post.IsRetweet ? string.Empty : post.Text);
            command.Parameters.AddWithValue("$reply", (object?)post.ReplyTo ?? DBNull.Value);
            command.Parameters.AddWithValue("$retweet", post.IsRetweet ? 1 : 0);
            command.Parameters.AddWithValue("$media", post.IsRetweet ? "[]" : JsonSerializer.Serialize(post.Media, XJson));
            command.Parameters.AddWithValue("$urls", post.IsRetweet ? "[]" : JsonSerializer.Serialize(post.Urls, XJson));
            command.Parameters.AddWithValue("$seen", importedAt);
            if (apply) imported += command.ExecuteNonQuery();
            else
            {
                command.CommandText = "SELECT 1 FROM x_posts WHERE status_id = $id";
                bool found = command.ExecuteScalar() is not null;
                existing += found ? 1 : 0;
                missing += found ? 0 : 1;
            }
        }
        if (apply)
        {
            missing = imported;
            existing = posts.Count - imported;
            transaction.Commit();
        }
        else transaction.Rollback();

        return new(apply, posts.Count, duplicateRows, missing, existing, imported, missingLikes, missingReposts, oldest, newest);
    }

    private static bool IsTweetFile(string name) =>
        name.Equals("tweets.js", StringComparison.OrdinalIgnoreCase)
        || name.Equals("tweet.js", StringComparison.OrdinalIgnoreCase)
        || ArchiveTweetPart.IsMatch(name);

    private static int PartNumber(string name)
    {
        Match match = ArchiveTweetPart.Match(name);
        return match.Success && int.TryParse(match.Groups["part"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int n)
            ? n : -1;
    }

    private static string ReadAccountId(string path)
    {
        using JsonDocument doc = ParseYtdFile(path, "account");
        if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() != 1)
            throw new XObservationException("archive-account-invalid");
        JsonElement root = doc.RootElement[0];
        if (!root.TryGetProperty("account", out JsonElement account) || account.ValueKind != JsonValueKind.Object
            || !TryString(account, "accountId", out string? id) || id is null
            || !Regex.IsMatch(id, "^[0-9]{1,25}$", RegexOptions.CultureInvariant))
            throw new XObservationException("archive-account-invalid");
        return id;
    }

    private static JsonDocument ParseYtdFile(string path, string kind)
    {
        try
        {
            var info = new FileInfo(path);
            if (info.Length is <= 0 or > MaxArchiveBytes) throw new XObservationException("archive-file-size-invalid");
            string raw = File.ReadAllText(path);
            Match prefix = Regex.Match(raw, $@"^\s*window\.YTD\.{Regex.Escape(kind)}\.part[0-9]+\s*=\s*", RegexOptions.CultureInvariant);
            if (!prefix.Success) throw new XObservationException("archive-assignment-invalid");
            string json = raw[prefix.Length..].Trim();
            if (json.EndsWith(';')) json = json[..^1].TrimEnd();
            return JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 64 });
        }
        catch (XObservationException) { throw; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or DecoderFallbackException)
        {
            throw new XObservationException("archive-json-invalid");
        }
    }

    private static ArchivePost ParsePost(JsonElement tweet)
    {
        if (!TryString(tweet, "id_str", out string? id) || id is null
            || !Regex.IsMatch(id, "^[0-9]{1,25}$", RegexOptions.CultureInvariant)
            || !TryString(tweet, "created_at", out string? created) || created is null
            || !TryArchiveDate(created, out DateTimeOffset posted))
            throw new XObservationException("archive-tweet-invalid");
        string? text = null;
        if (!TryString(tweet, "full_text", out text) && !TryString(tweet, "text", out text))
            throw new XObservationException("archive-tweet-invalid");
        text ??= string.Empty;
        if (text.Length > MaxXText) throw new XObservationException("archive-tweet-too-large");
        string? reply = null;
        if (TryString(tweet, "in_reply_to_status_id_str", out string? replyValue))
        {
            if (replyValue is { Length: > 0 } && !Regex.IsMatch(replyValue, "^[0-9]{1,25}$", RegexOptions.CultureInvariant))
                throw new XObservationException("archive-tweet-invalid");
            reply = string.IsNullOrEmpty(replyValue) ? null : replyValue;
        }
        bool retweet = (tweet.TryGetProperty("retweeted_status", out JsonElement rt) && rt.ValueKind is not JsonValueKind.Null and not JsonValueKind.False)
            || (tweet.TryGetProperty("retweeted_status_id_str", out JsonElement rtId) && rtId.ValueKind == JsonValueKind.String);
        return new(id, posted, text, reply, retweet, ReadMedia(tweet), ReadUrls(tweet));
    }

    private static bool HasCount(JsonElement tweet, params string[] names) => names.Any(name =>
        tweet.TryGetProperty(name, out JsonElement value) && TryNonNegativeLong(value, out _));

    private static bool Equivalent(ArchivePost left, ArchivePost right) =>
        left.Id == right.Id && left.Posted == right.Posted && left.Text == right.Text && left.ReplyTo == right.ReplyTo
        && left.IsRetweet == right.IsRetweet && left.Media.SequenceEqual(right.Media) && left.Urls.SequenceEqual(right.Urls);

    private static bool TryArchiveDate(string value, out DateTimeOffset posted)
    {
        string normalized = Regex.Replace(value, "([+-][0-9]{2})([0-9]{2})(?= [0-9]{4}$)", "$1:$2", RegexOptions.CultureInvariant);
        return DateTimeOffset.TryParseExact(normalized, "ddd MMM dd HH:mm:ss zzz yyyy", CultureInfo.InvariantCulture,
                   DateTimeStyles.AssumeUniversal, out posted)
            || DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out posted);
    }

    private static bool TryNonNegativeLong(JsonElement value, out long result)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out result)) return result >= 0;
        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out result)) return result >= 0;
        result = 0;
        return false;
    }

    private static IReadOnlyList<XObservedMedia> ReadMedia(JsonElement tweet)
    {
        if (!tweet.TryGetProperty("extended_entities", out JsonElement extended)
            || extended.ValueKind != JsonValueKind.Object
            || !extended.TryGetProperty("media", out JsonElement items)
            || items.ValueKind != JsonValueKind.Array) return [];
        if (items.GetArrayLength() > 4) throw new XObservationException("archive-tweet-invalid");
        var media = new List<XObservedMedia>();
        foreach (JsonElement item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw new XObservationException("archive-tweet-invalid");
            if (!TryString(item, "type", out string? type) || type is not ("video" or "photo" or "animated_gif"))
                continue;
            string? poster = null;
            if (TryString(item, "media_url_https", out string? url) && url is not null
                && Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)
                && uri.Scheme == Uri.UriSchemeHttps && uri.Host.Equals("pbs.twimg.com", StringComparison.OrdinalIgnoreCase))
                poster = uri.ToString();
            long? duration = null;
            if (item.TryGetProperty("video_info", out JsonElement video) && video.ValueKind == JsonValueKind.Object
                && video.TryGetProperty("duration_millis", out JsonElement durationValue)
                && TryNonNegativeLong(durationValue, out long millis) && millis <= 86_400_000)
                duration = millis;
            media.Add(new(type, null, duration, poster));
        }
        return media;
    }

    private static IReadOnlyList<string> ReadUrls(JsonElement tweet)
    {
        if (!tweet.TryGetProperty("entities", out JsonElement entities) || entities.ValueKind != JsonValueKind.Object
            || !entities.TryGetProperty("urls", out JsonElement items) || items.ValueKind != JsonValueKind.Array) return [];
        var urls = new List<string>();
        foreach (JsonElement item in items.EnumerateArray())
        {
            if (urls.Count == 5) break;
            if (item.ValueKind != JsonValueKind.Object) continue;
            if (!TryString(item, "expanded_url", out string? value) || value is null || value.Length > 1024
                || !Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) continue;
            urls.Add(uri.ToString());
        }
        return urls;
    }

    private static bool TryString(JsonElement value, string name, out string? result)
    {
        if (value.TryGetProperty(name, out JsonElement property) && property.ValueKind == JsonValueKind.String)
        {
            result = property.GetString();
            return true;
        }
        result = null;
        return false;
    }
}
