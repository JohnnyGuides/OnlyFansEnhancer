using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed partial class CatalogueStore
{
    private const string CreatorWorkflowProjectionEvent = "creator-workflow-projection";

    public IReadOnlyList<CreatorWorkflowProjectionIntent> GetCreatorWorkflowProjectionIntents(string workbookId)
    {
        Dictionary<string, CreatorWorkflowProjectionIntent> latest = ReadCreatorWorkflowProjectionIntents();
        return [.. latest.Values.Where(value => value.WorkbookId == workbookId && value.State != "completed")
            .OrderBy(value => value.RunId, StringComparer.Ordinal).ThenBy(value => value.Revision)];
    }

    public CreatorWorkflowProjectionCounts GetCreatorWorkflowProjectionCounts(string workbookId)
    {
        CreatorWorkflowProjectionIntent[] intents = [.. ReadCreatorWorkflowProjectionIntents().Values
            .Where(value => value.WorkbookId == workbookId)];
        return new(intents.Count(value => value.State == "pending"),
            intents.Count(value => value.State == "attempted"),
            intents.Count(value => value.State == "unresolved"),
            intents.Count(value => value.State == "conflict"));
    }

    public CreatorWorkflowProjectionIntent RecordCreatorWorkflowProjection(CreatorWorkflowProjectionIntent intent)
    {
        ArgumentNullException.ThrowIfNull(intent);
        ValidateProjectionIdentity(intent);
        Dictionary<string, CreatorWorkflowProjectionIntent> latest = ReadCreatorWorkflowProjectionIntents();
        if (!latest.TryGetValue(intent.Key, out CreatorWorkflowProjectionIntent? current)
            || !SameProjectionIdentity(current, intent))
            throw new CreatorWorkflowException("creator-workflow-projection-not-found");
        if (current.State == intent.State && current.ErrorCode == intent.ErrorCode
            && current.LedgerSheetId == intent.LedgerSheetId) return current;
        bool allowed = current.State switch
        {
            "pending" => intent.State is "attempted" or "completed" or "conflict",
            "attempted" or "unresolved" => intent.State is "completed" or "unresolved" or "conflict",
            "conflict" => intent.State == "completed",
            _ => false,
        };
        if (!allowed || intent.State is not ("attempted" or "completed" or "unresolved" or "conflict")
            || intent.ErrorCode is { Length: > 64 } || intent.ErrorCode is not null
                && !System.Text.RegularExpressions.Regex.IsMatch(intent.ErrorCode, "^[A-Za-z0-9_-]+$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)
            || intent.LedgerSheetId is < 0)
            throw new CreatorWorkflowException("creator-workflow-projection-transition-invalid");
        WriteCreatorWorkflowProjectionEvent(intent);
        return intent;
    }

    public CreatorWorkflowProjectionIntent RetryCreatorWorkflowProjectionCapacityConflict(string key)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 128)
            throw new CreatorWorkflowException("creator-workflow-projection-retry-not-allowed");
        CreatorWorkflowProjectionIntent? current = ReadCreatorWorkflowProjectionIntents().GetValueOrDefault(key);
        if (current is not { State: "conflict", ErrorCode: "google-workflow-ledger-full", LedgerSheetId: null }
            || HasCreatorWorkflowProjectionAttempt(key))
            throw new CreatorWorkflowException("creator-workflow-projection-retry-not-allowed");

        CreatorWorkflowProjectionIntent pending = current with { State = "pending", ErrorCode = null };
        WriteCreatorWorkflowProjectionEvent(pending);
        return pending;
    }

    private void QueueCreatorWorkflowProjection(string workbookId, CreatorWorkflowSnapshot snapshot,
        SqliteTransaction transaction)
    {
        if (snapshot.Destination?.WorkbookId != workbookId)
            throw new CreatorWorkflowException("creator-workflow-destination-conflict");
        CatalogueItemSummary? sourceItem = snapshot.SourceKey is null ? null
            : ReadItems(includeArchived: true, transaction).Single(item => item.SourceKey == snapshot.SourceKey);
        CreatorWorkflowProjectionIntent intent = NewCreatorWorkflowProjection(workbookId, snapshot,
            sourceItem?.Title, sourceItem?.ItemId);
        using SqliteCommand insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = "INSERT INTO audit_events(occurred_utc,kind,details_json) VALUES ($utc,$kind,$details)";
        insert.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        insert.Parameters.AddWithValue("$kind", CreatorWorkflowProjectionEvent);
        insert.Parameters.AddWithValue("$details", JsonSerializer.Serialize(intent));
        insert.ExecuteNonQuery();
    }

    private static CreatorWorkflowProjectionIntent NewCreatorWorkflowProjection(string workbookId,
        CreatorWorkflowSnapshot snapshot, string? sourceTitle, string? sourceItemId)
    {
        string key = ProjectionKey(workbookId, snapshot.RunId, snapshot.Revision);
        return new(key, workbookId, snapshot.RunId, snapshot.Revision, snapshot, sourceTitle,
            SourceItemId: sourceItemId);
    }

    private string? GetCreatorWorkflowProjectionWorkbook(string runId, SqliteTransaction transaction)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind=$kind ORDER BY event_id";
        command.Parameters.AddWithValue("$kind", CreatorWorkflowProjectionEvent);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            CreatorWorkflowProjectionIntent? intent = JsonSerializer.Deserialize<CreatorWorkflowProjectionIntent>(reader.GetString(0));
            if (intent?.RunId == runId) return intent.WorkbookId;
        }
        return null;
    }

    private UploadCatalogueDestination? GetCreatorWorkflowProjectionDestination(string runId,
        SqliteTransaction transaction)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind=$kind ORDER BY event_id";
        command.Parameters.AddWithValue("$kind", CreatorWorkflowProjectionEvent);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            CreatorWorkflowProjectionIntent? intent = JsonSerializer.Deserialize<CreatorWorkflowProjectionIntent>(reader.GetString(0));
            if (intent?.RunId != runId) continue;
            return intent.Snapshot.Destination ?? new UploadCatalogueDestination(intent.WorkbookId, null);
        }
        return null;
    }

    private Dictionary<string, CreatorWorkflowProjectionIntent> ReadCreatorWorkflowProjectionIntents()
    {
        Dictionary<string, CreatorWorkflowProjectionIntent> intents = new(StringComparer.Ordinal);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind=$kind ORDER BY event_id";
        command.Parameters.AddWithValue("$kind", CreatorWorkflowProjectionEvent);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            CreatorWorkflowProjectionIntent? intent = JsonSerializer.Deserialize<CreatorWorkflowProjectionIntent>(reader.GetString(0));
            if (intent is not null) intents[intent.Key] = intent;
        }
        return intents;
    }

    private void WriteCreatorWorkflowProjectionEvent(CreatorWorkflowProjectionIntent intent)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "INSERT INTO audit_events(occurred_utc,kind,details_json) VALUES ($utc,$kind,$details)";
        command.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$kind", CreatorWorkflowProjectionEvent);
        command.Parameters.AddWithValue("$details", JsonSerializer.Serialize(intent));
        command.ExecuteNonQuery();
    }

    private bool HasCreatorWorkflowProjectionAttempt(string key)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind=$kind ORDER BY event_id";
        command.Parameters.AddWithValue("$kind", CreatorWorkflowProjectionEvent);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            CreatorWorkflowProjectionIntent? prior = JsonSerializer.Deserialize<CreatorWorkflowProjectionIntent>(reader.GetString(0));
            if (prior?.Key == key && (prior.State is "attempted" or "unresolved" or "completed"
                || prior.LedgerSheetId is not null))
                return true;
        }
        return false;
    }

    private static void ValidateProjectionIdentity(CreatorWorkflowProjectionIntent intent)
    {
        if (string.IsNullOrWhiteSpace(intent.WorkbookId) || intent.WorkbookId.Length > 256
            || string.IsNullOrWhiteSpace(intent.RunId) || intent.RunId.Length > 128
            || intent.Revision <= 0 || intent.Snapshot is null
            || intent.Snapshot.RunId != intent.RunId || intent.Snapshot.Revision != intent.Revision
            || intent.Key != ProjectionKey(intent.WorkbookId, intent.RunId, intent.Revision))
            throw new CreatorWorkflowException("creator-workflow-projection-invalid");
    }

    private static bool SameProjectionIdentity(CreatorWorkflowProjectionIntent left,
        CreatorWorkflowProjectionIntent right) => left.Key == right.Key && left.WorkbookId == right.WorkbookId
        && left.RunId == right.RunId && left.Revision == right.Revision
        && left.SourceTitle == right.SourceTitle
        && left.SourceItemId == right.SourceItemId
        && JsonSerializer.Serialize(left.Snapshot) == JsonSerializer.Serialize(right.Snapshot);

    private static string ProjectionKey(string workbookId, string runId, long revision) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new object[] { workbookId, runId, revision }))));
}
