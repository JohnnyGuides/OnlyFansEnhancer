using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record UploadCatalogueRow(int Row, string Id, string ItemId, string ReleaseDate, string Title,
    string Description, string SeasonArc, string Episode, string PornhubLink, string OnlyfansLink,
    string FanslyLink, string ManyvidsLink, string TwitterTeasers, string RedditPosts, int RedditPostCount,
    string Fingerprint, IReadOnlyDictionary<string,string> PublicationState);
public sealed record UploadCatalogueSnapshot(string Status, string Source, IReadOnlyList<UploadCatalogueRow> Rows, object? EmptyRow = null, IReadOnlyDictionary<string,string>? SeasonAliases = null);
public sealed record UploadResultMetadata(string Id, string? ReleaseDate = null, string? Title = null, string? Description = null);
public sealed record UploadResultRequest(int Row, string Fingerprint, string Platform, string PostUrl,
    UploadResultMetadata? Metadata = null, string? ItemId = null, string? Id = null, string? Action=null,
    string? StatusUrl=null,string? RedditUrl=null,bool RepeatUploadConfirmed=false);
public sealed record UploadResult(string Status, string? Fingerprint = null, bool GoogleSynced = false, string? PostUrl = null);
public sealed record DistributionLedgerRequest(string EventId,string RunId,string JobId,string Platform,
    int CatalogueRow,string CatalogueId,string ResultId,string ResultUrl,string Status,long RecordedAt,
    string Action,string PostUrl,string? ParentResultId=null);

public sealed partial class CatalogueStore
{
    private static readonly string[] UploadPlatforms = ["pornhub", "onlyfans", "fansly", "manyvids", "x", "reddit", "redgifs", "clips4sale"];

    public UploadCatalogueSnapshot GetUploadCatalogueSnapshot() => new("snapshot", "desktop",
        GetItems().Select(ToUploadRow).ToArray(), SeasonAliases: GetUploadSeasonAliases());

    public UploadResult RecordDistributionLedger(DistributionLedgerRequest request)
    {
        static bool Bounded(string? value,int maximum) => !string.IsNullOrWhiteSpace(value)
            && value.Length<=maximum && !value.Any(char.IsControl);
        if(request.Action!="appendDistributionLedger" || request.Platform is not ("x" or "reddit" or "redgifs")
            || !Bounded(request.EventId,100) || !Regex.IsMatch(request.EventId,"^[A-Za-z0-9_-]{2,100}$")
            || !Bounded(request.RunId,64) || !Regex.IsMatch(request.RunId,"^[A-Za-z0-9_-]{8,64}$")
            || !Bounded(request.JobId,100) || !Regex.IsMatch(request.JobId,"^[A-Za-z0-9:_-]{1,100}$")
            || request.CatalogueRow<1 || !Bounded(request.CatalogueId,200) || !Bounded(request.ResultId,200)
            || request.ParentResultId is not null && !Bounded(request.ParentResultId,200)
            || request.Status is not ("published" or "deleted" or "removed" or "unresolved")
            || request.RecordedAt is <1 or >253402300799999
            || !Bounded(request.ResultUrl,2048) || request.ResultUrl.Any(char.IsWhiteSpace)
            || request.PostUrl!=request.ResultUrl
            || !Uri.TryCreate(request.ResultUrl,UriKind.Absolute,out Uri? uri)
            || uri.Scheme!=Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo)
            || CatalogueSnapshotImporter.CanonicalPlatformLink(request.Platform,uri) is null)
            throw new WorkbookProjectionException("invalid-upload-result","The distribution result is invalid.");

