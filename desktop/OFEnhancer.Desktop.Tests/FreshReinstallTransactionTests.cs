using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class FreshReinstallTransactionTests
{
    [TestMethod]
    public void Windows_finalization_retires_only_windows_record_and_keeps_chrome_obligation()
    {
        using var fixture = new Fixture();
        FreshReinstallTransaction transaction = fixture.Create();
        new ChromeExtensionReset(fixture.ResetPath).Begin(ChromeIntegration.CanonicalExtensionId);
        transaction.MarkPreviousPackageRemoved();
        transaction.CleanOwnedState();
        fixture.WriteInstalledPackage();

        string? previousDataRoot = Environment.GetEnvironmentVariable("OFENHANCER_DATA_ROOT");
        try
        {
            Environment.SetEnvironmentVariable("OFENHANCER_DATA_ROOT", fixture.Data);
            FreshReinstallMaintenance.FinalizeInstalledPackage(transaction, fixture.Install, Fixture.Version);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OFENHANCER_DATA_ROOT", previousDataRoot);
        }

        Assert.IsFalse(File.Exists(fixture.TransactionPath));
        Assert.IsTrue(File.Exists(fixture.ResetPath), "the app-owned Chrome task must survive Windows retirement");
        Assert.IsTrue(new ChromeExtensionReset(fixture.ResetPath).Pending);
        Assert.IsFalse(File.Exists(Path.Combine(fixture.Data, "data", "chrome-reset.json")), "there is no copied authority");
    }

    [TestMethod]
    public void Repeated_cleanup_uses_checkpoints_and_does_not_delete_newly_installed_files()
    {
        using var fixture = new Fixture();
        FreshReinstallTransaction transaction = fixture.Create();
        transaction.MarkPreviousPackageRemoved();
        transaction.CleanOwnedState();
        fixture.WriteInstalledPackage();

        FreshReinstallTransaction.Load(fixture.TransactionPath).CleanOwnedState();
        Assert.IsTrue(File.Exists(Path.Combine(fixture.Install, "payload.bin")));
        Assert.AreEqual(FreshReinstallPhase.OwnedStatePurged, FreshReinstallTransaction.Load(fixture.TransactionPath).Phase);
    }

    [TestMethod]
    public void Repair_package_can_resume_every_phase_without_repeating_cleanup()
    {
        foreach (FreshReinstallPhase phase in Enum.GetValues<FreshReinstallPhase>())
        {
            using var fixture = new Fixture();
            FreshReinstallTransaction transaction = fixture.Create("0.20.35");
            while (transaction.Phase < phase) transaction.Advance(transaction.Phase + 1, "fixture-checkpoint");
            string generation = transaction.Generation;
            transaction.AdoptPendingPackage("0.20.35", fixture.Install, fixture.Data, fixture.WebView);
            transaction.AdoptPendingPackage("0.20.102", fixture.Install, fixture.Data, fixture.WebView);
            transaction = FreshReinstallTransaction.Load(fixture.TransactionPath);
            Assert.AreEqual(phase, transaction.Phase);
            Assert.AreEqual(generation, transaction.Generation);
            Assert.AreEqual("0.20.102", transaction.PackageVersion);
            Assert.ThrowsException<InvalidOperationException>(() =>
                transaction.AdoptPendingPackage("0.20.35", fixture.Install, fixture.Data, fixture.WebView));
            Assert.ThrowsException<InvalidOperationException>(() =>
                transaction.AdoptPendingPackage("0.20.102", fixture.Install + "-other", fixture.Data, fixture.WebView));
        }
    }

    [TestMethod]
    public void Helper_recovers_missing_uninstaller_and_missing_reset_write_then_resumes_cleanup()
    {
        using var fixture = new Fixture();
        fixture.WriteInstalledPackage();
        fixture.Create(); // Simulate interruption before the Chrome journal write.
        fixture.WithEnvironment(() =>
        {
            Assert.IsTrue(FreshReinstallMaintenance.StartupAllowed(out _));
            fixture.Run("--fresh-reinstall-plan");
            Assert.IsTrue(new ChromeExtensionReset(fixture.ResetPath).Pending);
            fixture.Run("--fresh-reinstall-needs-uninstall", expected: 0);
            fixture.Run("--fresh-reinstall-previous-package-removed");
            fixture.Run("--fresh-reinstall-clean");
            fixture.WriteInstalledPackage();
            File.WriteAllText(Path.Combine(fixture.Data, "keep-after-cleanup.txt"), "keep");
            fixture.Run("--fresh-reinstall-plan");
            fixture.Run("--fresh-reinstall-needs-uninstall", expected: 1);
            fixture.Run("--fresh-reinstall-clean");
            Assert.IsTrue(File.Exists(Path.Combine(fixture.Install, "payload.bin")));
            Assert.IsTrue(File.Exists(Path.Combine(fixture.Data, "keep-after-cleanup.txt")));
            fixture.Run("--fresh-reinstall-installed");
            fixture.Run("--fresh-reinstall-status", expected: 1);
        });
    }

    [TestMethod]
    public void Invalid_reset_does_not_create_a_transaction_and_corrupt_status_is_not_absence()
    {
        using var fixture = new Fixture();
        fixture.WriteInstalledPackage();
        Directory.CreateDirectory(Path.GetDirectoryName(fixture.ResetPath)!);
        File.WriteAllText(fixture.ResetPath, "invalid");
        fixture.WithEnvironment(() =>
        {
            fixture.Run("--fresh-reinstall-plan", expected: 3);
            Assert.IsFalse(File.Exists(fixture.TransactionPath));
            File.WriteAllText(fixture.TransactionPath, "invalid");
            fixture.Run("--fresh-reinstall-status", expected: 3);
        });
    }

    [TestMethod]
    public void Missing_uninstaller_recovery_requires_a_product_manifest()
    {
        using var fixture = new Fixture();
        File.WriteAllText(Path.Combine(fixture.Install, "package-manifest.json"), "{\"product\":\"Other\",\"productVersion\":\"1.0.0\",\"files\":[]}");
        Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallMaintenance.VerifyPreviousPackage(fixture.Install));
        fixture.WriteInstalledPackage();
        FreshReinstallMaintenance.VerifyPreviousPackage(fixture.Install);
    }

    [TestMethod]
    public void Update_guard_ends_at_its_bound_when_the_guard_file_is_left_behind()
    {
        using var fixture = new Fixture();
        string guardFile = Path.Combine(fixture.Root, "guard");
        File.WriteAllText(guardFile, "running");
        long now = 0;
        int stops = 0;
        FreshReinstallMaintenance.RunUpdateGuard(guardFile, () => stops++, TimeSpan.FromMinutes(30), () => now, ms => now += ms);
        Assert.IsTrue(now >= TimeSpan.FromMinutes(30).TotalMilliseconds);
        Assert.IsTrue(now < TimeSpan.FromMinutes(30).TotalMilliseconds + 1000);
        Assert.IsTrue(stops > 0);
    }

    [TestMethod]
    public void Update_guard_ends_when_the_guard_file_is_removed()
    {
        using var fixture = new Fixture();
        string guardFile = Path.Combine(fixture.Root, "guard");
        File.WriteAllText(guardFile, "running");
        long now = 0;
        int stops = 0;
        FreshReinstallMaintenance.RunUpdateGuard(guardFile, () => { if (++stops == 3) File.Delete(guardFile); }, TimeSpan.FromMinutes(30), () => now, ms => now += ms);
        Assert.AreEqual(3, stops);
        Assert.IsTrue(now < 1000);
    }

    [TestMethod]
    public void Shared_data_siblings_survive_and_ambiguous_webview_fails_closed()
    {
        using var fixture = new Fixture(sharedData: true, webViewExclusive: false);
        File.WriteAllText(Path.Combine(fixture.Data, "unrelated.txt"), "keep");
        FreshReinstallTransaction transaction = fixture.Create(dataExclusive: false, webViewExclusive: false);
        transaction.MarkPreviousPackageRemoved();
        Assert.ThrowsException<InvalidOperationException>(transaction.CleanOwnedState);
        Assert.AreEqual("keep", File.ReadAllText(Path.Combine(fixture.Data, "unrelated.txt")));
        Assert.IsTrue(File.Exists(Path.Combine(fixture.WebView, "foreign.txt")));
        Assert.AreEqual(FreshReinstallPhase.DataRootPurged, FreshReinstallTransaction.Load(fixture.TransactionPath).Phase);

        File.WriteAllText(Path.Combine(fixture.Data, "created-after-checkpoint.txt"), "preserve");
        Assert.ThrowsException<InvalidOperationException>(() =>
            FreshReinstallTransaction.Load(fixture.TransactionPath).CleanOwnedState());
        Assert.AreEqual("preserve", File.ReadAllText(Path.Combine(fixture.Data, "created-after-checkpoint.txt")));
    }

    [DataTestMethod]
    [DataRow("99")]
    [DataRow("0")]
    [DataRow("Preflight,Complete")]
    public void Journal_with_an_undefined_phase_is_corrupt(string phase)
    {
        using var fixture = new Fixture();
        fixture.Create();
        File.WriteAllText(fixture.TransactionPath,
            File.ReadAllText(fixture.TransactionPath).Replace("\"Phase\":\"Preflight\"", $"\"Phase\":\"{phase}\""));
        Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallTransaction.Load(fixture.TransactionPath));
    }

    [TestMethod]
    public void Shared_root_cleanup_deletes_only_owned_entries_and_reports_unowned_content()
    {
        using var fixture = new Fixture(sharedData: true);
        string data = Path.Combine(fixture.Data, "data");
        string[] owned = ["google-desktop-client.dat", "google-oauth-token.dat", "catalogue.db-wal", "chrome-reset.json",
            "google-oauth-token.dat." + new string('a', 32) + ".tmp"];
        foreach (string name in owned) File.WriteAllText(Path.Combine(data, name), "owned");
        File.WriteAllText(Path.Combine(data, "unrelated.txt"), "keep");
        Directory.CreateDirectory(Path.Combine(data, "unrelated-folder"));
        File.WriteAllText(Path.Combine(data, "unrelated-folder", "inner.txt"), "keep");
        FreshReinstallTransaction transaction = fixture.Create(dataExclusive: false);
        transaction.MarkPreviousPackageRemoved();
        transaction.CleanOwnedState();

        Assert.AreEqual("keep", File.ReadAllText(Path.Combine(data, "unrelated.txt")));
        Assert.AreEqual("keep", File.ReadAllText(Path.Combine(data, "unrelated-folder", "inner.txt")));
        foreach (string name in owned.Append("catalogue.db")) Assert.IsFalse(File.Exists(Path.Combine(data, name)), name);
        Assert.IsFalse(File.Exists(Path.Combine(fixture.Data, "settings.json")));
        Assert.AreEqual(FreshReinstallPhase.OwnedStatePurged, FreshReinstallTransaction.Load(fixture.TransactionPath).Phase);
        using JsonDocument journal = JsonDocument.Parse(File.ReadAllText(fixture.TransactionPath));
        CollectionAssert.Contains(journal.RootElement.GetProperty("Observations").EnumerateArray().Select(item => item.GetString()).ToArray(),
            "data-root-purged-unowned-content-remains");
    }

    [TestMethod]
    public void Shared_root_cleanup_removes_sqlite_side_files_of_owned_backup_and_restore_databases_only()
    {
        using var fixture = new Fixture(sharedData: true);
        string data = Path.Combine(fixture.Data, "data");
        string backup = "catalogue.db.backup-v3-abc_9.sqlite", restore = "catalogue.db.restore-" + new string('b', 32) + ".sqlite";
        string[] owned = [.. new[] { backup, restore }.SelectMany(name => new[] { name, name + "-journal", name + "-wal", name + "-shm" })];
        string[] unrelated = ["other.sqlite-wal", backup + "-bak", "unrelated.sqlite-journal", "catalogue.db.backup-v3-abc_9.sqlite-wal.keep"];
        foreach (string name in owned.Concat(unrelated)) File.WriteAllText(Path.Combine(data, name), "x");
        FreshReinstallTransaction transaction = fixture.Create(dataExclusive: false);
        transaction.MarkPreviousPackageRemoved();
        transaction.CleanOwnedState();

        foreach (string name in owned) Assert.IsFalse(File.Exists(Path.Combine(data, name)), name);
        foreach (string name in unrelated) Assert.IsTrue(File.Exists(Path.Combine(data, name)), name);
    }

    [TestMethod]
    public void Shared_root_with_only_owned_data_is_fully_cleaned_without_an_unowned_report()
    {
        using var fixture = new Fixture(sharedData: true);
        FreshReinstallTransaction transaction = fixture.Create(dataExclusive: false);
        transaction.MarkPreviousPackageRemoved();
        transaction.CleanOwnedState();
        Assert.IsFalse(Directory.Exists(Path.Combine(fixture.Data, "data")));
        Assert.IsFalse(File.ReadAllText(fixture.TransactionPath).Contains("unowned-content-remains"));
    }

    [TestMethod]
    public void Exclusive_root_cleanup_still_removes_everything_including_unrecognised_content()
    {
        using var fixture = new Fixture();
        File.WriteAllText(Path.Combine(fixture.Data, "data", "unrecognised.bin"), "x");
        FreshReinstallTransaction transaction = fixture.Create();
        transaction.MarkPreviousPackageRemoved();
        transaction.CleanOwnedState();
        Assert.IsFalse(Directory.Exists(fixture.Data));
    }

    [TestMethod]
    public void Legacy_chrome_phases_migrate_without_claiming_chrome_completion()
    {
        using var fixture = new Fixture();
        Directory.CreateDirectory(Path.GetDirectoryName(fixture.TransactionPath)!);
        File.WriteAllText(fixture.TransactionPath, JsonSerializer.Serialize(new
        {
            Schema = 1, Generation = Guid.NewGuid().ToString(), StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            PackageVersion = Fixture.Version, Phase = "ChromeSetupPending", InstallRoot = fixture.Install,
            DataRoot = fixture.Data, WebViewRoot = fixture.WebView, DataRootExclusive = true,
            WebViewRootExclusive = true, ExtensionIds = new[] { ChromeIntegration.CanonicalExtensionId },
            Observations = Array.Empty<string>(),
        }));
        FreshReinstallTransaction migrated = FreshReinstallTransaction.Load(fixture.TransactionPath);
        Assert.AreEqual(FreshReinstallPhase.CleanPackageInstalled, migrated.Phase);
        Assert.AreEqual(2, JsonDocument.Parse(File.ReadAllText(fixture.TransactionPath)).RootElement.GetProperty("Schema").GetInt32());

        string completedPath = Path.Combine(fixture.Root, "completed-maintenance", "fresh-reinstall.json");
        Directory.CreateDirectory(Path.GetDirectoryName(completedPath)!);
        File.WriteAllText(completedPath, JsonSerializer.Serialize(new
        {
            Schema = 1, Generation = Guid.NewGuid().ToString(), StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            PackageVersion = Fixture.Version, Phase = "Complete", InstallRoot = fixture.Install,
            DataRoot = fixture.Data, WebViewRoot = fixture.WebView, DataRootExclusive = true,
            WebViewRootExclusive = true, ExtensionIds = new[] { ChromeIntegration.CanonicalExtensionId },
            Observations = Array.Empty<string>(),
        }));
        Assert.AreEqual(FreshReinstallPhase.ChromeObligationAcknowledged,
            FreshReinstallTransaction.Load(completedPath).Phase);
    }

    [TestMethod]
    public void Corrupt_transaction_and_overlapping_roots_fail_closed()
    {
        using var fixture = new Fixture();
        Directory.CreateDirectory(Path.GetDirectoryName(fixture.TransactionPath)!);
        File.WriteAllText(fixture.TransactionPath, "not-json");
        Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallTransaction.Load(fixture.TransactionPath));
        File.Delete(fixture.TransactionPath);
        Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallTransaction.Create(
            fixture.TransactionPath, Fixture.Version, fixture.Install, fixture.Root, fixture.WebView,
            [ChromeIntegration.CanonicalExtensionId]));
    }

    private sealed class Fixture : IDisposable
    {
        internal const string Version = "0.20.102";
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), "ofe-fresh-" + Guid.NewGuid().ToString("N"));
        internal string Install => Path.Combine(Root, "installed");
        internal string Data => Path.Combine(Root, "data");
        internal string WebView => Path.Combine(Root, "webview");
        internal string TransactionPath => Path.Combine(Root, "OFEnhancer-Maintenance", "fresh-reinstall.json");
        internal string ResetPath => Path.Combine(Root, "OFEnhancer-Maintenance", "chrome-reset.json");

        internal Fixture(bool sharedData = false, bool webViewExclusive = true)
        {
            Directory.CreateDirectory(Install);
            Directory.CreateDirectory(Path.Combine(Data, "data"));
            Directory.CreateDirectory(WebView);
            File.WriteAllText(Path.Combine(Install, "old.bin"), "old");
            File.WriteAllText(Path.Combine(Data, "data", "catalogue.db"), "old");
            File.WriteAllText(Path.Combine(Data, "settings.json"), "old");
            File.WriteAllText(Path.Combine(WebView, webViewExclusive ? "cache.bin" : "foreign.txt"), "old");
        }

        internal FreshReinstallTransaction Create(string version = Version, bool dataExclusive = true, bool webViewExclusive = true) =>
            FreshReinstallTransaction.Create(TransactionPath, version, Install, Data, WebView,
                [ChromeIntegration.CanonicalExtensionId], dataExclusive, webViewExclusive);

        internal void WriteInstalledPackage()
        {
            Directory.CreateDirectory(Install);
            Directory.CreateDirectory(Data);
            string payload = Path.Combine(Install, "payload.bin");
            File.WriteAllText(payload, "clean-package");
            byte[] bytes = File.ReadAllBytes(payload);
            File.WriteAllText(Path.Combine(Install, "package-manifest.json"), JsonSerializer.Serialize(new
            {
                product = "OFEnhancer", productVersion = Version,
                files = new[] { new { path = "payload.bin", size = bytes.LongLength, sha256 = Convert.ToHexString(SHA256.HashData(bytes)) } },
            }));
        }

        internal void WithEnvironment(Action action)
        {
            string? data = Environment.GetEnvironmentVariable("OFENHANCER_DATA_ROOT");
            string? webView = Environment.GetEnvironmentVariable("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER");
            try
            {
                Environment.SetEnvironmentVariable("OFENHANCER_DATA_ROOT", Data);
                Environment.SetEnvironmentVariable("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER", WebView);
                File.WriteAllText(Path.Combine(WebView, ".ofenhancer-webview-owned.json"), "{\"schema\":1,\"owner\":\"OFEnhancer\"}");
                action();
            }
            finally
            {
                Environment.SetEnvironmentVariable("OFENHANCER_DATA_ROOT", data);
                Environment.SetEnvironmentVariable("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER", webView);
            }
        }

        internal void Run(string operation, int expected = 0)
        {
            string errorPath = Path.Combine(Root, "error.txt");
            Assert.IsTrue(FreshReinstallMaintenance.TryRun([operation, "--install-root", Install,
                "--package-version", Version, "--error-file", errorPath], out int code));
            Assert.AreEqual(expected, code, File.Exists(errorPath) ? File.ReadAllText(errorPath) : operation);
        }

        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
    }
}
