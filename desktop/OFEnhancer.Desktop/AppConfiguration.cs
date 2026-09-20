using System.IO;
using System.Text.RegularExpressions;
using System.Text.Json;

namespace OFEnhancer.Desktop;

public static partial class AppConfiguration
{
    internal static void ApplyFreshInstallerDefaults(string installRoot, string settingsPath)
    {
        string defaults = Path.Combine(installRoot, "installer-defaults.json");
        if (!File.Exists(defaults)) return;
        // Uses the same strict schema/normalization as ordinary settings. Existing values always win.
        DesktopSettingsStore defaultsStore = new(defaults);
        if (!defaultsStore.TryLoad(out DesktopSettings installerValues)) return;
        DesktopSettingsStore settings = new(settingsPath);
        DesktopSettings current = DesktopSettings.Empty;
        if (File.Exists(settingsPath) && !settings.TryLoad(out current)) return;
        DesktopSettings merged = new(
            current.ExtensionId ?? installerValues.ExtensionId,
            current.GoogleOAuthClientId ?? installerValues.GoogleOAuthClientId,
            current.BrowserId ?? installerValues.BrowserId
        );
        if (merged != current) settings.Save(merged);
    }
    private const string DataRootEnvironmentVariable = "OFENHANCER_DATA_ROOT";
    private const int MaximumDataRootLength = 1_024;

    public static string SettingsPath => Path.Combine(DataRoot, "settings.json");
    internal static string ChromeResetPath => Path.Combine(DataRoot, "data", "chrome-reset.json");

    public static string CatalogueDatabasePath => Path.Combine(DataRoot, "data", "catalogue.db");

    public static string GoogleTokenPath =>
        Path.Combine(DataRoot, "data", "google-oauth-token.dat");

    public static string GoogleDesktopClientPath =>
        Path.Combine(DataRoot, "data", "google-desktop-client.dat");

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

    internal static string MaintenanceTransactionPath
    {
        get
        {
            // Keep the coordinator beside, never inside, the owned data root so
            // Fresh cleanup cannot delete its own transaction. This also keeps
            // an explicitly configured data root isolated from the normal user
            // profile during package and portable-style runs.
            string dataRoot = ResolveDataRoot(create: false);
            string parent = Directory.GetParent(dataRoot)?.FullName
                ?? throw new InvalidOperationException("The OFEnhancer data root has no safe maintenance parent.");
            return Path.Combine(parent, "OFEnhancer-Maintenance", "fresh-reinstall.json");
        }
    }

    internal static string ResolveDataRoot(bool create)
    {
        string? configuredRoot = Environment.GetEnvironmentVariable(DataRootEnvironmentVariable);
        if (configuredRoot is null)
        {
            string standard = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer");
            if (create) Directory.CreateDirectory(standard);
            return standard;
        }
        if (string.IsNullOrWhiteSpace(configuredRoot) || configuredRoot.Length > MaximumDataRootLength
            || !string.Equals(configuredRoot, configuredRoot.Trim(), StringComparison.Ordinal)
            || !Path.IsPathFullyQualified(configuredRoot)) throw InvalidDataRoot();

        try
        {
            string fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(configuredRoot));
            string? volumeRoot = Path.GetPathRoot(fullRoot);
            if (string.IsNullOrEmpty(volumeRoot)
                || string.Equals(fullRoot, Path.TrimEndingDirectorySeparator(volumeRoot), StringComparison.OrdinalIgnoreCase)
                || File.Exists(fullRoot)) throw InvalidDataRoot();
            if (create) Directory.CreateDirectory(fullRoot);
            return fullRoot;
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or NotSupportedException or UnauthorizedAccessException)
        { throw InvalidDataRoot(exception); }
    }

    internal static string ResolveWebViewRoot(bool create)
    {
        string? configured = Environment.GetEnvironmentVariable("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER");
        string value = configured ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer", "WebView2");
        if (string.IsNullOrWhiteSpace(value) || value.Length > MaximumDataRootLength
            || !string.Equals(value, value.Trim(), StringComparison.Ordinal) || !Path.IsPathFullyQualified(value))
            throw new InvalidOperationException("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER must name an absolute dedicated directory below a volume root.");
        try
        {
            string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
            string volume = Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!);
            if (string.Equals(full, volume, StringComparison.OrdinalIgnoreCase) || File.Exists(full))
                throw new InvalidOperationException();
            if (create) Directory.CreateDirectory(full);
            return full;
        }
        catch (Exception error) when (error is ArgumentException or IOException or NotSupportedException or UnauthorizedAccessException)
        {
            throw new InvalidOperationException("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER must name an absolute dedicated directory below a volume root.", error);
        }
    }

    internal static void EnsureOwnedRootsForStartup()
    {
        EnsureOwnershipMarker(ResolveDataRoot(create: false), ".ofenhancer-owned-root.json");
        EnsureOwnershipMarker(ResolveWebViewRoot(create: false), ".ofenhancer-webview-owned.json");
    }

    internal static bool IsExclusiveDataRoot(string root) =>
        SamePath(root, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer"))
        || HasOwnershipMarker(root, ".ofenhancer-owned-root.json");

    internal static bool IsExclusiveWebViewRoot(string root) =>
        SamePath(root, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OFEnhancer", "WebView2"))
        || HasOwnershipMarker(root, ".ofenhancer-webview-owned.json");

    private static void EnsureOwnershipMarker(string root, string markerName)
    {
        if (Directory.Exists(root))
        {
            if (HasOwnershipMarker(root, markerName) || Directory.EnumerateFileSystemEntries(root).Any()) return;
        }
        else Directory.CreateDirectory(root);
        string marker = Path.Combine(root, markerName);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { schema = 1, owner = "OFEnhancer" });
        using FileStream output = new(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        output.Write(bytes);
        output.Flush(true);
    }

    private static bool HasOwnershipMarker(string root, string markerName)
    {
        try
        {
            string marker = Path.Combine(root, markerName);
            if (!File.Exists(marker) || new FileInfo(marker).Length is <= 0 or > 1024) return false;
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(marker));
            return document.RootElement.GetProperty("schema").GetInt32() == 1
                && document.RootElement.GetProperty("owner").GetString() == "OFEnhancer";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException)
        { return false; }
    }

    private static bool SamePath(string left, string right) =>
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)).Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)), StringComparison.OrdinalIgnoreCase);

    private static string DataRoot
    {
        get => ResolveDataRoot(create: true);
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
