using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class AppConfigurationTests
{
    private const string ExtensionId = "cfkenejbehihjmeokedjfccmhffeahgh";

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
}
