using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

internal static partial class GoogleCatalogueSettings
{
    private const string WorkbookIdKey = "google.catalogue.workbookId";
    private const string WorkbookTitleKey = "google.catalogue.workbookTitle";
    private const string SheetIdKey = "google.catalogue.sheetId";
    private const string SheetTitleKey = "google.catalogue.sheetTitle";
    private const string ProfileKey = "google.catalogue.profile";
    private const string ReadyKey = "google.catalogue.ready";
    private const string InspectedUtcKey = "google.catalogue.lastInspectedUtc";
    private const string SyncedUtcKey = "google.catalogue.lastSuccessfulSyncUtc";
    private static readonly string[] Keys =
    [
        WorkbookIdKey,
        WorkbookTitleKey,
        SheetIdKey,
        SheetTitleKey,
        ProfileKey,
        ReadyKey,
        InspectedUtcKey,
        SyncedUtcKey,
    ];

    internal static GoogleCatalogueSelection? Get(SqliteConnection connection)
    {
        Dictionary<string, string> values = Read(connection);
        if (values.Count == 0)
            return null;
        try
        {
            string workbookId = WorkbookId(Required(values, WorkbookIdKey));
            string workbookTitle = Title(Required(values, WorkbookTitleKey), "workbookTitle");
            bool hasSheet = values.ContainsKey(SheetIdKey)
                || values.ContainsKey(SheetTitleKey)
                || values.ContainsKey(ProfileKey)
                || values.ContainsKey(ReadyKey)
                || values.ContainsKey(InspectedUtcKey)
                || values.ContainsKey(SyncedUtcKey);
            if (!hasSheet)
                return new(workbookId, workbookTitle, null, null, null, false, null, null);

            string sheetId = SheetId(Required(values, SheetIdKey));
            string sheetTitle = Title(Required(values, SheetTitleKey), "sheetTitle");
            string profile = Profile(Required(values, ProfileKey));
            bool ready = Required(values, ReadyKey) switch
            {
                "1" => true,
                "0" => false,
                _ => throw Invalid("Stored Google catalogue readiness is invalid."),
            };
            DateTimeOffset inspectedUtc = Timestamp(Required(values, InspectedUtcKey));
            DateTimeOffset? syncedUtc = values.TryGetValue(SyncedUtcKey, out string? synced)
                ? Timestamp(synced)
                : null;
            return new(
                workbookId,
                workbookTitle,
                sheetId,
                sheetTitle,
                profile,
                ready,
                inspectedUtc,
                syncedUtc
            );
        }
        catch (CatalogueSettingsException)
        {
            throw;
        }
        catch
        {
            throw Invalid("Stored Google catalogue selection is invalid.");
        }
    }

    internal static void SaveWorkbook(
        SqliteConnection connection,
        string workbookId,
        string workbookTitle
    )
    {
        string id = WorkbookId(workbookId);
        string title = Title(workbookTitle, "workbookTitle");
        using SqliteTransaction transaction = connection.BeginTransaction();
        Delete(connection, transaction, Keys.Skip(2));
        Upsert(connection, transaction, WorkbookIdKey, id);
        Upsert(connection, transaction, WorkbookTitleKey, title);
        transaction.Commit();
    }

    internal static void SaveProfile(
        SqliteConnection connection,
        string workbookId,
        string sheetId,
        string sheetTitle,
        string profile,
        bool ready,
        DateTimeOffset inspectedUtc
    )
    {
        string workbook = WorkbookId(workbookId);
        string sheet = SheetId(sheetId);
        string title = Title(sheetTitle, "sheetTitle");
        string profileValue = Profile(profile);
        using SqliteTransaction transaction = connection.BeginTransaction();
        if (!string.Equals(ReadOne(connection, transaction, WorkbookIdKey), workbook, StringComparison.Ordinal))
            throw Invalid("Google catalogue workbook selection changed.");
        string? previousSheet = ReadOne(connection, transaction, SheetIdKey);
        Upsert(connection, transaction, SheetIdKey, sheet);
        Upsert(connection, transaction, SheetTitleKey, title);
        Upsert(connection, transaction, ProfileKey, profileValue);
        Upsert(connection, transaction, ReadyKey, ready ? "1" : "0");
        Upsert(connection, transaction, InspectedUtcKey, FormatTimestamp(inspectedUtc));
        if (!string.Equals(previousSheet, sheet, StringComparison.Ordinal))
            Delete(connection, transaction, [SyncedUtcKey]);
        transaction.Commit();
    }

    internal static void MarkSync(
        SqliteConnection connection,
        string workbookId,
        string sheetId,
        DateTimeOffset syncedUtc
    )
    {
        string workbook = WorkbookId(workbookId);
        string sheet = SheetId(sheetId);
        using SqliteTransaction transaction = connection.BeginTransaction();
        if (!string.Equals(ReadOne(connection, transaction, WorkbookIdKey), workbook, StringComparison.Ordinal)
            || !string.Equals(ReadOne(connection, transaction, SheetIdKey), sheet, StringComparison.Ordinal)
            || !string.Equals(ReadOne(connection, transaction, ReadyKey), "1", StringComparison.Ordinal))
        {
            throw Invalid("Google catalogue selection is not ready for sync.");
        }
        Upsert(connection, transaction, SyncedUtcKey, FormatTimestamp(syncedUtc));
        transaction.Commit();
    }

