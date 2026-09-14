using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CatalogueStoreTests
{
    [TestMethod]
    public void NativeSqliteIncludesTheAggregateMemoryCorruptionFix()
    {
        using SqliteConnection connection = new("Data Source=:memory:");
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT sqlite_version()";
        Version version = Version.Parse((string)command.ExecuteScalar()!);
        Assert.IsTrue(version >= new Version(3, 50, 2), $"Native SQLite {version} predates CVE-2025-6965 remediation.");
    }

    [TestMethod]
    public void VersionTwoUpgradePreservesRowsAndAddsEmptySourceLinkEvidence()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore oldStore = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne, Migrations.VersionTwo]))
        {
            using SqliteCommand command = oldStore.Connection.CreateCommand();
            command.CommandText = "INSERT INTO catalogue_items(item_id,source_key,title,description,updated_utc) VALUES ('kept-id','kept-key','Kept title','','2026-09-08T12:00:00Z')";
            command.ExecuteNonQuery();
        }
        using CatalogueStore store = CatalogueStore.Open(databasePath);
        CatalogueItemSummary item = store.GetItems().Single();
        Assert.AreEqual("kept-id", item.ItemId);
        Assert.AreEqual("Kept title", item.Title);
        Assert.AreEqual(0, item.SourceLinkCells!.Count);
        Assert.AreEqual(3, store.SchemaVersion);
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v2-*.sqlite").Length);
    }

    [TestMethod]
    public void LatestSchemaKeepsTheExistingTableSet()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");

        using CatalogueStore store = CatalogueStore.Open(databasePath);

        Assert.AreEqual(3, store.SchemaVersion);
        CollectionAssert.AreEqual(
            new[]
            {
                "asset_bindings",
                "audit_events",
                "catalogue_items",
                "google_row_bindings",
                "media_assets",
                "settings",
                "sync_outbox",
            },
            ReadUserTables(databasePath)
        );
        Assert.AreEqual("ok", ReadIntegrity(databasePath));
    }

    [TestMethod]
    public void VersionOneFixtureMigratesWithVerifiedSiblingBackup()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore store = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne]))
        {
            using SqliteCommand command = store.Connection.CreateCommand();
            command.CommandText = "INSERT INTO settings(key, value) VALUES ('sentinel', 'kept')";
            command.ExecuteNonQuery();
        }

        using CatalogueStore migrated = CatalogueStore.Open(databasePath);
        Assert.AreEqual(3, ReadVersion(databasePath));
        Assert.AreEqual("kept", ReadSetting(databasePath, "sentinel"));
        Assert.AreEqual("ok", ReadIntegrity(databasePath));
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v1-*.sqlite").Length);
    }

    [TestMethod]
    public void FailedVersionThreeMigrationRestoresExactSchemaTwoRows()
    {
        using TempDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        string itemId = Guid.NewGuid().ToString("D");
        string operationId = Guid.NewGuid().ToString("D");
        const string fingerprint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const string createdUtc = "2026-09-04T10:00:00.0000000+00:00";
        const string attemptedUtc = "2026-09-04T10:01:00.0000000+00:00";
        using (CatalogueStore store = CatalogueStore.OpenForTesting(databasePath, [Migrations.VersionOne, Migrations.VersionTwo]))
        {
            using SqliteCommand command = store.Connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO settings(key, value) VALUES ('sentinel', 'kept');
                INSERT INTO catalogue_items(
                    item_id, source_key, source_row, title, description, planned_date,
                    series, episode, x_teasers, reddit_teasers, platform_links_json,
                    archived, updated_utc
                ) VALUES (
                    $itemId, 'restore-source', 77, 'Restored title', 'Restored description',
                    '2026-09-04', 'Restore', '07', 2, 1, '{"onlyfans":"https://onlyfans.com/123456789/johnny_guides"}',
                    0, $createdUtc
                );
                INSERT INTO google_row_bindings(
                    workbook_id, sheet_id, item_id, metadata_id, last_observed_row,
                    verified_remote_fingerprint, verified_utc
                ) VALUES ('restore-workbook', '2126708696', $itemId, $itemId, 77, $fingerprint, $createdUtc);
                INSERT INTO sync_outbox(
                    operation_id, idempotency_key, item_id, workbook_id, sheet_id,
                    metadata_key, metadata_value, destination_field, payload_value,
                    expected_remote_fingerprint, intended_value_fingerprint, state,
                    attempt_count, error_code, created_utc, attempted_utc, completed_utc, resolved_utc
                ) VALUES (
                    $operationId, 'restore-operation', $itemId, 'restore-workbook', '2126708696',
                    'ofenhancer.item_id.v1', $itemId, 'onlyfans', 'https://onlyfans.com/123456789/johnny_guides',
                    $fingerprint, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'attempted',
                    1, 'network-uncertain', $createdUtc, $attemptedUtc, NULL, NULL
                );
                """;
            command.Parameters.AddWithValue("$itemId", itemId);
            command.Parameters.AddWithValue("$operationId", operationId);
            command.Parameters.AddWithValue("$fingerprint", fingerprint);
            command.Parameters.AddWithValue("$createdUtc", createdUtc);
            command.Parameters.AddWithValue("$attemptedUtc", attemptedUtc);
            command.ExecuteNonQuery();
        }

        CatalogueMigrationException exception = Assert.ThrowsException<CatalogueMigrationException>(
            () => CatalogueStore.OpenForTesting(
                databasePath,
                [Migrations.VersionOne, Migrations.VersionTwo, new MigrationStep(3, "CREATE TABLE broken(")]
            )
        );

        StringAssert.Contains(exception.Message, "restored");
        Assert.AreEqual(2, ReadVersion(databasePath));
        Assert.AreEqual("kept", ReadSetting(databasePath, "sentinel"));
        CollectionAssert.Contains(ReadUserTables(databasePath), "google_row_bindings");
        CollectionAssert.Contains(ReadUserTables(databasePath), "sync_outbox");
        CollectionAssert.AreEqual(
            new[]
            {
                itemId, "restore-source", "77", "Restored title", "Restored description",
                "2026-09-04", "Restore", "07", "2", "1",
                "{\"onlyfans\":\"https://onlyfans.com/123456789/johnny_guides\"}", "0", createdUtc,
            },
            ReadRow(databasePath, "SELECT item_id, source_key, source_row, title, description, planned_date, series, episode, x_teasers, reddit_teasers, platform_links_json, archived, updated_utc FROM catalogue_items")
        );
        CollectionAssert.AreEqual(
            new[] { "restore-workbook", "2126708696", itemId, itemId, "77", fingerprint, createdUtc },
            ReadRow(databasePath, "SELECT workbook_id, sheet_id, item_id, metadata_id, last_observed_row, verified_remote_fingerprint, verified_utc FROM google_row_bindings")
        );
        CollectionAssert.AreEqual(
            new[]
            {
                operationId, "restore-operation", itemId, "restore-workbook", "2126708696",
                "ofenhancer.item_id.v1", itemId, "onlyfans", "https://onlyfans.com/123456789/johnny_guides",
                fingerprint, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "attempted",
                "1", "network-uncertain", createdUtc, attemptedUtc, "<null>", "<null>",
            },
            ReadRow(databasePath, "SELECT operation_id, idempotency_key, item_id, workbook_id, sheet_id, metadata_key, metadata_value, destination_field, payload_value, expected_remote_fingerprint, intended_value_fingerprint, state, attempt_count, error_code, created_utc, attempted_utc, completed_utc, resolved_utc FROM sync_outbox")
        );
        Assert.AreEqual("ok", ReadIntegrity(databasePath));
        Assert.AreEqual(1, Directory.GetFiles(temp.Path, "catalogue.db.backup-v2-*.sqlite").Length);
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

    private static string[] ReadRow(string path, string sql)
    {
        using SqliteConnection connection = Open(path);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        using SqliteDataReader reader = command.ExecuteReader();
        Assert.IsTrue(reader.Read());
        string[] values = new string[reader.FieldCount];
        for (int index = 0; index < values.Length; index++)
            values[index] = reader.IsDBNull(index) ? "<null>" : Convert.ToString(reader.GetValue(index))!;
        Assert.IsFalse(reader.Read());
        return values;
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
