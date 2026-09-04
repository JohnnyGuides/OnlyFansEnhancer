using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

internal static partial class SyncOutbox
{
    private const string MetadataKey = "ofenhancer.item_id.v1";
    private static readonly HashSet<string> UrlFields = ["onlyfans", "fansly", "manyvids", "pornhubFree", "pornhubPaid", "clips4sale", "x", "reddit"];
    private static readonly HashSet<string> CountFields = ["xTeasers", "redditTeasers"];
    private static readonly HashSet<string> TimestampFields = ["lastVerifiedSync"];

    internal static SyncOutboxItem Enqueue(SqliteConnection connection, SyncOutboxItem request)
    {
        ValidatedItem item = ValidateNew(request);
        using SqliteTransaction transaction = connection.BeginTransaction();
        SyncOutboxItem? existing = ReadByIdempotencyKey(connection, transaction, item.IdempotencyKey);
        if (existing is not null)
        {
            if (!SameIntent(existing, item))
                throw Invalid("An idempotency key cannot change its frozen sync intent.");
            transaction.Commit();
            return existing;
        }
        if (!ItemExists(connection, transaction, item.ItemId))
            throw Invalid("Catalogue item is unavailable.");

        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            """
            INSERT INTO sync_outbox(
                operation_id, idempotency_key, item_id, workbook_id, sheet_id,
                metadata_key, metadata_value, destination_field, payload_value,
                expected_remote_fingerprint, intended_value_fingerprint, state,
                attempt_count, error_code, created_utc, attempted_utc, completed_utc, resolved_utc
            ) VALUES (
                $operationId, $idempotencyKey, $itemId, $workbookId, $sheetId,
                $metadataKey, $metadataValue, $destinationField, $payloadValue,
                $expectedFingerprint, $intendedFingerprint, 'pending',
                0, NULL, $createdUtc, NULL, NULL, NULL
            )
            """;
        command.Parameters.AddWithValue("$operationId", item.OperationId);
        command.Parameters.AddWithValue("$idempotencyKey", item.IdempotencyKey);
        command.Parameters.AddWithValue("$itemId", item.ItemId);
        command.Parameters.AddWithValue("$workbookId", item.WorkbookId);
        command.Parameters.AddWithValue("$sheetId", item.SheetId);
        command.Parameters.AddWithValue("$metadataKey", item.MetadataKey);
        command.Parameters.AddWithValue("$metadataValue", item.MetadataValue);
        command.Parameters.AddWithValue("$destinationField", item.DestinationField);
        command.Parameters.AddWithValue("$payloadValue", item.PayloadValue);
        command.Parameters.AddWithValue("$expectedFingerprint", item.ExpectedRemoteFingerprint);
        command.Parameters.AddWithValue("$intendedFingerprint", item.IntendedValueFingerprint);
        command.Parameters.AddWithValue("$createdUtc", Timestamp(item.CreatedUtc));
        command.ExecuteNonQuery();
        transaction.Commit();
        return Get(connection, item.OperationId);
    }

    internal static IReadOnlyList<SyncOutboxItem> GetOpen(SqliteConnection connection) =>
        Read(connection, "WHERE state <> 'completed' ORDER BY created_utc, operation_id");

    internal static IReadOnlyList<SyncOutboxItem> GetOpen(
        SqliteConnection connection,
        string workbookId,
        string sheetId
    )
    {
        (string workbook, string sheet) = Scope(workbookId, sheetId);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = SelectSql + " WHERE workbook_id = $workbookId AND sheet_id = $sheetId AND state <> 'completed' ORDER BY created_utc, operation_id";
        command.Parameters.AddWithValue("$workbookId", workbook);
        command.Parameters.AddWithValue("$sheetId", sheet);
        return Read(command);
    }

