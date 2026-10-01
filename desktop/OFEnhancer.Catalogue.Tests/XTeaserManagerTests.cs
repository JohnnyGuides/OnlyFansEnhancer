using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XTeaserManagerTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly XOwnerIdentity Owner = new(OwnerId, "Owner_Handle");
    private static readonly DateTimeOffset Now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);
    private static readonly XObservedMedia Video = new("video", "7_1900000000000000001", 15_000, null);

    private static XObservation Post(string statusId, DateTimeOffset created, string text = "benign teaser",
        string? inReplyTo = null, string? conversationId = null, IReadOnlyList<string>? urls = null, bool video = true) =>
        new(statusId, OwnerId, "Owner_Handle", created.ToString("O", CultureInfo.InvariantCulture), text, inReplyTo,
            conversationId ?? statusId, false, video ? [Video] : [], urls ?? [], null, "network");

    [TestMethod]
    public void VersionSixUpgradeAddsEmptyTeaserTablesWithVerifiedBackup()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore oldStore = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne, Migrations.VersionTwo,
            Migrations.VersionThree, Migrations.VersionFour, Migrations.VersionFive, Migrations.VersionSix]))
        {
            Exec(oldStore, "INSERT INTO catalogue_items(item_id,source_key,title,description,updated_utc) VALUES ('kept-id','kept-key','Kept','','2026-09-08T12:00:00Z')");
            Exec(oldStore, "INSERT INTO x_posts(status_id,posted_utc,first_seen_utc,last_seen_utc) VALUES ('11','2026-09-01T00:00:00Z','x','x')");
            Assert.AreEqual(6, oldStore.SchemaVersion);
        }
        using CatalogueStore store = CatalogueStore.Open(databasePath);
        Assert.AreEqual(7, store.SchemaVersion);
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v6-*.sqlite").Length);
        Assert.AreEqual("kept-id", store.GetItems().Single().ItemId);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        foreach (string table in new[] { "x_post_bindings", "x_binding_conflicts", "x_first_replies", "x_local_clips", "x_teaser_verdicts", "x_clip_moves" })
            Assert.AreEqual(0L, Scalar(store, $"SELECT COUNT(*) FROM {table}"), table);
    }

    [TestMethod]
    public void BindingPrefersSheetLinksRecordsConflictsAndNeverGuesses()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-a", "show-ep01", "Benign teaser title", sheetX: ["https://x.com/Owner_Handle/status/101", "https://twitter.com/Owner_Handle/status/105"]);
        AddItem(store, "item-b", "show-ep02", "Other", onlyFans: "https://onlyfans.com/555/owner", sheetX: ["https://x.com/Owner_Handle/status/105?s=20"]);
        AddItem(store, "item-c", "show-ep03", "Third", fansly: "https://fansly.com/post/777");

        DateTimeOffset t = Now.AddDays(-2);
        store.RecordXObservations(new(Owner, [
            Post("101", t), Post("102", t.AddMinutes(30), "full vid -> onlyfans.com/555/owner", "101", "101", video: false),
            Post("103", t.AddHours(1)), Post("104", t.AddHours(2), "full vid -> https://onlyfans.com/555/owner", "103", "103",
                ["https://onlyfans.com/555/owner"], video: false),
            Post("105", t.AddHours(3)),
            Post("106", t.AddHours(4), "Benign teaser title"),
            Post("107", t.AddHours(5)), Post("108", t.AddHours(6), "-> fansly.com/post/777", "107", "107", video: false),
            Post("109", t.AddHours(7), "photo only", video: false),
        ]), Now);

        Assert.AreEqual("item-a|sheet-link|high", Scalar(store, "SELECT item_id||'|'||evidence||'|'||confidence FROM x_post_bindings WHERE status_id='101'"));
        Assert.AreEqual("item-b|reply-link|medium", Scalar(store, "SELECT item_id||'|'||evidence||'|'||confidence FROM x_post_bindings WHERE status_id='103'"));
        Assert.AreEqual("item-c|reply-link", Scalar(store, "SELECT item_id||'|'||evidence FROM x_post_bindings WHERE status_id='107'"));
        Assert.IsNull(Scalar(store, "SELECT item_id FROM x_post_bindings WHERE status_id='105'"), "two sheet rows claim 105");
        Assert.IsNull(Scalar(store, "SELECT item_id FROM x_post_bindings WHERE status_id='106'"), "titles are never matched");
        Assert.AreEqual(3L, Scalar(store, "SELECT COUNT(*) FROM x_post_bindings"));
        StringAssert.Contains((string)Scalar(store, "SELECT candidates_json FROM x_binding_conflicts WHERE status_id='101'")!, "\"evidence\":\"reply-link\"");
        StringAssert.Contains((string)Scalar(store, "SELECT candidates_json FROM x_binding_conflicts WHERE status_id='105'")!, "item-b");
        Assert.AreEqual(2L, Scalar(store, "SELECT COUNT(*) FROM x_binding_conflicts"));

        // An owner binding is never replaced by derived evidence; the job is repeatable.
        Exec(store, "INSERT INTO x_post_bindings(status_id,item_id,source_key,evidence,confidence,bound_utc) VALUES ('106','item-c','show-ep03','owner','high','x')");
        Exec(store, "UPDATE x_post_bindings SET item_id='item-c', evidence='owner' WHERE status_id='103'");
        XBindingResult again = store.RefreshXBindings(Now.AddHours(1));
        Assert.AreEqual("item-c|owner", Scalar(store, "SELECT item_id||'|'||evidence FROM x_post_bindings WHERE status_id='106'"));
        Assert.AreEqual("item-c|owner", Scalar(store, "SELECT item_id||'|'||evidence FROM x_post_bindings WHERE status_id='103'"));
        Assert.AreEqual(4, again.Bound);
        Assert.AreEqual(3L, Scalar(store, "SELECT COUNT(*) FROM x_binding_conflicts"), "owner 103 disagrees with its reply link");
    }

    [TestMethod]
    public void CatalogueImportRebindsCollectedTeasers()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Post("201", Now.AddDays(-1))]), Now);
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_post_bindings"));
        store.ImportWorkbookProjection(new("work", "1", true, [new(2, "show-ep09", "Title", "", null, null, null, 1, 0,
            new Dictionary<string, string>(), null, new Dictionary<string, CatalogueSourceLinkCell>
            {
                ["x"] = new("link", null, ["https://x.com/Owner_Handle/status/201"]),
            })]), false);
        Assert.AreEqual("show-ep09|sheet-link", Scalar(store, "SELECT source_key||'|'||evidence FROM x_post_bindings WHERE status_id='201'"));
    }

    [TestMethod]
    public void FirstReplyIsTheEarliestOwnerReplyWithAPaidLink()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        DateTimeOffset t = Now.AddDays(-3);
        store.RecordXObservations(new(Owner, [
            Post("301", t),
            Post("302", t.AddMinutes(5), "thanks all", "301", "301", video: false),
            Post("303", t.AddMinutes(10), "more", "302", "301", video: false),
            Post("305", t.AddDays(30), "full vid -> fansly.com/post/9", "301", "301", video: false),
            Post("304", t.AddMinutes(20), "full vid (no ppv) -> onlyfans.com/123456/owner_handle", "303", "301", video: false),
            Post("306", t.AddHours(1), "no link teaser"),
        ]), Now);
        Assert.AreEqual("304|onlyfans|123456|onlyfans.com/123456/owner_handle",
            Scalar(store, "SELECT reply_status_id||'|'||link_kind||'|'||link_post_id||'|'||reply_link FROM x_first_replies WHERE status_id='301'"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_first_replies"));
    }

    [TestMethod]
    public void ScanIndexesManagedFoldersFingerprintsAndFollowsMovedClips()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        WriteClip(root, "show-ep01__t1.mp4", "ready");
        WriteClip(root, @"Done\show-ep02__t1.mp4", "posted");
        WriteClip(root, @"Done\Good\show-ep03__t2-alt.mp4", "good");
        WriteClip(root, @"Done\Failed\Show-Ep04__t1.MP4", "failed");
        WriteClip(root, @"Ideas\show-ep05__t1.mp4", "idea");
        WriteClip(root, @"Done\Other\show-ep06__t1.mp4", "other");
        WriteClip(root, "notes.txt", "text");
        WriteClip(root, "loose name.mp4", "loose");

        IReadOnlyList<XClipFingerprint> files = XTeaserFolder.Scan(root, []);
        Assert.AreEqual(5, files.Count);
        XClipScanResult first = store.ApplyXClipScan(files, Now);
        Assert.AreEqual(new XClipScanResult(5, 5, 0, 0, 0), first);
        Assert.AreEqual("ready|show-ep01", Scalar(store, "SELECT state||'|'||episode_key FROM x_local_clips WHERE rel_path='show-ep01__t1.mp4'"));
        Assert.AreEqual("posted", Scalar(store, @"SELECT state FROM x_local_clips WHERE rel_path='Done\show-ep02__t1.mp4'"));
        Assert.AreEqual("good|show-ep03", Scalar(store, @"SELECT state||'|'||episode_key FROM x_local_clips WHERE rel_path='Done\Good\show-ep03__t2-alt.mp4'"));
        Assert.AreEqual("failed|show-ep04", Scalar(store, @"SELECT state||'|'||episode_key FROM x_local_clips WHERE rel_path='Done\Failed\Show-Ep04__t1.MP4'"));
        Assert.IsNull(Scalar(store, "SELECT episode_key FROM x_local_clips WHERE rel_path='loose name.mp4'"));
        Assert.AreEqual(Sha("ready"), Scalar(store, "SELECT sha256 FROM x_local_clips WHERE rel_path='show-ep01__t1.mp4'"));

        // Unchanged size and time reuse the stored hash instead of reading the file.
        IReadOnlyList<XClipFingerprint> known = [.. store.GetXClipFingerprints().Select(clip => clip with { Sha256 = clip.RelPath == "show-ep01__t1.mp4" ? "reused" : clip.Sha256 })];
        Assert.AreEqual("reused", XTeaserFolder.Scan(root, known).Single(file => file.RelPath == "show-ep01__t1.mp4").Sha256);

        long id = (long)Scalar(store, @"SELECT clip_id FROM x_local_clips WHERE rel_path='Done\show-ep02__t1.mp4'")!;
        File.Move(Path.Combine(root, @"Done\show-ep02__t1.mp4"), Path.Combine(root, @"Done\Failed\renamed-ep02__t9.mp4"));
        File.Delete(Path.Combine(root, "loose name.mp4"));
        XClipScanResult second = store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now.AddHours(1));
        Assert.AreEqual(new XClipScanResult(4, 0, 1, 1, 0), second);
        Assert.AreEqual(@"Done\Failed\renamed-ep02__t9.mp4|failed|renamed-ep02",
            Scalar(store, $"SELECT rel_path||'|'||state||'|'||episode_key FROM x_local_clips WHERE clip_id={id}"));
        Assert.AreEqual(1L, Scalar(store, "SELECT missing FROM x_local_clips WHERE rel_path='loose name.mp4'"));

        // Changed content at the same path is a different clip.
        WriteClip(root, "show-ep01__t1.mp4", "re-edited");
        store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now.AddHours(2));
        Assert.AreEqual(2L, Scalar(store, "SELECT COUNT(*) FROM x_local_clips WHERE rel_path='show-ep01__t1.mp4'"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_local_clips WHERE rel_path='show-ep01__t1.mp4' AND missing=0"));
    }

    [TestMethod]
    public void PairingNeedsExactlyOneBoundTeaserInTheWindowAndOneClaimingClip()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        DateTimeOffset mtime = Now.AddDays(-20);
        foreach ((string key, string[] statuses, double[] days) in new[]
        {
            ("ep-a", new[] { "401" }, new[] { 1.0 }),
            ("ep-b", new[] { "402", "403" }, new[] { 0.5, 2.0 }),
            ("ep-c", new[] { "404" }, new[] { 1.0 }),
            ("ep-d", new[] { "405" }, new[] { 3.5 }),
            ("ep-e", new[] { "406" }, new[] { -0.5 }),
            ("ep-f", new[] { "407" }, new[] { 1.0 }),
        })
        {
            AddItem(store, $"item-{key}", key, key, sheetX: [.. statuses.Select(status => $"https://x.com/Owner_Handle/status/{status}")]);
            for (int index = 0; index < statuses.Length; index++)
                store.RecordXObservations(new(Owner, [Post(statuses[index], mtime.AddDays(days[index]))]), Now);
        }
        WriteClip(root, @"Done\ep-a__t1.mp4", "a", mtime);
        WriteClip(root, @"Done\ep-b__t1.mp4", "b", mtime);
        WriteClip(root, @"Done\ep-c__t1.mp4", "c1", mtime);
        WriteClip(root, @"Done\Good\ep-c__t2.mp4", "c2", mtime);
        WriteClip(root, @"Done\ep-d__t1.mp4", "d", mtime);
        WriteClip(root, @"Done\ep-e__t1.mp4", "e", mtime);
        WriteClip(root, "ep-f__t1.mp4", "f", mtime);

        XClipScanResult result = store.ApplyXClipScan(XTeaserFolder.Scan(root, []), Now);
        Assert.AreEqual(1, result.Paired);
        Assert.AreEqual("401|time-window", Scalar(store, @"SELECT status_id||'|'||pairing_evidence FROM x_local_clips WHERE rel_path='Done\ep-a__t1.mp4'"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_local_clips WHERE status_id IS NOT NULL"));

        // Already paired clips keep their pairing; the next scan pairs nothing new.
        Assert.AreEqual(0, store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now.AddHours(1)).Paired);
    }

    [TestMethod]
    public void RevertListPairsUniqueStatusRowsOnce()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        WriteClip(root, @"Done\ep-a__t1.mp4", "a");
        WriteClip(root, @"Done\ep-b__t1.mp4", "b1");
        WriteClip(root, @"Done\ep-b__t2.mp4", "b2");
        WriteClip(root, "ep-c__t1.mp4", "c");
        WriteClip(root, @"Done\ep-d__t1.mp4", "d");
        string csv = Path.Combine(temp.Path, "revert.csv");
        File.WriteAllText(csv, "\uFEFFnew_path,original_path,episode_key,x_status_id,applied_utc\r\n"
            + $"{Path.Combine(root, @"Done\ep-a__t1.mp4")},\"{Path.Combine(root, "old, name.mp4")}\",ep-a,501,2026-10-01\r\n"
            + $"{Path.Combine(root, @"Done\ep-b__t1.mp4")},x,ep-b,502,2026-10-01\r\n"
            + $"{Path.Combine(root, @"Done\ep-b__t2.mp4")},x,ep-b,502,2026-10-01\r\n"
            + $"{Path.Combine(root, "ep-c__t1.mp4")},x,ep-c,,2026-10-01\r\n"
            + $"{Path.Combine(temp.Path, "outside.mp4")},x,ep-z,503,2026-10-01\r\n"
            + $"{Path.Combine(root, @"Done\ep-d__t1.mp4")},x,ep-d,504,2026-10-01\r\n"
            + $"{Path.Combine(root, @"Done\ep-d__t1.mp4")},x,ep-d,505,2026-10-01\r\n");
        Assert.AreEqual(0, store.ImportXClipRevertList(root, csv, Now), "nothing indexed yet: not consumed");
        store.ApplyXClipScan(XTeaserFolder.Scan(root, []), Now);
        Assert.AreEqual(1, store.ImportXClipRevertList(root, csv, Now));
        Assert.AreEqual("501|revert-list", Scalar(store, @"SELECT status_id||'|'||pairing_evidence FROM x_local_clips WHERE rel_path='Done\ep-a__t1.mp4'"));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_local_clips WHERE status_id IS NOT NULL"));
        Exec(store, "UPDATE x_local_clips SET status_id=NULL, pairing_evidence=NULL");
        Assert.AreEqual(0, store.ImportXClipRevertList(root, csv, Now), "imported once");
    }

    [TestMethod]
    public void VerdictComparesSevenDayRateWithCohortMedianAndNeedsTenPeers()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        // Ten peers with rates 0.10 (median 0.10).
        for (int index = 0; index < 10; index++)
            AddTeaser(store, $"6{index:00}", Now.AddDays(-8), (168, 1000, 60, 20, 10, 10));
        AddTeaser(store, "700", Now.AddDays(-8), (150, 1000, 50, 15, 5, 10));   // 0.080 = 0.8 x median -> good
        // 0.079 -> failed: one of the five replies is the owner's own first reply.
        AddTeaser(store, "701", Now.AddDays(-8), (200, 1000, 50, 15, 5, 10));
        store.RecordXObservations(new(Owner, [Post("7011", Now.AddDays(-8).AddMinutes(30), "-> onlyfans.com/77/x", "701", "701",
            video: false)]), Now);
        AddTeaser(store, "702", Now.AddDays(-6.5), (156, 1000, 1, 0, 0, 0));    // younger than 7 days
        AddTeaser(store, "703", Now.AddDays(-9), (100, 1000, 1, 0, 0, 0), (250, 1000, 1, 0, 0, 0)); // no sample at 6-10 days
        XVerdictResult result = store.DecideXVerdicts(Now);
        Assert.AreEqual(12, result.Decided);
        Assert.AreEqual("good", Scalar(store, "SELECT verdict FROM x_teaser_verdicts WHERE status_id='700'"));
        Assert.AreEqual("failed", Scalar(store, "SELECT verdict FROM x_teaser_verdicts WHERE status_id='701'"));
        Assert.AreEqual(0.1, (double)Scalar(store, "SELECT cohort_median FROM x_teaser_verdicts WHERE status_id='701'")!, 1e-9);
        Assert.AreEqual(12L, Scalar(store, "SELECT cohort_size FROM x_teaser_verdicts WHERE status_id='701'"), "peers, 700 and the younger 702");
        Assert.AreEqual(0.079, (double)Scalar(store, "SELECT engagement_rate FROM x_teaser_verdicts WHERE status_id='701'")!, 1e-9);
        Assert.IsNull(Scalar(store, "SELECT verdict FROM x_teaser_verdicts WHERE status_id IN ('702','703')"));
        Assert.AreEqual(1, store.DecideXVerdicts(Now.AddDays(1)).Decided, "only 702 newly reached 7 days");
        Assert.AreEqual("failed", Scalar(store, "SELECT verdict FROM x_teaser_verdicts WHERE status_id='701'"), "verdicts are taken once");
    }

    [TestMethod]
    public void VerdictWaitsForACohortOfTen()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        for (int index = 0; index < 10; index++)
            AddTeaser(store, $"8{index:00}", Now.AddDays(-8), (168, 1000, 60, 20, 10, 10));
        XVerdictResult nine = store.DecideXVerdicts(Now);
        Assert.AreEqual(new XVerdictResult(0, 10), nine, "each teaser has only nine peers");
        AddTeaser(store, "899", Now.AddDays(-8), (168, 1000, 60, 20, 10, 10));
        Assert.AreEqual(11, store.DecideXVerdicts(Now).Decided);
    }

    [TestMethod]
    public void VerdictMovesPostedClipAndUndoRestoresIt()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        long clip = PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "failed");

        IReadOnlyList<XClipMoveOutcome> moves = store.ApplyXClipVerdictMoves(root, Now);
        XClipMoveOutcome move = moves.Single();
        Assert.AreEqual("moved", move.Outcome);
        Assert.AreEqual(@"Done\Failed\ep-a__t1.mp4", move.ToRelPath);
        Assert.IsTrue(File.Exists(Path.Combine(root, @"Done\Failed\ep-a__t1.mp4")));
        Assert.IsFalse(File.Exists(Path.Combine(root, @"Done\ep-a__t1.mp4")));
        Assert.AreEqual(@"Done\Failed\ep-a__t1.mp4|failed", Scalar(store, $"SELECT rel_path||'|'||state FROM x_local_clips WHERE clip_id={clip}"));
        Assert.AreEqual(0, store.ApplyXClipVerdictMoves(root, Now).Count);
        Assert.AreEqual(1, store.GetXTeaserOverview().RecentMoves.Count);

        XClipMoveOutcome undo = store.UndoXClipMove(root, move.MoveId, Now.AddMinutes(1));
        Assert.AreEqual("moved", undo.Outcome);
        Assert.AreEqual("undo", undo.Reason);
        Assert.IsTrue(File.Exists(Path.Combine(root, @"Done\ep-a__t1.mp4")));
        Assert.IsFalse(File.Exists(Path.Combine(root, @"Done\Failed\ep-a__t1.mp4")));
        Assert.IsNotNull(Scalar(store, $"SELECT undone_utc FROM x_clip_moves WHERE move_id={move.MoveId}"));
        Assert.AreEqual(@"Done\ep-a__t1.mp4|posted", Scalar(store, $"SELECT rel_path||'|'||state FROM x_local_clips WHERE clip_id={clip}"));
        Assert.AreEqual("x-move-already-undone",
            Assert.ThrowsException<XTeaserException>(() => store.UndoXClipMove(root, move.MoveId, Now)).Code);
        Assert.AreEqual(0, store.ApplyXClipVerdictMoves(root, Now.AddHours(1)).Count, "an undone clip stays where the owner put it");
    }

    [TestMethod]
    public void OwnersManualMoveBackWinsOverTheVerdict()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        long clip = PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "failed");
        Assert.AreEqual("moved", store.ApplyXClipVerdictMoves(root, Now).Single().Outcome);
        File.Move(Path.Combine(root, @"Done\Failed\ep-a__t1.mp4"), Path.Combine(root, @"Done\ep-a__t1.mp4"));
        store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now.AddHours(1));
        Assert.AreEqual("posted", Scalar(store, $"SELECT state FROM x_local_clips WHERE clip_id={clip}"));

        Assert.AreEqual(0, store.GetXClipMoveCandidates().Count);
        Assert.AreEqual(0, store.ApplyXClipVerdictMoves(root, Now.AddHours(1)).Count);
        Assert.AreEqual(0, store.ApplyXClipVerdictMoves(root, Now.AddHours(2)).Count);
        Assert.IsTrue(File.Exists(Path.Combine(root, @"Done\ep-a__t1.mp4")));
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_clip_moves"));
    }

    [TestMethod]
    public void JunctionedFoldersAreNeitherScannedNorUsedAsMoveTargets()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        string outside = Path.Combine(temp.Path, "outside");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "good");
        WriteClip(outside, "ep-z__t1.mp4", "outside clip");
        Junction(Path.Combine(root, @"Done\Good"), outside);
        try
        {
            Assert.IsNull(XTeaserFolder.ResolveInside(root, @"Done\Good\ep-a__t1.mp4"));
            Assert.IsFalse(XTeaserFolder.Scan(root, []).Any(file => file.RelPath.StartsWith(@"Done\Good", StringComparison.OrdinalIgnoreCase)));
            Assert.AreEqual("unsafe-path", store.ApplyXClipVerdictMoves(root, Now).Single().Outcome);
            Assert.IsTrue(File.Exists(Path.Combine(root, @"Done\ep-a__t1.mp4")));
            CollectionAssert.AreEqual(new[] { "ep-z__t1.mp4" }, Directory.GetFiles(outside).Select(Path.GetFileName).ToArray());
        }
        finally
        {
            Directory.Delete(Path.Combine(root, @"Done\Good"));
        }
    }

    [TestMethod]
    public void LockedClipIsLoggedOnceAndOtherClipsStillMove()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "good");
        AddItem(store, "item-ep-b", "ep-b", "ep-b", sheetX: ["https://x.com/Owner_Handle/status/901"]);
        AddItem(store, "item-ep-c", "ep-c", "ep-c", sheetX: ["https://x.com/Owner_Handle/status/902"]);
        DateTimeOffset mtime = Now.AddDays(-9);
        store.RecordXObservations(new(Owner, [Post("901", mtime.AddDays(1)), Post("902", mtime.AddDays(1))]), Now);
        WriteClip(root, @"Done\ep-b__t1.mp4", "clip-b", mtime);
        WriteClip(root, @"Done\ep-c__t1.mp4", "clip-c", mtime);
        Assert.AreEqual(2, store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now).Paired);
        Exec(store, "INSERT INTO x_teaser_verdicts VALUES ('901','failed',0.05,0.1,10,168,'x'), ('902','failed',0.05,0.1,10,168,'x')");
        File.WriteAllText(Path.Combine(root, @"Done\Failed"), "a file where the folder should be");

        using (new FileStream(Path.Combine(root, @"Done\ep-a__t1.mp4"), FileMode.Open, FileAccess.Read, FileShare.None))
        {
            IReadOnlyList<XClipMoveOutcome> first = store.ApplyXClipVerdictMoves(root, Now);
            CollectionAssert.AreEqual(new[] { "locked", "error", "error" }, first.Select(move => move.Outcome).ToArray());
            Assert.AreEqual(0, store.ApplyXClipVerdictMoves(root, Now.AddHours(1)).Count, "identical refusals are not repeated");
        }
        File.Delete(Path.Combine(root, @"Done\Failed"));
        CollectionAssert.AreEqual(new[] { "moved", "moved", "moved" },
            store.ApplyXClipVerdictMoves(root, Now.AddHours(2)).Select(move => move.Outcome).ToArray());
        Assert.AreEqual(6L, Scalar(store, "SELECT COUNT(*) FROM x_clip_moves"));
    }

    [TestMethod]
    public void GoodVerdictCreatesTheGoodFolder()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "good");
        Assert.IsFalse(Directory.Exists(Path.Combine(root, @"Done\Good")));
        Assert.AreEqual("moved", store.ApplyXClipVerdictMoves(root, Now).Single().Outcome);
        Assert.IsTrue(File.Exists(Path.Combine(root, @"Done\Good\ep-a__t1.mp4")));
    }

    [TestMethod]
    public void MoveRefusesChangedContentAndLogsTheRefusalOnce()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "good");
        string path = Path.Combine(root, @"Done\ep-a__t1.mp4");
        DateTime mtime = File.GetLastWriteTimeUtc(path);
        File.WriteAllText(path, "clip-ep-a__t1.mxx");   // same length, different bytes
        File.SetLastWriteTimeUtc(path, mtime);

        Assert.AreEqual("fingerprint-mismatch", store.ApplyXClipVerdictMoves(root, Now).Single().Outcome);
        Assert.IsTrue(File.Exists(path));
        Assert.IsFalse(File.Exists(Path.Combine(root, @"Done\Good\ep-a__t1.mp4")));
        Assert.AreEqual(0, store.ApplyXClipVerdictMoves(root, Now.AddHours(1)).Count);
        Assert.AreEqual(1L, Scalar(store, "SELECT COUNT(*) FROM x_clip_moves"));
    }

    [TestMethod]
    public void MoveNeverOverwritesAnExistingFile()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "failed");
        WriteClip(root, @"Done\Failed\ep-a__t1.mp4", "older failed clip");

        Assert.AreEqual("collision", store.ApplyXClipVerdictMoves(root, Now).Single().Outcome);
        Assert.AreEqual("clip-ep-a__t1.mp4", File.ReadAllText(Path.Combine(root, @"Done\ep-a__t1.mp4")));
        Assert.AreEqual("older failed clip", File.ReadAllText(Path.Combine(root, @"Done\Failed\ep-a__t1.mp4")));
        Assert.AreEqual("collision", Scalar(store, "SELECT outcome FROM x_clip_moves"));
    }

    [TestMethod]
    public void CollisionIsRefusedBeforeTheClipIsRead()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "good");
        WriteClip(root, @"Done\Good\ep-a__t1.mp4", "existing");
        using (new FileStream(Path.Combine(root, @"Done\ep-a__t1.mp4"), FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.AreEqual("collision", store.ApplyXClipVerdictMoves(root, Now).Single().Outcome);
        Assert.AreEqual("existing", File.ReadAllText(Path.Combine(root, @"Done\Good\ep-a__t1.mp4")));
    }

    [TestMethod]
    public void UndoRefusesWhenTheOriginalPathIsTaken()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "good");
        XClipMoveOutcome move = store.ApplyXClipVerdictMoves(root, Now).Single();
        WriteClip(root, @"Done\ep-a__t1.mp4", "new clip with same name");
        Assert.AreEqual("collision", store.UndoXClipMove(root, move.MoveId, Now).Outcome);
        Assert.AreEqual("new clip with same name", File.ReadAllText(Path.Combine(root, @"Done\ep-a__t1.mp4")));
        Assert.IsNull(Scalar(store, $"SELECT undone_utc FROM x_clip_moves WHERE move_id={move.MoveId}"));
    }

    [TestMethod]
    public void PathsStayInsideTheManagedFolders()
    {
        using TempDirectory temp = new();
        string root = Path.Combine(temp.Path, "TWEETS");
        Directory.CreateDirectory(root);
        Assert.IsNull(XTeaserFolder.ResolveInside(root, @"..\outside.mp4"));
        Assert.IsNull(XTeaserFolder.ResolveInside(root, @"Ideas\a.mp4"));
        Assert.IsNull(XTeaserFolder.ResolveInside(root, @"C:\a.mp4"));
        Assert.AreEqual(Path.Combine(root, @"Done\Good\a.mp4"), XTeaserFolder.ResolveInside(root, @"Done\Good\a.mp4"));
        Assert.AreEqual("invalid-x-teaser-root", Assert.ThrowsException<XTeaserException>(() => XTeaserFolder.NormalizeRoot("relative")).Code);
        Assert.AreEqual("invalid-x-teaser-root", Assert.ThrowsException<XTeaserException>(() => XTeaserFolder.NormalizeRoot(@"C:\")).Code);
    }

    [TestMethod]
    public void OverviewSummarisesEpisodesPostsAndUnpairedItems()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string root = Path.Combine(temp.Path, "TWEETS");
        PairedClipWithVerdict(store, root, "ep-a__t1.mp4", "failed");
        WriteClip(root, "ep-a__t2.mp4", "spare");
        WriteClip(root, @"Done\unknown__t1.mp4", "unknown");
        store.RecordXObservations(new(Owner, [Post("990", Now.AddDays(-1)),
            Post("991", Now.AddDays(-1).AddMinutes(20), "-> onlyfans.com/42/x", "990", "990", video: false)]), Now);
        Exec(store, "INSERT INTO x_metric_samples(status_id,observed_utc,age_hours,views,likes,reposts,replies,quotes,bookmarks,source) VALUES ('990','2026-09-28T11:00:00Z',23,500,5,1,0,0,2,'network')");
        store.ApplyXClipScan(XTeaserFolder.Scan(root, store.GetXClipFingerprints()), Now);

        XTeaserOverview overview = store.GetXTeaserOverview();
        XTeaserEpisode episode = overview.Episodes.Single();
        Assert.AreEqual(new XTeaserEpisode("item-ep-a", "ep-a", "ep-a", 0, 1, 1, 1, 0, 0), episode);
        XTeaserPost failed = overview.Posts.Single(post => post.StatusId == "900");
        Assert.AreEqual("failed", failed.Verdict!.Verdict);
        Assert.IsNotNull(failed.ClipId);
        XTeaserPost recent = overview.UnboundPosts.Single();
        Assert.AreEqual("990", recent.StatusId);
        Assert.AreEqual(500L, recent.Latest!.Views);
        Assert.AreEqual("991", recent.FirstReply!.StatusId);
        Assert.AreEqual(@"Done\unknown__t1.mp4", overview.UnpairedClips.Single().RelPath);
        Assert.IsFalse(overview.Truncated);
    }

    [TestMethod]
    public void ReplyQueueListsOnlyRecentBoundUnrepliedTeasersWithTheCanonicalOnlyFansLink()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Assert.IsNull(store.GetXTeaserReplyQueue(Now).OwnerHandle, "no owner recorded yet");
        AddItem(store, "item-a", "ep-a", "A", onlyFans: "https://onlyfans.com/111/johnny_guides",
            sheetX: ["https://x.com/Owner_Handle/status/401", "https://x.com/Owner_Handle/status/407"]);
        AddItem(store, "item-b", "ep-b", "B", onlyFans: "https://onlyfans.com/222/someone_else", sheetX: ["https://x.com/Owner_Handle/status/402"]);
        AddItem(store, "item-c", "ep-c", "C", onlyFans: "https://onlyfans.com/333/johnny_guides",
            sheetX: ["https://x.com/Owner_Handle/status/403", "https://x.com/Owner_Handle/status/405", "https://x.com/Owner_Handle/status/406"]);
        AddItem(store, "item-d", "ep-d", "D", sheetX: ["https://x.com/Owner_Handle/status/409"]);
        AddItem(store, "item-e", "ep-e", "E", onlyFans: "https://onlyfans.com/555/johnny_guides", sheetX: ["https://x.com/Owner_Handle/status/407"]);
        AddItem(store, "item-f", "ep-f", "F", onlyFans: "https://onlyfans.com/666/johnny_guides", sheetX: ["https://x.com/Owner_Handle/status/410"]);
        string cells = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, CatalogueSourceLinkCell>
        {
            ["onlyfans"] = new("x", null, ["https://onlyfans.com/667/johnny_guides"]),
            ["x"] = new("x", null, ["https://x.com/Owner_Handle/status/410"]),
        });
        Exec(store, $"UPDATE catalogue_items SET source_link_cells_json = '{cells}' WHERE item_id = 'item-f'");

        store.RecordXObservations(new(Owner, [
            Post("401", Now.AddMinutes(-30)),
            Post("402", Now.AddHours(-2)),
            Post("403", Now.AddHours(-3)), Post("4031", Now.AddHours(-2), "thanks", "403", "403", video: false),
            Post("404", Now.AddHours(-1)),
            Post("405", Now.AddHours(-25)),
            Post("406", Now.AddHours(-1), "photo", video: false),
            Post("407", Now.AddHours(-1)),
            Post("409", Now.AddHours(-4)),
            Post("410", Now.AddHours(-5)),
        ]), Now);

        XTeaserReplyQueue queue = store.GetXTeaserReplyQueue(Now);
        Assert.AreEqual("Owner_Handle", queue.OwnerHandle);
        CollectionAssert.AreEqual(new[] { "401", "402", "409", "410" }, queue.Items.Select(item => item.StatusId).ToArray());
        XTeaserReplyCandidate first = queue.Items[0];
        Assert.AreEqual("https://onlyfans.com/111/johnny_guides", first.PaidUrl);
        Assert.AreEqual("item-a|ep-a", $"{first.ItemId}|{first.SourceKey}");
        Assert.IsTrue(first.HasVideo && !first.IsReply && !first.IsRepost && !first.OwnerReplyExists);
        Assert.IsNull(queue.Items[1].PaidUrl, "a foreign or non-canonical OnlyFans link is never used");
        Assert.IsNull(queue.Items[2].PaidUrl, "no OnlyFans link on the row");
        Assert.IsNull(queue.Items[3].PaidUrl, "two different OnlyFans posts are ambiguous");

        // An owner binding with a recorded conflict is not exactly one episode.
        Exec(store, "INSERT INTO x_post_bindings(status_id,item_id,source_key,evidence,confidence,bound_utc) VALUES ('404','item-a','ep-a','owner','high','x')");
        Assert.IsTrue(store.GetXTeaserReplyQueue(Now).Items.Any(item => item.StatusId == "404"));
        Exec(store, "INSERT INTO x_binding_conflicts(status_id,candidates_json,detected_utc) VALUES ('404','[]','x')");
        Assert.IsFalse(store.GetXTeaserReplyQueue(Now).Items.Any(item => item.StatusId == "404"));
        Assert.AreEqual(0, store.GetXTeaserReplyQueue(Now.AddHours(30)).Items.Count, "older than 24 h");
    }

    [TestMethod]
    public void CanonicalOnlyFansLinkAcceptsTheTrailingSlashFormOnly()
    {
        static CatalogueItemSummary Item(string link) => new("i", "k", null, "t", "", null, null, null, 0, 0,
            new Dictionary<string, string> { ["onlyfans"] = link }, false);
        Assert.AreEqual("https://onlyfans.com/42/johnny_guides", CatalogueStore.CanonicalOnlyFansUrl(Item("https://onlyfans.com/42/johnny_guides/")));
        Assert.IsNull(CatalogueStore.CanonicalOnlyFansUrl(Item("https://onlyfans.com/42")));
        Assert.IsNull(CatalogueStore.CanonicalOnlyFansUrl(Item("https://onlyfans.com/42/johnny_guides?x=1")));
        Assert.IsNull(CatalogueStore.CanonicalOnlyFansUrl(Item("http://onlyfans.com/42/johnny_guides")));
    }

    private static long PairedClipWithVerdict(CatalogueStore store, string root, string name, string verdict)
    {
        AddItem(store, "item-ep-a", "ep-a", "ep-a", sheetX: ["https://x.com/Owner_Handle/status/900"]);
        DateTimeOffset mtime = Now.AddDays(-9);
        store.RecordXObservations(new(Owner, [Post("900", mtime.AddDays(1))]), Now);
        WriteClip(root, Path.Combine("Done", name), $"clip-{name}", mtime);
        Assert.AreEqual(1, store.ApplyXClipScan(XTeaserFolder.Scan(root, []), Now).Paired);
        Exec(store, $"INSERT INTO x_teaser_verdicts VALUES ('900','{verdict}',0.05,0.1,10,168,'x')");
        return (long)Scalar(store, "SELECT clip_id FROM x_local_clips WHERE status_id='900'")!;
    }

    private static void AddTeaser(CatalogueStore store, string statusId, DateTimeOffset posted,
        params (double Age, long Views, long Likes, long Reposts, long Replies, long Bookmarks)[] samples)
    {
        store.RecordXObservations(new(Owner, [Post(statusId, posted)]), Now);
        foreach (var sample in samples)
            Exec(store, $"""
                INSERT INTO x_metric_samples(status_id,observed_utc,age_hours,views,likes,reposts,replies,quotes,bookmarks,source)
                VALUES ('{statusId}','{posted.AddHours(sample.Age).ToString("yyyy-MM-dd'T'HH:mm':00Z'", CultureInfo.InvariantCulture)}',
                        {sample.Age.ToString(CultureInfo.InvariantCulture)},
                        {sample.Views},{sample.Likes},{sample.Reposts},{sample.Replies},0,{sample.Bookmarks},'network')
                """);
    }

    private static void AddItem(CatalogueStore store, string itemId, string sourceKey, string title, string? onlyFans = null,
        string? fansly = null, IReadOnlyList<string>? sheetX = null)
    {
        Dictionary<string, string> links = [];
        if (onlyFans is not null) links["onlyfans"] = onlyFans;
        if (fansly is not null) links["fansly"] = fansly;
        string cells = sheetX is null ? "{}" : System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, CatalogueSourceLinkCell>
        {
            ["x"] = new(string.Join("\n", sheetX), null, sheetX),
        });
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = """
            INSERT INTO catalogue_items(item_id,source_key,title,description,platform_links_json,source_link_cells_json,updated_utc)
            VALUES ($id,$key,$title,'',$links,$cells,'2026-09-01T00:00:00Z')
            """;
        command.Parameters.AddWithValue("$id", itemId);
        command.Parameters.AddWithValue("$key", sourceKey);
        command.Parameters.AddWithValue("$title", title);
        command.Parameters.AddWithValue("$links", System.Text.Json.JsonSerializer.Serialize(links));
        command.Parameters.AddWithValue("$cells", cells);
        command.ExecuteNonQuery();
    }

    private static void Junction(string link, string target)
    {
        using System.Diagnostics.Process process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"") { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true })!;
        process.WaitForExit();
        Assert.AreEqual(0, process.ExitCode, "junction creation");
        Assert.IsTrue(new DirectoryInfo(link).Attributes.HasFlag(FileAttributes.ReparsePoint));
    }

    private static void WriteClip(string root, string relPath, string content, DateTimeOffset? mtime = null)
    {
        string path = Path.Combine(root, relPath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        if (mtime is not null) File.SetLastWriteTimeUtc(path, mtime.Value.UtcDateTime);
    }

    private static string Sha(string content) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

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
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xt-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
