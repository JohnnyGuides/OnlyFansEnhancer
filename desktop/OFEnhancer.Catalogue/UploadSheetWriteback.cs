using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record UploadSheetWriteback(string Key, string WorkbookId, string? SheetId,
    string SourceKey, string Platform, string Url, string Title, string Description,
    string State = "pending", string? ErrorCode = null);

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
}
