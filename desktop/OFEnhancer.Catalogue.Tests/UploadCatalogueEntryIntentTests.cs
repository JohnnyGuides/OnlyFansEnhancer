using OFEnhancer.Catalogue;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class UploadCatalogueEntryIntentTests
{
    [TestMethod]
    public void Attempted_intent_survives_restart_and_same_id_cannot_change_title_or_workbook()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"ofe-entry-intent-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, "catalogue.db");
        const string operationId = "8f02f51a-0e7b-4ec8-915e-7de45b7aa210";
        const string request = "{\"mode\":\"new\",\"title\":\"Episode A\",\"description\":\"Draft\"}";
        try
        {
            using (CatalogueStore store = CatalogueStore.Open(path))
            {
                UploadCatalogueEntryIntent pending = store.BeginUploadCatalogueEntryIntent(
                    operationId, "workbook-a", "17", request);
                Assert.AreEqual("pending", pending.State);
                UploadCatalogueEntryIntent attempted = store.MarkUploadCatalogueEntryAttempted(
                    operationId, "source-a", "stable-item-a", 42);
                Assert.AreEqual("attempted", attempted.State);
                store.MarkUploadCatalogueEntryUnresolved(operationId, "google-mutation-uncertain");
            }

            using CatalogueStore reopened = CatalogueStore.Open(path);
            UploadCatalogueEntryIntent recovered = reopened.BeginUploadCatalogueEntryIntent(
                operationId, "workbook-a", "17", request);
            Assert.AreEqual("unresolved", recovered.State);
            Assert.AreEqual("source-a", recovered.SourceKey);
            Assert.AreEqual("stable-item-a", recovered.ItemId);
            Assert.AreEqual(42, recovered.Row);

            InvalidOperationException titleChange = Assert.ThrowsException<InvalidOperationException>(() =>
                reopened.BeginUploadCatalogueEntryIntent(operationId, "workbook-a", "17",
                    "{\"mode\":\"new\",\"title\":\"Episode B\",\"description\":\"Draft\"}"));
            Assert.AreEqual("catalogue-entry-operation-conflict", titleChange.Message);
            InvalidOperationException workbookChange = Assert.ThrowsException<InvalidOperationException>(() =>
                reopened.BeginUploadCatalogueEntryIntent(operationId, "workbook-b", "17", request));
            Assert.AreEqual("catalogue-entry-operation-conflict", workbookChange.Message);
            Assert.AreEqual("unresolved", reopened.GetUploadCatalogueEntryIntent(operationId)!.State);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [TestMethod]
    public void Unresolved_intent_cannot_be_marked_pending_or_retargeted()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"ofe-entry-intent-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            using CatalogueStore store = CatalogueStore.Open(Path.Combine(directory, "catalogue.db"));
            const string operationId = "0b3c9246-013e-4f9d-8d0b-6ce8119b46a9";
            store.BeginUploadCatalogueEntryIntent(operationId, "workbook", "0", "{\"mode\":\"new\"}");
            store.MarkUploadCatalogueEntryAttempted(operationId, "source", "item", 9);
            store.MarkUploadCatalogueEntryUnresolved(operationId, "google-row-write-unresolved");
            InvalidOperationException retryWrite = Assert.ThrowsException<InvalidOperationException>(() =>
                store.MarkUploadCatalogueEntryAttempted(operationId, "source", "item", 9));
            Assert.AreEqual("catalogue-entry-operation-unresolved", retryWrite.Message);
            InvalidOperationException retarget = Assert.ThrowsException<InvalidOperationException>(() =>
                store.CompleteUploadCatalogueEntryIntent(operationId, "other-source", "item", 9));
            Assert.AreEqual("catalogue-entry-operation-state-conflict", retarget.Message);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}
