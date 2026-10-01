using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed class XObservationException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public sealed record XOwnerIdentity(string? AccountId, string Handle);

public sealed record XObservedMedia(string Type, string? MediaKey, long? DurationMs, string? PosterUrl);

public sealed record XObservedMetrics(long? Views, long? Likes, long? Reposts, long? Replies, long? Quotes, long? Bookmarks);

public sealed record XObservation(string StatusId, string? AuthorId, string AuthorHandle, string CreatedAt, string Text,
    string? InReplyToStatusId, string? ConversationId, bool IsRetweet, IReadOnlyList<XObservedMedia> Media,
    IReadOnlyList<string> Urls, XObservedMetrics? Metrics, string Source);

public sealed record XObservationBatch(XOwnerIdentity Owner, IReadOnlyList<XObservation> Observations);

public sealed record XObservationResult(int PostsUpserted, int SamplesAdded, int SamplesSkipped, int RejectedForeign);

public sealed record XStoredOwner(string? AccountId, string Handle);

public sealed partial class CatalogueStore
{
    internal const int MaxXObservations = 100;
    internal const int MaxXText = 2000;
    internal static readonly TimeSpan XSampleDedupeWindow = TimeSpan.FromMinutes(10);
    private static readonly Regex XId = new("^[0-9]{1,25}$", RegexOptions.CultureInvariant);
    private static readonly Regex XHandle = new("^[A-Za-z0-9_]{1,15}$", RegexOptions.CultureInvariant);
    private static readonly Regex XMediaKey = new("^[0-9]{1,4}_[0-9]{1,25}$", RegexOptions.CultureInvariant);

    // Records one batch of the owner's own X posts. Malformed batches and a
    // different signed-in account are refused whole; well-formed rows by any
    // other author are counted and never stored.
    public XObservationResult RecordXObservations(XObservationBatch batch, DateTimeOffset now)
    {
        ValidateXBatch(batch);
        string nowText = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        using SqliteTransaction transaction = connection.BeginTransaction();
        XStoredOwner owner = ReconcileXOwner(transaction, batch.Owner, nowText);
        int posts = 0, added = 0, skipped = 0, foreign = 0;
        foreach (XObservation row in batch.Observations)
        {
            if (!IsXOwnerRow(row, batch.Owner))
            {
                foreign++;
                continue;
            }
            UpsertXPost(transaction, row, row.AuthorId ?? owner.AccountId, nowText);
            posts++;
            if (row.Metrics is null || row.IsRetweet) continue;
            if (AppendXSample(transaction, row, now)) added++;
            else skipped++;
        }
        transaction.Commit();
        RefreshXBindings(now);
        return new(posts, added, skipped, foreign);
    }

