using System.Globalization;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

// ReEdit marks a slot that reuses a clip whose teaser failed its verdict.
public sealed record XTeaserPlanSlot(string Date, string EpisodeKey, string? ItemId, long? ClipId, bool ReEdit,
    string CreatedUtc);

public sealed record XTeaserPlan(IReadOnlyList<XTeaserPlanSlot> Slots);

public sealed partial class CatalogueStore
{
    internal const int MaxPlanSlots = 100;

    // Owner-local teaser plan: one planned episode per calendar day, never sent to X.
    public XTeaserPlan GetXTeaserPlan(string fromDate)
    {
        ParsePlanDate(fromDate);
        List<XTeaserPlanSlot> slots = [];
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT p.slot_date, p.episode_key, i.item_id, p.clip_id, c.state, p.created_utc
            FROM x_planned_slots p
            LEFT JOIN catalogue_items i ON i.source_key = p.episode_key COLLATE NOCASE AND i.archived = 0
            LEFT JOIN x_local_clips c ON c.clip_id = p.clip_id
            WHERE p.slot_date >= $from ORDER BY p.slot_date LIMIT {MaxPlanSlots}
            """;
        command.Parameters.AddWithValue("$from", fromDate);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
            slots.Add(new(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetInt64(3), !reader.IsDBNull(4) && reader.GetString(4) == "failed",
                reader.GetString(5)));
        return new(slots);
    }

    // Replaces the day's slot. The episode must be an active catalogue item and
    // an optional clip must be a present local clip of that episode.
    public XTeaserPlanSlot SetXTeaserPlanSlot(string date, string episodeKey, long? clipId, DateTimeOffset now)
    {
        ParsePlanDate(date);
        string? sourceKey = null, itemId = null;
        using (SqliteCommand item = connection.CreateCommand())
        {
            item.CommandText = "SELECT source_key, item_id FROM catalogue_items WHERE source_key = $key COLLATE NOCASE AND archived = 0";
            item.Parameters.AddWithValue("$key", episodeKey);
            using SqliteDataReader reader = item.ExecuteReader();
            if (reader.Read()) (sourceKey, itemId) = (reader.GetString(0), reader.GetString(1));
        }
        if (sourceKey is null) throw new XTeaserException("x-plan-episode-not-found");
        bool reEdit = false;
        if (clipId is { } id)
        {
            using SqliteCommand clip = connection.CreateCommand();
            clip.CommandText = "SELECT episode_key, state FROM x_local_clips WHERE clip_id = $id AND missing = 0";
            clip.Parameters.AddWithValue("$id", id);
            using SqliteDataReader reader = clip.ExecuteReader();
            if (!reader.Read() || reader.IsDBNull(0)
                || !string.Equals(reader.GetString(0), sourceKey, StringComparison.OrdinalIgnoreCase))
                throw new XTeaserException("x-plan-clip-not-found");
            reEdit = reader.GetString(1) == "failed";
        }
        string created = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        using SqliteCommand write = connection.CreateCommand();
        write.CommandText = """
            INSERT INTO x_planned_slots (slot_date, episode_key, clip_id, created_utc) VALUES ($date, $key, $clip, $now)
            ON CONFLICT(slot_date) DO UPDATE SET episode_key = excluded.episode_key, clip_id = excluded.clip_id,
                created_utc = excluded.created_utc
            """;
        write.Parameters.AddWithValue("$date", date);
        write.Parameters.AddWithValue("$key", sourceKey);
        write.Parameters.AddWithValue("$clip", clipId is { } value ? value : DBNull.Value);
        write.Parameters.AddWithValue("$now", created);
        write.ExecuteNonQuery();
        return new(date, sourceKey, itemId, clipId, reEdit, created);
    }

    public bool ClearXTeaserPlanSlot(string date)
    {
        ParsePlanDate(date);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "DELETE FROM x_planned_slots WHERE slot_date = $date";
        command.Parameters.AddWithValue("$date", date);
        return command.ExecuteNonQuery() == 1;
    }

    public static DateOnly ParsePlanDate(string date) =>
        DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateOnly parsed)
            ? parsed
            : throw new XTeaserException("invalid-teaser-plan");
}
