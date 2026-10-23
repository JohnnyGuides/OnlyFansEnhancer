using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record UploadSheetWriteback(string Key, string WorkbookId, string? SheetId,
    string SourceKey, string Platform, string Url, string Title, string Description,
    string State = "pending", string? ErrorCode = null);
public sealed record UploadSheetWritebackCounts(int Pending, int Conflicts, int Attempted, int Unresolved);
public sealed record UploadSheetWritebackDetail(UploadSheetWriteback Intent, string? CurrentFingerprint);

public sealed partial class CatalogueStore
{
    public UploadSheetWriteback QueueUploadSheetWriteback(string workbookId, string? sheetId,
        UploadResultRequest request, string canonicalUrl)
    {
        string sourceKey = request.Metadata?.Id ?? request.Id!;
        CatalogueItemSummary item = GetItems().Single(value => value.SourceKey == sourceKey && value.SourceRow == request.Row);
        return QueueUploadSheetWriteback(workbookId, sheetId, request, canonicalUrl, item, null);
    }

    private UploadSheetWriteback QueueUploadSheetWriteback(string workbookId, string? sheetId,
        UploadResultRequest request, string canonicalUrl, CatalogueItemSummary item, SqliteTransaction? transaction)
    {
        string sourceKey = item.SourceKey;
        string key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new[] { workbookId, sheetId, sourceKey, request.Platform, canonicalUrl }))));
        UploadSheetWriteback? existing = ReadUploadSheetWritebacks(transaction).GetValueOrDefault(key);
        if (existing is not null) return existing;
        UploadSheetWriteback intent = new(key, workbookId, sheetId, sourceKey, request.Platform,
            canonicalUrl, item.Title, item.Description);
        RecordUploadSheetWriteback(intent, transaction);
        return intent;
    }

    public UploadSheetWriteback? GetUploadSheetWriteback(string key) => ReadUploadSheetWritebacks().GetValueOrDefault(key);

    public IReadOnlyList<UploadSheetWriteback> GetUploadSheetWritebacks(string workbookId) =>
        [.. ReadUploadSheetWritebacks().Values.Where(value => value.WorkbookId == workbookId &&
            value.State is "pending" or "attempted" or "unresolved")];

    public IReadOnlyList<UploadSheetWritebackDetail> GetUploadSheetWritebackDetails(string workbookId)
    {
        Dictionary<string, string> fingerprints = GetItems(includeArchived: true)
            .ToDictionary(value => value.SourceKey, value => ToUploadRow(value).Fingerprint, StringComparer.Ordinal);
        return [.. ReadUploadSheetWritebacks().Values
            .Where(value => value.WorkbookId == workbookId && value.State is "pending" or "attempted" or "unresolved" or "conflict")
            .OrderBy(value => value.Key, StringComparer.Ordinal)
            .Select(value => new UploadSheetWritebackDetail(value,
                fingerprints.GetValueOrDefault(value.SourceKey)))];
    }

    public UploadSheetWriteback RebaseUploadSheetWriteback(string key, string expectedFingerprint)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 128)
            throw new WorkbookProjectionException("upload-sheet-writeback-not-found", "The upload writeback was not found.");
        if (expectedFingerprint is not { Length: 64 } || !expectedFingerprint.All(Uri.IsHexDigit))
            throw new WorkbookProjectionException("invalid-upload-fingerprint", "The catalogue fingerprint is invalid.");
        UploadSheetWriteback intent = ReadUploadSheetWritebacks().GetValueOrDefault(key)
            ?? throw new WorkbookProjectionException("upload-sheet-writeback-not-found", "The upload writeback was not found.");
        if (intent.State != "conflict" || intent.ErrorCode is not ("catalogue-entry-changed" or "catalogue-layout-changed"))
            throw new WorkbookProjectionException("upload-sheet-writeback-rebase-not-allowed", "Only an unattempted catalogue-change conflict can be rebased.");
        if (HasAttemptedUploadSheetWriteback(key))
            throw new WorkbookProjectionException("upload-sheet-writeback-rebase-not-allowed", "An attempted writeback must be resolved without changing its payload.");
        GoogleCatalogueSelection? selection = GetGoogleCatalogueSelection();
        UploadCatalogueDestination? currentDestination=GetTrustedUploadCatalogueDestination();
        if (selection?.WorkbookId != intent.WorkbookId
            || intent.SheetId is not null && (currentDestination?.WorkbookId != intent.WorkbookId
                || currentDestination.SheetId != intent.SheetId))
            throw new WorkbookProjectionException("google-catalogue-destination-changed", "The original workbook and sheet must be selected to rebase this writeback.");
        CatalogueItemSummary item = GetItems(includeArchived: true).SingleOrDefault(value => value.SourceKey == intent.SourceKey)
            ?? throw new WorkbookProjectionException("catalogue-entry-changed", "The original catalogue item is no longer available.");
        UploadCatalogueRow current = ToUploadRow(item);
        if (!string.Equals(current.Fingerprint, expectedFingerprint, StringComparison.OrdinalIgnoreCase))
            throw new WorkbookProjectionException("catalogue-entry-changed", "Review the current catalogue entry before rebasing.");

        UploadSheetWriteback rebased = intent with
        {
            Title = item.Title,
            Description = item.Description,
            State = "pending",
            ErrorCode = null,
        };
        RecordUploadSheetWriteback(rebased);
        return rebased;
    }

    public UploadSheetWritebackCounts GetUploadSheetWritebackCounts(string workbookId)
    {
        UploadSheetWriteback[] intents = [.. ReadUploadSheetWritebacks().Values.Where(value => value.WorkbookId == workbookId)];
        return new(intents.Count(value => value.State == "pending"),
            intents.Count(value => value.State == "conflict"),
            intents.Count(value => value.State == "attempted"),
            intents.Count(value => value.State == "unresolved"));
    }

    public void RecordUploadSheetWriteback(UploadSheetWriteback intent) => RecordUploadSheetWriteback(intent, null);

    private void RecordUploadSheetWriteback(UploadSheetWriteback intent, SqliteTransaction? transaction)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO audit_events(occurred_utc,kind,details_json) VALUES ($utc,'upload-sheet-writeback',$details)";
        command.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$details", JsonSerializer.Serialize(intent));
        command.ExecuteNonQuery();
    }

    private Dictionary<string, UploadSheetWriteback> ReadUploadSheetWritebacks(SqliteTransaction? transaction = null)
    {
        Dictionary<string, UploadSheetWriteback> result = new(StringComparer.Ordinal);
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind='upload-sheet-writeback' ORDER BY event_id";
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            UploadSheetWriteback intent = JsonSerializer.Deserialize<UploadSheetWriteback>(reader.GetString(0))!;
            result[intent.Key] = intent;
        }
        return result;
    }

    private bool HasAttemptedUploadSheetWriteback(string key)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind='upload-sheet-writeback' ORDER BY event_id";
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            UploadSheetWriteback? prior = JsonSerializer.Deserialize<UploadSheetWriteback>(reader.GetString(0));
            if (prior?.Key == key && prior.State is "attempted" or "unresolved" or "completed") return true;
        }
        return false;
    }
}
