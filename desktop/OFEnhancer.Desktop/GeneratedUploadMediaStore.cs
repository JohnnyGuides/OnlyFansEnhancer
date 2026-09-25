using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace OFEnhancer.Desktop;

// WebView2 exposes a native path only for a File chosen from disk. Browser-
// generated media is staged through bounded chunks before the usual bound
// file handoff; the source video itself never passes through this store.
internal sealed class GeneratedUploadMediaStore
{
    private const int MaximumChunkBytes = 256 * 1024;
    private readonly string root;
    private readonly Dictionary<string, Pending> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FileInfo> completed = new(StringComparer.Ordinal);

    private sealed record Pending(string Name, long Size, long LastModified, string Hash, string PartPath, long Offset);

    internal GeneratedUploadMediaStore(string? cacheRoot = null)
    {
        root = cacheRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OFEnhancer", "cache", "generated-upload-media");
    }

    internal FileInfo? Append(JsonElement payload)
    {
        string session = payload.GetProperty("sessionId").GetString() ?? "";
        string role = payload.GetProperty("role").GetString() ?? "";
        string name = payload.GetProperty("name").GetString() ?? "";
        string hash = payload.GetProperty("sha256").GetString() ?? "";
        long size = payload.GetProperty("size").GetInt64();
        long modified = payload.GetProperty("lastModified").GetInt64();
        long offset = payload.GetProperty("offset").GetInt64();
        bool final = payload.GetProperty("final").GetBoolean();
        if (session.Length != 48 || session.Any(c => !Uri.IsHexDigit(c)) || role is not ("teaser" or "thumbnail") ||
            name.Length is < 1 or > 128 || name != Path.GetFileName(name) || name.Any(c => Path.GetInvalidFileNameChars().Contains(c)) ||
            Path.GetExtension(name).ToLowerInvariant() != (role == "teaser" ? ".mp4" : ".png") ||
            hash.Length != 64 || hash.Any(c => !Uri.IsHexDigit(c)) ||
            size <= 0 || size >= (role == "teaser" ? 50L * 1024 * 1024 : 2_000_000) ||
            modified <= 0 || offset < 0 || offset >= size)
            throw new InvalidOperationException("Invalid generated upload media.");
        byte[] chunk;
        try { chunk = Convert.FromBase64String(payload.GetProperty("chunk").GetString() ?? ""); }
        catch (FormatException) { throw new InvalidOperationException("Invalid generated upload media chunk."); }
        if (chunk.Length is < 1 or > MaximumChunkBytes || offset + chunk.Length > size || final != (offset + chunk.Length == size))
            throw new InvalidOperationException("Invalid generated upload media chunk.");

        string key = session + "/" + role;
        if (completed.ContainsKey(key)) throw new InvalidOperationException("Generated upload media was already staged.");
        if (!pending.TryGetValue(key, out Pending? state))
        {
            if (offset != 0) throw new InvalidOperationException("Generated upload media chunks arrived out of order.");
            ReapOldOutputs();
            string directory = Path.Combine(root, session);
            Directory.CreateDirectory(directory);
            string partPath = Path.Combine(directory, role + ".partial");
            using (new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None)) { }
            state = new Pending(name, size, modified, hash, partPath, 0);
            pending[key] = state;
        }
        if (state.Name != name || state.Size != size || state.LastModified != modified || state.Hash != hash || state.Offset != offset)
            throw new InvalidOperationException("Generated upload media changed during staging.");
        using (FileStream stream = new(state.PartPath, FileMode.Open, FileAccess.Write, FileShare.None))
        {
            stream.Seek(offset, SeekOrigin.Begin);
            stream.Write(chunk);
        }
        pending[key] = state with { Offset = offset + chunk.Length };
        if (!final) return null;
        string actualHash;
        using (FileStream verified = File.OpenRead(state.PartPath))
            actualHash = Convert.ToHexString(SHA256.HashData(verified)).ToLowerInvariant();
        if (!actualHash.Equals(hash, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(state.PartPath);
            pending.Remove(key);
            throw new InvalidOperationException("Generated upload media failed its integrity check.");
        }
        string output = Path.Combine(root, session, name);
        if (File.Exists(output))
        {
            using (FileStream existing = File.OpenRead(output))
                if (existing.Length != size || !Convert.ToHexString(SHA256.HashData(existing)).Equals(hash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Generated upload media conflicts with an earlier staged file.");
            File.Delete(state.PartPath);
        }
        else File.Move(state.PartPath, output, overwrite: false);
        File.SetLastWriteTimeUtc(output, DateTimeOffset.FromUnixTimeMilliseconds(modified).UtcDateTime);
        pending.Remove(key);
        FileInfo result = new(output);
        completed[key] = result;
        return result;
    }

    internal FileInfo Resolve(JsonElement payload)
    {
        string session = payload.GetProperty("sessionId").GetString() ?? "";
        string role = payload.GetProperty("role").GetString() ?? "";
        string key = session + "/" + role;
        if (!completed.TryGetValue(key, out FileInfo? file) || !file.Exists ||
            file.Name != payload.GetProperty("name").GetString() ||
            file.Length != payload.GetProperty("size").GetInt64() ||
            Math.Abs(new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds() -
                payload.GetProperty("lastModified").GetInt64()) > 2)
            throw new InvalidOperationException("Generated upload media is not staged for this request.");
        return file;
    }

    private void ReapOldOutputs()
    {
        if (!Directory.Exists(root)) return;
        DateTime threshold = DateTime.UtcNow.AddDays(-30);
        foreach (string path in Directory.EnumerateDirectories(root))
        {
            DirectoryInfo directory = new(path);
            if (directory.Name.Length != 48 || directory.Name.Any(c => !Uri.IsHexDigit(c)) || directory.LastWriteTimeUtc >= threshold)
                continue;
            try { directory.Delete(recursive: true); }
            catch (IOException) { /* A browser may still hold this file. */ }
            catch (UnauthorizedAccessException) { /* Try on a later stage. */ }
        }
    }
}