    internal static SyncOutboxCounts GetCounts(
        SqliteConnection connection,
        string workbookId,
        string sheetId
    )
    {
        (string workbook, string sheet) = Scope(workbookId, sheetId);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT
                SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END),
                SUM(CASE WHEN state = 'attempted' THEN 1 ELSE 0 END),
                SUM(CASE WHEN state = 'conflict' THEN 1 ELSE 0 END),
                SUM(CASE WHEN state = 'unresolved' THEN 1 ELSE 0 END)
            FROM sync_outbox
            WHERE workbook_id = $workbookId AND sheet_id = $sheetId
            """;
        command.Parameters.AddWithValue("$workbookId", workbook);
        command.Parameters.AddWithValue("$sheetId", sheet);
        using SqliteDataReader reader = command.ExecuteReader();
        reader.Read();
        return new(
            reader.IsDBNull(0) ? 0 : reader.GetInt32(0),
            reader.IsDBNull(1) ? 0 : reader.GetInt32(1),
            reader.IsDBNull(2) ? 0 : reader.GetInt32(2),
            reader.IsDBNull(3) ? 0 : reader.GetInt32(3)
        );
    }

    internal static SyncOutboxItem Get(SqliteConnection connection, string operationId)
    {
        string id = GuidText(operationId, "operationId");
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = SelectSql + " WHERE operation_id = $operationId";
        command.Parameters.AddWithValue("$operationId", id);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
            throw Invalid("Sync operation is unavailable.");
        return ReadItem(reader);
    }

    internal static void MarkAttempted(SqliteConnection connection, string operationId, DateTimeOffset occurredUtc) =>
        Transition(connection, operationId, occurredUtc, "attempted", null, "state = 'pending'", "attempted_utc = $occurredUtc, attempt_count = attempt_count + 1");

    internal static void MarkPendingCompleted(SqliteConnection connection, string operationId, DateTimeOffset occurredUtc) =>
        Transition(connection, operationId, occurredUtc, "completed", null, "state = 'pending'", "completed_utc = $occurredUtc, resolved_utc = $occurredUtc");

    internal static void MarkPendingConflict(SqliteConnection connection, string operationId, string errorCode, DateTimeOffset occurredUtc) =>
        Transition(connection, operationId, occurredUtc, "conflict", ErrorCode(errorCode), "state = 'pending'", "error_code = $errorCode, resolved_utc = $occurredUtc");

    internal static void MarkCompleted(SqliteConnection connection, string operationId, DateTimeOffset occurredUtc) =>
        Transition(connection, operationId, occurredUtc, "completed", null, "state IN ('attempted', 'unresolved')", "error_code = NULL, completed_utc = $occurredUtc, resolved_utc = $occurredUtc");

    internal static void MarkConflict(SqliteConnection connection, string operationId, string errorCode, DateTimeOffset occurredUtc) =>
        Transition(connection, operationId, occurredUtc, "conflict", ErrorCode(errorCode), "state IN ('attempted', 'unresolved')", "error_code = $errorCode, resolved_utc = $occurredUtc");

    internal static void MarkUnresolved(SqliteConnection connection, string operationId, string errorCode, DateTimeOffset occurredUtc) =>
        Transition(connection, operationId, occurredUtc, "unresolved", ErrorCode(errorCode), "state = 'attempted'", "error_code = $errorCode, resolved_utc = $occurredUtc");

    private static void Transition(SqliteConnection connection, string operationId, DateTimeOffset occurredUtc, string next, string? errorCode, string requiredCurrentSql, string assignments)
    {
        string id = GuidText(operationId, "operationId");
        using SqliteTransaction transaction = connection.BeginTransaction();
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"UPDATE sync_outbox SET state = '{next}', {assignments} WHERE operation_id = $operationId AND {requiredCurrentSql}";
        command.Parameters.AddWithValue("$operationId", id);
        command.Parameters.AddWithValue("$occurredUtc", Timestamp(occurredUtc));
        if (errorCode is not null)
            command.Parameters.AddWithValue("$errorCode", errorCode);
        if (command.ExecuteNonQuery() != 1)
            throw Invalid($"Sync operation cannot move from its current state to {next}.");
        transaction.Commit();
    }

    private static IReadOnlyList<SyncOutboxItem> Read(SqliteConnection connection, string clause)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = SelectSql + " " + clause;
        return Read(command);
    }

    private static IReadOnlyList<SyncOutboxItem> Read(SqliteCommand command)
    {
        using SqliteDataReader reader = command.ExecuteReader();
        List<SyncOutboxItem> result = [];
        while (reader.Read())
            result.Add(ReadItem(reader));
        return result;
    }

    private static (string WorkbookId, string SheetId) Scope(string workbookId, string sheetId) =>
        (Required(workbookId, 256, "workbookId"), Required(sheetId, 64, "sheetId"));

    private static SyncOutboxItem? ReadByIdempotencyKey(SqliteConnection connection, SqliteTransaction transaction, string idempotencyKey)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = SelectSql + " WHERE idempotency_key = $idempotencyKey";
        command.Parameters.AddWithValue("$idempotencyKey", idempotencyKey);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? ReadItem(reader) : null;
    }

    private static bool ItemExists(SqliteConnection connection, SqliteTransaction transaction, string itemId)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT count(*) FROM catalogue_items WHERE item_id = $itemId";
        command.Parameters.AddWithValue("$itemId", itemId);
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture) == 1;
    }

    private static SyncOutboxItem ReadItem(SqliteDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7), reader.GetString(8), reader.GetString(9), reader.GetString(10), State(reader.GetString(11)), reader.GetInt32(12), reader.IsDBNull(13) ? null : reader.GetString(13), ParseTimestamp(reader.GetString(14)), reader.IsDBNull(15) ? null : ParseTimestamp(reader.GetString(15)), reader.IsDBNull(16) ? null : ParseTimestamp(reader.GetString(16)), reader.IsDBNull(17) ? null : ParseTimestamp(reader.GetString(17))
    );

    private static bool SameIntent(SyncOutboxItem existing, ValidatedItem item) =>
        existing.OperationId == item.OperationId && existing.ItemId == item.ItemId && existing.WorkbookId == item.WorkbookId && existing.SheetId == item.SheetId && existing.MetadataKey == item.MetadataKey && existing.MetadataValue == item.MetadataValue && existing.DestinationField == item.DestinationField && existing.PayloadValue == item.PayloadValue && existing.ExpectedRemoteFingerprint == item.ExpectedRemoteFingerprint && existing.IntendedValueFingerprint == item.IntendedValueFingerprint && existing.CreatedUtc == item.CreatedUtc;

    private static ValidatedItem ValidateNew(SyncOutboxItem item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (item.State != SyncOutboxState.Pending || item.AttemptCount != 0 || item.ErrorCode is not null || item.AttemptedUtc is not null || item.CompletedUtc is not null || item.ResolvedUtc is not null)
            throw Invalid("New sync operation must start pending without attempt data.");
        string itemId = GuidText(item.ItemId, "itemId");
        string metadataValue = GuidText(item.MetadataValue, "metadataValue");
        if (!string.Equals(itemId, metadataValue, StringComparison.Ordinal) || !string.Equals(item.MetadataKey, MetadataKey, StringComparison.Ordinal))
            throw Invalid("Sync metadata must identify the frozen catalogue item.");
        string destination = Required(item.DestinationField, 64, "destinationField");
        string payload = Payload(destination, item.PayloadValue);
        return new ValidatedItem(
            GuidText(item.OperationId, "operationId"),
            RequiredPattern(item.IdempotencyKey, 128, "idempotencyKey"),
            itemId,
            Required(item.WorkbookId, 256, "workbookId"),
            Required(item.SheetId, 64, "sheetId"),
            MetadataKey,
            metadataValue,
            destination,
            payload,
            Sha256(item.ExpectedRemoteFingerprint, "expectedRemoteFingerprint"),
            Sha256(item.IntendedValueFingerprint, "intendedValueFingerprint"),
            item.CreatedUtc.ToUniversalTime()
        );
    }

    private static string Payload(string destination, string? value)
    {
        string payload = Required(value, 2_048, "payloadValue");
        if (UrlFields.Contains(destination))
        {
            if (!Uri.TryCreate(payload, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort)
                throw Invalid("Sync URL payload must be canonical public HTTPS.");
            return CatalogueSnapshotImporter.CanonicalPlatformLink(destination, uri)
                ?? throw Invalid("Sync URL payload must be canonical for its destination.");
        }
        if (CountFields.Contains(destination))
        {
            if (!int.TryParse(payload, NumberStyles.None, CultureInfo.InvariantCulture, out int count) || count is < 0 or > 1_000_000)
                throw Invalid("Sync count payload is invalid.");
            return count.ToString(CultureInfo.InvariantCulture);
        }
        if (TimestampFields.Contains(destination))
            return Timestamp(ParseTimestamp(payload));
        if (destination == "ofenhancerId")
            return GuidText(payload, "payloadValue");
        throw Invalid("Sync destination field is not allowed.");
    }

    private static string Required(string? value, int maximum, string field)
    {
        string trimmed = value?.Trim() ?? "";
        if (trimmed.Length == 0 || trimmed.Length > maximum)
            throw Invalid($"{field} is invalid.");
        return trimmed;
    }

    private static string RequiredPattern(string? value, int maximum, string field)
    {
        string result = Required(value, maximum, field);
        if (!SafeCode().IsMatch(result))
            throw Invalid($"{field} is invalid.");
        return result;
    }

    private static string ErrorCode(string? value) => RequiredPattern(value, 128, "errorCode");

    private static string GuidText(string? value, string field)
    {
        if (!Guid.TryParse(value, out Guid parsed))
            throw Invalid($"{field} must be a GUID.");
        return parsed.ToString("D");
    }

    private static string Sha256(string? value, string field)
    {
        string fingerprint = Required(value, 64, field);
        if (!Sha256Hex().IsMatch(fingerprint))
            throw Invalid($"{field} must be a SHA-256 hexadecimal fingerprint.");
        return fingerprint.ToLowerInvariant();
    }

    private static DateTimeOffset ParseTimestamp(string value)
    {
        if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset parsed))
            throw Invalid("Timestamp payload is invalid.");
        return parsed.ToUniversalTime();
    }

    private static string Timestamp(DateTimeOffset value) => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static SyncOutboxState State(string value) => value switch
    {
        "pending" => SyncOutboxState.Pending,
        "attempted" => SyncOutboxState.Attempted,
        "completed" => SyncOutboxState.Completed,
        "conflict" => SyncOutboxState.Conflict,
        "unresolved" => SyncOutboxState.Unresolved,
        _ => throw Invalid("Stored sync operation state is invalid."),
    };

    private static SyncOutboxException Invalid(string message) => new("invalid-sync-outbox", message);

    private const string SelectSql = "SELECT operation_id, idempotency_key, item_id, workbook_id, sheet_id, metadata_key, metadata_value, destination_field, payload_value, expected_remote_fingerprint, intended_value_fingerprint, state, attempt_count, error_code, created_utc, attempted_utc, completed_utc, resolved_utc FROM sync_outbox";
    private sealed record ValidatedItem(string OperationId, string IdempotencyKey, string ItemId, string WorkbookId, string SheetId, string MetadataKey, string MetadataValue, string DestinationField, string PayloadValue, string ExpectedRemoteFingerprint, string IntendedValueFingerprint, DateTimeOffset CreatedUtc);

    [GeneratedRegex("^[A-Za-z0-9._:-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeCode();

    [GeneratedRegex("^[0-9A-Fa-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Hex();
}

public sealed partial class CatalogueStore
{
    public SyncOutboxItem EnqueueProjection(SyncOutboxItem projection) => SyncOutbox.Enqueue(connection, projection);
    public IReadOnlyList<SyncOutboxItem> GetOpenSyncOperations() => SyncOutbox.GetOpen(connection);
    public IReadOnlyList<SyncOutboxItem> GetOpenSyncOperations(string workbookId, string sheetId) => SyncOutbox.GetOpen(connection, workbookId, sheetId);
    public SyncOutboxCounts GetSyncOperationCounts(string workbookId, string sheetId) => SyncOutbox.GetCounts(connection, workbookId, sheetId);
    public SyncOutboxItem GetSyncOperation(string operationId) => SyncOutbox.Get(connection, operationId);
    public void MarkSyncAttempted(string operationId, DateTimeOffset occurredUtc) => SyncOutbox.MarkAttempted(connection, operationId, occurredUtc);
    public void MarkSyncPendingCompleted(string operationId, DateTimeOffset occurredUtc) => SyncOutbox.MarkPendingCompleted(connection, operationId, occurredUtc);
    public void MarkSyncPendingConflict(string operationId, string errorCode, DateTimeOffset occurredUtc) => SyncOutbox.MarkPendingConflict(connection, operationId, errorCode, occurredUtc);
    public void MarkSyncCompleted(string operationId, DateTimeOffset occurredUtc) => SyncOutbox.MarkCompleted(connection, operationId, occurredUtc);
    public void MarkSyncConflict(string operationId, string errorCode, DateTimeOffset occurredUtc) => SyncOutbox.MarkConflict(connection, operationId, errorCode, occurredUtc);
    public void MarkSyncUnresolved(string operationId, string errorCode, DateTimeOffset occurredUtc) => SyncOutbox.MarkUnresolved(connection, operationId, errorCode, occurredUtc);
}

public sealed record SyncOutboxCounts(int Pending, int Attempted, int Conflicts, int Unresolved);
