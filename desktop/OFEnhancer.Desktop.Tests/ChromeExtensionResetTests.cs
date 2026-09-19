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
            string freshId = Guid.NewGuid().ToString(), freshBrowser = Guid.NewGuid().ToString(), freshConnection = Guid.NewGuid().ToString();
            var fresh = Receipt(freshId, clock.Now.ToUnixTimeMilliseconds());
            Assert.IsFalse(reset.Observe(freshBrowser, freshConnection, fresh, true).Allowed, "Old connection is still live.");
            clock.Now = clock.Now.AddSeconds(11);
            Assert.IsFalse(reset.Observe(freshBrowser, freshConnection, fresh, false).Allowed, "Wrong product version never finishes reset.");
            clock.Now = clock.Now.AddSeconds(11);
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
            var fresh = new { id = Guid.NewGuid().ToString(), installedAt = clock.Now.ToUnixTimeMilliseconds() };
            clock.Now = clock.Now.AddSeconds(11);
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

}
