using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CatalogueMatcherTests
{
    [TestMethod]
    public void FilenameEvidenceRanksCandidatesButNeverCreatesABinding()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(root, "ashley_04_cover.png"), [1, 3, 3, 7]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(MultiSnapshot());
        store.ScanThumbnails(root);

        CatalogueView first = store.GetCatalogue();
        UnmatchedAssetSummary unmatched = first.UnmatchedAssets.Single();

        Assert.AreEqual(0L, ScalarLong(store.Connection, "SELECT count(*) FROM asset_bindings"));
        Assert.AreEqual(2, unmatched.Candidates.Count);
        Assert.AreEqual("Ashley episode 04", unmatched.Candidates[0].Title);
        Assert.IsTrue(unmatched.Candidates[0].Score > unmatched.Candidates[1].Score);
        Assert.IsTrue(first.Items.All(item => item.ThumbnailStatus == "missing"));
    }

    [TestMethod]
    public void ExplicitChoicePersistsAndRebindingIsAudited()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(root, "ashley.png"), [9, 8, 7]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(MultiSnapshot());
        store.ScanThumbnails(root);
        string assetId = store.GetCatalogue().UnmatchedAssets.Single().AssetId;
        string firstItem = store.GetItems().Single(item => item.Title.EndsWith("04", StringComparison.Ordinal)).ItemId;
        string secondItem = store.GetItems().Single(item => item.Title.EndsWith("05", StringComparison.Ordinal)).ItemId;

        BindingSummary first = store.ConfirmAssetBinding(assetId, firstItem);
        BindingSummary same = store.ConfirmAssetBinding(assetId, firstItem);
        BindingSummary changed = store.ConfirmAssetBinding(assetId, secondItem);

        Assert.IsTrue(first.Changed);
        Assert.IsFalse(same.Changed);
        Assert.IsTrue(changed.Changed);
        Assert.AreEqual(secondItem, store.GetAssets().Single().BoundItemId);
        Assert.AreEqual(2L, ScalarLong(store.Connection, "SELECT count(*) FROM audit_events WHERE kind = 'asset-bound'"));
        Assert.AreEqual(0, store.GetCatalogue().UnmatchedAssets.Count);
    }

    [TestMethod]
    public void CandidateListIsDeterministicAndCappedAtFive()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(root, "shared.png"), [5, 5, 5]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(ManySnapshot());
        store.ScanThumbnails(root);

        string[] first = store.GetCatalogue().UnmatchedAssets.Single().Candidates.Select(item => item.ItemId).ToArray();
        string[] second = store.GetCatalogue().UnmatchedAssets.Single().Candidates.Select(item => item.ItemId).ToArray();

        Assert.AreEqual(5, first.Length);
        CollectionAssert.AreEqual(first, second);
    }

    private static long ScalarLong(SqliteConnection connection, string sql)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static string MultiSnapshot() =>
        """
        {"version":1,"items":[
          {"sourceKey":"ashley-04","sourceRow":10,"title":"Ashley episode 04","description":"","plannedDate":"2026-09-11","series":"Ashley","episode":"04","xTeasers":1,"redditTeasers":2,"platformLinks":{}},
          {"sourceKey":"ashley-05","sourceRow":11,"title":"Ashley episode 05","description":"","plannedDate":"2026-09-18","series":"Ashley","episode":"05","xTeasers":0,"redditTeasers":0,"platformLinks":{}}
        ]}
        """;

    private static string ManySnapshot()
    {
        string items = string.Join(
            ",",
            Enumerable.Range(1, 8).Select(index =>
                """
                {"sourceKey":"item-$INDEX$","sourceRow":$INDEX$,"title":"Shared video $INDEX$","description":"","plannedDate":null,"series":"Shared","episode":"$INDEX$","xTeasers":0,"redditTeasers":0,"platformLinks":{}}
                """.Replace("$INDEX$", index.ToString(), StringComparison.Ordinal)
            )
        );
        return """{"version":1,"items":[$ITEMS$]}""".Replace(
            "$ITEMS$",
            items,
            StringComparison.Ordinal
        );
    }

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-match-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
