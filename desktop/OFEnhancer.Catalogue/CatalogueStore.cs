using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed partial class CatalogueStore : IDisposable
{
    private readonly SqliteConnection connection;

    private CatalogueStore(string databasePath, SqliteConnection connection)
    {
        DatabasePath = databasePath;
        this.connection = connection;
    }

    public string DatabasePath { get; }

    public int SchemaVersion => ReadVersion(connection);

    internal SqliteConnection Connection => connection;

    public static CatalogueStore Open(string databasePath) =>
        OpenCore(databasePath, Migrations.All);

    internal static CatalogueStore OpenForTesting(
        string databasePath,
        IReadOnlyList<MigrationStep> migrations
    ) => OpenCore(databasePath, migrations);

    public void Dispose() => connection.Dispose();

    private static CatalogueStore OpenCore(
        string databasePath,
        IReadOnlyList<MigrationStep> migrations
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        ValidateMigrations(migrations);

        string fullPath = Path.GetFullPath(databasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        bool hadContent = File.Exists(fullPath) && new FileInfo(fullPath).Length > 0;
        string? backupPath = null;
        SqliteConnection? connection = null;

        try
        {
            connection = CreateConnection(fullPath);
            connection.Open();
            Configure(connection);

            int currentVersion = ReadVersion(connection);
            int targetVersion = migrations[^1].Version;
            if (currentVersion > targetVersion)
                throw new CatalogueMigrationException(
                    $"Catalogue schema {currentVersion} is newer than supported schema {targetVersion}."
                );

            if (currentVersion < targetVersion)
            {
                if (hadContent)
                    backupPath = CreateVerifiedBackup(connection, fullPath, currentVersion);
                ApplyMigrations(connection, migrations, currentVersion);
            }

            VerifyIntegrity(connection);
            return new CatalogueStore(fullPath, connection);
        }
        catch (Exception exception) when (backupPath is not null)
        {
            connection?.Dispose();
            RestoreVerifiedBackup(backupPath, fullPath);
            throw new CatalogueMigrationException(
                "Catalogue migration failed; the verified previous database was restored.",
                exception
            );
        }
        catch
        {
            connection?.Dispose();
            throw;
        }
    }

    private static void ValidateMigrations(IReadOnlyList<MigrationStep> migrations)
    {
        if (migrations.Count == 0)
            throw new ArgumentException("At least one migration is required.", nameof(migrations));
        for (int index = 0; index < migrations.Count; index++)
        {
            if (migrations[index].Version != index + 1 || string.IsNullOrWhiteSpace(migrations[index].Sql))
                throw new ArgumentException("Migrations must be non-empty and contiguous from version 1.", nameof(migrations));
        }
    }

    private static SqliteConnection CreateConnection(string path) =>
        new(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Cache = SqliteCacheMode.Private,
                Pooling = false,
            }.ToString()
        );

    private static void Configure(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;";
        command.ExecuteNonQuery();
    }

    private static int ReadVersion(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version";
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private static void ApplyMigrations(
        SqliteConnection connection,
        IReadOnlyList<MigrationStep> migrations,
        int currentVersion
    )
    {
        using SqliteTransaction transaction = connection.BeginTransaction();
        foreach (MigrationStep migration in migrations.Where(item => item.Version > currentVersion))
        {
            using SqliteCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = migration.Sql;
            command.ExecuteNonQuery();

            using SqliteCommand version = connection.CreateCommand();
            version.Transaction = transaction;
            version.CommandText = $"PRAGMA user_version = {migration.Version}";
            version.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    private static string CreateVerifiedBackup(
        SqliteConnection source,
        string databasePath,
        int currentVersion
    )
    {
        string timestamp = DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ", CultureInfo.InvariantCulture);
        string backupPath = $"{databasePath}.backup-v{currentVersion}-{timestamp}.sqlite";
        using SqliteConnection backup = CreateConnection(backupPath);
        backup.Open();
        source.BackupDatabase(backup);
        VerifyIntegrity(backup);
        return backupPath;
    }

    private static void RestoreVerifiedBackup(string backupPath, string databasePath)
    {
        using (SqliteConnection backup = CreateConnection(backupPath))
        {
            backup.Open();
            VerifyIntegrity(backup);
        }

        string restorePath = $"{databasePath}.restore-{Guid.NewGuid():N}.sqlite";
        try
        {
            File.Copy(backupPath, restorePath, overwrite: false);
            using (SqliteConnection staged = CreateConnection(restorePath))
            {
                staged.Open();
                VerifyIntegrity(staged);
            }
            File.Replace(restorePath, databasePath, null, ignoreMetadataErrors: true);
            using SqliteConnection restored = CreateConnection(databasePath);
            restored.Open();
            VerifyIntegrity(restored);
        }
        finally
        {
            if (File.Exists(restorePath))
                File.Delete(restorePath);
        }
    }

    private static void VerifyIntegrity(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA integrity_check";
        string result = Convert.ToString(command.ExecuteScalar(), CultureInfo.InvariantCulture) ?? "";
        if (!string.Equals(result, "ok", StringComparison.Ordinal))
            throw new CatalogueMigrationException($"Catalogue integrity check failed: {result}");
    }
}

public sealed class CatalogueMigrationException : Exception
{
    public CatalogueMigrationException(string message)
        : base(message) { }

    public CatalogueMigrationException(string message, Exception innerException)
        : base(message, innerException) { }
}
