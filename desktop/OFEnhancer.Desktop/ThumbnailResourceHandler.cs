using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.Win32.SafeHandles;
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
            using SafeFileHandle rootHandle = FinalPath.OpenDirectory(location.ScanRoot);
            string finalRoot = FinalPath.Read(rootHandle);
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
                        FinalPath.Read(stream.SafeFileHandle)
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

internal static class FinalPath
{
    private const uint FileFlagBackupSemantics = 0x02000000;

    internal static SafeFileHandle OpenDirectory(string path)
    {
        SafeFileHandle handle = CreateFile(
            path,
            0,
            FileShare.Read | FileShare.Write,
            IntPtr.Zero,
            FileMode.Open,
            FileFlagBackupSemantics,
            IntPtr.Zero
        );
        if (!handle.IsInvalid)
            return handle;
        int error = Marshal.GetLastPInvokeError();
        handle.Dispose();
        throw new Win32Exception(error);
    }

    internal static string Read(SafeFileHandle handle)
    {
        int capacity = 512;
        while (true)
        {
            StringBuilder buffer = new(capacity);
            uint result = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (result == 0)
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            if (result < buffer.Capacity)
                return Normalize(buffer.ToString());
            capacity = checked((int)result + 1);
        }
    }

    private static string Normalize(string path) =>
        path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
            ? @"\\" + path[8..]
            : path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)
                ? path[4..]
                : path;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        FileShare shareMode,
        IntPtr securityAttributes,
        FileMode creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        [Out] StringBuilder filePath,
        uint filePathLength,
        uint flags
    );
}
