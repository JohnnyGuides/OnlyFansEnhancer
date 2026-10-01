using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XSheetWritebackCandidate(string StatusId, string ItemId, string SourceKey, string Url);

// Pending counts bound teasers still missing from the sheet; Waiting is the
// part of them held back by the retry backoff after a failed attempt.
public sealed record XSheetWritebackStatus(int Pending, int Waiting, int Written, string? LastOutcome, string? LastCode,
    string? LastUtc);

public sealed partial class CatalogueStore
{
    internal const int MaxSheetWritebacksPerRun = 5;
    internal static readonly TimeSpan SheetWritebackBackoff = TimeSpan.FromHours(1);
    internal static readonly TimeSpan MaxSheetWritebackBackoff = TimeSpan.FromHours(24);
    private static readonly Regex XOwnerHandle = new("^[A-Za-z0-9_]{1,15}$", RegexOptions.CultureInvariant);
    private static readonly string[] SheetWritebackOutcomes = ["appended", "already-present", "failed"];

    private sealed record XSheetWritebackRecord(string StatusId, string SourceKey, string Url, string Outcome, string? Code);

    // Owner video teasers bound by reply-link or owner evidence whose status
    // link is missing from the bound row's Twitter Teaser(s) cell, oldest
    // first. Sheet-link bindings are already in the sheet; a post with a
    // recorded binding conflict is never written, even under an owner binding.
    public IReadOnlyList<XSheetWritebackCandidate> GetXSheetWritebackCandidates(DateTimeOffset now,
        int limit = MaxSheetWritebacksPerRun)
    {
        Dictionary<string, (int Failures, DateTimeOffset Last)> attempts = ReadSheetWritebackAttempts(out _, out _);
        return [.. SheetWritebackEligible().Where(candidate => !SheetWritebackWaiting(candidate, attempts, now)).Take(limit)];
    }

    public void RecordXSheetWriteback(XSheetWritebackCandidate candidate, string outcome, string? code, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        if (!SheetWritebackOutcomes.Contains(outcome, StringComparer.Ordinal) || (outcome == "failed") != (code is not null)
            || code is { Length: > 64 })
            throw new ArgumentException("Invalid sheet write-back outcome.", nameof(outcome));
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO audit_events(occurred_utc, kind, item_id, details_json)
            VALUES ($now, 'x-sheet-writeback', (SELECT item_id FROM catalogue_items WHERE item_id = $item), $details)
            """;
        command.Parameters.AddWithValue("$now", now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$item", candidate.ItemId);
        command.Parameters.AddWithValue("$details", JsonSerializer.Serialize(
            new XSheetWritebackRecord(candidate.StatusId, candidate.SourceKey, candidate.Url, outcome, code), XJson));
        command.ExecuteNonQuery();
    }

    public XSheetWritebackStatus GetXSheetWritebackStatus(DateTimeOffset now)
    {
        Dictionary<string, (int Failures, DateTimeOffset Last)> attempts = ReadSheetWritebackAttempts(out int written,
            out (XSheetWritebackRecord Record, string Utc)? last);
        IReadOnlyList<XSheetWritebackCandidate> eligible = SheetWritebackEligible();
        return new(eligible.Count, eligible.Count(candidate => SheetWritebackWaiting(candidate, attempts, now)), written,
            last?.Record.Outcome, last?.Record.Code, last?.Utc);
    }

    private IReadOnlyList<XSheetWritebackCandidate> SheetWritebackEligible()
    {
        string? handle = null;
        Query("SELECT handle FROM x_owner WHERE singleton = 1", reader => handle = reader.GetString(0));
        if (handle is null || !XOwnerHandle.IsMatch(handle)) return [];
        HashSet<string> conflicts = new(StringComparer.Ordinal);
        Query("SELECT status_id FROM x_binding_conflicts", reader => conflicts.Add(reader.GetString(0)));
        Dictionary<string, string> bindings = new(StringComparer.Ordinal);
        Query("SELECT status_id, item_id FROM x_post_bindings WHERE evidence IN ('reply-link', 'owner')",
            reader => bindings[reader.GetString(0)] = reader.GetString(1));
        if (bindings.Count == 0) return [];
        Dictionary<string, CatalogueItemSummary> items = GetItems().ToDictionary(item => item.ItemId, StringComparer.Ordinal);
        List<XSheetWritebackCandidate> result = [];
        foreach (XPostRow teaser in ReadXPosts(null).Where(IsXTeaser))
        {
            if (!bindings.TryGetValue(teaser.StatusId, out string? itemId) || conflicts.Contains(teaser.StatusId)
                || !items.TryGetValue(itemId, out CatalogueItemSummary? item) || item.SourceRow is null
                || ItemUrls(item, "x").Select(XStatusIdFromUrl).Contains(teaser.StatusId, StringComparer.Ordinal))
                continue;
            result.Add(new(teaser.StatusId, item.ItemId, item.SourceKey, $"https://x.com/{handle}/status/{teaser.StatusId}"));
        }
        return result;
    }

    // Consecutive failures since the last success decide the backoff:
    // 1 h after the first failure, doubling up to 24 h.
    private static bool SheetWritebackWaiting(XSheetWritebackCandidate candidate,
        Dictionary<string, (int Failures, DateTimeOffset Last)> attempts, DateTimeOffset now)
    {
        if (!attempts.TryGetValue(candidate.StatusId, out var attempt) || attempt.Failures == 0) return false;
        double hours = Math.Min(SheetWritebackBackoff.TotalHours * Math.Pow(2, attempt.Failures - 1),
            MaxSheetWritebackBackoff.TotalHours);
        return now < attempt.Last.AddHours(hours);
    }

    private Dictionary<string, (int Failures, DateTimeOffset Last)> ReadSheetWritebackAttempts(out int written,
        out (XSheetWritebackRecord Record, string Utc)? last)
    {
        Dictionary<string, (int Failures, DateTimeOffset Last)> attempts = new(StringComparer.Ordinal);
        HashSet<string> appended = new(StringComparer.Ordinal);
        (XSheetWritebackRecord, string)? latest = null;
        Query("SELECT occurred_utc, details_json FROM audit_events WHERE kind = 'x-sheet-writeback' ORDER BY event_id", reader =>
        {
            XSheetWritebackRecord? record = JsonSerializer.Deserialize<XSheetWritebackRecord>(reader.GetString(1), XJson);
            if (record is null) return;
            DateTimeOffset when = ParseUtc(reader.GetString(0));
            int failures = attempts.TryGetValue(record.StatusId, out var previous) ? previous.Failures : 0;
            attempts[record.StatusId] = (record.Outcome == "failed" ? failures + 1 : 0, when);
            if (record.Outcome == "appended") appended.Add(record.StatusId);
            latest = (record, reader.GetString(0));
        });
        written = appended.Count;
        last = latest;
        return attempts;
    }
}
