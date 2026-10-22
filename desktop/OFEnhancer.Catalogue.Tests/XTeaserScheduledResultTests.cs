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

    [TestMethod]
    public void PublicationSurvivesRestartAndRequiresPinnedOwnerNewUniqueVideo()
    {
        using TempDirectory temp = new();
        string database = Path.Combine(temp.Path, "catalogue.db");
        XTeaserPublicationContext context;
        using (var store = CatalogueStore.Open(database))
        {
            store.RecordXObservations(new(Owner, [Post("601", Scheduled.AddMinutes(-2))]), Scheduled);
            context = store.GetXTeaserPublicationContext(Scheduled)!;
            Assert.AreEqual("601", context.LatestStatusId);
            store.RecordXObservations(new(Owner, [Post("602", Scheduled.AddMinutes(5))]), Scheduled.AddMinutes(5));
        }
        using (var store = CatalogueStore.Open(database))
        {
            var result = store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled.AddMinutes(30));
            Assert.AreEqual("https://x.com/Owner_Handle/status/602", result?.Url);
            Assert.AreEqual(Scheduled.AddMinutes(5), result?.PostedUtc);
            Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context with { AccountId = "2" }, Scheduled.AddMinutes(30)));
            Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context with { Handle = "Other" }, Scheduled.AddMinutes(30)));
            Assert.IsNull(store.ResolveXTeaserPublication(Hash("different"), context, Scheduled.AddMinutes(30)));
            store.RecordXObservations(new(Owner, [Post("603", Scheduled.AddMinutes(6), inReplyTo: "602"),
                Post("604", Scheduled.AddMinutes(7), retweet: true)]), Scheduled.AddMinutes(30));
            Assert.IsNotNull(store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled.AddMinutes(30)));
            store.RecordXObservations(new(Owner, [Post("605", Scheduled.AddMinutes(8))]), Scheduled.AddMinutes(30));
            Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled.AddMinutes(30)), "Never guess between identical captions.");
        }
    }

    [TestMethod]
    public void PublicationRejectsOldFutureForeignAndScheduledMismatch()
    {
        using TempDirectory temp = new();
        using var store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Post("701", Scheduled.AddMinutes(-2))]), Scheduled);
        var context = store.GetXTeaserPublicationContext(Scheduled)!;
        store.RecordXObservations(new(Owner, [Post("702", Scheduled.AddMinutes(-1)), Post("703", Scheduled.AddMinutes(20))]), Scheduled);
        Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled));
        Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled.AddMinutes(30), Scheduled.AddHours(1)));
        Exec(store, "UPDATE x_posts SET author_id='2' WHERE status_id='703'");
        Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled.AddMinutes(30)));
    }

    [TestMethod]
    public void PublicationRecoveryRequiresExactUploadedMediaIds()
    {
        using TempDirectory temp = new();
        using var store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.RecordXObservations(new(Owner, [Post("801", Scheduled.AddMinutes(-2), "old caption")]), Scheduled);
        var context = store.GetXTeaserPublicationContext(Scheduled)!;
        store.RecordXObservations(new(Owner, [Post("802", Scheduled.AddMinutes(5))]), Scheduled.AddMinutes(5));
        Assert.IsNull(store.ResolveXTeaserPublication(Hash(Caption), context, Scheduled.AddMinutes(10), mediaIds: ["999"]));
        Assert.AreEqual("https://x.com/Owner_Handle/status/802", store.ResolveXTeaserPublication(Hash(Caption), context,
            Scheduled.AddMinutes(10), mediaIds: ["1900000000000000001"])?.Url);
    }

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
