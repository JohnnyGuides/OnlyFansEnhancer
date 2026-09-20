using OFEnhancer.Protocol;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class AppConfigurationTests
{
    private const string DataRootVariable = "OFENHANCER_DATA_ROOT";
    private const string ExtensionId = "cfkenejbehihjmeokedjfccmhffeahgh";
    private const string GoogleClientId =
        "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";

    [TestMethod]
    public void Command_line_extension_id_wins_over_settings()
    {
        string root = CreateSettings("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        try
        {
            string? value = AppConfiguration.ResolveExtensionId(
                ["--extension-id", ExtensionId],
                Path.Combine(root, "settings.json")
            );

            Assert.AreEqual(ExtensionId, value);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void Settings_supply_a_valid_extension_id()
    {
        string root = CreateSettings(ExtensionId);
        try
        {
            Assert.AreEqual(
                ExtensionId,
                AppConfiguration.ResolveExtensionId([], Path.Combine(root, "settings.json"))
            );
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [DataTestMethod]
    [DataRow("not-an-id")]
    [DataRow("")]
    public void Invalid_settings_do_not_create_a_launch_target(string value)
    {
        string root = CreateSettings(value);
        try
        {
            Assert.IsNull(
                AppConfiguration.ResolveExtensionId([], Path.Combine(root, "settings.json"))
            );
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void Google_token_is_a_separate_file_beside_the_catalogue_database()
    {
        WithDataRoot(
            null,
            () =>
            {
                Assert.AreEqual(
                    Path.GetDirectoryName(AppConfiguration.CatalogueDatabasePath),
                    Path.GetDirectoryName(AppConfiguration.GoogleTokenPath)
                );
                Assert.AreNotEqual(AppConfiguration.SettingsPath, AppConfiguration.GoogleTokenPath);
                Assert.AreEqual(
                    "google-oauth-token.dat",
                    Path.GetFileName(AppConfiguration.GoogleTokenPath)
                );
            }
        );
    }

    [TestMethod]
    public void Explicit_data_root_routes_every_private_file_and_creates_the_directory()
    {
        string parent = Path.Combine(Path.GetTempPath(), $"ofenhancer-root-{Guid.NewGuid():N}");
        string configuredRoot = Path.Combine(parent, "configured");
        try
        {
            WithDataRoot(
                configuredRoot,
                () =>
                {
                    Assert.AreEqual(
                        Path.Combine(configuredRoot, "settings.json"),
                        AppConfiguration.SettingsPath
                    );
                    Assert.AreEqual(
                        Path.Combine(configuredRoot, "data", "catalogue.db"),
                        AppConfiguration.CatalogueDatabasePath
                    );
                    Assert.AreEqual(
                        Path.Combine(configuredRoot, "data", "google-oauth-token.dat"),
                        AppConfiguration.GoogleTokenPath
                    );
                    Assert.AreEqual(
                        Path.Combine(parent, "OFEnhancer-Maintenance", "fresh-reinstall.json"),
                        AppConfiguration.MaintenanceTransactionPath
                    );
                    Assert.IsTrue(Directory.Exists(configuredRoot));
                }
            );
        }
        finally
        {
            if (Directory.Exists(parent))
                Directory.Delete(parent, true);
        }
    }

    [TestMethod]
    public void Missing_data_root_override_uses_local_application_data()
    {
        WithDataRoot(
            null,
            () =>
            {
                string expectedRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OFEnhancer"
                );
                Assert.AreEqual(
                    Path.Combine(expectedRoot, "settings.json"),
                    AppConfiguration.SettingsPath
                );
                Assert.AreEqual(
                    Path.Combine(expectedRoot, "data", "catalogue.db"),
                    AppConfiguration.CatalogueDatabasePath
                );
                Assert.AreEqual(
                    Path.Combine(expectedRoot, "data", "google-oauth-token.dat"),
                    AppConfiguration.GoogleTokenPath
                );
            }
        );
    }

    [DataTestMethod]
    [DataRow("relative-data-root")]
    [DataRow("   ")]
    public void Malformed_or_unrooted_data_root_override_fails_closed(string configuredRoot)
    {
        WithDataRoot(
            configuredRoot,
            () =>
                Assert.ThrowsException<InvalidOperationException>(
                    () => _ = AppConfiguration.SettingsPath
                )
        );
    }

    [TestMethod]
    public void File_overlong_and_volume_root_overrides_fail_closed()
    {
        string parent = Path.Combine(Path.GetTempPath(), $"ofenhancer-root-{Guid.NewGuid():N}");
        Directory.CreateDirectory(parent);
        string file = Path.Combine(parent, "not-a-directory");
        File.WriteAllText(file, "fixture");
        try
        {
            foreach (string configuredRoot in new[]
            {
                file,
                Path.Combine(parent, new string('x', 1_100)),
                Path.GetPathRoot(parent)!,
            })
            {
                WithDataRoot(
                    configuredRoot,
                    () =>
                        Assert.ThrowsException<InvalidOperationException>(
                            () => _ = AppConfiguration.SettingsPath,
                            configuredRoot
                        )
                );
            }
        }
        finally
        {
            Directory.Delete(parent, true);
        }
    }

    [DataTestMethod]
    [DataRow(GoogleClientId, true)]
    [DataRow("123.apps.googleusercontent.com", false)]
    [DataRow("123-ABC.apps.googleusercontent.com", false)]
    [DataRow("not-a-google-client", false)]
    [DataRow("", false)]
    public void Installed_app_google_client_ids_have_one_strict_shape(string value, bool expected)
    {
        Assert.AreEqual(expected, AppConfiguration.IsValidGoogleOAuthClientId(value));
    }

    [TestMethod]
    public void Personalized_defaults_backfill_missing_google_client_without_replacing_saved_settings()
    {
        string root = Path.Combine(Path.GetTempPath(), $"ofenhancer-defaults-{Guid.NewGuid():N}");
        string installRoot = Path.Combine(root, "install");
        string settingsPath = Path.Combine(root, "data", "settings.json");
        Directory.CreateDirectory(installRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
        File.WriteAllText(
            Path.Combine(installRoot, "installer-defaults.json"),
            $$"""{"extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","googleOAuthClientId":"{{GoogleClientId}}"}"""
        );
        File.WriteAllText(
            settingsPath,
            $$"""{"extensionId":"{{ExtensionId}}","browserId":"firefox"}"""
        );
        try
        {
            AppConfiguration.ApplyFreshInstallerDefaults(installRoot, settingsPath);

            DesktopSettings saved = new DesktopSettingsStore(settingsPath).Load();
            Assert.AreEqual(ExtensionId, saved.ExtensionId);
            Assert.AreEqual(GoogleClientId, saved.GoogleOAuthClientId);
            Assert.AreEqual("firefox", saved.BrowserId);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    private static string CreateSettings(string extensionId)
    {
        string root = Path.Combine(Path.GetTempPath(), $"ofenhancer-settings-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        File.WriteAllText(
            Path.Combine(root, "settings.json"),
            $$"""{"extensionId":"{{extensionId}}"}"""
        );
        return root;
    }

    private static void WithDataRoot(string? value, Action action)
    {
        string? previous = Environment.GetEnvironmentVariable(DataRootVariable);
        try
        {
            Environment.SetEnvironmentVariable(DataRootVariable, value);
            action();
        }
        finally
        {
            Environment.SetEnvironmentVariable(DataRootVariable, previous);
        }
    }
}
