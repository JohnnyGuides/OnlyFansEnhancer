using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

public partial class MainWindow : Window
{
    private readonly WebMessageRouter router;
    private readonly ThumbnailResourceResolver thumbnails;
    private bool exiting;

    public MainWindow(string? extensionId, CatalogueStore catalogue)
    {
        InitializeComponent();
        router = new WebMessageRouter(OpenChrome, () => extensionId, catalogue);
        thumbnails = new ThumbnailResourceResolver(catalogue);
    }

    public void Exit()
    {
        exiting = true;
        Close();
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
        Browser.CoreWebView2.WebResourceRequested += (_, args) =>
        {
            try
            {
                ThumbnailResource? resource = thumbnails.Resolve(new Uri(args.Request.Uri));
                if (resource is null)
                {
                    SetThumbnailNotFound(args);
                    return;
                }
                FileStream stream = new(
                    resource.Path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    bufferSize: 64 * 1024,
                    FileOptions.SequentialScan
                );
                args.Response = Browser.CoreWebView2.Environment.CreateWebResourceResponse(
                    stream,
                    200,
                    "OK",
                    $"Content-Type: {resource.ContentType}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff"
                );
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
        };
        Browser.CoreWebView2.WebMessageReceived += (_, message) =>
        {
            string response = router.Handle(message.TryGetWebMessageAsString());
            Browser.CoreWebView2.PostWebMessageAsJson(response);
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
