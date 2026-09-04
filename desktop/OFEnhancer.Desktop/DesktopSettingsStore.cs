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
    {
        try
        {
            if (!File.Exists(_path) || new FileInfo(_path).Length > MaximumSettingsBytes)
                return DesktopSettings.Empty;
            DesktopSettingsPayload? payload = JsonSerializer.Deserialize<DesktopSettingsPayload>(
                File.ReadAllBytes(_path),
                JsonOptions
            );
            if (payload is null)
                return DesktopSettings.Empty;
            return new(
                AppConfiguration.NormalizeExtensionId(payload.ExtensionId),
                AppConfiguration.NormalizeGoogleOAuthClientId(payload.GoogleOAuthClientId)
            );
        }
        catch
        {
            return DesktopSettings.Empty;
        }
    }

    internal void Save(DesktopSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        string? extensionId = NullOrValidatedExtensionId(settings.ExtensionId);
        string? googleClientId = NullOrValidatedGoogleClientId(settings.GoogleOAuthClientId);
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(
            new DesktopSettingsPayload(extensionId, googleClientId),
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
        [property: JsonPropertyName("googleOAuthClientId")] string? GoogleOAuthClientId
    );
}

internal sealed record DesktopSettings(string? ExtensionId, string? GoogleOAuthClientId)
{
    internal static DesktopSettings Empty { get; } = new(null, null);
}

internal sealed class DesktopSettingsException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}
