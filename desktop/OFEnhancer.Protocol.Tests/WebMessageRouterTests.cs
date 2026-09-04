using System.Text.Json;
using OFEnhancer.Catalogue;
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
            "0.19.0",
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

    [TestMethod]
    public void Catalogue_operations_use_the_real_store_and_return_no_local_paths()
    {
        using TestDirectory temp = new();
        string thumbnailRoot = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(thumbnailRoot, "ashley.png"), [1, 2, 3, 4]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        WebMessageRouter router = new(_ => throw new AssertFailedException(), () => null, store);
        string snapshot =
            """
            {"version":1,"items":[{"sourceKey":"ashley-04","sourceRow":4,"title":"Ashley 04","description":"","plannedDate":"2026-09-11","series":"Ashley","episode":"04","xTeasers":2,"redditTeasers":1,"platformLinks":{}}]}
            """;

        AssertOk(router.Handle(Request("importCatalogueSnapshot", new { json = snapshot })));
        AssertOk(router.Handle(Request("scanThumbnails", new { root = thumbnailRoot })));
        using JsonDocument catalogue = Parse(router.Handle(Request("getCatalogue", new { })));
        JsonElement result = catalogue.RootElement.GetProperty("result");
        string assetId = result.GetProperty("unmatchedAssets")[0].GetProperty("assetId").GetString()!;
        string itemId = result.GetProperty("items")[0].GetProperty("itemId").GetString()!;

        Assert.IsFalse(catalogue.RootElement.GetRawText().Contains(temp.Path, StringComparison.OrdinalIgnoreCase));
        AssertOk(router.Handle(Request("confirmAssetBinding", new { assetId, itemId })));
        using JsonDocument bound = Parse(router.Handle(Request("getCatalogue", new { })));
        Assert.AreEqual(
            "bound",
            bound.RootElement.GetProperty("result").GetProperty("items")[0].GetProperty("thumbnailStatus").GetString()
        );
    }

    [TestMethod]
    public void Catalogue_payloads_fail_closed_and_unavailable_store_is_truthful()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        WebMessageRouter router = new(_ => throw new AssertFailedException(), () => null, store);
        WebMessageRouter unavailable = new(_ => throw new AssertFailedException(), () => null);

        AssertError(router.Handle(Request("getCatalogue", new { unexpected = true })), "invalid-payload");
        AssertError(
            router.Handle(Request("confirmAssetBinding", new { assetId = "no", itemId = "no" })),
            "invalid-binding"
        );
        AssertError(unavailable.Handle(Request("getCatalogue", new { })), "catalogue-unavailable");
    }

    private static string Request(string operation, object payload) =>
        JsonSerializer.Serialize(new { requestId = RequestId, operation, payload });

    private static void AssertOk(string value)
    {
        using JsonDocument response = Parse(value);
        Assert.IsTrue(response.RootElement.GetProperty("ok").GetBoolean(), value);
    }

    private static void AssertError(string value, string expectedCode)
    {
        using JsonDocument response = Parse(value);
        Assert.IsFalse(response.RootElement.GetProperty("ok").GetBoolean(), value);
        Assert.AreEqual(expectedCode, response.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    private static JsonDocument Parse(string value) => JsonDocument.Parse(value);

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-router-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
