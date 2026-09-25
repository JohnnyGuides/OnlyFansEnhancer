using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GeneratedUploadMediaStoreTests
{
    [TestMethod]
    public void StagesOnlyBoundSequentialMediaWithVerifiedHash()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofenhancer-generated-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            GeneratedUploadMediaStore store = new(root);
            byte[] bytes = Encoding.UTF8.GetBytes("neutral generated preview bytes");
            string hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            string session = new('a', 48);
            long modified = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            JsonElement Chunk(long offset, byte[] part, bool final, string? digest = null) =>
                JsonSerializer.SerializeToElement(new {
                    sessionId = session, role = "teaser", name = "neutral (teaser).mp4", size = bytes.Length,
                    lastModified = modified, sha256 = digest ?? hash, offset, final,
                    chunk = Convert.ToBase64String(part),
                });
            Assert.IsNull(store.Append(Chunk(0, bytes[..10], false)));
            Assert.ThrowsException<InvalidOperationException>(() => store.Append(Chunk(15, bytes[10..], true)));
            FileInfo result = store.Append(Chunk(10, bytes[10..], true))!;
            CollectionAssert.AreEqual(bytes, File.ReadAllBytes(result.FullName));
            FileInfo resolved = store.Resolve(JsonSerializer.SerializeToElement(new {
                sessionId = session, role = "teaser", name = result.Name, size = result.Length,
                lastModified = modified,
            }));
            Assert.AreEqual(result.FullName, resolved.FullName);
            Assert.ThrowsException<InvalidOperationException>(() => store.Resolve(JsonSerializer.SerializeToElement(new {
                sessionId = new string('b', 48), role = "teaser", name = result.Name, size = result.Length,
                lastModified = modified,
            })));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [TestMethod]
    public void RejectsPathNamesAndCorruptBytesBeforeDelivery()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofenhancer-generated-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            GeneratedUploadMediaStore store = new(root);
            JsonElement Payload(string name, string hash) => JsonSerializer.SerializeToElement(new {
                sessionId = new string('b', 48), role = "thumbnail", name, size = 3,
                lastModified = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), sha256 = hash,
                offset = 0, final = true, chunk = Convert.ToBase64String([1, 2, 3]),
            });
            string falseHash = new('0', 64);
            Assert.ThrowsException<InvalidOperationException>(() => store.Append(Payload("../escape.png", falseHash)));
            Assert.ThrowsException<InvalidOperationException>(() => store.Append(Payload("frame.png", falseHash)));
            Assert.IsFalse(File.Exists(Path.Combine(root, new string('b', 48), "frame.png")));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
