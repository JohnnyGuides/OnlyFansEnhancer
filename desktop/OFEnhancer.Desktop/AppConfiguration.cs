using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace OFEnhancer.Desktop;

public static partial class AppConfiguration
{
    public static string SettingsPath =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OFEnhancer",
            "settings.json"
        );

    public static string CatalogueDatabasePath
    {
        get
        {
            string? overrideFolder = Environment.GetEnvironmentVariable("OFENHANCER_DATA_FOLDER");
            string folder = string.IsNullOrWhiteSpace(overrideFolder)
                ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OFEnhancer",
                    "data"
                )
                : Path.GetFullPath(overrideFolder);
            return Path.Combine(folder, "catalogue.db");
        }
    }

    public static string? ResolveExtensionId(IReadOnlyList<string> args, string settingsPath)
    {
        for (int index = 0; index < args.Count - 1; index++)
        {
            if (!string.Equals(args[index], "--extension-id", StringComparison.Ordinal))
                continue;
            return NormalizeExtensionId(args[index + 1]);
        }

        if (!File.Exists(settingsPath))
            return null;
        try
        {
            Settings? settings = JsonSerializer.Deserialize<Settings>(
                File.ReadAllText(settingsPath)
            );
            return NormalizeExtensionId(settings?.ExtensionId);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? NormalizeExtensionId(string? value)
    {
        string candidate = value?.Trim() ?? string.Empty;
        return ExtensionIdPattern().IsMatch(candidate) ? candidate : null;
    }

    [GeneratedRegex("^[a-p]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdPattern();

    private sealed record Settings([property: JsonPropertyName("extensionId")] string? ExtensionId);
}
