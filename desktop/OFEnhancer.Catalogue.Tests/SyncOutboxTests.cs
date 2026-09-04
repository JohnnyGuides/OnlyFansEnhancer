namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class SyncOutboxTests
{
    private static readonly DateTimeOffset Clock = new(2026, 9, 4, 10, 30, 0, TimeSpan.Zero);
    private const string CanonicalOnlyFans = "https://onlyfans.com/123456789/johnny_guides";
    private const string DifferentOnlyFans = "https://onlyfans.com/987654321/johnny_guides";

    [TestMethod]
    public void EnqueueIsIdempotentForTheSameFrozenProjection()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);
        SyncOutboxItem request = Request(itemId, "idempotency-1");

        SyncOutboxItem first = store.EnqueueProjection(request);
        SyncOutboxItem repeated = store.EnqueueProjection(request);

        Assert.AreEqual(first.OperationId, repeated.OperationId);
        Assert.AreEqual(1, store.GetOpenSyncOperations().Count);
    }

    [TestMethod]
    public void EnqueueRejectsPrivateOrNoncanonicalPayloadsBeforeSql()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);

        SyncOutboxException exception = Assert.ThrowsException<SyncOutboxException>(
            () => store.EnqueueProjection(Request(itemId, "idempotency-private", payloadValue: @"C:\private\ashley.mp4"))
        );

        Assert.AreEqual("invalid-sync-outbox", exception.Code);
        Assert.AreEqual(0, store.GetOpenSyncOperations().Count);
    }

    [TestMethod]
    public void EnqueueRejectsPublicUrlsOutsideTheDestinationCanonicalShape()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);

        Assert.ThrowsException<SyncOutboxException>(
            () => store.EnqueueProjection(Request(itemId, "idempotency-wrong-host", payloadValue: "https://example.com/123456789/johnny_guides"))
        );

        Assert.AreEqual(0, store.GetOpenSyncOperations().Count);
    }

    [TestMethod]
    public void PendingOperationMovesThroughAttemptedToCompleted()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);
        SyncOutboxItem item = store.EnqueueProjection(Request(itemId, "idempotency-complete"));

        store.MarkSyncAttempted(item.OperationId, Clock);
        store.MarkSyncCompleted(item.OperationId, Clock.AddMinutes(1));

        Assert.AreEqual(0, store.GetOpenSyncOperations().Count);
        Assert.AreEqual(SyncOutboxState.Completed, store.GetSyncOperation(item.OperationId).State);
        Assert.AreEqual(1, store.GetSyncOperation(item.OperationId).AttemptCount);
    }

    [TestMethod]
    public void AttemptedOperationCanBecomeConflictOrUnresolved()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);
        SyncOutboxItem conflict = store.EnqueueProjection(Request(itemId, "idempotency-conflict"));
        SyncOutboxItem unresolved = store.EnqueueProjection(Request(itemId, "idempotency-unresolved"));

        store.MarkSyncAttempted(conflict.OperationId, Clock);
        store.MarkSyncConflict(conflict.OperationId, "remote-fingerprint-changed", Clock.AddMinutes(1));
        store.MarkSyncAttempted(unresolved.OperationId, Clock);
        store.MarkSyncUnresolved(unresolved.OperationId, "network-uncertain", Clock.AddMinutes(1));

        Assert.AreEqual(SyncOutboxState.Conflict, store.GetSyncOperation(conflict.OperationId).State);
        Assert.AreEqual(SyncOutboxState.Unresolved, store.GetSyncOperation(unresolved.OperationId).State);
    }

    [TestMethod]
    public void AttemptedOperationCannotReturnToPendingOrChangeItsIntent()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);
        SyncOutboxItem item = store.EnqueueProjection(Request(itemId, "idempotency-immutable"));

        store.MarkSyncAttempted(item.OperationId, Clock);

        Assert.ThrowsException<SyncOutboxException>(
            () => store.EnqueueProjection(Request(itemId, item.IdempotencyKey, DifferentOnlyFans, item.OperationId))
        );
        Assert.AreEqual(SyncOutboxState.Attempted, store.GetSyncOperation(item.OperationId).State);
        Assert.AreEqual(CanonicalOnlyFans, store.GetSyncOperation(item.OperationId).PayloadValue);
    }

    [TestMethod]
    public void OpenOperationsHaveStableCreationOrder()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = OpenWithItem(temp.Path, out string itemId);
        SyncOutboxItem later = store.EnqueueProjection(Request(itemId, "idempotency-later", createdUtc: Clock.AddMinutes(1)));
        SyncOutboxItem earlier = store.EnqueueProjection(Request(itemId, "idempotency-earlier", createdUtc: Clock));

        CollectionAssert.AreEqual(
            new[] { earlier.OperationId, later.OperationId },
            store.GetOpenSyncOperations().Select(item => item.OperationId).ToArray()
        );
    }

    private static CatalogueStore OpenWithItem(string directory, out string itemId)
    {
        CatalogueStore store = CatalogueStore.Open(Path.Combine(directory, "catalogue.db"));
        Guid stable = Guid.NewGuid();
        store.ImportWorkbookProjection(
            new WorkbookProjection(
                "workbook-1",
                "2126708696",
                true,
                [new WorkbookCatalogueItem(7, "ashley", "Ashley episode", "Description", "2026-09-11", "Ashley", "04", 2, 1, new Dictionary<string, string> { ["onlyfans"] = CanonicalOnlyFans }, stable.ToString("D"))]
            )
        );
        itemId = stable.ToString("D");
        return store;
    }

    private static SyncOutboxItem Request(string itemId, string idempotencyKey, string payloadValue = CanonicalOnlyFans, string? operationId = null, DateTimeOffset? createdUtc = null) =>
        new(
            operationId ?? Guid.NewGuid().ToString("D"),
            idempotencyKey,
            itemId,
            "workbook-1",
            "2126708696",
            "ofenhancer.item_id.v1",
            itemId,
            "onlyfans",
            payloadValue,
            new string('a', 64),
            new string('b', 64),
            SyncOutboxState.Pending,
            0,
            null,
            createdUtc ?? Clock,
            null,
            null,
            null
        );

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-outbox-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
