using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XVerdictResult(int Decided, int WithoutCohort);

public sealed record XClipMoveOutcome(long MoveId, long ClipId, string FromRelPath, string ToRelPath, string Reason, string Outcome);

public sealed record XClipMoveCandidate(long ClipId, string RelPath, long SizeBytes, string Sha256, string Verdict);

public sealed record XClipUndoPlan(long MoveId, long ClipId, string OriginalRelPath, string CurrentRelPath, long SizeBytes, string Sha256);

public sealed partial class CatalogueStore
{
    internal static readonly TimeSpan XVerdictAge = TimeSpan.FromDays(7);
    internal const double XVerdictWindowStartHours = 144;
    internal const double XVerdictWindowEndHours = 240;
    internal const int XVerdictMinimumCohort = 10;
    internal const decimal XVerdictFailedFactor = 0.8m;

    // Takes the 7-day verdict once per teaser: engagement (likes + reposts +
    // replies + bookmarks) / views at the sample closest to 7 days within ages 6–10 days,
    // against the median of other teasers' samples in the same window. The
    // owner's own first reply, once posted, is not counted as a reply.
    public XVerdictResult DecideXVerdicts(DateTimeOffset now)
    {
        DateTimeOffset utc = now.ToUniversalTime();
        IReadOnlyList<XPostRow> teasers = [.. ReadXPosts(null).Where(IsXTeaser)];
        Dictionary<string, (decimal Rate, double Age)> rates = new(StringComparer.Ordinal);
        using (SqliteCommand read = connection.CreateCommand())
        {
            read.CommandText = """
                SELECT s.status_id, s.age_hours, s.views, s.likes, s.reposts, s.replies, s.bookmarks, s.observed_utc, f.replied_utc
                FROM x_metric_samples s LEFT JOIN x_first_replies f ON f.status_id = s.status_id
                WHERE s.age_hours >= $start AND s.age_hours <= $end AND s.views > 0
                  AND s.likes IS NOT NULL AND s.reposts IS NOT NULL AND s.replies IS NOT NULL AND s.bookmarks IS NOT NULL
                ORDER BY s.status_id, ABS(s.age_hours - 168), s.observed_utc
                """;
            read.Parameters.AddWithValue("$start", XVerdictWindowStartHours);
            read.Parameters.AddWithValue("$end", XVerdictWindowEndHours);
            using SqliteDataReader reader = read.ExecuteReader();
            while (reader.Read())
            {
                string statusId = reader.GetString(0);
                if (rates.ContainsKey(statusId)) continue;
                bool ownReply = !reader.IsDBNull(8) && ParseUtc(reader.GetString(8)) <= ParseUtc(reader.GetString(7));
                long replies = Math.Max(0, reader.GetInt64(5) - (ownReply ? 1 : 0));
                decimal rate = (reader.GetInt64(3) + reader.GetInt64(4) + replies + reader.GetInt64(6))
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

    // Posted clips (in Done\) whose paired teaser has a verdict and that were
    // never moved by a verdict before. The app moves a clip at most once: after
    // that, wherever the owner puts it (by undo or by hand) wins.
    public IReadOnlyList<XClipMoveCandidate> GetXClipMoveCandidates()
    {
        List<XClipMoveCandidate> candidates = [];
        Query("""
            SELECT c.clip_id, c.rel_path, c.size_bytes, c.sha256, v.verdict FROM x_local_clips c
            JOIN x_teaser_verdicts v ON v.status_id = c.status_id
            WHERE c.missing = 0 AND c.state = 'posted'
              AND NOT EXISTS (SELECT 1 FROM x_clip_moves m WHERE m.clip_id = c.clip_id AND m.outcome = 'moved'
                              AND m.reason IN ('verdict-good', 'verdict-failed'))
            ORDER BY c.clip_id
            """, reader => candidates.Add(new(reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(3),
            reader.GetString(4))));
        return candidates;
    }

    // Moves each candidate into Done\Good\ or Done\Failed\. Every move needs a
    // fresh hash match, never overwrites, stays inside the root and is logged;
    // consecutive identical refusals are logged once. One clip's failure is
    // logged and the next clip is still tried.
    public IReadOnlyList<XClipMoveOutcome> ApplyXClipVerdictMoves(string root, DateTimeOffset now)
    {
        string normalizedRoot = XTeaserFolder.NormalizeRoot(root);
        List<XClipMoveOutcome> outcomes = [];
        foreach (XClipMoveCandidate candidate in GetXClipMoveCandidates())
            if (ApplyXClipVerdictMoveCore(normalizedRoot, candidate,
                () => XTeaserFolder.FreshFingerprint(normalizedRoot, candidate.RelPath), now) is { } outcome)
                outcomes.Add(outcome);
        return outcomes;
    }

    // Applies one candidate with a fingerprint taken beside the request queue.
    // The candidate is re-checked here, so a clip changed meanwhile is skipped.
    public XClipMoveOutcome? ApplyXClipVerdictMove(string root, XClipMoveCandidate candidate, XClipFreshFingerprint fresh,
        DateTimeOffset now) =>
        ApplyXClipVerdictMoveCore(XTeaserFolder.NormalizeRoot(root), candidate, () => fresh, now);

    public static string XClipVerdictTarget(XClipMoveCandidate candidate) =>
        Path.Combine(candidate.Verdict == "good" ? XTeaserFolder.GoodFolder : XTeaserFolder.FailedFolder,
            Path.GetFileName(candidate.RelPath));

    private XClipMoveOutcome? ApplyXClipVerdictMoveCore(string root, XClipMoveCandidate candidate,
        Func<XClipFreshFingerprint> fresh, DateTimeOffset now)
    {
        if (!GetXClipMoveCandidates().Contains(candidate)) return null;
        string targetRel = XClipVerdictTarget(candidate);
        string reason = candidate.Verdict == "good" ? "verdict-good" : "verdict-failed";
        try
        {
            return MoveXClip(root, candidate.ClipId, candidate.RelPath, targetRel, candidate.SizeBytes, candidate.Sha256,
                reason, candidate.Verdict, now, fresh);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return RefuseXMove(candidate.ClipId, candidate.RelPath, targetRel, reason, "error", now, logRepeated: false);
        }
    }

    // Validates that a verdict move can still be undone: the clip is where the
    // move put it. Read on the request queue before hashing beside it.
    public XClipUndoPlan PlanXClipUndo(long moveId)
    {
        using SqliteCommand read = connection.CreateCommand();
        read.CommandText = """
            SELECT m.clip_id, m.from_rel_path, m.to_rel_path, m.reason, m.outcome, m.undone_utc,
                   c.rel_path, c.size_bytes, c.sha256, c.missing
            FROM x_clip_moves m JOIN x_local_clips c ON c.clip_id = m.clip_id WHERE m.move_id = $id
            """;
        read.Parameters.AddWithValue("$id", moveId);
        using SqliteDataReader reader = read.ExecuteReader();
        if (!reader.Read()) throw new XTeaserException("x-move-not-found");
        if (reader.GetString(4) != "moved" || reader.GetString(3) == "undo") throw new XTeaserException("x-move-not-undoable");
        if (!reader.IsDBNull(5)) throw new XTeaserException("x-move-already-undone");
        if (reader.GetInt64(9) == 1 || !string.Equals(reader.GetString(6), reader.GetString(2), StringComparison.OrdinalIgnoreCase))
            throw new XTeaserException("x-clip-moved-since");
        if (XTeaserFolder.StateForRelPath(reader.GetString(1)) is null) throw new XTeaserException("x-move-not-undoable");
        return new(moveId, reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetInt64(7), reader.GetString(8));
    }

    // Moves a verdict move back when the clip is still where the move put it,
    // its hash still matches and the original path is free.
    public XClipMoveOutcome UndoXClipMove(string root, long moveId, DateTimeOffset now, XClipFreshFingerprint? fresh = null)
    {
        string normalizedRoot = XTeaserFolder.NormalizeRoot(root);
        XClipUndoPlan plan = PlanXClipUndo(moveId);
        string state = XTeaserFolder.StateForRelPath(plan.OriginalRelPath)!;
        return MoveXClip(normalizedRoot, plan.ClipId, plan.CurrentRelPath, plan.OriginalRelPath, plan.SizeBytes, plan.Sha256,
            "undo", state, now, () => fresh ?? XTeaserFolder.FreshFingerprint(normalizedRoot, plan.CurrentRelPath), moveId,
            logRepeatedRefusal: true)!;
    }

    private XClipMoveOutcome? MoveXClip(string root, long clipId, string fromRel, string toRel, long size, string sha,
        string reason, string state, DateTimeOffset now, Func<XClipFreshFingerprint> fresh, long? undoes = null,
        bool logRepeatedRefusal = false)
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
        else
        {
            XClipFreshFingerprint fingerprint = fresh();
            if (fingerprint.Failure == XClipFreshFingerprint.NotRead) return null;
            refusal = fingerprint.Failure;
            if (refusal is null && (!string.Equals(fingerprint.RelPath, fromRel, StringComparison.OrdinalIgnoreCase)
                || fingerprint.SizeBytes != size || !string.Equals(fingerprint.Sha256, sha, StringComparison.Ordinal)))
                refusal = "fingerprint-mismatch";
            if (refusal is null)
            {
                // The file must still be the one that was hashed.
                FileInfo current = new(from);
                if (!current.Exists || current.Length != fingerprint.SizeBytes
                    || XTeaserFolder.MtimeText(current.LastWriteTimeUtc) != fingerprint.MtimeUtc)
                    refusal = "fingerprint-mismatch";
            }
        }
        if (refusal is not null) return RefuseXMove(clipId, fromRel, toRel, reason, refusal, now, logRepeatedRefusal);
        Directory.CreateDirectory(Path.GetDirectoryName(to!)!);
        if (XTeaserFolder.ResolveInside(root, toRel) is null)
            return RefuseXMove(clipId, fromRel, toRel, reason, "unsafe-path", now, logRepeatedRefusal);
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
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            transaction.Rollback();
            string outcome = File.Exists(to) ? "collision"
                : XTeaserFolder.IsSharingViolation(exception) ? "locked"
                : !File.Exists(from) ? "fingerprint-mismatch" : "error";
            return RefuseXMove(clipId, fromRel, toRel, reason, outcome, now, logRepeatedRefusal);
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

    private XClipMoveOutcome? RefuseXMove(long clipId, string fromRel, string toRel, string reason, string outcome,
        DateTimeOffset now, bool logRepeated)
    {
        if (!logRepeated && LatestXMoveIs(clipId, toRel, reason, outcome)) return null;
        string nowText = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        return new(InsertXMove(null, clipId, fromRel, toRel, reason, outcome, nowText), clipId, fromRel, toRel, reason, outcome);
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
