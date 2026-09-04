using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Win32.SafeHandles;

namespace OFEnhancer.Catalogue;

internal static class ThumbnailInventory
{
    internal const int DefaultMaximumFiles = 20_000;
    internal const string RootSetting = "thumbnails.root";
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
        int maximumFiles,
        Action<string>? beforeOpenFile = null
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

        IReadOnlyList<ScannedFile> files = ReadFiles(fullRoot, maximumFiles, beforeOpenFile);
        string now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        int newAssets = 0;
        using SqliteTransaction transaction = connection.BeginTransaction();
        Execute(
            connection,
            transaction,
            "UPDATE media_assets SET available = 0, updated_utc = $now",
            ("$now", now)
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
            "SELECT count(*) FROM media_assets WHERE available = 0"
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

    private static IReadOnlyList<ScannedFile> ReadFiles(
        string root,
        int maximumFiles,
        Action<string>? beforeOpenFile
    )
    {
        using SafeFileHandle rootHandle = WindowsFinalPath.OpenDirectory(root);
        string finalRoot = WindowsFinalPath.Read(rootHandle);
        if (!WindowsFinalPath.IsSamePath(root, finalRoot))
            throw new CatalogueInventoryException(
                "unsafe-thumbnail-root",
                "Thumbnail folder cannot resolve through a reparse point."
            );
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
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or Win32Exception)
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
            try
            {
                beforeOpenFile?.Invoke(path);
                using FileStream stream = new(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    bufferSize: 128 * 1024,
                    FileOptions.SequentialScan
                );
                string finalPath = WindowsFinalPath.Read(stream.SafeFileHandle);
                if (!IsContainedPath(finalRoot, finalPath))
                    throw new CatalogueInventoryException(
                        "thumbnail-path-escape",
                        "A thumbnail resolved outside the configured folder."
                    );
                string sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                string fileName = Path.GetFileName(path);
                result.Add(
                    new ScannedFile(
                        fileName,
                        path,
                        stream.Length,
                        File.GetLastWriteTimeUtc(stream.SafeFileHandle)
                            .ToString("O", CultureInfo.InvariantCulture),
                        sha256,
                        ClassifyRole(Path.GetFileNameWithoutExtension(fileName))
                    )
                );
            }
            catch (CatalogueInventoryException)
            {
                throw;
            }
            catch (Exception exception)
                when (exception is IOException or UnauthorizedAccessException or Win32Exception)
            {
                throw new CatalogueInventoryException(
                    "thumbnail-read-failed",
                    $"Thumbnail could not be read: {Path.GetFileName(path)}",
                    exception
                );
            }
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

    internal ThumbnailScanSummary ScanThumbnails(
        string root,
        int maximumFiles,
        Action<string> beforeOpenFile
    ) => ThumbnailInventory.Scan(connection, root, maximumFiles, beforeOpenFile);

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

    internal AvailableAssetLocation? ResolveAvailableAssetLocation(string assetId)
    {
        if (!Guid.TryParse(assetId, out _))
            return null;
        using SqliteConnection readConnection = new(
            new SqliteConnectionStringBuilder
            {
                DataSource = DatabasePath,
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Private,
                Pooling = false,
            }.ToString()
        );
        readConnection.Open();
        using SqliteCommand command = readConnection.CreateCommand();
        command.CommandText =
            """
            SELECT a.absolute_path, a.scan_root, a.sha256
            FROM media_assets a
            JOIN settings s ON s.key = $rootKey AND s.value = a.scan_root
            WHERE a.asset_id = $assetId AND a.available = 1
            """;
        command.Parameters.AddWithValue("$assetId", assetId);
        command.Parameters.AddWithValue("$rootKey", ThumbnailInventory.RootSetting);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
            return null;
        string path = reader.GetString(0);
        string root = reader.GetString(1);
        return ThumbnailInventory.IsContainedPath(root, path) && File.Exists(path)
            ? new AvailableAssetLocation(path, root, reader.GetString(2))
            : null;
    }
}

internal sealed record AvailableAssetLocation(string Path, string ScanRoot, string Sha256);

internal static class WindowsFinalPath
{
    private const uint FileFlagBackupSemantics = 0x02000000;

    internal static SafeFileHandle OpenDirectory(string path)
    {
        SafeFileHandle handle = CreateFile(
            path,
            0,
            FileShare.Read | FileShare.Write | FileShare.Delete,
            IntPtr.Zero,
            FileMode.Open,
            FileFlagBackupSemantics,
            IntPtr.Zero
        );
        if (!handle.IsInvalid)
            return handle;
        int error = Marshal.GetLastPInvokeError();
        handle.Dispose();
        throw new Win32Exception(error);
    }

    internal static string Read(SafeFileHandle handle)
    {
        int capacity = 512;
        while (true)
        {
            StringBuilder buffer = new(capacity);
            uint result = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (result == 0)
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            if (result < buffer.Capacity)
                return Normalize(buffer.ToString());
            capacity = checked((int)result + 1);
        }
    }

    internal static bool IsSamePath(string left, string right) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            StringComparison.OrdinalIgnoreCase
        );

    private static string Normalize(string path) =>
        path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
            ? @"\\" + path[8..]
            : path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)
                ? path[4..]
                : path;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        FileShare shareMode,
        IntPtr securityAttributes,
        FileMode creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        [Out] StringBuilder filePath,
        uint filePathLength,
        uint flags
    );
}
