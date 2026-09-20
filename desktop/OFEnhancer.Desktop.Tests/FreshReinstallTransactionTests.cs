using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class FreshReinstallTransactionTests
{
    [TestMethod]
    public void Transaction_is_durable_resumable_and_contains_no_user_state()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-fresh-" + Guid.NewGuid().ToString("N"));
        string install = Path.Combine(root, "installed");
        string data = Path.Combine(root, "data");
        string webView = Path.Combine(root, "webview");
        string transaction = Path.Combine(root, "maintenance", "fresh-reinstall.json");
        Directory.CreateDirectory(install);
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(webView);
        try
        {
            var created = FreshReinstallTransaction.Create(
                transaction,
                "0.20.27",
                install,
                data,
                webView,
                [ChromeIntegration.CanonicalExtensionId]
            );
            created.Advance(FreshReinstallPhase.ExtensionRemovalPending, "removal-route-ready");

            FreshReinstallTransaction loaded = FreshReinstallTransaction.Load(transaction);
            Assert.AreEqual(FreshReinstallPhase.ExtensionRemovalPending, loaded.Phase);
            Assert.AreEqual(Path.GetFullPath(data), loaded.DataRoot);
            string json = File.ReadAllText(transaction);
            Assert.IsFalse(json.Contains("token", StringComparison.OrdinalIgnoreCase));
            Assert.IsFalse(json.Contains("catalogue", StringComparison.OrdinalIgnoreCase));
            Assert.IsFalse(json.Contains("clientSecret", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void Corrupt_transaction_and_dangerous_or_overlapping_roots_fail_closed()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-fresh-invalid-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string transaction = Path.Combine(root, "maintenance", "fresh-reinstall.json");
        Directory.CreateDirectory(Path.GetDirectoryName(transaction)!);
        File.WriteAllText(transaction, "not-json");
        try
        {
            Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallTransaction.Load(transaction));
            Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallTransaction.Create(
                transaction,
                "0.20.27",
                Path.GetPathRoot(root)!,
                Path.Combine(root, "data"),
                Path.Combine(root, "webview"),
                [ChromeIntegration.CanonicalExtensionId]
            ));
            Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallTransaction.Create(
                transaction,
                "0.20.27",
                Path.Combine(root, "install"),
                root,
                Path.Combine(root, "webview"),
                [ChromeIntegration.CanonicalExtensionId]
            ));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void Cleanup_removes_owned_state_and_preserves_shared_siblings()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-fresh-clean-" + Guid.NewGuid().ToString("N"));
        string install = Path.Combine(root, "installed");
        string sharedData = Path.Combine(root, "shared-data");
        string webView = Path.Combine(root, "webview");
        string transaction = Path.Combine(root, "maintenance", "fresh-reinstall.json");
        Directory.CreateDirectory(install);
        Directory.CreateDirectory(Path.Combine(sharedData, "data"));
        Directory.CreateDirectory(webView);
        File.WriteAllText(Path.Combine(install, "obsolete.dll"), "old");
        File.WriteAllText(Path.Combine(sharedData, "settings.json"), "old");
        File.WriteAllText(Path.Combine(sharedData, "data", "catalogue.db"), "old");
        File.WriteAllText(Path.Combine(sharedData, "unrelated.txt"), "keep");
        File.WriteAllText(Path.Combine(webView, "sentinel.txt"), "old");
        try
        {
            var fresh = FreshReinstallTransaction.Create(
                transaction,
                "0.20.27",
                install,
                sharedData,
                webView,
                [ChromeIntegration.CanonicalExtensionId],
                dataRootExclusive: false,
                webViewRootExclusive: true
            );
            fresh.Advance(FreshReinstallPhase.ExtensionRemovalPending, "removal-route-ready");
            fresh.Advance(FreshReinstallPhase.ExtensionRemovalVerified, "observer-absent");
            fresh.CleanOwnedState();

            Assert.IsFalse(Directory.Exists(install));
            Assert.IsFalse(File.Exists(Path.Combine(sharedData, "settings.json")));
            Assert.IsFalse(Directory.Exists(Path.Combine(sharedData, "data")));
            Assert.IsTrue(File.Exists(Path.Combine(sharedData, "unrelated.txt")));
            Assert.IsFalse(Directory.Exists(webView));
            Assert.AreEqual(FreshReinstallPhase.OwnedStatePurged, FreshReinstallTransaction.Load(transaction).Phase);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void Ambiguous_webview_and_locked_install_residue_keep_the_transaction_incomplete()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-fresh-blocked-" + Guid.NewGuid().ToString("N"));
        string install = Path.Combine(root, "installed");
        string data = Path.Combine(root, "data");
        string webView = Path.Combine(root, "shared-webview");
        string transaction = Path.Combine(root, "maintenance", "fresh-reinstall.json");
        Directory.CreateDirectory(install);
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(webView);
        File.WriteAllText(Path.Combine(webView, "foreign.txt"), "keep");
        string locked = Path.Combine(install, "obsolete.locked");
        File.WriteAllText(locked, "old");
        try
        {
            var fresh = FreshReinstallTransaction.Create(transaction, "0.20.27", install, data, webView,
                [ChromeIntegration.CanonicalExtensionId], webViewRootExclusive: false);
            fresh.Advance(FreshReinstallPhase.ExtensionRemovalPending, "removal-route-ready");
            fresh.Advance(FreshReinstallPhase.ExtensionRemovalVerified, "observer-absent");
            using (FileStream hold = new(locked, FileMode.Open, FileAccess.Read, FileShare.None))
                Assert.ThrowsException<IOException>(fresh.CleanOwnedState);
            Assert.AreEqual(FreshReinstallPhase.ExtensionRemovalVerified, FreshReinstallTransaction.Load(transaction).Phase);

            File.Delete(locked);
            Assert.ThrowsException<InvalidOperationException>(fresh.CleanOwnedState);
            Assert.IsTrue(File.Exists(Path.Combine(webView, "foreign.txt")));
            Assert.AreEqual(FreshReinstallPhase.PreviousPackageRemoved, FreshReinstallTransaction.Load(transaction).Phase);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
