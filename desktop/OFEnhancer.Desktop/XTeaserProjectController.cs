using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed partial class XTeaserController
{
    internal Action<string> OpenProject { get; set; } = path => Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
    internal Func<string, string?> ChooseProject { get; set; } = folder => System.Windows.Application.Current.Dispatcher.Invoke(() =>
    {
        Microsoft.Win32.OpenFileDialog picker = new() { Title = "Choose teaser project", InitialDirectory = folder,
            Filter = "VEGAS projects (*.veg)|*.veg", CheckFileExists = true, Multiselect = false };
        return picker.ShowDialog() == true ? picker.FileName : null;
    });
    internal string? TeaserTemplatePath { get; set; }
    private readonly Dictionary<string, (long Size, DateTime Mtime, DateTimeOffset Seen)> renderProbes = new(StringComparer.OrdinalIgnoreCase);
    // Normal renders change mtime/size immediately. Periodic hashing also catches
    // tools that replace bytes while preserving timestamps, without hashing a large
    // unchanged video on every UI poll or rewriting its catalogue row.
    internal static readonly TimeSpan RenderHashInterval = TimeSpan.FromSeconds(15);
    private readonly Dictionary<string, (long Size, DateTime Mtime, DateTimeOffset Hashed, XTeaserLibraryClip Clip)> readyRenders = new(StringComparer.OrdinalIgnoreCase);

    private (string Key, string Date, string Folder) EditRequest(JsonElement payload, bool projectName = false)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any(p => p.Name is not ("episodeKey" or "date") && !(projectName && p.Name == "projectName"))
            || !payload.TryGetProperty("episodeKey", out var keyValue) || keyValue.ValueKind != JsonValueKind.String
            || keyValue.GetString() is not { } key || !Regex.IsMatch(key, "^[a-z0-9-]{1,200}$")
            || !store.GetItems().Any(item => item.SourceKey == key)
            || !payload.TryGetProperty("date", out var dateValue) || dateValue.ValueKind != JsonValueKind.String
            || !DateOnly.TryParseExact(dateValue.GetString(), "yyyy-MM-dd", out _))
            throw new GoogleCatalogueControllerException("invalid-teaser-edit");
        string root = Path.GetDirectoryName(store.ConfiguredThumbnailRoot ?? "") ?? throw new GoogleCatalogueControllerException("episode-folder-unavailable");
        return (key, dateValue.GetString()!, ResolveEpisodeFolder(root, key));
    }

    private static string SafeProject(string path)
    {
        string full = Path.GetFullPath(path);
        if (!Path.IsPathFullyQualified(path) || !string.Equals(Path.GetExtension(full), ".veg", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(full)) throw new GoogleCatalogueControllerException("teaser-project-unavailable");
        for (string? current = full; current is not null; current = Path.GetDirectoryName(current))
            if (File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint)) throw new GoogleCatalogueControllerException("unsafe-teaser-project");
        return full;
    }

    private string? Template()
    {
        string? root = Path.GetDirectoryName(store.ConfiguredThumbnailRoot ?? "");
        if (root is null) return null;
        string folder = Path.Combine(root, "_template");
        string? candidate = TeaserTemplatePath;
        if (candidate is null && Directory.Exists(folder))
        {
            string preferred = Path.Combine(folder, "_.-TEMPLATE-._.veg");
            if (File.Exists(preferred)) candidate = preferred;
            // The user's template is a uniquely named .veg under the media root.
            else
            {
                var files = Directory.EnumerateFiles(folder, "*.veg", SearchOption.TopDirectoryOnly).Take(2).ToArray();
                if (files.Length == 1) candidate = files[0];
            }
        }
        if (candidate is null) return null;
        try { return SafeProject(candidate); }
        catch (GoogleCatalogueControllerException) { return null; }
    }

    private string ReserveRender(string key, string date, XTeaserEdit edit)
    {
        if (edit.Renders.TryGetValue(date, out string? reserved)) return reserved;
        string root = settings().XTeaserRoot ?? throw new GoogleCatalogueControllerException("x-teaser-inactive");
        _ = XTeaserFolder.ResolveInside(root, "probe.mp4") ?? throw new GoogleCatalogueControllerException("unsafe-teaser-clip");
        if (!Directory.Exists(root)) throw new GoogleCatalogueControllerException("x-teaser-root-unavailable");
        var used = store.GetXTeaserRenderReservations().Concat(store.GetXClipFingerprints().Select(clip => Path.GetFileName(clip.RelPath)))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (int index = 1; index <= 999; index++)
        {
            string name = $"{key}__t{index:00}.mp4";
            if (used.Contains(name) || new[] { "", "Done", Path.Combine("Done", "Good"), Path.Combine("Done", "Failed") }
                .Any(folder => File.Exists(Path.Combine(root, folder, name)))) continue;
            return name;
        }
        throw new GoogleCatalogueControllerException("teaser-render-names-exhausted");
    }

    private object EditDetails(string key, string date, string folder, bool cancelled = false, string? status = null, XTeaserLibraryClip? clip = null)
    {
        XTeaserEdit edit = store.GetXTeaserEdit(key);
        string name = edit.Renders.TryGetValue(date, out var render) ? render : "";
        string root = settings().XTeaserRoot ?? "";
        var projects = Directory.EnumerateFiles(folder, "*", SearchOption.TopDirectoryOnly)
            .Where(path => string.Equals(Path.GetExtension(path), ".veg", StringComparison.OrdinalIgnoreCase))
            .Where(path => !File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint))
            .Select(path => new { name = Path.GetFileName(path), suggested = Regex.IsMatch(Path.GetFileNameWithoutExtension(path), "teas", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) })
            .OrderByDescending(project => project.suggested).ThenBy(project => project.name).ToArray();
        string selected = "";
        if (!string.IsNullOrEmpty(edit.ProjectPath))
            try { selected = Path.GetFileName(SafeProject(edit.ProjectPath)); } catch (GoogleCatalogueControllerException) { }
        return new { episodeKey = key, projectName = selected, projects, templateAvailable = Template() is not null,
            renderName = name, renderFolder = name.Length > 0 ? root : "", renderPath = name.Length > 0 && root.Length > 0 ? Path.Combine(root, name) : "",
            cancelled, status, clip = clip is null ? null : new { clip.ClipId, name = Path.GetFileName(clip.RelPath), size = clip.SizeBytes,
                lastModified = DateTimeOffset.Parse(clip.MtimeUtc).ToUnixTimeMilliseconds(), clip.Sha256 } };
    }

    internal object GetTeaserEdit(JsonElement payload)
    {
        var request = EditRequest(payload);
        return EditDetails(request.Key, request.Date, request.Folder);
    }

    internal object PrepareTeaserProject(JsonElement payload, string operation)
    {
        var request = EditRequest(payload, operation == "openTeaserProject");
        XTeaserEdit edit = store.GetXTeaserEdit(request.Key);
        string? selected;
        string? render = null;
        if (operation == "chooseTeaserProject")
        {
            selected = ChooseProject(request.Folder);
            if (selected is null) return EditDetails(request.Key, request.Date, request.Folder, cancelled: true);
            selected = SafeProject(selected); // Only the native picker authorizes outside projects.
        }
        else if (operation == "createTeaserProject")
        {
            string template = Template() ?? throw new GoogleCatalogueControllerException("teaser-template-unavailable");
            render = ReserveRender(request.Key, request.Date, edit);
            selected = "";
            for (int index = 1; index <= 999; index++)
            {
                string candidate = Path.Combine(request.Folder, $"{request.Key}__teaser{(index == 1 ? "" : "-" + index)}.veg");
                if (File.Exists(candidate) || Directory.Exists(candidate)) continue;
                File.Copy(template, candidate, overwrite: false);
                selected = SafeProject(candidate);
                break;
            }
            if (selected.Length == 0) throw new GoogleCatalogueControllerException("teaser-project-names-exhausted");
        }
        else if (payload.TryGetProperty("projectName", out var project))
        {
            if (project.ValueKind != JsonValueKind.String || project.GetString() is not { Length: > 0 } name || name != Path.GetFileName(name) || name.Contains(':') || name.Contains('/') || name.Contains('\\'))
                throw new GoogleCatalogueControllerException("invalid-teaser-project");
            selected = SafeProject(Path.Combine(request.Folder, name));
        }
        else if (edit.ProjectPath.Length > 0) selected = SafeProject(edit.ProjectPath);
        else
        {
            string[] projects = Directory.EnumerateFiles(request.Folder, "*", SearchOption.TopDirectoryOnly)
                .Where(path => string.Equals(Path.GetExtension(path), ".veg", StringComparison.OrdinalIgnoreCase)
                    && !File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint)).Take(2).ToArray();
            if (projects.Length != 1) throw new GoogleCatalogueControllerException(projects.Length == 0 ? "teaser-project-unavailable" : "teaser-project-choice-required");
            selected = SafeProject(projects[0]);
        }
        render ??= ReserveRender(request.Key, request.Date, edit);
        var renders = new Dictionary<string, string>(edit.Renders) { [request.Date] = render };
        store.SaveXTeaserEdit(request.Key, new(selected, renders));
        OpenProject(selected);
        return EditDetails(request.Key, request.Date, request.Folder);
    }

    internal object CheckTeaserRender(JsonElement payload)
    {
        var request = EditRequest(payload);
        XTeaserEdit edit = store.GetXTeaserEdit(request.Key);
        if (!edit.Renders.TryGetValue(request.Date, out var name) || settings().XTeaserRoot is not { } root)
            return EditDetails(request.Key, request.Date, request.Folder, status: "inactive");
        string path = XTeaserFolder.ResolveInside(root, name) ?? throw new GoogleCatalogueControllerException("unsafe-teaser-clip");
        try
        {
            FileInfo file = new(path);
            if (!file.Exists) { renderProbes.Remove(path); readyRenders.Remove(path); return EditDetails(request.Key, request.Date, request.Folder, status: "waiting"); }
            if (file.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new GoogleCatalogueControllerException("unsafe-teaser-clip");
            if (file.Length > MaximumClipBytes) throw new GoogleCatalogueControllerException("teaser-render-too-large");
            if (file.Length <= 0) { readyRenders.Remove(path); return EditDetails(request.Key, request.Date, request.Folder, status: "rendering"); }
            long size = file.Length;
            DateTime mtime = file.LastWriteTimeUtc;
            if (!renderProbes.TryGetValue(path, out var probe) || probe.Size != size || probe.Mtime != mtime)
            {
                readyRenders.Remove(path);
                renderProbes[path] = (size, mtime, Now);
                return EditDetails(request.Key, request.Date, request.Folder, status: "rendering");
            }
            if (Now - probe.Seen < TimeSpan.FromSeconds(1)) return EditDetails(request.Key, request.Date, request.Folder, status: "rendering");
            using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            file.Refresh();
            if (stream.Length != size || file.Length != size || file.LastWriteTimeUtc != mtime)
            { renderProbes.Remove(path); readyRenders.Remove(path); return EditDetails(request.Key, request.Date, request.Folder, status: "rendering"); }
            if (readyRenders.TryGetValue(path, out var cached) && cached.Size == size && cached.Mtime == mtime
                && Now - cached.Hashed < RenderHashInterval && store.GetXTeaserLibraryClip(cached.Clip.ClipId) is { } available)
                return EditDetails(request.Key, request.Date, request.Folder, status: "ready", clip: available);
            string hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            file.Refresh();
            if (stream.Length != size || file.Length != size || file.LastWriteTimeUtc != mtime)
            { renderProbes.Remove(path); readyRenders.Remove(path); return EditDetails(request.Key, request.Date, request.Folder, status: "rendering"); }
            XTeaserLibraryClip clip = readyRenders.TryGetValue(path, out cached) && cached.Clip.Sha256 == hash
                && cached.Clip.MtimeUtc == XTeaserFolder.MtimeText(mtime) && store.GetXTeaserLibraryClip(cached.Clip.ClipId) is { } unchanged
                ? unchanged : store.UpsertXTeaserRender(new(name, size, XTeaserFolder.MtimeText(mtime), hash), Now);
            readyRenders[path] = (size, mtime, Now, clip);
            return EditDetails(request.Key, request.Date, request.Folder, status: "ready", clip: clip);
        }
        catch (IOException) { readyRenders.Remove(path); return EditDetails(request.Key, request.Date, request.Folder, status: "rendering"); }
        catch (UnauthorizedAccessException) { readyRenders.Remove(path); return EditDetails(request.Key, request.Date, request.Folder, status: "rendering"); }
    }
}
