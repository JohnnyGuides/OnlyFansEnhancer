using System.IO;
using System.Text.RegularExpressions;

namespace OFEnhancer.Desktop;

public static partial class AppConfiguration
{
    private const string DataRootEnvironmentVariable = "OFENHANCER_DATA_ROOT";
    private const int MaximumDataRootLength = 1_024;

    public static string SettingsPath => Path.Combine(DataRoot, "settings.json");

    public static string CatalogueDatabasePath => Path.Combine(DataRoot, "data", "catalogue.db");

    public static string GoogleTokenPath =>
        Path.Combine(DataRoot, "data", "google-oauth-token.dat");

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

    private static string DataRoot
    {
        get
        {
            string? configuredRoot = Environment.GetEnvironmentVariable(DataRootEnvironmentVariable);
            if (configuredRoot is null)
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OFEnhancer"
                );
            }
            if (
                string.IsNullOrWhiteSpace(configuredRoot)
                || configuredRoot.Length > MaximumDataRootLength
                || !string.Equals(configuredRoot, configuredRoot.Trim(), StringComparison.Ordinal)
                || !Path.IsPathFullyQualified(configuredRoot)
            )
            {
                throw InvalidDataRoot();
            }

            try
            {
                string fullRoot = Path.TrimEndingDirectorySeparator(
                    Path.GetFullPath(configuredRoot)
                );
                string? volumeRoot = Path.GetPathRoot(fullRoot);
                if (
                    string.IsNullOrEmpty(volumeRoot)
                    || string.Equals(
                        fullRoot,
                        Path.TrimEndingDirectorySeparator(volumeRoot),
                        StringComparison.OrdinalIgnoreCase
                    )
                    || File.Exists(fullRoot)
                )
                {
                    throw InvalidDataRoot();
                }
                Directory.CreateDirectory(fullRoot);
                return fullRoot;
            }
            catch (Exception exception) when (
                exception is ArgumentException
                    or IOException
                    or NotSupportedException
                    or UnauthorizedAccessException
            )
            {
                throw InvalidDataRoot(exception);
            }
        }
    }

    private static InvalidOperationException InvalidDataRoot(Exception? innerException = null) =>
        new(
            "OFENHANCER_DATA_ROOT must name an absolute, creatable directory below a volume root.",
            innerException
        );

    [GeneratedRegex("^[a-p]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdPattern();

    [GeneratedRegex(
        "^[0-9]{6,30}-[a-z0-9]{8,128}\\.apps\\.googleusercontent\\.com$",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex GoogleOAuthClientIdPattern();
}
