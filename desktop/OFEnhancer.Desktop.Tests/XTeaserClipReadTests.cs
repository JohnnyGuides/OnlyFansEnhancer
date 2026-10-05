using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class XTeaserClipReadTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);

    [TestMethod]
    public async Task IndexedClipReadsBackAsSequentialVerifiedChunks()
    {
        byte[] expected = Enumerable.Range(0, 256 * 1024 + 37).Select(value => (byte)(value % 251)).ToArray();
        using ClipFixture fixture = await ClipFixture.Create(expected);
        JsonElement library = await fixture.Library();
        JsonElement clip = library.GetProperty("clips").EnumerateArray().Single();
        Assert.AreEqual("ep-a__t1.mp4", clip.GetProperty("name").GetString());
        Assert.AreEqual(expected.LongLength, clip.GetProperty("size").GetInt64());
        Assert.AreEqual(Convert.ToHexString(SHA256.HashData(expected)).ToLowerInvariant(), clip.GetProperty("Sha256").GetString());
        Assert.IsFalse(library.GetRawText().Contains(fixture.Root, StringComparison.OrdinalIgnoreCase));

        using MemoryStream received = new();
        string token = "";
        long offset = 0;
        bool done;
        do
        {
            using JsonDocument chunk = await fixture.Chunk(new
            {
                clipId = clip.GetProperty("ClipId").GetInt64(),
                token,
                offset,
            });
            JsonElement value = chunk.RootElement;
            token = value.GetProperty("token").GetString()!;
            Assert.IsFalse(string.IsNullOrWhiteSpace(token));
            Assert.AreEqual(offset, value.GetProperty("offset").GetInt64());
            byte[] bytes = Convert.FromBase64String(value.GetProperty("chunk").GetString()!);
            Assert.IsTrue(bytes.Length is > 0 and <= 256 * 1024);
            received.Write(bytes);
            offset += bytes.LongLength;
            done = value.GetProperty("done").GetBoolean();
            Assert.AreEqual(expected.LongLength, value.GetProperty("size").GetInt64());
            Assert.AreEqual("ep-a__t1.mp4", value.GetProperty("name").GetString());
            Assert.AreEqual(clip.GetProperty("Sha256").GetString(), value.GetProperty("sha256").GetString());
        } while (!done);

        CollectionAssert.AreEqual(expected, received.ToArray());
        Assert.AreEqual(expected.LongLength, offset);
    }

    [TestMethod]
    public async Task ClipReadRejectsSourceChangedSinceItsIndex()
    {
        byte[] original = Enumerable.Range(0, 4096).Select(value => (byte)value).ToArray();
        using ClipFixture fixture = await ClipFixture.Create(original);
        JsonElement clip = (await fixture.Library()).GetProperty("clips").EnumerateArray().Single();
        string source = Path.Combine(fixture.Root, "ep-a__t1.mp4");
        DateTime originalMtime = File.GetLastWriteTimeUtc(source);
        byte[] changed = original.ToArray();
        changed[120] ^= 0x7f;
        File.WriteAllBytes(source, changed);
        File.SetLastWriteTimeUtc(source, originalMtime);

        Assert.AreEqual("teaser-clip-changed", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId = clip.GetProperty("ClipId").GetInt64(), token = "", offset = 0L }))).Code);
    }

    [TestMethod]
    public async Task ClipReadRejectsChangedLengthSinceItsIndex()
    {
        using ClipFixture fixture = await ClipFixture.Create([1, 2, 3, 4]);
        JsonElement clip = (await fixture.Library()).GetProperty("clips").EnumerateArray().Single();
        File.WriteAllBytes(Path.Combine(fixture.Root, "ep-a__t1.mp4"), [1, 2, 3, 4, 5]);

        Assert.AreEqual("teaser-clip-changed", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId = clip.GetProperty("ClipId").GetInt64(), token = "", offset = 0L }))).Code);
    }

    [TestMethod]
    public async Task ClipReadRejectsInvalidPathTokenOffsetAndUnindexedClipRequests()
    {
        using ClipFixture fixture = await ClipFixture.Create(Enumerable.Repeat((byte)9, 1024).ToArray());
        JsonElement clip = (await fixture.Library()).GetProperty("clips").EnumerateArray().Single();
        long clipId = clip.GetProperty("ClipId").GetInt64();

        Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId, token = "", offset = 0L, path = Path.Combine(fixture.Root, "ep-a__t1.mp4") }))).Code);
        Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId, token = "", offset = -1L }))).Code);
        Assert.AreEqual("teaser-clip-not-found", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId = clipId + 100, token = "", offset = 0L }))).Code);
        Assert.AreEqual("teaser-read-expired", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId, token = "not-a-read-token", offset = 0L }))).Code);

        using JsonDocument first = await fixture.Chunk(new { clipId, token = "", offset = 0L });
        string token = first.RootElement.GetProperty("token").GetString()!;
        Assert.AreEqual("teaser-read-expired", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId, token, offset = 1L }))).Code);
        Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(
            () => fixture.Chunk(new { clipId, token, offset = -1L }))).Code);
    }

    [TestMethod]
    public void SocialRoleCanStageAndResolveGeneratedVideoMedia()
    {
        using TestDirectory temp = new();
        GeneratedUploadMediaStore store = new(Path.Combine(temp.Path, "cache"));
        byte[] bytes = [3, 1, 4, 1, 5, 9];
        string hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        string session = new('a', 48);
        long modified = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        JsonElement payload = JsonSerializer.SerializeToElement(new
        {
            sessionId = session,
            role = "social",
            name = "social-teaser.mp4",
            size = bytes.Length,
            lastModified = modified,
            sha256 = hash,
            offset = 0,
            final = true,
            chunk = Convert.ToBase64String(bytes),
        });

        FileInfo staged = store.Append(payload)!;
        CollectionAssert.AreEqual(bytes, File.ReadAllBytes(staged.FullName));
        FileInfo resolved = store.Resolve(JsonSerializer.SerializeToElement(new
        {
            sessionId = session,
            role = "social",
            name = "social-teaser.mp4",
            size = bytes.Length,
            lastModified = modified,
        }));
        Assert.AreEqual(staged.FullName, resolved.FullName);
    }

    private sealed class ClipFixture : IDisposable
    {
        private readonly TestDirectory temp;
        private readonly CatalogueStore store;
        private readonly XTeaserController controller;

        private ClipFixture(TestDirectory temp, CatalogueStore store, XTeaserController controller, string root)
        {
            this.temp = temp;
            this.store = store;
            this.controller = controller;
            Root = root;
        }

        internal string Root { get; }

        internal static async Task<ClipFixture> Create(byte[] bytes)
        {
            TestDirectory temp = new();
            string root = Path.Combine(temp.Path, "TWEETS");
            Directory.CreateDirectory(root);
            File.WriteAllBytes(Path.Combine(root, "ep-a__t1.mp4"), bytes);
            CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            DesktopSettings settings = DesktopSettings.Empty with { XTeaserRoot = root };
            XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => settings, () => Now);
            try
            {
                XTeaserRunResult run = await controller.RunOnceAsync();
                Assert.IsTrue(run.Active);
                Assert.AreEqual(1, run.Scan!.Present);
                return new(temp, store, controller, root);
            }
            catch
            {
                controller.Dispose();
                store.Dispose();
                temp.Dispose();
                throw;
            }
        }

        internal async Task<JsonElement> Library()
        {
            using JsonDocument result = JsonDocument.Parse(JsonSerializer.Serialize(
                await controller.HandleAsync("getTeaserClips", Json("{}"))));
            return result.RootElement.Clone();
        }

        internal async Task<JsonDocument> Chunk<T>(T payload)
        {
            using JsonDocument request = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            object result = await controller.HandleAsync("getTeaserClipChunk", request.RootElement);
            return JsonDocument.Parse(JsonSerializer.Serialize(result));
        }

        public void Dispose()
        {
            controller.Dispose();
            store.Dispose();
            temp.Dispose();
        }
    }

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    private sealed class TestDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xclip-{Guid.NewGuid():N}");

        internal TestDirectory() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
        }
    }
}
