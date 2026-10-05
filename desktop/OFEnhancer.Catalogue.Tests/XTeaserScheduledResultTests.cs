using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class XTeaserScheduledResultTests
{
    private const string OwnerId = "1000000000000000001";
    private static readonly XOwnerIdentity Owner = new(OwnerId, "Owner_Handle");
    private static readonly DateTimeOffset Scheduled = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
    private const string Caption = "Benign scheduled teaser";
    private static readonly XObservedMedia Video = new("video", "7_1900000000000000001", 15_000, null);

    [TestMethod]
    public void ResolvesOnlyUniqueExactCaptionOwnerVideoInTimeWindowAndDoesNotWrite()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Post("101", Scheduled.AddSeconds(-90)),
            Post("102", Scheduled.AddSeconds(90), "other caption"), Post("103", Scheduled.AddSeconds(91))]), Scheduled);

        XTeaserScheduledResult? result = store.ResolveXScheduledResult(Hash(Caption), Scheduled);

        Assert.IsNotNull(result);
        Assert.AreEqual("https://x.com/Owner_Handle/status/101", result.Url);
        Assert.AreEqual(Scheduled.AddSeconds(-90), result.PostedUtc);
        Assert.AreEqual(3L, Scalar(store, "SELECT COUNT(*) FROM x_posts"));
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM x_post_bindings"));
        Assert.AreEqual(0L, Scalar(store, "SELECT COUNT(*) FROM audit_events"));
    }

    [TestMethod]
    public void ReturnsNullForAmbiguityRepliesRetweetsCaptionMismatchAndBindingMismatch()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-a", "episode-a");
        store.RecordXObservations(new(Owner, [Post("201", Scheduled), Post("202", Scheduled),
            Post("203", Scheduled, inReplyTo: "201"), Post("204", Scheduled, retweet: true)]), Scheduled);
        var mapping = store.MapXTeasers([new("201", "item-a", "episode-a")], Scheduled, false);
        store.MapXTeasers(mapping.Choices, Scheduled, true);

        Assert.IsNull(store.ResolveXScheduledResult(Hash(Caption), Scheduled));
        Assert.IsNull(store.ResolveXScheduledResult(Hash("unrelated caption"), Scheduled));
        Assert.IsNull(store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-b"));
    }

    [TestMethod]
    public void ExpectedEpisodeKeyAcceptsUniqueUnboundOrMatchingBindingAndRejectsConflict()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-a", "episode-a");
        store.RecordXObservations(new(Owner, [Post("301", Scheduled)]), Scheduled);
        Assert.AreEqual("https://x.com/Owner_Handle/status/301",
            store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a")?.Url);

        var mapping = store.MapXTeasers([new("301", "item-a", "episode-a")], Scheduled, false);
        store.MapXTeasers(mapping.Choices, Scheduled, true);
        Assert.AreEqual("https://x.com/Owner_Handle/status/301",
            store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a")?.Url);

        AddBindingConflict(store, "301");
        Assert.IsNull(store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a"));
    }

    [TestMethod]
    public void ExpectedEpisodeKeyAllowsUniqueUnboundPostButRejectsContradictoryBinding()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-a", "episode-a");
        AddItem(store, "item-b", "episode-b");
        store.RecordXObservations(new(Owner, [Post("401", Scheduled)]), Scheduled);
        Assert.AreEqual("https://x.com/Owner_Handle/status/401",
            store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a")?.Url);

        var mapping = store.MapXTeasers([new("401", "item-b", "episode-b")], Scheduled, false);
        store.MapXTeasers(mapping.Choices, Scheduled, true);
        Assert.IsNull(store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a"));
    }

    [TestMethod]
    public void CompetingCaptionAndTimeMatchIsAmbiguousEvenWhenOnlyOneBindingMatches()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        AddItem(store, "item-a", "episode-a");
        store.RecordXObservations(new(Owner, [Post("501", Scheduled), Post("502", Scheduled)]), Scheduled);
        var mapping = store.MapXTeasers([new("501", "item-a", "episode-a")], Scheduled, false);
        store.MapXTeasers(mapping.Choices, Scheduled, true);

        Assert.IsNull(store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a"));
        AddBindingConflict(store, "501");
        Assert.IsNull(store.ResolveXScheduledResult(Hash(Caption), Scheduled, "episode-a"),
            "A conflicting candidate still makes the caption/time match ambiguous.");
    }

    [TestMethod]
    public void RejectsMalformedInputs()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Assert.AreEqual("invalid-x-scheduled-result", Assert.ThrowsException<XObservationException>(() =>
            store.ResolveXScheduledResult("ABC", Scheduled)).Code);
        Assert.AreEqual("invalid-x-scheduled-result", Assert.ThrowsException<XObservationException>(() =>
            store.ResolveXScheduledResult(Hash(Caption), Scheduled, "../episode")).Code);
    }

    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    private static XObservation Post(string id, DateTimeOffset time, string text = Caption, string? inReplyTo = null,
        bool retweet = false) => new(id, OwnerId, Owner.Handle, time.ToString("O", CultureInfo.InvariantCulture),
        retweet ? string.Empty : text, inReplyTo, id, retweet, retweet ? [] : [Video], [], null, "network");

    private static void AddItem(CatalogueStore store, string id, string key)
    {
        using var command = store.Connection.CreateCommand();
        command.CommandText = "INSERT INTO catalogue_items(item_id,source_key,title,description,updated_utc) VALUES ($id,$key,$key,'','2026-09-01T00:00:00Z')";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$key", key);
        command.ExecuteNonQuery();
    }

    private static void Exec(CatalogueStore store, string sql)
    {
        using var command = store.Connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static void AddBindingConflict(CatalogueStore store, string statusId) =>
        Exec(store, $"INSERT INTO x_binding_conflicts(status_id,candidates_json,detected_utc) VALUES ('{statusId}','[]','x')");

    private static long Scalar(CatalogueStore store, string sql)
    {
        using var command = store.Connection.CreateCommand();
        command.CommandText = sql;
        return (long)command.ExecuteScalar()!;
    }

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xsr-{Guid.NewGuid():N}");
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, true);
    }
}
