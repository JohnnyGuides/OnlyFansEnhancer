using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using OFEnhancer.Catalogue;
using OFEnhancer.Protocol;
using System.Text.Json;

namespace OFEnhancer.Desktop;

public partial class MainWindow : Window, IDisposable
{
    private readonly WebMessageRouter router;
    private readonly WebMessageDispatcher dispatcher;
    private readonly ThumbnailResourceResolver thumbnails;
    private readonly CatalogueStore catalogue;
    private readonly DesktopSettingsStore settings;
    private readonly BrowserSettingsController browserSettings;
    private readonly HttpClient googleHttp;
    private readonly GoogleCatalogueController googleCatalogue;
    private readonly BrowserUploadChannel uploads = new();
    private readonly DevelopmentFixtureSource developmentFixtures = new();
    private readonly UploadCatalogueController uploadCatalogue;
    private readonly UploadThumbnailCatalogue uploadThumbnails;
    private readonly GeneratedUploadMediaStore generatedUploadMedia = new();
    private readonly ChromeIntegration chromeIntegration;
    private readonly bool hasExtensionOverride;
    private bool exiting;
    private bool disposed;
    private bool showChromeSetup;
    private HwndSource? windowSource;

    public MainWindow(string? extensionId, CatalogueStore catalogue, bool extensionOverride = false)
    {
        InitializeComponent();
        this.catalogue = catalogue;
        hasExtensionOverride = extensionOverride;
        settings = new DesktopSettingsStore(AppConfiguration.SettingsPath);
        uploads.Reset = new ChromeExtensionReset(AppConfiguration.ChromeResetPath,
            legacyPath: AppConfiguration.LegacyChromeResetPath);
        Func<string?> effectiveIdentity = () => extensionOverride ? extensionId : settings.Load().ExtensionId;
        chromeIntegration = new ChromeIntegration(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..")), settings, effectiveIdentity, uploads);
        browserSettings = new BrowserSettingsController(settings);
        WebMessageRouter? queuedRouter = null;
        dispatcher = new WebMessageDispatcher(json => queuedRouter!.Handle(json));
        googleHttp = GoogleHttpClientFactory.Create();
        googleCatalogue = new(
            settings,
            catalogue,
            new DpapiGoogleTokenVault(AppConfiguration.GoogleTokenPath),
            googleHttp,
            uri => GoogleBrowserLauncher.Open(uri, settings),
            dispatcher.EnqueueAsync,
            new GoogleDesktopClientStore(AppConfiguration.GoogleDesktopClientPath)
        );
        router = new WebMessageRouter(
            OpenChrome,
            effectiveIdentity,
            catalogue,
            () => Dispatcher.Invoke(ChooseThumbnailRoot),
            googleCatalogue,
            browserSettings.Get,
            browserSettings.Save,
            () => googleCatalogue.ImportGoogleClientConfiguration(() => Dispatcher.Invoke(ChooseGoogleClientConfiguration))
        );
        queuedRouter = router;
        uploadCatalogue = new UploadCatalogueController(catalogue, googleCatalogue.ReadSubredditPresets);
        uploadThumbnails = new UploadThumbnailCatalogue(catalogue);
        uploads.EventReceived += value => Dispatcher.BeginInvoke(() =>
        {
            if (!exiting && Browser.CoreWebView2 is not null)
                Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { uploadEvent = value }));
        });
        thumbnails = new ThumbnailResourceResolver(catalogue);
    }

    public async Task<AgentResponse> HandleAgentRequest(AgentRequest request)
    {
        try
        {
            if (request.Operation == "getStatus") return AgentResponse.Success(request, AgentStatus.Current);
            if (request.Operation == "showChromeSetup")
            {
                if (request.Payload is JsonElement setupPayload && setupPayload.ValueKind == JsonValueKind.Object && setupPayload.EnumerateObject().Any())
                    return AgentResponse.Failure(request.RequestId.ToString(), "invalid-payload");
                _ = Dispatcher.BeginInvoke(OpenChromeSetup);
                return AgentResponse.SuccessResult(request, new { opened = true });
            }
            JsonElement payload = request.Payload ?? JsonSerializer.SerializeToElement(new { });
            if (request.Operation is "loadDevelopmentFixtures" or "resolveDevelopmentFixture")
            {
                var integration = chromeIntegration.Get();
                if (!integration.Prepared || uploads.Reset?.Pending == true
                    || !payload.TryGetProperty("bridgeExtensionId", out var origin) || origin.GetString() != integration.ExtensionId
                    || !payload.TryGetProperty("extensionVersion", out var version) || version.GetString() != AgentProtocol.ProductVersion)
                    throw new InvalidOperationException("Connect the current personal extension before loading the development template.");
                uploads.AuthorizeNativeOperation(origin.GetString(), version.GetString(),
                    payload.TryGetProperty("installation", out JsonElement fixtureInstallation) ? fixtureInstallation : null);
                if (request.Operation == "loadDevelopmentFixtures")
                {
                    if (payload.EnumerateObject().Any(p => p.Name is not ("bridgeExtensionId" or "extensionVersion" or "installation"))) throw new InvalidOperationException("invalid-payload");
                    return AgentResponse.SuccessResult(request, developmentFixtures.Load());
                }
                if (payload.EnumerateObject().Any(p => p.Name is not ("bridgeExtensionId" or "extensionVersion" or "installation" or "fixtureToken"))) throw new InvalidOperationException("invalid-payload");
                var info = developmentFixtures.Resolve(payload.GetProperty("fixtureToken").GetString() ?? "");
                return AgentResponse.SuccessResult(request, new { filePath = info.FullName, name = info.Name, size = info.Length,
                    lastModified = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
            }
            if (request.Operation == "browserExchange")
            {
                chromeIntegration.Get();
                return AgentResponse.SuccessResult(request, uploads.Exchange(payload));
            }
            chromeIntegration.Get();
            string? bridgeExtensionId = payload.TryGetProperty("bridgeExtensionId", out JsonElement bridge)
                && bridge.ValueKind == JsonValueKind.String ? bridge.GetString() : null;
            string? extensionVersion = payload.TryGetProperty("extensionVersion", out JsonElement directVersion)
                && directVersion.ValueKind == JsonValueKind.String ? directVersion.GetString() : null;
            uploads.AuthorizeNativeOperation(bridgeExtensionId, extensionVersion,
                payload.TryGetProperty("installation", out JsonElement installation) ? installation : null);
            if (request.Operation == "resolveUploadThumbnail")
            {
                FileInfo file = await dispatcher.EnqueueAsync(() => uploadThumbnails.ConvertSelected(WithoutTransportMetadata(payload)));
                return AgentResponse.SuccessResult(request, new { filePath = file.FullName, name = file.Name,
                    size = file.Length, lastModified = new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
            }
            if (request.Operation == "writeUploadCatalogueEntry")
            {
                object written = await dispatcher.EnqueueAsync(() => googleCatalogue.WriteUploadEntry(WithoutTransportMetadata(payload)));
                return AgentResponse.SuccessResult(request, written);
            }
            object result = await dispatcher.EnqueueAsync(() => uploadCatalogue.Handle(request.Operation, WithoutTransportMetadata(payload)));
            return AgentResponse.SuccessResult(request, result);
        }
        catch (Exception error)
        {
            return AgentResponse.Failure(request.RequestId.ToString(), error is GoogleCatalogueControllerException googleError ? googleError.Code : error is InvalidOperationException ? error.Message : "desktop-operation-failed");
        }
    }

    private async Task<string?> HandleUploadMessage(string json, IReadOnlyList<object> additionalObjects)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        string operation = root.GetProperty("operation").GetString() ?? "";
        if (!new[] { "getStatus", "browserRequest", "deliverUploadFile", "deliverCatalogueThumbnail", "stageGeneratedMediaChunk", "deliverGeneratedMedia", "getUploadBrowsers", "selectUploadBrowser", "getChromeReadiness", "prepareChrome", "openChrome", "openChromeExtensions", "installChromeInfo", "revealChromeExtension", "loadDevelopmentFixtures", "deliverDevelopmentFixture", "freshChromeReset", "continueChromeReset" }.Contains(operation)) return null;
        string requestId = root.GetProperty("requestId").GetString() ?? "";
        try
        {
            if (!Guid.TryParse(requestId, out _)) throw new InvalidOperationException("invalid-request");
            JsonElement payload = root.GetProperty("payload");
            object result;
            if (operation is "getStatus" or "getChromeReadiness" or "prepareChrome" or "openChrome" or "openChromeExtensions" or "installChromeInfo" or "revealChromeExtension")
            {
                if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any()) throw new InvalidOperationException("invalid-payload");
                if (operation == "getStatus") result = AgentStatus.Current with { Capabilities = [.. AgentStatus.Current.Capabilities, "chrome-readiness"] };
                else if (operation == "getChromeReadiness") result = await Task.Run(chromeIntegration.Get);
                else if (operation == "prepareChrome")
                {
                    if (hasExtensionOverride) throw new InvalidOperationException("Chrome is using a command-line extension override. Start without that override to change saved setup.");
                    result = await Task.Run(chromeIntegration.Prepare);
                    string message = await OpenChromePageAsync("extensions");
                    result = new { prepared = true, message };
                }
                else
                {
                    if (operation == "installChromeInfo") Process.Start(new ProcessStartInfo("https://www.google.com/chrome/") { UseShellExecute = true });
                    else if (operation == "revealChromeExtension")
                    {
                        string folder = chromeIntegration.Get().ExtensionFolder ?? throw new InvalidOperationException("Prepare Chrome setup first.");
                        Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
                    }
                    if (operation is "openChromeExtensions" or "openChrome")
                        result = new { opened = true, message = await OpenChromePageAsync(operation == "openChromeExtensions" ? "extensions" : "newtab") };
                    else result = new { opened = true };
                }
            }
            else if (operation == "getUploadBrowsers") { await Task.Run(chromeIntegration.Get); result = uploads.Status(); }
            else if (operation == "selectUploadBrowser") result = uploads.Select(payload.GetProperty("browserId").GetString() ?? "");
            else if (operation == "loadDevelopmentFixtures")
            {
                if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any()) throw new InvalidOperationException("invalid-payload");
                if (uploads.Reset?.Pending == true) throw new InvalidOperationException(uploads.Reset.Message);
                result = await Task.Run(developmentFixtures.Load);
            }
            else if (operation == "freshChromeReset")
            {
                if (hasExtensionOverride || payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any()) throw new InvalidOperationException("invalid-payload");
                result = await Task.Run(chromeIntegration.FreshReset);
            }
            else if (operation == "continueChromeReset")
            {
                if (hasExtensionOverride || payload.ValueKind != JsonValueKind.Object
                    || !payload.TryGetProperty("evidence", out JsonElement evidenceValue)
                    || payload.EnumerateObject().Any(property => property.Name != "evidence"))
                    throw new InvalidOperationException("invalid-payload");
                ChromeRemovalEvidence evidence = evidenceValue.GetString() switch
                {
                    "removed" => ChromeRemovalEvidence.UserReportedRemoved,
                    "absent" => ChromeRemovalEvidence.UserReportedAbsent,
                    "unknown" => ChromeRemovalEvidence.Unknown,
                    _ => throw new InvalidOperationException("invalid-payload"),
                };
                result = await Task.Run(() => chromeIntegration.ContinueFreshReset(evidence));
            }
            else if (operation == "deliverDevelopmentFixture")
            {
                if (additionalObjects.Count != 0) throw new InvalidOperationException("invalid-payload");
                var info = developmentFixtures.Resolve(payload.GetProperty("fixtureToken").GetString() ?? "");
                if (info.Name != payload.GetProperty("name").GetString() || info.Length != payload.GetProperty("size").GetInt64()
                    || new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() != payload.GetProperty("lastModified").GetInt64())
                    throw new InvalidOperationException("Template changed. Click Load Template again.");
                FileInfo delivered = payload.GetProperty("role").GetString() == "thumbnail"
                    ? UploadThumbnailConverter.Convert(info) : info;
                result = await uploads.RequestNativeFileAsync(JsonSerializer.SerializeToElement(new {
                    kind = "file", filePath = delivered.FullName, name = delivered.Name, size = delivered.Length,
                    lastModified = new DateTimeOffset(delivered.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                    requestId = payload.GetProperty("requestId").GetString(), sessionId = payload.GetProperty("sessionId").GetString(),
                    platform = payload.GetProperty("platform").GetString(), role = payload.GetProperty("role").GetString(), token = payload.GetProperty("token").GetString()
                }));
            }
            else if (operation == "deliverCatalogueThumbnail")
            {
                if (additionalObjects.Count != 0 || payload.GetProperty("role").GetString() != "thumbnail")
                    throw new InvalidOperationException("invalid-payload");
                FileInfo delivered = uploadThumbnails.ConvertSelected(payload);
                result = await uploads.RequestNativeFileAsync(JsonSerializer.SerializeToElement(new {
                    kind = "file", filePath = delivered.FullName, name = delivered.Name, size = delivered.Length,
                    lastModified = new DateTimeOffset(delivered.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                    requestId = payload.GetProperty("requestId").GetString(), sessionId = payload.GetProperty("sessionId").GetString(),
                    platform = payload.GetProperty("platform").GetString(), role = "thumbnail", token = payload.GetProperty("token").GetString()
                }));
            }
            else if (operation == "stageGeneratedMediaChunk")
            {
                if (additionalObjects.Count != 0) throw new InvalidOperationException("invalid-payload");
                result = new { staged = generatedUploadMedia.Append(payload) is not null };
            }
            else if (operation == "deliverGeneratedMedia")
            {
                if (additionalObjects.Count != 0) throw new InvalidOperationException("invalid-payload");
                FileInfo delivered = generatedUploadMedia.Resolve(payload);
                result = await uploads.RequestNativeFileAsync(JsonSerializer.SerializeToElement(new {
                    kind = "file", filePath = delivered.FullName, name = delivered.Name, size = delivered.Length,
                    lastModified = new DateTimeOffset(delivered.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                    requestId = payload.GetProperty("requestId").GetString(), sessionId = payload.GetProperty("sessionId").GetString(),
                    platform = payload.GetProperty("platform").GetString(), role = payload.GetProperty("role").GetString(),
                    token = payload.GetProperty("token").GetString()
                }));
            }
            else if (operation == "deliverUploadFile")
            {
                if (additionalObjects.Count != 1 || additionalObjects[0] is not CoreWebView2File file)
                    throw new InvalidOperationException("Choose the file again in this window.");
                FileInfo info = new(file.Path);
                if (!info.Exists || info.Name != payload.GetProperty("name").GetString() || info.Length != payload.GetProperty("size").GetInt64() ||
                    Math.Abs(new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() - payload.GetProperty("lastModified").GetInt64()) > 2)
                    throw new InvalidOperationException("The selected file changed. Choose it again before uploading.");
                var command = payload.EnumerateObject().ToDictionary(item => item.Name, item => (object)item.Value.Clone());
                FileInfo delivered = payload.GetProperty("role").GetString() == "thumbnail"
                    ? UploadThumbnailConverter.Convert(info) : info;
                command["kind"] = "file";
                command["filePath"] = delivered.FullName;
                command["name"] = delivered.Name;
                command["size"] = delivered.Length;
                command["lastModified"] = new DateTimeOffset(delivered.LastWriteTimeUtc).ToUnixTimeMilliseconds();
                result = await uploads.RequestNativeFileAsync(JsonSerializer.SerializeToElement(command));
            }
            else result = await uploads.RequestAsync(payload);
            return JsonSerializer.Serialize(new { requestId, ok = true, result }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        }
        catch (Exception error)
        {
            return JsonSerializer.Serialize(new { requestId, ok = false, error = new { code = error is InvalidOperationException ? error.Message : "upload-connection-failed" } });
        }
    }

    public async Task ExitAsync()
    {
        exiting = true;
        await dispatcher.DrainAsync();
        Dispose();
        Close();
    }

    public void Dispose()
    {
        if (disposed)
            return;
        disposed = true;
        uploads.Dispose();
        windowSource?.RemoveHook(HandleWindowMessage);
        windowSource = null;
        googleCatalogue.Dispose();
        googleHttp.Dispose();
    }

    public void OpenChromeSetup()
    {
        showChromeSetup = true;
        Show();
        Activate();
        if (Browser.CoreWebView2 is not null)
            Browser.CoreWebView2.Navigate("https://app.ofenhancer.local/index.html");
    }

    private string? ChooseGoogleClientConfiguration()
    {
        Microsoft.Win32.OpenFileDialog dialog = new()
        {
            Title = "Import Google Desktop app setup",
            Filter = "Google Desktop app JSON (*.json)|*.json",
            CheckFileExists = true,
            Multiselect = false,
        };
        return dialog.ShowDialog(this) == true ? dialog.FileName : null;
    }

    protected override void OnSourceInitialized(EventArgs eventArgs)
    {
        base.OnSourceInitialized(eventArgs);
        windowSource = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        windowSource?.AddHook(HandleWindowMessage);
    }

    private async void Window_Loaded(object sender, RoutedEventArgs eventArgs)
    {
        string userDataFolder = AppConfiguration.ResolveWebViewRoot(create: true);
        CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
            userDataFolder: userDataFolder
        );
        await Browser.EnsureCoreWebView2Async(environment);
        Browser.CoreWebView2.NavigationCompleted += async (_, _) =>
        {
            if (!showChromeSetup || !Uri.TryCreate(Browser.CoreWebView2.Source, UriKind.Absolute, out var source)
                || source.Host != "app.ofenhancer.local" || source.AbsolutePath != "/index.html") return;
            showChromeSetup = false;
            await Browser.CoreWebView2.ExecuteScriptAsync("document.getElementById('chromeConnection')?.click()");
        };
        string appRoot = Path.Combine(AppContext.BaseDirectory, "app");
        Browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.ofenhancer.local",
            appRoot,
            CoreWebView2HostResourceAccessKind.DenyCors
        );
        Browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
        Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        Browser.CoreWebView2.AddWebResourceRequestedFilter(
            "https://thumbs.ofenhancer.local/*",
            CoreWebView2WebResourceContext.Image
        );
        Browser.CoreWebView2.WebResourceRequested += async (_, args) =>
        {
            CoreWebView2Deferral deferral = args.GetDeferral();
            try
            {
                // WebView2 request members are COM objects bound to this UI thread.
                // Snapshot the URI before queuing the catalogue lookup on a worker.
                string requestUri = args.Request.Uri;
                ThumbnailResource? resource = await dispatcher.EnqueueAsync(
                    () => thumbnails.Open(new Uri(requestUri))
                );
                if (resource is null)
                {
                    SetThumbnailNotFound(args);
                    return;
                }
                try
                {
                    args.Response = Browser.CoreWebView2.Environment.CreateWebResourceResponse(
                        resource.Stream,
                        200,
                        "OK",
                        $"Content-Type: {resource.ContentType}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff"
                    );
                }
                catch
                {
                    resource.Dispose();
                    throw;
                }
            }
            catch (IOException)
            {
                SetThumbnailNotFound(args);
            }
            catch (UnauthorizedAccessException)
            {
                SetThumbnailNotFound(args);
            }
            catch (UriFormatException)
            {
                SetThumbnailNotFound(args);
            }
            finally
            {
                deferral.Complete();
            }
        };
        Browser.CoreWebView2.WebMessageReceived += async (_, message) =>
        {
            if (exiting || !WebMessageSourcePolicy.IsTrusted(message.Source))
                return;
            try
            {
                string json = message.TryGetWebMessageAsString();
                string response = await HandleUploadMessage(json, message.AdditionalObjects?.ToArray() ?? [])
                    ?? await dispatcher.HandleAsync(json);
                if (!exiting) Browser.CoreWebView2.PostWebMessageAsJson(response);
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException)
            {
                if (!exiting) Browser.CoreWebView2.PostWebMessageAsJson("{\"ok\":false,\"error\":{\"code\":\"invalid-request\"}}");
            }
        };
        Browser.CoreWebView2.NavigationStarting += (_, args) =>
        {
            if (!WebMessageSourcePolicy.IsTrusted(args.Uri))
                args.Cancel = true;
        };
        Browser.Source = new Uri("https://app.ofenhancer.local/index.html");
    }

    private void Window_Closing(object? sender, CancelEventArgs eventArgs)
    {
        if (
            exiting
            || System.Windows.Application.Current.ShutdownMode != ShutdownMode.OnExplicitShutdown
        )
            return;
        eventArgs.Cancel = true;
        Hide();
    }

    private nint HandleWindowMessage(
        nint window,
        int message,
        nint wParam,
        nint lParam,
        ref bool handled
    )
    {
        RestartManagerDecision decision = RestartManagerMessage.Decide(message, wParam, lParam);
        if (!decision.Handled)
            return nint.Zero;
        handled = true;
        if (decision.Shutdown)
        {
            exiting = true;
            System.Windows.Application.Current.Shutdown();
        }
        return decision.Result;
    }

    private static void OpenChrome(Uri uri)
    {
        ChromeIntegration.OpenChrome(uri);
    }

    private async Task<string> OpenChromePageAsync(string page)
    {
        var readiness = await Task.Run(chromeIntegration.Get);
        var status = JsonSerializer.SerializeToElement(uploads.Status());
        if (status.GetProperty("browsers").GetArrayLength() > 0)
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(8));
            try { await uploads.OpenChromePageAsync(page, timeout.Token); }
            catch (OperationCanceledException) { throw new InvalidOperationException("Chrome did not confirm opening the page. Reload the existing OFEnhancer extension and try again."); }
            return page == "extensions" ? "Chrome extensions opened in your existing Chrome window." : "A new tab opened in your existing Chrome window.";
        }
        // Chrome rejects internal URLs on its command line. Before the extension is
        // connected, open the installed guide and explain the manual address step.
        if (page == "extensions")
        {
            string guide = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "extension-setup.html"));
            if (!File.Exists(guide)) throw new InvalidOperationException("Open chrome://extensions in Chrome's address bar. The extension is not connected yet.");
            readiness = chromeIntegration.Get();
            if (readiness.ExtensionFolder is null)
                throw new InvalidOperationException("Copy chrome://extensions into Chrome and reload the existing extension. Choose Fresh reset for a clean installation.");
            var address = new UriBuilder(new Uri(guide)) { Fragment = "folder=" + Uri.EscapeDataString(readiness.ExtensionFolder)
                + (readiness.ResetPending ? "&reset=1&previous=" + Uri.EscapeDataString(readiness.ResetExtensionId ?? ChromeIntegration.CanonicalExtensionId) : "") };
            OpenChrome(address.Uri);
            return "Copy this address and paste it into Chrome: chrome://extensions";
        }
        OpenChrome(new Uri("about:blank"));
        return "Chrome opened.";
    }

    private static JsonElement WithoutTransportMetadata(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return payload;
        Dictionary<string, JsonElement> values = payload.EnumerateObject()
            .Where(property => property.Name is not ("bridgeExtensionId" or "extensionVersion" or "installation"))
            .ToDictionary(property => property.Name, property => property.Value.Clone());
        return JsonSerializer.SerializeToElement(values);
    }

    private string? ChooseThumbnailRoot()
    {
        using System.Windows.Forms.FolderBrowserDialog dialog = new()
        {
            Description = "Choose your curated thumbnail folder",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        string? configured = catalogue.ConfiguredThumbnailRoot;
        if (configured is not null && Directory.Exists(configured))
            dialog.SelectedPath = configured;
        return dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK
            ? dialog.SelectedPath
            : null;
    }

    private void SetThumbnailNotFound(CoreWebView2WebResourceRequestedEventArgs args)
    {
        args.Response = Browser.CoreWebView2.Environment.CreateWebResourceResponse(
            new MemoryStream([]),
            404,
            "Not Found",
            "Content-Type: text/plain\r\nCache-Control: no-store"
        );
    }
}
