using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

internal static class WorkbookProjectionImporter
{
    private const int MaximumItems = 5_000;
    private static readonly JsonSerializerOptions StorageJson = new() { WriteIndented = false };

    internal static void Import(SqliteConnection connection, WorkbookProjection projection)
    {
        ArgumentNullException.ThrowIfNull(projection);
        ValidatedProjection validated = Validate(projection);
        string now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);

        using SqliteTransaction transaction = connection.BeginTransaction();
        if (validated.Complete)
            Execute(connection, transaction, "UPDATE catalogue_items SET archived = 1, updated_utc = $now", ("$now", now));

        List<GoogleRowBinding> bindings = new(validated.Items.Count);
        foreach (ValidatedWorkbookItem row in validated.Items)
        {
            string itemId = ResolveItemId(connection, transaction, row);
            using SqliteCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                """
                INSERT INTO catalogue_items(
                    item_id, source_key, source_row, title, description, planned_date,
                    series, episode, x_teasers, reddit_teasers, platform_links_json,
                    archived, updated_utc
                ) VALUES (
                    $itemId, $sourceKey, $sourceRow, $title, $description, $plannedDate,
                    $series, $episode, $xTeasers, $redditTeasers, $links, 0, $now
                )
                ON CONFLICT(item_id) DO UPDATE SET
                    source_key = excluded.source_key,
                    source_row = excluded.source_row,
                    title = excluded.title,
                    description = excluded.description,
                    planned_date = excluded.planned_date,
                    series = excluded.series,
                    episode = excluded.episode,
                    x_teasers = excluded.x_teasers,
                    reddit_teasers = excluded.reddit_teasers,
                    platform_links_json = excluded.platform_links_json,
                    archived = 0,
                    updated_utc = excluded.updated_utc
                """;
            command.Parameters.AddWithValue("$itemId", itemId);
            command.Parameters.AddWithValue("$sourceKey", row.SourceKey);
            command.Parameters.AddWithValue("$sourceRow", row.SourceRow);
            command.Parameters.AddWithValue("$title", row.Title);
            command.Parameters.AddWithValue("$description", row.Description);
            command.Parameters.AddWithValue("$plannedDate", (object?)row.PlannedDate ?? DBNull.Value);
            command.Parameters.AddWithValue("$series", (object?)row.Series ?? DBNull.Value);
            command.Parameters.AddWithValue("$episode", (object?)row.Episode ?? DBNull.Value);
            command.Parameters.AddWithValue("$xTeasers", row.XTeasers);
            command.Parameters.AddWithValue("$redditTeasers", row.RedditTeasers);
            command.Parameters.AddWithValue("$links", JsonSerializer.Serialize(row.PlatformLinks, StorageJson));
            command.Parameters.AddWithValue("$now", now);
            command.ExecuteNonQuery();
            bindings.Add(new GoogleRowBinding(
                validated.WorkbookId,
                validated.SheetId,
                itemId,
                row.MetadataId ?? itemId,
                row.SourceRow,
                Fingerprint(row),
                DateTimeOffset.Parse(now, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)
            ));
        }
        ReplaceSheetBindings(connection, transaction, validated.WorkbookId, validated.SheetId, bindings, validated.Complete);
        transaction.Commit();
    }

    private static void ReplaceSheetBindings(SqliteConnection connection, SqliteTransaction transaction, string workbookId, string sheetId, IReadOnlyList<GoogleRowBinding> bindings, bool complete)
    {
        if (complete)
            Execute(connection, transaction, "DELETE FROM google_row_bindings WHERE workbook_id = $workbookId AND sheet_id = $sheetId", ("$workbookId", workbookId), ("$sheetId", sheetId));
        foreach (GoogleRowBinding binding in bindings)
            Execute(
                connection,
                transaction,
                "INSERT INTO google_row_bindings(workbook_id, sheet_id, item_id, metadata_id, last_observed_row, verified_remote_fingerprint, verified_utc) VALUES ($workbookId, $sheetId, $itemId, $metadataId, $row, $fingerprint, $utc) ON CONFLICT(workbook_id, sheet_id, item_id) DO UPDATE SET metadata_id = excluded.metadata_id, last_observed_row = excluded.last_observed_row, verified_remote_fingerprint = excluded.verified_remote_fingerprint, verified_utc = excluded.verified_utc",
                ("$workbookId", binding.WorkbookId),
                ("$sheetId", binding.SheetId),
                ("$itemId", binding.ItemId),
                ("$metadataId", binding.MetadataId),
                ("$row", binding.LastObservedRow),
                ("$fingerprint", binding.VerifiedRemoteFingerprint),
                ("$utc", binding.VerifiedUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture))
            );
    }

    private static string Fingerprint(ValidatedWorkbookItem row) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(row, StorageJson)))).ToLowerInvariant();

    private static string ResolveItemId(SqliteConnection connection, SqliteTransaction transaction, ValidatedWorkbookItem row)
    {
        string? bySource = ReadSingle(connection, transaction, "SELECT item_id FROM catalogue_items WHERE source_key = $value", row.SourceKey);
        if (row.MetadataId is null)
            return bySource ?? Guid.NewGuid().ToString("D");

        string? byMetadata = ReadSingle(connection, transaction, "SELECT item_id FROM catalogue_items WHERE item_id = $value", row.MetadataId);
        if (byMetadata is null)
        {
            if (bySource is not null)
                throw Invalid("Workbook metadata conflicts with the local source identity.");
            return row.MetadataId;
        }
        if (bySource is not null && !string.Equals(byMetadata, bySource, StringComparison.Ordinal))
            throw Invalid("Workbook metadata conflicts with the local source identity.");
        return byMetadata;
    }

    private static string? ReadSingle(SqliteConnection connection, SqliteTransaction transaction, string sql, string value)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.Parameters.AddWithValue("$value", value);
        return command.ExecuteScalar() is { } result ? Convert.ToString(result, CultureInfo.InvariantCulture) : null;
    }

    private static ValidatedProjection Validate(WorkbookProjection projection)
    {
        string workbookId = Required(projection.WorkbookId, 256, "workbookId");
        string sheetId = Required(projection.SheetId, 64, "sheetId");
        if (projection.Items is null || projection.Items.Count > MaximumItems)
            throw Invalid("Workbook projection has too many rows.");

        HashSet<string> sourceKeys = new(StringComparer.Ordinal);
        HashSet<string> metadataIds = new(StringComparer.Ordinal);
        List<ValidatedWorkbookItem> rows = new(projection.Items.Count);
        foreach (WorkbookCatalogueItem? candidate in projection.Items)
        {
            if (candidate is null)
                throw Invalid("Workbook row cannot be null.");
            WorkbookCatalogueItem row = candidate;
            if (row.SourceRow is <= 0 or > 1_000_000)
                throw Invalid("sourceRow must be a positive worksheet row.");
            string sourceKey = Required(row.SourceKey, 200, "sourceKey");
            if (!sourceKeys.Add(sourceKey))
                throw Invalid("Workbook source keys must be unique.");
            string? metadataId = OptionalGuid(row.MetadataId, "metadataId");
            if (metadataId is not null && !metadataIds.Add(metadataId))
                throw Invalid("Workbook metadata IDs must be unique.");
            if (row.XTeasers is < 0 or > 1_000_000 || row.RedditTeasers is < 0 or > 1_000_000)
                throw Invalid("Teaser counts are out of range.");
            rows.Add(new ValidatedWorkbookItem(
                row.SourceRow,
                sourceKey,
                Required(row.Title, 300, "title"),
                Required(row.Description, 10_000, "description", allowEmpty: true),
                OptionalDate(row.PlannedDate),
                Optional(row.Series, 200, "series"),
                Optional(row.Episode, 100, "episode"),
                row.XTeasers,
                row.RedditTeasers,
                ValidateLinks(row.PlatformLinks),
                metadataId
            ));
        }
        return new ValidatedProjection(workbookId, sheetId, projection.Complete, rows);
    }

    private static IReadOnlyDictionary<string, string> ValidateLinks(IReadOnlyDictionary<string, string>? links)
    {
        if (links is null || links.Count > 9)
            throw Invalid("platformLinks is missing or too large.");
        SortedDictionary<string, string> result = new(StringComparer.Ordinal);
        foreach ((string platform, string? rawUrl) in links)
        {
            if (platform is not ("onlyfans" or "fansly" or "manyvids" or "pornhubFree" or "pornhubPaid" or "clips4sale" or "x" or "reddit" or "redgifs"))
                throw Invalid($"Unsupported platform: {platform}");
            string url = Required(rawUrl, 2_048, $"platformLinks.{platform}");
            if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort)
                throw Invalid($"Platform link for {platform} must use a canonical credential-free HTTPS URL.");
            string? canonical = CatalogueSnapshotImporter.CanonicalPlatformLink(platform, uri);
            if (canonical is null)
                throw Invalid($"Platform link for {platform} must use a canonical credential-free HTTPS URL.");
            result.Add(platform, canonical);
        }
        return result;
    }

    private static string Required(string? value, int maximum, string field, bool allowEmpty = false)
    {
        string trimmed = value?.Trim() ?? "";
        if ((!allowEmpty && trimmed.Length == 0) || trimmed.Length > maximum)
            throw Invalid($"{field} is invalid.");
        return trimmed;
    }

    private static string? Optional(string? value, int maximum, string field) =>
        string.IsNullOrWhiteSpace(value) ? null : Required(value, maximum, field);

    private static string? OptionalGuid(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        if (!Guid.TryParse(value, out Guid parsed))
            throw Invalid($"{field} must be a GUID.");
        return parsed.ToString("D");
    }

    private static string? OptionalDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        string date = Required(value, 10, "plannedDate");
        if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            throw Invalid("plannedDate must use YYYY-MM-DD.");
        return date;
    }

    private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql, params (string Name, object Value)[] parameters)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach ((string name, object value) in parameters)
            command.Parameters.AddWithValue(name, value);
        command.ExecuteNonQuery();
    }

    private static WorkbookProjectionException Invalid(string message) => new("invalid-workbook-projection", message);

    private sealed record ValidatedProjection(string WorkbookId, string SheetId, bool Complete, IReadOnlyList<ValidatedWorkbookItem> Items);
    private sealed record ValidatedWorkbookItem(int SourceRow, string SourceKey, string Title, string Description, string? PlannedDate, string? Series, string? Episode, int XTeasers, int RedditTeasers, IReadOnlyDictionary<string, string> PlatformLinks, string? MetadataId);
}

