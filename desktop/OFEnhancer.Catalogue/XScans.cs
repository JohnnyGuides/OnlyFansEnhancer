using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XScheduledOwner(string AccountId, string? Handle);

public sealed record XScheduledItem(string ScheduledId, string ScheduledUtc, string Text, int MediaCount,
    IReadOnlyList<string> MediaTypes);

public sealed record XScheduledBatch(XScheduledOwner Owner, IReadOnlyList<XScheduledItem> Scheduled);

public sealed record XScheduledResult(int Listed, int Gone);

public sealed record XScheduledPost(string ScheduledId, string ScheduledUtc, string Text, string MediaSummary,
    string ObservedUtc);

public sealed record XScanOwner(string AccountId, string Handle);

// What the extension's background scanner needs to decide whether a scan is due.
// DesktopStartedUtc: when this OFEnhancer process started; the scanner runs one
// scan after each start. KnownPosts / KnownPostsInWindow: how many of the
// owner's posts the catalogue already holds in total and within the routine
// scan window, so progress can be shown against a recorded count.
public sealed record XScanTarget(string StatusId, string LastSeenUtc, string? LastMetricUtc);

public sealed record XScanPlan(XScanOwner? Owner, string? RequestedUtc, IReadOnlyList<string> RecentPostsUtc,
    string? DesktopStartedUtc = null, int KnownPosts = 0, int KnownPostsInWindow = 0, IReadOnlyList<XScanTarget>? KnownStatuses = null, bool KnownStatusesTruncated = false);

// BackoffUntilUtc: automatic scans are paused until then after a rate-limit or
// authorization answer ("" when not paused).
public sealed record XScanReport(string Trigger, string Mode, string StartedUtc, string FinishedUtc, string Outcome,
    string Detail, int Pages, int Rows, int? Scheduled, string BackoffUntilUtc = "");

public sealed record XScanStatus(string? RequestedUtc, XScanReport? Last);