        using SqliteTransaction transaction=connection.BeginTransaction();
        CatalogueItemSummary? item=ReadItems(false,transaction).SingleOrDefault(value=>
            value.SourceKey==request.CatalogueId && value.SourceRow==request.CatalogueRow);
        if(item is null) return new("stale");
        using SqliteCommand command=connection.CreateCommand();
        command.Transaction=transaction;
        command.CommandText="SELECT details_json FROM audit_events WHERE kind='distribution-result' AND item_id=$item";
        command.Parameters.AddWithValue("$item",item.ItemId);
        using(SqliteDataReader reader=command.ExecuteReader())
            while(reader.Read())
            {
                DistributionLedgerRequest? previous=JsonSerializer.Deserialize<DistributionLedgerRequest>(reader.GetString(0));
                if(previous?.RunId==request.RunId && previous.JobId==request.JobId && previous.EventId==request.EventId)
                    return new(previous==request ? "idempotent" : "conflict");
            }
        // Audit-only: ledger entries never establish publication state without a row fingerprint.
        command.CommandText="INSERT INTO audit_events(occurred_utc,kind,item_id,details_json) VALUES ($utc,'distribution-result',$item,$details)";
        command.Parameters.AddWithValue("$utc",DateTimeOffset.UtcNow.ToString("O",CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$details",JsonSerializer.Serialize(request));
        command.ExecuteNonQuery();
        transaction.Commit();
        return new("recorded-local");
    }

    public UploadResult RecordUploadResult(UploadResultRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        string? id = request.Metadata?.Id ?? request.Id;
        if (request.Row < 1 || string.IsNullOrWhiteSpace(id) || id.Length > 200
            || request.Fingerprint is not { Length: 64 } || !request.Fingerprint.All(Uri.IsHexDigit)
            || !UploadPlatforms.Contains(request.Platform, StringComparer.Ordinal)
            || request.Action is not (null or "commitPlatformLink" or "appendTwitterTeaser" or "appendRedditPost")
            || request.Action=="appendTwitterTeaser" && request.Platform!="x"
            || request.Action=="appendRedditPost" && request.Platform!="reddit"
            || request.StatusUrl is not null && request.StatusUrl!=request.PostUrl
            || request.RedditUrl is not null && request.RedditUrl!=request.PostUrl
            || request.PostUrl is not { Length: > 0 and <= 2048 }
            || request.PostUrl.Any(char.IsWhiteSpace)
            || !Uri.TryCreate(request.PostUrl, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort)
            throw new WorkbookProjectionException("invalid-upload-result", "The upload result is invalid.");
        string platform = request.Platform == "pornhub" ? "pornhubFree" : request.Platform;
        string? canonical = CatalogueSnapshotImporter.CanonicalPlatformLink(platform, uri);
        if (canonical is null) throw new WorkbookProjectionException("invalid-upload-result", "The upload result URL is invalid.");

        using SqliteTransaction transaction = connection.BeginTransaction();
        CatalogueItemSummary? item = ReadItems(false, transaction).SingleOrDefault(candidate =>
            candidate.SourceKey == id && candidate.SourceRow == request.Row
            && (request.ItemId is null || candidate.ItemId == request.ItemId));
        if (item is null) return new("stale");
        UploadCatalogueRow current = ToUploadRow(item);
        string state = current.PublicationState[request.Platform];
        if (state == "review") return new("conflict", current.Fingerprint);
        var knownUrls = SourceUrls(item, platform);
        if (knownUrls.Contains(canonical, StringComparer.Ordinal)) return new("idempotent", current.Fingerprint, PostUrl: canonical);
        if (!string.Equals(current.Fingerprint, request.Fingerprint, StringComparison.OrdinalIgnoreCase)) return new("stale", current.Fingerprint);
        bool append=request.Action is "appendTwitterTeaser" or "appendRedditPost";
        if (state == "published" && !append && !request.RepeatUploadConfirmed) return new("conflict", current.Fingerprint);
        if (knownUrls.Count >= 100) throw new WorkbookProjectionException("upload-result-limit", "This item has reached the publication link limit.");

        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE catalogue_items SET updated_utc=$utc WHERE item_id=$id";
        command.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$id", item.ItemId);
        command.ExecuteNonQuery();
        command.CommandText="INSERT INTO audit_events(occurred_utc,kind,item_id,details_json) VALUES ($utc,'upload-result',$id,$details)";
        command.Parameters.AddWithValue("$details",JsonSerializer.Serialize(new RecordedPublication(platform,canonical,request.RepeatUploadConfirmed ? knownUrls.ToArray() : null)));
        command.ExecuteNonQuery();
        transaction.Commit();
        return new("recorded-local", ToUploadRow(GetItems().Single(value=>value.ItemId==item.ItemId)).Fingerprint, PostUrl: canonical);
    }

    private IReadOnlyList<CatalogueItemSummary> WithRecordedPublications(List<CatalogueItemSummary> items,SqliteTransaction? transaction)
    {
        using SqliteCommand command=connection.CreateCommand();
        command.Transaction=transaction;
        command.CommandText="SELECT item_id,details_json FROM audit_events WHERE kind='upload-result' AND item_id IS NOT NULL ORDER BY event_id";
        using SqliteDataReader reader=command.ExecuteReader();
        Dictionary<string,List<RecordedPublication>> evidence=new(StringComparer.Ordinal);
        while(reader.Read())
        {
            RecordedPublication? record=JsonSerializer.Deserialize<RecordedPublication>(reader.GetString(1));
            if(record is null) continue;
            string itemId=reader.GetString(0);
            if(!evidence.TryGetValue(itemId,out List<RecordedPublication>? records)) evidence[itemId]=records=[];
            records.Add(record);
        }
        return items.Select(item=>
        {
            if(!evidence.TryGetValue(item.ItemId,out List<RecordedPublication>? records)) return item;
            Dictionary<string,string> links=new(item.PlatformLinks);
            Dictionary<string,CatalogueSourceLinkCell> cells=item.SourceLinkCells is null ? [] : new(item.SourceLinkCells);
            foreach(var group in records.GroupBy(record=>record.Platform,StringComparer.Ordinal))
            {
                string platform=group.Key;
                List<string> urls=[..group.Select(record=>record.PostUrl)];
                if(links.TryGetValue(platform,out string? existing)) urls.Add(existing);
                cells.TryGetValue(platform,out CatalogueSourceLinkCell? source);
                if(source is not null) urls.AddRange(source.Urls);
                string[] distinct=urls.Distinct(StringComparer.Ordinal).ToArray();
                bool social=platform is "x" or "reddit";
                var confirmed=group.SelectMany(record=>record.ConfirmedExistingUrls ?? []).Concat(group.Select(record=>record.PostUrl)).ToHashSet(StringComparer.Ordinal);
                bool confirmedRepeat=group.Any(record=>record.ConfirmedExistingUrls is {Length:>0}) && distinct.All(confirmed.Contains);
                bool conflict=source?.IssueCode is not null || !social && distinct.Length>1 && !confirmedRepeat;
                if(distinct.Length==1 && !conflict) links[platform]=distinct[0];
                else
                {
                    if(confirmedRepeat && !conflict) links[platform]=existing ?? group.First().ConfirmedExistingUrls?.FirstOrDefault() ?? distinct[0];
                    else links.Remove(platform);
                    cells[platform]=new(source?.Text ?? existing ?? "",source?.Hyperlink,distinct,
                        source?.IssueCode ?? (conflict ? "local-link-conflict" : null));
                }
            }
            CatalogueItemSummary result=item with {PlatformLinks=links,SourceLinkCells=cells};
            return result with {XTeasers=Math.Max(item.XTeasers,SourceUrls(result,"x").Count),
                RedditTeasers=Math.Max(item.RedditTeasers,SourceUrls(result,"reddit").Count)};
        }).ToArray();
    }

    private sealed record RecordedPublication(string Platform,string PostUrl,string[]? ConfirmedExistingUrls=null);

    private static UploadCatalogueRow ToUploadRow(CatalogueItemSummary item)
    {
        var states = UploadPlatforms.ToDictionary(platform => platform, platform => PublicationState(item, platform), StringComparer.Ordinal);
        string Link(string platform) => item.PlatformLinks.TryGetValue(platform,out string? value) ? value : "";
        return new(item.SourceRow ?? 0, item.SourceKey, item.ItemId, item.PlannedDate ?? "", item.Title, item.Description,
            item.Series ?? "", item.Episode ?? "", Link("pornhubFree"), Link("onlyfans"), Link("fansly"), Link("manyvids"),
            string.Join("\n",SourceUrls(item,"x")), string.Join("\n",SourceUrls(item,"reddit")), item.RedditTeasers,
            UploadFingerprint(item),states);
    }

    private static string PublicationState(CatalogueItemSummary item, string platform)
    {
        string[] keys = platform == "pornhub" ? ["pornhubFree", "pornhubPaid"] : [platform];
        bool evidence = false;
        foreach (string key in keys)
        {
            evidence |= item.PlatformLinks.ContainsKey(key);
            if (item.SourceLinkCells?.TryGetValue(key,out CatalogueSourceLinkCell? cell) == true)
            {
                if (cell.IssueCode is not null || cell.Urls.Count == 0 && (!string.IsNullOrWhiteSpace(cell.Text) || !string.IsNullOrWhiteSpace(cell.Hyperlink)))
                    return "review";
                evidence |= cell.Urls.Count > 0;
            }
        }
        return evidence ? "published" : "empty";
    }

    private static IReadOnlyList<string> SourceUrls(CatalogueItemSummary item, string platform)
    {
        List<string> urls=[];
        if (item.PlatformLinks.TryGetValue(platform,out string? primary)) urls.Add(primary);
        if (item.SourceLinkCells?.TryGetValue(platform,out CatalogueSourceLinkCell? cell) == true) urls.AddRange(cell.Urls);
        return urls.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static string UploadFingerprint(CatalogueItemSummary item) => Convert.ToHexString(SHA256.HashData(
        JsonSerializer.SerializeToUtf8Bytes(new
        {
            item.ItemId,item.SourceKey,item.SourceRow,item.Title,item.Description,item.PlannedDate,item.Series,item.Episode,
            item.XTeasers,item.RedditTeasers,
            Links=item.PlatformLinks.OrderBy(pair=>pair.Key,StringComparer.Ordinal).ToArray(),
            SourceLinks=item.SourceLinkCells?.OrderBy(pair=>pair.Key,StringComparer.Ordinal).ToArray()
        }))).ToLowerInvariant();
}
