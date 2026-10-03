using System.Globalization;
using System.Text.Json;

namespace OFEnhancer.Catalogue;

public sealed record XOwnerMapping(string StatusId, string ItemId, string SourceKey, string? Fingerprint = null);
public sealed record XOwnerMappingResult(bool Applied, int Mapped, IReadOnlyList<XOwnerMapping> Choices);

public sealed partial class CatalogueStore
{
    // Explicit owner choices only. Preview freezes catalogue identities before
    // applying the whole batch; this never changes Google or local media.
    public XOwnerMappingResult MapXTeasers(IReadOnlyList<XOwnerMapping> choices, DateTimeOffset now, bool apply)
    {
        if (choices.Count is < 1 or > 100 || choices.Select(row => row.StatusId).Distinct().Count() != choices.Count)
            throw new XObservationException("mapping-invalid");
        var owner = GetXOwner();
        if (owner?.AccountId is null) throw new XObservationException("x-owner-unknown");
        var posts = ReadXPosts(null).Where(IsXTeaser).ToDictionary(row => row.StatusId);
        var items = GetItems().Where(row => !row.Archived).ToDictionary(row => row.ItemId);
        List<XOwnerMapping> frozen = [];
        foreach (var choice in choices)
        {
            if (!posts.ContainsKey(choice.StatusId)) throw new XObservationException("mapping-not-video-teaser");
            if (!items.TryGetValue(choice.ItemId, out var item) || item.SourceKey != choice.SourceKey)
                throw new XObservationException("mapping-item-stale");
            string fingerprint = ToUploadRow(item).Fingerprint;
            if (apply && choice.Fingerprint != fingerprint) throw new XObservationException("mapping-item-stale");
            if (items.Values.Any(other => other.ItemId != item.ItemId &&
                ItemUrls(other, "x").Any(url => XStatusIdFromUrl(url) == choice.StatusId)))
                throw new XObservationException("mapping-link-conflict");
            if (ItemUrls(item, "x").Distinct().Count() + choices.Count(row => row.ItemId == item.ItemId) > 100)
                throw new XObservationException("mapping-link-limit");
            frozen.Add(choice with { Fingerprint = fingerprint });
        }
        if (!apply) return new(false, frozen.Count, frozen);
        string utc = now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        using var transaction = connection.BeginTransaction();
        foreach (var choice in frozen)
        {
            var item = items[choice.ItemId];
            string url = $"https://x.com/{owner.Handle}/status/{choice.StatusId}";
            if (!ItemUrls(item, "x").Any(link => XStatusIdFromUrl(link) == choice.StatusId))
                ExecuteX(transaction, """
                    INSERT INTO audit_events(occurred_utc,kind,item_id,details_json)
                    VALUES ($utc,'owner-x-link',$item,$details)
                    """, ("$utc", utc), ("$item", item.ItemId),
                    ("$details", JsonSerializer.Serialize(new RecordedPublication("x", url))));
            ExecuteX(transaction, """
                INSERT INTO x_post_bindings(status_id,item_id,source_key,evidence,confidence,bound_utc)
                VALUES ($status,$item,$key,'owner','high',$utc)
                ON CONFLICT(status_id) DO UPDATE SET item_id=excluded.item_id, source_key=excluded.source_key,
                    evidence='owner',confidence='high',bound_utc=excluded.bound_utc
                """, ("$status", choice.StatusId), ("$item", item.ItemId), ("$key", item.SourceKey), ("$utc", utc));
            ExecuteX(transaction, """
                INSERT INTO audit_events(occurred_utc,kind,item_id,details_json)
                VALUES ($utc,'x-owner-binding',$item,$details)
                """, ("$utc", utc), ("$item", item.ItemId), ("$details", JsonSerializer.Serialize(choice)));
            ExecuteX(transaction, "UPDATE catalogue_items SET updated_utc=$utc WHERE item_id=$item",
                ("$utc", utc), ("$item", item.ItemId));
        }
        transaction.Commit();
        return new(true, frozen.Count, frozen);
    }
}
