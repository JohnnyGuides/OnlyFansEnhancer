using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

/// <summary>Durable intent for one Google upload-catalogue row creation.</summary>
public sealed record UploadCatalogueEntryIntent(
    string OperationId,
    string WorkbookId,
    string SheetId,
    string RequestJson,
    string State,
    string? SourceKey,
    string? ItemId,
    int? Row,
    string? ErrorCode);

public sealed partial class CatalogueStore
{
    private sealed record UploadCatalogueEntryIntentEvent(
        string OperationId, string WorkbookId, string SheetId, string RequestJson,
        string State, string? SourceKey, string? ItemId, int? Row, string? ErrorCode);

    private const string UploadCatalogueEntryIntentKind = "upload-catalogue-entry-intent";

    public UploadCatalogueEntryIntent BeginUploadCatalogueEntryIntent(
        string operationId, string workbookId, string sheetId, string requestJson)
    {
        ValidateOperationId(operationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(workbookId);
        ArgumentException.ThrowIfNullOrWhiteSpace(sheetId);
        ArgumentNullException.ThrowIfNull(requestJson);
        lock (connection)
        {
            using SqliteTransaction transaction = connection.BeginTransaction();
            UploadCatalogueEntryIntent? current = ReadUploadCatalogueEntryIntent(operationId, transaction);
            if (current is not null)
            {
                if (current.WorkbookId != workbookId || current.SheetId != sheetId
                    || current.RequestJson != requestJson)
                    throw new InvalidOperationException("catalogue-entry-operation-conflict");
                transaction.Commit();
                return current;
            }

            UploadCatalogueEntryIntent created = new(operationId, workbookId, sheetId, requestJson,
                "pending", null, null, null, null);
            AppendUploadCatalogueEntryIntent(created, transaction);
            transaction.Commit();
            return created;
        }
    }

    public UploadCatalogueEntryIntent? GetUploadCatalogueEntryIntent(string operationId)
    {
        ValidateOperationId(operationId);
        lock (connection) return ReadUploadCatalogueEntryIntent(operationId, null);
    }

    public UploadCatalogueEntryIntent MarkUploadCatalogueEntryAttempted(
        string operationId, string sourceKey, string itemId, int row)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(itemId);
        if (row < 1) throw new ArgumentOutOfRangeException(nameof(row));
        return TransitionUploadCatalogueEntryIntent(operationId, current =>
        {
            if (current.State != "pending")
                throw new InvalidOperationException("catalogue-entry-operation-unresolved");
            return current with { State = "attempted", SourceKey = sourceKey, ItemId = itemId, Row = row, ErrorCode = null };
        });
    }

    public UploadCatalogueEntryIntent MarkUploadCatalogueEntryUnresolved(string operationId, string errorCode) =>
        TransitionUploadCatalogueEntryIntent(operationId, current =>
        {
            if (current.State is not ("attempted" or "unresolved"))
                throw new InvalidOperationException("catalogue-entry-operation-state-conflict");
            string safeCode = string.IsNullOrWhiteSpace(errorCode) ? "google-row-write-unresolved" : errorCode;
            return current with { State = "unresolved", ErrorCode = safeCode[..Math.Min(safeCode.Length, 100)] };
        });

    public UploadCatalogueEntryIntent CompleteUploadCatalogueEntryIntent(
        string operationId, string sourceKey, string itemId, int row) =>
        TransitionUploadCatalogueEntryIntent(operationId, current =>
        {
            if (current.State == "completed")
            {
                if (current.SourceKey != sourceKey || current.ItemId != itemId)
                    throw new InvalidOperationException("catalogue-entry-operation-conflict");
                return current.Row == row ? current : current with { Row = row };
            }
            if (current.State == "pending" && current.SourceKey is null
                && current.ItemId is null && current.Row is null)
                return current with { State = "completed", SourceKey = sourceKey, ItemId = itemId, Row = row, ErrorCode = null };
            if (current.State is not ("pending" or "attempted" or "unresolved")
                || current.SourceKey is not null && current.SourceKey != sourceKey
                || current.ItemId is not null && current.ItemId != itemId)
                throw new InvalidOperationException("catalogue-entry-operation-state-conflict");
            return current with { State = "completed", Row = row, ErrorCode = null };
        });

    private UploadCatalogueEntryIntent TransitionUploadCatalogueEntryIntent(
        string operationId, Func<UploadCatalogueEntryIntent, UploadCatalogueEntryIntent> transition)
    {
        ValidateOperationId(operationId);
        lock (connection)
        {
            using SqliteTransaction transaction = connection.BeginTransaction();
            UploadCatalogueEntryIntent current = ReadUploadCatalogueEntryIntent(operationId, transaction)
                ?? throw new InvalidOperationException("catalogue-entry-operation-missing");
            UploadCatalogueEntryIntent next = transition(current);
            if (next != current) AppendUploadCatalogueEntryIntent(next, transaction);
            transaction.Commit();
            return next;
        }
    }

    private UploadCatalogueEntryIntent? ReadUploadCatalogueEntryIntent(string operationId, SqliteTransaction? transaction)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind=$kind ORDER BY event_id DESC";
        command.Parameters.AddWithValue("$kind", UploadCatalogueEntryIntentKind);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            UploadCatalogueEntryIntentEvent? item = JsonSerializer.Deserialize<UploadCatalogueEntryIntentEvent>(reader.GetString(0));
            if (item?.OperationId == operationId)
                return new(item.OperationId, item.WorkbookId, item.SheetId, item.RequestJson,
                    item.State, item.SourceKey, item.ItemId, item.Row, item.ErrorCode);
        }
        return null;
    }

    private void AppendUploadCatalogueEntryIntent(UploadCatalogueEntryIntent intent, SqliteTransaction transaction)
    {
        UploadCatalogueEntryIntentEvent value = new(intent.OperationId, intent.WorkbookId, intent.SheetId,
            intent.RequestJson, intent.State, intent.SourceKey, intent.ItemId, intent.Row, intent.ErrorCode);
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO audit_events(occurred_utc,kind,details_json) VALUES($utc,$kind,$details)";
        command.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$kind", UploadCatalogueEntryIntentKind);
        command.Parameters.AddWithValue("$details", JsonSerializer.Serialize(value));
        command.ExecuteNonQuery();
    }

    private static void ValidateOperationId(string operationId)
    {
        if (!Guid.TryParseExact(operationId, "D", out Guid parsed)
            || parsed == Guid.Empty || parsed.ToString("D") != operationId)
            throw new ArgumentException("operationId must be a canonical lowercase UUID.", nameof(operationId));
    }
}
