using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal static class WebMessageSourcePolicy
{
    internal static bool IsTrusted(string? source) =>
        Uri.TryCreate(source, UriKind.Absolute, out Uri? uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && string.Equals(uri.Host, "app.ofenhancer.local", StringComparison.OrdinalIgnoreCase)
        && uri.IsDefaultPort
        && string.IsNullOrEmpty(uri.UserInfo);
}

public sealed record ThumbnailResource(FileStream Stream, string ContentType) : IDisposable
{
    public void Dispose() => Stream.Dispose();
}

public sealed class ThumbnailResourceResolver(CatalogueStore catalogue)
{
    private const long MaximumThumbnailBytes = 25 * 1024 * 1024;

    public ThumbnailResource? Open(Uri uri)
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

        AvailableAssetLocation? location;
        try
        {
            location = catalogue.ResolveAvailableAssetLocation(segment);
        }
        catch (SqliteException)
        {
            return null;
        }
        if (location is null)
            return null;
        string? contentType = Path.GetExtension(location.Path).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            _ => null,
        };
        if (contentType is null)
            return null;

        try
        {
            using var rootHandle = WindowsFinalPath.OpenDirectory(location.ScanRoot);
            string finalRoot = WindowsFinalPath.Read(rootHandle);
            FileStream stream = new(
                location.Path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 64 * 1024,
                FileOptions.SequentialScan
            );
            try
            {
                if (
                    stream.Length > MaximumThumbnailBytes
                    || !ThumbnailInventory.IsContainedPath(
                        finalRoot,
                        WindowsFinalPath.Read(stream.SafeFileHandle)
                    )
                )
                    return DisposeAndNull(stream);

                string sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                if (!string.Equals(sha256, location.Sha256, StringComparison.Ordinal))
                    return DisposeAndNull(stream);
                stream.Position = 0;
                return new ThumbnailResource(stream, contentType);
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or Win32Exception)
        {
            return null;
        }
    }

    private static ThumbnailResource? DisposeAndNull(FileStream stream)
    {
        stream.Dispose();
        return null;
    }
}
