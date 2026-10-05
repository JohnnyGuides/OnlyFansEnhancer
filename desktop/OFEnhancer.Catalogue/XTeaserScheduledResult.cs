using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace OFEnhancer.Catalogue;

public sealed record XTeaserScheduledResult(string Url, DateTimeOffset PostedUtc);

public sealed partial class CatalogueStore
{
    private static readonly Regex XCaptionSha256 = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex XScheduledEpisodeKey = new("^[A-Za-z0-9_-]{1,200}$", RegexOptions.CultureInvariant);

    // Resolves an already persisted scheduled caption to its eventual owner video post.
    // This is intentionally read-only: a schedule never creates an inferred binding.
    public XTeaserScheduledResult? ResolveXScheduledResult(string captionSha256, DateTimeOffset scheduledUtc,
        string? expectedEpisodeKey = null)
    {
        if (captionSha256 is null || !XCaptionSha256.IsMatch(captionSha256)
            || scheduledUtc == default || (expectedEpisodeKey is not null && !XScheduledEpisodeKey.IsMatch(expectedEpisodeKey)))
            throw new XObservationException("invalid-x-scheduled-result");

        XStoredOwner? owner = GetXOwner();
        if (owner is null || !Regex.IsMatch(owner.Handle, "^[A-Za-z0-9_]{1,15}$", RegexOptions.CultureInvariant)) return null;

        DateTimeOffset target = scheduledUtc.ToUniversalTime();
        List<(XPostRow Post, bool BindingMatches)> matches = [];
        foreach (XPostRow post in ReadXPosts(null))
        {
            if (!IsXTeaser(post) || Math.Abs((post.PostedUtc - target).TotalSeconds) > 90) continue;
            string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(post.Text))).ToLowerInvariant();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(digest), Encoding.ASCII.GetBytes(captionSha256))) continue;

            bool bindingMatches = true;
            if (expectedEpisodeKey is not null)
            {
                using var command = connection.CreateCommand();
                command.CommandText = """
                    SELECT COUNT(*), MIN(b.source_key),
                           EXISTS(SELECT 1 FROM x_binding_conflicts c WHERE c.status_id = $status)
                    FROM x_post_bindings b WHERE b.status_id = $status
                    """;
                command.Parameters.AddWithValue("$status", post.StatusId);
                using var reader = command.ExecuteReader();
                if (!reader.Read()) return null;
                long bindingCount = reader.GetInt64(0);
                bindingMatches = reader.GetInt64(2) == 0 && bindingCount <= 1;
                if (bindingCount == 1 && bindingMatches)
                    bindingMatches = !reader.IsDBNull(1)
                        && string.Equals(reader.GetString(1), expectedEpisodeKey, StringComparison.Ordinal);
            }

            matches.Add((post, bindingMatches));
            if (matches.Count > 1) return null;
        }
        return matches.Count == 1 && matches[0].BindingMatches
            ? new($"https://x.com/{owner.Handle}/status/{matches[0].Post.StatusId}", matches[0].Post.PostedUtc)
            : null;
    }
}
