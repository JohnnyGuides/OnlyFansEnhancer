using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed class XTeaserException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public sealed record XClipFingerprint(string RelPath, long SizeBytes, string MtimeUtc, string Sha256);

public sealed record XClipScanResult(int Present, int Added, int Moved, int Missing, int Paired);

// The owner's local teaser folder: `<root>\` ready, `Done\` posted awaiting a
// verdict, `Done\Good\` and `Done\Failed\`. Other folders (for example Ideas)
// and non-video files are never indexed or touched.
public static class XTeaserFolder
{
    public const string DoneFolder = "Done";
    public static readonly string GoodFolder = Path.Combine("Done", "Good");
    public static readonly string FailedFolder = Path.Combine("Done", "Failed");
    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase) { ".mp4", ".mov", ".m4v", ".webm", ".mkv" };
    private static readonly Regex EpisodeName = new(
        @"^(?<key>[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)__t[0-9]{1,3}(?:-[A-Za-z0-9-]{1,80})?\.[A-Za-z0-9]{2,5}$",
        RegexOptions.CultureInvariant);

    internal static readonly (string Folder, string State)[] Folders =
        [("", "ready"), (DoneFolder, "posted"), (GoodFolder, "good"), (FailedFolder, "failed")];

    public static string? EpisodeKeyFromName(string fileName)
    {
        Match match = EpisodeName.Match(fileName);
        return match.Success ? match.Groups["key"].Value.ToLowerInvariant() : null;
    }

    public static string? StateForRelPath(string relPath)
    {
        string folder = Path.GetDirectoryName(relPath) ?? "";
        foreach ((string candidate, string state) in Folders)
            if (string.Equals(folder, candidate, StringComparison.OrdinalIgnoreCase)) return state;
        return null;
    }

    public static string NormalizeRoot(string root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root)) throw new XTeaserException("invalid-x-teaser-root");
        string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        if (string.Equals(full, Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full) ?? ""), StringComparison.OrdinalIgnoreCase))
            throw new XTeaserException("invalid-x-teaser-root");
        return full;
    }

    // Resolves a stored relative path to a full path that stays inside the
    // root and only passes through real (non-reparse) managed directories.
    public static string? ResolveInside(string root, string relPath)
    {
        string normalizedRoot = NormalizeRoot(root);
        if (Path.IsPathRooted(relPath) || StateForRelPath(relPath) is null) return null;
        string full = Path.GetFullPath(Path.Combine(normalizedRoot, relPath));
        if (!full.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
        string? directory = Path.GetDirectoryName(full);
        while (directory is not null && directory.Length >= normalizedRoot.Length)
        {
            if (Directory.Exists(directory) && new DirectoryInfo(directory).Attributes.HasFlag(FileAttributes.ReparsePoint)) return null;
            if (directory.Length == normalizedRoot.Length) break;
            directory = Path.GetDirectoryName(directory);
        }
        return full;
    }

    public static string Sha256(string path)
    {
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static string MtimeText(DateTime lastWriteUtc) =>
        new DateTimeOffset(DateTime.SpecifyKind(lastWriteUtc, DateTimeKind.Utc)).ToString("O", CultureInfo.InvariantCulture);

    // Lists the managed video files. The hash is reused when a known clip at
    // the same path has the same size and modification time.
    public static IReadOnlyList<XClipFingerprint> Scan(string root, IReadOnlyList<XClipFingerprint> known)
    {
        string normalizedRoot = NormalizeRoot(root);
        DirectoryInfo rootInfo = new(normalizedRoot);
        if (!rootInfo.Exists || rootInfo.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new XTeaserException("x-teaser-root-unavailable");
        Dictionary<string, XClipFingerprint> byPath = new(StringComparer.OrdinalIgnoreCase);
        foreach (XClipFingerprint clip in known) byPath.TryAdd(clip.RelPath, clip);
        List<XClipFingerprint> result = [];
        foreach ((string folder, _) in Folders)
        {
            string directory = Path.Combine(normalizedRoot, folder);
            if (!Directory.Exists(directory) || ResolveInside(normalizedRoot, Path.Combine(folder, "probe.mp4")) is null) continue;
            foreach (FileInfo file in new DirectoryInfo(directory).EnumerateFiles("*", SearchOption.TopDirectoryOnly))
            {
                if (!VideoExtensions.Contains(file.Extension) || file.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                string relPath = Path.GetRelativePath(normalizedRoot, file.FullName);
                string mtime = MtimeText(file.LastWriteTimeUtc);
                try
                {
                    string sha = byPath.TryGetValue(relPath, out XClipFingerprint? previous)
                        && previous.SizeBytes == file.Length && previous.MtimeUtc == mtime
                        ? previous.Sha256
                        : Sha256(file.FullName);
                    result.Add(new(relPath, file.Length, mtime, sha));
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        return result;
    }
}

public sealed partial class CatalogueStore
{
    internal static readonly TimeSpan XClipPairingWindow = TimeSpan.FromDays(3);
    private const string XRevertImportedSetting = "x.clips.revert-list.sha256";

    public IReadOnlyList<XClipFingerprint> GetXClipFingerprints()
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT rel_path, size_bytes, mtime_utc, sha256 FROM x_local_clips WHERE missing = 0";
        using SqliteDataReader reader = command.ExecuteReader();
        List<XClipFingerprint> rows = [];
        while (reader.Read()) rows.Add(new(reader.GetString(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3)));
        return rows;
    }

    // Applies one folder scan. A clip keeps its row (and pairing) while its
    // content hash is unchanged, wherever it moves inside the managed folders;
    // changed content at the same path is a new clip.
    public XClipScanResult ApplyXClipScan(IReadOnlyList<XClipFingerprint> files, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(files);
        string nowText = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        using SqliteTransaction transaction = connection.BeginTransaction();
        List<(long Id, string RelPath, string Sha, bool Missing)> rows = [];
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.Transaction = transaction;
            read.CommandText = "SELECT clip_id, rel_path, sha256, missing FROM x_local_clips ORDER BY missing, clip_id";
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read()) rows.Add((reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetInt64(3) == 1));
        }
        HashSet<long> claimed = [];
        Dictionary<XClipFingerprint, long> assigned = [];
        List<XClipFingerprint> pending = [];
        foreach (XClipFingerprint file in files.DistinctBy(file => file.RelPath, StringComparer.OrdinalIgnoreCase))
        {
            if (XTeaserFolder.StateForRelPath(file.RelPath) is null) continue;
            var same = rows.FirstOrDefault(row => !row.Missing && row.Sha == file.Sha256
                && string.Equals(row.RelPath, file.RelPath, StringComparison.OrdinalIgnoreCase));
            if (same.Id != 0) { claimed.Add(same.Id); assigned[file] = same.Id; }
            else pending.Add(file);
        }
        int moved = 0, added = 0;
        foreach (XClipFingerprint file in pending)
        {
            var match = rows.FirstOrDefault(row => !claimed.Contains(row.Id) && row.Sha == file.Sha256);
            if (match.Id != 0) { claimed.Add(match.Id); assigned[file] = match.Id; moved++; }
        }
        ExecuteX(transaction, "UPDATE x_local_clips SET missing = 1 WHERE missing = 0");
        foreach (XClipFingerprint file in files.DistinctBy(file => file.RelPath, StringComparer.OrdinalIgnoreCase))
        {
            string? state = XTeaserFolder.StateForRelPath(file.RelPath);
            if (state is null) continue;
            string? episodeKey = XTeaserFolder.EpisodeKeyFromName(Path.GetFileName(file.RelPath));
            if (assigned.TryGetValue(file, out long id))
                ExecuteX(transaction, """
                    UPDATE x_local_clips SET rel_path = $path, size_bytes = $size, mtime_utc = $mtime, episode_key = $key,
                        state = $state, last_seen_utc = $now, missing = 0 WHERE clip_id = $id
                    """, ("$path", file.RelPath), ("$size", file.SizeBytes), ("$mtime", file.MtimeUtc), ("$key", episodeKey),
                    ("$state", state), ("$now", nowText), ("$id", id));
            else
            {
                added++;
                ExecuteX(transaction, """
                    INSERT INTO x_local_clips (rel_path, size_bytes, mtime_utc, sha256, episode_key, state, first_seen_utc, last_seen_utc)
                    VALUES ($path, $size, $mtime, $sha, $key, $state, $now, $now)
                    """, ("$path", file.RelPath), ("$size", file.SizeBytes), ("$mtime", file.MtimeUtc), ("$sha", file.Sha256),
                    ("$key", episodeKey), ("$state", state), ("$now", nowText));
            }
        }
        int present = assigned.Count + added;
        int missing = rows.Count(row => !row.Missing && !claimed.Contains(row.Id));
        int paired = PairXClipsByTimeWindow(transaction);
        transaction.Commit();
        return new(present, added, moved, missing, paired);
    }

    // A posted clip pairs with a teaser only when exactly one teaser bound to
    // the clip's episode was posted within three days after the file's
    // modification time and no other clip claims that teaser.
    private int PairXClipsByTimeWindow(SqliteTransaction transaction)
    {
        List<(long Id, string EpisodeKey, DateTimeOffset Mtime)> clips = [];
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.Transaction = transaction;
            read.CommandText = """
                SELECT clip_id, episode_key, mtime_utc FROM x_local_clips
                WHERE missing = 0 AND status_id IS NULL AND episode_key IS NOT NULL AND state <> 'ready'
                """;
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read()) clips.Add((reader.GetInt64(0), reader.GetString(1), ParseUtc(reader.GetString(2))));
        }
        if (clips.Count == 0) return 0;
        List<(string StatusId, string SourceKey, DateTimeOffset Posted, bool Paired)> teasers = [];
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.Transaction = transaction;
            read.CommandText = """
                SELECT b.status_id, b.source_key, p.posted_utc,
                       EXISTS (SELECT 1 FROM x_local_clips c WHERE c.status_id = b.status_id)
                FROM x_post_bindings b JOIN x_posts p ON p.status_id = b.status_id
                """;
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read())
                teasers.Add((reader.GetString(0), reader.GetString(1), ParseUtc(reader.GetString(2)), reader.GetInt64(3) == 1));
        }
        Dictionary<string, List<long>> claims = new(StringComparer.Ordinal);
        foreach (var clip in clips)
        {
            var window = teasers.Where(teaser => string.Equals(teaser.SourceKey, clip.EpisodeKey, StringComparison.OrdinalIgnoreCase)
                && teaser.Posted >= clip.Mtime && teaser.Posted <= clip.Mtime + XClipPairingWindow).ToList();
            if (window.Count != 1 || window[0].Paired) continue;
            if (!claims.TryGetValue(window[0].StatusId, out List<long>? list)) claims[window[0].StatusId] = list = [];
            list.Add(clip.Id);
        }
        int paired = 0;
        foreach ((string statusId, List<long> ids) in claims.Where(pair => pair.Value.Count == 1))
        {
            ExecuteX(transaction, "UPDATE x_local_clips SET status_id = $status, pairing_evidence = 'time-window' WHERE clip_id = $id",
                ("$status", statusId), ("$id", ids[0]));
            paired++;
        }
        return paired;
    }

    // Imports the owner's 2026-10-01 rename revert list once: a row's
    // x_status_id pairs the renamed file. A status listed for more than one
    // file is skipped (never guessed).
    public int ImportXClipRevertList(string root, string csvPath, DateTimeOffset now)
    {
        string normalizedRoot = XTeaserFolder.NormalizeRoot(root);
        if (!File.Exists(csvPath) || new FileInfo(csvPath).Length > 4 * 1024 * 1024) return 0;
        byte[] bytes = File.ReadAllBytes(csvPath);
        if (ReadXSetting(XRevertImportedSetting) is not null || GetXClipFingerprints().Count == 0) return 0;
        List<string[]> records = ParseCsv(Encoding.UTF8.GetString(bytes).TrimStart('﻿'));
        if (records.Count == 0) return 0;
        int pathColumn = Array.IndexOf(records[0], "new_path"), statusColumn = Array.IndexOf(records[0], "x_status_id");
        if (pathColumn < 0 || statusColumn < 0) throw new XTeaserException("invalid-x-revert-list");
        List<(string RelPath, string StatusId)> rows = [];
        foreach (string[] record in records.Skip(1))
        {
            if (record.Length <= Math.Max(pathColumn, statusColumn)) continue;
            string status = record[statusColumn].Trim(), path = record[pathColumn].Trim();
            if (!XId.IsMatch(status) || !Path.IsPathFullyQualified(path)) continue;
            string full = Path.GetFullPath(path);
            if (!full.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
            rows.Add((Path.GetRelativePath(normalizedRoot, full), status));
        }
        using SqliteTransaction transaction = connection.BeginTransaction();
        int paired = 0;
        foreach (var group in rows.GroupBy(row => row.StatusId, StringComparer.Ordinal).Where(group => group.Count() == 1))
        {
            (string relPath, string statusId) = group.Single();
            using SqliteCommand update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = """
                UPDATE x_local_clips SET status_id = $status, pairing_evidence = 'revert-list'
                WHERE missing = 0 AND status_id IS NULL AND rel_path = $path COLLATE NOCASE
                  AND NOT EXISTS (SELECT 1 FROM x_local_clips other WHERE other.status_id = $status)
                """;
            update.Parameters.AddWithValue("$status", statusId);
            update.Parameters.AddWithValue("$path", relPath);
            paired += update.ExecuteNonQuery();
        }
        ExecuteX(transaction, "INSERT INTO settings(key, value) VALUES ($key, $value)",
            ("$key", XRevertImportedSetting), ("$value", Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()));
        ExecuteX(transaction, "INSERT INTO audit_events(occurred_utc, kind, details_json) VALUES ($now, 'x-revert-list-imported', $details)",
            ("$now", now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)),
            ("$details", $"{{\"paired\":{paired.ToString(CultureInfo.InvariantCulture)}}}"));
        transaction.Commit();
        return paired;
    }

    private string? ReadXSetting(string key)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key = $key";
        command.Parameters.AddWithValue("$key", key);
        return command.ExecuteScalar() as string;
    }

    private static List<string[]> ParseCsv(string text)
    {
        List<string[]> records = [];
        List<string> fields = [];
        StringBuilder field = new();
        bool quoted = false;
        for (int index = 0; index < text.Length; index++)
        {
            char current = text[index];
            if (quoted)
            {
                if (current == '"' && index + 1 < text.Length && text[index + 1] == '"') { field.Append('"'); index++; }
                else if (current == '"') quoted = false;
                else field.Append(current);
            }
            else if (current == '"') quoted = true;
            else if (current == ',') { fields.Add(field.ToString()); field.Clear(); }
            else if (current is '\r' or '\n')
            {
                if (current == '\r' && index + 1 < text.Length && text[index + 1] == '\n') index++;
                fields.Add(field.ToString()); field.Clear();
                if (fields.Count > 1 || fields[0].Length > 0) records.Add([.. fields]);
                fields.Clear();
            }
            else field.Append(current);
        }
        fields.Add(field.ToString());
        if (fields.Count > 1 || fields[0].Length > 0) records.Add([.. fields]);
        return records;
    }
}
