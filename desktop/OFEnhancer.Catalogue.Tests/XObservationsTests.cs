using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XObservationsTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly XOwnerIdentity Owner = new(OwnerId, "Owner_Handle");
    private static readonly DateTimeOffset Now = new(2026, 9, 28, 12, 0, 30, TimeSpan.Zero);

    private static XObservation Row(string statusId, string? authorId = OwnerId, string handle = "Owner_Handle",
        string source = "network", long? views = 100, long? likes = 10, string text = "benign teaser text",
        bool retweet = false, XObservedMetrics? metrics = null, IReadOnlyList<string>? urls = null,
        IReadOnlyList<XObservedMedia>? media = null) =>
        new(statusId, authorId, handle, "2026-09-27T12:00:30.000Z", text, null, statusId, retweet,
            media ?? [new("video", "7_1900000000000000001", 15_000, "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg")],
            urls ?? ["https://onlyfans.com/123/example"],
            retweet ? null : metrics ?? new(views, likes, 1, 2, 0, 3), source);

    [TestMethod]
    public void VersionFiveUpgradeAddsEmptyXTablesWithVerifiedBackup()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore oldStore = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne,
            Migrations.VersionTwo, Migrations.VersionThree, Migrations.VersionFour, Migrations.VersionFive]))
        {
            using SqliteCommand command = oldStore.Connection.CreateCommand();
            command.CommandText = "INSERT INTO catalogue_items(item_id,source_key,title,description,updated_utc,category) VALUES ('kept-id','kept-key','Kept title','','2026-09-08T12:00:00Z','Review')";
            command.ExecuteNonQuery();
            Assert.AreEqual(5, oldStore.SchemaVersion);
        }
        using CatalogueStore store = CatalogueStore.Open(databasePath);
        Assert.AreEqual(6, store.SchemaVersion);
        Assert.AreEqual("Review", store.GetItems().Single().Category);
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v5-*.sqlite").Length);
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
        Assert.IsNull(store.GetXOwner());
    }

    [TestMethod]
    public void OwnerPostsUpsertAndSamplesDedupeWithinTenMinutes()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        Assert.AreEqual(new XObservationResult(1, 1, 0, 0), store.RecordXObservations(new(Owner, [Row("11")]), Now));
        Assert.AreEqual(new XObservationResult(1, 0, 1, 0), store.RecordXObservations(new(Owner, [Row("11")]), Now.AddSeconds(20)));
        Assert.AreEqual(new XObservationResult(1, 0, 1, 0), store.RecordXObservations(new(Owner, [Row("11")]), Now.AddMinutes(5)));
        // A DOM sample without quotes is near-identical to the network one.
        Assert.AreEqual(new XObservationResult(1, 0, 1, 0), store.RecordXObservations(new(new(null, "owner_handle"),
            [Row("11", authorId: null, source: "dom", metrics: new(100, 10, 1, 2, null, 3))]), Now.AddMinutes(6)));
        Assert.AreEqual(new XObservationResult(1, 1, 0, 0), store.RecordXObservations(new(Owner, [Row("11", views: 150)]), Now.AddMinutes(7)));
        Assert.AreEqual(new XObservationResult(1, 1, 0, 0), store.RecordXObservations(new(Owner, [Row("11", views: 150)]), Now.AddMinutes(18)));

        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        Assert.AreEqual(3L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
        Assert.AreEqual(24.0, (double)Scalar(store, "SELECT age_hours FROM x_metric_samples ORDER BY observed_utc LIMIT 1")!, 0.01);
        Assert.AreEqual("2026-09-28T12:00:00Z", Scalar(store, "SELECT observed_utc FROM x_metric_samples ORDER BY observed_utc LIMIT 1"));
        Assert.AreEqual(OwnerId, Scalar(store, "SELECT author_id FROM x_posts"));
        Assert.AreEqual("2026-09-27T12:00:30.0000000+00:00", Scalar(store, "SELECT posted_utc FROM x_posts"));
        StringAssert.Contains((string)Scalar(store, "SELECT media_json FROM x_posts")!, "\"durationMs\":15000");
        Assert.AreEqual(Now.AddMinutes(18).ToString("O"), Scalar(store, "SELECT last_seen_utc FROM x_posts"));
        Assert.AreEqual(Now.ToString("O"), Scalar(store, "SELECT first_seen_utc FROM x_posts"));
        Assert.AreEqual(new XStoredOwner(OwnerId, "Owner_Handle"), store.GetXOwner());
    }

    [TestMethod]
    public void DomSightingsNeverOverwriteNetworkContent()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Row("12", text: "network text")]), Now);
        store.RecordXObservations(new(new(null, "Owner_Handle"),
            [Row("12", authorId: null, source: "dom", text: "dom text", urls: [], media: [])]), Now.AddHours(1));
        Assert.AreEqual("network text", Scalar(store, "SELECT text FROM x_posts"));
        StringAssert.Contains((string)Scalar(store, "SELECT urls_json FROM x_posts")!, "onlyfans.com");

        store.RecordXObservations(new(new(null, "Owner_Handle"),
            [Row("13", authorId: null, source: "dom", text: "dom only")]), Now);
        Assert.AreEqual(OwnerId, Scalar(store, "SELECT author_id FROM x_posts WHERE status_id = '13'"));
        Assert.AreEqual("dom", Scalar(store, "SELECT source FROM x_metric_samples WHERE status_id = '13'"));
    }

    [TestMethod]
    public void ForeignAuthorRowsAreCountedAndNeverStored()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        XObservationResult result = store.RecordXObservations(new(Owner, [
            Row("21"),
            Row("22", authorId: "2000000000000000002", handle: "Someone_Else"),
            Row("23", authorId: "2000000000000000002", handle: "Owner_Handle"),
        ]), Now);
        Assert.AreEqual(new XObservationResult(1, 1, 0, 2), result);
        XObservationResult dom = store.RecordXObservations(new(new(null, "Owner_Handle"), [
            Row("24", authorId: null, handle: "Someone_Else", source: "dom"),
        ]), Now);
        Assert.AreEqual(new XObservationResult(0, 0, 0, 1), dom);
        Assert.AreEqual("21", Scalar(store, "SELECT group_concat(status_id) FROM x_posts"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
    }

    [TestMethod]
    public void ADifferentSignedInAccountIsRefusedWhole()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Row("31")]), Now);
        XObservationException byId = Assert.ThrowsException<XObservationException>(() => store.RecordXObservations(
            new(new("2000000000000000002", "Owner_Handle"), [Row("32", authorId: "2000000000000000002")]), Now));
        Assert.AreEqual("x-owner-mismatch", byId.Code);
        XObservationException byHandle = Assert.ThrowsException<XObservationException>(() => store.RecordXObservations(
            new(new(null, "Someone_Else"), [Row("33", authorId: null, handle: "Someone_Else", source: "dom")]), Now));
        Assert.AreEqual("x-owner-mismatch", byHandle.Code);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));

        // The same account under a new handle keeps its identity.
        store.RecordXObservations(new(new(OwnerId, "Renamed_Owner"), [Row("34", handle: "Renamed_Owner")]), Now);
        Assert.AreEqual(new XStoredOwner(OwnerId, "Renamed_Owner"), store.GetXOwner());
    }

    [TestMethod]
    public void RepostsKeepNoForeignContentOrSamples()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Assert.AreEqual(new XObservationResult(1, 0, 0, 0), store.RecordXObservations(
            new(Owner, [Row("41", retweet: true, text: "", urls: [], media: [])]), Now));
        Assert.AreEqual(1L, Scalar(store, "SELECT is_retweet FROM x_posts"));
        Assert.AreEqual("[]", Scalar(store, "SELECT media_json FROM x_posts"));
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
    }

    [TestMethod]
    public void MalformedBatchesAreRejectedWithoutWrites()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        XObservationBatch[] invalid =
        [
            new(Owner, []),
            new(Owner, [.. Enumerable.Range(1, 101).Select(index => Row(index.ToString()))]),
            new(new(OwnerId, "bad handle!"), [Row("51")]),
            new(new("12ab", "Owner_Handle"), [Row("51")]),
            new(Owner, [Row("not-an-id")]),
            new(Owner, [Row("51", text: new string('a', 2001))]),
            new(Owner, [Row("51", authorId: null)]),
            new(Owner, [Row("51", source: "dom")]),
            new(Owner, [Row("51", source: "scrape")]),
            new(Owner, [Row("51", views: -1)]),
            new(Owner, [Row("51", urls: ["javascript:alert(1)"])]),
            new(Owner, [Row("51", urls: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4", "https://a.example/5", "https://a.example/6"])]),
            new(Owner, [Row("51", media: [new("video", null, null, "https://evil.example/a.jpg")])]),
            new(Owner, [Row("51", media: [new("audio", null, null, null)])]),
            new(Owner, [Row("51", media: [new("video", "bad", null, null)])]),
            new(Owner, [Row("51", retweet: true)]),
            new(Owner, [Row("51") with { CreatedAt = "yesterday" }]),
            new(Owner, [Row("51") with { InReplyToStatusId = "abc" }]),
        ];
        foreach (XObservationBatch batch in invalid)
        {
            XObservationException error = Assert.ThrowsException<XObservationException>(() => store.RecordXObservations(batch, Now));
            Assert.AreEqual("invalid-x-observations", error.Code);
        }
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        Assert.IsNull(store.GetXOwner());
    }

    private static object? Scalar(CatalogueStore store, string sql)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-x-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
