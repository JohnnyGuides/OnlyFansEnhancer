using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OFEnhancer.Desktop;

internal sealed class DesktopSettingsStore
{
    private const int MaximumSettingsBytes = 64 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        MaxDepth = 8,
    };
    private readonly string _path;
    private readonly Action<string, string> _replace;
    internal string SettingsPath => _path;

    internal DesktopSettingsStore(
        string path,
        Action<string, string>? replace = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        _path = Path.GetFullPath(path);
        _replace = replace
            ?? ((source, destination) => File.Move(source, destination, overwrite: true));
    }

    internal DesktopSettings Load()
        => TryLoad(out DesktopSettings settings) ? settings : DesktopSettings.Empty;

    internal bool TryLoad(out DesktopSettings settings)
    {
        try
        {
            if (!File.Exists(_path) || new FileInfo(_path).Length > MaximumSettingsBytes)
            {
                settings = DesktopSettings.Empty;
                return false;
            }
            DesktopSettingsPayload? payload = JsonSerializer.Deserialize<DesktopSettingsPayload>(
                File.ReadAllBytes(_path),
                JsonOptions
            );
            if (payload is null)
            {
                settings = DesktopSettings.Empty;
                return false;
            }
            settings = new(
                AppConfiguration.NormalizeExtensionId(payload.ExtensionId),
                AppConfiguration.NormalizeGoogleOAuthClientId(payload.GoogleOAuthClientId),
                BrowserSelection.NormalizeId(payload.BrowserId),
                NormalizeGoogleSheetUrl(payload.GoogleSheetUrl),
                NormalizeLocalPath(payload.XTeaserRoot),
                NormalizeLocalPath(payload.XTeaserRevertListPath)
            );
            return true;
        }
        catch
        {
            settings = DesktopSettings.Empty;
            return false;
        }
    }

    internal void Save(DesktopSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        string? extensionId = NullOrValidatedExtensionId(settings.ExtensionId);
        string? googleClientId = NullOrValidatedGoogleClientId(settings.GoogleOAuthClientId);
        string? browserId = NullOrValidatedBrowserId(settings.BrowserId);
        string? googleSheetUrl = NullOrValidatedGoogleSheetUrl(settings.GoogleSheetUrl);
        string? teaserRoot = NullOrValidatedLocalPath(settings.XTeaserRoot, "invalid-x-teaser-root");
        string? revertList = NullOrValidatedLocalPath(settings.XTeaserRevertListPath, "invalid-x-teaser-revert-list");
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(
            new DesktopSettingsPayload(extensionId, googleClientId, browserId, googleSheetUrl, teaserRoot, revertList),
            JsonOptions
        );
        string? directory = Path.GetDirectoryName(_path);
        if (string.IsNullOrEmpty(directory))
            throw new DesktopSettingsException("settings-write-failed");
        string temporaryPath = $"{_path}.{Guid.NewGuid():N}.tmp";
        try
        {
            Directory.CreateDirectory(directory);
            using (FileStream output = new(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4_096,
                FileOptions.WriteThrough
            ))
            {
                output.Write(json);
                output.Flush(flushToDisk: true);
            }
            _replace(temporaryPath, _path);
        }
        catch (DesktopSettingsException)
        {
            TryDelete(temporaryPath);
            throw;
        }
        catch
        {
            TryDelete(temporaryPath);
            throw new DesktopSettingsException("settings-write-failed");
        }
    }

    private static string? NullOrValidatedExtensionId(string? value)
    {
        if (value is null)
            return null;
        return AppConfiguration.NormalizeExtensionId(value)
            ?? throw new DesktopSettingsException("invalid-extension-id");
    }

    private static string? NullOrValidatedGoogleClientId(string? value)
    {
        if (value is null)
            return null;
        return AppConfiguration.NormalizeGoogleOAuthClientId(value)
            ?? throw new DesktopSettingsException("invalid-google-client-id");
    }

    private static string? NullOrValidatedBrowserId(string? value)
    {
        if (value is null)
            return null;
        return BrowserSelection.NormalizeId(value)
            ?? throw new DesktopSettingsException("invalid-browser-id");
    }

    private static string? NormalizeGoogleSheetUrl(string? value)
    {
        if (value is null) return null;
        try { return GoogleSheetReference.Parse(value).CanonicalUrl; }
        catch (GoogleSheetReferenceException) { return null; }
    }

    private static string? NullOrValidatedGoogleSheetUrl(string? value)
    {
        if (value is null) return null;
        return NormalizeGoogleSheetUrl(value)
            ?? throw new DesktopSettingsException("invalid-google-sheet-url");
    }

    // Local folders/files for the X teaser manager: fully qualified, no drive
    // root, normalized without a trailing separator.
    internal static string? NormalizeLocalPath(string? value)
    {
        if (value is null || value.Length > 1_024 || !Path.IsPathFullyQualified(value)) return null;
        try
        {
            string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
            string root = Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full) ?? "");
            return string.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? null : full;
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    private static string? NullOrValidatedLocalPath(string? value, string code)
    {
        if (value is null) return null;
        return NormalizeLocalPath(value) ?? throw new DesktopSettingsException(code);
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // The destination remains an intact old or new settings document.
        }
    }

    private sealed record DesktopSettingsPayload(
        [property: JsonPropertyName("extensionId")] string? ExtensionId,
        [property: JsonPropertyName("googleOAuthClientId")] string? GoogleOAuthClientId,
        [property: JsonPropertyName("browserId")] string? BrowserId,
        [property: JsonPropertyName("googleSheetUrl")] string? GoogleSheetUrl,
        [property: JsonPropertyName("xTeaserRoot")] string? XTeaserRoot = null,
        [property: JsonPropertyName("xTeaserRevertListPath")] string? XTeaserRevertListPath = null
    );
}

internal sealed record DesktopSettings(
    string? ExtensionId,
    string? GoogleOAuthClientId,
    string? BrowserId = null,
    string? GoogleSheetUrl = null,
    string? XTeaserRoot = null,
    string? XTeaserRevertListPath = null
)
{
    internal static DesktopSettings Empty { get; } = new(null, null);
}

internal sealed class DesktopSettingsException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}
