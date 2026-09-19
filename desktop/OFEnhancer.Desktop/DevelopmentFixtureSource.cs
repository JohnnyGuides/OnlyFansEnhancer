using System.IO;

namespace OFEnhancer.Desktop;

internal sealed record DevelopmentFixtureFile(string Source, string FixtureToken, string Name, long Size, string Type, long LastModified);

// Personal desktop only. Neither a browser message nor an environment variable
// can choose a root/path. Large media stays on disk; descriptors are capabilities.
internal sealed class DevelopmentFixtureSource
{
    internal const string FixtureRoot = @"F:\WORK\Creations\OFEnhancer\.local\upload-test-media";
    private readonly string root;
    private readonly object gate = new();
    private readonly Dictionary<string, DevelopmentFixtureFile> capabilities = [];
    private static readonly (string Name, string Type)[] Contract = [
        ("neutral-full.mp4", "video/mp4"),
        ("neutral-teaser.mp4", "video/mp4"),
        ("neutral-thumbnail-valid.png", "image/png")
    ];
    internal DevelopmentFixtureSource() : this(FixtureRoot) { }
    internal DevelopmentFixtureSource(string root) { this.root = Path.GetFullPath(root); }
    private InvalidOperationException Missing() => new("Place neutral-full.mp4, neutral-teaser.mp4 and neutral-thumbnail-valid.png in " + root + ", then click Load Template again.");
    private FileInfo Validate(string name, string type)
    {
        try
        {
            string full = Path.GetFullPath(Path.Combine(root, name));
            if (!Contract.Any(item => item.Name == name && item.Type == type)
                || !string.Equals(Path.GetDirectoryName(full), root, StringComparison.OrdinalIgnoreCase)) throw Missing();
            for (string? current = full; current is not null; current = Path.GetDirectoryName(current))
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw Missing();
            var info = new FileInfo(full);
            long maximum = type == "image/png" ? 50L * 1024 * 1024 : 100L * 1024 * 1024 * 1024;
            if (!info.Exists || info.Length < 24 || info.Length > maximum) throw Missing();
            Span<byte> header = stackalloc byte[24];
            using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read);
            stream.ReadExactly(header);
            bool supported = type == "video/mp4"
                ? header[4..8].SequenceEqual("ftyp"u8)
                : header[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })
                    && header[12..16].SequenceEqual("IHDR"u8)
                    && System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(header[16..20]) > 0
                    && System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(header[20..24]) > 0;
            if (!supported) throw Missing();
            return info;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { throw Missing(); }
    }
    internal DevelopmentFixtureFile[] Load()
    {
        lock (gate)
        {
            // Validate the entire set before issuing any capability. Loading again
            // revokes old tokens; it is refused by the UI while a run is active.
            var files = Contract.Select(item => {
                var info = Validate(item.Name, item.Type);
                return new DevelopmentFixtureFile("development-fixture", Guid.NewGuid().ToString(), info.Name, info.Length,
                    item.Type, new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds());
            }).ToArray();
            capabilities.Clear();
            foreach (var file in files) capabilities.Add(file.FixtureToken, file);
            return files;
        }
    }
    internal FileInfo Resolve(string token)
    {
        lock (gate)
        {
            if (!capabilities.TryGetValue(token, out var expected)) throw new InvalidOperationException("Template expired. Click Load Template again.");
            var info = Validate(expected.Name, expected.Type);
            if (info.Length != expected.Size || new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() != expected.LastModified)
                throw new InvalidOperationException("A template file changed. Click Load Template again.");
            return info;
        }
    }
}
