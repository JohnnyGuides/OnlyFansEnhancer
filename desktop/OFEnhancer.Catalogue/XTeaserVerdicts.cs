using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XVerdictResult(int Decided, int WithoutCohort);

public sealed record XClipMoveOutcome(long MoveId, long ClipId, string FromRelPath, string ToRelPath, string Reason, string Outcome);

public sealed partial class CatalogueStore
{
    internal static readonly TimeSpan XVerdictAge = TimeSpan.FromDays(7);
    internal const double XVerdictWindowStartHours = 144;
    internal const double XVerdictWindowEndHours = 240;
    internal const int XVerdictMinimumCohort = 10;
    internal const decimal XVerdictFailedFactor = 0.8m;

    // Takes the 7-day verdict once per teaser: engagement (likes + reposts +
    // replies + bookmarks) / views at the sample closest to 7 days within ages 6–10 days,
    // against the median of other teasers' samples in the same window.
    public XVerdictResult DecideXVerdicts(DateTimeOffset now)
    {
        DateTimeOffset utc = now.ToUniversalTime();
        IReadOnlyList<XPostRow> teasers = [.. ReadXPosts(null).Where(IsXTeaser)];
        Dictionary<string, (decimal Rate, double Age)> rates = new(StringComparer.Ordinal);
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.CommandText = """
                SELECT status_id, age_hours, views, likes, reposts, replies, bookmarks FROM x_metric_samples
                WHERE age_hours >= $start AND age_hours <= $end AND views > 0
                  AND likes IS NOT NULL AND reposts IS NOT NULL AND replies IS NOT NULL AND bookmarks IS NOT NULL
                ORDER BY status_id, ABS(age_hours - 168), observed_utc
                """;
            read.Parameters.AddWithValue("$start", XVerdictWindowStartHours);
            read.Parameters.AddWithValue("$end", XVerdictWindowEndHours);
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read())
            {
                string statusId = reader.GetString(0);
                if (rates.ContainsKey(statusId)) continue;
                decimal rate = (reader.GetInt64(3) + reader.GetInt64(4) + reader.GetInt64(5) + reader.GetInt64(6))
                    / (decimal)reader.GetInt64(2);
                rates[statusId] = (rate, reader.GetDouble(1));
            }
        }
        HashSet<string> decided = new(StringComparer.Ordinal);
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.CommandText = "SELECT status_id FROM x_teaser_verdicts";
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read()) decided.Add(reader.GetString(0));
        }
        Dictionary<string, (decimal Rate, double Age)> teaserRates = teasers.Where(post => rates.ContainsKey(post.StatusId))
            .ToDictionary(post => post.StatusId, post => rates[post.StatusId], StringComparer.Ordinal);
        int count = 0, withoutCohort = 0;
        using SqliteTransaction transaction = connection.BeginTransaction();
        foreach (XPostRow teaser in teasers)
        {
            if (decided.Contains(teaser.StatusId) || utc - teaser.PostedUtc < XVerdictAge
                || !teaserRates.TryGetValue(teaser.StatusId, out var own)) continue;
            decimal[] cohort = [.. teaserRates.Where(pair => pair.Key != teaser.StatusId).Select(pair => pair.Value.Rate).Order()];
            if (cohort.Length < XVerdictMinimumCohort)
            {
                withoutCohort++;
                continue;
            }
            decimal median = cohort.Length % 2 == 1 ? cohort[cohort.Length / 2]
                : (cohort[cohort.Length / 2 - 1] + cohort[cohort.Length / 2]) / 2;
            // Exact decimal arithmetic: a rate at exactly 0.8 x median is good.
            string verdict = own.Rate < XVerdictFailedFactor * median ? "failed" : "good";
            ExecuteX(transaction, """
                INSERT INTO x_teaser_verdicts (status_id, verdict, engagement_rate, cohort_median, cohort_size, sample_age_hours, decided_utc)
                VALUES ($status, $verdict, $rate, $median, $size, $age, $now)
                """, ("$status", teaser.StatusId), ("$verdict", verdict), ("$rate", (double)own.Rate), ("$median", (double)median),
                ("$size", cohort.Length), ("$age", own.Age), ("$now", utc.ToString("O", CultureInfo.InvariantCulture)));
            count++;
        }
        transaction.Commit();
        return new(count, withoutCohort);
    }

    // Moves each posted clip (in Done\) whose paired teaser has a verdict into
    // Done\Good\ or Done\Failed\. Every move needs a fresh hash match, never
    // overwrites, stays inside the root and is logged; refusals are logged once.
    // A clip whose earlier move was undone is left where the owner put it.
    public IReadOnlyList<XClipMoveOutcome> ApplyXClipVerdictMoves(string root, DateTimeOffset now)
    {
        string normalizedRoot = XTeaserFolder.NormalizeRoot(root);
        List<(long ClipId, string RelPath, long Size, string Sha, string Verdict)> candidates = [];
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.CommandText = """
                SELECT c.clip_id, c.rel_path, c.size_bytes, c.sha256, v.verdict FROM x_local_clips c
                JOIN x_teaser_verdicts v ON v.status_id = c.status_id
                WHERE c.missing = 0 AND c.state = 'posted'
                  AND NOT EXISTS (SELECT 1 FROM x_clip_moves m WHERE m.clip_id = c.clip_id AND m.undone_utc IS NOT NULL)
                ORDER BY c.clip_id
                """;
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read())
                candidates.Add((reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(3), reader.GetString(4)));
        }
        List<XClipMoveOutcome> outcomes = [];
        foreach (var clip in candidates)
        {
            string folder = clip.Verdict == "good" ? XTeaserFolder.GoodFolder : XTeaserFolder.FailedFolder;
            string targetRel = Path.Combine(folder, Path.GetFileName(clip.RelPath));
            XClipMoveOutcome? outcome = MoveXClip(normalizedRoot, clip.ClipId, clip.RelPath, targetRel, clip.Size, clip.Sha,
                clip.Verdict == "good" ? "verdict-good" : "verdict-failed", clip.Verdict == "good" ? "good" : "failed", now);
            if (outcome is not null) outcomes.Add(outcome);
        }
        return outcomes;
    }

    // Moves a verdict move back when the clip is still where the move put it,
    // its hash still matches and the original path is free.
    public XClipMoveOutcome UndoXClipMove(string root, long moveId, DateTimeOffset now)
    {
        string normalizedRoot = XTeaserFolder.NormalizeRoot(root);
        using SqliteCommand read = connection.CreateCommand();
        read.CommandText = """
            SELECT m.clip_id, m.from_rel_path, m.to_rel_path, m.reason, m.outcome, m.undone_utc,
                   c.rel_path, c.size_bytes, c.sha256, c.missing
            FROM x_clip_moves m JOIN x_local_clips c ON c.clip_id = m.clip_id WHERE m.move_id = $id
            """;
        read.Parameters.AddWithValue("$id", moveId);
        long clipId, size;
        string from, to, sha;
        using (SqliteDataReader reader = read.ExecuteReader())
        {
            if (!reader.Read()) throw new XTeaserException("x-move-not-found");
            if (reader.GetString(4) != "moved" || reader.GetString(3) == "undo") throw new XTeaserException("x-move-not-undoable");
            if (!reader.IsDBNull(5)) throw new XTeaserException("x-move-already-undone");
            if (reader.GetInt64(9) == 1 || !string.Equals(reader.GetString(6), reader.GetString(2), StringComparison.OrdinalIgnoreCase))
                throw new XTeaserException("x-clip-moved-since");
            (clipId, from, to, size, sha) = (reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetInt64(7), reader.GetString(8));
        }
        string state = XTeaserFolder.StateForRelPath(from) ?? throw new XTeaserException("x-move-not-undoable");
        return MoveXClip(normalizedRoot, clipId, to, from, size, sha, "undo", state, now, moveId, logRepeatedRefusal: true)!;
    }

    private XClipMoveOutcome? MoveXClip(string root, long clipId, string fromRel, string toRel, long size, string sha,
        string reason, string state, DateTimeOffset now, long? undoes = null, bool logRepeatedRefusal = false)
    {
        string nowText = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        string? from = XTeaserFolder.ResolveInside(root, fromRel);
        string? to = XTeaserFolder.ResolveInside(root, toRel);
        string? refusal = null;
        if (from is null || to is null
            || !string.Equals(Path.GetPathRoot(from), Path.GetPathRoot(to), StringComparison.OrdinalIgnoreCase))
            refusal = "unsafe-path";
        else if (File.Exists(to) || Directory.Exists(to))
            refusal = "collision";
        else if (!FreshFingerprintMatches(from, size, sha))
            refusal = "fingerprint-mismatch";
        if (refusal is not null)
        {
            if (!logRepeatedRefusal && LatestXMoveIs(clipId, toRel, reason, refusal)) return null;
            return new(InsertXMove(null, clipId, fromRel, toRel, reason, refusal, nowText), clipId, fromRel, toRel, reason, refusal);
        }
        Directory.CreateDirectory(Path.GetDirectoryName(to!)!);
        if (XTeaserFolder.ResolveInside(root, toRel) is null)
            return new(InsertXMove(null, clipId, fromRel, toRel, reason, "unsafe-path", nowText), clipId, fromRel, toRel, reason, "unsafe-path");
        using SqliteTransaction transaction = connection.BeginTransaction();
        long moveId = InsertXMove(transaction, clipId, fromRel, toRel, reason, "moved", nowText);
        ExecuteX(transaction, "UPDATE x_local_clips SET rel_path = $path, state = $state WHERE clip_id = $id",
            ("$path", toRel), ("$state", state), ("$id", clipId));
        if (undoes is not null)
            ExecuteX(transaction, "UPDATE x_clip_moves SET undone_utc = $now WHERE move_id = $id", ("$now", nowText), ("$id", undoes));
        try
        {
            File.Move(from!, to!, overwrite: false);
        }
        catch (IOException)
        {
            transaction.Rollback();
            string outcome = File.Exists(to) ? "collision" : "fingerprint-mismatch";
            return new(InsertXMove(null, clipId, fromRel, toRel, reason, outcome, nowText), clipId, fromRel, toRel, reason, outcome);
        }
        try
        {
            transaction.Commit();
        }
        catch
        {
            File.Move(to!, from!, overwrite: false);
            throw;
        }
        return new(moveId, clipId, fromRel, toRel, reason, "moved");
    }

    private static bool FreshFingerprintMatches(string path, long size, string sha)
    {
        try
        {
            FileInfo file = new(path);
            return file.Exists && !file.Attributes.HasFlag(FileAttributes.ReparsePoint) && file.Length == size
                && string.Equals(XTeaserFolder.Sha256(path), sha, StringComparison.Ordinal);
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private bool LatestXMoveIs(long clipId, string toRel, string reason, string outcome)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT to_rel_path, reason, outcome FROM x_clip_moves WHERE clip_id = $id ORDER BY move_id DESC LIMIT 1";
        command.Parameters.AddWithValue("$id", clipId);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() && reader.GetString(0) == toRel && reader.GetString(1) == reason && reader.GetString(2) == outcome;
    }

    private long InsertXMove(SqliteTransaction? transaction, long clipId, string fromRel, string toRel, string reason, string outcome, string nowText)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO x_clip_moves (clip_id, from_rel_path, to_rel_path, reason, outcome, occurred_utc)
            VALUES ($clip, $from, $to, $reason, $outcome, $now) RETURNING move_id
            """;
        command.Parameters.AddWithValue("$clip", clipId);
        command.Parameters.AddWithValue("$from", fromRel);
        command.Parameters.AddWithValue("$to", toRel);
        command.Parameters.AddWithValue("$reason", reason);
        command.Parameters.AddWithValue("$outcome", outcome);
        command.Parameters.AddWithValue("$now", nowText);
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }
}
