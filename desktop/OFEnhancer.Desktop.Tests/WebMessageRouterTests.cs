using OFEnhancer.Protocol;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class WebMessageRouterTests
{
    private const string RequestId = "18db3aac-b76f-445c-bbd1-4d7c6fb214c8";
    private const string GoogleClientId =
        "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
    private static readonly string PlanHash = new('a', 64);

    [TestMethod]
    public void GoogleClientImportIsNativeOnlyAndRejectsJsonOrPathsInPayload()
    {
        int calls = 0;
        WebMessageRouter router = new(_ => { }, () => null, googleCatalogue: new RecordingGoogleController(),
            importGoogleClientConfiguration: () => { calls++; return new("disconnected"); });
        foreach (string payload in new[] { "{\"path\":\"C:\\\\secret.json\"}", "{\"json\":\"secret\"}" })
        {
            using JsonDocument rejected = Parse(router.Handle(
                $"{{\"requestId\":\"{RequestId}\",\"operation\":\"importGoogleClientConfiguration\",\"payload\":{payload}}}"));
            Assert.IsFalse(rejected.RootElement.GetProperty("ok").GetBoolean());
        }
        Assert.AreEqual(0, calls);
        using JsonDocument success = Parse(router.Handle(
            $"{{\"requestId\":\"{RequestId}\",\"operation\":\"importGoogleClientConfiguration\",\"payload\":{{}}}}"));
        Assert.IsTrue(success.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(1, calls);
    }

    [TestMethod]
    public void ReadOnlyGoogleImportReturnsCountSheetAndStatus()
    {
        RecordingGoogleController google = new();
        WebMessageRouter router = new(_ => { }, () => null, googleCatalogue: google);
        using JsonDocument response = Parse(router.Handle(
            $"{{\"requestId\":\"{RequestId}\",\"operation\":\"importGoogleCatalogue\",\"payload\":{{}}}}"));
        Assert.IsTrue(response.RootElement.GetProperty("ok").GetBoolean());
        JsonElement result = response.RootElement.GetProperty("result");
        Assert.AreEqual(12, result.GetProperty("importedItems").GetInt32());
        Assert.AreEqual("Catalogue", result.GetProperty("sheetName").GetString());
        Assert.AreEqual("disconnected", result.GetProperty("status").GetProperty("state").GetString());
    }

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
            "0.20.17",
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

    [TestMethod]
    public void First_thumbnail_scan_chooses_and_remembers_a_folder_without_exposing_its_path()
    {
        using TestDirectory temp = new();
        string thumbnailRoot = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(thumbnailRoot, "one.png"), [1]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        int choices = 0;
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            store,
            () =>
            {
                choices++;
                return thumbnailRoot;
            }
        );

        string first = router.Handle(Request("scanThumbnails", new { }));
        string second = router.Handle(Request("scanThumbnails", new { }));

        AssertOk(first);
        AssertOk(second);
        Assert.AreEqual(1, choices);
        Assert.AreEqual(thumbnailRoot, store.ConfiguredThumbnailRoot);
        Assert.IsFalse(first.Contains(thumbnailRoot, StringComparison.OrdinalIgnoreCase));

        using CatalogueStore cancelledStore = CatalogueStore.Open(Path.Combine(temp.Path, "cancelled.db"));
        WebMessageRouter cancelled = new(
            _ => throw new AssertFailedException(),
            () => null,
            cancelledStore,
            () => null
        );
        AssertError(
            cancelled.Handle(Request("scanThumbnails", new { })),
            "thumbnail-folder-not-selected"
        );
    }

    [TestMethod]
    public void MissingRememberedThumbnailFolderPromptsForAReplacement()
    {
        using TestDirectory temp = new();
        string missing = Directory.CreateDirectory(Path.Combine(temp.Path, "missing")).FullName;
        string replacement = Directory.CreateDirectory(Path.Combine(temp.Path, "replacement")).FullName;
        File.WriteAllBytes(Path.Combine(missing, "old.png"), [1]);
        File.WriteAllBytes(Path.Combine(replacement, "new.png"), [2]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ScanThumbnails(missing);
        Directory.Delete(missing, recursive: true);
        int choices = 0;
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            store,
            () =>
            {
                choices++;
                return replacement;
            }
        );

        AssertOk(router.Handle(Request("scanThumbnails", new { })));

        Assert.AreEqual(1, choices);
        Assert.AreEqual(replacement, store.ConfiguredThumbnailRoot);
        CollectionAssert.AreEqual(new[] { "new.png" }, store.GetAssets().Select(asset => asset.FileName).ToArray());
    }

    [TestMethod]
    public void Google_catalogue_empty_operations_have_exact_payloads()
    {
        RecordingGoogleController google = new();
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            googleCatalogue: google
        );
        string[] operations =
        [
            "getGoogleCatalogueStatus",
            "startGoogleCatalogueConnection",
            "cancelGoogleCatalogueConnection",
            "inspectGoogleWorkbook",
            "syncGoogleCatalogue",
            "disconnectGoogleCatalogue",
        ];

        foreach (string operation in operations)
        {
            AssertOk(router.Handle(Request(operation, new { })));
            AssertError(
                router.Handle(Request(operation, new { unexpected = true })),
                "invalid-payload"
            );
        }

        CollectionAssert.AreEqual(operations, google.Calls.ToArray());
    }

    [TestMethod]
    public void Google_catalogue_value_operations_have_exact_payloads()
    {
        RecordingGoogleController google = new();
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            googleCatalogue: google
        );

        AssertOk(router.Handle(Request("saveGoogleClientId", new { clientId = GoogleClientId })));
        AssertError(router.Handle(Request("saveGoogleClientId", new { })), "invalid-payload");
        AssertError(
            router.Handle(Request("saveGoogleClientId", new { clientId = GoogleClientId, extra = true })),
            "invalid-payload"
        );
        const string sheetUrl = "https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=17";
        AssertOk(router.Handle(Request("startGoogleCatalogueConnection", new { sheetUrl })));
        AssertError(
            router.Handle(Request("startGoogleCatalogueConnection", new { sheetUrl, extra = true })),
            "invalid-payload"
        );
        AssertOk(router.Handle(Request("applyGoogleWorkbookMigration", new { planHash = PlanHash })));
        AssertError(
            router.Handle(Request("applyGoogleWorkbookMigration", new { planHash = "bad" })),
            "invalid-payload"
        );
        AssertError(
            router.Handle(Request("applyGoogleWorkbookMigration", new { planHash = PlanHash, extra = true })),
            "invalid-payload"
        );

        Assert.AreEqual(GoogleClientId, google.SavedClientId);
        Assert.AreEqual(sheetUrl, google.SheetUrl);
        Assert.AreEqual(PlanHash, google.AppliedPlanHash);
    }

    [TestMethod]
    public void Browser_settings_routes_empty_and_value_payloads()
    {
        string? savedBrowserId = null;
        BrowserSettingsView view = new(
            "system",
            [
                new BrowserOption("system", "System default"),
                new BrowserOption("firefox", "Mozilla Firefox"),
            ]
        );
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            browserOptions: () => view,
            saveBrowserPreference: browserId =>
            {
                savedBrowserId = browserId;
                return view with { SelectedId = browserId };
            }
        );

        using JsonDocument options = Parse(router.Handle(Request("getBrowserOptions", new { })));
        Assert.AreEqual("system", options.RootElement.GetProperty("result").GetProperty("selectedId").GetString());
        Assert.AreEqual(2, options.RootElement.GetProperty("result").GetProperty("options").GetArrayLength());

        AssertOk(router.Handle(Request("saveBrowserPreference", new { browserId = "firefox" })));
        Assert.AreEqual("firefox", savedBrowserId);
        AssertError(
            router.Handle(Request("saveBrowserPreference", new { browserId = "firefox", extra = true })),
            "invalid-payload"
        );
    }

    [TestMethod]
    public void Google_catalogue_routes_are_truthful_when_unavailable_and_map_safe_errors()
    {
        WebMessageRouter unavailable = new(_ => throw new AssertFailedException(), () => null);
        (string Operation, object Payload)[] operations =
        [
            ("getGoogleCatalogueStatus", new { }),
            ("saveGoogleClientId", new { clientId = GoogleClientId }),
            ("startGoogleCatalogueConnection", new { }),
            ("cancelGoogleCatalogueConnection", new { }),
            ("inspectGoogleWorkbook", new { }),
            ("applyGoogleWorkbookMigration", new { planHash = PlanHash }),
            ("syncGoogleCatalogue", new { }),
            ("disconnectGoogleCatalogue", new { }),
        ];
        foreach ((string operation, object payload) in operations)
        {
            AssertError(
                unavailable.Handle(Request(operation, payload)),
                "google-catalogue-unavailable"
            );
        }

        RecordingGoogleController failing = new() { ErrorCode = "stale-migration-plan" };
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            googleCatalogue: failing
        );
        string response = router.Handle(Request("inspectGoogleWorkbook", new { }));

        AssertError(response, "stale-migration-plan");
        Assert.IsFalse(response.Contains("stack", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(response.Contains("token", StringComparison.OrdinalIgnoreCase));
    }

    [TestMethod]
    public void Google_status_serialization_has_no_secret_or_local_identity_fields()
    {
        RecordingGoogleController google = new();
        WebMessageRouter router = new(
            _ => throw new AssertFailedException(),
            () => null,
            googleCatalogue: google
        );

        string response = router.Handle(Request("getGoogleCatalogueStatus", new { }));

        AssertOk(response);
        string[] forbidden =
        [
            "accessToken",
            "refreshToken",
            "authorizationCode",
            "workbookId",
            "tokenPath",
            "databasePath",
            "rawPayload",
        ];
        foreach (string field in forbidden)
            Assert.IsFalse(response.Contains(field, StringComparison.OrdinalIgnoreCase), field);
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

    private sealed class RecordingGoogleController : IGoogleCatalogueController
    {
        internal List<string> Calls { get; } = [];
        internal string? SavedClientId { get; private set; }
        internal string? SheetUrl { get; private set; }
        internal string? AppliedPlanHash { get; private set; }
        internal string? ErrorCode { get; init; }

        public GoogleCatalogueStatusView getGoogleCatalogueStatus() => Called(
            "getGoogleCatalogueStatus"
        );

        public GoogleCatalogueStatusView saveGoogleClientId(string clientId)
        {
            SavedClientId = clientId;
            return Called("saveGoogleClientId");
        }

        public GoogleCatalogueStatusView startGoogleCatalogueConnection(string? sheetUrl = null)
        {
            SheetUrl = sheetUrl;
            return Called("startGoogleCatalogueConnection");
        }

        public GoogleCatalogueStatusView cancelGoogleCatalogueConnection() => Called(
            "cancelGoogleCatalogueConnection"
        );

        public GoogleCatalogueStatusView inspectGoogleWorkbook() => Called(
            "inspectGoogleWorkbook"
        );

        public GoogleCatalogueImportResult importGoogleCatalogue() => new(Called("importGoogleCatalogue"), "Catalogue", 12);

        public GoogleCatalogueStatusView applyGoogleWorkbookMigration(string planHash)
        {
            AppliedPlanHash = planHash;
            return Called("applyGoogleWorkbookMigration");
        }

        public GoogleCatalogueStatusView syncGoogleCatalogue() => Called(
            "syncGoogleCatalogue"
        );

        public GoogleCatalogueStatusView disconnectGoogleCatalogue() => Called(
            "disconnectGoogleCatalogue"
        );

        public void Dispose() { }

        private GoogleCatalogueStatusView Called(string operation)
        {
            if (ErrorCode is not null)
                throw new GoogleCatalogueControllerException(ErrorCode);
            Calls.Add(operation);
            return new("disconnected");
        }
    }

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
