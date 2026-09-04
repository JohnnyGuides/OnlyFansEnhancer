using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class WebMessageRouterTests
{
    private const string RequestId = "18db3aac-b76f-445c-bbd1-4d7c6fb214c8";

    [TestMethod]
    public void Get_status_returns_the_desktop_contract()
    {
        WebMessageRouter router = new(_ => throw new AssertFailedException(), () => null);

        using JsonDocument response = Parse(
            router.Handle(
                $"{{\"requestId\":\"{RequestId}\",\"operation\":\"getStatus\",\"payload\":{{}}}}"
            )
        );

        Assert.IsTrue(response.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(
            "0.18.0",
            response.RootElement.GetProperty("result").GetProperty("productVersion").GetString()
        );
    }

    [TestMethod]
    public void Open_uploader_uses_only_the_configured_extension_id()
    {
        Uri? opened = null;
        WebMessageRouter router = new(uri => opened = uri, () => "cfkenejbehihjmeokedjfccmhffeahgh");

        using JsonDocument response = Parse(
            router.Handle(
                $"{{\"requestId\":\"{RequestId}\",\"operation\":\"openChromeUploader\",\"payload\":{{}}}}"
            )
        );

        Assert.IsTrue(response.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(
            "chrome-extension://cfkenejbehihjmeokedjfccmhffeahgh/upload-console.html",
            opened?.AbsoluteUri
        );
    }

    [TestMethod]
    public void Open_uploader_fails_when_the_extension_is_not_configured()
    {
        WebMessageRouter router = new(_ => throw new AssertFailedException(), () => null);

        using JsonDocument response = Parse(
            router.Handle(
                $"{{\"requestId\":\"{RequestId}\",\"operation\":\"openChromeUploader\",\"payload\":{{}}}}"
            )
        );

        Assert.IsFalse(response.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(
            "extension-not-configured",
            response.RootElement.GetProperty("error").GetProperty("code").GetString()
        );
    }

    [DataTestMethod]
    [DataRow("not-json", "invalid-request")]
    [DataRow(
        "{\"requestId\":\"18db3aac-b76f-445c-bbd1-4d7c6fb214c8\",\"operation\":\"erase\",\"payload\":{}}",
        "unsupported-operation"
    )]
    public void Invalid_web_messages_fail_without_running_an_action(string json, string code)
    {
        WebMessageRouter router = new(_ => throw new AssertFailedException(), () => null);

        using JsonDocument response = Parse(router.Handle(json));

        Assert.IsFalse(response.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(code, response.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    private static JsonDocument Parse(string value) => JsonDocument.Parse(value);
}
