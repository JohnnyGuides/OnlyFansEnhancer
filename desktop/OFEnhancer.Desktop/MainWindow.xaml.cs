using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

public partial class MainWindow : Window, IDisposable
{
    private readonly WebMessageRouter router;
    private readonly WebMessageDispatcher dispatcher;
    private readonly ThumbnailResourceResolver thumbnails;
    private readonly CatalogueStore catalogue;
    private readonly HttpClient googleHttp;
    private readonly GoogleCatalogueController googleCatalogue;
    private bool exiting;
    private bool disposed;

    public MainWindow(string? extensionId, CatalogueStore catalogue)
    {
        InitializeComponent();
        this.catalogue = catalogue;
        WebMessageRouter? queuedRouter = null;
        dispatcher = new WebMessageDispatcher(json => queuedRouter!.Handle(json));
        googleHttp = GoogleHttpClientFactory.Create();
        googleCatalogue = new(
            new DesktopSettingsStore(AppConfiguration.SettingsPath),
            catalogue,
            new DpapiGoogleTokenVault(AppConfiguration.GoogleTokenPath),
            googleHttp,
            GoogleBrowserLauncher.Open,
            dispatcher.EnqueueAsync
        );
        router = new WebMessageRouter(
            OpenChrome,
            () => extensionId,
            catalogue,
            () => Dispatcher.Invoke(ChooseThumbnailRoot),
            googleCatalogue
        );
        queuedRouter = router;
        thumbnails = new ThumbnailResourceResolver(catalogue);
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
        googleCatalogue.Dispose();
        googleHttp.Dispose();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs eventArgs)
    {
        string userDataFolder =
            Environment.GetEnvironmentVariable("OFENHANCER_WEBVIEW2_USER_DATA_FOLDER")
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OFEnhancer",
                "WebView2"
            );
        CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
            userDataFolder: userDataFolder
        );
        await Browser.EnsureCoreWebView2Async(environment);
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
                ThumbnailResource? resource = await dispatcher.EnqueueAsync(
                    () => thumbnails.Open(new Uri(args.Request.Uri))
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
            string response = await dispatcher.HandleAsync(message.TryGetWebMessageAsString());
            if (!exiting)
                Browser.CoreWebView2.PostWebMessageAsJson(response);
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

    private static void OpenChrome(Uri uri)
    {
        ProcessStartInfo start = new("chrome.exe") { UseShellExecute = true };
        start.ArgumentList.Add(uri.AbsoluteUri);
        Process.Start(start);
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
