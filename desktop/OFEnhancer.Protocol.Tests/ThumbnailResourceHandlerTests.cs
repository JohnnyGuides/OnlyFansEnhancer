using Microsoft.Data.Sqlite;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class ThumbnailResourceHandlerTests
{
    [TestMethod]
    public void ResolverServesOnlyKnownAvailableAssetsInsideTheirScanRoot()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        string image = Path.Combine(root, "safe.png");
        File.WriteAllBytes(image, [0x89, 0x50, 0x4e, 0x47]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ScanThumbnails(root);
        string assetId = store.GetAssets().Single().AssetId;
        ThumbnailResourceResolver resolver = new(store);

        ThumbnailResource? known = resolver.Resolve(new Uri($"https://thumbs.ofenhancer.local/{assetId}"));

        Assert.IsNotNull(known);
        Assert.AreEqual(image, known.Path);
        Assert.AreEqual("image/png", known.ContentType);
        Assert.IsNull(resolver.Resolve(new Uri("https://thumbs.ofenhancer.local/../settings.json")));
        Assert.IsNull(resolver.Resolve(new Uri($"https://other.invalid/{assetId}")));
        Assert.IsNull(resolver.Resolve(new Uri($"https://thumbs.ofenhancer.local/{Guid.NewGuid():D}")));

        string outside = Path.Combine(temp.Path, "outside.png");
        File.WriteAllBytes(outside, [1, 2, 3]);
        using (SqliteCommand command = store.Connection.CreateCommand())
        {
            command.CommandText = "UPDATE media_assets SET absolute_path = $outside WHERE asset_id = $assetId";
            command.Parameters.AddWithValue("$outside", outside);
            command.Parameters.AddWithValue("$assetId", assetId);
            command.ExecuteNonQuery();
        }
        Assert.IsNull(resolver.Resolve(new Uri($"https://thumbs.ofenhancer.local/{assetId}")));
    }

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-resource-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
