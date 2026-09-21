using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace OFEnhancer.Desktop;

// Owns only the Windows side of Fresh maintenance. Chrome reset intent is
// durably seeded here, then resumed exclusively by the installed application.
internal static class FreshReinstallMaintenance
{
    internal static bool TryRun(IReadOnlyList<string> args, out int exitCode)
    {
        exitCode = 0;
        try
        {
            if (args.Contains("--fresh-reinstall-status", StringComparer.Ordinal))
            {
                exitCode = File.Exists(AppConfiguration.MaintenanceTransactionPath) ? 0 : 1;
                return true;
            }
            if (args.Contains("--fresh-reinstall-plan", StringComparer.Ordinal))
            {
                Plan(args);
                return true;
            }
            if (args.Contains("--fresh-reinstall-previous-package-removed", StringComparer.Ordinal))
            {
                LoadMatching(args).MarkPreviousPackageRemoved();
                return true;
            }
            if (args.Contains("--fresh-reinstall-clean", StringComparer.Ordinal))
            {
                LoadMatching(args).CleanOwnedState();
                return true;
            }
            if (args.Contains("--fresh-reinstall-installed", StringComparer.Ordinal))
            {
                using FinalizationLock finalization = AcquireFinalizationLock();
                FreshReinstallTransaction transaction = LoadMatching(args);
                FinalizeInstalledPackage(transaction, Argument(args, "--install-root"), Argument(args, "--package-version"));
                return true;
            }
            if (args.Contains("--uninstall-clean-data", StringComparer.Ordinal))
            {
                CleanUninstallData();
                return true;
            }
            return false;
        }
        catch (Exception error)
        {
            Debug.WriteLine("OFEnhancer maintenance failed: " + error);
            exitCode = 3;
            return true;
        }
    }

    internal static bool StartupAllowed(out string message)
    {
        message = "";
        if (!File.Exists(AppConfiguration.MaintenanceTransactionPath)) return true;
        try
        {
            using FinalizationLock finalization = AcquireFinalizationLock();
            FreshReinstallTransaction transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
            if (transaction.Phase is FreshReinstallPhase.OwnedStatePurged or FreshReinstallPhase.CleanPackageInstalled
                or FreshReinstallPhase.ChromeObligationAcknowledged or FreshReinstallPhase.Complete)
                FinalizeInstalledPackage(transaction, transaction.InstallRoot, transaction.PackageVersion);
            if (!File.Exists(AppConfiguration.MaintenanceTransactionPath)) return true;
            transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
            message = transaction.Phase switch
            {
                FreshReinstallPhase.Preflight => "Fresh reinstall is paused before Windows cleanup. Rerun the installer to continue; Chrome has not been marked complete.",
                FreshReinstallPhase.PreviousPackageRemoved => "The previous Windows package was removed. Rerun the installer to finish the clean installation.",
                FreshReinstallPhase.InstallRootPurged or FreshReinstallPhase.DataRootPurged => "Fresh reinstall cleanup is partially complete. Rerun the installer to continue from its durable checkpoint.",
                _ => "The Windows part of Fresh reinstall has not finished. Rerun the installer to continue from the saved checkpoint.",
            };
            return false;
        }
        catch
        {
            message = "The Windows Fresh maintenance record could not be verified. Rerun the matching installer; no Chrome completion is assumed.";
            return false;
        }
    }

    private static void Plan(IReadOnlyList<string> args)
    {
        string installRoot = Path.GetFullPath(Argument(args, "--install-root"));
        string version = Argument(args, "--package-version");
        string dataRoot = AppConfiguration.ResolveDataRoot(create: false);
        string webViewRoot = AppConfiguration.ResolveWebViewRoot(create: false);
        bool webViewExclusive = AppConfiguration.IsExclusiveWebViewRoot(webViewRoot) || !Directory.Exists(webViewRoot);
        if (!webViewExclusive)
            throw new InvalidOperationException("The configured WebView2 folder is not proven exclusive to OFEnhancer.");

        FreshReinstallTransaction transaction;
        bool created = false;
        if (File.Exists(AppConfiguration.MaintenanceTransactionPath))
        {
            transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
            transaction.AdoptPendingPackage(version, installRoot, dataRoot, webViewRoot);
        }
        else
        {
            if (!Directory.Exists(installRoot) || !File.Exists(Path.Combine(installRoot, "package-manifest.json")))
                throw new InvalidOperationException("The previous OFEnhancer installation root could not be verified.");
            string settingsPath = Path.Combine(dataRoot, "settings.json");
            string oldIdentity = File.Exists(settingsPath)
                ? new DesktopSettingsStore(settingsPath).Load().ExtensionId ?? ChromeIntegration.CanonicalExtensionId
                : ChromeIntegration.CanonicalExtensionId;
            transaction = FreshReinstallTransaction.Create(AppConfiguration.MaintenanceTransactionPath, version,
                installRoot, dataRoot, webViewRoot, [oldIdentity], AppConfiguration.IsExclusiveDataRoot(dataRoot), webViewExclusive);
            created = true;
        }
        ChromeExtensionReset reset = new(AppConfiguration.ChromeResetPath, legacyPath: AppConfiguration.LegacyChromeResetPath);
        if (!reset.IsValid) throw new InvalidOperationException("The Chrome reset record could not be verified.");
        if (created && !reset.Pending)
            reset.Begin(transaction.ExtensionIds[0]);
        if (!reset.Pending)
            throw new InvalidOperationException("The durable Chrome reset obligation could not be established.");
    }

