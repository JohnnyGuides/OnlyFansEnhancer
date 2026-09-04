using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

internal static class ThumbnailInventory
{
    internal const int DefaultMaximumFiles = 20_000;
    internal const string DefaultRoot = @"D:\MEDIA - SELFMADE\Youtube2\.DONE_DEEDS\.thumbs";
    private const string RootSetting = "thumbnails.root";
    private static readonly HashSet<string> Extensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
    };

    internal static ThumbnailScanSummary Scan(
        SqliteConnection connection,
        string root,
        int maximumFiles
    )
    {
        if (maximumFiles <= 0 || maximumFiles > DefaultMaximumFiles)
            throw new ArgumentOutOfRangeException(nameof(maximumFiles));

        string fullRoot;
        try
        {
            fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw new CatalogueInventoryException("invalid-thumbnail-root", "Thumbnail folder is invalid.", exception);
        }
        if (!Directory.Exists(fullRoot))
            throw new CatalogueInventoryException("thumbnail-root-missing", "Thumbnail folder does not exist.");
        if ((File.GetAttributes(fullRoot) & FileAttributes.ReparsePoint) != 0)
            throw new CatalogueInventoryException("unsafe-thumbnail-root", "Thumbnail folder cannot be a reparse point.");

        IReadOnlyList<ScannedFile> files = ReadFiles(fullRoot, maximumFiles);
        string now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        int newAssets = 0;
        using SqliteTransaction transaction = connection.BeginTransaction();
        Execute(
            connection,
            transaction,
            "UPDATE media_assets SET available = 0, updated_utc = $now WHERE scan_root = $root",
            ("$now", now),
            ("$root", fullRoot)
        );

        foreach (ScannedFile file in files)
        {
            string? existingId = ReadAssetId(connection, transaction, file.Sha256);
            if (existingId is null)
                newAssets++;
            string assetId = existingId ?? Guid.NewGuid().ToString("D");
            using SqliteCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                """
                INSERT INTO media_assets(
                    asset_id, sha256, role, file_name, absolute_path, scan_root,
                    size_bytes, last_write_utc, available, updated_utc
                ) VALUES (
                    $assetId, $sha256, $role, $fileName, $absolutePath, $root,
                    $sizeBytes, $lastWriteUtc, 1, $now
                )
                ON CONFLICT(sha256) DO UPDATE SET
                    role = excluded.role,
                    file_name = excluded.file_name,
                    absolute_path = excluded.absolute_path,
                    scan_root = excluded.scan_root,
                    size_bytes = excluded.size_bytes,
                    last_write_utc = excluded.last_write_utc,
                    available = 1,
                    updated_utc = excluded.updated_utc
                """;
            command.Parameters.AddWithValue("$assetId", assetId);
            command.Parameters.AddWithValue("$sha256", file.Sha256);
            command.Parameters.AddWithValue("$role", file.Role);
            command.Parameters.AddWithValue("$fileName", file.FileName);
            command.Parameters.AddWithValue("$absolutePath", file.AbsolutePath);
            command.Parameters.AddWithValue("$root", fullRoot);
            command.Parameters.AddWithValue("$sizeBytes", file.SizeBytes);
            command.Parameters.AddWithValue("$lastWriteUtc", file.LastWriteUtc);
            command.Parameters.AddWithValue("$now", now);
            command.ExecuteNonQuery();
        }

        Execute(
            connection,
            transaction,
            "INSERT INTO settings(key, value) VALUES ($key, $root) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("$key", RootSetting),
            ("$root", fullRoot)
        );
        int unavailable = ScalarInt(
            connection,
            transaction,
            "SELECT count(*) FROM media_assets WHERE scan_root = $root AND available = 0",
            ("$root", fullRoot)
        );
        string details = JsonSerializer.Serialize(
            new { availableAssets = files.Count, newAssets, unavailableAssets = unavailable }
        );
        Execute(
            connection,
            transaction,
            "INSERT INTO audit_events(occurred_utc, kind, details_json) VALUES ($now, 'thumbnails-scanned', $details)",
            ("$now", now),
            ("$details", details)
        );
        transaction.Commit();
        return new ThumbnailScanSummary(files.Count, newAssets, unavailable);
    }

    internal static bool IsContainedPath(string root, string candidate)
    {
        string fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        string fullCandidate = Path.GetFullPath(candidate);
        string relative = Path.GetRelativePath(fullRoot, fullCandidate);
        return relative.Length > 0
            && !Path.IsPathRooted(relative)
            && !string.Equals(relative, "..", StringComparison.Ordinal)
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal);
    }

    internal static string? ReadConfiguredRoot(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key = $key";
        command.Parameters.AddWithValue("$key", RootSetting);
        return command.ExecuteScalar() as string;
    }

    private static IReadOnlyList<ScannedFile> ReadFiles(string root, int maximumFiles)
    {
        List<string> paths = [];
        Stack<string> directories = new();
        directories.Push(root);
        try
        {
            while (directories.TryPop(out string? directory))
            {
                foreach (string childDirectory in Directory.EnumerateDirectories(directory))
                {
                    if ((File.GetAttributes(childDirectory) & FileAttributes.ReparsePoint) == 0)
                        directories.Push(childDirectory);
                }

                foreach (string file in Directory.EnumerateFiles(directory))
                {
                    if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                        continue;
                    if (!Extensions.Contains(Path.GetExtension(file)))
                        continue;
                    if (!IsContainedPath(root, file))
                        throw new CatalogueInventoryException(
                            "thumbnail-path-escape",
                            "A thumbnail resolved outside the configured folder."
                        );
                    paths.Add(Path.GetFullPath(file));
                    if (paths.Count > maximumFiles)
                        throw new CatalogueInventoryException(
                            "too-many-thumbnails",
                            $"Thumbnail folder contains more than {maximumFiles} supported files."
                        );
                }
            }
        }
        catch (CatalogueInventoryException)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new CatalogueInventoryException(
                "thumbnail-scan-failed",
                "Thumbnail folder could not be read completely.",
                exception
            );
        }

        paths.Sort(StringComparer.OrdinalIgnoreCase);
        List<ScannedFile> result = new(paths.Count);
        foreach (string path in paths)
        {
            FileInfo info = new(path);
            string sha256;
            try
            {
                using FileStream stream = new(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    bufferSize: 128 * 1024,
                    FileOptions.SequentialScan
                );
                sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new CatalogueInventoryException(
                    "thumbnail-read-failed",
                    $"Thumbnail could not be read: {info.Name}",
                    exception
                );
            }
            result.Add(
                new ScannedFile(
                    info.Name,
                    path,
                    info.Length,
                    info.LastWriteTimeUtc.ToString("O", CultureInfo.InvariantCulture),
                    sha256,
                    ClassifyRole(Path.GetFileNameWithoutExtension(info.Name))
                )
            );
        }
        return result;
    }

    private static string ClassifyRole(string stem)
    {
        string normalized = stem.ToLowerInvariant().Replace('-', '_');
        string[] tokens = normalized.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Contains("33", StringComparer.Ordinal))
            return "pornhub-33";
        if (tokens.Contains("4k", StringComparer.Ordinal))
            return "clips4sale-4k";
        return "curated";
    }

    private static string? ReadAssetId(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sha256
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT asset_id FROM media_assets WHERE sha256 = $sha256";
        command.Parameters.AddWithValue("$sha256", sha256);
        return command.ExecuteScalar() as string;
    }

    private static int ScalarInt(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sql,
        params (string Name, object Value)[] parameters
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach ((string name, object value) in parameters)
            command.Parameters.AddWithValue(name, value);
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private static void Execute(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sql,
        params (string Name, object Value)[] parameters
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach ((string name, object value) in parameters)
            command.Parameters.AddWithValue(name, value);
        command.ExecuteNonQuery();
    }

    private sealed record ScannedFile(
        string FileName,
        string AbsolutePath,
        long SizeBytes,
        string LastWriteUtc,
        string Sha256,
        string Role
    );
}

