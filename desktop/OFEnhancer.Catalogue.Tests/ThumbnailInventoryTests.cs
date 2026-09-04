using System.Diagnostics;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class ThumbnailInventoryTests
{
    [TestMethod]
    public void ScanClassifiesImagesAndConfirmedBindingSurvivesRename()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(root, "ashley_33.png"), [1, 2, 3]);
        File.WriteAllBytes(Path.Combine(root, "ashley_4K.jpg"), [4, 5, 6]);
        string curatedPath = Path.Combine(root, "ashley.webp");
        File.WriteAllBytes(curatedPath, [7, 8, 9]);
        File.WriteAllText(Path.Combine(root, "ignore.txt"), "not an image");

        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(Snapshot("ashley-04", "Ashley episode 04"));

        ThumbnailScanSummary first = store.ScanThumbnails(root);
        IReadOnlyList<MediaAssetSummary> assets = store.GetAssets(includeUnavailable: true);
        Assert.AreEqual(3, first.AvailableAssets);
        Assert.AreEqual(3, first.NewAssets);
        CollectionAssert.AreEquivalent(
            new[] { "clips4sale-4k", "curated", "pornhub-33" },
            assets.Select(asset => asset.Role).ToArray()
        );
        MediaAssetSummary curated = assets.Single(asset => asset.Role == "curated");
        string itemId = store.GetItems().Single().ItemId;
        store.ConfirmAssetBinding(curated.AssetId, itemId);

        string renamed = Path.Combine(root, "anything.webp");
        File.Move(curatedPath, renamed);
        ThumbnailScanSummary second = store.ScanThumbnails(root);
        MediaAssetSummary renamedAsset = store
            .GetAssets(includeUnavailable: true)
            .Single(asset => asset.AssetId == curated.AssetId);
        CatalogueItemSummary item = store.GetCatalogue().Items.Single();

        Assert.AreEqual(0, second.NewAssets);
        Assert.AreEqual("anything.webp", renamedAsset.FileName);
        Assert.AreEqual(itemId, renamedAsset.BoundItemId);
        Assert.AreEqual(curated.AssetId, item.ThumbnailAssetId);
        Assert.AreEqual("bound", item.ThumbnailStatus);

        File.Delete(renamed);
        ThumbnailScanSummary third = store.ScanThumbnails(root);
        Assert.AreEqual(1, third.UnavailableAssets);
        Assert.IsFalse(
            store.GetAssets(includeUnavailable: true).Single(asset => asset.AssetId == curated.AssetId).Available
        );
        Assert.AreEqual("missing", store.GetCatalogue().Items.Single().ThumbnailStatus);
    }

    [TestMethod]
    public void ScanRejectsUnsafeRootsEscapesAndFileLimitWithoutPartialChanges()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(root, "one.png"), [1]);
        File.WriteAllBytes(Path.Combine(root, "two.jpg"), [2]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        CatalogueInventoryException limit = Assert.ThrowsException<CatalogueInventoryException>(
            () => store.ScanThumbnails(root, maximumFiles: 1)
        );
        Assert.AreEqual("too-many-thumbnails", limit.Code);
        Assert.AreEqual(0, store.GetAssets(includeUnavailable: true).Count);

        Assert.IsFalse(ThumbnailInventory.IsContainedPath(root, Path.Combine(temp.Path, "outside.png")));
        Assert.ThrowsException<CatalogueInventoryException>(() => store.ScanThumbnails(Path.Combine(root, "one.png")));
    }

    [TestMethod]
    public void ChangingConfiguredRootMakesPreviousRootAssetsUnavailable()
    {
        using TestDirectory temp = new();
        string firstRoot = Directory.CreateDirectory(Path.Combine(temp.Path, "first")).FullName;
        string secondRoot = Directory.CreateDirectory(Path.Combine(temp.Path, "second")).FullName;
        File.WriteAllBytes(Path.Combine(firstRoot, "first.png"), [1]);
        File.WriteAllBytes(Path.Combine(secondRoot, "second.png"), [2]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        store.ScanThumbnails(firstRoot);
        string firstAssetId = store.GetAssets().Single().AssetId;
        ThumbnailScanSummary second = store.ScanThumbnails(secondRoot);

        IReadOnlyList<MediaAssetSummary> assets = store.GetAssets(includeUnavailable: true);
        Assert.AreEqual(1, second.AvailableAssets);
        Assert.AreEqual(1, second.UnavailableAssets);
        Assert.IsFalse(assets.Single(asset => asset.AssetId == firstAssetId).Available);
        Assert.IsNull(store.ResolveAvailableAssetLocation(firstAssetId));
        Assert.AreEqual(secondRoot, store.ConfiguredThumbnailRoot);
    }

    [TestMethod]
    public void ScanRejectsAQueuedDirectoryThatIsReplacedByAnOutsideLink()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        string queued = Directory.CreateDirectory(Path.Combine(root, "queued")).FullName;
        string moved = Path.Combine(root, "moved");
        string outside = Directory.CreateDirectory(Path.Combine(temp.Path, "outside")).FullName;
        File.WriteAllBytes(Path.Combine(queued, "cover.png"), [1, 2, 3]);
        File.WriteAllBytes(Path.Combine(outside, "cover.png"), [9, 8, 7]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        CatalogueInventoryException exception = Assert.ThrowsException<CatalogueInventoryException>(
            () =>
                store.ScanThumbnails(
                    root,
                    ThumbnailInventory.DefaultMaximumFiles,
                    path =>
                    {
                        if (!path.EndsWith("cover.png", StringComparison.OrdinalIgnoreCase))
                            return;
                        Directory.Move(queued, moved);
                        CreateJunction(queued, outside);
                    }
                )
        );

        Assert.AreEqual("thumbnail-path-escape", exception.Code, exception.ToString());
        Assert.AreEqual(0, store.GetAssets(includeUnavailable: true).Count);
        Directory.Delete(queued);
    }

    [TestMethod]
    public void ScanRejectsAJunctionAsTheSelectedRoot()
    {
        using TestDirectory temp = new();
        string target = Directory.CreateDirectory(Path.Combine(temp.Path, "target")).FullName;
        string junction = Path.Combine(temp.Path, "junction");
        File.WriteAllBytes(Path.Combine(target, "cover.png"), [1, 2, 3]);
        CreateJunction(junction, target);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        CatalogueInventoryException exception = Assert.ThrowsException<CatalogueInventoryException>(
            () => store.ScanThumbnails(junction)
        );

        Assert.AreEqual("unsafe-thumbnail-root", exception.Code);
        Assert.AreEqual(0, store.GetAssets(includeUnavailable: true).Count);
        Directory.Delete(junction);
    }

    private static void CreateJunction(string link, string target)
    {
        using Process process = Process.Start(
            new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/d /c mklink /J \"{link}\" \"{target}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        process.WaitForExit();
        Assert.AreEqual(0, process.ExitCode, process.StandardError.ReadToEnd());
    }

    private static string Snapshot(string sourceKey, string title) =>
        """
        {"version":1,"items":[{"sourceKey":"$SOURCE$","sourceRow":12,"title":"$TITLE$","description":"","plannedDate":"2026-09-11","series":"Ashley","episode":"04","xTeasers":0,"redditTeasers":0,"platformLinks":{}}]}
        """
            .Replace("$SOURCE$", sourceKey, StringComparison.Ordinal)
            .Replace("$TITLE$", title, StringComparison.Ordinal);

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-thumbs-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
