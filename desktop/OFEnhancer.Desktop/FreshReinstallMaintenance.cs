using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using System.Windows;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

internal static class FreshReinstallMaintenance
{
    internal static bool TryRun(IReadOnlyList<string> args, out int exitCode)
    {
        exitCode = 0;
        try
        {
            if (args.Contains("--fresh-reinstall-remove", StringComparer.Ordinal))
            {
                exitCode = RemoveExtension(args);
                return true;
            }
            if (args.Contains("--fresh-reinstall-continue", StringComparer.Ordinal))
            {
                exitCode = ContinueWithoutChromeConfirmation(args);
                return true;
            }
            if (args.Contains("--fresh-reinstall-clean", StringComparer.Ordinal))
            {
                FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath).CleanOwnedState();
                return true;
            }
            if (args.Contains("--fresh-reinstall-installed", StringComparer.Ordinal))
            {
                MarkInstalled(args);
                return true;
            }
            return false;
        }
        catch (Exception error)
        {
            Debug.WriteLine("Fresh reinstall maintenance failed: " + error);
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
            if (transaction.Phase is FreshReinstallPhase.OwnedStatePurged or FreshReinstallPhase.CleanPackageInstalled)
                FinalizeInstalledPackage(transaction, transaction.InstallRoot, transaction.PackageVersion);
            if (FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath).Phase == FreshReinstallPhase.ChromeSetupPending)
                return true;
            message = "OFEnhancer setup has not finished yet. Complete or rerun the installer; your previous data remains protected.";
            return false;
        }
        catch
        {
            message = "OFEnhancer setup has not finished yet. Complete or rerun the installer; your previous data remains protected.";
            return false;
        }
    }

    internal static void CompleteIfChromeReady()
    {
        if (!File.Exists(AppConfiguration.MaintenanceTransactionPath)) return;
        FreshReinstallTransaction transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
        if (transaction.Phase == FreshReinstallPhase.ChromeSetupPending) transaction.CompleteAndDelete();
    }

    private static int RemoveExtension(IReadOnlyList<string> args)
    {
        string installRoot = Path.GetFullPath(Argument(args, "--install-root"));
        string version = Argument(args, "--package-version");
        if (File.Exists(AppConfiguration.MaintenanceTransactionPath))
        {
            FreshReinstallTransaction resumed = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
            if (resumed.Phase >= FreshReinstallPhase.ExtensionRemovalVerified)
            {
                if (!SamePath(resumed.InstallRoot, installRoot))
                    throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
                if (resumed.Phase < FreshReinstallPhase.PreviousPackageRemoved)
                    resumed.AdoptPendingPackage(version, installRoot, resumed.DataRoot, resumed.WebViewRoot);
                else if (!string.Equals(resumed.PackageVersion, version, StringComparison.Ordinal))
                    throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
                return 0;
            }
        }
        if (!Directory.Exists(installRoot) || !File.Exists(Path.Combine(installRoot, "package-manifest.json")))
            throw new InvalidOperationException("The previous OFEnhancer installation root could not be verified.");
        string dataRoot = AppConfiguration.ResolveDataRoot(create: false);
        string webViewRoot = AppConfiguration.ResolveWebViewRoot(create: false);
        bool webViewExclusive = AppConfiguration.IsExclusiveWebViewRoot(webViewRoot) || !Directory.Exists(webViewRoot);
        if (!webViewExclusive)
            throw new InvalidOperationException("The configured WebView2 folder is not proven exclusive to OFEnhancer. Choose a dedicated folder before Fresh reinstall.");
        string? oldIdentity = null;
        string settingsPath = Path.Combine(dataRoot, "settings.json");
        if (File.Exists(settingsPath)) oldIdentity = new DesktopSettingsStore(settingsPath).Load().ExtensionId;
        oldIdentity ??= ChromeIntegration.CanonicalExtensionId;

        FreshReinstallTransaction transaction;
        string transactionPath = AppConfiguration.MaintenanceTransactionPath;
        if (File.Exists(transactionPath))
        {
            transaction = FreshReinstallTransaction.Load(transactionPath);
            if (!SamePath(transaction.InstallRoot, installRoot))
                throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
            transaction.AdoptPendingPackage(version, installRoot, dataRoot, webViewRoot);
        }
        else
        {
            transaction = FreshReinstallTransaction.Create(transactionPath, version, installRoot, dataRoot, webViewRoot,
                [oldIdentity], AppConfiguration.IsExclusiveDataRoot(dataRoot), webViewExclusive);
        }
        if (transaction.Phase >= FreshReinstallPhase.ExtensionRemovalVerified) return 0;

        string resetPath = Path.Combine(transaction.TransactionDirectory, "chrome-reset.json");
        ChromeExtensionReset reset = new(resetPath);
        if (transaction.Phase == FreshReinstallPhase.Preflight && File.Exists(resetPath))
            throw new InvalidOperationException("The Fresh removal journal is inconsistent; setup remains blocked.");
        using BrowserUploadChannel channel = new() { Reset = reset };
        DesktopSettingsStore settings = new(settingsPath);
        ChromeIntegration integration = new(installRoot, settings, () => settings.Load().ExtensionId, channel,
            permanentInstall: () => true);
        if (transaction.Phase == FreshReinstallPhase.Preflight)
        {
            integration.FreshReset();
            transaction.Advance(FreshReinstallPhase.ExtensionRemovalPending, "removal-route-ready");
        }

        string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        using Mutex candidate = new(true, $"Local\\OFEnhancer.Desktop.{userKey}", out bool first);
        if (!first)
            throw new InvalidOperationException("Exit the running OFEnhancer tray application, then run this installer again. The Fresh transaction was preserved.");
        DesktopAgent agent = new(DesktopAgent.DefaultPipeName(userKey), request =>
        {
            if (request.Operation != "browserExchange" || request.Payload is not JsonElement payload)
                return Task.FromResult(AgentResponse.Failure(request.RequestId.ToString(), "maintenance-only"));
            try { return Task.FromResult(AgentResponse.SuccessResult(request, channel.Exchange(payload))); }
            catch (Exception error) { return Task.FromResult(AgentResponse.Failure(request.RequestId.ToString(), error is InvalidOperationException ? error.Message : "maintenance-failed")); }
        });
        agent.Start();
        try
        {
            if (reset.ManualRemovalPending)
            {
                // Setup already displayed the manual instructions. A second
                // click runs this short confirmation window; an old worker that
                // still reports itself keeps the barrier closed.
                reset.BeginManualConfirmation();
                DateTimeOffset manualDeadline = DateTimeOffset.UtcNow.AddSeconds(5);
                while (!reset.RemovalVerified && DateTimeOffset.UtcNow < manualDeadline)
                {
                    reset.TryConfirmManualRemoval(TimeSpan.FromSeconds(2));
                    Thread.Sleep(250);
                }
                if (!reset.RemovalVerified) return 4;
            }
            else
            {
                // The exact old extension clears its Chrome-owned storage and
                // calls uninstallSelf. Successful self-removal destroys the
                // caller before it can reply, so allow a bounded reconnect window.
                DateTimeOffset automaticDeadline = DateTimeOffset.UtcNow.AddSeconds(18);
                while (!reset.RemovalVerified && DateTimeOffset.UtcNow < automaticDeadline)
                {
                    reset.TryConfirmAutomaticRemoval(TimeSpan.FromSeconds(7));
                    Thread.Sleep(250);
                }
                if (!reset.RemovalVerified)
                {
                    // The installer owns the visible fallback copy. Keep this
                    // process windowless, open the exact connected profile, and
                    // return a distinct code so Setup can reveal its inline steps.
                    reset.RequestManualRemoval();
                    Thread.Sleep(1500);
                    return 4;
                }
            }
        }
        finally { agent.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
        transaction.Advance(FreshReinstallPhase.ExtensionRemovalVerified, "chrome-self-removal-or-user-confirmed");
        return 0;
    }

    private static int ContinueWithoutChromeConfirmation(IReadOnlyList<string> args)
    {
        string installRoot = Path.GetFullPath(Argument(args, "--install-root"));
        string version = Argument(args, "--package-version");
        FreshReinstallTransaction transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
        if (!SamePath(transaction.InstallRoot, installRoot))
            throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
        if (transaction.Phase >= FreshReinstallPhase.PreviousPackageRemoved)
        {
            if (!string.Equals(transaction.PackageVersion, version, StringComparison.Ordinal))
                throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
            return 0;
        }
        transaction.AdoptPendingPackage(version, installRoot, transaction.DataRoot, transaction.WebViewRoot);
        if (transaction.Phase >= FreshReinstallPhase.ExtensionRemovalVerified) return 0;
        if (transaction.Phase != FreshReinstallPhase.ExtensionRemovalPending)
            throw new InvalidOperationException("Chrome removal has not been staged safely.");
        string resetPath = Path.Combine(transaction.TransactionDirectory, "chrome-reset.json");
        ChromeExtensionReset reset = new(resetPath);
        reset.AcceptUnverifiedContinuation();
        transaction.Advance(FreshReinstallPhase.ExtensionRemovalVerified, "chrome-removal-unconfirmed-user-continued");
        return 0;
    }

    private static void MarkInstalled(IReadOnlyList<string> args)
    {
        string installRoot = Path.GetFullPath(Argument(args, "--install-root"));
        string version = Argument(args, "--package-version");
        using FinalizationLock finalization = AcquireFinalizationLock();
        FreshReinstallTransaction transaction = FreshReinstallTransaction.Load(AppConfiguration.MaintenanceTransactionPath);
        FinalizeInstalledPackage(transaction, installRoot, version);
    }

    internal static void FinalizeInstalledPackage(FreshReinstallTransaction transaction, string installRoot, string version)
    {
        if (!string.Equals(transaction.PackageVersion, version, StringComparison.Ordinal)
            || !SamePath(transaction.InstallRoot, installRoot))
            throw new InvalidOperationException("The clean package does not match the committed Fresh reinstall transaction.");
        if (transaction.Phase == FreshReinstallPhase.ChromeSetupPending) return;
        if (transaction.Phase is not (FreshReinstallPhase.OwnedStatePurged or FreshReinstallPhase.CleanPackageInstalled))
            throw new InvalidOperationException("The clean package cannot be finalized from the current Fresh reinstall phase.");
        VerifyInstalledPackage(installRoot, version);
        string sourceReset = Path.Combine(transaction.TransactionDirectory, "chrome-reset.json");
        if (!File.Exists(sourceReset)) throw new InvalidOperationException("The Fresh Chrome admission journal is missing.");
        string destinationReset = Path.Combine(transaction.DataRoot, "data", "chrome-reset.json");
        Directory.CreateDirectory(Path.GetDirectoryName(destinationReset)!);
        File.Copy(sourceReset, destinationReset, true);
        if (transaction.Phase == FreshReinstallPhase.OwnedStatePurged)
            transaction.Advance(FreshReinstallPhase.CleanPackageInstalled, "clean-package-verified");
        transaction.Advance(FreshReinstallPhase.ChromeSetupPending, "chrome-new-install-pending");
    }

    private static FinalizationLock AcquireFinalizationLock()
    {
        string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        Mutex mutex = new(false, $"Local\\OFEnhancer.FreshFinalization.{userKey}");
        try
        {
            if (!mutex.WaitOne(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Fresh reinstall finalization is already running.");
        }
        catch (AbandonedMutexException) { }
        return new FinalizationLock(mutex);
    }

    private sealed class FinalizationLock(Mutex mutex) : IDisposable
    {
        private bool released;

        public void Dispose()
        {
            if (!released)
            {
                released = true;
                mutex.ReleaseMutex();
                mutex.Dispose();
            }
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
        throw new InvalidOperationException("Fresh reinstall is missing " + name + ".");
    }

    private static bool SamePath(string left, string right) =>
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)).Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)), StringComparison.OrdinalIgnoreCase);
}
