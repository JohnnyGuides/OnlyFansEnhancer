using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed record TeaserClipPreview(string PosterUrl, double Duration, string? VideoUrl);
internal sealed record TeaserPreviewResource(Stream Stream, string ContentType, long Length);

// The browser receives only small derived media. Original teaser paths never
// cross the bridge, and ffmpeg jobs stay outside the serial catalogue queue.
internal sealed class TeaserClipPreviewStore(string? cacheRoot = null)
{
    internal const string Host = "teaser-preview.ofenhancer.local";
    private readonly string root = cacheRoot ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer", "cache", "teaser-previews-v1");
    private readonly SemaphoreSlim generation = new(1, 1);
    private readonly ConcurrentDictionary<string, double> durations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> assets = new(StringComparer.Ordinal);

    internal async Task<TeaserClipPreview> PrepareAsync(string sourceRoot, XTeaserLibraryClip clip, bool playback)
    {
        if (clip.Sha256.Length != 64 || !clip.Sha256.All(char.IsAsciiHexDigit))
            throw new GoogleCatalogueControllerException("teaser-clip-changed");
        string source = XTeaserFolder.ResolveInside(sourceRoot, clip.RelPath)
            ?? throw new GoogleCatalogueControllerException("unsafe-teaser-clip");
        string key = clip.Sha256.ToLowerInvariant();
        await generation.WaitAsync().ConfigureAwait(false);
        try
        {
            FileInfo file = new(source);
            if (!file.Exists || file.Attributes.HasFlag(FileAttributes.ReparsePoint)
                || clip.SizeBytes is <= 0 or > 512L * 1024 * 1024 || file.Length != clip.SizeBytes
                || XTeaserFolder.MtimeText(file.LastWriteTimeUtc) != clip.MtimeUtc)
                throw new GoogleCatalogueControllerException("teaser-clip-changed");
            using var rootHandle = WindowsFinalPath.OpenDirectory(sourceRoot);
            using FileStream locked = new(source, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!ThumbnailInventory.IsContainedPath(WindowsFinalPath.Read(rootHandle), WindowsFinalPath.Read(locked.SafeFileHandle)))
                throw new GoogleCatalogueControllerException("unsafe-teaser-clip");

            string folder = Path.Combine(root, key);
            string poster = Path.Combine(folder, "poster.jpg"), video = Path.Combine(folder, "preview.mp4");
            string durationFile = Path.Combine(folder, "duration.txt");
            if (!durations.TryGetValue(key, out double duration))
            {
                // Verify once per indexed fingerprint/session, including before
                // trusting any previously generated cache for this fingerprint.
                string hash = Convert.ToHexString(await SHA256.HashDataAsync(locked).ConfigureAwait(false));
                if (!hash.Equals(key, StringComparison.OrdinalIgnoreCase))
                    throw new GoogleCatalogueControllerException("teaser-clip-changed");
                Directory.CreateDirectory(folder);
                string durationText = File.Exists(durationFile) ? await File.ReadAllTextAsync(durationFile).ConfigureAwait(false)
                    : await Run("ffprobe.exe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source]).ConfigureAwait(false);
                if (!double.TryParse(durationText.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out duration)
                    || !double.IsFinite(duration) || duration <= 0)
                    throw new InvalidOperationException("The video duration could not be read.");
                await File.WriteAllTextAsync(durationFile, duration.ToString(CultureInfo.InvariantCulture)).ConfigureAwait(false);
                durations[key] = duration;
            }
            if (!ValidAsset(poster, 256 * 1024))
            {
                string partial = Path.Combine(folder, "poster.partial.jpg");
                // Use a real frame shortly after the start, avoiding a common
                // black fade-in while keeping thumbnails cheap to decode.
                await Run("ffmpeg.exe", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-ss", Math.Min(5, duration / 4).ToString(CultureInfo.InvariantCulture), "-i", source,
                    "-map", "0:v:0", "-frames:v", "1", "-threads", "1", "-vf", "scale=320:320:force_original_aspect_ratio=decrease", "-q:v", "4", partial]).ConfigureAwait(false);
                if (!ValidAsset(partial, 256 * 1024)) throw new InvalidOperationException("The video thumbnail could not be created.");
                File.Move(partial, poster, overwrite: true);
            }
            assets[$"/{key}/poster.jpg"] = poster;
            string? videoUrl = null;
            if (playback)
            {
                if (!ValidAsset(video, 4 * 1024 * 1024))
                {
                    string partial = Path.Combine(folder, "preview.partial.mp4");
                    await Run("ffmpeg.exe", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source,
                        "-map", "0:v:0", "-t", "6", "-an", "-vf", "scale=320:320:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=12",
                        "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-crf", "29", "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial]).ConfigureAwait(false);
                    if (!ValidAsset(partial, 4 * 1024 * 1024)) throw new InvalidOperationException("The video preview could not be created.");
                    File.Move(partial, video, overwrite: true);
                }
                assets[$"/{key}/preview.mp4"] = video;
                videoUrl = $"https://{Host}/{key}/preview.mp4";
            }
            return new($"https://{Host}/{key}/poster.jpg", duration, videoUrl);
        }
        finally { generation.Release(); }
    }

    internal TeaserPreviewResource? Open(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttps || uri.Host != Host || !uri.IsDefaultPort || uri.UserInfo.Length != 0
            || uri.Query.Length != 0 || uri.Fragment.Length != 0 || !assets.TryGetValue(uri.AbsolutePath, out string? path)) return null;
        try
        {
            FileInfo file = new(path);
            if (file.Attributes.HasFlag(FileAttributes.ReparsePoint) || !ValidAsset(path, 4 * 1024 * 1024)) return null;
            FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return new(stream, path.EndsWith(".jpg", StringComparison.Ordinal) ? "image/jpeg" : "video/mp4", stream.Length);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return null; }
    }

    private static bool ValidAsset(string path, long maximum) => new FileInfo(path) is { Exists: true, Length: > 0 } file && file.Length <= maximum;

    private static async Task<string> Run(string name, string[] arguments)
    {
        string bundled = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JohnnyTools", "ffmpeg", "bin", name);
        string executable = File.Exists(bundled) ? bundled : (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).Select(folder => Path.Combine(folder, name)).FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException("FFmpeg is needed for video previews.");
        ProcessStartInfo info = new(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in arguments) info.ArgumentList.Add(argument);
        using Process process = Process.Start(info) ?? throw new InvalidOperationException("Video preview preparation could not start.");
        Task<string> output = process.StandardOutput.ReadToEndAsync(), error = process.StandardError.ReadToEndAsync();
        using CancellationTokenSource stop = new(TimeSpan.FromSeconds(60));
        try { await process.WaitForExitAsync(stop.Token).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new InvalidOperationException("Video preview preparation timed out.");
        }
        string result = await output.ConfigureAwait(false);
        await error.ConfigureAwait(false);
        if (process.ExitCode != 0) throw new InvalidOperationException("The video preview could not be read.");
        return result;
    }
}
