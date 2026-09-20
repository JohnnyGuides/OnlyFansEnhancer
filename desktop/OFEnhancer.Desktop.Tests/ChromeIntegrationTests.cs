using System.Security.Cryptography;
using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class ChromeIntegrationTests
{
    private sealed class Fixture : IDisposable
    {
        internal readonly string Root = Path.Combine(Path.GetTempPath(), "ofenhancer-chrome-" + Guid.NewGuid());
        internal readonly BrowserUploadChannel Channel = new();
        internal readonly DesktopSettingsStore Settings;
        internal readonly ChromeIntegration Integration;
        internal string[] Targets = [];
        internal bool Chrome = true;
        internal bool FailRegistration;
        internal string Manifest => Path.Combine(Root, "native", ChromeIntegration.HostName + ".json");

        internal Fixture()
        {
            string? repository = AppContext.BaseDirectory;
            while (repository is not null && !File.Exists(Path.Combine(repository, "packaging", "personal-identity.json"))) repository = Path.GetDirectoryName(repository);
            using var identity = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(repository!, "packaging", "personal-identity.json")));
            foreach (var folder in new[] { "extension", "extension-keyed" })
            {
                Directory.CreateDirectory(Path.Combine(Root, folder, "workflows"));
                File.WriteAllText(Path.Combine(Root, folder, "workflows", "desktop-upload-runtime.js"), "fixture");
                File.WriteAllText(Path.Combine(Root, folder, "manifest.json"), folder == "extension" ? "{}" : JsonSerializer.Serialize(new { key = identity.RootElement.GetProperty("key").GetString() }));
            }
            Directory.CreateDirectory(Path.Combine(Root, "native"));
            File.WriteAllText(Path.Combine(Root, "native", "OFEnhancerNativeBridge.exe"), "fixture");
            var files = Directory.GetFiles(Root, "*", SearchOption.AllDirectories).Select(file => new { path = Path.GetRelativePath(Root, file).Replace('\\', '/'), size = new FileInfo(file).Length, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))) }).ToArray();
            File.WriteAllText(Path.Combine(Root, "package-manifest.json"), JsonSerializer.Serialize(new { product = "OFEnhancer", files }));
            Settings = new(Path.Combine(Root, "data", "settings.json"));
            Integration = new(Root, Settings, () => Settings.Load().ExtensionId, Channel,
                () => Chrome ? new("chrome", "Google Chrome", "fixture.exe") : null,
                () => Targets,
                manifest => { if (FailRegistration) throw new IOException("injected registry failure"); Targets = [manifest]; },
                () => true);
        }
        public void Dispose() { Channel.Dispose(); Directory.Delete(Root, true); }
    }

    [TestMethod]
    public void DesktopAvailabilityAndPreparationNeverProveChromeConnection()
    {
        using var fixture = new Fixture();
        fixture.Chrome = false;
        Assert.AreEqual("not-found", fixture.Integration.Get().State);
        fixture.Chrome = true;
        Assert.AreEqual("setup", fixture.Integration.Get().State);
        Assert.AreEqual("offline", fixture.Integration.Prepare().State);
        Assert.AreEqual(ChromeIntegration.CanonicalExtensionId, fixture.Settings.Load().ExtensionId);
        Assert.AreEqual("offline", fixture.Integration.Prepare().State);
    }

    [TestMethod]
    public void MatchingFreshChallengeAllowsUnselectedSoleBrowserButMultipleRequireChoice()
    {
        using var fixture = new Fixture();
        fixture.Integration.Prepare();
        var browser = Guid.NewGuid().ToString();
        var connection = Guid.NewGuid().ToString();
        JsonElement Exchange(string? generation, string id) => JsonSerializer.SerializeToElement(fixture.Channel.Exchange(JsonSerializer.SerializeToElement(new { browserId = id, connectionId = connection, extensionId = ChromeIntegration.CanonicalExtensionId, bridgeExtensionId = ChromeIntegration.CanonicalExtensionId, extensionVersion = OFEnhancer.Protocol.AgentProtocol.ProductVersion, setupGeneration = generation })));
        string challenge = Exchange(null, browser).GetProperty("setupGeneration").GetString()!;
        Assert.AreEqual("offline", fixture.Integration.Get().State);
        Exchange(challenge, browser);
        Assert.AreEqual("connected", fixture.Integration.Get().State);
        Assert.IsNull(JsonSerializer.SerializeToElement(fixture.Channel.Status()).GetProperty("selected").GetString());
        Exchange(challenge, Guid.NewGuid().ToString());
        Assert.AreEqual("choose", fixture.Integration.Get().State);
        fixture.Channel.Select(browser);
        Assert.AreEqual("connected", fixture.Integration.Get().State);
    }

    [TestMethod]
    public void ForeignRegistrationAndPartialFailureDoNotBecomeSuccess()
    {
        using var fixture = new Fixture();
        fixture.Targets = [Path.Combine(fixture.Root, "foreign.json")];
        Assert.ThrowsException<InvalidOperationException>(() => fixture.Integration.Prepare());
        Assert.IsNull(fixture.Settings.Load().ExtensionId);
        fixture.Targets = [];
        fixture.FailRegistration = true;
        Assert.ThrowsException<IOException>(() => fixture.Integration.Prepare());
        Assert.AreEqual("repair", fixture.Integration.Get().State);
        fixture.FailRegistration = false;
        Assert.AreEqual("offline", fixture.Integration.Prepare().State);
    }

    [TestMethod]
    public void LegacyRepairPreservesIdentityAndGooglePreferenceAndKeylessFolder()
    {
        using var fixture = new Fixture();
        string legacy = new('b', 32);
        fixture.Settings.Save(new(legacy, null, "edge"));
        fixture.Targets = [fixture.Manifest];
        Assert.AreEqual("offline", fixture.Integration.Prepare().State);
        Assert.AreEqual(legacy, fixture.Settings.Load().ExtensionId);
        Assert.AreEqual("edge", fixture.Settings.Load().BrowserId);
        Assert.AreEqual("{}", File.ReadAllText(Path.Combine(fixture.Root, "extension", "manifest.json")));
        Assert.IsNull(fixture.Integration.Get().ExtensionFolder, "Unknown legacy load locations must not be invented.");
    }

    [TestMethod]
    public void MissingLegacyEvidenceAndInvalidSettingsStopBeforeWrites()
    {
        using var fixture = new Fixture();
        fixture.Settings.Save(new(new string('c', 32), null, "system"));
        Assert.ThrowsException<InvalidOperationException>(() => fixture.Integration.Prepare());
        File.WriteAllText(fixture.Settings.SettingsPath, "{\"extensionId\":\"invalid\"}");
        Assert.ThrowsException<InvalidOperationException>(() => fixture.Integration.Prepare());
        Assert.IsFalse(File.Exists(fixture.Manifest));
    }

    [TestMethod]
    public void WrongIdentityAndOldSetupGenerationCannotValidateLiveness()
    {
        using var fixture = new Fixture();
        fixture.Integration.Prepare();
        string browser = Guid.NewGuid().ToString(), connection = Guid.NewGuid().ToString();
        JsonElement Exchange(string? generation, string identity, string bridge) => JsonSerializer.SerializeToElement(fixture.Channel.Exchange(JsonSerializer.SerializeToElement(new { browserId = browser, connectionId = connection, extensionId = identity, bridgeExtensionId = bridge, setupGeneration = generation })));
        string canonical = ChromeIntegration.CanonicalExtensionId;
        string generation = Exchange(null, canonical, canonical).GetProperty("setupGeneration").GetString()!;
        Exchange(generation, new string('a', 32), canonical);
        Exchange(generation, canonical, new string('a', 32));
        Assert.AreEqual("offline", fixture.Integration.Get().State);
        fixture.Channel.ConfigureIntegration(canonical, "new-setup");
        Exchange(generation, canonical, canonical);
        Assert.AreEqual(0, JsonSerializer.SerializeToElement(fixture.Channel.Status()).GetProperty("browsers").GetArrayLength());
    }
    [TestMethod]
    public void ExplicitResetCanReplaceLegacyIdentityWhileKeepingDesktopDataAndInterruptedCutoff()
    {
        using var fixture = new Fixture();
        string legacy = new('b', 32), journal = Path.Combine(fixture.Root, "data", "reset.json");
        fixture.Settings.Save(new(legacy, null, "edge"));
        fixture.Targets = [fixture.Manifest];
        fixture.Channel.Reset = new ChromeExtensionReset(journal);
        fixture.Integration.Prepare();
        Assert.IsFalse(fixture.Channel.Reset.Pending, "Normal update is not a reset.");
        Directory.CreateDirectory(Path.Combine(fixture.Root, "data"));
        string[] preservedFiles = ["catalogue.db", "google-oauth-token.dat", "upload-history.json"];
        foreach (string name in preservedFiles) File.WriteAllText(Path.Combine(fixture.Root, "data", name), "unchanged fixture data");
        var result = fixture.Integration.FreshReset();
        foreach (string name in preservedFiles) Assert.AreEqual("unchanged fixture data", File.ReadAllText(Path.Combine(fixture.Root, "data", name)));
        Assert.IsTrue(result.ResetPending);
        Assert.AreEqual(legacy, result.ResetExtensionId);
        Assert.AreEqual(legacy, result.ExtensionId, "The old native origin must remain reachable until removal is verified.");
        Assert.AreEqual("edge", fixture.Settings.Load().BrowserId);
        Assert.IsNull(result.ExtensionFolder);
        using (JsonDocument maintenanceManifest = JsonDocument.Parse(File.ReadAllText(fixture.Manifest)))
        {
            string[] origins = maintenanceManifest.RootElement.GetProperty("allowed_origins").EnumerateArray()
                .Select(item => item.GetString()!).ToArray();
            CollectionAssert.Contains(origins, $"chrome-extension://{legacy}/");
            CollectionAssert.Contains(origins, $"chrome-extension://{ChromeIntegration.MaintenanceVerifierId}/");
        }
        string cutoff = File.ReadAllText(journal);
        fixture.Integration.Prepare();
        Assert.AreEqual(cutoff, File.ReadAllText(journal), "Resume must not move the original reset cutoff.");
        Assert.AreEqual("reset-pending", fixture.Integration.Get().State);
        Assert.IsFalse(fixture.Integration.Get().CanOpenExtensions, "there is no connected Chrome profile in this fixture");
        fixture.Channel.Reset.Observe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(),
            JsonSerializer.SerializeToElement(new { id = Guid.NewGuid().ToString(), installedAt = DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds() }), true);
        Assert.IsTrue(fixture.Channel.Reset.TryConfirmAutomaticRemoval(TimeSpan.Zero));
        var rebound = fixture.Integration.Get();
        Assert.AreEqual(ChromeIntegration.CanonicalExtensionId, rebound.ExtensionId);
        Assert.AreEqual(Path.Combine(fixture.Root, "extension-keyed"), rebound.ExtensionFolder);
    }

}
