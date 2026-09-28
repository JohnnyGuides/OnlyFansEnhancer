using System.Diagnostics;
using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class VideoOpeningFrameStoreTests
{
    private static string? Tool(string name)
    {
        string candidate = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JohnnyTools", "ffmpeg", "bin", name);
        if (File.Exists(candidate)) return candidate;
        return (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Select(folder => Path.Combine(folder, name)).FirstOrDefault(File.Exists);
    }

    private static string Run(string exe, params string[] args)
    {
        var start = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (string arg in args) start.ArgumentList.Add(arg);
        using Process process = Process.Start(start)!;
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.AreEqual(0, process.ExitCode, error);
        return output;
    }

    [TestMethod]
    public async Task PrependsASecondOnlyForTheApprovedPlatforms()
    {
        string? ffmpeg = Tool("ffmpeg.exe");
        string? ffprobe = Tool("ffprobe.exe");
        if (ffmpeg is null || ffprobe is null) Assert.Inconclusive("FFmpeg is unavailable on this test machine.");
        string root = Path.Combine(Path.GetTempPath(), "ofenhancer-intro-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sourcePath = Path.Combine(root, "neutral.mp4");
            Run(ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
                "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", sourcePath);
            FileInfo source = new(sourcePath);
            JsonElement selection = JsonSerializer.SerializeToElement(new {
                name = source.Name, size = source.Length,
                lastModified = new DateTimeOffset(source.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                seconds = 1.5, crop = new { zoom = 1.2, x = 0.3, y = -0.2 },
            });
            VideoOpeningFrameStore store = new(Path.Combine(root, "cache"), ffmpeg, ffprobe);
            string token = await store.PrepareAsync(source, selection);
            FileInfo result = store.Resolve(token, source, "fansly");
            Assert.AreEqual(source.Name, result.Name);
            Assert.AreNotEqual(source.FullName, result.FullName);
            Assert.IsTrue(result.Length > source.Length);
            Assert.AreEqual(result.FullName, store.Resolve(token, source, "onlyfans").FullName);
            Assert.ThrowsException<InvalidOperationException>(() => store.Resolve(token, source, "manyvids"));
            Assert.ThrowsException<InvalidOperationException>(() => store.Resolve("wrong", source, "fansly"));
            string durationText = Run(ffprobe!, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", result.FullName);
            double duration = double.Parse(durationText.Trim(), System.Globalization.CultureInfo.InvariantCulture);
            Assert.IsTrue(duration is > 3.9 and < 4.2, $"Unexpected output duration: {duration}");
            string OriginalFrame() => Run(ffmpeg!, "-v", "error", "-ss", "0.5", "-i", sourcePath, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "-")
                .Split('\n').Last(line => line.StartsWith("0,"));
            string JoinedFrame() => Run(ffmpeg!, "-v", "error", "-ss", "1.5", "-i", result.FullName, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "-")
                .Split('\n').Last(line => line.StartsWith("0,"));
            Assert.AreEqual(OriginalFrame().Split(',').Last().Trim(), JoinedFrame().Split(',').Last().Trim());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [TestMethod]
    public async Task SupportsHevcVideoWithoutAudio()
    {
        string? ffmpeg = Tool("ffmpeg.exe");
        string? ffprobe = Tool("ffprobe.exe");
        if (ffmpeg is null || ffprobe is null) Assert.Inconclusive("FFmpeg is unavailable on this test machine.");
        string root = Path.Combine(Path.GetTempPath(), "ofenhancer-hevc-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string sourcePath = Path.Combine(root, "neutral-hevc.mp4");
            Run(ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
                "-t", "2", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", sourcePath);
            FileInfo source = new(sourcePath);
            JsonElement selection = JsonSerializer.SerializeToElement(new {
                name = source.Name, size = source.Length,
                lastModified = new DateTimeOffset(source.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                seconds = 0.5, crop = new { zoom = 1, x = 0, y = 0 },
            });
            VideoOpeningFrameStore store = new(Path.Combine(root, "cache"), ffmpeg, ffprobe);
            string token = await store.PrepareAsync(source, selection);
            FileInfo output = store.Resolve(token, source, "onlyfans");
            string durationText = Run(ffprobe!, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", output.FullName);
            double duration = double.Parse(durationText.Trim(), System.Globalization.CultureInfo.InvariantCulture);
            Assert.IsTrue(duration is > 2.9 and < 3.2, $"Unexpected output duration: {duration}");
            Run(ffmpeg!, "-v", "error", "-i", output.FullName, "-map", "0:v:0", "-f", "null", "-");
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
