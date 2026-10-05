using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserLibraryClip(long ClipId, string RelPath, string? EpisodeKey, string State,
    long SizeBytes, string MtimeUtc, string Sha256);

public sealed partial class CatalogueStore
{
    public IReadOnlyList<XTeaserLibraryClip> GetXTeaserLibrary()
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT clip_id, rel_path, episode_key, state, size_bytes, mtime_utc, sha256
            FROM x_local_clips WHERE missing = 0 AND state IN ('ready', 'failed')
            ORDER BY CASE state WHEN 'ready' THEN 0 ELSE 1 END, clip_id DESC LIMIT 200
            """;
        using SqliteDataReader reader = command.ExecuteReader();
        List<XTeaserLibraryClip> clips = [];
        while (reader.Read()) clips.Add(new(reader.GetInt64(0), reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetString(3), reader.GetInt64(4),
            reader.GetString(5), reader.GetString(6)));
        return clips;
    }
}
