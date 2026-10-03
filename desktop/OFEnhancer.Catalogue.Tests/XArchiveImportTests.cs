using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XArchiveImportTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly DateTimeOffset Now = new(2026, 10, 3, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public void DryRunReportsMissingRowsThenApplyInsertsOnlyMissingWithoutSamples()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(new(OwnerId, "Owner_Handle"), [LiveRow("1", "live text")] ), Now.AddDays(-1));
        string archive = MakeArchive(temp.Path,
            [ArchiveRow("1", "archive text", "2024-09-20T00:00:00Z", 44, 8), ArchiveRow("2", "archive only", "2026-10-01T00:00:00Z", null, null)],
            splitParts: true);

        XArchiveImportResult dry = store.ImportXArchive(archive, Now, apply: false);
        Assert.AreEqual(new XArchiveImportResult(false, 2, 0, 1, 1, 0, 1, 1,
            "2024-09-20T00:00:00.0000000+00:00", "2026-10-01T00:00:00.0000000+00:00"), dry);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));

        XArchiveImportResult applied = store.ImportXArchive(archive, Now, apply: true);
        Assert.AreEqual(1, applied.ImportedPosts);
        Assert.AreEqual(1, applied.ExistingPosts);
        Assert.AreEqual("live text", Scalar(store, "SELECT text FROM x_posts WHERE status_id='1'"));
        Assert.AreEqual("archive only", Scalar(store, "SELECT text FROM x_posts WHERE status_id='2'"));
        Assert.AreEqual("Owner_Handle", Scalar(store, "SELECT handle FROM x_owner WHERE singleton=1"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
        Assert.AreEqual("2026-10-03T12:00:00.0000000+00:00", Scalar(store, "SELECT first_seen_utc FROM x_posts WHERE status_id='2'"));
        Assert.AreEqual(0, store.ImportXArchive(archive, Now, apply: true).ImportedPosts);
    }

    [TestMethod]
    public void MultipartDuplicateRowsAreCountedOnceAndRepliesKeepOnlyExplicitParent()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(new(OwnerId, "Owner_Handle"), [LiveRow("9", "seed")]), Now);
        string archive = MakeArchive(temp.Path,
            [ArchiveRow("10", "first", "2025-01-01T00:00:00Z", 10, 2, "9", media: true)], splitParts: true,
            secondPartRows: [ArchiveRow("10", "first", "2025-01-01T00:00:00Z", 10, 2, "9", media: true)]);

        XArchiveImportResult result = store.ImportXArchive(archive, Now, apply: true);
        Assert.AreEqual(1, result.ArchivePosts);
        Assert.AreEqual(1, result.DuplicateArchiveRows);
        Assert.AreEqual("9", Scalar(store, "SELECT in_reply_to FROM x_posts WHERE status_id='10'"));
        Assert.AreEqual(DBNull.Value, Scalar(store, "SELECT conversation_id FROM x_posts WHERE status_id='10'"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
        File.AppendAllText(Path.Combine(archive, "data", "tweets-part0.js"), "globalThis.untrustedCode = true;");
        Assert.AreEqual("archive-json-invalid", Assert.ThrowsException<XObservationException>(
            () => store.ImportXArchive(archive, Now, true)).Code);
    }

    [TestMethod]
    public void TwitterTimestampStringCountersAndMediaMetadataAreReadWithoutExecutingScript()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(new(OwnerId, "Owner_Handle"), [LiveRow("29", "seed")]), Now);
        string archive = MakeArchive(temp.Path, [ArchiveRow("30", "plain text", "Fri Sep 20 19:51:33 +0000 2024", 1, 2,
            media: true, stringCounters: true)]);

        XArchiveImportResult result = store.ImportXArchive(archive, Now, apply: true);
        Assert.AreEqual(0, result.RowsMissingLikes);
        Assert.AreEqual(0, result.RowsMissingReposts);
        Assert.AreEqual("2024-09-20T19:51:33.0000000+00:00", Scalar(store, "SELECT posted_utc FROM x_posts WHERE status_id='30'"));
        StringAssert.Contains((string)Scalar(store, "SELECT media_json FROM x_posts WHERE status_id='30'")!, "\"type\":\"video\"");
        StringAssert.Contains((string)Scalar(store, "SELECT urls_json FROM x_posts WHERE status_id='30'")!, "https://example.com/video");
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_metric_samples"));
    }

    [TestMethod]
    public void ArchiveOwnerMismatchAndMalformedPartRejectWholeImport()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(new(OwnerId, "Owner_Handle"), [LiveRow("11", "retained")]), Now);
        string wrongOwner = MakeArchive(temp.Path, [ArchiveRow("12", "ignored", "2025-01-01T00:00:00Z", 1, 1)], ownerId: "2000000000000000002");
        XObservationException mismatch = Assert.ThrowsException<XObservationException>(() => store.ImportXArchive(wrongOwner, Now, true));
        Assert.AreEqual("x-owner-mismatch", mismatch.Code);

        string malformed = MakeArchive(temp.Path, [ArchiveRow("13", "never committed", "2025-01-01T00:00:00Z", 1, 1)], splitParts: true);
        File.WriteAllText(Path.Combine(malformed, "data", "tweets-part1.js"), "window.YTD.tweets.part1 = [{ broken ];");
        XObservationException invalid = Assert.ThrowsException<XObservationException>(() => store.ImportXArchive(malformed, Now, true));
        Assert.AreEqual("archive-json-invalid", invalid.Code);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        Assert.AreEqual("retained", Scalar(store, "SELECT text FROM x_posts WHERE status_id='11'"));
    }

    [TestMethod]
    public void ImportRequiresAnEstablishedOwner()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string archive = MakeArchive(temp.Path, [ArchiveRow("20", "text", "2025-01-01T00:00:00Z", 0, 0)]);
        XObservationException error = Assert.ThrowsException<XObservationException>(() => store.ImportXArchive(archive, Now, true));
        Assert.AreEqual("archive-owner-not-established", error.Code);
    }

    private static XObservation LiveRow(string id, string text) => new(id, OwnerId, "Owner_Handle",
        "2026-10-02T12:00:00Z", text, null, id, false, [], [], new(1, 1, 0, 0, 0, 0), "network");

    private static string ArchiveRow(string id, string text, string created, long? likes, long? reposts, string? reply = null,
        bool media = false, bool stringCounters = false)
    {
        string replyProperty = reply is null ? "" : $",\"in_reply_to_status_id_str\":\"{reply}\"";
        string likeProperty = likes.HasValue ? $",\"favorite_count\":{(stringCounters ? $"\"{likes.Value}\"" : likes.Value.ToString())}" : "";
        string repostProperty = reposts.HasValue ? $",\"retweet_count\":{(stringCounters ? $"\"{reposts.Value}\"" : reposts.Value.ToString())}" : "";
        string metadata = media
            ? ",\"entities\":{\"urls\":[{\"expanded_url\":\"https://example.com/video\"}]},\"extended_entities\":{\"media\":[{\"type\":\"video\",\"media_url_https\":\"https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg\",\"video_info\":{\"duration_millis\":12000}}]}"
            : "";
        return $"{{\"tweet\":{{\"id_str\":\"{id}\",\"created_at\":\"{created}\",\"full_text\":\"{text}\"{replyProperty}{likeProperty}{repostProperty}{metadata}}}}}";
    }

    private static string MakeArchive(string root, IReadOnlyList<string> rows, bool splitParts = false,
        IReadOnlyList<string>? secondPartRows = null, string ownerId = OwnerId)
    {
        string folder = Path.Combine(root, "archive-" + Guid.NewGuid().ToString("N"));
        string data = Path.Combine(folder, "data");
        Directory.CreateDirectory(data);
        File.WriteAllText(Path.Combine(data, "account.js"),
            $"window.YTD.account.part0 = [{{\"account\":{{\"accountId\":\"{ownerId}\",\"username\":\"archived_handle\"}}}}];");
        if (splitParts)
        {
            File.WriteAllText(Path.Combine(data, "tweets-part0.js"), "window.YTD.tweets.part0 = [" + string.Join(',', rows) + "];");
            File.WriteAllText(Path.Combine(data, "tweets-part1.js"), "window.YTD.tweets.part1 = [" + string.Join(',', secondPartRows ?? []) + "];");
        }
        else File.WriteAllText(Path.Combine(data, "tweets.js"), "window.YTD.tweets.part0 = [" + string.Join(',', rows) + "];");
        return folder;
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
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-archive-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }
        public string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
