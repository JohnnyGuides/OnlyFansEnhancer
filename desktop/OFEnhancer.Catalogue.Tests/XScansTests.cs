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
