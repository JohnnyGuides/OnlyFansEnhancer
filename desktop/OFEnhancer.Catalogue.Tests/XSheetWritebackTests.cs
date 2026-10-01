using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XSheetWritebackTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly XOwnerIdentity Owner = new(OwnerId, "Owner_Handle");
    private static readonly DateTimeOffset Now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);
    private static readonly XObservedMedia Video = new("video", "7_1900000000000000001", 15_000, null);

    [TestMethod]
    public void OnlyReplyLinkAndOwnerBoundTeasersMissingFromTheSheetAreCandidates()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-a", "show-ep01", onlyFans: "https://onlyfans.com/555/owner",
            sheetX: ["https://x.com/Owner_Handle/status/101"]);
        AddItem(store, "item-b", "show-ep02", fansly: "https://fansly.com/post/777");
        AddItem(store, "item-c", "show-ep03", sheetX: ["https://twitter.com/Owner_Handle/status/109"]);
        AddItem(store, "item-d", "show-ep04", onlyFans: "https://onlyfans.com/888/owner");
        AddItem(store, "item-e", "show-ep05", onlyFans: "https://onlyfans.com/888/owner");
        DateTimeOffset t = Now.AddDays(-2);
        store.RecordXObservations(new(Owner, [
            Post("101", t),                                                        // sheet-link: already in the sheet
            Post("103", t.AddHours(1)), Reply("104", t.AddHours(1.5), "103", "https://fansly.com/post/777"), // reply-link
            Post("105", t.AddHours(2)),                                            // unbound
            Post("106", t.AddHours(3)),                                            // owner binding, conflicted
            Reply("107", t.AddHours(3.5), "106", "https://onlyfans.com/555/owner"),
            Post("108", t.AddHours(4)),                                            // owner binding, no conflict
            Post("109", t.AddHours(5)),                                            // owner binding, link already present
            Post("110", t.AddHours(6), video: false),                              // not a video teaser
            Post("111", t.AddHours(7)), Reply("112", t.AddHours(7.5), "111", "https://onlyfans.com/888/owner"), // ambiguous
        ]), Now);
        Exec(store, "INSERT OR REPLACE INTO x_post_bindings VALUES ('106','item-b','show-ep02','owner','high','x')");
        Exec(store, "INSERT OR REPLACE INTO x_post_bindings VALUES ('108','item-d','show-ep04','owner','high','x')");
        Exec(store, "INSERT OR REPLACE INTO x_post_bindings VALUES ('109','item-c','show-ep03','owner','high','x')");
        Exec(store, "INSERT OR REPLACE INTO x_post_bindings VALUES ('110','item-d','show-ep04','owner','high','x')");
        store.RefreshXBindings(Now);
        Assert.IsNotNull(Scalar(store, "SELECT 1 FROM x_binding_conflicts WHERE status_id='106'"));
        Assert.IsNotNull(Scalar(store, "SELECT 1 FROM x_binding_conflicts WHERE status_id='111'"));

        IReadOnlyList<XSheetWritebackCandidate> candidates = store.GetXSheetWritebackCandidates(Now);

        CollectionAssert.AreEqual(new[]
        {
            "103|item-b|show-ep02|https://x.com/Owner_Handle/status/103",
            "108|item-d|show-ep04|https://x.com/Owner_Handle/status/108",
        }, candidates.Select(c => $"{c.StatusId}|{c.ItemId}|{c.SourceKey}|{c.Url}").ToArray());
    }

    [TestMethod]
    public void NoCandidatesWithoutAKnownOwnerHandle()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-b", "show-ep02", fansly: "https://fansly.com/post/777");
        store.RecordXObservations(new(Owner, [Post("103", Now.AddDays(-1)),
            Reply("104", Now.AddDays(-1).AddHours(1), "103", "https://fansly.com/post/777")]), Now);
        Assert.AreEqual(1, store.GetXSheetWritebackCandidates(Now).Count);
        Exec(store, "UPDATE x_owner SET handle='bad handle!'");
        Assert.AreEqual(0, store.GetXSheetWritebackCandidates(Now).Count);
    }

    [TestMethod]
    public void RunsAreRateLimitedAndFailuresBackOffBeforeRetrying()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        List<XObservation> posts = [];
        for (int index = 0; index < 7; index++)
        {
            AddItem(store, $"item-{index}", $"show-ep{index:00}", fansly: $"https://fansly.com/post/70{index}");
            posts.Add(Post($"20{index}", Now.AddDays(-1).AddHours(index)));
            posts.Add(Reply($"30{index}", Now.AddDays(-1).AddHours(index).AddMinutes(5), $"20{index}", $"https://fansly.com/post/70{index}"));
        }
        store.RecordXObservations(new(Owner, posts), Now);

        IReadOnlyList<XSheetWritebackCandidate> first = store.GetXSheetWritebackCandidates(Now);
        Assert.AreEqual(CatalogueStore.MaxSheetWritebacksPerRun, first.Count);
        Assert.AreEqual("200", first[0].StatusId, "oldest first");

        XSheetWritebackCandidate failing = first[0];
        store.RecordXSheetWriteback(failing, "failed", "catalogue-entry-changed", Now);
        Assert.IsFalse(store.GetXSheetWritebackCandidates(Now, 10).Any(c => c.StatusId == "200"), "waits after a failure");
        Assert.IsFalse(store.GetXSheetWritebackCandidates(Now.AddMinutes(59), 10).Any(c => c.StatusId == "200"));
        Assert.IsTrue(store.GetXSheetWritebackCandidates(Now.AddHours(1), 10).Any(c => c.StatusId == "200"));
        store.RecordXSheetWriteback(failing, "failed", "google-row-write-unresolved", Now.AddHours(1));
        Assert.IsFalse(store.GetXSheetWritebackCandidates(Now.AddHours(2.9), 10).Any(c => c.StatusId == "200"), "doubles");
        Assert.IsTrue(store.GetXSheetWritebackCandidates(Now.AddHours(3), 10).Any(c => c.StatusId == "200"));

        XSheetWritebackStatus waiting = store.GetXSheetWritebackStatus(Now.AddHours(2));
        Assert.AreEqual(7, waiting.Pending);
        Assert.AreEqual(1, waiting.Waiting);
        Assert.AreEqual(0, waiting.Written);
        Assert.AreEqual("failed", waiting.LastOutcome);
        Assert.AreEqual("google-row-write-unresolved", waiting.LastCode);

        store.RecordXSheetWriteback(first[1], "appended", null, Now.AddHours(2));
        store.RecordXSheetWriteback(failing, "already-present", null, Now.AddHours(3));
        XSheetWritebackStatus after = store.GetXSheetWritebackStatus(Now.AddHours(3));
        Assert.AreEqual(1, after.Written);
        Assert.AreEqual(0, after.Waiting, "a success clears the backoff");
        Assert.AreEqual("already-present", after.LastOutcome);
        Assert.IsNull(after.LastCode);
        Assert.AreEqual(4L, Scalar(store, "SELECT COUNT(*) FROM audit_events WHERE kind='x-sheet-writeback' AND item_id IS NOT NULL"));
        Assert.ThrowsException<ArgumentException>(() => store.RecordXSheetWriteback(failing, "failed", null, Now));
        Assert.ThrowsException<ArgumentException>(() => store.RecordXSheetWriteback(failing, "written", null, Now));
    }

    [TestMethod]
    public void OverviewCarriesTheWritebackStatus()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-b", "show-ep02", fansly: "https://fansly.com/post/777");
        store.RecordXObservations(new(Owner, [Post("103", Now.AddDays(-1)),
            Reply("104", Now.AddDays(-1).AddHours(1), "103", "https://fansly.com/post/777")]), Now);
        XSheetWritebackStatus status = store.GetXTeaserOverview().SheetWriteback!;
        Assert.AreEqual(1, status.Pending);
        Assert.IsNull(status.LastOutcome);
    }

    private static XObservation Post(string statusId, DateTimeOffset created, bool video = true) =>
        new(statusId, OwnerId, "Owner_Handle", created.ToString("O", CultureInfo.InvariantCulture), "benign teaser", null,
            statusId, false, video ? [Video] : [], [], null, "network");

    private static XObservation Reply(string statusId, DateTimeOffset created, string teaser, string link) =>
        new(statusId, OwnerId, "Owner_Handle", created.ToString("O", CultureInfo.InvariantCulture), "full vid -> " + link, teaser,
            teaser, false, [], [link], null, "network");

    private static void AddItem(CatalogueStore store, string itemId, string sourceKey, string? onlyFans = null,
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
            INSERT INTO catalogue_items(item_id,source_key,source_row,title,description,platform_links_json,source_link_cells_json,updated_utc)
            VALUES ($id,$key,2,'Benign title','',$links,$cells,'2026-09-01T00:00:00Z')
            """;
        command.Parameters.AddWithValue("$id", itemId);
        command.Parameters.AddWithValue("$key", sourceKey);
        command.Parameters.AddWithValue("$links", System.Text.Json.JsonSerializer.Serialize(links));
        command.Parameters.AddWithValue("$cells", cells);
        command.ExecuteNonQuery();
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
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xw-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(Path, recursive: true); } catch (IOException) { }
        }
    }
}
