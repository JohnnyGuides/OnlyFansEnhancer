using System.Globalization;
using System.Text.RegularExpressions;

namespace OFEnhancer.Catalogue;

// The background scanner's live log, as sent by the extension during a scan:
// what it is doing, which page and which of the owner's posts it just read,
// with X's counters exactly as received (null when X sent none).
public sealed record XScanActivityMetrics(long? Views, long? Likes, long? Reposts, long? Replies, long? Quotes,
    long? Bookmarks);

public sealed record XScanActivityPost(string StatusId, string PostedUtc, string Kind, string Text, string MediaType,
    string PosterUrl, XScanActivityMetrics? Metrics);

public sealed record XScanActivityEvent(string At, string Kind, string Text, XScanActivityPost? Post = null);

public sealed record XScanActivity(int Version, string RunId, bool Running, string Trigger, string Mode, string Phase,
    string StartedUtc, string UpdatedUtc, int Pages, int Rows, string Outcome, IReadOnlyList<XScanActivityPost> Posts,
    IReadOnlyList<XScanActivityEvent> Events, int Expected = 0);

// Holds the latest live log in memory only; nothing here is written to the
// catalogue. A log that claims to be running but has not been updated for
// StaleAfter is reported as not running (phase "stale"): Chrome stopped
// reporting, so the scan is not shown as active.
public sealed class XScanActivityBoard
{
    public static readonly TimeSpan StaleAfter = TimeSpan.FromSeconds(90);
    internal const int MaxEvents = 60;
    internal const int MaxPosts = 40;
    internal const int MaxText = 240;
    internal const int MaxPostText = 140;
    private static readonly Regex RunId = new("^([0-9a-f]{32})?$", RegexOptions.CultureInvariant);
    private static readonly Regex StatusId = new(@"^\d{1,25}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Triggers = new(StringComparer.Ordinal)
        { "", "startup", "routine", "checkpoint", "requested", "manual" };
    private static readonly HashSet<string> Modes = new(StringComparer.Ordinal) { "", "routine", "backfill" };
    private static readonly HashSet<string> Phases = new(StringComparer.Ordinal)
        { "idle", "starting", "opening", "loading", "reading", "waiting", "paging", "scheduled", "closing", "done" };
    private static readonly HashSet<string> Outcomes = new(StringComparer.Ordinal)
    {
        "", "complete", "window-reached", "no-new-posts", "page-cap", "owner-unknown", "owner-mismatch", "signed-out",
        "no-timeline", "timeout", "user-took-over", "error",
    };
    private static readonly HashSet<string> EventKinds = new(StringComparer.Ordinal) { "step", "post", "warn", "done" };
    private static readonly HashSet<string> PostKinds = new(StringComparer.Ordinal) { "post", "reply", "repost" };
    private static readonly HashSet<string> MediaTypes = new(StringComparer.Ordinal)
        { "", "video", "photo", "animated_gif" };
    private readonly object gate = new();
    private XScanActivity? latest;

    public XScanActivity Record(XScanActivity activity)
    {
        Validate(activity);
        lock (gate) latest = activity;
        return activity;
    }

    public XScanActivity? Latest(DateTimeOffset now)
    {
        XScanActivity? current;
        lock (gate) current = latest;
        if (current is not { Running: true }) return current;
        DateTimeOffset updated = DateTimeOffset.Parse(current.UpdatedUtc, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal);
        return now - updated > StaleAfter ? current with { Running = false, Phase = "stale" } : current;
    }

    private static void Validate(XScanActivity? activity)
    {
        static void Require(bool condition)
        {
            if (!condition) throw new XObservationException("invalid-x-scan-activity");
        }
        Require(activity is not null && activity.Version == 1);
        Require(activity!.RunId is not null && RunId.IsMatch(activity.RunId));
        Require(activity.Trigger is not null && Triggers.Contains(activity.Trigger));
        Require(activity.Mode is not null && Modes.Contains(activity.Mode));
        Require(activity.Phase is not null && Phases.Contains(activity.Phase));
        Require(activity.Outcome is not null && Outcomes.Contains(activity.Outcome));
        Require(Utc(activity.StartedUtc, allowEmpty: true) && Utc(activity.UpdatedUtc, allowEmpty: false));
        Require(activity.Pages is >= 0 and <= 1000 && activity.Rows is >= 0 and <= 100_000
            && activity.Expected is >= 0 and <= 1_000_000);
        Require(activity.Posts is not null && activity.Posts.Count <= MaxPosts && activity.Posts.All(ValidPost));
        Require(activity.Events is not null && activity.Events.Count <= MaxEvents && activity.Events.All(item =>
            item is not null && Utc(item.At, allowEmpty: false) && item.Kind is not null && EventKinds.Contains(item.Kind)
            && item.Text is not null && item.Text.Length <= MaxText
            && (item.Post is null ? item.Kind != "post" : item.Kind == "post" && ValidPost(item.Post))));
    }

    private static bool ValidPost(XScanActivityPost? post) =>
        post is not null && post.StatusId is not null && StatusId.IsMatch(post.StatusId)
        && Utc(post.PostedUtc, allowEmpty: false) && post.Kind is not null && PostKinds.Contains(post.Kind)
        && post.Text is not null && post.Text.Length <= MaxPostText
        && post.MediaType is not null && MediaTypes.Contains(post.MediaType)
        && post.PosterUrl is not null && (post.PosterUrl.Length == 0 || Poster(post.PosterUrl))
        && (post.Metrics is null || new[] { post.Metrics.Views, post.Metrics.Likes, post.Metrics.Reposts,
            post.Metrics.Replies, post.Metrics.Quotes, post.Metrics.Bookmarks }.All(value => value is null or (>= 0 and <= 1_000_000_000_000)));

    private static bool Poster(string value) =>
        value.Length <= 1024 && Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
        && uri.Scheme == Uri.UriSchemeHttps && uri.Host == "pbs.twimg.com" && uri.IsDefaultPort;

    private static bool Utc(string? value, bool allowEmpty) =>
        value is not null && (value.Length == 0 ? allowEmpty : value.EndsWith('Z')
            && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _));
}
