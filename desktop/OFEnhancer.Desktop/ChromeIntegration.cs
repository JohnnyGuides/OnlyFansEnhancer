using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace OFEnhancer.Desktop;

internal sealed record ChromeIntegrationView(string State, string Message, bool HostAvailable,
    bool ChromeFound, bool Prepared, string? ExtensionId, string? ExtensionFolder,
    object BrowserStatus, string? SetupError = null, bool CanOpenExtensions = false, bool ResetPending = false, string? ResetExtensionId = null);

// Only fixed OFEnhancer package paths and current-user registration are writable here.
// Registry inspection is diagnostic evidence, not proof that an extension is loaded.
internal sealed class ChromeIntegration
{
    internal const string HostName = "com.johnnyguides.ofenhancer";
    internal const string CanonicalExtensionId = "aocoaajmhccmefmfebgiiogfdojciild";
    internal const string RegistryPath = @"Software\Google\Chrome\NativeMessagingHosts\" + HostName;
    private readonly string root;
    private readonly DesktopSettingsStore settings;
    private readonly Func<string?> effectiveIdentity;
    private readonly BrowserUploadChannel channel;
    private readonly object gate = new();
    private readonly Func<InstalledBrowser?> findChrome;
    private readonly Func<string[]> registrationTargets;
    private readonly Action<string> register;
    private readonly Func<bool> permanentInstall;
    private string NativeManifest => Path.Combine(root, "native", HostName + ".json");
    private string NativeExecutable => Path.Combine(root, "native", "OFEnhancerNativeBridge.exe");

    private static byte[] ReadBounded(string path, int limit = 65536)
    {
        using var stream = File.OpenRead(path);
        if (stream.Length <= 0 || stream.Length > limit) throw new InvalidOperationException("The setup file has an invalid size. Repair OFEnhancer.");
        var bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        return bytes;
    }

