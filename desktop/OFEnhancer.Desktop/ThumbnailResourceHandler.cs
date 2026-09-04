using System.IO;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

public sealed record ThumbnailResource(string Path, string ContentType);

public sealed class ThumbnailResourceResolver(CatalogueStore catalogue)
{
    private const long MaximumThumbnailBytes = 25 * 1024 * 1024;

    public ThumbnailResource? Resolve(Uri uri)
    {
        if (
            uri.Scheme != Uri.UriSchemeHttps
            || !string.Equals(uri.Host, "thumbs.ofenhancer.local", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
        )
            return null;

        string segment;
        try
        {
            segment = Uri.UnescapeDataString(uri.AbsolutePath.Trim('/'));
        }
        catch (UriFormatException)
        {
            return null;
        }
        if (!Guid.TryParse(segment, out _) || segment.Contains('/') || segment.Contains('\\'))
            return null;
        string? path = catalogue.ResolveAvailableAssetPath(segment);
        if (path is null)
            return null;
        FileInfo file = new(path);
        if (!file.Exists || file.Length > MaximumThumbnailBytes)
            return null;
        string? contentType = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            _ => null,
        };
        return contentType is null ? null : new ThumbnailResource(path, contentType);
    }
}
