using OFEnhancer.Protocol;
using System.Diagnostics;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class BrowserSelectionTests
{
    [DataTestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void Missing_or_saved_system_preference_launches_the_system_browser(bool saveSystem)
    {
        using TestDirectory temp = new();
        DesktopSettingsStore store = new(Path.Combine(temp.Path, "settings.json"));
        BrowserSettingsController controller = new(store, () => []);
        if (saveSystem)
            controller.Save("system");

        Uri authorization = new("https://accounts.google.com/o/oauth2/v2/auth?state=test");
        ProcessStartInfo start = GoogleBrowserLauncher.CreateStartInfo(authorization, store.Load().BrowserId, []);

        Assert.AreEqual("system", controller.Get().SelectedId);
        Assert.IsTrue(start.UseShellExecute);
        Assert.AreEqual(authorization.AbsoluteUri, start.FileName);
    }

    [TestMethod]
    public void Removed_browser_preference_launches_the_system_browser_shown_in_settings()
    {
        using TestDirectory temp = new();
        DesktopSettingsStore store = new(Path.Combine(temp.Path, "settings.json"));
        store.Save(new(null, null, "firefox"));
        BrowserSettingsController controller = new(store, () => []);
        Uri authorization = new("https://accounts.google.com/o/oauth2/v2/auth?state=test");

        ProcessStartInfo start = GoogleBrowserLauncher.CreateStartInfo(authorization, store.Load().BrowserId, []);

        Assert.AreEqual("system", controller.Get().SelectedId);
        Assert.IsTrue(start.UseShellExecute);
        Assert.AreEqual(authorization.AbsoluteUri, start.FileName);
    }

    [TestMethod]
    public void Browser_settings_start_with_system_default_and_only_list_installed_browsers()
    {
        using TestDirectory temp = new();
        DesktopSettingsStore store = new(Path.Combine(temp.Path, "settings.json"));
        BrowserSettingsController controller = new(
            store,
            () =>
            [
                new InstalledBrowser("chrome", "Google Chrome", @"C:\\Chrome\\chrome.exe"),
                new InstalledBrowser("firefox", "Mozilla Firefox", @"C:\\Firefox\\firefox.exe"),
            ]
        );

        BrowserSettingsView view = controller.Get();

        Assert.AreEqual("system", view.SelectedId);
        CollectionAssert.AreEqual(
            new[] { "system", "chrome", "firefox" },
            view.Options.Select(option => option.Id).ToArray()
        );
    }

    [TestMethod]
    public void Browser_preference_round_trips_and_rejects_an_uninstalled_browser()
    {
        using TestDirectory temp = new();
        DesktopSettingsStore store = new(Path.Combine(temp.Path, "settings.json"));
        BrowserSettingsController controller = new(
            store,
            () => [new InstalledBrowser("firefox", "Mozilla Firefox", @"C:\\Firefox\\firefox.exe")]
        );

        BrowserSettingsView saved = controller.Save("firefox");

        Assert.AreEqual("firefox", saved.SelectedId);
        Assert.AreEqual("firefox", store.Load().BrowserId);
        BrowserSettingsException error = Assert.ThrowsException<BrowserSettingsException>(
            () => controller.Save("chrome")
        );
        Assert.AreEqual("browser-not-installed", error.Code);
    }

    [TestMethod]
    public void Selected_browser_launches_the_authorization_url_without_shell_reinterpretation()
    {
        Uri authorization = new("https://accounts.google.com/o/oauth2/v2/auth?state=one&code=two");
        ProcessStartInfo start = GoogleBrowserLauncher.CreateStartInfo(
            authorization,
            "firefox",
            [new InstalledBrowser("firefox", "Mozilla Firefox", @"C:\\Firefox\\firefox.exe")]
        );

        Assert.AreEqual(@"C:\\Firefox\\firefox.exe", start.FileName);
        Assert.IsFalse(start.UseShellExecute);
        CollectionAssert.AreEqual(new[] { authorization.AbsoluteUri }, start.ArgumentList.ToArray());
    }

    private sealed class TestDirectory : IDisposable
    {
        internal TestDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"ofenhancer-browser-settings-{Guid.NewGuid():N}"
            );
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
