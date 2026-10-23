using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XTeaserClipPublicationTests
{
    private const string OwnerId = "1000000000000000001";
    private const string OwnerHandle = "Owner_Handle";
    private static readonly DateTimeOffset Now = new(2026, 10, 23, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public void VerifiedReceiptPostsOnlyMatchingOwnedClipAndRemainsPostedAfterRescan()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddOwnerPost(store, "9001", OwnerId);
        string root = Path.Combine(temp.Path, "TWEETS");
        const string content = "neutral synthetic clip bytes";
        WriteClip(root, "ep-a__t1.mp4", content);
        store.ApplyXClipScan(XTeaserFolder.Scan(root, []), Now);
        long clipId = ClipId(store, "ep-a__t1.mp4");
        string sha = Sha(content);

        XTeaserClipPublicationResult first = store.RecordPublishedTeaserClip(
            clipId, sha, "ep-a", "https://x.com/Owner_Handle/status/9001");

        Assert.AreEqual(new XTeaserClipPublicationResult(clipId, "9001", "ep-a", false), first);
        Assert.AreEqual("posted|9001|owner|ep-a", Scalar(store,
            $"SELECT state||'|'||status_id||'|'||pairing_evidence||'|'||episode_key FROM x_local_clips WHERE clip_id={clipId}"));
        Assert.AreEqual(0, store.GetXTeaserLibrary().Count, "published clips are not offered by the library");
        Assert.IsTrue(File.Exists(Path.Combine(root, "ep-a__t1.mp4")), "the file is left in place");

        XTeaserLibraryClip? directRead = store.GetXTeaserLibraryClip(clipId);
        Assert.IsNotNull(directRead, "direct metadata reads remain available for posted clips");
        Assert.AreEqual("posted", directRead!.State);
        XTeaserLibraryClip repeatedRender = store.UpsertXTeaserRender(store.GetXClipFingerprints().Single(), Now.AddSeconds(1));
        Assert.AreEqual(clipId, repeatedRender.ClipId);
        Assert.AreEqual("posted", repeatedRender.State, "an identical render observation preserves its publication state");
        Assert.AreEqual("ep-a", repeatedRender.EpisodeKey);
        Assert.AreEqual(0, store.GetXTeaserLibrary().Count, "a repeated render does not make the posted clip selectable again");
        Assert.IsTrue(File.Exists(Path.Combine(root, "ep-a__t1.mp4")));

        File.Move(Path.Combine(root, "ep-a__t1.mp4"), Path.Combine(root, "ep-b__t1.mp4"));
        store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now.AddMinutes(1));
        Assert.AreEqual("ep-b__t1.mp4|posted|owner|ep-a|9001", Scalar(store,
            $"SELECT rel_path||'|'||state||'|'||pairing_evidence||'|'||episode_key||'|'||status_id FROM x_local_clips WHERE clip_id={clipId}"));
        Assert.AreEqual(0, store.GetXTeaserLibrary().Count);

        XTeaserClipPublicationResult duplicate = store.RecordPublishedTeaserClip(
            clipId, sha, "ep-a", "https://x.com/owner_handle/status/9001");
        Assert.AreEqual(new XTeaserClipPublicationResult(clipId, "9001", "ep-a", true), duplicate);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_local_clips WHERE status_id='9001'"));
    }

    [TestMethod]
    public void ReceiptRejectsFingerprintEpisodeOwnerAndConflictingClip()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddOwnerPost(store, "9001", OwnerId);
        Exec(store, "INSERT INTO x_posts(status_id,author_id,posted_utc,first_seen_utc,last_seen_utc) VALUES ('9002','2000000000000000002','2026-10-23T12:00:00Z','x','x')");
        string root = Path.Combine(temp.Path, "TWEETS");
        const string firstContent = "synthetic clip one";
        const string secondContent = "synthetic clip two";
        WriteClip(root, "ep-a__t1.mp4", firstContent);
        WriteClip(root, "ep-a__t2.mp4", secondContent);
        store.ApplyXClipScan(XTeaserFolder.Scan(root, []), Now);
        long firstId = ClipId(store, "ep-a__t1.mp4");
        long secondId = ClipId(store, "ep-a__t2.mp4");

        AssertRejected(store, firstId, "0".PadLeft(64, '0'), "ep-a", "https://x.com/Owner_Handle/status/9001", "x-clip-fingerprint-mismatch");
        AssertRejected(store, firstId, Sha(firstContent), "ep-b", "https://x.com/Owner_Handle/status/9001", "x-clip-episode-mismatch");
        AssertRejected(store, firstId, Sha(firstContent), "ep-a", "https://x.com/Other_Handle/status/9001", "x-clip-status-not-owned");
        AssertRejected(store, firstId, Sha(firstContent), "ep-a", "https://x.com/Owner_Handle/status/9002", "x-clip-status-not-owned");

        store.RecordPublishedTeaserClip(firstId, Sha(firstContent), "ep-a", "https://x.com/Owner_Handle/status/9001");
        AssertRejected(store, secondId, Sha(secondContent), "ep-a", "https://x.com/Owner_Handle/status/9001", "x-clip-status-conflict");
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_local_clips WHERE status_id='9001'"));
        Assert.AreEqual(1L, Scalar(store, $"SELECT COUNT(*) FROM x_local_clips WHERE clip_id={secondId} AND status_id IS NULL AND state='ready'"));
    }

    private static void AssertRejected(CatalogueStore store, long clipId, string hash, string episode, string url, string code)
    {
        XTeaserException exception = Assert.ThrowsException<XTeaserException>(
            () => store.RecordPublishedTeaserClip(clipId, hash, episode, url));
        Assert.AreEqual(code, exception.Code);
    }

    private static void AddOwnerPost(CatalogueStore store, string statusId, string authorId)
    {
        string handle = authorId == OwnerId ? OwnerHandle : "Other_Handle";
        XOwnerIdentity owner = new(OwnerId, OwnerHandle);
        XObservation observation = new(statusId, authorId, handle, Now.ToString("O", CultureInfo.InvariantCulture),
            "synthetic teaser post", null, statusId, false, [], [], null, "network");
        store.RecordXObservations(new(owner, [observation]), Now);
    }

    private static long ClipId(CatalogueStore store, string relPath) =>
        (long)Scalar(store, $"SELECT clip_id FROM x_local_clips WHERE rel_path='{relPath}'")!;

    private static string Sha(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private static void WriteClip(string root, string relPath, string content)
    {
        string path = Path.Combine(root, relPath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    private static object? Scalar(CatalogueStore store, string sql)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = sql;
        object? value = command.ExecuteScalar();
        return value is DBNull ? null : value;
    }

    private static void Exec(CatalogueStore store, string sql)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xclip-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
