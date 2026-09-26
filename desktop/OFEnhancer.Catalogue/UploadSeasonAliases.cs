using System.Globalization;
using System.Text.Json;

namespace OFEnhancer.Catalogue;

public sealed partial class CatalogueStore
{
    private const string UploadSeasonAliasesKey = "upload.seasonAliases";

    public IReadOnlyDictionary<string,string> GetUploadSeasonAliases()
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key=$key";
        command.Parameters.AddWithValue("$key", UploadSeasonAliasesKey);
        if (command.ExecuteScalar() is not string json) return new Dictionary<string,string>();
        try
        {
            var stored = JsonSerializer.Deserialize<Dictionary<string,string>>(json) ?? [];
            var series = GetItems().Select(item=>item.Series).Where(value=>!string.IsNullOrWhiteSpace(value)).ToHashSet(StringComparer.Ordinal);
            return stored.Where(pair=>int.TryParse(pair.Key, NumberStyles.None, CultureInfo.InvariantCulture, out int season)
                && season is >0 and <=999 && series.Contains(pair.Value))
                .ToDictionary(pair=>pair.Key,pair=>pair.Value,StringComparer.Ordinal);
        }
        catch (JsonException) { return new Dictionary<string,string>(); }
    }

    // Configure a verified filename-season alias without changing catalogue rows.
    public void SetUploadSeasonAlias(int season, string series)
    {
        if (season is <=0 or >999 || !GetItems().Any(item=>item.Series==series))
            throw new ArgumentException("The season alias must refer to an existing catalogue series.");
        var aliases = new Dictionary<string,string>(GetUploadSeasonAliases()) { [season.ToString(CultureInfo.InvariantCulture)] = series };
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO settings(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
        command.Parameters.AddWithValue("$key", UploadSeasonAliasesKey);
        command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(aliases));
        command.ExecuteNonQuery();
    }
}
