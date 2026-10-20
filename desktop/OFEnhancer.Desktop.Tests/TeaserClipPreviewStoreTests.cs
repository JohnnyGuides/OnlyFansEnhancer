using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class TeaserClipPreviewStoreTests
{
    [TestMethod]
    public async Task ActualPosterIsCachedAndMutedPlaybackIsCreatedOnlyOnDemand()
    {
        using Fixture fixture = new();
        string ffmpeg = Tool("ffmpeg.exe"), ffprobe = Tool("ffprobe.exe");
        Run(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=440", "-t", "8", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-c:a", "aac", fixture.Source);
        XTeaserLibraryClip clip = fixture.Index();
        TeaserClipPreviewStore store = new(fixture.Cache);
        TeaserClipPreview poster = await store.PrepareAsync(fixture.Root, clip, false);
        Assert.IsNull(poster.VideoUrl);
        Assert.IsTrue(poster.Duration is > 7.8 and < 8.2);
        Assert.IsFalse(Directory.EnumerateFiles(fixture.Cache, "*.mp4", SearchOption.AllDirectories).Any());
        var image = store.Open(new Uri(poster.PosterUrl));
        Assert.IsNotNull(image);
        using (image.Stream)
        {
            Assert.AreEqual("image/jpeg", image.ContentType);
            Assert.IsTrue(image.Length is > 100 and < 256 * 1024);
            Assert.AreEqual(0xff, image.Stream.ReadByte());
            Assert.AreEqual(0xd8, image.Stream.ReadByte());
        }
        string posterPath = Directory.EnumerateFiles(fixture.Cache, "poster.jpg", SearchOption.AllDirectories).Single();
        DateTime modified = File.GetLastWriteTimeUtc(posterPath);
        TeaserClipPreview playback = await store.PrepareAsync(fixture.Root, clip, true);
        Assert.AreEqual(poster.PosterUrl, playback.PosterUrl);
        Assert.AreEqual(modified, File.GetLastWriteTimeUtc(posterPath), "Poster should not be regenerated on hover.");
        Assert.IsNotNull(playback.VideoUrl);
        var resource = store.Open(new Uri(playback.VideoUrl));
        Assert.IsNotNull(resource);
        using (resource.Stream) Assert.IsTrue(resource.Length is > 0 and < 4 * 1024 * 1024);
        string video = Directory.EnumerateFiles(fixture.Cache, "preview.mp4", SearchOption.AllDirectories).Single();
        using JsonDocument probe = JsonDocument.Parse(Run(ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", video));
        Assert.IsTrue(double.Parse(probe.RootElement.GetProperty("format").GetProperty("duration").GetString()!, CultureInfo.InvariantCulture) <= 6.1);
        JsonElement[] streams = probe.RootElement.GetProperty("streams").EnumerateArray().ToArray();
        Assert.AreEqual(1, streams.Length);
        Assert.AreEqual("video", streams[0].GetProperty("codec_type").GetString());
        Assert.IsTrue(streams[0].GetProperty("width").GetInt32() <= 320 && streams[0].GetProperty("height").GetInt32() <= 320);
        foreach (string url in new[] { playback.VideoUrl + "?path=x", playback.VideoUrl.Replace("https:", "http:"), "https://teaser-preview.ofenhancer.local/unknown/preview.mp4" })
            Assert.IsNull(store.Open(new Uri(url)));
        File.AppendAllText(fixture.Source, "changed");
        Assert.AreEqual("teaser-clip-changed", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => store.PrepareAsync(fixture.Root, clip, true))).Code);
    }

    [TestMethod]
    public async Task ChangedSameSizeSourceIsRejectedBeforeTrustingAnIndexedHash()
    {
        using Fixture fixture = new();
        File.WriteAllBytes(fixture.Source, [1, 2, 3, 4]);
        XTeaserLibraryClip clip = fixture.Index();
        DateTime timestamp = File.GetLastWriteTimeUtc(fixture.Source);
        File.WriteAllBytes(fixture.Source, [4, 3, 2, 1]);
        File.SetLastWriteTimeUtc(fixture.Source, timestamp);
        Assert.AreEqual("teaser-clip-changed", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => new TeaserClipPreviewStore(fixture.Cache).PrepareAsync(fixture.Root, clip, false))).Code);
        Assert.IsFalse(Directory.Exists(fixture.Cache));
    }

    [TestMethod]
    public async Task BridgeRejectsArbitraryPathsAndMalformedRequests()
    {
        using Fixture fixture = new();
        using CatalogueStore catalogue = CatalogueStore.Open(Path.Combine(fixture.Root, "catalogue.db"));
        using XTeaserController controller = new(catalogue, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty);
        foreach (string json in new[] { "{}", "[]", "{\"clipId\":\"1\"}", "{\"clipId\":1,\"path\":\"x.mp4\"}", "{\"clipId\":1,\"playback\":null}" })
        {
            using JsonDocument request = JsonDocument.Parse(json);
            Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
                () => controller.HandleAsync("getTeaserClipPreview", request.RootElement))).Code);
        }
    }

    private static string Tool(string name)
    {
        string bundled = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JohnnyTools", "ffmpeg", "bin", name);
        string? tool = File.Exists(bundled) ? bundled : (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Select(folder => Path.Combine(folder, name)).FirstOrDefault(File.Exists);
        if (tool is null) Assert.Inconclusive("FFmpeg is unavailable on this test machine.");
        return tool!;
    }

    private static string Run(string exe, params string[] arguments)
    {
        ProcessStartInfo info = new(exe) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in arguments) info.ArgumentList.Add(argument);
        using Process process = Process.Start(info)!;
        Task<string> output = process.StandardOutput.ReadToEndAsync(), error = process.StandardError.ReadToEndAsync();
        Assert.IsTrue(process.WaitForExit(30000), "Fixture media generation timed out.");
        Assert.AreEqual(0, process.ExitCode, error.GetAwaiter().GetResult());
        return output.GetAwaiter().GetResult();
    }

    private sealed class Fixture : IDisposable
    {
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), "ofenhancer-preview-test-" + Guid.NewGuid().ToString("N"));
        internal string Source => Path.Combine(Root, "ep-a__t1.mp4");
        internal string Cache => Path.Combine(Root, "cache");
        internal Fixture() => Directory.CreateDirectory(Root);
        internal XTeaserLibraryClip Index()
        {
            FileInfo file = new(Source);
            return new(1, file.Name, "ep-a", "Ready", file.Length, XTeaserFolder.MtimeText(file.LastWriteTimeUtc),
                Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Source))).ToLowerInvariant());
        }
        public void Dispose() => Directory.Delete(Root, recursive: true);
    }
}
