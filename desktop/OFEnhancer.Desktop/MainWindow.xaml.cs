using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace OFEnhancer.Desktop;

public partial class MainWindow : Window
{
    private readonly WebMessageRouter router;
    private bool exiting;

    public MainWindow(string? extensionId)
    {
        InitializeComponent();
        router = new WebMessageRouter(OpenChrome, () => extensionId);
    }

    public void Exit()
    {
        exiting = true;
        Close();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs eventArgs)
    {
        await Browser.EnsureCoreWebView2Async();
        string appRoot = Path.Combine(AppContext.BaseDirectory, "app");
        Browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.ofenhancer.local",
            appRoot,
            CoreWebView2HostResourceAccessKind.DenyCors
        );
        Browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
        Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
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
}

