using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserEpisode(string ItemId, string SourceKey, string Title, int UsedCount, int FailedCount,
    int ReadyClips, int PostedClips, int GoodClips, int FailedClips, string? Category = null, string? Series = null,
    string? Episode = null);

public sealed record XTeaserMetrics(string ObservedUtc, double AgeHours, long? Views, long? Likes, long? Reposts,
    long? Replies, long? Bookmarks);

public sealed record XTeaserVerdict(string Verdict, double EngagementRate, double CohortMedian, int CohortSize,
    double SampleAgeHours, string DecidedUtc);

public sealed record XTeaserFirstReply(string StatusId, string Link, string Kind, string RepliedUtc);

// Medians of the other teasers' samples taken at an age comparable to this
// post's latest sample; a null field had too few comparable values.
public sealed record XTeaserUsual(double AgeHours, int Peers, double? Views, double? Likes, double? Reposts,
    double? EngagementRate);

public sealed record XTeaserPost(string StatusId, string PostedUtc, string? ItemId, string? SourceKey, string? Evidence,
    IReadOnlyList<XBindingCandidate>? Conflict, XTeaserMetrics? Latest, XTeaserVerdict? Verdict, XTeaserFirstReply? FirstReply,
    long? ClipId, string? PosterUrl = null, XTeaserUsual? Usual = null);

public sealed record XTeaserClip(long ClipId, string RelPath, string? EpisodeKey, string State, string? StatusId,
    string? PairingEvidence, bool Missing);

public sealed record XTeaserMove(long MoveId, long ClipId, string FromRelPath, string ToRelPath, string Reason,
    string Outcome, string OccurredUtc, string? UndoneUtc);

public sealed record XTeaserOverview(IReadOnlyList<XTeaserEpisode> Episodes, IReadOnlyList<XTeaserPost> Posts,
    IReadOnlyList<XTeaserClip> UnpairedClips, IReadOnlyList<XTeaserPost> UnboundPosts, IReadOnlyList<XTeaserMove> RecentMoves,
    bool Truncated, XSheetWritebackStatus? SheetWriteback = null);

public sealed partial class CatalogueStore
{
    internal const int MaxOverviewEpisodes = 500;
    internal const int MaxOverviewPosts = 200;
    internal const int MaxOverviewClips = 200;
    internal const int MaxOverviewMoves = 50;
    internal const int MinimumUsualPeers = 3;