    private static FreshReinstallTransaction LoadMatching(IReadOnlyList<string> args)
    {
        FreshReinstallTransaction transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
        string installRoot = Path.GetFullPath(Argument(args, "--install-root"));
        string version = Argument(args, "--package-version");
        if (!SamePath(transaction.InstallRoot, installRoot) || !string.Equals(transaction.PackageVersion, version, StringComparison.Ordinal))
            throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
        return transaction;
    }

    internal static void FinalizeInstalledPackage(FreshReinstallTransaction transaction, string installRoot, string version)
    {
        installRoot = Path.GetFullPath(installRoot);
        if (!string.Equals(transaction.PackageVersion, version, StringComparison.Ordinal) || !SamePath(transaction.InstallRoot, installRoot))
            throw new InvalidOperationException("The clean package does not match the committed Fresh reinstall transaction.");
        if (transaction.Phase == FreshReinstallPhase.Complete)
        {
            transaction.CompleteAndDelete();
            return;
        }
        if (transaction.Phase == FreshReinstallPhase.ChromeObligationAcknowledged)
        {
            transaction.CompleteAndDelete();
            return;
        }
        if (transaction.Phase is not (FreshReinstallPhase.OwnedStatePurged or FreshReinstallPhase.CleanPackageInstalled))
            throw new InvalidOperationException("The clean package cannot be finalized from the current Windows phase.");
        VerifyInstalledPackage(installRoot, version);
        ChromeExtensionReset reset = new(AppConfiguration.ChromeResetPath, legacyPath: AppConfiguration.LegacyChromeResetPath);
        if (!reset.IsValid || !reset.Pending)
            throw new InvalidOperationException("The Windows package is valid, but its durable Chrome reset obligation is missing.");
        if (transaction.Phase == FreshReinstallPhase.OwnedStatePurged)
            transaction.Advance(FreshReinstallPhase.CleanPackageInstalled, "clean-package-verified");
        transaction.Advance(FreshReinstallPhase.ChromeObligationAcknowledged, "chrome-obligation-acknowledged");
        transaction.CompleteAndDelete();
    }

    private static void CleanUninstallData()
    {
        string dataRoot = AppConfiguration.ResolveDataRoot(create: false);
        string webViewRoot = AppConfiguration.ResolveWebViewRoot(create: false);
        bool webViewExclusive = AppConfiguration.IsExclusiveWebViewRoot(webViewRoot) || !Directory.Exists(webViewRoot);
        FreshReinstallTransaction.CleanUserData(dataRoot, webViewRoot, AppConfiguration.IsExclusiveDataRoot(dataRoot), webViewExclusive);
    }

    private static FinalizationLock AcquireFinalizationLock()
    {
        string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        Mutex mutex = new(false, $"Local\\OFEnhancer.FreshFinalization.{userKey}");
        try { if (!mutex.WaitOne(TimeSpan.FromSeconds(10))) throw new TimeoutException("OFEnhancer maintenance is already running."); }
        catch (AbandonedMutexException) { }
        return new FinalizationLock(mutex);
    }

    private sealed class FinalizationLock(Mutex mutex) : IDisposable
    {
        private bool released;
        public void Dispose()
        {
            if (released) return;
            released = true; mutex.ReleaseMutex(); mutex.Dispose();
        }
    }

    private static void VerifyInstalledPackage(string root, string version)
    {
        string manifestPath = Path.Combine(root, "package-manifest.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(manifestPath));
        if (document.RootElement.GetProperty("product").GetString() != "OFEnhancer"
            || document.RootElement.GetProperty("productVersion").GetString() != version)
            throw new InvalidOperationException("The installed package inventory has the wrong version.");
        string prefix = Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar;
        foreach (JsonElement entry in document.RootElement.GetProperty("files").EnumerateArray())
        {
            string relative = entry.GetProperty("path").GetString() ?? "";
            string file = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
                throw new InvalidOperationException("The installed package inventory is incomplete.");
            using FileStream stream = File.OpenRead(file);
            if (stream.Length != entry.GetProperty("size").GetInt64()
                || !Convert.ToHexString(SHA256.HashData(stream)).Equals(entry.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("An installed package file failed verification: " + relative);
        }
    }

    private static string Argument(IReadOnlyList<string> args, string name)
    {
        for (int index = 0; index < args.Count - 1; index++)
            if (string.Equals(args[index], name, StringComparison.Ordinal)) return args[index + 1];
        throw new InvalidOperationException("OFEnhancer maintenance is missing " + name + ".");
    }
    private static bool SamePath(string left, string right) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(left))
        .Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)), StringComparison.OrdinalIgnoreCase);
}
