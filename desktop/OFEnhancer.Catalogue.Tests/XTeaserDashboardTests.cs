using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XTeaserDashboardTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly XOwnerIdentity Owner = new(OwnerId, "Owner_Handle");
    private static readonly DateTimeOffset Now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public void VersionSevenUpgradeAddsAnEmptyPlanTableWithVerifiedBackup()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore oldStore = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne, Migrations.VersionTwo,
            Migrations.VersionThree, Migrations.VersionFour, Migrations.VersionFive, Migrations.VersionSix, Migrations.VersionSeven]))
        {
            AddItem(oldStore, "kept-id", "kept-key", "Games", "Series A", "3");
            Assert.AreEqual(7, oldStore.SchemaVersion);
        }
        using CatalogueStore store = CatalogueStore.Open(databasePath);
        Assert.AreEqual(9, store.SchemaVersion);
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v7-*.sqlite").Length);
        Assert.AreEqual("kept-id", store.GetItems().Single().ItemId);
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_planned_slots"));
    }

    [TestMethod]
    public void OverviewListsEveryActiveEpisodeWithItsCategoryAndSeason()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-1", "series-a-e1", "Games", "Series A", "1");
        AddItem(store, "item-2", "series-b-e1", "Dolls", "Series B", "1");
        AddItem(store, "item-3", "archived-e1", "Dolls", "Series B", "2", archived: true);
        AddClip(store, "series-a-e1__t1.mp4", "series-a-e1", "ready");

        XTeaserOverview overview = store.GetXTeaserOverview();
        CollectionAssert.AreEquivalent(new[] { "item-1", "item-2" }, overview.Episodes.Select(episode => episode.ItemId).ToArray());
        XTeaserEpisode uncovered = overview.Episodes.Single(episode => episode.ItemId == "item-2");
        Assert.AreEqual(new XTeaserEpisode("item-2", "series-b-e1", "Series B E1", 0, 0, 0, 0, 0, 0, "Dolls", "Series B", "1"), uncovered);
        Assert.AreEqual(1, overview.Episodes.Single(episode => episode.ItemId == "item-1").ReadyClips);
    }

    [TestMethod]
    public void OverviewPassesOnlyXHostedPosterImages()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        DateTimeOffset posted = Now.AddDays(-1);
        store.RecordXObservations(new(Owner, [
            Post("801", posted, "https://pbs.twimg.com/ext_tw_video_thumb/801/pu/img/a.jpg"),
            Post("802", posted.AddHours(1), "https://pbs.twimg.com/ext_tw_video_thumb/802/pu/img/b.jpg"),
            Post("803", posted.AddHours(2), null),
        ]), Now);
        // The collector refuses other hosts; a stored row from elsewhere is still not passed on.
        Exec(store, """UPDATE x_posts SET media_json = '[{"type":"video","posterUrl":"https://example.com/b.jpg"}]' WHERE status_id = '802'""");

        Dictionary<string, string?> posters = store.GetXTeaserOverview().Posts.ToDictionary(post => post.StatusId, post => post.PosterUrl);
        Assert.AreEqual("https://pbs.twimg.com/ext_tw_video_thumb/801/pu/img/a.jpg", posters["801"]);
        Assert.IsNull(posters["802"]);
        Assert.IsNull(posters["803"]);
    }

    [TestMethod]
    public void UsualIsTheMedianOfOtherTeasersAtAComparableAge()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        DateTimeOffset posted = Now.AddDays(-20);
        // Target at 24 h; peers have one comparable sample each plus far-off samples that must be ignored.
        AddTeaser(store, "900", posted, (24, 1000, 100, 10, 0, 0));
        AddTeaser(store, "901", posted.AddDays(1), (22, 400, 8, 2, 0, 0), (168, 99999, 9999, 999, 0, 0));
        AddTeaser(store, "902", posted.AddDays(2), (25, 600, 12, 4, 0, 0), (2, 1, 1, 1, 0, 0));
        AddTeaser(store, "903", posted.AddDays(3), (28, 800, 20, 6, 4, 0));
        AddTeaser(store, "904", posted.AddDays(4), (90, 5000, 50, 5, 0, 0));

        XTeaserPost target = store.GetXTeaserOverview().Posts.Single(post => post.StatusId == "900");
        XTeaserUsual usual = target.Usual!;
        Assert.AreEqual(24, usual.AgeHours);
        Assert.AreEqual(3, usual.Peers);
        Assert.AreEqual(600d, usual.Views);
        Assert.AreEqual(12d, usual.Likes);
        Assert.AreEqual(4d, usual.Reposts);
        // Peer rates 10/400, 16/600 and 30/800.
        Assert.AreEqual(16d / 600, usual.EngagementRate!.Value, 1e-12);

        // Fewer than three comparable peers leaves the usual unknown.
        XTeaserPost lonely = store.GetXTeaserOverview().Posts.Single(post => post.StatusId == "904");
        Assert.IsNull(lonely.Usual);
    }

    [TestMethod]
    public void PlanSlotsAreValidatedReplacedAndCleared()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-1", "Series-A-E1", "Games", "Series A", "1");
        AddItem(store, "item-2", "series-b-e1", "Dolls", "Series B", "1");
        long ready = AddClip(store, "series-a-e1__t2.mp4", "series-a-e1", "ready");
        long failed = AddClip(store, @"Done\Failed\series-a-e1__t1.mp4", "series-a-e1", "failed");
        long other = AddClip(store, "series-b-e1__t1.mp4", "series-b-e1", "ready");

        XTeaserPlanSlot first = store.SetXTeaserPlanSlot("2026-09-29", "series-a-e1", ready, Now);
        Assert.AreEqual("Series-A-E1", first.EpisodeKey, "the catalogue's own key is stored");
        Assert.AreEqual("item-1", first.ItemId);
        Assert.IsFalse(first.ReEdit);
        store.SetXTeaserPlanSlot("2026-09-30", "series-b-e1", null, Now);
        XTeaserPlanSlot remake = store.SetXTeaserPlanSlot("2026-09-29", "series-a-e1", failed, Now.AddMinutes(1));
        Assert.IsTrue(remake.ReEdit);

        IReadOnlyList<XTeaserPlanSlot> slots = store.GetXTeaserPlan("2026-09-28").Slots;
        CollectionAssert.AreEqual(new[] { "2026-09-29", "2026-09-30" }, slots.Select(slot => slot.Date).ToArray());
        Assert.AreEqual(failed, slots[0].ClipId);
        Assert.IsTrue(slots[0].ReEdit);
        Assert.IsNull(slots[1].ClipId);
        Assert.AreEqual(1, store.GetXTeaserPlan("2026-09-30").Slots.Count);

        Assert.AreEqual("x-plan-episode-not-found", Assert.ThrowsException<XTeaserException>(() =>
            store.SetXTeaserPlanSlot("2026-10-01", "missing-key", null, Now)).Code);
        Assert.AreEqual("x-plan-clip-not-found", Assert.ThrowsException<XTeaserException>(() =>
            store.SetXTeaserPlanSlot("2026-10-01", "series-a-e1", other, Now)).Code);
        Assert.AreEqual("x-plan-clip-not-found", Assert.ThrowsException<XTeaserException>(() =>
            store.SetXTeaserPlanSlot("2026-10-01", "series-a-e1", 9999, Now)).Code);
        foreach (string bad in new[] { "2026-9-30", "2026-02-30", "30/09/2026", "", "2026-09-30T00:00" })
            Assert.AreEqual("invalid-teaser-plan", Assert.ThrowsException<XTeaserException>(() =>
                store.SetXTeaserPlanSlot(bad, "series-a-e1", null, Now)).Code, bad);
        Assert.AreEqual(2L, Scalar(store, "SELECT COUNT(*) FROM x_planned_slots"));

        Assert.IsTrue(store.ClearXTeaserPlanSlot("2026-09-29"));
        Assert.IsFalse(store.ClearXTeaserPlanSlot("2026-09-29"));
        Assert.AreEqual("2026-09-30", store.GetXTeaserPlan("2026-09-01").Slots.Single().Date);
    }

    private static XObservation Post(string statusId, DateTimeOffset created, string? poster) =>
        new(statusId, OwnerId, "Owner_Handle", created.ToString("O", CultureInfo.InvariantCulture), "benign teaser", null,
            statusId, false, [new("video", "7_1900000000000000001", 15_000, poster)], [], null, "network");

    private static void AddTeaser(CatalogueStore store, string statusId, DateTimeOffset posted,
        params (double Age, long Views, long Likes, long Reposts, long Replies, long Bookmarks)[] samples)
    {
        store.RecordXObservations(new(Owner, [Post(statusId, posted, null)]), Now);
        foreach (var sample in samples)
            Exec(store, $"""
                INSERT INTO x_metric_samples(status_id,observed_utc,age_hours,views,likes,reposts,replies,quotes,bookmarks,source)
                VALUES ('{statusId}','{posted.AddHours(sample.Age).ToString("yyyy-MM-dd'T'HH:mm':00Z'", CultureInfo.InvariantCulture)}',
                        {sample.Age.ToString(CultureInfo.InvariantCulture)},
                        {sample.Views},{sample.Likes},{sample.Reposts},{sample.Replies},0,{sample.Bookmarks},'network')
                """);
    }

    private static void AddItem(CatalogueStore store, string itemId, string sourceKey, string category, string series, string episode,
        bool archived = false)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = """
            INSERT INTO catalogue_items(item_id,source_key,title,description,series,episode,category,archived,updated_utc)
            VALUES ($id,$key,$title,'',$series,$episode,$category,$archived,'2026-09-01T00:00:00Z')
            """;
        command.Parameters.AddWithValue("$id", itemId);
        command.Parameters.AddWithValue("$key", sourceKey);
        command.Parameters.AddWithValue("$title", $"{series} E{episode}");
        command.Parameters.AddWithValue("$series", series);
        command.Parameters.AddWithValue("$episode", episode);
        command.Parameters.AddWithValue("$category", category);
        command.Parameters.AddWithValue("$archived", archived ? 1 : 0);
        command.ExecuteNonQuery();
    }

    private static long AddClip(CatalogueStore store, string relPath, string episodeKey, string state)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = """
            INSERT INTO x_local_clips(rel_path,size_bytes,mtime_utc,sha256,episode_key,state,first_seen_utc,last_seen_utc)
            VALUES ($path,1,'2026-09-01T00:00:00Z',$sha,$key,$state,'x','x');
            SELECT last_insert_rowid();
            """;
        command.Parameters.AddWithValue("$path", relPath);
        command.Parameters.AddWithValue("$sha", new string('a', 64));
        command.Parameters.AddWithValue("$key", episodeKey);
        command.Parameters.AddWithValue("$state", state);
        return (long)command.ExecuteScalar()!;
    }

    private static void Exec(CatalogueStore store, string sql)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

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
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xd-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
