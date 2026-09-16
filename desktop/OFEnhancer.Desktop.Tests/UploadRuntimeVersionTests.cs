using System.Text.Json;
using OFEnhancer.Desktop;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public class UploadRuntimeVersionTests
{
    private const string Identity = "aocoaajmhccmefmfebgiiogfdojciild";
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
    private static JsonElement Exchange(BrowserUploadChannel channel, string id, string? version, string? generation = null) =>
        Json(channel.Exchange(Json(new { browserId = id, connectionId = id, extensionId = Identity, bridgeExtensionId = Identity,
            setupGeneration = generation, extensionVersion = version, replies = Array.Empty<object>(), events = Array.Empty<object>() })));

    [DataTestMethod]
    [DataRow(null)]
    [DataRow("0.1.0")]
    [DataRow("unverified")]
    public async Task OldOrUnknownExtensionCannotReceiveNewDesktopCommands(string? version)
    {
        using var channel = new BrowserUploadChannel();
        channel.ConfigureIntegration(Identity, "fixture-installation");
        string id = Guid.NewGuid().ToString();
        string generation = Exchange(channel, id, version).GetProperty("setupGeneration").GetString()!;
        var response = Exchange(channel, id, version, generation);
        Assert.AreEqual(0, response.GetProperty("commands").GetArrayLength());
        var status = Json(channel.Status());
        Assert.IsFalse(status.GetProperty("connected").GetBoolean());
        Assert.AreEqual(0, status.GetProperty("browsers").GetArrayLength());
        Assert.IsTrue(status.GetProperty("updateRequired").GetBoolean(), "An incompatible live extension must report reload-required, not connected.");
        var error = await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => channel.RequestAsync(Json(new { kind = "message" })).WaitAsync(TimeSpan.FromSeconds(1)));
        StringAssert.Contains(error.Message.ToLowerInvariant(), "reload");
    }

    [TestMethod]
    public async Task MatchingReloadedExtensionCanConnectButCannotReviveOldPendingWork()
    {
        using var channel = new BrowserUploadChannel();
        channel.ConfigureIntegration(Identity, "fixture-installation");
        string id = Guid.NewGuid().ToString();
        string generation = Exchange(channel, id, AgentProtocol.ProductVersion).GetProperty("setupGeneration").GetString()!;
        Exchange(channel, id, AgentProtocol.ProductVersion, generation);
        channel.Select(id);
        var pending = channel.RequestAsync(Json(new { kind = "message" }));
        Exchange(channel, id, "0.1.0", generation);
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => pending.WaitAsync(TimeSpan.FromSeconds(1)));
        var reload = Exchange(channel, id, AgentProtocol.ProductVersion, generation);
        Assert.AreEqual(0, reload.GetProperty("commands").GetArrayLength());
        Assert.IsFalse(Json(channel.Status()).GetProperty("updateRequired").GetBoolean());
        Assert.IsTrue(Json(channel.Status()).GetProperty("selectionRequired").GetBoolean());
        Assert.IsFalse(Json(channel.Status()).GetProperty("connected").GetBoolean());
        channel.Select(id);
        Assert.IsTrue(Json(channel.Status()).GetProperty("connected").GetBoolean());
    }
}
