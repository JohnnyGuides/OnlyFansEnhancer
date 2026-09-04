using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CatalogueSnapshotImporterTests
{
    [TestMethod]
    public void ReimportKeepsOpaqueIdentityBindingAndArchivesMissingItems()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        CatalogueImportSummary firstImport = store.ImportSnapshot(Snapshot("Ashley", "Ashley episode", "2026-09-11"));
        CatalogueItemSummary first = AssertSingle(store.GetItems(includeArchived: true));
        Assert.AreEqual(1, firstImport.ActiveItems);
        Assert.IsTrue(Guid.TryParse(first.ItemId, out _));

        AddBoundAsset(store.Connection, first.ItemId);
        CatalogueImportSummary changed = store.ImportSnapshot(Snapshot("Ashley", "Ashley remaster", "2026-09-18"));
        CatalogueItemSummary updated = AssertSingle(store.GetItems(includeArchived: true));
        Assert.AreEqual(first.ItemId, updated.ItemId);
        Assert.AreEqual("Ashley remaster", updated.Title);
        Assert.AreEqual(1L, ScalarLong(store.Connection, "SELECT count(*) FROM asset_bindings"));
        Assert.IsFalse(changed.Unchanged);

        CatalogueImportSummary unchanged = store.ImportSnapshot(Snapshot("Ashley", "Ashley remaster", "2026-09-18"));
        Assert.IsTrue(unchanged.Unchanged);
        Assert.AreEqual(2L, ScalarLong(store.Connection, "SELECT count(*) FROM audit_events"));

        CatalogueImportSummary empty = store.ImportSnapshot("""{"version":1,"items":[]}""");
        CatalogueItemSummary archived = AssertSingle(store.GetItems(includeArchived: true));
        Assert.IsTrue(archived.Archived);
        Assert.AreEqual(0, empty.ActiveItems);
        Assert.AreEqual(1, empty.ArchivedItems);
        Assert.AreEqual(1L, ScalarLong(store.Connection, "SELECT count(*) FROM asset_bindings"));
    }

    [TestMethod]
    public void InvalidSnapshotsLeaveTheExistingProjectionUntouched()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(Snapshot("Ashley", "Ashley episode", "2026-09-11"));

        string[] invalidSnapshots =
        [
            """{"version":1,"items":[{"sourceKey":"same","sourceRow":1,"title":"One","description":"","plannedDate":null,"series":null,"episode":null,"xTeasers":0,"redditTeasers":0,"platformLinks":{}},{"sourceKey":"same","sourceRow":2,"title":"Two","description":"","plannedDate":null,"series":null,"episode":null,"xTeasers":0,"redditTeasers":0,"platformLinks":{}}]}""",
            """{"version":1,"items":[{"sourceKey":"bad-date","sourceRow":1,"title":"Bad","description":"","plannedDate":"Friday","series":null,"episode":null,"xTeasers":0,"redditTeasers":0,"platformLinks":{}}]}""",
            """{"version":1,"items":[{"sourceKey":"bad-count","sourceRow":1,"title":"Bad","description":"","plannedDate":null,"series":null,"episode":null,"xTeasers":-1,"redditTeasers":0,"platformLinks":{}}]}""",
            """{"version":1,"items":[{"sourceKey":"bad-link","sourceRow":1,"title":"Bad","description":"","plannedDate":null,"series":null,"episode":null,"xTeasers":0,"redditTeasers":0,"platformLinks":{"onlyfans":"http://example.com/post"}}]}""",
            """{"version":1,"items":[],"unexpected":true}""",
        ];

        foreach (string invalid in invalidSnapshots)
            Assert.ThrowsException<CatalogueSnapshotException>(() => store.ImportSnapshot(invalid));

        CatalogueItemSummary existing = AssertSingle(store.GetItems(includeArchived: true));
        Assert.AreEqual("Ashley episode", existing.Title);
        Assert.IsFalse(existing.Archived);
        Assert.AreEqual(1L, ScalarLong(store.Connection, "SELECT count(*) FROM audit_events"));
    }

    [TestMethod]
    public void SnapshotSizeLimitIsCheckedBeforeJsonParsing()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string oversized = new(' ', CatalogueSnapshotImporter.MaximumUtf8Bytes + 1);

        CatalogueSnapshotException exception = Assert.ThrowsException<CatalogueSnapshotException>(
            () => store.ImportSnapshot(oversized)
        );

        Assert.AreEqual("snapshot-too-large", exception.Code);
        Assert.AreEqual(0, store.GetItems(includeArchived: true).Count);
    }

    private static string Snapshot(string sourceKey, string title, string date) =>
        $$"""
        {
          "version": 1,
          "items": [
            {
              "sourceKey": "{{sourceKey}}",
              "sourceRow": 42,
              "title": "{{title}}",
              "description": "Description",
              "plannedDate": "{{date}}",
              "series": "Ashley",
              "episode": "04",
              "xTeasers": 2,
              "redditTeasers": 1,
              "platformLinks": {
                "onlyfans": "https://onlyfans.com/example/post/1",
                "fansly": "https://fansly.com/post/1"
              }
            }
          ]
        }
        """;

    private static CatalogueItemSummary AssertSingle(IReadOnlyList<CatalogueItemSummary> items)
    {
        Assert.AreEqual(1, items.Count);
        return items[0];
    }

    private static void AddBoundAsset(SqliteConnection connection, string itemId)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO media_assets(
                asset_id, sha256, role, file_name, absolute_path, scan_root,
                size_bytes, last_write_utc, available, updated_utc
            ) VALUES (
                'asset-1', $hash, 'curated', 'ashley.jpg', 'C:\fixture\ashley.jpg',
                'C:\fixture', 10, '2026-09-04T00:00:00Z', 1, '2026-09-04T00:00:00Z'
            );
            INSERT INTO asset_bindings(asset_id, item_id, confirmed_utc, evidence)
            VALUES ('asset-1', $itemId, '2026-09-04T00:00:00Z', 'user-confirmed');
            """;
        command.Parameters.AddWithValue("$hash", new string('a', 64));
        command.Parameters.AddWithValue("$itemId", itemId);
        command.ExecuteNonQuery();
    }

    private static long ScalarLong(SqliteConnection connection, string sql)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-import-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
