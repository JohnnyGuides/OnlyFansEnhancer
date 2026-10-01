using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XBindingResult(int Bound, int Conflicts, int FirstReplies);

public sealed record XBindingCandidate(string ItemId, string SourceKey, string Evidence);

public sealed partial class CatalogueStore
{
    private static readonly Regex XStatusLink = new(
        @"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/(?:[A-Za-z0-9_]{1,15}|i/web|i)/status/(?<id>[0-9]{1,25})(?:[/?#]|$)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex OnlyFansPostLink = new(
        @"(?:^|[^A-Za-z0-9.])(?<link>(?:https?://)?(?:www\.)?onlyfans\.com/(?<id>[0-9]{1,30})(?:/[A-Za-z0-9._]{1,64})?)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex FanslyPostLink = new(
        @"(?:^|[^A-Za-z0-9.])(?<link>(?:https?://)?(?:www\.)?fansly\.com/post/(?<id>[0-9]{1,30}))",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    internal sealed record XPostRow(string StatusId, DateTimeOffset PostedUtc, string Text, string? InReplyTo,
        string? ConversationId, bool IsRetweet, bool HasVideo, IReadOnlyList<string> Urls);

    // Recomputes the derived X tables from the stored owner posts and the
    // catalogue: first self-replies, then post-to-episode bindings. Sheet X
    // links outrank first-reply paid links; owner bindings are never replaced;
    // an ambiguous match binds nothing and is recorded as a conflict.
    public XBindingResult RefreshXBindings(DateTimeOffset now)
    {
        string nowText = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        IReadOnlyList<XPostRow> posts = ReadXPosts(null);
        IReadOnlyList<CatalogueItemSummary> items = GetItems();
        using SqliteTransaction transaction = connection.BeginTransaction();

        Dictionary<string, (XPostRow Reply, string Kind, string PostId, string Link)> replies = DeriveFirstReplies(posts);
        ExecuteX(transaction, "DELETE FROM x_first_replies");
        foreach ((string teaser, var reply) in replies)
            ExecuteX(transaction, """
                INSERT INTO x_first_replies (status_id, reply_status_id, reply_link, link_kind, link_post_id, replied_utc)
                VALUES ($status, $reply, $link, $kind, $postId, $utc)
                """, ("$status", teaser), ("$reply", reply.Reply.StatusId), ("$link", reply.Link), ("$kind", reply.Kind),
                ("$postId", reply.PostId), ("$utc", reply.Reply.PostedUtc.ToString("O", CultureInfo.InvariantCulture)));

        Dictionary<string, List<CatalogueItemSummary>> bySheetStatus = [];
        Dictionary<(string Kind, string Id), List<CatalogueItemSummary>> byPaidPost = [];
        foreach (CatalogueItemSummary item in items)
        {
            foreach (string id in ItemUrls(item, "x").Select(XStatusIdFromUrl).OfType<string>().Distinct(StringComparer.Ordinal))
                Add(bySheetStatus, id, item);
            foreach ((string kind, string id) in ItemUrls(item, "onlyfans").Concat(ItemUrls(item, "fansly"))
                .Select(PaidPostFromUrl).OfType<(string, string)>().Distinct())
                Add(byPaidPost, (kind, id), item);
        }

        Dictionary<string, (string ItemId, string Evidence)> existing = [];
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.Transaction = transaction;
            read.CommandText = "SELECT status_id, item_id, evidence FROM x_post_bindings";
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read()) existing[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2));
        }

        int bound = 0, conflicts = 0;
        HashSet<string> keepConflicts = new(StringComparer.Ordinal);
        foreach (XPostRow teaser in posts.Where(IsXTeaser))
        {
            List<XBindingCandidate> candidates = [];
            if (bySheetStatus.TryGetValue(teaser.StatusId, out List<CatalogueItemSummary>? sheetItems))
                candidates.AddRange(sheetItems.Select(item => new XBindingCandidate(item.ItemId, item.SourceKey, "sheet-link")));
            if (replies.TryGetValue(teaser.StatusId, out var reply)
                && byPaidPost.TryGetValue((reply.Kind, reply.PostId), out List<CatalogueItemSummary>? paidItems))
                candidates.AddRange(paidItems.Select(item => new XBindingCandidate(item.ItemId, item.SourceKey, "reply-link")));

            bool owner = existing.TryGetValue(teaser.StatusId, out var current) && current.Evidence == "owner";
            XBindingCandidate? winner = null;
            List<XBindingCandidate> sheet = [.. candidates.Where(candidate => candidate.Evidence == "sheet-link")];
            List<XBindingCandidate> paid = [.. candidates.Where(candidate => candidate.Evidence == "reply-link")];
            if (sheet.Count == 1) winner = sheet[0];
            else if (sheet.Count == 0 && paid.Count == 1) winner = paid[0];
            if (owner)
            {
                bound++;
                if (candidates.Any(candidate => candidate.ItemId != current.ItemId))
                {
                    RecordXConflict(transaction, teaser.StatusId, candidates, nowText);
                    keepConflicts.Add(teaser.StatusId);
                    conflicts++;
                }
                continue;
            }
            if (candidates.Select(candidate => candidate.ItemId).Distinct(StringComparer.Ordinal).Count() > 1)
            {
                RecordXConflict(transaction, teaser.StatusId, candidates, nowText);
                keepConflicts.Add(teaser.StatusId);
                conflicts++;
            }
            if (winner is null)
            {
                if (existing.ContainsKey(teaser.StatusId))
                    ExecuteX(transaction, "DELETE FROM x_post_bindings WHERE status_id = $status", ("$status", teaser.StatusId));
                continue;
            }
            bound++;
            if (existing.TryGetValue(teaser.StatusId, out var previous)
                && previous.ItemId == winner.ItemId && previous.Evidence == winner.Evidence)
                continue;
            ExecuteX(transaction, """
                INSERT INTO x_post_bindings (status_id, item_id, source_key, evidence, confidence, bound_utc)
                VALUES ($status, $item, $key, $evidence, $confidence, $now)
                ON CONFLICT(status_id) DO UPDATE SET item_id = excluded.item_id, source_key = excluded.source_key,
                    evidence = excluded.evidence, confidence = excluded.confidence, bound_utc = excluded.bound_utc
                """, ("$status", teaser.StatusId), ("$item", winner.ItemId), ("$key", winner.SourceKey),
                ("$evidence", winner.Evidence), ("$confidence", winner.Evidence == "sheet-link" ? "high" : "medium"),
                ("$now", nowText));
        }
        HashSet<string> teaserIds = [.. posts.Where(IsXTeaser).Select(post => post.StatusId)];
        foreach ((string statusId, var binding) in existing)
            if (!teaserIds.Contains(statusId) && binding.Evidence != "owner")
                ExecuteX(transaction, "DELETE FROM x_post_bindings WHERE status_id = $status", ("$status", statusId));
        using (SqliteCommand stale = connection.CreateCommand())
        {
            stale.Transaction = transaction;
            stale.CommandText = "SELECT status_id FROM x_binding_conflicts";
            List<string> ids = [];
            using (SqliteDataReader reader = stale.ExecuteReader())
                while (reader.Read()) ids.Add(reader.GetString(0));
            foreach (string id in ids.Where(id => !keepConflicts.Contains(id)))
                ExecuteX(transaction, "DELETE FROM x_binding_conflicts WHERE status_id = $status", ("$status", id));
        }
        transaction.Commit();
        return new(bound, conflicts, replies.Count);

        static void Add<TKey>(Dictionary<TKey, List<CatalogueItemSummary>> map, TKey key, CatalogueItemSummary item) where TKey : notnull
        {
            if (!map.TryGetValue(key, out List<CatalogueItemSummary>? list)) map[key] = list = [];
            if (list.All(existing => existing.ItemId != item.ItemId)) list.Add(item);
        }
    }

    internal static bool IsXTeaser(XPostRow post) => post.InReplyTo is null && !post.IsRetweet && post.HasVideo;

    internal static string? XStatusIdFromUrl(string url)
    {
        Match match = XStatusLink.Match(url.Trim());
        return match.Success ? match.Groups["id"].Value : null;
    }

    internal static (string Kind, string Id)? PaidPostFromUrl(string text)
    {
        Match onlyFans = OnlyFansPostLink.Match(text);
        if (onlyFans.Success) return ("onlyfans", onlyFans.Groups["id"].Value);
        Match fansly = FanslyPostLink.Match(text);
        return fansly.Success ? ("fansly", fansly.Groups["id"].Value) : null;
    }

    private static IEnumerable<string> ItemUrls(CatalogueItemSummary item, string platform)
    {
        if (item.PlatformLinks.TryGetValue(platform, out string? link)) yield return link;
        if (item.SourceLinkCells?.TryGetValue(platform, out CatalogueSourceLinkCell? cell) == true)
        {
            foreach (string url in cell.Urls) yield return url;
            if (cell.Hyperlink is not null) yield return cell.Hyperlink;
        }
    }

    // The earliest owner reply in a teaser's conversation that carries an
    // OnlyFans or Fansly post link.
    private static Dictionary<string, (XPostRow Reply, string Kind, string PostId, string Link)> DeriveFirstReplies(
        IReadOnlyList<XPostRow> posts)
    {
        Dictionary<string, DateTimeOffset> teasers = posts.Where(IsXTeaser)
            .ToDictionary(post => post.StatusId, post => post.PostedUtc, StringComparer.Ordinal);
        Dictionary<string, (XPostRow, string, string, string)> result = new(StringComparer.Ordinal);
        foreach (XPostRow reply in posts.Where(post => post.InReplyTo is not null && !post.IsRetweet)
            .OrderBy(post => post.PostedUtc).ThenBy(post => post.StatusId, StringComparer.Ordinal))
        {
            string? teaser = reply.ConversationId is not null && teasers.ContainsKey(reply.ConversationId) ? reply.ConversationId
                : teasers.ContainsKey(reply.InReplyTo!) ? reply.InReplyTo : null;
            if (teaser is null || result.ContainsKey(teaser) || reply.PostedUtc < teasers[teaser])
                continue;
            foreach (string candidate in reply.Urls.Append(reply.Text))
            {
                if (PaidPostFromUrl(candidate) is not { } paid) continue;
                string link = (paid.Kind == "onlyfans" ? OnlyFansPostLink : FanslyPostLink).Match(candidate).Groups["link"].Value;
                result[teaser] = (reply, paid.Kind, paid.Id, link);
                break;
            }
        }
        return result;
    }

    private void RecordXConflict(SqliteTransaction transaction, string statusId, IReadOnlyList<XBindingCandidate> candidates, string nowText)
    {
        string json = JsonSerializer.Serialize(candidates, XJson);
        ExecuteX(transaction, """
            INSERT INTO x_binding_conflicts (status_id, candidates_json, detected_utc) VALUES ($status, $json, $now)
            ON CONFLICT(status_id) DO UPDATE SET candidates_json = excluded.candidates_json,
                detected_utc = CASE WHEN x_binding_conflicts.candidates_json = excluded.candidates_json
                    THEN x_binding_conflicts.detected_utc ELSE excluded.detected_utc END
            """, ("$status", statusId), ("$json", json), ("$now", nowText));
    }

    internal IReadOnlyList<XPostRow> ReadXPosts(SqliteTransaction? transaction)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT status_id, posted_utc, text, in_reply_to, conversation_id, is_retweet, media_json, urls_json
            FROM x_posts ORDER BY posted_utc, status_id
            """;
        using SqliteDataReader reader = command.ExecuteReader();
        List<XPostRow> rows = [];
        while (reader.Read())
        {
            List<XObservedMedia> media = JsonSerializer.Deserialize<List<XObservedMedia>>(reader.GetString(6), XJson) ?? [];
            List<string> urls = JsonSerializer.Deserialize<List<string>>(reader.GetString(7), XJson) ?? [];
            rows.Add(new(reader.GetString(0), ParseUtc(reader.GetString(1)), reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetInt64(5) == 1, media.Any(item => item.Type == "video"), urls));
        }
        return rows;
    }

    internal static DateTimeOffset ParseUtc(string value) =>
        DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).ToUniversalTime();
}