public sealed partial class CatalogueStore
{
    public void ImportWorkbookProjection(WorkbookProjection projection) => WorkbookProjectionImporter.Import(connection, projection);

    public void ReplaceGoogleBindings(string workbookId, IReadOnlyList<GoogleRowBinding> bindings)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        ValidatedGoogleBindings validated = ValidateGoogleBindings(workbookId, bindings);
        using SqliteTransaction transaction = connection.BeginTransaction();
        using (SqliteCommand delete = connection.CreateCommand())
        {
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM google_row_bindings WHERE workbook_id = $workbookId";
            delete.Parameters.AddWithValue("$workbookId", validated.WorkbookId);
            delete.ExecuteNonQuery();
        }
        foreach (GoogleRowBinding binding in validated.Bindings)
        {
            using SqliteCommand insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = "INSERT INTO google_row_bindings(workbook_id, sheet_id, item_id, metadata_id, last_observed_row, verified_remote_fingerprint, verified_utc) VALUES ($workbookId, $sheetId, $itemId, $metadataId, $row, $fingerprint, $utc)";
            insert.Parameters.AddWithValue("$workbookId", binding.WorkbookId);
            insert.Parameters.AddWithValue("$sheetId", binding.SheetId);
            insert.Parameters.AddWithValue("$itemId", binding.ItemId);
            insert.Parameters.AddWithValue("$metadataId", binding.MetadataId);
            insert.Parameters.AddWithValue("$row", binding.LastObservedRow);
            insert.Parameters.AddWithValue("$fingerprint", binding.VerifiedRemoteFingerprint);
            insert.Parameters.AddWithValue("$utc", binding.VerifiedUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            insert.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public IReadOnlyList<GoogleRowBinding> GetGoogleBindings(string workbookId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workbookId);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT workbook_id, sheet_id, item_id, metadata_id, last_observed_row, verified_remote_fingerprint, verified_utc FROM google_row_bindings WHERE workbook_id = $workbookId ORDER BY sheet_id, last_observed_row, item_id";
        command.Parameters.AddWithValue("$workbookId", workbookId);
        using SqliteDataReader reader = command.ExecuteReader();
        List<GoogleRowBinding> result = [];
        while (reader.Read())
            result.Add(new GoogleRowBinding(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetInt32(4), reader.GetString(5), DateTimeOffset.Parse(reader.GetString(6), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)));
        return result;
    }

    private static ValidatedGoogleBindings ValidateGoogleBindings(string workbookId, IReadOnlyList<GoogleRowBinding> bindings)
    {
        string normalizedWorkbookId = RequiredGoogleBindingText(workbookId, 256, "workbookId");
        HashSet<(string SheetId, string ItemId)> itemKeys = [];
        HashSet<string> metadataIds = new(StringComparer.Ordinal);
        List<GoogleRowBinding> result = new(bindings.Count);
        foreach (GoogleRowBinding? candidate in bindings)
        {
            if (candidate is null)
                throw InvalidGoogleBinding();
            GoogleRowBinding binding = candidate;
            string bindingWorkbookId = RequiredGoogleBindingText(binding.WorkbookId, 256, "workbookId");
            if (!string.Equals(normalizedWorkbookId, bindingWorkbookId, StringComparison.Ordinal))
                throw InvalidGoogleBinding();
            string sheetId = RequiredGoogleBindingText(binding.SheetId, 64, "sheetId");
            string itemId = CanonicalGuid(binding.ItemId);
            string metadataId = CanonicalGuid(binding.MetadataId);
            if (binding.LastObservedRow is <= 0 or > 1_000_000 || binding.VerifiedUtc == default)
                throw InvalidGoogleBinding();
            if (!itemKeys.Add((sheetId, itemId)) || !metadataIds.Add(metadataId))
                throw InvalidGoogleBinding();
            result.Add(new GoogleRowBinding(
                normalizedWorkbookId,
                sheetId,
                itemId,
                metadataId,
                binding.LastObservedRow,
                Sha256(binding.VerifiedRemoteFingerprint),
                binding.VerifiedUtc.ToUniversalTime()
            ));
        }
        return new ValidatedGoogleBindings(normalizedWorkbookId, result);
    }

    private static string RequiredGoogleBindingText(string? value, int maximum, string field)
    {
        string normalized = value?.Trim() ?? "";
        if (normalized.Length == 0 || normalized.Length > maximum)
            throw new WorkbookProjectionException("invalid-google-binding", $"Google row binding {field} is invalid.");
        return normalized;
    }

    private static string CanonicalGuid(string? value)
    {
        if (!Guid.TryParse(value, out Guid parsed))
            throw InvalidGoogleBinding();
        return parsed.ToString("D");
    }

    private static string Sha256(string? value)
    {
        string fingerprint = value?.Trim() ?? "";
        if (fingerprint.Length != 64 || !fingerprint.All(char.IsAsciiHexDigit))
            throw InvalidGoogleBinding();
        return fingerprint.ToLowerInvariant();
    }

    private static WorkbookProjectionException InvalidGoogleBinding() =>
        new("invalid-google-binding", "Google row binding is invalid.");

    private sealed record ValidatedGoogleBindings(string WorkbookId, IReadOnlyList<GoogleRowBinding> Bindings);
}
