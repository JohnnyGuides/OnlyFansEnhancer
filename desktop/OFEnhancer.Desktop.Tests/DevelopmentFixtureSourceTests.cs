using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class DevelopmentFixtureSourceTests
{
    private static void Media(string root)
    {
        Directory.CreateDirectory(root);
        File.WriteAllBytes(Path.Combine(root, "neutral-full.mp4"), [0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 0, 0, 0, 0]);
        File.Copy(Path.Combine(root, "neutral-full.mp4"), Path.Combine(root, "neutral-teaser.mp4"));
        File.WriteAllBytes(Path.Combine(root, "neutral-thumbnail-valid.png"), [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    }

    [TestMethod]
    public void FixedFilesBecomeOpaqueCapabilitiesWithoutReadingMultiGigabyteContents()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-fixtures-" + Guid.NewGuid());
        try
        {
            Media(root);
            using (var file = File.OpenWrite(Path.Combine(root, "neutral-full.mp4"))) file.SetLength(3_429_630_660);
            var source = new DevelopmentFixtureSource(root);
            long allocated = GC.GetAllocatedBytesForCurrentThread();
            var files = source.Load();
            Assert.IsTrue(GC.GetAllocatedBytesForCurrentThread() - allocated < 1_000_000, "Only bounded file headers and descriptors may enter memory.");
            Assert.AreEqual(3, files.Length);
            Assert.AreEqual(3_429_630_660L, files[0].Size);
            Assert.AreEqual("neutral-full.mp4", files[0].Name);
            Assert.AreEqual("neutral-teaser.mp4", files[1].Name);
            Assert.AreEqual("neutral-thumbnail-valid.png", files[2].Name);
            string serialized = JsonSerializer.Serialize(files);
            Assert.IsFalse(serialized.Contains(root.Replace("\\", "\\\\")), "Absolute paths must stay out of UI descriptors.");
            Assert.AreEqual(Path.Combine(root, files[0].Name), source.Resolve(files[0].FixtureToken).FullName);
            Assert.ThrowsException<InvalidOperationException>(() => source.Resolve("../../other.mp4"));
            File.SetLastWriteTimeUtc(Path.Combine(root, files[0].Name), DateTime.UtcNow.AddMinutes(1));
            Assert.ThrowsException<InvalidOperationException>(() => source.Resolve(files[0].FixtureToken));
        }
        finally { Directory.Delete(root, true); }
    }

    [TestMethod]
    public void MissingEmptyAndWrongTypeFixturesFailTogetherWithoutPartialCapabilities()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-fixtures-" + Guid.NewGuid());
        try
        {
            var source = new DevelopmentFixtureSource(root);
            Assert.ThrowsException<InvalidOperationException>(() => source.Load());
            Media(root);
            File.WriteAllText(Path.Combine(root, "neutral-teaser.mp4"), "not a video");
            Assert.ThrowsException<InvalidOperationException>(() => source.Load());
            File.WriteAllBytes(Path.Combine(root, "neutral-teaser.mp4"), []);
            Assert.ThrowsException<InvalidOperationException>(() => source.Load());
        }
        finally { Directory.Delete(root, true); }
    }
}
