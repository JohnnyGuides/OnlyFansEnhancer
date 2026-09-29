using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record CatalogueProductionHandoff(string HandoffId, string EpisodeId,
    string EditId, string EpisodeCode, int EditNumber, string FilesJson,
    string RequestFingerprint, string State, string? CatalogueItemId,
    DateTimeOffset CreatedUtc, DateTimeOffset? ReviewedUtc);

public sealed partial class CatalogueStore
{
    public CatalogueProductionHandoff SaveProductionDraft(string handoffId,
        string episodeId, string editId, string episodeCode, int editNumber,
        string filesJson, string requestFingerprint)
    {
        var existing = GetProductionHandoff(handoffId);
        if (existing is not null)
        {
            if (!string.Equals(existing.RequestFingerprint, requestFingerprint,
                    StringComparison.Ordinal))
                throw new InvalidOperationException("handoff-conflict");
            return existing;
        }
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO production_handoffs
            (handoff_id, episode_id, edit_id, episode_code, edit_number, files_json,
             request_fingerprint, state, created_utc)
            VALUES ($handoff, $episode, $edit, $code, $number, $files, $fingerprint,
                    'awaiting_review', $created)
            """;
        command.Parameters.AddWithValue("$handoff", handoffId);
        command.Parameters.AddWithValue("$episode", episodeId);
        command.Parameters.AddWithValue("$edit", editId);
        command.Parameters.AddWithValue("$code", episodeCode);
        command.Parameters.AddWithValue("$number", editNumber);
        command.Parameters.AddWithValue("$files", filesJson);
        command.Parameters.AddWithValue("$fingerprint", requestFingerprint);
        command.Parameters.AddWithValue("$created", DateTimeOffset.UtcNow.ToString("O"));
        try { command.ExecuteNonQuery(); }
        catch (SqliteException error) when (error.SqliteErrorCode == 19)
        {
            existing = GetProductionHandoff(handoffId);
            if (existing is not null && existing.RequestFingerprint == requestFingerprint)
                return existing;
            throw new InvalidOperationException("handoff-conflict", error);
        }
        return GetProductionHandoff(handoffId)!;
    }

    public CatalogueProductionHandoff? GetProductionHandoff(string handoffId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT handoff_id, episode_id, edit_id, episode_code, edit_number,
                   files_json, request_fingerprint, state, catalogue_item_id,
                   created_utc, reviewed_utc
            FROM production_handoffs WHERE handoff_id = $handoff
            """;
        command.Parameters.AddWithValue("$handoff", handoffId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadHandoff(reader) : null;
    }

    public IReadOnlyList<CatalogueProductionHandoff> GetPendingProductionHandoffs()
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT handoff_id, episode_id, edit_id, episode_code, edit_number,
                   files_json, request_fingerprint, state, catalogue_item_id,
                   created_utc, reviewed_utc
            FROM production_handoffs WHERE state IN ('awaiting_review', 'changed_source')
            ORDER BY created_utc DESC LIMIT 50
            """;
        using var reader = command.ExecuteReader();
        List<CatalogueProductionHandoff> items = [];
        while (reader.Read()) items.Add(ReadHandoff(reader));
        return items;
    }

    public CatalogueProductionHandoff ReviewProductionHandoff(string handoffId,
        string decision, string? catalogueItemId = null)
    {
        if (decision is not ("bound" or "rejected" or "changed_source"))
            throw new ArgumentException("Invalid production handoff state.", nameof(decision));
        var existing = GetProductionHandoff(handoffId)
            ?? throw new InvalidOperationException("handoff-not-found");
        if (decision == existing.State &&
            (decision != "bound" || catalogueItemId == existing.CatalogueItemId))
            return existing;
        if (decision == "bound" &&
            (existing.State != "awaiting_review" || string.IsNullOrWhiteSpace(catalogueItemId)))
            throw new InvalidOperationException("handoff-not-reviewable");
        if (decision == "rejected" && existing.State != "awaiting_review")
            throw new InvalidOperationException("handoff-not-reviewable");
        if (decision == "changed_source" && existing.State is "rejected" or "changed_source")
            throw new InvalidOperationException("handoff-not-reviewable");
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE production_handoffs SET state = $state,
                catalogue_item_id = CASE WHEN $state = 'bound' THEN $item ELSE catalogue_item_id END,
                reviewed_utc = CASE WHEN $state IN ('bound', 'rejected') THEN $reviewed ELSE reviewed_utc END
            WHERE handoff_id = $handoff
            """;
        command.Parameters.AddWithValue("$state", decision);
        command.Parameters.AddWithValue("$item", (object?)catalogueItemId ?? DBNull.Value);
        command.Parameters.AddWithValue("$reviewed", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$handoff", handoffId);
        try { command.ExecuteNonQuery(); }
        catch (SqliteException error) when (error.SqliteErrorCode == 19)
        { throw new InvalidOperationException("catalogue-item-not-found", error); }
        return GetProductionHandoff(handoffId)!;
    }

    private static CatalogueProductionHandoff ReadHandoff(SqliteDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
        reader.GetInt32(4), reader.GetString(5), reader.GetString(6), reader.GetString(7),
        reader.IsDBNull(8) ? null : reader.GetString(8),
        DateTimeOffset.Parse(reader.GetString(9)),
        reader.IsDBNull(10) ? null : DateTimeOffset.Parse(reader.GetString(10)));
}
