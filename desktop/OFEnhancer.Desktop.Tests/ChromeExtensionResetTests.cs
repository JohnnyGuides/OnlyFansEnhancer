using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class ChromeExtensionResetTests
{
    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-09-19T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [TestMethod]
    public void OldReceiptAndReloadNeverCompleteResetAndNewInstallMustWaitForOldSilence()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-reset-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "catalogue.db"), "keep catalogue");
            File.WriteAllText(Path.Combine(root, "settings.json"), "keep desktop settings");
            var clock = new Clock();
            var reset = new ChromeExtensionReset(Path.Combine(root, "chrome-reset.json"), clock);
            string oldBrowser = Guid.NewGuid().ToString(), oldConnection = Guid.NewGuid().ToString();
            JsonElement Receipt(string id, long at) => JsonSerializer.SerializeToElement(new { id, installedAt = at });
            string oldId = Guid.NewGuid().ToString();
            var oldReceipt = Receipt(oldId, clock.Now.AddDays(-1).ToUnixTimeMilliseconds());
            Assert.IsTrue(reset.Observe(oldBrowser, oldConnection, oldReceipt, true).Allowed);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            Assert.IsTrue(reset.Pending);
            var first = reset.Observe(oldBrowser, oldConnection, oldReceipt, true);
            Assert.IsFalse(first.Allowed);
            Assert.AreEqual(1, first.Commands.Length);
            Assert.AreEqual(0, reset.Observe(oldBrowser, oldConnection, oldReceipt, true).Commands.Length);
            clock.Now = clock.Now.AddSeconds(20);
            Assert.IsFalse(reset.Observe(oldBrowser, Guid.NewGuid().ToString(), oldReceipt, true).Allowed, "A reload is still the old installation.");
            reset.ObserveVerifier(ChromeIntegration.MaintenanceVerifierId, [], [ChromeIntegration.CanonicalExtensionId]);
            string freshId = Guid.NewGuid().ToString(), freshBrowser = Guid.NewGuid().ToString(), freshConnection = Guid.NewGuid().ToString();
            var fresh = Receipt(freshId, clock.Now.ToUnixTimeMilliseconds());
            Assert.IsFalse(reset.Observe(freshBrowser, freshConnection, fresh, false).Allowed, "Wrong product version never finishes reset.");
            Assert.IsTrue(reset.Observe(freshBrowser, freshConnection, fresh, true).Allowed);
            Assert.IsFalse(reset.Pending);
            var restarted = new ChromeExtensionReset(Path.Combine(root, "chrome-reset.json"), clock);
            Assert.IsFalse(restarted.Observe(oldBrowser, oldConnection, oldReceipt, true).Allowed, "Old profile cannot reconnect after desktop restart.");
            Assert.IsTrue(restarted.Observe(freshBrowser, freshConnection, fresh, true).Allowed);
            Assert.AreEqual("keep catalogue", File.ReadAllText(Path.Combine(root, "catalogue.db")));
            Assert.AreEqual("keep desktop settings", File.ReadAllText(Path.Combine(root, "settings.json")));
        }
        finally { Directory.Delete(root, true); }
    }

    [TestMethod]
    public void DisconnectionAndSavedIdentityAreNotProofOfFreshInstallation()
    {
        string path = Path.Combine(Path.GetTempPath(), "ofe-reset-" + Guid.NewGuid(), "chrome-reset.json");
        try
        {
            var clock = new Clock();
            var reset = new ChromeExtensionReset(path, clock);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            clock.Now = clock.Now.AddHours(1);
            Assert.IsFalse(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), null, true).Allowed);
            Assert.IsTrue(reset.Pending);
            Assert.IsTrue(reset.Message.Contains("Remove"));
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }
    [TestMethod]
    public async Task ChannelKeepsResetClosedUntilNewInstallAndRejectsWrongBridge()
    {
        string path = Path.Combine(Path.GetTempPath(), "ofe-reset-channel-" + Guid.NewGuid(), "reset.json");
        try
        {
            var clock = new Clock();
            using var channel = new BrowserUploadChannel(clock) { Reset = new ChromeExtensionReset(path, clock) };
            string id = ChromeIntegration.CanonicalExtensionId, browser = Guid.NewGuid().ToString(), connection = Guid.NewGuid().ToString();
            channel.ConfigureIntegration(id, "owned-manifest");
            JsonElement Exchange(string? generation, object? receipt, string bridge) => JsonSerializer.SerializeToElement(channel.Exchange(JsonSerializer.SerializeToElement(new {
                browserId = browser, connectionId = connection, extensionId = id, bridgeExtensionId = bridge,
                extensionVersion = OFEnhancer.Protocol.AgentProtocol.ProductVersion, setupGeneration = generation, installation = receipt
            })));
            string generation = Exchange(null, null, id).GetProperty("setupGeneration").GetString()!;
            var old = new { id = Guid.NewGuid().ToString(), installedAt = clock.Now.AddDays(-1).ToUnixTimeMilliseconds() };
            Exchange(generation, old, id);
            channel.Select(browser);
            var pending = channel.RequestAsync(JsonSerializer.SerializeToElement(new { kind = "storageGet", keys = new[] { "creatorToolkitV2" } }));
            channel.BeginReset(id);
            await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => pending);
            Assert.AreEqual(0, Exchange(generation, old, new string('b', 32)).GetProperty("commands").GetArrayLength());
            var rejected = Exchange(generation, old, id);
            Assert.AreEqual("resetExtension", rejected.GetProperty("commands")[0].GetProperty("command").GetProperty("kind").GetString());
            clock.Now = clock.Now.AddMinutes(1);
            Exchange(generation, null, id);
            Assert.IsFalse(JsonSerializer.SerializeToElement(channel.Status()).GetProperty("connected").GetBoolean());
            await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => channel.RequestAsync(JsonSerializer.SerializeToElement(new { kind = "storageGet" })));
            channel.Exchange(JsonSerializer.SerializeToElement(new {
                browserId = Guid.NewGuid().ToString(), connectionId = Guid.NewGuid().ToString(),
                extensionId = ChromeIntegration.MaintenanceVerifierId, bridgeExtensionId = ChromeIntegration.MaintenanceVerifierId,
                maintenanceVerifier = new { installed = Array.Empty<object>(), uninstalled = new[] { id } }
            }));
            var fresh = new { id = Guid.NewGuid().ToString(), installedAt = clock.Now.ToUnixTimeMilliseconds() };
            Exchange(generation, fresh, id);
            channel.Select(browser);
            Assert.IsTrue(JsonSerializer.SerializeToElement(channel.Status()).GetProperty("connected").GetBoolean());
            Assert.IsFalse(channel.Reset.Pending);
            Exchange(generation, old, id);
            Assert.IsFalse(JsonSerializer.SerializeToElement(channel.Status()).GetProperty("connected").GetBoolean());
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    [TestMethod]
    public void CorruptJournalAndMalformedReceiptFailClosed()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-reset-invalid-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            string path = Path.Combine(root, "reset.json");
            File.WriteAllText(path, "not a journal");
            var reset = new ChromeExtensionReset(path);
            Assert.IsTrue(reset.Pending);
            Assert.IsFalse(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), null, true).Allowed);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            var bad = JsonSerializer.SerializeToElement(new { id = Guid.NewGuid().ToString(), installedAt = "yesterday" });
            Assert.IsFalse(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), bad, true).Allowed);
            Assert.IsTrue(reset.Pending);
        }
        finally { Directory.Delete(root, true); }
    }

    [TestMethod]
    public void Removal_errors_are_recorded_and_retried_on_the_same_connection_without_reload()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-reset-retry-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var clock = new Clock();
            var reset = new ChromeExtensionReset(Path.Combine(root, "reset.json"), clock);
            string connection = Guid.NewGuid().ToString();
            JsonElement old = JsonSerializer.SerializeToElement(new
            {
                id = Guid.NewGuid().ToString(),
                installedAt = clock.Now.AddDays(-1).ToUnixTimeMilliseconds(),
            });
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            var first = reset.Observe(Guid.NewGuid().ToString(), connection, old, true);
            JsonElement command = JsonSerializer.SerializeToElement(first.Commands.Single());
            string commandId = command.GetProperty("id").GetString()!;
            reset.ObserveReplies(
                connection,
                JsonSerializer.SerializeToElement(new[] { new { id = commandId, error = "managed-extension" } })
            );
            Assert.IsTrue(reset.Message.Contains("managed-extension", StringComparison.Ordinal));

            clock.Now = clock.Now.AddSeconds(3);
            var retry = reset.Observe(Guid.NewGuid().ToString(), connection, old, true);
            Assert.AreEqual(1, retry.Commands.Length, "the same running worker must be retried without Reload");
            Assert.AreNotEqual(commandId, JsonSerializer.SerializeToElement(retry.Commands[0]).GetProperty("id").GetString());
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void Independently_observed_absence_is_required_before_a_new_install_can_complete()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofe-reset-observer-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var clock = new Clock();
            var reset = new ChromeExtensionReset(Path.Combine(root, "reset.json"), clock);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            reset.ObserveVerifier(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                [new ExtensionPresence(ChromeIntegration.CanonicalExtensionId, false)],
                []
            );
            Assert.IsTrue(reset.Pending, "a target that was merely disabled is still installed");
            var restartedVerifier = new ChromeExtensionReset(Path.Combine(root, "reset.json"), clock);
            restartedVerifier.ObserveVerifier("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [], []);
            Assert.IsFalse(restartedVerifier.RemovalVerified, "restart cannot erase evidence that the target was previously present");
            restartedVerifier.ObserveVerifier("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [], [ChromeIntegration.CanonicalExtensionId]);
            Assert.IsTrue(restartedVerifier.RemovalVerified);

            var fresh = JsonSerializer.SerializeToElement(new
            {
                id = Guid.NewGuid().ToString(),
                installedAt = clock.Now.AddSeconds(1).ToUnixTimeMilliseconds(),
            });
            clock.Now = clock.Now.AddSeconds(12);
            Assert.IsTrue(restartedVerifier.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), fresh, true).Allowed);
            Assert.IsFalse(restartedVerifier.Pending);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

}
