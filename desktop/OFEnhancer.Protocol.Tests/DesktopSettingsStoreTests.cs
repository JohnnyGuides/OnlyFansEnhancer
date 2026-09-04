using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class DesktopSettingsStoreTests
{
    private const string ExtensionId = "cfkenejbehihjmeokedjfccmhffeahgh";
    private const string FirstGoogleClientId =
        "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
    private const string SecondGoogleClientId =
        "987654321098-zyxwvutsrqponmlkjihgfedcba654321.apps.googleusercontent.com";

    [TestMethod]
    public void Google_client_id_round_trips_without_losing_the_extension_id()
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "settings.json");
        DesktopSettingsStore store = new(path);

        store.Save(new DesktopSettings(ExtensionId, FirstGoogleClientId));
        store.Save(new DesktopSettings(ExtensionId, SecondGoogleClientId));

        Assert.AreEqual(new DesktopSettings(ExtensionId, SecondGoogleClientId), store.Load());
        using JsonDocument json = JsonDocument.Parse(File.ReadAllText(path));
        CollectionAssert.AreEquivalent(
            new[] { "extensionId", "googleOAuthClientId" },
            json.RootElement.EnumerateObject().Select(property => property.Name).ToArray()
        );
        string raw = json.RootElement.GetRawText();
        Assert.IsFalse(raw.Contains("token", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(raw.Contains("workbook", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(raw.Contains("path", StringComparison.OrdinalIgnoreCase));
    }

    [DataTestMethod]
    [DataRow("not-json")]
    [DataRow("{\"extensionId\":\"cfkenejbehihjmeokedjfccmhffeahgh\",\"unknown\":true}")]
    [DataRow("[]")]
    public void Malformed_or_unknown_settings_fail_closed(string json)
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "settings.json");
        File.WriteAllText(path, json);

        Assert.AreEqual(new DesktopSettings(null, null), new DesktopSettingsStore(path).Load());
    }

    [TestMethod]
    public void Invalid_known_values_are_not_loaded()
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "settings.json");
        File.WriteAllText(
            path,
            "{\"extensionId\":\"wrong\",\"googleOAuthClientId\":\"wrong\"}"
        );

        Assert.AreEqual(new DesktopSettings(null, null), new DesktopSettingsStore(path).Load());
    }

    [DataTestMethod]
    [DataRow(false, FirstGoogleClientId)]
    [DataRow(true, SecondGoogleClientId)]
    public void Failed_atomic_replace_leaves_valid_old_or_new_settings(
        bool replaceBeforeThrowing,
        string expectedClientId
    )
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "settings.json");
        DesktopSettingsStore initial = new(path);
        initial.Save(new DesktopSettings(ExtensionId, FirstGoogleClientId));
        DesktopSettingsStore failing = new(
            path,
            (source, destination) =>
            {
                if (replaceBeforeThrowing)
                    File.Move(source, destination, overwrite: true);
                throw new IOException("injected replace failure");
            }
        );

        Assert.ThrowsException<DesktopSettingsException>(() =>
            failing.Save(new DesktopSettings(ExtensionId, SecondGoogleClientId))
        );

        Assert.AreEqual(
            new DesktopSettings(ExtensionId, expectedClientId),
            new DesktopSettingsStore(path).Load()
        );
        using JsonDocument _ = JsonDocument.Parse(File.ReadAllText(path));
    }

    [TestMethod]
    public void Save_rejects_invalid_values_before_touching_the_file()
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "settings.json");
        DesktopSettingsStore store = new(path);
        store.Save(new DesktopSettings(ExtensionId, FirstGoogleClientId));
        string before = File.ReadAllText(path);

        DesktopSettingsException error = Assert.ThrowsException<DesktopSettingsException>(() =>
            store.Save(new DesktopSettings(ExtensionId, "bad"))
        );

        Assert.AreEqual("invalid-google-client-id", error.Code);
        Assert.AreEqual(before, File.ReadAllText(path));
    }

    private sealed class TestDirectory : IDisposable
    {
        internal TestDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"ofenhancer-desktop-settings-{Guid.NewGuid():N}"
            );
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
