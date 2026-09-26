using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

// Recovers covers only from the saved catalogue links. No discovery/search or credentials.
internal sealed class ThumbnailPosterRecovery(HttpClient client)
{
    private static readonly HashSet<string> PageHosts = new(StringComparer.OrdinalIgnoreCase)
        { "www.manyvids.com", "manyvids.com", "www.pornhub.com", "pornhub.com" };
    private static readonly HashSet<string> ImageHosts = new(StringComparer.OrdinalIgnoreCase)
        { "cdn.manyvids.com", "ods.manyvids.com", "di.phncdn.com", "ei.phncdn.com", "pix-cdn77.phncdn.com", "pix-fl.phncdn.com" };
    internal static HttpClient CreateClient() => new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,
    }) { Timeout = TimeSpan.FromSeconds(20) };

    internal static Uri Validate(string value, bool image)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) || uri.Scheme != "https"
            || !uri.IsDefaultPort || uri.UserInfo.Length != 0
            || !(image ? ImageHosts : PageHosts).Contains(uri.Host))
            throw new InvalidDataException("unapproved-thumbnail-source");
        return uri;
    }

    internal static string? PosterReference(string html)
    {
        foreach (Match tag in Regex.Matches(html, @"<meta\b[^>]*>", RegexOptions.IgnoreCase))
        {
            var attributes = Regex.Matches(tag.Value, "([a-zA-Z:-]+)\\s*=\\s*([\"'])(.*?)\\2", RegexOptions.Singleline)
                .Cast<Match>().GroupBy(m => m.Groups[1].Value, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => WebUtility.HtmlDecode(g.First().Groups[3].Value), StringComparer.OrdinalIgnoreCase);
            if ((attributes.GetValueOrDefault("property") ?? attributes.GetValueOrDefault("name")) == "og:image")
                return attributes.GetValueOrDefault("content");
        }
        return null;
    }

    private async Task<byte[]> Read(string reference, bool image, CancellationToken cancellationToken)
    {
        Uri uri = Validate(reference, image);
        for (int redirects = 0; redirects <= 5; redirects++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.UserAgent.ParseAdd("OFEnhancer/1.0");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                if (response.Headers.Location is null) throw new InvalidDataException("missing-redirect-location");
                uri = Validate(new Uri(uri, response.Headers.Location).AbsoluteUri, image);
                continue;
            }
            response.EnsureSuccessStatusCode();
            int limit = image ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
            if (response.Content.Headers.ContentLength > limit) throw new InvalidDataException("thumbnail-response-too-large");
            if (image && response.Content.Headers.ContentType?.MediaType?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) != true)
                throw new InvalidDataException("thumbnail-response-not-image");
            using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using MemoryStream output = new();
            byte[] buffer = new byte[16384];
            int count;
            while ((count = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
            {
                if (output.Length + count > limit) throw new InvalidDataException("thumbnail-response-too-large");
                output.Write(buffer, 0, count);
            }
            return output.ToArray();
        }
        throw new InvalidDataException("too-many-thumbnail-redirects");
    }

    internal async Task<byte[]?> Recover(CatalogueItemSummary item, CancellationToken cancellationToken = default, Action<string>? diagnostic = null)
    {
        foreach (string platform in new[] { "manyvids", "pornhubFree", "pornhubPaid" })
        {
            var urls = new List<string>();
            if (item.PlatformLinks.TryGetValue(platform, out string? primary)) urls.Add(primary);
            if (item.SourceLinkCells?.TryGetValue(platform, out var cell) == true) urls.AddRange(cell.Urls);
            foreach (string url in urls.Distinct(StringComparer.Ordinal))
            {
                try
                {
                    // One deadline includes headers, redirects and response bodies.
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    deadline.CancelAfter(TimeSpan.FromSeconds(30));
                    byte[] page = await Read(url, false, deadline.Token).ConfigureAwait(false);
                    string? reference = PosterReference(System.Text.Encoding.UTF8.GetString(page));
                    if (reference is null)
                    {
                        // Some saved pages transiently return an incomplete HTML response.
                        await Task.Delay(500, deadline.Token).ConfigureAwait(false);
                        page = await Read(url, false, deadline.Token).ConfigureAwait(false);
                        reference = PosterReference(System.Text.Encoding.UTF8.GetString(page));
                    }
                    if (reference is null) { diagnostic?.Invoke(platform + ": no og:image"); continue; }
                    byte[] bytes = await Read(reference, true, deadline.Token).ConfigureAwait(false);
                    using MemoryStream input = new(bytes);
                    using Image image = Image.FromStream(input, false, true);
                    if (image.Width < 32 || image.Height < 32 || image.Width > 10000 || image.Height > 10000)
                        throw new InvalidDataException("invalid-thumbnail-dimensions");
                    // A real decoded image is stored, never HTML or an unvalidated downloaded file.
                    using MemoryStream output = new();
                    image.Save(output, ImageFormat.Png);
                    return output.ToArray();
                }
                catch (Exception error) when (error is HttpRequestException or IOException or InvalidDataException or ArgumentException or System.Runtime.InteropServices.ExternalException
                    || error is OperationCanceledException && !cancellationToken.IsCancellationRequested)
                {
                    diagnostic?.Invoke(platform + ": " + (error is HttpRequestException http ? "HTTP " + (int?)http.StatusCode
                        : error is OperationCanceledException ? "timeout" : error.Message));
                }
            }
        }
        return null;
    }
}
