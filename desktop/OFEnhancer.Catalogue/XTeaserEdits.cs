using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserEdit(string ProjectPath, IReadOnlyDictionary<string, string> Renders);

public sealed partial class CatalogueStore
{
    public XTeaserEdit GetXTeaserEdit(string episodeKey)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key=$key";
        command.Parameters.AddWithValue("$key", "x.teaser.edit." + episodeKey);
        if (command.ExecuteScalar() is not string json) return new("", new Dictionary<string, string>());
        try { return JsonSerializer.Deserialize<XTeaserEdit>(json) ?? new("", new Dictionary<string, string>()); }
        catch (JsonException) { return new("", new Dictionary<string, string>()); }
    }

    public void SaveXTeaserEdit(string episodeKey, XTeaserEdit edit)
    {
        if (!GetItems().Any(item => item.SourceKey == episodeKey)) throw new ArgumentException("Unknown teaser episode.");
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO settings(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
        command.Parameters.AddWithValue("$key", "x.teaser.edit." + episodeKey);
        command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(edit));
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<string> GetXTeaserRenderReservations()
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key LIKE 'x.teaser.edit.%'";
        using var reader = command.ExecuteReader();
        List<string> names = [];
        while (reader.Read())
        {
            try { names.AddRange(JsonSerializer.Deserialize<XTeaserEdit>(reader.GetString(0))?.Renders.Values ?? []); }
            catch (JsonException) { }
        }
        return names;
    }

    public XTeaserLibraryClip? GetXTeaserLibraryClip(long clipId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT clip_id,rel_path,episode_key,state,size_bytes,mtime_utc,sha256 FROM x_local_clips WHERE clip_id=$id AND missing=0 AND state IN ('ready','failed')";
        command.Parameters.AddWithValue("$id", clipId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? new(reader.GetInt64(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.GetString(3), reader.GetInt64(4), reader.GetString(5), reader.GetString(6)) : null;
    }

    // A watched render updates one path, never the rest of the folder inventory.
    public XTeaserLibraryClip UpsertXTeaserRender(XClipFingerprint file, DateTimeOffset now)
    {
        if (XTeaserFolder.StateForRelPath(file.RelPath) != "ready" || XTeaserFolder.EpisodeKeyFromName(Path.GetFileName(file.RelPath)) is not { } key)
            throw new ArgumentException("Invalid teaser render path.");
        using var transaction = connection.BeginTransaction();
        using var lookup = connection.CreateCommand();
        lookup.Transaction = transaction;
        lookup.CommandText = "SELECT clip_id FROM x_local_clips WHERE rel_path=$path COLLATE NOCASE AND sha256=$sha AND missing=0 LIMIT 1";
        lookup.Parameters.AddWithValue("$path", file.RelPath);
        lookup.Parameters.AddWithValue("$sha", file.Sha256);
        long? id = lookup.ExecuteScalar() is long found ? found : null;
        ExecuteX(transaction, "UPDATE x_local_clips SET missing=1 WHERE rel_path=$path COLLATE NOCASE AND missing=0 AND sha256<>$sha",
            ("$path", file.RelPath), ("$sha", file.Sha256));
        string time = now.ToUniversalTime().ToString("O");
        if (id is not null)
            ExecuteX(transaction, "UPDATE x_local_clips SET size_bytes=$size,mtime_utc=$mtime,last_seen_utc=$now WHERE clip_id=$id",
                ("$id", id.Value), ("$size", file.SizeBytes), ("$mtime", file.MtimeUtc), ("$now", time));
        else
        {
            ExecuteX(transaction, "INSERT INTO x_local_clips(rel_path,size_bytes,mtime_utc,sha256,episode_key,state,first_seen_utc,last_seen_utc) VALUES($path,$size,$mtime,$sha,$key,'ready',$now,$now)",
                ("$path", file.RelPath), ("$size", file.SizeBytes), ("$mtime", file.MtimeUtc), ("$sha", file.Sha256), ("$key", key), ("$now", time));
            using var inserted = connection.CreateCommand();
            inserted.Transaction = transaction;
            inserted.CommandText = "SELECT last_insert_rowid()";
            id = (long)inserted.ExecuteScalar()!;
        }
        transaction.Commit();
        return GetXTeaserLibraryClip(id.Value)!;
    }
}
