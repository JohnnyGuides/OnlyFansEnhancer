using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal static class ThumbnailMaintenance
{
    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp" };
    internal static string CleanStem(string stem) => Regex.Replace(stem, @"_(33|4k)(?=_|$)", "", RegexOptions.IgnoreCase);
    internal static string Hash(string path) { using var stream = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(stream)); }
    private static bool SamePath(string a, string b) => Path.GetFullPath(a).Equals(Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    private static void SafePath(string root, string path)
    {
        string relative = Path.GetRelativePath(root, path);
        if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar))
            throw new IOException("thumbnail-path-outside-authorized-root");
        for (string? check = path; check is not null; check = Path.GetDirectoryName(check))
        {
            if ((File.Exists(check) || Directory.Exists(check)) && (File.GetAttributes(check) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("thumbnail-reparse-point");
        }
    }
    private static IEnumerable<string> Images(string root)
    {
        SafePath(root, root);
        foreach (string file in Directory.EnumerateFiles(root))
        {
            SafePath(root, file);
            if (ImageExtensions.Contains(Path.GetExtension(file))) yield return file;
        }
        foreach (string child in Directory.EnumerateDirectories(root))
        {
            SafePath(root, child);
            foreach (string file in Images(child)) yield return file;
        }
    }

    internal static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        if (!args.Contains("--recover-thumbnails", StringComparer.Ordinal)) return false;
        string? Option(string name) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        string report = Option("--result") ?? throw new ArgumentException("--result is required");
        try
        {
            string root = Path.GetFullPath(Option("--thumbnail-root") ?? throw new ArgumentException("--thumbnail-root is required"));
            string database = Option("--catalogue-database") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer", "data", "catalogue.db");
            string[] sources = new[] { root, Option("--consolidate-from") }.OfType<string>().Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            bool apply = args.Contains("--apply", StringComparer.Ordinal);
            bool cleanup = args.Contains("--remove-resolution-variants", StringComparer.Ordinal);
            Task.Run(() => Run(database, root, sources, report, apply, cleanup)).GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            exitCode = 1;
            File.WriteAllText(report + ".error.txt", error.ToString());
        }
        return true;
    }

    internal static async Task Run(string database, string root, string[] sources, string report, bool apply, bool cleanup)
    {
        string[] files = sources.SelectMany(Images).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(report))!);
        using var store = CatalogueStore.Open(database);
        var initial = store.GetCatalogue();
        var result = new MaintenanceResult { Before = initial.Items.Count(i => i.ThumbnailAssetId is not null), ImageFiles = files.Length, Applied = apply };
        if (!apply) { File.WriteAllText(report, JsonSerializer.Serialize(result)); return; }
        string backup = report + ".backup";
        if (Directory.Exists(backup)) throw new IOException("Choose a new result path; backup already exists.");
        Directory.CreateDirectory(backup);
        using (var source = new SqliteConnection($"Data Source={database};Mode=ReadOnly;Pooling=False"))
        using (var target = new SqliteConnection($"Data Source={Path.Combine(backup, "catalogue.db")};Pooling=False"))
        { source.Open(); target.Open(); source.BackupDatabase(target); }

        // Resolve all existing bindings before changing any file locations.
        var bindings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (var connection = new SqliteConnection($"Data Source={database};Mode=ReadOnly;Pooling=False"))
        {
            connection.Open(); using var query = connection.CreateCommand();
            query.CommandText = "SELECT m.absolute_path,b.item_id FROM media_assets m JOIN asset_bindings b USING(asset_id) WHERE m.available=1";
            using var reader = query.ExecuteReader(); while (reader.Read()) bindings[reader.GetString(0)] = reader.GetString(1);
        }
        var canonical = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // Nonvariants first, so an existing main image always wins over _33/_4k.
        foreach (string file in files.OrderBy(f => CleanStem(Path.GetFileNameWithoutExtension(f)) == Path.GetFileNameWithoutExtension(f) ? 0 : 1))
        {
            string stem = Path.GetFileNameWithoutExtension(file);
            string clean = cleanup ? CleanStem(stem) : stem;
            string destination = Path.Combine(root, clean + Path.GetExtension(file).ToLowerInvariant());
            SafePath(root, destination);
            bool variant = stem != clean;
            if (File.Exists(destination) && !SamePath(file, destination) && Hash(file) != Hash(destination) && !variant)
                destination = Path.Combine(root, clean + "_" + Hash(file)[..10].ToLowerInvariant() + Path.GetExtension(file).ToLowerInvariant());
            if (!File.Exists(destination)) File.Copy(file, destination, overwrite: false);
            if (!variant && Hash(file) != Hash(destination)) throw new IOException("thumbnail-copy-verification-failed");
            canonical[file] = destination;
        }
        // Identical exports can have different names. Prefer stable catalogue names,
        // then retain one verified copy and redirect all bindings to that copy.
        var keys = initial.Items.Select(i => i.SourceKey).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var group in canonical.Values.Distinct(StringComparer.OrdinalIgnoreCase).GroupBy(Hash))
        {
            string keep = group.OrderBy(p => keys.Contains(Path.GetFileNameWithoutExtension(p)) ? 0 : 1)
                .ThenBy(p => p, StringComparer.OrdinalIgnoreCase).First();
            var duplicates = group.Where(p => !SamePath(p, keep)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (string source in canonical.Keys.ToArray())
                if (duplicates.Contains(canonical[source])) canonical[source] = keep;
            foreach (string duplicate in duplicates) canonical[duplicate] = keep;
        }
        var plannedBindings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach ((string original, string item) in bindings)
        {
            if (!canonical.TryGetValue(original, out string? destination)) continue;
            string hash = Hash(destination);
            if (plannedBindings.TryGetValue(hash, out string? previous) && previous != item)
                throw new IOException("Consolidation would merge thumbnails bound to different catalogue entries.");
            plannedBindings[hash] = item;
        }
        // Back up and validate all removals before deleting any of them.
        foreach ((string source, string destination) in canonical.Where(p => !SamePath(p.Key, p.Value)))
        {
            string authorized = sources.First(r =>
            {
                string relative = Path.GetRelativePath(r, source);
                return !Path.IsPathRooted(relative) && relative != ".."
                    && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
            });
            SafePath(authorized, source); SafePath(root, destination);
            string saved = Path.Combine(backup, Hash(source) + Path.GetExtension(source));
            if (!File.Exists(saved)) File.Copy(source, saved, false);
            if (Hash(saved) != Hash(source)) throw new IOException("thumbnail-backup-verification-failed");
            result.Removed.Add(new(source, destination, saved, Hash(source), Hash(destination)));
        }
        File.WriteAllText(report, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
        foreach (var removal in result.Removed)
        {
            if (Hash(removal.Source) != removal.SourceHash || Hash(removal.Destination) != removal.DestinationHash)
                throw new IOException("thumbnail-changed-during-cleanup");
            File.Delete(removal.Source);
        }
        store.ScanThumbnails(root);
        foreach ((string original, string item) in bindings)
            if (canonical.TryGetValue(original, out string? destination)) Bind(store, database, destination, item);

        using var client = ThumbnailPosterRecovery.CreateClient();
        var recovery = new ThumbnailPosterRecovery(client);
        foreach (var item in store.GetCatalogue().Items.Where(i => i.ThumbnailAssetId is null))
        {
            if (!Regex.IsMatch(item.SourceKey, "^[a-zA-Z0-9-]{1,200}$")) { result.Unresolved.Add(item.SourceKey); continue; }
            var failures = new List<string>();
            byte[]? bytes = await recovery.Recover(item, diagnostic: failures.Add).ConfigureAwait(false);
            if (bytes is null) result.Failures[item.SourceKey] = failures.Count > 0 ? failures : ["No saved ManyVids or Pornhub link"];
            if (bytes is null) result.Unresolved.Add(item.SourceKey);
            else
            {
                string destination = Path.Combine(root, item.SourceKey + ".png");
                SafePath(root, destination);
                using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) output.Write(bytes);
                result.Recovered.Add(item.SourceKey);
            }
            File.WriteAllText(report, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
        }
        store.ScanThumbnails(root);
        foreach (string key in result.Recovered)
            Bind(store, database, Path.Combine(root, key + ".png"), store.GetItems().Single(i => i.SourceKey == key).ItemId);
        result.After = store.GetCatalogue().Items.Count(i => i.ThumbnailAssetId is not null);
        result.Complete = true;
        File.WriteAllText(report, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static void Bind(CatalogueStore store, string database, string file, string item)
    {
        using var connection = new SqliteConnection($"Data Source={database};Mode=ReadOnly;Pooling=False"); connection.Open();
        using var query = connection.CreateCommand();
        query.CommandText = "SELECT asset_id FROM media_assets WHERE lower(sha256)=$hash AND available=1";
        query.Parameters.AddWithValue("$hash", Hash(file).ToLowerInvariant());
        string id = (string)(query.ExecuteScalar() ?? throw new IOException("thumbnail-not-indexed"));
        var asset = store.GetAssets().Single(a => a.AssetId == id);
        if (asset.BoundItemId is not null && asset.BoundItemId != item) throw new IOException("thumbnail-binding-conflict");
        store.ConfirmAssetBinding(id, item);
    }
    private sealed class MaintenanceResult
    {
        public bool Applied { get; set; }
        public bool Complete { get; set; }
        public int ImageFiles { get; set; }
        public int Before { get; set; }
        public int After { get; set; }
        public List<Removal> Removed { get; set; } = [];
        public List<string> Recovered { get; set; } = [];
        public List<string> Unresolved { get; set; } = [];
        public Dictionary<string, List<string>> Failures { get; set; } = [];
    }
    private sealed record Removal(string Source, string Destination, string Backup, string SourceHash, string DestinationHash);
}
