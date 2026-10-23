using OFEnhancer.Catalogue;
using System.Text.Json;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CreatorWorkflowProjectionTests
{
    [TestMethod]
    public void ProjectionIntentIsTransactionalImmutableAndRemainsBoundToItsFirstWorkbookAcrossAssociation()
    {
        using TempDirectory temp = new();
        string path = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore store = Store(path))
        {
            store.SaveGoogleCatalogueWorkbook("workbook-one", "First workbook");
            CreatorWorkflowSnapshot unbound = Snapshot("run-projection-01", 1, null) with
            { Destination = new("workbook-one", null) };
            Assert.AreEqual("recorded", store.RecordCreatorWorkflow(unbound).Status);
            Assert.AreEqual("idempotent", store.RecordCreatorWorkflow(unbound).Status);
            Assert.AreEqual(1, store.GetCreatorWorkflowProjectionIntents("workbook-one").Count);

            CreatorWorkflowSnapshot associated = unbound with { Revision = 2, SourceKey = "episode-a" };
            Assert.AreEqual("recorded", store.RecordCreatorWorkflow(associated).Status);
            CreatorWorkflowProjectionIntent[] intents = [.. store.GetCreatorWorkflowProjectionIntents("workbook-one")];
            Assert.AreEqual(2, intents.Length, "each immutable revision gets its own row intent");
            Assert.AreEqual(2, intents.Select(value => value.Revision).Distinct().Count());
            Assert.AreEqual("episode-a", intents.Single(value => value.Revision == 2).Snapshot.SourceKey);
            Assert.AreEqual("Episode A", intents.Single(value => value.Revision == 2).SourceTitle);
            Assert.IsTrue(Guid.TryParse(intents.Single(value => value.Revision == 2).SourceItemId, out _),
                "the projection captures the catalogue's stable item ID alongside its source key");

            CreatorWorkflowProjectionIntent attempted = intents.Single(value => value.Revision == 1) with
            {
                State = "attempted",
                LedgerSheetId = 321,
            };
            Assert.AreEqual(attempted, store.RecordCreatorWorkflowProjection(attempted));
            Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflowProjection(
                attempted with { Snapshot = attempted.Snapshot with { Revision = 3 } }));
        }

        using CatalogueStore reopened = CatalogueStore.Open(path);
        CreatorWorkflowProjectionCounts counts = reopened.GetCreatorWorkflowProjectionCounts("workbook-one");
        Assert.AreEqual(1, counts.Attempted);
        Assert.AreEqual(1, counts.Pending);
        Assert.AreEqual(0, counts.Unresolved);
        Assert.AreEqual(0, counts.Conflicts);
    }

    [TestMethod]
    public void HistoricalRunWithoutWorkbookAffinityIsNeverProjectedAfterWorkbookSelection()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = Store(Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot first = Snapshot("run-projection-02", 1, null);
        store.RecordCreatorWorkflow(first);
        store.SaveGoogleCatalogueWorkbook("workbook-later", "Later workbook");
        store.RecordCreatorWorkflow(first with { Revision = 2, SourceKey = "episode-a" });
        Assert.AreEqual(0, store.GetCreatorWorkflowProjectionIntents("workbook-later").Count);
    }

    [TestMethod]
    public void FrozenWorkflowDestinationCannotFollowTheCurrentWorkbook()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = Store(Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot first = Snapshot("run-projection-03", 1, "episode-a") with
        { Destination = new("workbook-one", "1") };
        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(first).Status);

        store.SaveGoogleCatalogueWorkbook("workbook-two", "Different workbook");
        CreatorWorkflowSnapshot sameDestination = first with { Revision = 2 };
        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(sameDestination).Status);
        CreatorWorkflowSnapshot attemptedReplacement = sameDestination with
        { Revision = 3, Destination = new("workbook-two", "2") };
        Assert.AreEqual("creator-workflow-destination-conflict",
            store.RecordCreatorWorkflow(attemptedReplacement).Code);
        Assert.AreEqual(2, store.GetCreatorWorkflowProjectionIntents("workbook-one").Count);
        Assert.AreEqual(0, store.GetCreatorWorkflowProjectionIntents("workbook-two").Count);
    }

    [TestMethod]
    public void ExplicitRetryReopensOnlyANeverAttemptedLedgerCapacityConflict()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = Store(Path.Combine(temp.Path, "catalogue.db"));
        store.SaveGoogleCatalogueWorkbook("workbook-one", "First workbook");
        CreatorWorkflowSnapshot snapshot = Snapshot("run-capacity-retry", 1, null) with
        { Destination = new("workbook-one", "1") };
        store.RecordCreatorWorkflow(snapshot);
        CreatorWorkflowProjectionIntent intent = store.GetCreatorWorkflowProjectionIntents("workbook-one").Single();
        CreatorWorkflowProjectionIntent conflict = store.RecordCreatorWorkflowProjection(intent with
        { State = "conflict", ErrorCode = "google-workflow-ledger-full" });

        CreatorWorkflowProjectionIntent pending = store.RetryCreatorWorkflowProjectionCapacityConflict(conflict.Key);

        Assert.AreEqual("pending", pending.State);
        Assert.IsNull(pending.ErrorCode);
        Assert.AreEqual(intent.Key, pending.Key);
        Assert.AreEqual(intent.WorkbookId, pending.WorkbookId);
        Assert.AreEqual(JsonSerializer.Serialize(intent.Snapshot), JsonSerializer.Serialize(pending.Snapshot));
        Assert.ThrowsException<CreatorWorkflowException>(() =>
            store.RetryCreatorWorkflowProjectionCapacityConflict(pending.Key));
    }

    [TestMethod]
    public void CapacityConflictCannotBeReopenedAfterAnyHistoricalAttemptEvenIfCurrentStateIsConflict()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = Store(Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot snapshot = Snapshot("run-capacity-attempted", 1, null) with
        { Destination = new("workbook-one", "1") };
        store.RecordCreatorWorkflow(snapshot);
        CreatorWorkflowProjectionIntent intent = store.GetCreatorWorkflowProjectionIntents("workbook-one").Single();
        store.RecordCreatorWorkflowProjection(intent with { State = "attempted", LedgerSheetId = 123 });
        CreatorWorkflowProjectionIntent forgedLaterConflict = intent with
        { State = "conflict", ErrorCode = "google-workflow-ledger-full", LedgerSheetId = 123 };
        store.RecordCreatorWorkflowProjection(forgedLaterConflict);

        Assert.ThrowsException<CreatorWorkflowException>(() =>
            store.RetryCreatorWorkflowProjectionCapacityConflict(intent.Key));
        Assert.AreEqual("conflict", store.GetCreatorWorkflowProjectionIntents("workbook-one").Single().State);
    }

    private static CatalogueStore Store(string path)
    {
        CatalogueStore store = CatalogueStore.Open(path);
        store.ImportWorkbookProjection(new("source-workbook", "1", true,
        [
            new(2, "episode-a", "Episode A", "Description", null, null, null, 0, 0,
                new Dictionary<string, string>(), null),
        ]), updateGoogleBindings: false);
        return store;
    }

    private static CreatorWorkflowSnapshot Snapshot(string runId, long revision, string? sourceKey) => new(
        runId, "upload", revision, sourceKey,
        [new("onlyfans", "uploaded", "https://onlyfans.com/123/johnny_guides", Submitted: true)],
        [new("video", "episode.mp4", 1024, new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero), new string('a', 64))],
        new("uploaded", "episode.funscript", new string('b', 64), ["https://johnnyguides.com/sync/scripts/episode.funscript"]),
        new("https://fansly.com/Creator/posts", true, 15, "New episode: {{link}}", "https://x.com/owner/status/123"));

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
            "OFEnhancerCreatorWorkflowProjectionTests", Guid.NewGuid().ToString("N"));
        internal TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
