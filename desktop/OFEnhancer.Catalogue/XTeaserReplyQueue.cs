using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserReplyIntent(string RunId, string SourceKey, bool AutoReply, int ReplyDelayMinutes,
    string? WordingTemplate, bool Attempted, string? ReplyStatusUrl);
public sealed record XTeaserReplyCandidate(string StatusId, string PostedUtc, string ItemId, string SourceKey, string? PaidUrl,
    bool HasVideo, bool IsReply, bool IsRepost, bool OwnerReplyExists, XTeaserReplyIntent? ReplyIntent = null);

public sealed record XTeaserReplyQueue(string? OwnerHandle, IReadOnlyList<XTeaserReplyCandidate> Items);

public sealed partial class CatalogueStore
{
    internal const int MaxReplyQueueItems = 50;
    internal static readonly TimeSpan ReplyQueueWindow = TimeSpan.FromHours(24);
    private static readonly Regex CanonicalOnlyFansPost = new(
        @"^https://onlyfans\.com/(?<id>[0-9]{1,30})/johnny_guides/?$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex WorkflowMainStatus = new(
        @"^https://x\.com/[A-Za-z0-9_]{1,15}/status/(?<id>[0-9]{1,25})/?$",
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
        Query("SELECT status_id, item_id, source_key, evidence FROM x_post_bindings",
            reader =>
            {
                // A legacy derived reply-link binding is a promotion destination,
                // never a safe source episode for a new reply.
                string evidence = reader.GetString(3);
                if (evidence is "owner" or "sheet-link")
                    bindings[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2));
            });
        HashSet<string> conflicts = new(StringComparer.Ordinal);
        Query("SELECT status_id FROM x_binding_conflicts", reader => conflicts.Add(reader.GetString(0)));
        Dictionary<string, CatalogueItemSummary> items = GetItems().ToDictionary(item => item.ItemId, StringComparer.Ordinal);
        Dictionary<string, IReadOnlyDictionary<string, CreatorWorkflowSnapshot>> workflowIntents = new(StringComparer.Ordinal);

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
                || !items.TryGetValue(binding.ItemId, out CatalogueItemSummary? item)
                || item.SourceKey != binding.SourceKey)
                continue;
            if (!workflowIntents.TryGetValue(binding.SourceKey, out IReadOnlyDictionary<string, CreatorWorkflowSnapshot>? intents))
            {
                intents = ReadLatestReplyIntents(binding.ItemId, binding.SourceKey);
                workflowIntents.Add(binding.SourceKey, intents);
            }
            XTeaserReplyIntent? replyIntent = null;
            string? paidUrl;
            if (intents.TryGetValue(teaser.StatusId, out CreatorWorkflowSnapshot? workflow)
                && workflow.Reply is { } reply)
            {
                // Explicit workflow destinations and policy own this reply. Never
                // infer its source episode from the destination link.
                if (!reply.AutoReply || reply.Attempted || reply.ReplyStatusUrl is not null
                    || reply.ReplyDelayMinutes is < 1 or > 1440)
                    continue;
                paidUrl = reply.PaidUrl;
                replyIntent = new(workflow.RunId, binding.SourceKey, reply.AutoReply, reply.ReplyDelayMinutes,
                    reply.WordingTemplate, reply.Attempted, reply.ReplyStatusUrl);
            }
            else
                paidUrl = CanonicalOnlyFansUrl(item);
            queue.Add(new(teaser.StatusId, teaser.PostedUtc.ToString("O", CultureInfo.InvariantCulture), binding.ItemId,
                binding.SourceKey, paidUrl, teaser.HasVideo, teaser.InReplyTo is not null, teaser.IsRetweet,
                false, replyIntent));
            if (queue.Count == MaxReplyQueueItems) break;
        }
        return new(owner.Handle, queue);
    }

    private IReadOnlyDictionary<string, CreatorWorkflowSnapshot> ReadLatestReplyIntents(string itemId, string sourceKey)
    {
        Dictionary<string, CreatorWorkflowSnapshot> latest = new(StringComparer.Ordinal);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT item_id, source_key, snapshot_json FROM creator_workflows WHERE source_key=$source ORDER BY updated_utc DESC, run_id DESC";
        command.Parameters.AddWithValue("$source", sourceKey);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (reader.GetString(0) != itemId || reader.GetString(1) != sourceKey) continue;
            CreatorWorkflowSnapshot? workflow = JsonSerializer.Deserialize<CreatorWorkflowSnapshot>(reader.GetString(2));
            if (workflow?.Kind != "social" || workflow.SourceKey != sourceKey
                || workflow.Reply?.MainStatusUrl is not { } mainStatusUrl) continue;
            Match status = WorkflowMainStatus.Match(mainStatusUrl);
            if (status.Success) latest.TryAdd(status.Groups["id"].Value, workflow);
        }
        return latest;
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