public sealed partial class CatalogueStore
{
    internal const int MaxXScheduled = 100;
    internal const int MaxXScheduledText = 280;
    internal const int MaxXScheduledMedia = 10;
    internal const int MaxOverviewScheduled = 50;
    internal const int MaxScanPlanPosts = 200;
    internal static readonly TimeSpan XScanPlanWindow = TimeSpan.FromDays(31);
    // Matches the scanner's routine window (ROUTINE_WINDOW_MS).
    internal static readonly TimeSpan XScanRoutineWindow = TimeSpan.FromDays(35);
    private static readonly Regex XScanDetail = new("^[a-z0-9-]{0,40}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> XScheduledMediaTypes = new(StringComparer.Ordinal)
        { "video", "photo", "animated_gif", "unknown" };
    private static readonly HashSet<string> XScanTriggers = new(StringComparer.Ordinal)
        { "startup", "routine", "checkpoint", "requested", "manual" };
    private static readonly HashSet<string> XScanModes = new(StringComparer.Ordinal) { "routine", "backfill", "refresh" };
    private static readonly HashSet<string> XScanOutcomes = new(StringComparer.Ordinal)
    {
        "complete", "window-reached", "no-new-posts", "page-cap", "owner-unknown", "owner-mismatch", "signed-out",
        "no-timeline", "timeout", "user-took-over", "error",
    };

    // Replaces the owner's scheduled-post list with X's current one: listed
    // posts are refreshed, previously listed ones that are missing are marked
    // gone. Only the recorded owner account's list is accepted.
    public XScheduledResult RecordXScheduledPosts(XScheduledBatch batch, DateTimeOffset now)
    {
        ValidateXScheduled(batch);
        XStoredOwner owner = GetXOwner() ?? throw new XObservationException("x-owner-unknown");
        if (owner.AccountId is not null ? owner.AccountId != batch.Owner.AccountId
            : batch.Owner.Handle is null || !string.Equals(owner.Handle, batch.Owner.Handle, StringComparison.OrdinalIgnoreCase))
            throw new XObservationException("x-owner-mismatch");
        string nowText = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        HashSet<string> listed = new(batch.Scheduled.Select(item => item.ScheduledId), StringComparer.Ordinal);
        List<string> active = [];
        Query("SELECT scheduled_id FROM x_scheduled_posts WHERE gone = 0", reader => active.Add(reader.GetString(0)));
        using SqliteTransaction transaction = connection.BeginTransaction();
        foreach (XScheduledItem item in batch.Scheduled)
            ExecuteX(transaction, """
                INSERT INTO x_scheduled_posts (scheduled_id, scheduled_utc, text_excerpt, media_summary, first_seen_utc,
                                               observed_utc, gone)
                VALUES ($id, $time, $text, $media, $now, $now, 0)
                ON CONFLICT(scheduled_id) DO UPDATE SET scheduled_utc = excluded.scheduled_utc,
                    text_excerpt = excluded.text_excerpt, media_summary = excluded.media_summary,
                    observed_utc = excluded.observed_utc, gone = 0
                """, ("$id", item.ScheduledId), ("$time", ScheduledUtc(item.ScheduledUtc)), ("$text", item.Text),
                ("$media", MediaSummary(item)), ("$now", nowText));
        int gone = 0;
        foreach (string id in active.Where(id => !listed.Contains(id)))
        {
            ExecuteX(transaction, "UPDATE x_scheduled_posts SET gone = 1, observed_utc = $now WHERE scheduled_id = $id",
                ("$id", id), ("$now", nowText));
            gone++;
        }
        transaction.Commit();
        return new(batch.Scheduled.Count, gone);
    }

    public IReadOnlyList<XScheduledPost> GetXScheduledPosts()
    {
        List<XScheduledPost> posts = [];
        Query($"""
            SELECT scheduled_id, scheduled_utc, text_excerpt, media_summary, observed_utc FROM x_scheduled_posts
            WHERE gone = 0 ORDER BY scheduled_utc, scheduled_id LIMIT {MaxOverviewScheduled}
            """, reader => posts.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
            reader.GetString(4))));
        return posts;
    }

    // Records a "Scan now" request; the extension picks it up on its next check.
    public XScanStatus RequestXScan(DateTimeOffset now)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO x_scan_state (singleton, requested_utc) VALUES (1, $now)
            ON CONFLICT(singleton) DO UPDATE SET requested_utc = excluded.requested_utc
            """;
        command.Parameters.AddWithValue("$now", now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        command.ExecuteNonQuery();
        return GetXScanStatus();
    }

    // The recorded owner (only with a known account id), the pending request
    // and the owner's own recent non-reply posts for checkpoint ages.
    public XScanPlan GetXScanPlan(DateTimeOffset now)
    {
        XStoredOwner? stored = GetXOwner();
        XScanOwner? owner = stored?.AccountId is { } accountId ? new(accountId, stored.Handle) : null;
        List<string> recent = [];
        if (owner is not null)
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = $"""
                SELECT posted_utc FROM x_posts
                WHERE author_id = $owner AND is_retweet = 0 AND in_reply_to IS NULL AND posted_utc >= $since
                ORDER BY posted_utc DESC LIMIT {MaxScanPlanPosts}
                """;
            command.Parameters.AddWithValue("$owner", owner.AccountId);
            command.Parameters.AddWithValue("$since",
                now.ToUniversalTime().Subtract(XScanPlanWindow).ToString("O", CultureInfo.InvariantCulture));
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read()) recent.Add(reader.GetString(0));
        }
        int known = 0, inWindow = 0;
        if (owner is not null)
        {
            // x_posts holds only the recorded owner's posts (DOM rows carry no author id).
            using SqliteCommand count = connection.CreateCommand();
            count.CommandText = """
                SELECT COUNT(*), COALESCE(SUM(posted_utc >= $since), 0) FROM x_posts
                WHERE author_id = $owner OR author_id IS NULL
                """;
            count.Parameters.AddWithValue("$owner", owner.AccountId);
            count.Parameters.AddWithValue("$since",
                now.ToUniversalTime().Subtract(XScanRoutineWindow).ToString("O", CultureInfo.InvariantCulture));
            using SqliteDataReader reader = count.ExecuteReader();
            if (reader.Read()) (known, inWindow) = (reader.GetInt32(0), reader.GetInt32(1));
        }
        List<XScanTarget> targets = [];
        if (owner is not null)
        {
            using SqliteCommand target = connection.CreateCommand();
            target.CommandText = """
                SELECT p.status_id, p.last_seen_utc, MAX(m.observed_utc) AS latest
                FROM x_posts p LEFT JOIN x_metric_samples m ON m.status_id = p.status_id
                WHERE (p.author_id = $owner OR p.author_id IS NULL) AND p.is_retweet = 0
                GROUP BY p.status_id ORDER BY latest IS NOT NULL, latest, p.posted_utc LIMIT 2001
                """;
            target.Parameters.AddWithValue("$owner", owner.AccountId);
            using SqliteDataReader reader = target.ExecuteReader();
            while (reader.Read()) targets.Add(new(reader.GetString(0), reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2)));
        }
        return new(owner, GetXScanStatus().RequestedUtc, recent, KnownPosts: known, KnownPostsInWindow: inWindow,
            KnownStatuses: targets.Take(2000).ToArray(), KnownStatusesTruncated: targets.Count > 2000);
    }

    // Stores the extension's scan outcome; a request made before the scan
    // started is answered by it and cleared.
    public XScanStatus RecordXScanResult(XScanReport report)
    {
        ValidateXScanReport(report);
        DateTimeOffset started = ParseUtc(report.StartedUtc);
        string? requested = GetXScanStatus().RequestedUtc;
        bool answered = requested is not null && ParseUtc(requested) <= started;
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO x_scan_state (singleton, requested_utc, last_trigger, last_mode, last_started_utc, last_finished_utc,
                                      last_outcome, last_detail, last_pages, last_rows, last_scheduled,
                                      last_backoff_until_utc)
            VALUES (1, NULL, $trigger, $mode, $started, $finished, $outcome, $detail, $pages, $rows, $scheduled, $backoff)
            ON CONFLICT(singleton) DO UPDATE SET
                requested_utc = CASE WHEN $answered = 1 THEN NULL ELSE x_scan_state.requested_utc END,
                last_trigger = excluded.last_trigger, last_mode = excluded.last_mode,
                last_started_utc = excluded.last_started_utc, last_finished_utc = excluded.last_finished_utc,
                last_outcome = excluded.last_outcome, last_detail = excluded.last_detail, last_pages = excluded.last_pages,
                last_rows = excluded.last_rows, last_scheduled = excluded.last_scheduled,
                last_backoff_until_utc = excluded.last_backoff_until_utc
            """;
        command.Parameters.AddWithValue("$trigger", report.Trigger);
        command.Parameters.AddWithValue("$mode", report.Mode);
        command.Parameters.AddWithValue("$started", started.ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$finished", ParseUtc(report.FinishedUtc).ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$outcome", report.Outcome);
        command.Parameters.AddWithValue("$detail", report.Detail);
        command.Parameters.AddWithValue("$pages", report.Pages);
        command.Parameters.AddWithValue("$rows", report.Rows);
        command.Parameters.AddWithValue("$scheduled", report.Scheduled is { } scheduled ? scheduled : DBNull.Value);
        command.Parameters.AddWithValue("$answered", answered ? 1 : 0);
        command.Parameters.AddWithValue("$backoff", report.BackoffUntilUtc.Length == 0 ? ""
            : ParseUtc(report.BackoffUntilUtc).ToString("O", CultureInfo.InvariantCulture));
        command.ExecuteNonQuery();
        return GetXScanStatus();
    }

    public XScanStatus GetXScanStatus()
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT requested_utc, last_trigger, last_mode, last_started_utc, last_finished_utc, last_outcome, last_detail,
                   last_pages, last_rows, last_scheduled, last_backoff_until_utc
            FROM x_scan_state WHERE singleton = 1
            """;
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read()) return new(null, null);
        string? requested = reader.IsDBNull(0) ? null : reader.GetString(0);
        XScanReport? last = reader.IsDBNull(5) ? null : new(reader.GetString(1), reader.GetString(2), reader.GetString(3),
            reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetInt32(7), reader.GetInt32(8),
            reader.IsDBNull(9) ? null : reader.GetInt32(9), reader.IsDBNull(10) ? "" : reader.GetString(10));
        return new(requested, last);
    }

    private static string ScheduledUtc(string value) => ParseUtc(value).ToString("O", CultureInfo.InvariantCulture);

    // "1 video", "2 photos", "1 video, 1 photo"; empty without media.
    internal static string MediaSummary(XScheduledItem item)
    {
        if (item.MediaCount == 0) return "";
        Dictionary<string, int> counts = new(StringComparer.Ordinal);
        foreach (string type in item.MediaTypes)
        {
            string name = type switch { "video" => "video", "photo" => "photo", "animated_gif" => "GIF", _ => "media" };
            counts[name] = counts.GetValueOrDefault(name) + 1;
        }
        int untyped = item.MediaCount - item.MediaTypes.Count;
        if (untyped > 0) counts["media"] = counts.GetValueOrDefault("media") + untyped;
        return string.Join(", ", counts.Select(pair =>
            $"{pair.Value} {pair.Key}{(pair.Value > 1 && pair.Key != "media" ? "s" : "")}"));
    }

    private static bool ValidXUtc(string? value) =>
        value is { Length: > 0 and <= 40 }
        && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _);

    private static void ValidateXScheduled(XScheduledBatch? batch)
    {
        static void Require(bool condition)
        {
            if (!condition) throw new XObservationException("invalid-x-scheduled");
        }
        Require(batch?.Owner is not null && batch.Scheduled is not null);
        Require(batch!.Owner.AccountId is not null && XId.IsMatch(batch.Owner.AccountId));
        Require(batch.Owner.Handle is null || XHandle.IsMatch(batch.Owner.Handle));
        Require(batch.Scheduled!.Count <= MaxXScheduled);
        HashSet<string> ids = new(StringComparer.Ordinal);
        foreach (XScheduledItem? item in batch.Scheduled!)
        {
            Require(item is not null && item.ScheduledId is not null && XId.IsMatch(item.ScheduledId) && ids.Add(item.ScheduledId));
            Require(ValidXUtc(item!.ScheduledUtc));
            Require(item.Text is not null && item.Text.Length <= MaxXScheduledText);
            Require(item.MediaCount is >= 0 and <= MaxXScheduledMedia && item.MediaTypes is not null);
            Require(item.MediaTypes!.Count <= item.MediaCount && item.MediaTypes.All(type => type is not null
                && XScheduledMediaTypes.Contains(type)));
        }
    }

    private static void ValidateXScanReport(XScanReport? report)
    {
        static void Require(bool condition)
        {
            if (!condition) throw new XObservationException("invalid-x-scan");
        }
        Require(report is not null && report.Trigger is not null && XScanTriggers.Contains(report.Trigger));
        Require(report!.Mode is not null && XScanModes.Contains(report.Mode));
        Require(report.Outcome is not null && XScanOutcomes.Contains(report.Outcome));
        Require(report.Detail is not null && XScanDetail.IsMatch(report.Detail));
        Require(ValidXUtc(report.StartedUtc) && ValidXUtc(report.FinishedUtc));
        Require(report.Pages is >= 0 and <= 1000 && report.Rows is >= 0 and <= 100_000);
        Require(report.Scheduled is null or (>= 0 and <= MaxXScheduled));
        Require(report.BackoffUntilUtc is not null && (report.BackoffUntilUtc.Length == 0 || ValidXUtc(report.BackoffUntilUtc)));
    }
}