    internal static void Clear(SqliteConnection connection)
    {
        using SqliteTransaction transaction = connection.BeginTransaction();
        Delete(connection, transaction, Keys);
        using SqliteCommand bindings = connection.CreateCommand();
        bindings.Transaction = transaction;
        bindings.CommandText = "DELETE FROM google_row_bindings";
        bindings.ExecuteNonQuery();
        transaction.Commit();
    }

    private static Dictionary<string, string> Read(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"SELECT key, value FROM settings WHERE key IN ({string.Join(", ", Keys.Select((_, index) => $"$key{index}"))})";
        for (int index = 0; index < Keys.Length; index++)
            command.Parameters.AddWithValue($"$key{index}", Keys[index]);
        using SqliteDataReader reader = command.ExecuteReader();
        Dictionary<string, string> values = new(StringComparer.Ordinal);
        while (reader.Read())
            values.Add(reader.GetString(0), reader.GetString(1));
        return values;
    }

    private static string? ReadOne(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string key
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT value FROM settings WHERE key = $key";
        command.Parameters.AddWithValue("$key", key);
        return command.ExecuteScalar() as string;
    }

    private static void Upsert(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string key,
        string value
    )
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO settings(key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", value);
        command.ExecuteNonQuery();
    }

    private static void Delete(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IEnumerable<string> keys
    )
    {
        string[] selected = keys.ToArray();
        if (selected.Length == 0)
            return;
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"DELETE FROM settings WHERE key IN ({string.Join(", ", selected.Select((_, index) => $"$key{index}"))})";
        for (int index = 0; index < selected.Length; index++)
            command.Parameters.AddWithValue($"$key{index}", selected[index]);
        command.ExecuteNonQuery();
    }

    private static string Required(IReadOnlyDictionary<string, string> values, string key) =>
        values.TryGetValue(key, out string? value) ? value : throw Invalid("Stored Google catalogue selection is incomplete.");

    private static string WorkbookId(string? value) => Safe(value, 256, "workbookId", WorkbookIdPattern());

    private static string SheetId(string? value)
    {
        string result = Safe(value, 64, "sheetId", SheetIdPattern());
        return int.TryParse(result, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed)
            && parsed >= 0
            ? result
            : throw Invalid("sheetId is invalid.");
    }

    private static string Profile(string? value) => Safe(value, 64, "profile", ProfilePattern());

    private static string Safe(string? value, int maximum, string field, Regex pattern)
    {
        string result = value?.Trim() ?? "";
        if (result.Length == 0 || result.Length > maximum || !pattern.IsMatch(result))
            throw Invalid($"{field} is invalid.");
        return result;
    }

    private static string Title(string? value, string field)
    {
        string result = value?.Trim() ?? "";
        if (result.Length == 0 || result.Length > 512 || result.Any(char.IsControl))
            throw Invalid($"{field} is invalid.");
        return result;
    }

    private static DateTimeOffset Timestamp(string value) =>
        DateTimeOffset.TryParseExact(value, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset parsed)
            ? parsed.ToUniversalTime()
            : throw Invalid("Stored Google catalogue timestamp is invalid.");

    private static string FormatTimestamp(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static CatalogueSettingsException Invalid(string message) => new("invalid-google-catalogue-settings", message);

    [GeneratedRegex("^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex WorkbookIdPattern();

    [GeneratedRegex("^[0-9]+$", RegexOptions.CultureInvariant)]
    private static partial Regex SheetIdPattern();

    [GeneratedRegex("^[a-z0-9.-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex ProfilePattern();
}

public sealed partial class CatalogueStore
{
    public GoogleCatalogueSelection? GetGoogleCatalogueSelection() => GoogleCatalogueSettings.Get(connection);

    public void SaveGoogleCatalogueWorkbook(string workbookId, string workbookTitle) =>
        GoogleCatalogueSettings.SaveWorkbook(connection, workbookId, workbookTitle);

    public void SaveGoogleCatalogueProfile(
        string workbookId,
        string sheetId,
        string sheetTitle,
        string profile,
        bool ready,
        DateTimeOffset inspectedUtc
    ) => GoogleCatalogueSettings.SaveProfile(
        connection,
        workbookId,
        sheetId,
        sheetTitle,
        profile,
        ready,
        inspectedUtc
    );

    public void MarkGoogleCatalogueSync(string workbookId, string sheetId, DateTimeOffset syncedUtc) =>
        GoogleCatalogueSettings.MarkSync(connection, workbookId, sheetId, syncedUtc);

    public void ClearGoogleCatalogueSelection() => GoogleCatalogueSettings.Clear(connection);
}

public sealed record GoogleCatalogueSelection(
    string WorkbookId,
    string WorkbookTitle,
    string? SheetId,
    string? SheetTitle,
    string? Profile,
    bool Ready,
    DateTimeOffset? LastInspectedUtc,
    DateTimeOffset? LastSuccessfulSyncUtc
);

public sealed class CatalogueSettingsException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
