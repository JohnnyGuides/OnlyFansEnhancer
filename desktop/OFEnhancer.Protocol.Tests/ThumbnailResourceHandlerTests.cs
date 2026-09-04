using Microsoft.Data.Sqlite;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class ThumbnailResourceHandlerTests
{
    [TestMethod]
    public void WebMessagesAreAcceptedOnlyFromThePackagedAppOrigin()
    {
        Assert.IsTrue(WebMessageSourcePolicy.IsTrusted("https://app.ofenhancer.local/index.html"));
        Assert.IsTrue(WebMessageSourcePolicy.IsTrusted("https://app.ofenhancer.local/catalogue"));
        Assert.IsFalse(WebMessageSourcePolicy.IsTrusted("http://app.ofenhancer.local/index.html"));
        Assert.IsFalse(WebMessageSourcePolicy.IsTrusted("https://app.ofenhancer.local:444/index.html"));
        Assert.IsFalse(WebMessageSourcePolicy.IsTrusted("https://app.ofenhancer.local.example/index.html"));
        Assert.IsFalse(WebMessageSourcePolicy.IsTrusted("https://user@app.ofenhancer.local/index.html"));
        Assert.IsFalse(WebMessageSourcePolicy.IsTrusted("not a URI"));
    }

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

        using (
            ThumbnailResource? known = resolver.Open(
                new Uri($"https://thumbs.ofenhancer.local/{assetId}")
            )
        )
        {
            Assert.IsNotNull(known);
            Assert.AreEqual("image/png", known.ContentType);
            CollectionAssert.AreEqual(
                new byte[] { 0x89, 0x50, 0x4e, 0x47 },
                ReadAll(known.Stream)
            );
        }
        Assert.IsNull(resolver.Open(new Uri("https://thumbs.ofenhancer.local/../settings.json")));
        Assert.IsNull(resolver.Open(new Uri($"https://other.invalid/{assetId}")));
        Assert.IsNull(resolver.Open(new Uri($"https://thumbs.ofenhancer.local/{Guid.NewGuid():D}")));

        string outside = Path.Combine(temp.Path, "outside.png");
        File.WriteAllBytes(outside, [1, 2, 3]);
        using (SqliteCommand command = store.Connection.CreateCommand())
        {
            command.CommandText = "UPDATE media_assets SET absolute_path = $outside WHERE asset_id = $assetId";
            command.Parameters.AddWithValue("$outside", outside);
            command.Parameters.AddWithValue("$assetId", assetId);
            command.ExecuteNonQuery();
        }
        Assert.IsNull(resolver.Open(new Uri($"https://thumbs.ofenhancer.local/{assetId}")));

        using SqliteCommand restore = store.Connection.CreateCommand();
        restore.CommandText = "UPDATE media_assets SET absolute_path = $image WHERE asset_id = $assetId";
        restore.Parameters.AddWithValue("$image", image);
        restore.Parameters.AddWithValue("$assetId", assetId);
        restore.ExecuteNonQuery();
        File.WriteAllBytes(image, [1, 2, 3, 4]);
        Assert.IsNull(
            resolver.Open(new Uri($"https://thumbs.ofenhancer.local/{assetId}")),
            "changed bytes must be rescanned before the opaque resource can serve them"
        );
    }

    private static byte[] ReadAll(Stream stream)
    {
        using MemoryStream copy = new();
        stream.CopyTo(copy);
        return copy.ToArray();
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
