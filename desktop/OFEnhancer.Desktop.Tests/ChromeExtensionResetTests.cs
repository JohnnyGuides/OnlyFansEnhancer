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
    public void Request_disconnect_and_elapsed_time_never_prove_removal()
    {
        string path = TempPath();
        try
        {
            var clock = new Clock();
            var reset = new ChromeExtensionReset(path, clock);
            string oldReceiptId = Guid.NewGuid().ToString();
            JsonElement oldReceipt = Receipt(oldReceiptId, clock.Now.AddDays(-1));
            reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), oldReceipt, true);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);

            ExtensionResetObservation request = reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), oldReceipt, true);
            Assert.AreEqual(1, request.Commands.Length);
            Assert.AreEqual(ChromeRemovalEvidence.Requested, reset.RemovalEvidence);
            clock.Now = clock.Now.AddDays(2);
            Assert.AreEqual(ChromeResetStage.Removal, reset.Stage);
            Assert.IsTrue(reset.Pending);
            Assert.IsTrue(reset.Message.Contains("not confirmed", StringComparison.OrdinalIgnoreCase));
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    [TestMethod]
    public void User_report_is_provenance_not_verification_and_fresh_receipt_is_required()
    {
        string path = TempPath();
        try
        {
            var clock = new Clock();
            var reset = new ChromeExtensionReset(path, clock);
            JsonElement oldReceipt = Receipt(Guid.NewGuid().ToString(), clock.Now.AddHours(-1));
            reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), oldReceipt, true);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            reset.ContinueToReplacement(ChromeRemovalEvidence.UserReportedRemoved);

            Assert.AreEqual(ChromeResetStage.Replacement, reset.Stage);
            Assert.AreEqual(ChromeRemovalEvidence.UserReportedRemoved, reset.RemovalEvidence);
            Assert.IsFalse(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), oldReceipt, true).Allowed);
            Assert.IsTrue(reset.Pending);

            JsonElement fresh = Receipt(Guid.NewGuid().ToString(), clock.Now.AddSeconds(1));
            Assert.IsFalse(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), fresh, false).Allowed);
            Assert.IsTrue(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), fresh, true).Allowed);
            Assert.IsFalse(reset.Pending);
            Assert.AreEqual(fresh.GetProperty("id").GetString(), reset.AdmittedReceipt);

            var restarted = new ChromeExtensionReset(path, clock);
            Assert.IsFalse(restarted.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), oldReceipt, true).Allowed);
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    [TestMethod]
    public void Api_rejection_is_recorded_without_retry_or_storage_loss_claim()
    {
        string path = TempPath();
        try
        {
            var clock = new Clock();
            var reset = new ChromeExtensionReset(path, clock);
            reset.Begin(ChromeIntegration.CanonicalExtensionId);
            string connection = Guid.NewGuid().ToString();
            ExtensionResetObservation first = reset.Observe(Guid.NewGuid().ToString(), connection,
                Receipt(Guid.NewGuid().ToString(), clock.Now.AddDays(-1)), true);
            JsonElement command = JsonSerializer.SerializeToElement(first.Commands.Single());
            reset.ObserveReplies(connection, JsonSerializer.SerializeToElement(new[]
            {
                new { id = command.GetProperty("id").GetString(), error = "Chrome refused self-removal." },
            }));
            Assert.AreEqual(ChromeRemovalEvidence.ApiRejected, reset.RemovalEvidence);
            clock.Now = clock.Now.AddMinutes(5);
            Assert.AreEqual(0, reset.Observe(Guid.NewGuid().ToString(), connection,
                Receipt(Guid.NewGuid().ToString(), clock.Now.AddDays(-1)), true).Commands.Length);
            Assert.IsTrue(reset.Message.Contains("refused", StringComparison.OrdinalIgnoreCase));
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    [TestMethod]
    public void Legacy_silence_verification_migrates_to_unknown_and_stays_blocked()
    {
        string path = TempPath();
        try
        {
            long started = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(new
            {
                Schema = 4, Generation = Guid.NewGuid().ToString(), StartedAt = started, Pending = true,
                ExtensionId = ChromeIntegration.CanonicalExtensionId, RetiredReceipts = Array.Empty<string>(),
                RemovalVerified = true, LastRemovalError = (string?)null, VerifierSawTarget = false,
                RemovalRequestedAt = started, ManualPromptAt = 0, ManualConfirmedAt = 0, LastObservedAt = started,
            }));
            var migrated = new ChromeExtensionReset(path);
            Assert.AreEqual(ChromeResetStage.Replacement, migrated.Stage);
            Assert.AreEqual(ChromeRemovalEvidence.Unknown, migrated.RemovalEvidence);
            Assert.IsTrue(migrated.Pending);
            Assert.IsTrue(migrated.Message.Contains("not confirmed", StringComparison.OrdinalIgnoreCase));
            Assert.AreEqual(5, JsonDocument.Parse(File.ReadAllText(path)).RootElement.GetProperty("Schema").GetInt32());
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    [TestMethod]
    public void Corrupt_journal_and_malformed_receipt_fail_closed()
    {
        string path = TempPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        try
        {
            File.WriteAllText(path, "not-json");
            var reset = new ChromeExtensionReset(path);
            Assert.IsTrue(reset.Pending);
            Assert.IsFalse(reset.IsValid);
            Assert.IsFalse(reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), null, true).Allowed);
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    [TestMethod]
    public void Native_operations_are_denied_during_reset_and_for_wrong_origin()
    {
        string path = TempPath();
        try
        {
            using var channel = new BrowserUploadChannel { Reset = new ChromeExtensionReset(path) };
            channel.ConfigureIntegration(ChromeIntegration.CanonicalExtensionId, "manifest");
            string browser = Guid.NewGuid().ToString(), connection = Guid.NewGuid().ToString();
            JsonElement first = JsonSerializer.SerializeToElement(channel.Exchange(JsonSerializer.SerializeToElement(new { browserId = browser, connectionId = connection,
                extensionId = ChromeIntegration.CanonicalExtensionId, bridgeExtensionId = ChromeIntegration.CanonicalExtensionId,
                extensionVersion = OFEnhancer.Protocol.AgentProtocol.ProductVersion })));
            channel.Exchange(JsonSerializer.SerializeToElement(new { browserId = browser, connectionId = connection,
                extensionId = ChromeIntegration.CanonicalExtensionId, bridgeExtensionId = ChromeIntegration.CanonicalExtensionId,
                extensionVersion = OFEnhancer.Protocol.AgentProtocol.ProductVersion,
                setupGeneration = first.GetProperty("setupGeneration").GetString() }));
            channel.AuthorizeNativeOperation(ChromeIntegration.CanonicalExtensionId, OFEnhancer.Protocol.AgentProtocol.ProductVersion, null);
            Assert.ThrowsException<InvalidOperationException>(() => channel.AuthorizeNativeOperation(new string('b', 32), OFEnhancer.Protocol.AgentProtocol.ProductVersion, null));
            channel.BeginReset(ChromeIntegration.CanonicalExtensionId);
            Assert.ThrowsException<InvalidOperationException>(() => channel.AuthorizeNativeOperation(ChromeIntegration.CanonicalExtensionId, OFEnhancer.Protocol.AgentProtocol.ProductVersion, null));
        }
        finally { Directory.Delete(Path.GetDirectoryName(path)!, true); }
    }

    private static string TempPath() => Path.Combine(Path.GetTempPath(), "ofe-reset-" + Guid.NewGuid().ToString("N"), "reset.json");
    private static JsonElement Receipt(string id, DateTimeOffset installedAt) =>
        JsonSerializer.SerializeToElement(new { id, installedAt = installedAt.ToUnixTimeMilliseconds() });
}
