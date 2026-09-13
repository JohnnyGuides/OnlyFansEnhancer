using System.Text.Json;
using System.Text.RegularExpressions;

namespace OFEnhancer.Desktop;

internal static class GoogleSubredditPresets
{
    internal static GoogleSubredditPresetSnapshot Parse(byte[] json, string sheetTitle, int lastRow)
    {
        try
        {
            using JsonDocument document=JsonDocument.Parse(json,new(){MaxDepth=8});
            JsonElement root=document.RootElement;
            string range=root.GetProperty("range").GetString() ?? "";
            int separator=range.LastIndexOf('!');
            string source=separator<1 ? "" : range[..separator];
            if(source.StartsWith('\'') && source.EndsWith('\'') && source.Length>=2)
                source=source[1..^1].Replace("''","'",StringComparison.Ordinal);
            if(separator<1 || range[(separator+1)..] != $"Z1:AB{lastRow}"
                || source != sheetTitle)
                throw new GoogleCatalogueException("subreddit-source-mismatch");
            JsonElement values=root.GetProperty("values");
            if(values.ValueKind != JsonValueKind.Array || values.GetArrayLength() is <1 or >501)
                throw new GoogleCatalogueException("subreddit-presets-unavailable");
            string[] headers=ReadCells(values[0]);
            if(headers.Length !=3 || !headers.Select(value=>value.Trim().ToLowerInvariant()).SequenceEqual(["subreddit","status","notes"]))
                throw new GoogleCatalogueException("subreddit-headers-mismatch");
            List<GoogleSubredditPresetRow> rows=[];
            HashSet<string> seen=new(StringComparer.OrdinalIgnoreCase);
            foreach(JsonElement element in values.EnumerateArray().Skip(1))
            {
                string[] cells=ReadCells(element);
                if(cells.All(string.IsNullOrWhiteSpace)) continue;
                string name=cells.ElementAtOrDefault(0)?.Trim() ?? "";
                if(name.StartsWith("r/",StringComparison.OrdinalIgnoreCase)) name=name[2..];
                if(!Regex.IsMatch(name,"^[A-Za-z0-9_]{2,21}$",RegexOptions.CultureInvariant) || !seen.Add(name))
                    throw new GoogleCatalogueException("invalid-subreddit-preset");
                string status=cells.ElementAtOrDefault(1)?.Trim() ?? "";
                if(status is not ("Approved" or "Needs review" or "Rejected")) status="Needs review";
                rows.Add(new(name,status,cells.ElementAtOrDefault(2)?.Trim() ?? ""));
            }
            return new("snapshot",rows,sheetTitle);
        }
        catch(GoogleCatalogueException){throw;}
        catch {throw new GoogleCatalogueException("invalid-subreddit-presets");}
    }

    private static string[] ReadCells(JsonElement row)
    {
        if(row.ValueKind != JsonValueKind.Array || row.GetArrayLength()>3) throw new GoogleCatalogueException("invalid-subreddit-presets");
        return row.EnumerateArray().Select(cell=>
        {
            string value=cell.ValueKind==JsonValueKind.String ? cell.GetString()! : throw new GoogleCatalogueException("invalid-subreddit-presets");
            if(value.Length>5000 || value.Any(character=>char.IsControl(character) && character is not ('\r' or '\n' or '\t')))
                throw new GoogleCatalogueException("invalid-subreddit-presets");
            return value;
        }).ToArray();
    }
}

public sealed record GoogleSubredditPresetRow(string Subreddit,string Status,string Notes);
public sealed record GoogleSubredditPresetSnapshot(string Status,IReadOnlyList<GoogleSubredditPresetRow> Rows,string SheetName);
