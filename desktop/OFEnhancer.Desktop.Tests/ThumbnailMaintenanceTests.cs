using System.Drawing;
using System.Drawing.Imaging;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class ThumbnailMaintenanceTests
{
    [TestMethod]
    public async Task SavedPlatformFallbackDecodesCoverAndRejectsRedirectToUnapprovedHost()
    {
        using Bitmap bitmap = new(64, 64);
        using MemoryStream image = new(); bitmap.Save(image, ImageFormat.Png);
        var visited = new List<string>();
        using var client = new HttpClient(new Handler(request =>
        {
            visited.Add(request.RequestUri!.Host);
            if (request.RequestUri.Host == "www.manyvids.com") return new(HttpStatusCode.NotFound);
            if (request.RequestUri.Host == "www.pornhub.com") return new(HttpStatusCode.OK)
            { Content = new StringContent("<meta content='https://di.phncdn.com/cover.png?a=1&amp;b=2' property='og:image'>") };
            var content = new ByteArrayContent(image.ToArray()); content.Headers.ContentType = new("image/png");
            return new(HttpStatusCode.OK) { Content = content };
        }));
        var item = new CatalogueItemSummary(Guid.NewGuid().ToString(), "test", 2, "Test", "", null, null, null, 0, 0,
            new Dictionary<string, string> { ["manyvids"] = "https://www.manyvids.com/video/1", ["pornhubFree"] = "https://www.pornhub.com/view_video.php?viewkey=test" }, false);
        byte[]? recovered = await new ThumbnailPosterRecovery(client).Recover(item);
        Assert.IsNotNull(recovered);
        CollectionAssert.AreEqual(new[] { "www.manyvids.com", "www.pornhub.com", "di.phncdn.com" }, visited);
        Assert.ThrowsException<InvalidDataException>(() => ThumbnailPosterRecovery.Validate("https://di.phncdn.com.evil.test/cover", true));
        Assert.ThrowsException<InvalidDataException>(() => ThumbnailPosterRecovery.Validate("http://di.phncdn.com/cover", true));
        int calls = 0;
        using var redirectClient = new HttpClient(new Handler(_ =>
        {
            calls++; var response = new HttpResponseMessage(HttpStatusCode.Found);
            response.Headers.Location = new Uri("https://127.0.0.1/secret"); return response;
        }));
        Assert.IsNull(await new ThumbnailPosterRecovery(redirectClient).Recover(item));
        Assert.AreEqual(2, calls); // Only the two saved, approved page URLs were contacted.
    }

    [TestMethod]
    public async Task ConsolidationPromotesOnlyCopyPreservesMainAndRebindsDeletedVariants()
    {
        string temp = Path.Combine(Path.GetTempPath(), "ofenhancer-thumbnails-" + Guid.NewGuid().ToString("N"));
        string root = Path.Combine(temp, "destination"), old = Path.Combine(temp, "old");
        Directory.CreateDirectory(root); Directory.CreateDirectory(old);
        try
        {
            File.WriteAllBytes(Path.Combine(old, "first_4K.png"), [1, 2, 3]);
            File.WriteAllBytes(Path.Combine(old, "first-copy.png"), [1, 2, 3]);
            File.WriteAllBytes(Path.Combine(root, "second.png"), [4, 5, 6]);
            File.WriteAllBytes(Path.Combine(root, "second_33.png"), [7, 8, 9]);
            string database = Path.Combine(temp, "catalogue.db");
            using (var store = CatalogueStore.Open(database))
            {
                store.ImportSnapshot(JsonSerializer.Serialize(new { version = 1, items = new[] { "first", "second" }.Select((key, index) => new
                { sourceKey = key, sourceRow = index + 2, title = key, description = "Test", plannedDate = "2026-09-25", series = "Test", episode = "1", xTeasers = 0, redditTeasers = 0, platformLinks = new Dictionary<string, string>() }) }));
                store.ScanThumbnails(old);
                store.ConfirmAssetBinding(store.GetAssets().Single().AssetId, store.GetItems().Single(i => i.SourceKey == "first").ItemId);
            }
            string report = Path.Combine(temp, "result.json");
            await ThumbnailMaintenance.Run(database, root, [root, old], report, true, true);
            CollectionAssert.AreEqual(new byte[] { 1, 2, 3 }, File.ReadAllBytes(Path.Combine(root, "first.png")));
            CollectionAssert.AreEqual(new byte[] { 4, 5, 6 }, File.ReadAllBytes(Path.Combine(root, "second.png")));
            Assert.IsFalse(File.Exists(Path.Combine(root, "second_33.png")));
            Assert.AreEqual(2, Directory.GetFiles(root).Length);
            Assert.AreEqual(0, Directory.GetFiles(old).Length);
            Assert.IsTrue(Directory.Exists(report + ".backup"));
            using var verify = CatalogueStore.Open(database);
            Assert.AreEqual(2, verify.GetCatalogue().Items.Count(i => i.ThumbnailAssetId is not null));
            Assert.AreEqual(1, verify.GetAssets().Count(a => a.BoundItemId is not null));
        }
        finally { Directory.Delete(temp, true); }
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(respond(request));
    }
}
