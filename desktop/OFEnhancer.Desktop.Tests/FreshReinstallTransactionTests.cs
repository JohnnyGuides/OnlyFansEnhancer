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
    public void Newer_package_can_adopt_before_destructive_effect_but_not_after()
    {
        using var fixture = new Fixture();
        FreshReinstallTransaction transaction = fixture.Create("0.20.30");
        transaction.AdoptPendingPackage("0.20.31", fixture.Install, fixture.Data, fixture.WebView);
        Assert.AreEqual("0.20.31", FreshReinstallTransaction.Load(fixture.TransactionPath).PackageVersion);
        transaction.MarkPreviousPackageRemoved();
        Assert.ThrowsException<InvalidOperationException>(() =>
            transaction.AdoptPendingPackage("0.20.32", fixture.Install, fixture.Data, fixture.WebView));
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
        internal const string Version = "0.20.35";
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
            string payload = Path.Combine(Install, "payload.bin");
            File.WriteAllText(payload, "clean-package");
            byte[] bytes = File.ReadAllBytes(payload);
            File.WriteAllText(Path.Combine(Install, "package-manifest.json"), JsonSerializer.Serialize(new
            {
                product = "OFEnhancer", productVersion = Version,
                files = new[] { new { path = "payload.bin", size = bytes.LongLength, sha256 = Convert.ToHexString(SHA256.HashData(bytes)) } },
            }));
        }

        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
    }
}
