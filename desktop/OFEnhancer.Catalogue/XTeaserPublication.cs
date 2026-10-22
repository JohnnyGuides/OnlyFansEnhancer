using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserPublicationContext(string AccountId, string Handle, string PreparedUtc, string LatestStatusId);

public sealed partial class CatalogueStore
{
    public XTeaserPublicationContext? GetXTeaserPublicationContext(DateTimeOffset now)
    {
        XStoredOwner? owner = GetXOwner();
        if (owner?.AccountId is null) return null;
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT status_id FROM x_posts WHERE author_id = $owner ORDER BY LENGTH(status_id) DESC, status_id DESC LIMIT 1";
        command.Parameters.AddWithValue("$owner", owner.AccountId);
        return new(owner.AccountId, owner.Handle, now.ToUniversalTime().ToString("O"), command.ExecuteScalar() as string ?? "0");
    }

    public XTeaserScheduledResult? ResolveXTeaserPublication(string captionSha256, XTeaserPublicationContext context,
        DateTimeOffset now, DateTimeOffset? scheduledUtc = null, string? episodeKey = null, IReadOnlyList<string>? mediaIds = null)
    {
        if (captionSha256 is null || context is null || !XCaptionSha256.IsMatch(captionSha256)
            || !Regex.IsMatch(context.AccountId ?? "", "^[0-9]{1,25}$")
            || !Regex.IsMatch(context.Handle ?? "", "^[A-Za-z0-9_]{1,15}$")
            || !Regex.IsMatch(context.LatestStatusId ?? "", "^[0-9]{1,25}$")
            || !DateTimeOffset.TryParse(context.PreparedUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var prepared)
            || (episodeKey is not null && !XScheduledEpisodeKey.IsMatch(episodeKey))
            || (mediaIds is not null && (mediaIds.Count > 4 || mediaIds.Any(id => !Regex.IsMatch(id, "^[0-9]{1,25}$")))))
            throw new XObservationException("invalid-x-publication-context");
        XStoredOwner? owner = GetXOwner();
        if (owner is null || owner.AccountId != context.AccountId || !string.Equals(owner.Handle, context.Handle, StringComparison.OrdinalIgnoreCase))
            return null;
        var matches = new List<(XPostRow Post, bool BindingMatches)>();
        foreach (XPostRow post in ReadXPosts(null))
        {
            if (!IsXTeaser(post) || post.PostedUtc < prepared.AddSeconds(-1) || post.PostedUtc > now.AddSeconds(90)
                || BigInteger.Parse(post.StatusId) <= BigInteger.Parse(context.LatestStatusId!)
                || (scheduledUtc is { } scheduled && Math.Abs((post.PostedUtc - scheduled).TotalSeconds) > 90)) continue;
            using var author = connection.CreateCommand();
            author.CommandText = "SELECT author_id FROM x_posts WHERE status_id = $status";
            author.Parameters.AddWithValue("$status", post.StatusId);
            if (author.ExecuteScalar() as string != context.AccountId) continue;
            if (mediaIds is { Count: > 0 })
            {
                using var media = connection.CreateCommand();
                media.CommandText = "SELECT media_json FROM x_posts WHERE status_id = $status";
                media.Parameters.AddWithValue("$status", post.StatusId);
                var observed = JsonSerializer.Deserialize<List<XObservedMedia>>((string)media.ExecuteScalar()!, XJson) ?? [];
                if (!mediaIds.ToHashSet(StringComparer.Ordinal).SetEquals(observed.Where(item => item.Type == "video")
                    .Select(item => item.MediaKey?.Split('_').Last() ?? ""))) continue;
            }
            string hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(post.Text))).ToLowerInvariant();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(hash), Encoding.ASCII.GetBytes(captionSha256))) continue;
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT COUNT(*), MIN(source_key), EXISTS(SELECT 1 FROM x_binding_conflicts WHERE status_id = $status)
                FROM x_post_bindings WHERE status_id = $status
                """;
            command.Parameters.AddWithValue("$status", post.StatusId);
            using var reader = command.ExecuteReader();
            reader.Read();
            bool bindingMatches = reader.GetInt64(0) <= 1 && reader.GetInt64(2) == 0
                && (episodeKey is null || reader.GetInt64(0) == 0 || (!reader.IsDBNull(1) && reader.GetString(1) == episodeKey));
            matches.Add((post, bindingMatches));
            if (matches.Count > 1) return null;
        }
        return matches.Count == 1 && matches[0].BindingMatches
            ? new($"https://x.com/{owner.Handle}/status/{matches[0].Post.StatusId}", matches[0].Post.PostedUtc)
            : null;
    }
}
