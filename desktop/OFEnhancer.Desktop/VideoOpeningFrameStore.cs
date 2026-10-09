using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal sealed class VideoOpeningFrameStore
{
    private sealed record Prepared(string SourcePath, long SourceSize, long SourceModified, string Selection, FileInfo Output,
        int LeadInMs);
    private readonly ConcurrentDictionary<string, Prepared> prepared = new();
    private readonly string root;
    private readonly string ffmpeg;
    private readonly string ffprobe;

    internal VideoOpeningFrameStore(string? root = null, string? ffmpeg = null, string? ffprobe = null)
    {
        this.root = root ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer", "cache", "opening-frames");
        this.ffmpeg = ffmpeg ?? FindExecutable("ffmpeg.exe");
        this.ffprobe = ffprobe ?? FindExecutable("ffprobe.exe");
    }

    private static string FindExecutable(string name)
    {
        string[] candidates = [
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JohnnyTools", "ffmpeg", "bin", name),
            .. (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Select(folder => Path.Combine(folder, name)),
        ];
        return candidates.FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException("FFmpeg is needed for an opening frame. Install FFmpeg or turn off the opening frame.");
    }

    private static long Modified(FileInfo file) => new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds();

    private static void ValidateSource(FileInfo file, JsonElement payload)
    {
        if (!file.Exists || file.Name != payload.GetProperty("name").GetString()
            || file.Length != payload.GetProperty("size").GetInt64()
            || Math.Abs(Modified(file) - payload.GetProperty("lastModified").GetInt64()) > 2)
            throw new InvalidOperationException("The selected video changed. Choose it again before uploading.");
    }

    private static string Number(double value) => value.ToString("0.######", CultureInfo.InvariantCulture);

    private static double RequiredNumber(JsonElement item, string key, double min, double max)
    {
        double value = item.GetProperty(key).GetDouble();
        if (!double.IsFinite(value) || value < min || value > max) throw new InvalidOperationException("Invalid opening frame selection.");
        return value;
    }

    private static string EscapeConcatPath(string path) => path.Replace('\\', '/').Replace("'", "'\\''");

    private static async Task<string> Run(string executable, IEnumerable<string> arguments, TimeSpan timeout)
    {
        var info = new ProcessStartInfo(executable) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (string argument in arguments) info.ArgumentList.Add(argument);
        using Process process = Process.Start(info) ?? throw new InvalidOperationException("FFmpeg could not start.");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var cancellation = new CancellationTokenSource(timeout);
        try { await process.WaitForExitAsync(cancellation.Token); }
        catch (OperationCanceledException) {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new InvalidOperationException("Opening frame preparation timed out. Turn it off or retry with a smaller video.");
        }
        string output = await stdout;
        string error = await stderr;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"Opening frame preparation failed: {error.Trim().Split('\n').LastOrDefault()?.Trim() ?? "FFmpeg error"}");
        return output;
    }

    internal async Task<string> PrepareAsync(FileInfo source, JsonElement payload)
    {
        ValidateSource(source, payload);
        if (!source.Extension.Equals(".mp4", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Opening frames currently support MP4 videos. Turn off the opening frame for this file.");
        double seconds = RequiredNumber(payload, "seconds", 0, 24 * 60 * 60);
        JsonElement crop = payload.GetProperty("crop");
        double zoom = RequiredNumber(crop, "zoom", 1, 2);
        double x = RequiredNumber(crop, "x", -1, 1);
        double y = RequiredNumber(crop, "y", -1, 1);
        string selection = $"{Number(seconds)}:{Number(zoom)}:{Number(x)}:{Number(y)}";
        foreach (KeyValuePair<string, Prepared> existing in prepared)
            if (existing.Value.SourcePath == source.FullName && existing.Value.SourceSize == source.Length
                && existing.Value.SourceModified == Modified(source) && existing.Value.Selection == selection
                && existing.Value.Output.Exists)
                return existing.Key;
        using JsonDocument probe = JsonDocument.Parse(await Run(ffprobe, [
            "-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,pix_fmt,profile,r_frame_rate,sample_rate,channel_layout",
            "-of", "json", source.FullName,
        ], TimeSpan.FromSeconds(30)));
        JsonElement streams = probe.RootElement.GetProperty("streams");
        JsonElement[] videos = streams.EnumerateArray().Where(item => item.GetProperty("codec_type").GetString() == "video").ToArray();
        JsonElement[] audios = streams.EnumerateArray().Where(item => item.GetProperty("codec_type").GetString() == "audio").ToArray();
        if (videos.Length != 1 || audios.Length > 1 || streams.GetArrayLength() != videos.Length + audios.Length)
            throw new InvalidOperationException("Opening frames need one video stream and at most one audio stream. Turn off the opening frame for this file.");
        JsonElement video = videos[0];
        string codec = video.GetProperty("codec_name").GetString() ?? "";
        if (codec is not ("h264" or "hevc") || audios.Any(item => item.GetProperty("codec_name").GetString() != "aac"))
            throw new InvalidOperationException("Opening frames currently support H.264 or HEVC MP4 with AAC audio. Turn off the opening frame for this file.");
        int width = video.GetProperty("width").GetInt32();
        int height = video.GetProperty("height").GetInt32();
        if (width < 320 || height < 180 || width > 7680 || height > 4320 || width % 2 != 0 || height % 2 != 0)
            throw new InvalidOperationException("This video size is not supported for an opening frame.");
        string pixelFormat = video.GetProperty("pix_fmt").GetString() ?? "";
        if (pixelFormat is not ("yuv420p" or "yuv420p10le"))
            throw new InvalidOperationException("This video pixel format is not supported for an opening frame.");
        string frameRate = video.GetProperty("r_frame_rate").GetString() ?? "";
        string[] ratio = frameRate.Split('/');
        if (ratio.Length != 2 || !double.TryParse(ratio[0], out double numerator) || !double.TryParse(ratio[1], out double denominator)
            || denominator <= 0 || numerator / denominator is < 10 or > 120)
            throw new InvalidOperationException("This video frame rate is not supported for an opening frame.");
        if (!double.TryParse(probe.RootElement.GetProperty("format").GetProperty("duration").GetString(),
            NumberStyles.Float, CultureInfo.InvariantCulture, out double duration) || !double.IsFinite(duration) || duration <= 0)
            throw new InvalidOperationException("This video has no readable duration for an opening frame.");
        if (seconds >= duration) throw new InvalidOperationException("Choose a frame inside the video.");
        long needed = source.Length + 256L * 1024 * 1024;
        Directory.CreateDirectory(root);
        foreach (string candidate in Directory.EnumerateDirectories(root))
        {
            if (Guid.TryParseExact(Path.GetFileName(candidate), "N", out _)
                && Directory.GetLastWriteTimeUtc(candidate) < DateTime.UtcNow.AddDays(-1))
            {
                try { Directory.Delete(candidate, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        if (new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root))!).AvailableFreeSpace < needed)
            throw new InvalidOperationException("There is not enough free space for the video with an opening frame. Free space or turn off the opening frame.");

        string token = Guid.NewGuid().ToString("N");
        string folder = Path.Combine(root, token);
        Directory.CreateDirectory(folder);
        string frame = Path.Combine(folder, "frame.png");
        string intro = Path.Combine(folder, "intro.mp4");
        string list = Path.Combine(folder, "files.ffcat");
        string partial = Path.Combine(folder, "partial.mp4");
        string final = Path.Combine(folder, source.Name);
        try {
            double baseWidth = Math.Min(width, height * 16d / 9);
            int cropWidth = Math.Clamp((int)Math.Round(baseWidth / zoom / 2) * 2, 2, width);
            int cropHeight = Math.Clamp((int)Math.Round(cropWidth * 9d / 16 / 2) * 2, 2, height);
            int left = Math.Clamp((int)Math.Round((width - cropWidth) * (x + 1) / 4) * 2, 0, width - cropWidth);
            int top = Math.Clamp((int)Math.Round((height - cropHeight) * (y + 1) / 4) * 2, 0, height - cropHeight);
            string filter = $"crop={cropWidth}:{cropHeight}:{left}:{top},scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1";
            await Run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", Number(seconds), "-i", source.FullName,
                "-map", "0:v:0", "-frames:v", "1", "-vf", filter, frame], TimeSpan.FromMinutes(2));
            var introArguments = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", frameRate,
                "-t", "1", "-i", frame };
            if (audios.Length == 1) {
                JsonElement audio = audios[0];
                string rate = audio.GetProperty("sample_rate").GetString() ?? "";
                string layout = audio.TryGetProperty("channel_layout", out JsonElement layoutValue) ? layoutValue.GetString() ?? "" : "";
                if (!int.TryParse(rate, out int sampleRate) || sampleRate is < 8000 or > 192000 || layout is not ("mono" or "stereo" or "5.1"))
                    throw new InvalidOperationException("This audio layout is not supported for an opening frame.");
                introArguments.AddRange(["-f", "lavfi", "-t", "1", "-i", $"anullsrc=r={rate}:cl={layout}"]);
            }
            introArguments.AddRange(["-map", "0:v:0"]);
            if (audios.Length == 1) introArguments.AddRange(["-map", "1:a:0"]);
            introArguments.AddRange(["-c:v", codec == "h264" ? "libx264" : "libx265", "-preset", "fast", "-crf", "18",
                "-pix_fmt", pixelFormat, "-r", frameRate]);
            if (codec == "h264") {
                string profile = video.GetProperty("profile").GetString() ?? "";
                if (profile.Contains("Baseline", StringComparison.OrdinalIgnoreCase)) introArguments.AddRange(["-profile:v", "baseline"]);
                else if (profile.Equals("Main", StringComparison.OrdinalIgnoreCase)) introArguments.AddRange(["-profile:v", "main"]);
                else if (profile.Equals("High", StringComparison.OrdinalIgnoreCase)) introArguments.AddRange(["-profile:v", "high"]);
            } else introArguments.AddRange(["-tag:v", "hvc1", "-x265-params", "log-level=error"]);
            if (audios.Length == 1) introArguments.AddRange(["-c:a", "aac", "-b:a", "128k", "-shortest"]);
            introArguments.Add(intro);
            await Run(ffmpeg, introArguments, TimeSpan.FromMinutes(5));
            await File.WriteAllTextAsync(list, $"ffconcat version 1.0\nfile '{EscapeConcatPath(intro)}'\nfile '{EscapeConcatPath(source.FullName)}'\n", new UTF8Encoding(false));
            var concatArguments = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
                "-map", "0:v:0" };
            if (audios.Length == 1) concatArguments.AddRange(["-map", "0:a:0"]);
            concatArguments.AddRange(["-c", "copy", partial]);
            await Run(ffmpeg, concatArguments, TimeSpan.FromHours(2));
            FileInfo output = new(partial);
            if (!output.Exists || output.Length <= source.Length / 2)
                throw new InvalidOperationException("The video with an opening frame could not be verified.");
            string checkedDuration = (await Run(ffprobe, ["-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", partial], TimeSpan.FromSeconds(30))).Trim();
            if (!double.TryParse(checkedDuration, NumberStyles.Float, CultureInfo.InvariantCulture, out double outputDuration)
                || outputDuration < duration + 0.75 || outputDuration > duration + 1.25)
                throw new InvalidOperationException("The video with an opening frame could not be verified.");
            await Run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-ss", "1.25", "-i", partial,
                "-map", "0:v:0", "-frames:v", "2", "-f", "null", "-"], TimeSpan.FromMinutes(1));
            // The source's first frame follows every intro frame; its measured shift
            // (frame-rate rounding and audio priming included) aligns toy scripts.
            int introFrames = int.Parse((await Run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets",
                "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", intro], TimeSpan.FromSeconds(30))).Trim().TrimEnd(','),
                NumberStyles.None, CultureInfo.InvariantCulture);
            double shift = await PresentationTime(partial, introFrames) - await PresentationTime(source.FullName, 0);
            if (!double.IsFinite(shift) || shift is < 0.75 or > 1.25)
                throw new InvalidOperationException("The video with an opening frame could not be verified.");
            File.Move(partial, final);
            File.Delete(frame);
            File.Delete(intro);
            File.Delete(list);
            prepared[token] = new(source.FullName, source.Length, Modified(source), selection, new FileInfo(final),
                (int)Math.Round(shift * 1000, MidpointRounding.AwayFromZero));
            return token;
        }
        catch {
            try { Directory.Delete(folder, recursive: true); } catch { }
            throw;
        }
    }

    // Presentation time of the index-th video frame, from the leading packets in decode order.
    private async Task<double> PresentationTime(string file, int index)
    {
        string text = await Run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
            "-read_intervals", $"%+#{index + 64}", "-of", "csv=p=0", file], TimeSpan.FromSeconds(30));
        double[] times = [.. text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => double.TryParse(line.TrimEnd(','), NumberStyles.Float, CultureInfo.InvariantCulture, out double value)
                ? value : double.NaN)
            .Where(double.IsFinite).Order()];
        return index < times.Length ? times[index]
            : throw new InvalidOperationException("The video with an opening frame could not be verified.");
    }

    internal int LeadInMs(string token) =>
        prepared.TryGetValue(token, out Prepared? item) ? item.LeadInMs
            : throw new InvalidOperationException("The opening frame video is no longer available. Start this upload again.");

    internal FileInfo Resolve(string token, FileInfo source, string platform)
    {
        if (platform is not ("onlyfans" or "fansly") || !prepared.TryGetValue(token, out Prepared? item)
            || item.SourcePath != source.FullName || item.SourceSize != source.Length || item.SourceModified != Modified(source)
            || !item.Output.Exists)
            throw new InvalidOperationException("The opening frame video is no longer available. Start this upload again.");
        return item.Output;
    }
}
