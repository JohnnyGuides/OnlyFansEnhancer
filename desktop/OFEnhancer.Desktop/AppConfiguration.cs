using System.IO;
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

    public static string CatalogueDatabasePath => Path.Combine(DataFolder, "catalogue.db");

    public static string GoogleTokenPath => Path.Combine(DataFolder, "google-oauth-token.dat");

    public static string? ResolveExtensionId(IReadOnlyList<string> args, string settingsPath)
    {
        for (int index = 0; index < args.Count - 1; index++)
        {
            if (!string.Equals(args[index], "--extension-id", StringComparison.Ordinal))
                continue;
            return NormalizeExtensionId(args[index + 1]);
        }

        return new DesktopSettingsStore(settingsPath).Load().ExtensionId;
    }

    public static bool IsValidGoogleOAuthClientId(string? value)
    {
        string candidate = value?.Trim() ?? string.Empty;
        return GoogleOAuthClientIdPattern().IsMatch(candidate);
    }

    internal static string? NormalizeExtensionId(string? value)
    {
        string candidate = value?.Trim() ?? string.Empty;
        return ExtensionIdPattern().IsMatch(candidate) ? candidate : null;
    }

    internal static string? NormalizeGoogleOAuthClientId(string? value)
    {
        string candidate = value?.Trim() ?? string.Empty;
        return IsValidGoogleOAuthClientId(candidate) ? candidate : null;
    }

    private static string DataFolder
    {
        get
        {
            string? overrideFolder = Environment.GetEnvironmentVariable("OFENHANCER_DATA_FOLDER");
            return string.IsNullOrWhiteSpace(overrideFolder)
                ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OFEnhancer",
                    "data"
                )
                : Path.GetFullPath(overrideFolder);
        }
    }

    [GeneratedRegex("^[a-p]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdPattern();

    [GeneratedRegex(
        "^[0-9]{6,30}-[a-z0-9]{8,128}\\.apps\\.googleusercontent\\.com$",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex GoogleOAuthClientIdPattern();
}
