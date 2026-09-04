namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class WorkbookProjectionTests
{
    [TestMethod]
    public void StableMetadataIdSurvivesRowMoveAndFreshLocalImport()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Guid stable = Guid.NewGuid();

        store.ImportWorkbookProjection(Projection(complete: true, Row(93, stable)));
        store.ImportWorkbookProjection(Projection(complete: true, Row(14, stable)));

        CatalogueItemSummary item = AssertSingle(store.GetItems(includeArchived: true));
        Assert.AreEqual(stable.ToString("D"), item.ItemId);
        Assert.AreEqual(14, item.SourceRow);
        GoogleRowBinding binding = store.GetGoogleBindings("workbook-1").Single();
        Assert.AreEqual(stable.ToString("D"), binding.MetadataId);
        Assert.AreEqual(14, binding.LastObservedRow);
    }

    [TestMethod]
    public void ExistingLocalSourceKeyKeepsItsIdentityBeforeWorkbookMigration()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(Snapshot("ashley"));
        string existingId = AssertSingle(store.GetItems()).ItemId;

        store.ImportWorkbookProjection(Projection(complete: true, Row(51, metadataId: null)));

        Assert.AreEqual(existingId, AssertSingle(store.GetItems(includeArchived: true)).ItemId);
    }

    [TestMethod]
    public void CompleteWorkbookPullArchivesMissingLocalItems()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Guid ashley = Guid.NewGuid();
        Guid bianca = Guid.NewGuid();
        store.ImportWorkbookProjection(Projection(complete: true, Row(10, ashley, "ashley"), Row(11, bianca, "bianca")));

        store.ImportWorkbookProjection(Projection(complete: true, Row(12, bianca, "bianca")));

        CatalogueItemSummary archived = store.GetItems(includeArchived: true).Single(item => item.SourceKey == "ashley");
        Assert.IsTrue(archived.Archived);
    }

    [TestMethod]
    public void DuplicateMetadataIdRejectsTheEntireProjection()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportWorkbookProjection(Projection(complete: true, Row(7, Guid.NewGuid(), "existing")));
        Guid duplicate = Guid.NewGuid();

        Assert.ThrowsException<WorkbookProjectionException>(
            () => store.ImportWorkbookProjection(Projection(complete: true, Row(8, duplicate, "ashley"), Row(9, duplicate, "bianca")))
        );

        CatalogueItemSummary[] items = [.. store.GetItems(includeArchived: true)];
        Assert.AreEqual(1, items.Length);
        Assert.AreEqual("existing", items[0].SourceKey);
        Assert.IsFalse(items[0].Archived);
    }

    [TestMethod]
    public void IncompleteWorkbookSnapshotDoesNotArchiveMissingItems()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportWorkbookProjection(Projection(complete: true, Row(7, Guid.NewGuid(), "ashley")));

        store.ImportWorkbookProjection(Projection(complete: false, Row(8, Guid.NewGuid(), "bianca")));

        Assert.IsFalse(AssertSingle(store.GetItems(includeArchived: true)).Archived);
    }

    private static WorkbookProjection Projection(bool complete, params WorkbookCatalogueItem[] items) =>
        new("workbook-1", "2126708696", complete, items);

    private static WorkbookCatalogueItem Row(int row, Guid? metadataId, string sourceKey = "ashley") =>
        new(
            sourceRow: row,
            sourceKey: sourceKey,
            title: $"{sourceKey} episode",
            description: "Description",
            plannedDate: "2026-09-11",
            series: "Ashley",
            episode: "04",
            xTeasers: 2,
            redditTeasers: 1,
            platformLinks: new Dictionary<string, string> { ["onlyfans"] = "https://onlyfans.com/123456789/johnny_guides" },
            metadataId: metadataId?.ToString("D")
        );

    private static string Snapshot(string sourceKey) =>
        System.Text.Json.JsonSerializer.Serialize(
            new
            {
                version = 1,
                items = new[]
                {
                    new
                    {
                        sourceKey,
                        sourceRow = 42,
                        title = "Ashley episode",
                        description = "Description",
                        plannedDate = "2026-09-11",
                        series = "Ashley",
                        episode = "04",
                        xTeasers = 2,
                        redditTeasers = 1,
                        platformLinks = new Dictionary<string, string>
                        {
                            ["onlyfans"] = "https://onlyfans.com/123456789/johnny_guides",
                        },
                    },
                },
            }
        );

    private static CatalogueItemSummary AssertSingle(IReadOnlyList<CatalogueItemSummary> items)
    {
        Assert.AreEqual(1, items.Count);
        return items[0];
    }

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-workbook-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
