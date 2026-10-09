using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed partial class XTeaserController
{
    private readonly Dictionary<string, ClipRead> clipReads = new(StringComparer.Ordinal);
    private sealed record ClipRead(long ClipId, FileStream Stream, XTeaserLibraryClip Clip, DateTimeOffset Expires);
    private const long MaximumClipBytes = 512L * 1024 * 1024;
    private const int ClipChunkBytes = 256 * 1024;

    internal object ScheduledResult(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Count() != 3
            || !payload.TryGetProperty("captionSha256", out var hash) || hash.ValueKind != JsonValueKind.String
            || !payload.TryGetProperty("scheduledUtc", out var time) || time.ValueKind != JsonValueKind.String
            || !DateTimeOffset.TryParse(time.GetString(), out var instant)
            || !payload.TryGetProperty("episodeKey", out var episode) || episode.ValueKind != JsonValueKind.String)
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        var result = store.ResolveXScheduledResult(hash.GetString()!, instant, string.IsNullOrEmpty(episode.GetString()) ? null : episode.GetString());
        return result is null ? new { matched = false, resultId = "", resultUrl = "", postedUtc = "" }
            : new { matched = true, resultId = new Uri(result.Url).Segments.Last(), resultUrl = result.Url, postedUtc = result.PostedUtc.ToString("O") };
    }

    internal object Library(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        return new { clips = store.GetXTeaserLibrary().Where(clip =>
            new[] { ".mp4", ".mov", ".m4v", ".webm" }.Contains(Path.GetExtension(clip.RelPath).ToLowerInvariant())).Select(clip => new {
            clip.ClipId, name = Path.GetFileName(clip.RelPath), clip.EpisodeKey, clip.State,
            size = clip.SizeBytes, lastModified = DateTimeOffset.Parse(clip.MtimeUtc).ToUnixTimeMilliseconds(),
            clip.Sha256
        }).ToArray() };
    }

    // Retain one verified handle to prevent writes/renames between native-message
    // chunks. A caller can select an indexed ID, never an arbitrary media path.
    internal object ClipChunk(JsonElement payload)
    {
        foreach (string expired in clipReads.Where(p => p.Value.Expires <= Now).Select(p => p.Key).ToArray())
        { clipReads[expired].Stream.Dispose(); clipReads.Remove(expired); }
        if (payload.ValueKind != JsonValueKind.Object
            || payload.EnumerateObject().Any(p => p.Name is not ("clipId" or "token" or "offset"))
            || !payload.TryGetProperty("clipId", out var id) || !id.TryGetInt64(out long clipId) || clipId <= 0
            || !payload.TryGetProperty("offset", out var at) || !at.TryGetInt64(out long offset) || offset < 0)
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        string token = payload.TryGetProperty("token", out var tokenValue) && tokenValue.ValueKind == JsonValueKind.String
            ? tokenValue.GetString() ?? "" : "";
        if (offset == 0 && token.Length == 0)
        {
            if (clipReads.Count >= 4) throw new GoogleCatalogueControllerException("teaser-read-busy");
            string root = settings().XTeaserRoot ?? throw new GoogleCatalogueControllerException("x-teaser-inactive");
            XTeaserLibraryClip clip = store.GetXTeaserLibrary().SingleOrDefault(c => c.ClipId == clipId)
                ?? throw new GoogleCatalogueControllerException("teaser-clip-not-found");
            string path = XTeaserFolder.ResolveInside(root, clip.RelPath)
                ?? throw new GoogleCatalogueControllerException("unsafe-teaser-clip");
            FileInfo file = new(path);
            if (!file.Exists || file.Attributes.HasFlag(FileAttributes.ReparsePoint) || clip.SizeBytes is <= 0 or > MaximumClipBytes
                || file.Length != clip.SizeBytes || XTeaserFolder.MtimeText(file.LastWriteTimeUtc) != clip.MtimeUtc)
                throw new GoogleCatalogueControllerException("teaser-clip-changed");
            FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                string hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                if (hash != clip.Sha256) throw new GoogleCatalogueControllerException("teaser-clip-changed");
                stream.Position = 0;
                token = Guid.NewGuid().ToString("N");
                clipReads[token] = new(clipId, stream, clip, Now.AddMinutes(10));
            }
            catch { stream.Dispose(); throw; }
        }
        if (!clipReads.TryGetValue(token, out ClipRead? read) || read.ClipId != clipId || read.Stream.Position != offset)
            throw new GoogleCatalogueControllerException("teaser-read-expired");
        byte[] bytes = new byte[(int)Math.Min(ClipChunkBytes, read.Stream.Length - offset)];
        read.Stream.ReadExactly(bytes);
        bool done = read.Stream.Position == read.Stream.Length;
        var result = new { token, offset, chunk = Convert.ToBase64String(bytes), done, size = read.Clip.SizeBytes,
            name = Path.GetFileName(read.Clip.RelPath), sha256 = read.Clip.Sha256,
            lastModified = DateTimeOffset.Parse(read.Clip.MtimeUtc).ToUnixTimeMilliseconds() };
        if (done) { read.Stream.Dispose(); clipReads.Remove(token); }
        return result;
    }

    internal object OpenEpisodeFolder(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Count() != 1
            || !payload.TryGetProperty("episodeKey", out var value) || value.ValueKind != JsonValueKind.String
            || value.GetString() is not { } key || !System.Text.RegularExpressions.Regex.IsMatch(key, "^[a-z0-9-]{1,200}$")
            || !store.GetItems().Any(i => i.SourceKey == key))
            throw new GoogleCatalogueControllerException("invalid-teaser-episode");
        string root = Path.GetDirectoryName(store.ConfiguredThumbnailRoot ?? "")
            ?? throw new GoogleCatalogueControllerException("episode-folder-unavailable");
        string path = ResolveEpisodeFolder(root, key);
        Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
        return new { opened = true };
    }

    internal static string ResolveEpisodeFolder(string root, string key)
    {
        if (!Directory.Exists(root)) throw new GoogleCatalogueControllerException("episode-folder-unavailable");
        for (string? directory = root; directory is not null; directory = Path.GetDirectoryName(directory))
            if (new DirectoryInfo(directory).Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new GoogleCatalogueControllerException("unsafe-episode-folder");
        // Archived episodes live one grouping folder below the media root.
        string[] matches = Directory.EnumerateDirectories(root)
            .Where(directory => !new DirectoryInfo(directory).Attributes.HasFlag(FileAttributes.ReparsePoint))
            .Prepend(root)
            .Select(directory => Path.Combine(directory, key))
            .Where(Directory.Exists).Take(2).ToArray();
        if (matches.Length == 0) throw new GoogleCatalogueControllerException("episode-folder-unavailable");
        if (matches.Length > 1) throw new GoogleCatalogueControllerException("ambiguous-episode-folder");
        if (new DirectoryInfo(matches[0]).Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new GoogleCatalogueControllerException("unsafe-episode-folder");
        return matches[0];
    }
}
