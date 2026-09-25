using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class UploadThumbnailCatalogueTests
{
    [TestMethod]
    public void NamedVariantsStayWithinTheirCatalogueItemAndConvertForUpload()
    {
        string temporary = Path.Combine(Path.GetTempPath(), $"ofenhancer-upload-thumbs-{Guid.NewGuid():N}");
        string root = Path.Combine(temporary, "thumbs");
        Directory.CreateDirectory(root);
        try
        {
            using (Bitmap image = new(800, 800))
            {
                using Graphics drawing = Graphics.FromImage(image);
                drawing.Clear(Color.Blue);
                image.Save(Path.Combine(root, "episode-one_v01.png"), ImageFormat.Png);
                drawing.Clear(Color.Red);
                image.Save(Path.Combine(root, "episode-two.png"), ImageFormat.Png);
                drawing.Clear(Color.Green);
                image.Save(Path.Combine(root, "Renamed Episode Cover.png"), ImageFormat.Png);
            }
            using CatalogueStore store = CatalogueStore.Open(Path.Combine(temporary, "catalogue.db"));
            store.ImportSnapshot(JsonSerializer.Serialize(new
            {
                version = 1,
                items = new[] { "episode-one", "episode-two" }.Select((key, index) => new
                {
                    sourceKey = key, sourceRow = index + 2, title = key, description = "Test clip",
                    plannedDate = "2026-09-25", series = "Test", episode = "01",
                    xTeasers = 0, redditTeasers = 0, platformLinks = new Dictionary<string, string>(),
                }),
            }));
            store.ScanThumbnails(root);
            store.ConfirmAssetBinding(
                store.GetAssets().Single(asset => asset.FileName == "Renamed Episode Cover.png").AssetId,
                store.GetItems().Single(item => item.SourceKey == "episode-one").ItemId);
            UploadThumbnailCatalogue catalogue = new(store);
            JsonElement listed = JsonSerializer.SerializeToElement(catalogue.List(JsonSerializer.SerializeToElement(new
            {
                catalogueId = "episode-one",
            })));
            Assert.IsTrue(listed.GetProperty("choices").EnumerateArray().Any(asset =>
                asset.GetProperty("name").GetString() == "Renamed Episode Cover.png"));
            JsonElement choice = listed.GetProperty("choices").EnumerateArray().Single(asset =>
                asset.GetProperty("name").GetString() == "episode-one_v01.png");
            Assert.AreEqual("episode-one_v01.png", choice.GetProperty("name").GetString());
            string assetId = choice.GetProperty("assetId").GetString()!;
            JsonElement request = JsonSerializer.SerializeToElement(new
            {
                catalogueId = "episode-one", assetId,
                name = choice.GetProperty("name").GetString(),
                size = choice.GetProperty("size").GetInt64(),
                lastModified = choice.GetProperty("lastModified").GetInt64(),
            });
            JsonElement preview = JsonSerializer.SerializeToElement(catalogue.Preview(request));
            StringAssert.StartsWith(preview.GetProperty("dataUrl").GetString()!, "data:image/jpeg;base64,");
            JsonElement cataloguePreview = JsonSerializer.SerializeToElement(catalogue.CataloguePreviews(
                JsonSerializer.SerializeToElement(new { catalogueIds = new[] { "episode-one", "episode-two" } })));
            StringAssert.StartsWith(cataloguePreview.GetProperty("previews").GetProperty("episode-one").GetString()!, "data:image/jpeg;base64,");
            StringAssert.StartsWith(cataloguePreview.GetProperty("previews").GetProperty("episode-two").GetString()!, "data:image/jpeg;base64,");
            FileInfo converted = catalogue.ConvertSelected(request);
            try
            {
                using Image result = Image.FromFile(converted.FullName);
                Assert.AreEqual(640, result.Width);
                Assert.AreEqual(360, result.Height);
            }
            finally { UploadThumbnailConverter.Delete(converted); }
            Assert.ThrowsException<InvalidOperationException>(() => catalogue.Preview(
                JsonSerializer.SerializeToElement(new { catalogueId = "episode-two", assetId })));
        }
        finally { Directory.Delete(temporary, recursive: true); }
    }
}
