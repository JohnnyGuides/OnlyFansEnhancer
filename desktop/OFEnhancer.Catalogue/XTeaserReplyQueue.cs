using System.Globalization;
using System.Text.RegularExpressions;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserReplyCandidate(string StatusId, string PostedUtc, string ItemId, string SourceKey, string? PaidUrl,
    bool HasVideo, bool IsReply, bool IsRepost, bool OwnerReplyExists);

public sealed record XTeaserReplyQueue(string? OwnerHandle, IReadOnlyList<XTeaserReplyCandidate> Items);

public sealed partial class CatalogueStore
{
    internal const int MaxReplyQueueItems = 50;
    internal static readonly TimeSpan ReplyQueueWindow = TimeSpan.FromHours(24);
    private static readonly Regex CanonicalOnlyFansPost = new(
        @"^https://onlyfans\.com/(?<id>[0-9]{1,30})/johnny_guides/?$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    // Teasers that still need the automatic first reply: an owner post with
    // video that is neither a reply nor a repost, posted within the last 24 h,
    // bound to exactly one episode without a recorded conflict, and with no
    // owner reply anywhere in its conversation. The paid URL is the episode's
    // single canonical OnlyFans post link, or absent when the catalogue does
    // not hold exactly one; it is never guessed.
    public XTeaserReplyQueue GetXTeaserReplyQueue(DateTimeOffset now)
    {
        XStoredOwner? owner = GetXOwner();
        if (owner is null) return new(null, []);
        Dictionary<string, (string ItemId, string SourceKey)> bindings = new(StringComparer.Ordinal);
        Query("SELECT status_id, item_id, source_key FROM x_post_bindings",
            reader => bindings[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2)));
        HashSet<string> conflicts = new(StringComparer.Ordinal);
        Query("SELECT status_id FROM x_binding_conflicts", reader => conflicts.Add(reader.GetString(0)));
        Dictionary<string, CatalogueItemSummary> items = GetItems().ToDictionary(item => item.ItemId, StringComparer.Ordinal);

        IReadOnlyList<XPostRow> posts = ReadXPosts(null);
        HashSet<string> replied = new(StringComparer.Ordinal);
        foreach (XPostRow post in posts.Where(post => post.InReplyTo is not null && !post.IsRetweet))
        {
            replied.Add(post.InReplyTo!);
            if (post.ConversationId is not null && post.ConversationId != post.StatusId) replied.Add(post.ConversationId);
        }

        DateTimeOffset utcNow = now.ToUniversalTime();
        List<XTeaserReplyCandidate> queue = [];
        foreach (XPostRow teaser in posts.Where(IsXTeaser).OrderByDescending(post => post.PostedUtc))
        {
            if (teaser.PostedUtc < utcNow - ReplyQueueWindow || teaser.PostedUtc > utcNow.AddMinutes(5)) continue;
            if (replied.Contains(teaser.StatusId) || conflicts.Contains(teaser.StatusId)) continue;
            if (!bindings.TryGetValue(teaser.StatusId, out var binding)
                || !items.TryGetValue(binding.ItemId, out CatalogueItemSummary? item))
                continue;
            queue.Add(new(teaser.StatusId, teaser.PostedUtc.ToString("O", CultureInfo.InvariantCulture), binding.ItemId,
                binding.SourceKey, CanonicalOnlyFansUrl(item), teaser.HasVideo, teaser.InReplyTo is not null, teaser.IsRetweet,
                false));
            if (queue.Count == MaxReplyQueueItems) break;
        }
        return new(owner.Handle, queue);
    }

    // Every OnlyFans link on the row must be the canonical johnny_guides post
    // form and all must name the same post; anything else yields no link.
    internal static string? CanonicalOnlyFansUrl(CatalogueItemSummary item)
    {
        List<string> links = [.. ItemUrls(item, "onlyfans").Select(link => link.Trim()).Where(link => link.Length > 0)];
        if (links.Count == 0) return null;
        HashSet<string> ids = new(StringComparer.Ordinal);
        foreach (string link in links)
        {
            Match match = CanonicalOnlyFansPost.Match(link);
            if (!match.Success) return null;
            ids.Add(match.Groups["id"].Value);
        }
        return ids.Count == 1 ? $"https://onlyfans.com/{ids.Single()}/johnny_guides" : null;
    }
}
