using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed partial class XTeaserController
{
    // Only the WebView's verified staged file reaches here; web requests cannot name a source path.
    internal object CopyTeaserFile(JsonElement payload, FileInfo source)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || payload.EnumerateObject().Any(p => p.Name is not ("sessionId" or "role" or "name" or "size" or "lastModified" or "episodeKey" or "date"))
            || !payload.TryGetProperty("episodeKey", out var episode) || episode.ValueKind != JsonValueKind.String
            || episode.GetString() is not { } key || !Regex.IsMatch(key, "^[a-z0-9-]{1,200}$")
            || !store.GetItems().Any(item => item.SourceKey == key)
            || !payload.TryGetProperty("date", out var day) || day.ValueKind != JsonValueKind.String
            || !DateOnly.TryParseExact(day.GetString(), "yyyy-MM-dd", out _)
            || !payload.TryGetProperty("role", out var role) || role.ValueKind != JsonValueKind.String || role.GetString() != "social")
            throw new GoogleCatalogueControllerException("Choose a catalogue episode before copying the teaser.");
        string extension = source.Extension.ToLowerInvariant();
        source.Refresh();
        if (!source.Exists || source.Length is <= 0 or >= MaximumClipBytes
            || !new[] { ".mp4", ".mov", ".m4v", ".webm" }.Contains(extension))
            throw new GoogleCatalogueControllerException("Choose a teaser video under 512 MB.");
        for (string? current = source.FullName; current is not null; current = Path.GetDirectoryName(current))
            if (File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint))
                throw new GoogleCatalogueControllerException("unsafe-teaser-source");
        string root = settings().XTeaserRoot ?? throw new GoogleCatalogueControllerException("Set the teaser folder in Settings before copying.");
        _ = XTeaserFolder.ResolveInside(root, "probe.mp4") ?? throw new GoogleCatalogueControllerException("unsafe-teaser-clip");
        if (!Directory.Exists(root)) throw new GoogleCatalogueControllerException("The teaser folder is unavailable.");
        string date = day.GetString()!;
        XTeaserEdit edit = store.GetXTeaserEdit(key);
        using FileStream input = new(source.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length != source.Length || input.Length is <= 0 or >= MaximumClipBytes)
            throw new GoogleCatalogueControllerException("The selected teaser changed. Choose it again.");
        string hash = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
        string? name = null;
        foreach (var clip in store.GetXTeaserLibrary().Where(c => c.EpisodeKey == key && c.State == "ready" && c.Sha256 == hash))
        {
            string? existing = XTeaserFolder.ResolveInside(root, clip.RelPath);
            if (existing is null || !File.Exists(existing) || File.GetAttributes(existing).HasFlag(FileAttributes.ReparsePoint)) continue;
            using FileStream verified = new(existing, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (verified.Length == input.Length && Convert.ToHexString(SHA256.HashData(verified)).ToLowerInvariant() == hash)
            { name = Path.GetFileName(existing); break; }
        }
        if (name is null)
        {
            name = ReserveRender(key, date, edit, extension, reuseReservation: false);
            string temporary = Path.Combine(root, ".teaser-import-" + Guid.NewGuid().ToString("N") + ".partial");
            try
            {
                using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    input.Position = 0;
                    input.CopyTo(output);
                    output.Flush(flushToDisk: true);
                }
                File.Move(temporary, Path.Combine(root, name), overwrite: false);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        FileInfo copied = new(Path.Combine(root, name));
        XTeaserLibraryClip managed = store.UpsertXTeaserRender(new(name, copied.Length, XTeaserFolder.MtimeText(copied.LastWriteTimeUtc), hash), Now);
        store.SaveXTeaserEdit(key, edit with { Renders = new Dictionary<string, string>(edit.Renders) { [date] = name } });
        return new { name, path = copied.FullName, episodeKey = key, clip = new {
            managed.ClipId, name, size = copied.Length, lastModified = new DateTimeOffset(copied.LastWriteTimeUtc).ToUnixTimeMilliseconds(), managed.Sha256 } };
    }
}
