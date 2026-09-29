using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class ProductionHandoffsTests
{
    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
            "OFEnhancerProductionTests", Guid.NewGuid().ToString("N"));

        public TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    [TestMethod]
    public void DraftIsIdempotentAndCatalogueBindingSurvivesRestart()
    {
        using TempDirectory temp = new();
        var database = Path.Combine(temp.Path, "catalogue.db");
        var handoffId = Guid.NewGuid().ToString("D");
        var itemId = Guid.NewGuid().ToString("D");
        using (var store = CatalogueStore.Open(database))
        {
            var draft = store.SaveProductionDraft(handoffId, Guid.NewGuid().ToString("D"),
                Guid.NewGuid().ToString("D"), "S5E8", 2, "[]", "fingerprint-a");
            Assert.AreEqual("awaiting_review", draft.State);
            Assert.AreEqual(draft, store.SaveProductionDraft(handoffId, draft.EpisodeId,
                draft.EditId, draft.EpisodeCode, draft.EditNumber,
                draft.FilesJson, draft.RequestFingerprint));
            Assert.ThrowsException<InvalidOperationException>(() =>
                store.SaveProductionDraft(handoffId, draft.EpisodeId, draft.EditId,
                    draft.EpisodeCode, draft.EditNumber, "[]", "fingerprint-b"));
            Assert.ThrowsException<InvalidOperationException>(() =>
                store.ReviewProductionHandoff(handoffId, "bound", "missing-item"));
            using SqliteCommand insert = store.Connection.CreateCommand();
            insert.CommandText = """
                INSERT INTO catalogue_items(item_id, source_key, title, updated_utc)
                VALUES ($id, 'fixture', 'Fixture', $updated)
                """;
            insert.Parameters.AddWithValue("$id", itemId);
            insert.Parameters.AddWithValue("$updated", DateTimeOffset.UtcNow.ToString("O"));
            insert.ExecuteNonQuery();
            var bound = store.ReviewProductionHandoff(handoffId, "bound", itemId);
            Assert.AreEqual("bound", bound.State);
            Assert.AreEqual(itemId, bound.CatalogueItemId);
            Assert.ThrowsException<InvalidOperationException>(() =>
                store.ReviewProductionHandoff(handoffId, "rejected"));
        }
        using var reopened = CatalogueStore.Open(database);
        var saved = reopened.GetProductionHandoff(handoffId)!;
        Assert.AreEqual("bound", saved.State);
        Assert.AreEqual(itemId, saved.CatalogueItemId);
    }

    [TestMethod]
    public void ChangedSourceStateRemainsReviewableAndDoesNotInventBinding()
    {
        using TempDirectory temp = new();
        using var store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        var id = Guid.NewGuid().ToString("D");
        store.SaveProductionDraft(id, Guid.NewGuid().ToString("D"),
            Guid.NewGuid().ToString("D"), "S5E8", 1, "[]", "fingerprint");
        var changed = store.ReviewProductionHandoff(id, "changed_source");
        Assert.AreEqual("changed_source", changed.State);
        Assert.IsNull(changed.CatalogueItemId);
        Assert.AreEqual(id, store.GetPendingProductionHandoffs().Single().HandoffId);
        Assert.ThrowsException<InvalidOperationException>(() =>
            store.ReviewProductionHandoff(id, "bound", "any-item"));
    }
}
