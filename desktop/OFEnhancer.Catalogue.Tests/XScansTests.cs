using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XScansTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly XOwnerIdentity Owner = new(OwnerId, "Owner_Handle");
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public void VersionEightUpgradeAddsEmptyScheduledAndScanTablesWithVerifiedBackup()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore oldStore = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne, Migrations.VersionTwo,
            Migrations.VersionThree, Migrations.VersionFour, Migrations.VersionFive, Migrations.VersionSix, Migrations.VersionSeven,
            Migrations.VersionEight]))
        {
            oldStore.RecordXObservations(new(Owner, [Post("501", Now.AddDays(-2))]), Now);
            Assert.AreEqual(8, oldStore.SchemaVersion);
        }
        using CatalogueStore store = CatalogueStore.Open(databasePath);
        Assert.AreEqual(9, store.SchemaVersion);
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v8-*.sqlite").Length);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_scheduled_posts"));
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_scan_state"));
        Assert.AreEqual(new XScanStatus(null, null), store.GetXScanStatus());
    }

    [TestMethod]
    public void ScheduledListReplacesThePreviousOneAndMarksMissingPostsGone()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Post("501", Now.AddDays(-2))]), Now);
        XScheduledItem a = Item("7001", Now.AddDays(2), "benign scheduled a", 2, ["video", "photo"]);
        XScheduledItem b = Item("7002", Now.AddDays(1), "benign scheduled b", 3, ["video"]);

        Assert.AreEqual(new XScheduledResult(2, 0), store.RecordXScheduledPosts(new(new(OwnerId, null), [a, b]), Now));
        IReadOnlyList<XScheduledPost> listed = store.GetXScheduledPosts();
        CollectionAssert.AreEqual(new[] { "7002", "7001" }, listed.Select(post => post.ScheduledId).ToArray());
        Assert.AreEqual("1 video, 2 media", listed[0].MediaSummary);
        Assert.AreEqual("1 video, 1 photo", listed[1].MediaSummary);
        Assert.AreEqual(Now.AddDays(2).ToString("O", CultureInfo.InvariantCulture), listed[1].ScheduledUtc);

        // b was posted (or deleted): it is no longer listed and becomes gone.
        Assert.AreEqual(new XScheduledResult(1, 1), store.RecordXScheduledPosts(new(new(OwnerId, "Owner_Handle"),
            [a with { Text = "edited" }]), Now.AddHours(1)));
        XScheduledPost only = store.GetXScheduledPosts().Single();
        Assert.AreEqual("edited", only.Text);
        Assert.AreEqual(1L, Scalar(store, "SELECT gone FROM x_scheduled_posts WHERE scheduled_id = '7002'"));

        // An empty list is a real answer; a re-listed post comes back.
        Assert.AreEqual(new XScheduledResult(0, 1), store.RecordXScheduledPosts(new(new(OwnerId, null), []), Now.AddHours(2)));
        Assert.AreEqual(0, store.GetXScheduledPosts().Count);
        store.RecordXScheduledPosts(new(new(OwnerId, null), [b]), Now.AddHours(3));
        Assert.AreEqual("7002", store.GetXScheduledPosts().Single().ScheduledId);
        Assert.AreEqual(Now.ToString("O", CultureInfo.InvariantCulture),
            Scalar(store, "SELECT first_seen_utc FROM x_scheduled_posts WHERE scheduled_id = '7002'"));
    }

    [TestMethod]
    public void ScheduledListIsRefusedForAnotherOrUnknownAccountAndForMalformedRows()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        XScheduledItem a = Item("7001", Now.AddDays(1), "benign", 0, []);
        Assert.AreEqual("x-owner-unknown", Assert.ThrowsException<XObservationException>(() =>
            store.RecordXScheduledPosts(new(new(OwnerId, null), [a]), Now)).Code);
        store.RecordXObservations(new(Owner, [Post("501", Now.AddDays(-2))]), Now);
        Assert.AreEqual("x-owner-mismatch", Assert.ThrowsException<XObservationException>(() =>
            store.RecordXScheduledPosts(new(new("2000000000000000002", "Someone_Else"), [a]), Now)).Code);
        foreach (XScheduledBatch bad in new XScheduledBatch[]
        {
            new(new("not-an-id", null), [a]),
            new(new(OwnerId, "bad handle!"), [a]),
            new(new(OwnerId, null), [a, a]),
            new(new(OwnerId, null), [a with { ScheduledUtc = "tomorrow" }]),
            new(new(OwnerId, null), [a with { Text = new string('x', 281) }]),
            new(new(OwnerId, null), [a with { MediaCount = 11 }]),
            new(new(OwnerId, null), [a with { MediaTypes = ["video"] }]),
            new(new(OwnerId, null), [a with { MediaCount = 1, MediaTypes = ["evil"] }]),
            new(new(OwnerId, null), [.. Enumerable.Range(1, 101).Select(index => a with { ScheduledId = $"{index}" })]),
        })
            Assert.AreEqual("invalid-x-scheduled", Assert.ThrowsException<XObservationException>(() =>
                store.RecordXScheduledPosts(bad, Now)).Code);
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_scheduled_posts"));
    }

    [TestMethod]
    public void ScanPlanCarriesTheOwnerRequestAndRecentOwnPostsAndAResultAnswersOlderRequests()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        XScanPlan empty = store.GetXScanPlan(Now);
        Assert.IsNull(empty.Owner);
        Assert.AreEqual(0, empty.RecentPostsUtc.Count);

        store.RecordXObservations(new(Owner, [
            Post("501", Now.AddDays(-10)),
            Post("502", Now.AddDays(-40)),
            Post("503", Now.AddDays(-1)) with { InReplyToStatusId = "501" },
        ]), Now);
        XScanPlan plan = store.GetXScanPlan(Now);
        Assert.AreEqual(new XScanOwner(OwnerId, "Owner_Handle"), plan.Owner);
        Assert.IsNull(plan.RequestedUtc);
        CollectionAssert.AreEqual(new[] { Now.AddDays(-10).ToString("O", CultureInfo.InvariantCulture) },
            plan.RecentPostsUtc.ToArray());

        XScanStatus requested = store.RequestXScan(Now);
        Assert.AreEqual(Now.ToString("O", CultureInfo.InvariantCulture), requested.RequestedUtc);
        Assert.AreEqual(requested.RequestedUtc, store.GetXScanPlan(Now).RequestedUtc);

        // A scan that started before the request leaves it pending.
        XScanReport early = Report(Now.AddMinutes(-5), "complete");
        XScanStatus afterEarly = store.RecordXScanResult(early);
        Assert.AreEqual(requested.RequestedUtc, afterEarly.RequestedUtc);
        Assert.AreEqual("complete", afterEarly.Last!.Outcome);
        XScanStatus answered = store.RecordXScanResult(Report(Now.AddMinutes(1), "error") with { Detail = "http-429" });
        Assert.IsNull(answered.RequestedUtc);
        Assert.AreEqual(new XScanReport("requested", "routine", Now.AddMinutes(1).ToString("O", CultureInfo.InvariantCulture),
            Now.AddMinutes(3).ToString("O", CultureInfo.InvariantCulture), "error", "http-429", 3, 40, 2), answered.Last);

        string paused = Now.AddHours(9).ToString("O", CultureInfo.InvariantCulture);
        Assert.AreEqual(paused, store.RecordXScanResult(Report(Now.AddMinutes(4), "error") with
            { Detail = "http-429", BackoffUntilUtc = paused }).Last!.BackoffUntilUtc);
        // The scan run after an OFEnhancer start is recorded as such.
        Assert.AreEqual("startup", store.RecordXScanResult(Report(Now.AddMinutes(4), "complete") with
            { Trigger = "startup" }).Last!.Trigger);
        XScanReport tookOver = Report(Now.AddMinutes(5), "user-took-over");
        Assert.AreEqual(tookOver, store.RecordXScanResult(tookOver).Last);
        Assert.AreEqual("", tookOver.BackoffUntilUtc);

        foreach (XScanReport bad in new[]
        {
            early with { BackoffUntilUtc = "later" },
            early with { Trigger = "sometime" },
            early with { Mode = "full" },
            early with { Outcome = "posted" },
            early with { Detail = "Bad Detail" },
            early with { StartedUtc = "soon" },
            early with { Pages = -1 },
            early with { Rows = 100_001 },
            early with { Scheduled = 101 },
        })
            Assert.AreEqual("invalid-x-scan", Assert.ThrowsException<XObservationException>(() =>
                store.RecordXScanResult(bad)).Code);
    }

    [TestMethod]
    public void OverviewCarriesTheScheduledPostsAndTheScanStatus()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Post("501", Now.AddDays(-2))]), Now);
        store.RecordXScheduledPosts(new(new(OwnerId, null), [Item("7001", Now.AddDays(1), "benign", 1, ["video"])]), Now);
        store.RecordXScanResult(Report(Now, "page-cap"));

        XTeaserOverview overview = store.GetXTeaserOverview();
        XScheduledPost scheduled = overview.Scheduled!.Single();
        Assert.AreEqual(new XScheduledPost("7001", Now.AddDays(1).ToString("O", CultureInfo.InvariantCulture), "benign", "1 video",
            Now.ToString("O", CultureInfo.InvariantCulture)), scheduled);
        Assert.AreEqual("page-cap", overview.Scan!.Last!.Outcome);
        Assert.IsNull(overview.Scan.RequestedUtc);
    }

    [TestMethod]
    public void LiveScanLogIsKeptInMemoryValidatedAndNeverShownRunningOnceStale()
    {
        XScanActivityBoard board = new();
        Assert.IsNull(board.Latest(Now));
        XScanActivity running = Activity(Now, running: true);
        Assert.AreEqual(running, board.Record(running));
        XScanActivity latest = board.Latest(Now.AddSeconds(30))!;
        Assert.IsTrue(latest.Running);
        Assert.AreEqual(12345L, latest.Events.Single(item => item.Post is not null).Post!.Metrics!.Views);

        // Chrome stopped reporting: the log is kept but no longer running.
        XScanActivity stale = board.Latest(Now.Add(XScanActivityBoard.StaleAfter).AddSeconds(1))!;
        Assert.IsFalse(stale.Running);
        Assert.AreEqual("stale", stale.Phase);
        XScanActivity done = Activity(Now.AddMinutes(1), running: false) with { Phase = "done", Outcome = "complete" };
        board.Record(done);
        Assert.AreEqual(done, board.Latest(Now.AddHours(5)));

        XScanActivityPost post = running.Posts[0];
        foreach (XScanActivity bad in new[]
        {
            running with { Version = 2 },
            running with { RunId = "not-a-run" },
            running with { Trigger = "sometime" },
            running with { Phase = "posting" },
            running with { Outcome = "posted" },
            running with { UpdatedUtc = "" },
            running with { Pages = -1 },
            running with { Expected = -1 },
            running with { Posts = [post with { PosterUrl = "https://example.com/a.jpg" }] },
            running with { Posts = [post with { PosterUrl = "http://pbs.twimg.com/a.jpg" }] },
            running with { Posts = [post with { StatusId = "x1" }] },
            running with { Posts = [post with { Kind = "ad" }] },
            running with { Posts = [post with { Metrics = post.Metrics! with { Views = -1 } }] },
            running with { Posts = [post with { Text = new string('x', 141) }] },
            running with { Posts = Enumerable.Repeat(post, 41).ToList() },
            running with { Events = [new(running.UpdatedUtc, "post", "no post attached")] },
            running with { Events = [new(running.UpdatedUtc, "step", "a step with a post", post)] },
            running with { Events = [new(running.UpdatedUtc, "step", new string('x', 241))] },
            running with { Events = Enumerable.Repeat(new XScanActivityEvent(running.UpdatedUtc, "step", "s"), 61).ToList() },
        })
            Assert.AreEqual("invalid-x-scan-activity", Assert.ThrowsException<XObservationException>(() =>
                board.Record(bad)).Code);
        Assert.AreEqual(done, board.Latest(Now.AddHours(5)), "A refused log leaves the last good one.");
    }

    [TestMethod]
    public void ScanPlanCarriesNoDesktopStartUntilTheDesktopAddsIt()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        XScanPlan plan = store.GetXScanPlan(Now);
        Assert.IsNull(plan.DesktopStartedUtc);
        Assert.AreEqual((0, 0), (plan.KnownPosts, plan.KnownPostsInWindow));
        // The progress total: owner posts recorded overall and in the 35-day window.
        store.RecordXObservations(new(Owner, [Post("501", Now.AddDays(-2)), Post("502", Now.AddDays(-34)),
            Post("503", Now.AddDays(-40))]), Now);
        XScanPlan counted = store.GetXScanPlan(Now);
        Assert.AreEqual((3, 2), (counted.KnownPosts, counted.KnownPostsInWindow));
        Assert.AreEqual("2026-10-01T11:00:00.0000000+00:00",
            (plan with { DesktopStartedUtc = Now.AddHours(-1).ToString("O", CultureInfo.InvariantCulture) }).DesktopStartedUtc);
    }

    private static XScanActivity Activity(DateTimeOffset updated, bool running)
    {
        string at = updated.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        XScanActivityPost post = new("9101", "2026-09-30T18:00:00.000Z", "post", "benign preview", "video",
            "https://pbs.twimg.com/ext_tw_video_thumb/9101/pu/img/poster.jpg", new(12345, 1204, 37, 12, 0, null));
        return new(1, "0123456789abcdef0123456789abcdef", running, "startup", "routine", running ? "reading" : "done",
            at, at, 1, 20, "", [post],
            [new(at, "step", "Page 1: read 20 posts of yours"), new(at, "post", "Page 1: Video post 9101 — 12,345 views", post)]);
    }

    private static XScanReport Report(DateTimeOffset started, string outcome) =>
        new("requested", "routine", started.ToString("O", CultureInfo.InvariantCulture),
            started.AddMinutes(2).ToString("O", CultureInfo.InvariantCulture), outcome, "", 3, 40, 2);

    private static XScheduledItem Item(string id, DateTimeOffset when, string text, int mediaCount, string[] types) =>
        new(id, when.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture), text, mediaCount, types);

    private static XObservation Post(string statusId, DateTimeOffset created) =>
        new(statusId, OwnerId, "Owner_Handle", created.ToString("O", CultureInfo.InvariantCulture), "benign post", null,
            statusId, false, [], [], null, "network");

    private static object? Scalar(CatalogueStore store, string sql)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = sql;
        object? value = command.ExecuteScalar();
        return value is DBNull ? null : value;
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xs-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
