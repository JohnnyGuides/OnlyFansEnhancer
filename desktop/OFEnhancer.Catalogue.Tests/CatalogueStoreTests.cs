using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CatalogueStoreTests
{
    [TestMethod]
    public void OpenFreshStoreCreatesOnlyTheVersionOneCoreTables()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");

        using CatalogueStore store = CatalogueStore.Open(databasePath);

        Assert.AreEqual(1, store.SchemaVersion);
        CollectionAssert.AreEqual(
            new[]
            {
                "asset_bindings",
                "audit_events",
                "catalogue_items",
                "media_assets",
                "settings",
            },
            ReadUserTables(databasePath)
        );
        Assert.AreEqual("ok", ReadIntegrity(databasePath));
    }

    [TestMethod]
    public void FailedMigrationRestoresTheVerifiedOriginalDatabase()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore store = CatalogueStore.Open(databasePath))
        {
            using SqliteCommand command = store.Connection.CreateCommand();
            command.CommandText = "INSERT INTO settings(key, value) VALUES ('sentinel', 'kept')";
            command.ExecuteNonQuery();
        }

        CatalogueMigrationException exception = Assert.ThrowsException<CatalogueMigrationException>(
            () =>
                CatalogueStore.OpenForTesting(
                    databasePath,
                    [Migrations.VersionOne, new MigrationStep(2, "CREATE TABLE broken(")]
                )
        );

        StringAssert.Contains(exception.Message, "restored");
        Assert.AreEqual(1, ReadVersion(databasePath));
        Assert.AreEqual("kept", ReadSetting(databasePath, "sentinel"));
        Assert.AreEqual("ok", ReadIntegrity(databasePath));
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v1-*.sqlite").Length);
        Assert.AreEqual(0, Directory.GetFiles(temp.Path, "catalogue.db.restore-*.sqlite").Length);
    }

    private static string[] ReadUserTables(string path)
    {
        using SqliteConnection connection = Open(path);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        using SqliteDataReader reader = command.ExecuteReader();
        List<string> names = [];
        while (reader.Read())
            names.Add(reader.GetString(0));
        return [.. names];
    }

    private static int ReadVersion(string path)
    {
        using SqliteConnection connection = Open(path);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    private static string ReadIntegrity(string path)
    {
        using SqliteConnection connection = Open(path);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA integrity_check";
        return Convert.ToString(command.ExecuteScalar())!;
    }

    private static string ReadSetting(string path, string key)
    {
        using SqliteConnection connection = Open(path);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key = $key";
        command.Parameters.AddWithValue("$key", key);
        return Convert.ToString(command.ExecuteScalar())!;
    }

    private static SqliteConnection Open(string path)
    {
        SqliteConnection connection = new(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        return connection;
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"ofenhancer-catalogue-{Guid.NewGuid():N}"
            );
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