    internal ChromeIntegration(string root, DesktopSettingsStore settings, Func<string?> effectiveIdentity, BrowserUploadChannel channel,
        Func<InstalledBrowser?>? findChrome = null, Func<string[]>? registrationTargets = null,
        Action<string>? register = null, Func<bool>? permanentInstall = null)
    {
        this.root = Path.GetFullPath(root);
        this.settings = settings;
        this.effectiveIdentity = effectiveIdentity;
        this.channel = channel;
        this.findChrome = findChrome ?? FindChrome;
        this.registrationTargets = registrationTargets ?? RegistrationTargets;
        this.register = register ?? RegisterCurrentUser;
        this.permanentInstall = permanentInstall ?? (() =>
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{D4702E08-310F-477A-91DA-DC45603DD6AF}_is1");
            return key?.GetValue("InstallLocation") is string installed && SamePath(installed.TrimEnd('\\'), this.root);
        });
    }

    internal static InstalledBrowser? FindChrome() => InstalledBrowserCatalog.Discover().FirstOrDefault(browser => browser.Id == "chrome");

    internal static void OpenChrome(Uri uri)
    {
        if (uri.Scheme == "chrome")
            throw new InvalidOperationException("Chrome internal pages must be opened through the connected extension.");
        var browser = FindChrome() ?? throw new InvalidOperationException("chrome-not-found");
        ProcessStartInfo start = new(browser.ExecutablePath) { UseShellExecute = false };
        start.ArgumentList.Add(uri.AbsoluteUri);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("chrome-launch-failed");
    }

    internal ChromeIntegrationView Get()
    {
        lock (gate)
        {
            bool chrome = findChrome() is not null;
            string? id = effectiveIdentity();
            string? error = null;
            string? folder = null;
            bool prepared = false;
            string fingerprint = "unprepared";
            try
            {
                ValidateSettings();
                if (id is null) folder = ResolveFolder(CanonicalId());
                if (id is not null)
                {
                    folder = ResolveFolder(id);
                    string[] registered = registrationTargets();
                    if (registered.Length == 0) error = "No owned native bridge registration was found in the Windows registry views checked. Check setup to repair it.";
                    else if (registered.Any(target => !SamePath(target, NativeManifest))) error = "Another installation owns the native bridge registration. Resolve that installation before repairing.";
                    else
                    {
                        var bytes = ReadBounded(NativeManifest);
                        ValidateManifest(bytes, id);
                        fingerprint = id + Convert.ToHexString(SHA256.HashData(bytes));
                        prepared = true;
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or JsonException or InvalidOperationException or UnauthorizedAccessException or KeyNotFoundException or FormatException)
            {
                error = exception is InvalidOperationException ? exception.Message : "The installed native bridge or extension package could not be verified. Check setup.";
            }
            channel.ConfigureIntegration(prepared ? id : null, fingerprint);
            object status = channel.Status();
            var browserStatus = JsonSerializer.SerializeToElement(status);
            int live = browserStatus.GetProperty("browsers").GetArrayLength();
            bool selected = browserStatus.GetProperty("connected").GetBoolean();
            bool selectionRequired = browserStatus.GetProperty("selectionRequired").GetBoolean();
            bool resetting = channel.Reset?.Pending == true;
            if (!resetting && prepared && browserStatus.TryGetProperty("updateRequired", out var update) && update.GetBoolean())
                error = BrowserUploadChannel.ExtensionReloadMessage;
            string state = !chrome ? "not-found" : resetting ? "reset-pending" : error is not null ? "repair" : !prepared ? "setup" : live == 0 ? "offline" : (live > 1 || selectionRequired) && !selected ? "choose" : "connected";
            string message = state switch
            {
                "not-found" => "Install Google Chrome to use Upload. Your catalogue is still available.",
                "reset-pending" => channel.Reset!.Message,
                "repair" => error!,
                "setup" => "Select Set up Chrome, then follow the steps below.",
                "offline" => "Finish the steps below, then check connection.",
                "choose" => "Choose the Chrome window to use in Upload.",
                _ => "Ready to prepare uploads."
            };
            if (state == "not-found" && error is not null) message += " Setup also needs attention: " + error;
            return new(state, message, true, chrome, prepared, id, id is null || id == CanonicalExtensionId ? folder : null, status, error,
                !resetting && live > 0 && (selected || live == 1 && !selectionRequired), resetting, channel.Reset?.PreviousExtensionId);
        }
    }

    private string CanonicalId()
    {
        using var manifest = JsonDocument.Parse(ReadBounded(Path.Combine(root, "extension-keyed", "manifest.json")));
        byte[] key = Convert.FromBase64String(manifest.RootElement.GetProperty("key").GetString()!);
        string id = string.Concat(SHA256.HashData(key).Take(16).SelectMany(value => new[] { (char)('a' + (value >> 4)), (char)('a' + (value & 15)) }));
        if (id != CanonicalExtensionId) throw new InvalidOperationException("The packaged personal identity does not match this desktop build.");
        return id;
    }

    private string ResolveFolder(string id)
    {
        string canonical = CanonicalId();
        string folder = Path.Combine(root, id == canonical ? "extension-keyed" : "extension");
        using var manifest = JsonDocument.Parse(ReadBounded(Path.Combine(folder, "manifest.json")));
        if (id != canonical && manifest.RootElement.TryGetProperty("key", out _))
            throw new InvalidOperationException("The legacy load folder contains a key. Restore its keyless package before continuing; do not remove the existing Chrome extension.");
        if (!File.Exists(Path.Combine(folder, "workflows", "desktop-upload-runtime.js")) || !File.Exists(NativeExecutable))
            throw new InvalidOperationException("The installed extension/native package is incomplete. Repair OFEnhancer.");
        return folder;
    }

    private static bool SamePath(string left, string right) => Path.GetFullPath(left).Equals(Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);

    private static string[] RegistrationTargets()
    {
        List<string> targets = [];
        foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
        {
            foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            {
                using var registry = RegistryKey.OpenBaseKey(hive, view);
                using var key = registry.OpenSubKey(RegistryPath);
                if (key is not null) targets.Add(key.GetValue(null) as string ?? "");
            }
        }
        return targets.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private void ValidateManifest(byte[] bytes, string id)
    {
        if (bytes.Length > 65536) throw new InvalidOperationException("The native bridge manifest is too large.");
        using var document = JsonDocument.Parse(bytes);
        var manifest = document.RootElement;
        if (manifest.GetProperty("name").GetString() != HostName || manifest.GetProperty("type").GetString() != "stdio"
            || !SamePath(manifest.GetProperty("path").GetString()!, NativeExecutable)
            || manifest.GetProperty("allowed_origins").GetArrayLength() != 1
            || manifest.GetProperty("allowed_origins")[0].GetString() != $"chrome-extension://{id}/")
            throw new InvalidOperationException("The owned native bridge manifest does not match the effective extension identity. Check setup to repair it.");
    }

    internal ChromeIntegrationView Prepare()
    {
        lock (gate)
        {
            if (channel.Reset?.Pending == true) return ConfigureFreshReset(false);
            VerifyPackage();
            if (!permanentInstall()) throw new InvalidOperationException("Run OFEnhancer from its permanent installed location before preparing Chrome. Staging and builds do not register hosts.");
            ValidateSettings();
            string? previous = effectiveIdentity();
            string id = previous ?? CanonicalId();
            ResolveFolder(id);
            var targets = registrationTargets();
            if (previous is null && targets.Length > 0)
                throw new InvalidOperationException("An existing registration has no verified effective identity. Preserve the existing extension and repair its saved identity first.");
            if (targets.Any(target => !SamePath(target, NativeManifest)))
                throw new InvalidOperationException("A different installation owns the native bridge. No registration was changed.");
            if (previous is not null && previous != CanonicalId() && targets.Length == 0)
                throw new InvalidOperationException("Legacy installation location is unverified. Preserve its Chrome load folder and use advanced identity repair; do not load the new keyed extension.");
            WriteRegistration(id);
            return Get();
        }
    }

    internal ChromeIntegrationView FreshReset() => ConfigureFreshReset(true);

    private ChromeIntegrationView ConfigureFreshReset(bool begin)
    {
        lock (gate)
        {
            VerifyPackage();
            if (!permanentInstall()) throw new InvalidOperationException("Install this build before starting Fresh reset.");
            ValidateSettings();
            var targets = registrationTargets();
            if (targets.Any(target => !SamePath(target, NativeManifest)))
                throw new InvalidOperationException("Another OFEnhancer installation owns Chrome setup. No extension state was changed.");
            string canonical = CanonicalId();
            ResolveFolder(canonical);
            // Persist the rejection barrier before changing registration or sending
            // a self-uninstall. An interrupted reset remains pending on restart.
            if (begin) channel.BeginReset(effectiveIdentity() ?? canonical);
            else if (channel.Reset?.Pending != true) throw new InvalidOperationException("Start Fresh reset before replacing the previous extension identity.");
            WriteRegistration(canonical);
            return Get();
        }
    }

    private void WriteRegistration(string id)
    {
        // Atomic file/settings commits make retries recoverable. No settings or Chrome storage migration.
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { name = HostName, description = "OFEnhancer desktop bridge", path = NativeExecutable, type = "stdio", allowed_origins = new[] { $"chrome-extension://{id}/" } });
        string temporary = NativeManifest + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllBytes(temporary, bytes); File.Move(temporary, NativeManifest, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        settings.Save(settings.Load() with { ExtensionId = id });
        register(NativeManifest);
    }

    private static void RegisterCurrentUser(string manifest)
    {
        foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
        {
            using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view);
            using var key = user.CreateSubKey(RegistryPath);
            key.SetValue("", manifest);
        }
    }

    private void ValidateSettings()
    {
        if (File.Exists(settings.SettingsPath))
        {
            using var existing = JsonDocument.Parse(ReadBounded(settings.SettingsPath));
            if (existing.RootElement.ValueKind != JsonValueKind.Object
                || existing.RootElement.EnumerateObject().Any(property => property.Name is not ("extensionId" or "googleOAuthClientId" or "browserId"))
                || existing.RootElement.TryGetProperty("extensionId", out var oldId) && oldId.ValueKind != JsonValueKind.Null && AppConfiguration.NormalizeExtensionId(oldId.GetString()) is null
                || existing.RootElement.TryGetProperty("googleOAuthClientId", out var google) && google.ValueKind != JsonValueKind.Null && AppConfiguration.NormalizeGoogleOAuthClientId(google.GetString()) is null
                || existing.RootElement.TryGetProperty("browserId", out var browser) && browser.ValueKind != JsonValueKind.Null && BrowserSelection.NormalizeId(browser.GetString()) is null)
                throw new InvalidOperationException("Existing settings need repair. They were preserved; no new identity was assigned.");
        }
    }

    private void VerifyPackage()
    {
        // Preparation is only available from a complete staged/installed OFEnhancer package.
        using var inventory = JsonDocument.Parse(ReadBounded(Path.Combine(root, "package-manifest.json"), 4 * 1024 * 1024));
        if (inventory.RootElement.GetProperty("product").GetString() != "OFEnhancer")
            throw new InvalidOperationException("The installed package inventory is invalid.");
        foreach (var entry in inventory.RootElement.GetProperty("files").EnumerateArray())
        {
            string relative = entry.GetProperty("path").GetString()!;
            if (!relative.StartsWith("extension", StringComparison.Ordinal) && !relative.StartsWith("native/", StringComparison.Ordinal)) continue;
            string path = Path.GetFullPath(Path.Combine(root, relative));
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The package inventory escapes the install folder.");
            for (string? current = path; current is not null && current.Length >= root.Length; current = Path.GetDirectoryName(current))
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("The installed package contains a redirected path. Repair it before setup.");
            using var stream = File.OpenRead(path);
            if (stream.Length != entry.GetProperty("size").GetInt64()
                || !Convert.ToHexString(SHA256.HashData(stream)).Equals(entry.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The installed package changed or is incomplete. Repair OFEnhancer before setup.");
        }
    }
}
