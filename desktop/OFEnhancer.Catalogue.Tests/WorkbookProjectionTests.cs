namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class WorkbookProjectionTests
{
    [TestMethod]
    public void SnapshotAfterWorkbookImportMustRestoreProjectionAcrossRestart()
    {
        using TestDirectory temp = new();
        string database = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore store = CatalogueStore.Open(database))
        {
            store.ImportSnapshot(Snapshot("ashley"));
            Assert.IsTrue(store.ImportSnapshot(Snapshot("ashley")).Unchanged);
            store.ImportWorkbookProjection(Projection(true, Row(15, null, "bianca")));
        }
        using (CatalogueStore store = CatalogueStore.Open(database))
        {
            Assert.IsFalse(store.ImportSnapshot(Snapshot("ashley")).Unchanged);
            Assert.AreEqual("ashley", store.GetItems().Single().SourceKey);
            Assert.IsTrue(store.ImportSnapshot(Snapshot("ashley")).Unchanged);
        }
    }

    [TestMethod]
    public void InvalidSourceLinkEvidenceRejectsImportBeforeChangingLocalRows()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportWorkbookProjection(Projection(true, Row(2, null, "kept")), updateGoogleBindings: false);
        foreach (CatalogueSourceLinkCell cell in new[]
        {
            new CatalogueSourceLinkCell("text", null, ["https://evil.example/post"]),
            new CatalogueSourceLinkCell("bad\0text", null, []),
            new CatalogueSourceLinkCell(new string('a', 10_001), null, []),
            new CatalogueSourceLinkCell("text", new string('a', 2_049), []),
            new CatalogueSourceLinkCell("text", null, Enumerable.Repeat("https://x.com/creator/status/123456789", 101).ToArray())
        })
        {
            WorkbookCatalogueItem row = new(3, "other", "Title", "", null, null, null, 0, 0,
                new Dictionary<string, string>(), null, new Dictionary<string, CatalogueSourceLinkCell> { ["x"] = cell });
            Assert.ThrowsException<WorkbookProjectionException>(() => store.ImportWorkbookProjection(Projection(true, row), updateGoogleBindings: false));
            Assert.AreEqual("kept", store.GetItems().Single().SourceKey);
        }
    }

    [TestMethod]
    public void ReadImportPreservesAllSourceLinksAcrossReopenAndLegacySyncPull()
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "catalogue.db");
        string first = "https://x.com/johnny_guides/status/123456789";
        string second = "https://x.com/johnny_guides/status/234567890";
        CatalogueSourceLinkCell cell = new(first + "\r\n" + second, null, [first, second], "multiple-links");
        CatalogueSourceLinkCell conflict = new("https://onlyfans.com/123456789/creator", "https://onlyfans.com/234567890/creator",
            ["https://onlyfans.com/123456789/creator", "https://onlyfans.com/234567890/creator"], "catalogue-link-conflict");
        WorkbookCatalogueItem row = new(2, "source", "Title", "", null, null, null, 2, 0,
            new Dictionary<string, string>(), null, new Dictionary<string, CatalogueSourceLinkCell> { ["x"] = cell, ["onlyfans"] = conflict });
        using (CatalogueStore store = CatalogueStore.Open(path))
        {
            store.ImportWorkbookProjection(Projection(true, row), updateGoogleBindings: false);
            Assert.AreEqual(0, store.GetGoogleBindings("workbook-1").Count);
        }
        using (CatalogueStore store = CatalogueStore.Open(path))
        {
            CatalogueSourceLinkCell actual = store.GetItems().Single().SourceLinkCells!["x"];
            Assert.AreEqual(cell.Text, actual.Text);
            CollectionAssert.AreEqual(cell.Urls.ToArray(), actual.Urls.ToArray());
            Assert.AreEqual(cell.IssueCode, actual.IssueCode);
            CatalogueItemSummary summary = store.GetItems().Single();
            Assert.IsFalse(summary.PlatformLinks.ContainsKey("onlyfans"));
            Assert.AreEqual(conflict.Hyperlink, summary.SourceLinkCells!["onlyfans"].Hyperlink);
            Assert.AreEqual(conflict.Text, summary.SourceLinkCells["onlyfans"].Text);
            store.ImportWorkbookProjection(Projection(true, Row(2, null, "source")));
            Assert.AreEqual(cell.Text, store.GetItems().Single().SourceLinkCells!["x"].Text);
            store.ImportWorkbookProjection(Projection(true, Row(2, null, "source")), updateGoogleBindings: false);
            Assert.AreEqual(0, store.GetItems().Single().SourceLinkCells!.Count);
        }
    }

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
        Guid ashley = Guid.NewGuid();
        Guid bianca = Guid.NewGuid();
        store.ImportWorkbookProjection(Projection(complete: true, Row(7, ashley, "ashley")));

        store.ImportWorkbookProjection(Projection(complete: false, Row(8, bianca, "bianca")));

        CatalogueItemSummary[] items = [.. store.GetItems(includeArchived: true)];
        Assert.AreEqual(2, items.Length);
        Assert.IsFalse(items.Single(item => item.SourceKey == "ashley").Archived);
        Assert.IsFalse(items.Single(item => item.SourceKey == "bianca").Archived);
        Assert.AreEqual(2, store.GetGoogleBindings("workbook-1").Count);
    }

    [TestMethod]
    public void ReplaceGoogleBindingsCanonicalizesGuidIdentityBeforeCheckingDuplicates()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Guid ashley = Guid.NewGuid();
        Guid bianca = Guid.NewGuid();
        store.ImportWorkbookProjection(Projection(complete: true, Row(7, ashley, "ashley"), Row(8, bianca, "bianca")));
        GoogleRowBinding[] original = [.. store.GetGoogleBindings("workbook-1")];
        GoogleRowBinding first = original.Single(binding => binding.ItemId == ashley.ToString("D"));
        GoogleRowBinding second = original.Single(binding => binding.ItemId == bianca.ToString("D"));

        Assert.ThrowsException<WorkbookProjectionException>(
            () => store.ReplaceGoogleBindings(
                "workbook-1",
                [first, second with { MetadataId = first.MetadataId.ToUpperInvariant() }]
            )
        );

        CollectionAssert.AreEqual(original, store.GetGoogleBindings("workbook-1").ToArray());
    }

    [TestMethod]
    public void ReplaceGoogleBindingsStoresCanonicalGuidAndUtcTimestampValues()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Guid stable = Guid.NewGuid();
        store.ImportWorkbookProjection(Projection(complete: true, Row(7, stable)));
        GoogleRowBinding original = store.GetGoogleBindings("workbook-1").Single();
        DateTimeOffset localTime = new(2026, 9, 4, 12, 0, 0, TimeSpan.FromHours(2));

        store.ReplaceGoogleBindings(
            "workbook-1",
            [original with { ItemId = original.ItemId.ToUpperInvariant(), MetadataId = original.MetadataId.ToUpperInvariant(), VerifiedUtc = localTime }]
        );

        GoogleRowBinding stored = store.GetGoogleBindings("workbook-1").Single();
        Assert.AreEqual(stable.ToString("D"), stored.ItemId);
        Assert.AreEqual(stable.ToString("D"), stored.MetadataId);
        Assert.AreEqual(localTime.ToUniversalTime(), stored.VerifiedUtc);
    }

    [TestMethod]
    public void ReplaceGoogleBindingsRejectsInvalidValuesBeforeChangingStoredBindings()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        Guid stable = Guid.NewGuid();
        store.ImportWorkbookProjection(Projection(complete: true, Row(7, stable)));
        GoogleRowBinding original = store.GetGoogleBindings("workbook-1").Single();
        GoogleRowBinding[] invalid =
        [
            original with { WorkbookId = new string('w', 257) },
            original with { SheetId = new string('s', 65) },
            original with { ItemId = "not-a-guid" },
            original with { MetadataId = "not-a-guid" },
            original with { VerifiedRemoteFingerprint = new string('g', 64) },
            original with { LastObservedRow = 1_000_001 },
            original with { VerifiedUtc = default },
        ];

        foreach (GoogleRowBinding candidate in invalid)
            Assert.ThrowsException<WorkbookProjectionException>(
                () => store.ReplaceGoogleBindings(candidate.WorkbookId, [candidate])
            );

        CollectionAssert.AreEqual(new[] { original }, store.GetGoogleBindings("workbook-1").ToArray());
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
