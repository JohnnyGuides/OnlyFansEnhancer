using System.IO;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

// Owner-invoked local archive import. The desktop remains the sole writer;
// the ordinary agent must be stopped before maintenance takes its mutex.
internal static class XArchiveMaintenance
{
    internal static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        bool mapping = args.Contains("--map-x-teasers", StringComparer.Ordinal);
        if (!mapping && !args.Contains("--import-x-archive", StringComparer.Ordinal)) return false;
        string? Option(string name)
        {
            int index = Array.IndexOf(args, name);
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        }
        string? report = Option("--result");
        try
        {
            if (report is null) throw new InvalidOperationException("archive-result-required");
            report = Path.GetFullPath(report);
            if (File.Exists(report)) throw new InvalidOperationException("archive-result-exists");
            Directory.CreateDirectory(Path.GetDirectoryName(report)!);
            string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
            using Mutex writer = new(true, $"Local\\OFEnhancer.Desktop.{userKey}", out bool acquired);
            if (!acquired) throw new InvalidOperationException("desktop-must-be-stopped");
            try
            {
                string folder = Path.GetFullPath(Option(mapping ? "--map-x-teasers" : "--import-x-archive")
                    ?? throw new InvalidOperationException("archive-folder-required"));
                string database = Path.GetFullPath(Option("--catalogue-database") ?? AppConfiguration.CatalogueDatabasePath);
                if (!File.Exists(database)) throw new InvalidOperationException("catalogue-required");
                bool apply = args.Contains("--apply", StringComparer.Ordinal);
                if (apply)
                {
                    string backup = report + ".backup.sqlite";
                    if (File.Exists(backup)) throw new InvalidOperationException("archive-backup-exists");
                    using SqliteConnection source = new(new SqliteConnectionStringBuilder
                        { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
                    using SqliteConnection target = new(new SqliteConnectionStringBuilder
                        { DataSource = backup, Pooling = false }.ToString());
                    source.Open();
                    target.Open();
                    source.BackupDatabase(target);
                }
                using CatalogueStore store = CatalogueStore.Open(database);
                object result;
                if (mapping)
                {
                    if (new FileInfo(folder).Length > 131072) throw new InvalidOperationException("mapping-input-limit");
                    var choices = JsonSerializer.Deserialize<List<XOwnerMapping>>(File.ReadAllText(folder),
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true,
                            UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow })
                        ?? throw new InvalidOperationException("mapping-invalid");
                    result = store.MapXTeasers(choices, DateTimeOffset.UtcNow, apply);
                }
                else result = store.ImportXArchive(folder, DateTimeOffset.UtcNow, apply);
                File.WriteAllText(report, JsonSerializer.Serialize(result,
                    new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true }));
            }
            finally { writer.ReleaseMutex(); }
        }
        catch (Exception error)
        {
            exitCode = 1;
            // Never export paths, post contents or private archive data in errors.
            string code = error is XObservationException x ? x.Code
                : error is InvalidOperationException invalid && (invalid.Message.StartsWith("archive-", StringComparison.Ordinal) || invalid.Message.StartsWith("mapping-", StringComparison.Ordinal))
                    ? invalid.Message : error.Message == "desktop-must-be-stopped" ? error.Message : "archive-import-failed";
            if (report is not null)
                File.WriteAllText(report + ".error.json", JsonSerializer.Serialize(new { error = code }));
        }
        return true;
    }
}