    public XStoredOwner? GetXOwner()
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT account_id, handle FROM x_owner WHERE singleton = 1";
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? new(reader.IsDBNull(0) ? null : reader.GetString(0), reader.GetString(1)) : null;
    }

    private static bool IsXOwnerRow(XObservation row, XOwnerIdentity owner) =>
        row.Source == "network"
            ? owner.AccountId is not null && row.AuthorId == owner.AccountId
            : string.Equals(row.AuthorHandle, owner.Handle, StringComparison.OrdinalIgnoreCase);

    private XStoredOwner ReconcileXOwner(SqliteTransaction transaction, XOwnerIdentity incoming, string nowText)
    {
        XStoredOwner? stored = GetXOwner();
        if (stored is null)
        {
            ExecuteX(transaction, """
                INSERT INTO x_owner (singleton, account_id, handle, first_seen_utc, updated_utc)
                VALUES (1, $id, $handle, $now, $now)
                """, ("$id", incoming.AccountId), ("$handle", incoming.Handle), ("$now", nowText));
            return new(incoming.AccountId, incoming.Handle);
        }
        bool sameId = stored.AccountId is not null && stored.AccountId == incoming.AccountId;
        if (stored.AccountId is not null && incoming.AccountId is not null && !sameId)
            throw new XObservationException("x-owner-mismatch");
        if (!sameId && !string.Equals(stored.Handle, incoming.Handle, StringComparison.OrdinalIgnoreCase))
            throw new XObservationException("x-owner-mismatch");
        string? accountId = stored.AccountId ?? incoming.AccountId;
        string handle = sameId ? incoming.Handle : stored.Handle;
        if (accountId != stored.AccountId || handle != stored.Handle)
            ExecuteX(transaction, "UPDATE x_owner SET account_id = $id, handle = $handle, updated_utc = $now WHERE singleton = 1",
                ("$id", accountId), ("$handle", handle), ("$now", nowText));
        return new(accountId, handle);
    }

    private void UpsertXPost(SqliteTransaction transaction, XObservation row, string? authorId, string nowText)
    {
        // Network rows are authoritative for content; DOM rows only refresh sightings.
        string update = row.Source == "network"
            ? """
              author_id = COALESCE(excluded.author_id, x_posts.author_id), posted_utc = excluded.posted_utc,
              text = excluded.text, in_reply_to = excluded.in_reply_to, conversation_id = excluded.conversation_id,
              is_retweet = excluded.is_retweet, media_json = excluded.media_json, urls_json = excluded.urls_json,
              last_seen_utc = excluded.last_seen_utc
              """
            : "author_id = COALESCE(x_posts.author_id, excluded.author_id), last_seen_utc = excluded.last_seen_utc";
        ExecuteX(transaction, $"""
            INSERT INTO x_posts (status_id, author_id, posted_utc, text, in_reply_to, conversation_id, is_retweet,
                                 media_json, urls_json, first_seen_utc, last_seen_utc)
            VALUES ($status, $author, $posted, $text, $reply, $conversation, $retweet, $media, $urls, $now, $now)
            ON CONFLICT(status_id) DO UPDATE SET {update}
            """,
            ("$status", row.StatusId), ("$author", authorId), ("$posted", PostedUtc(row)),
            ("$text", row.IsRetweet ? "" : row.Text), ("$reply", row.InReplyToStatusId),
            ("$conversation", row.ConversationId), ("$retweet", row.IsRetweet ? 1 : 0),
            ("$media", row.IsRetweet ? "[]" : JsonSerializer.Serialize(row.Media, XJson)),
            ("$urls", row.IsRetweet ? "[]" : JsonSerializer.Serialize(row.Urls, XJson)), ("$now", nowText));
    }

    private bool AppendXSample(SqliteTransaction transaction, XObservation row, DateTimeOffset now)
    {
        XObservedMetrics metrics = row.Metrics!;
        DateTimeOffset utc = now.ToUniversalTime();
        using (SqliteCommand latest = connection.CreateCommand())
        {
            latest.Transaction = transaction;
            latest.CommandText = """
                SELECT observed_utc, views, likes, reposts, replies, quotes, bookmarks FROM x_metric_samples
                WHERE status_id = $status ORDER BY observed_utc DESC LIMIT 1
                """;
            latest.Parameters.AddWithValue("$status", row.StatusId);
            using SqliteDataReader reader = latest.ExecuteReader();
            if (reader.Read())
            {
                DateTimeOffset observed = DateTimeOffset.Parse(reader.GetString(0), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal);
                long?[] previous = [.. Enumerable.Range(1, 6).Select(index => reader.IsDBNull(index) ? (long?)null : reader.GetInt64(index))];
                long?[] current = [metrics.Views, metrics.Likes, metrics.Reposts, metrics.Replies, metrics.Quotes, metrics.Bookmarks];
                bool nearIdentical = previous.Zip(current).All(pair => pair.First is null || pair.Second is null || pair.First == pair.Second);
                if (utc - observed < XSampleDedupeWindow && nearIdentical) return false;
            }
        }
        DateTimeOffset posted = DateTimeOffset.Parse(PostedUtc(row), CultureInfo.InvariantCulture);
        using SqliteCommand insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            INSERT OR IGNORE INTO x_metric_samples
                (status_id, observed_utc, age_hours, views, likes, reposts, replies, quotes, bookmarks, source)
            VALUES ($status, $observed, $age, $views, $likes, $reposts, $replies, $quotes, $bookmarks, $source)
            """;
        insert.Parameters.AddWithValue("$status", row.StatusId);
        insert.Parameters.AddWithValue("$observed", utc.ToString("yyyy-MM-dd'T'HH:mm':00Z'", CultureInfo.InvariantCulture));
        insert.Parameters.AddWithValue("$age", Math.Max(0, (utc - posted).TotalHours));
        insert.Parameters.AddWithValue("$views", (object?)metrics.Views ?? DBNull.Value);
        insert.Parameters.AddWithValue("$likes", (object?)metrics.Likes ?? DBNull.Value);
        insert.Parameters.AddWithValue("$reposts", (object?)metrics.Reposts ?? DBNull.Value);
        insert.Parameters.AddWithValue("$replies", (object?)metrics.Replies ?? DBNull.Value);
        insert.Parameters.AddWithValue("$quotes", (object?)metrics.Quotes ?? DBNull.Value);
        insert.Parameters.AddWithValue("$bookmarks", (object?)metrics.Bookmarks ?? DBNull.Value);
        insert.Parameters.AddWithValue("$source", row.Source);
        return insert.ExecuteNonQuery() == 1;
    }

    private static readonly JsonSerializerOptions XJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static string PostedUtc(XObservation row) =>
        DateTimeOffset.Parse(row.CreatedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)
            .ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private void ExecuteX(SqliteTransaction transaction, string sql, params (string Name, object? Value)[] parameters)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach ((string name, object? value) in parameters)
            command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    private static void ValidateXBatch(XObservationBatch? batch)
    {
        static void Require(bool condition)
        {
            if (!condition) throw new XObservationException("invalid-x-observations");
        }
        static bool OptionalId(string? value) => value is null || XId.IsMatch(value);
        static bool Count(long? value) => value is null or >= 0 and <= 1_000_000_000_000;
        static bool Url(string? value, bool poster) =>
            value is { Length: > 0 and <= 1024 }
            && Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            && (poster ? uri.Scheme == Uri.UriSchemeHttps && uri.Host == "pbs.twimg.com"
                : uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);

        Require(batch?.Owner is not null && batch.Observations is not null);
        Require(OptionalId(batch!.Owner.AccountId) && batch.Owner.Handle is not null && XHandle.IsMatch(batch.Owner.Handle));
        Require(batch.Observations.Count is > 0 and <= MaxXObservations);
        foreach (XObservation? row in batch.Observations)
        {
            Require(row is not null && row.StatusId is not null && XId.IsMatch(row.StatusId));
            Require(row!.Source is "network" or "dom");
            Require(row.Source == "network" ? row.AuthorId is not null && XId.IsMatch(row.AuthorId) : row.AuthorId is null);
            Require(row.AuthorHandle is not null && XHandle.IsMatch(row.AuthorHandle));
            Require(row.CreatedAt is not null && DateTimeOffset.TryParse(row.CreatedAt, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out _));
            Require(row.Text is not null && row.Text.Length <= MaxXText);
            Require(OptionalId(row.InReplyToStatusId) && OptionalId(row.ConversationId));
            Require(row.Media is not null && row.Media.Count <= 4 && row.Urls is not null && row.Urls.Count <= 5);
            foreach (XObservedMedia? media in row.Media!)
            {
                Require(media is not null && media.Type is "video" or "photo" or "animated_gif");
                Require(media!.MediaKey is null || XMediaKey.IsMatch(media.MediaKey));
                Require(media.DurationMs is null or >= 0 and <= 86_400_000);
                Require(media.PosterUrl is null || Url(media.PosterUrl, true));
            }
            foreach (string? url in row.Urls!) Require(Url(url, false));
            if (row.Metrics is { } metrics)
                Require(Count(metrics.Views) && Count(metrics.Likes) && Count(metrics.Reposts) && Count(metrics.Replies)
                    && Count(metrics.Quotes) && Count(metrics.Bookmarks));
            if (row.IsRetweet)
                Require(row.Text.Length == 0 && row.Media.Count == 0 && row.Urls.Count == 0 && row.Metrics is null);
        }
    }
}