public sealed class CatalogueInventoryException : Exception
{
    public CatalogueInventoryException(string code, string message)
        : base(message) => Code = code;

    public CatalogueInventoryException(string code, string message, Exception innerException)
        : base(message, innerException) => Code = code;

    public string Code { get; }
}

public sealed partial class CatalogueStore
{
    public ThumbnailScanSummary ScanThumbnails(string root) =>
        ThumbnailInventory.Scan(connection, root, ThumbnailInventory.DefaultMaximumFiles);

    internal ThumbnailScanSummary ScanThumbnails(string root, int maximumFiles) =>
        ThumbnailInventory.Scan(connection, root, maximumFiles);

    public string DefaultThumbnailRoot => ThumbnailInventory.DefaultRoot;

    public string? ConfiguredThumbnailRoot => ThumbnailInventory.ReadConfiguredRoot(connection);

    public IReadOnlyList<MediaAssetSummary> GetAssets(bool includeUnavailable = false)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT a.asset_id, a.file_name, a.role, a.size_bytes, a.available, b.item_id
            FROM media_assets a
            LEFT JOIN asset_bindings b ON b.asset_id = a.asset_id
            WHERE $includeUnavailable = 1 OR a.available = 1
            ORDER BY a.file_name COLLATE NOCASE, a.asset_id
            """;
        command.Parameters.AddWithValue("$includeUnavailable", includeUnavailable ? 1 : 0);
        using SqliteDataReader reader = command.ExecuteReader();
        List<MediaAssetSummary> assets = [];
        while (reader.Read())
        {
            assets.Add(
                new MediaAssetSummary(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetInt64(3),
                    reader.GetInt32(4) == 1,
                    reader.IsDBNull(5) ? null : reader.GetString(5)
                )
            );
        }
        return assets;
    }

    internal string? ResolveAvailableAssetPath(string assetId)
    {
        if (!Guid.TryParse(assetId, out _))
            return null;
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            "SELECT absolute_path, scan_root FROM media_assets WHERE asset_id = $assetId AND available = 1";
        command.Parameters.AddWithValue("$assetId", assetId);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
            return null;
        string path = reader.GetString(0);
        string root = reader.GetString(1);
        return ThumbnailInventory.IsContainedPath(root, path) && File.Exists(path) ? path : null;
    }
}