    // Bounded read model for the teaser dashboard: newest teasers first.
    public XTeaserOverview GetXTeaserOverview()
    {
        Dictionary<string, (string ItemId, string SourceKey, string Evidence)> bindings = new(StringComparer.Ordinal);
        Query("SELECT status_id, item_id, source_key, evidence FROM x_post_bindings",
            reader => bindings[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2), reader.GetString(3)));
        Dictionary<string, IReadOnlyList<XBindingCandidate>> conflicts = new(StringComparer.Ordinal);
        Query("SELECT status_id, candidates_json FROM x_binding_conflicts", reader => conflicts[reader.GetString(0)] =
            JsonSerializer.Deserialize<List<XBindingCandidate>>(reader.GetString(1), XJson) ?? []);
        Dictionary<string, XTeaserVerdict> verdicts = new(StringComparer.Ordinal);
        Query("SELECT status_id, verdict, engagement_rate, cohort_median, cohort_size, sample_age_hours, decided_utc FROM x_teaser_verdicts",
            reader => verdicts[reader.GetString(0)] = new(reader.GetString(1), reader.GetDouble(2), reader.GetDouble(3),
                reader.GetInt32(4), reader.GetDouble(5), reader.GetString(6)));
        Dictionary<string, XTeaserFirstReply> replies = new(StringComparer.Ordinal);
        Query("SELECT status_id, reply_status_id, reply_link, link_kind, replied_utc FROM x_first_replies",
            reader => replies[reader.GetString(0)] = new(reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4)));
        Dictionary<string, XTeaserMetrics> latest = new(StringComparer.Ordinal);
        Query("""
            SELECT s.status_id, s.observed_utc, s.age_hours, s.views, s.likes, s.reposts, s.replies, s.bookmarks
            FROM x_metric_samples s
            WHERE s.observed_utc = (SELECT MAX(observed_utc) FROM x_metric_samples t WHERE t.status_id = s.status_id)
            """, reader => latest[reader.GetString(0)] = new(reader.GetString(1), reader.GetDouble(2), Nullable(reader, 3),
            Nullable(reader, 4), Nullable(reader, 5), Nullable(reader, 6), Nullable(reader, 7)));
        List<XTeaserClip> clips = [];
        Query("""
            SELECT clip_id, rel_path, episode_key, state, status_id, pairing_evidence, missing FROM x_local_clips
            WHERE missing = 0 ORDER BY clip_id
            """, reader => clips.Add(new(reader.GetInt64(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetInt64(6) == 1)));
        Dictionary<string, string> posters = new(StringComparer.Ordinal);
        Query("SELECT status_id, media_json FROM x_posts", reader =>
        {
            if (PosterUrl(reader.GetString(1)) is { } poster) posters[reader.GetString(0)] = poster;
        });
        Dictionary<string, List<XUsualSample>> samples = new(StringComparer.Ordinal);
        Query("SELECT status_id, age_hours, views, likes, reposts, replies, bookmarks FROM x_metric_samples", reader =>
        {
            if (!samples.TryGetValue(reader.GetString(0), out List<XUsualSample>? list))
                samples[reader.GetString(0)] = list = [];
            list.Add(new(reader.GetDouble(1), Nullable(reader, 2), Nullable(reader, 3), Nullable(reader, 4),
                Nullable(reader, 5), Nullable(reader, 6)));
        });
        Dictionary<string, long> clipByStatus = clips.Where(clip => clip.StatusId is not null)
            .ToDictionary(clip => clip.StatusId!, clip => clip.ClipId, StringComparer.Ordinal);

        List<XTeaserPost> posts = [];
        foreach (XPostRow teaser in ReadXPosts(null).Where(IsXTeaser).OrderByDescending(post => post.PostedUtc))
        {
            bool isBound = bindings.TryGetValue(teaser.StatusId, out var binding);
            posts.Add(new(teaser.StatusId, teaser.PostedUtc.ToString("O", CultureInfo.InvariantCulture), isBound ? binding.ItemId : null,
                isBound ? binding.SourceKey : null, isBound ? binding.Evidence : null, conflicts.GetValueOrDefault(teaser.StatusId),
                latest.GetValueOrDefault(teaser.StatusId), verdicts.GetValueOrDefault(teaser.StatusId),
                replies.GetValueOrDefault(teaser.StatusId), clipByStatus.TryGetValue(teaser.StatusId, out long clipId) ? clipId : null,
                posters.GetValueOrDefault(teaser.StatusId)));
        }
        HashSet<string> teaserIds = [.. posts.Select(post => post.StatusId)];
        for (int index = 0; index < Math.Min(posts.Count, MaxOverviewPosts); index++)
            if (posts[index].Latest is { } own)
                posts[index] = posts[index] with { Usual = Usual(posts[index].StatusId, own.AgeHours, teaserIds, samples) };

        List<XTeaserEpisode> episodes = [];
        foreach (CatalogueItemSummary item in GetItems())
        {
            string key = item.SourceKey.ToLowerInvariant();
            List<XTeaserPost> used = [.. posts.Where(post => post.ItemId == item.ItemId)];
            List<XTeaserClip> own = [.. clips.Where(clip => clip.EpisodeKey == key)];
            int failed = used.Count(post => post.Verdict?.Verdict == "failed");
            // Every active episode is listed so the dashboard shows uncovered ones too.
            episodes.Add(new(item.ItemId, item.SourceKey, item.Title, used.Count - failed, failed,
                own.Count(clip => clip.State == "ready"), own.Count(clip => clip.State == "posted"),
                own.Count(clip => clip.State == "good"), own.Count(clip => clip.State == "failed"),
                item.Category, item.Series, item.Episode));
        }

        List<XTeaserMove> moves = [];
        Query($"""
            SELECT move_id, clip_id, from_rel_path, to_rel_path, reason, outcome, occurred_utc, undone_utc
            FROM x_clip_moves ORDER BY move_id DESC LIMIT {MaxOverviewMoves}
            """, reader => moves.Add(new(reader.GetInt64(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3),
            reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7))));

        List<XTeaserClip> unpaired = [.. clips.Where(clip => clip.StatusId is null && clip.State != "ready")];
        List<XTeaserPost> unbound = [.. posts.Where(post => post.ItemId is null)];
        bool truncated = episodes.Count > MaxOverviewEpisodes || posts.Count > MaxOverviewPosts
            || unpaired.Count > MaxOverviewClips || unbound.Count > MaxOverviewPosts;
        return new([.. episodes.Take(MaxOverviewEpisodes)], [.. posts.Take(MaxOverviewPosts)], [.. unpaired.Take(MaxOverviewClips)],
            [.. unbound.Take(MaxOverviewPosts)], moves, truncated, GetXSheetWritebackStatus(DateTimeOffset.UtcNow));

        static long? Nullable(SqliteDataReader reader, int index) => reader.IsDBNull(index) ? null : reader.GetInt64(index);
    }

    private sealed record XUsualSample(double AgeHours, long? Views, long? Likes, long? Reposts, long? Replies, long? Bookmarks);

    // Comparable age: 0.8x-1.25x of the post's age, and at least +/-2 h.
    // Each other teaser contributes its one sample closest to that age.
    private static XTeaserUsual? Usual(string statusId, double age, HashSet<string> teaserIds,
        Dictionary<string, List<XUsualSample>> samples)
    {
        double low = Math.Min(age * 0.8, age - 2), high = Math.Max(age * 1.25, age + 2);
        List<XUsualSample> peers = [];
        foreach ((string peerId, List<XUsualSample> list) in samples)
        {
            if (peerId == statusId || !teaserIds.Contains(peerId)) continue;
            XUsualSample? closest = list.Where(sample => sample.AgeHours >= low && sample.AgeHours <= high)
                .OrderBy(sample => Math.Abs(sample.AgeHours - age)).FirstOrDefault();
            if (closest is not null) peers.Add(closest);
        }
        if (peers.Count < MinimumUsualPeers) return null;
        return new(age, peers.Count, Median(peers.Select(peer => (double?)peer.Views)),
            Median(peers.Select(peer => (double?)peer.Likes)), Median(peers.Select(peer => (double?)peer.Reposts)),
            Median(peers.Select(peer => peer.Views > 0 && peer.Likes is not null && peer.Reposts is not null
                && peer.Replies is not null && peer.Bookmarks is not null
                ? (double)(peer.Likes + peer.Reposts + peer.Replies + peer.Bookmarks).Value / peer.Views.Value : (double?)null)));

        static double? Median(IEnumerable<double?> values)
        {
            double[] sorted = [.. values.Where(value => value is not null).Select(value => value!.Value).Order()];
            if (sorted.Length < MinimumUsualPeers) return null;
            return sorted.Length % 2 == 1 ? sorted[sorted.Length / 2] : (sorted[sorted.Length / 2 - 1] + sorted[sorted.Length / 2]) / 2;
        }
    }

    // Only X's own image host is passed to the dashboard.
    private static string? PosterUrl(string mediaJson)
    {
        List<XObservedMedia>? media;
        try { media = JsonSerializer.Deserialize<List<XObservedMedia>>(mediaJson, XJson); }
        catch (JsonException) { return null; }
        string? poster = media?.FirstOrDefault(item => item.Type == "video" && item.PosterUrl is not null)?.PosterUrl;
        return Uri.TryCreate(poster, UriKind.Absolute, out Uri? uri) && uri.Scheme == Uri.UriSchemeHttps
            && uri.Host == "pbs.twimg.com" && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) ? uri.AbsoluteUri : null;
    }

    private void Query(string sql, Action<SqliteDataReader> row)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read()) row(reader);
    }
}
