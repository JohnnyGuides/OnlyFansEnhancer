using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public class PreviousPackageVerificationTests
{
    private string root = "";

    [TestInitialize]
    public void CreateRoot()
    {
        root = Path.Combine(Path.GetTempPath(), "ofe-previous-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
    }

    [TestCleanup]
    public void DeleteRoot() => Directory.Delete(root, recursive: true);

    // The package layout without package-manifest.json, as a damaged install leaves it.
    private void WriteManifestlessPackage(string? assemblySource = null)
    {
        string desktop = Path.Combine(root, "desktop");
        Directory.CreateDirectory(desktop);
        File.WriteAllText(Path.Combine(desktop, "OFEnhancer.Desktop.exe"), "apphost");
        File.Copy(assemblySource ?? typeof(FreshReinstallMaintenance).Assembly.Location,
            Path.Combine(desktop, "OFEnhancer.Desktop.dll"));
        foreach (string directory in new[] { "native", "extension", "assets", "tools" })
            Directory.CreateDirectory(Path.Combine(root, directory));
        File.WriteAllText(Path.Combine(root, "version.json"), "{\"product\":\"OFEnhancer\",\"productVersion\":\"0.20.80\"}");
        File.WriteAllText(Path.Combine(root, "unins000.exe"), "uninstaller");
        File.WriteAllText(Path.Combine(root, "unins000.dat"), "uninstaller");
    }

    [TestMethod]
    public void RecognizedInstallWithoutAManifestIsAcceptedForRepair()
    {
        WriteManifestlessPackage();

        FreshReinstallMaintenance.VerifyPreviousPackage(root);
    }

    [TestMethod]
    public void ForeignContentBesideProductFilesIsNotRecognized()
    {
        WriteManifestlessPackage();
        File.WriteAllText(Path.Combine(root, "user-file.txt"), "not ours");

        var error = Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallMaintenance.VerifyPreviousPackage(root));
        StringAssert.Contains(error.Message, "not recognizably an OFEnhancer installation");
    }

    [TestMethod]
    public void AnotherAssemblyUnderTheProductNameIsNotRecognized()
    {
        WriteManifestlessPackage(typeof(Assert).Assembly.Location);

        Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallMaintenance.VerifyPreviousPackage(root));
    }

    [TestMethod]
    public void AFolderWithoutTheProductExecutableIsNotRecognized()
    {
        WriteManifestlessPackage();
        File.Delete(Path.Combine(root, "desktop", "OFEnhancer.Desktop.exe"));

        Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallMaintenance.VerifyPreviousPackage(root));
    }

    [TestMethod]
    public void UnreadableManifestFailsWithAPlainMessage()
    {
        File.WriteAllText(Path.Combine(root, "package-manifest.json"), "{ nope");

        var error = Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallMaintenance.VerifyPreviousPackage(root));
        Assert.AreEqual("The previous OFEnhancer installation root could not be verified.", error.Message);
    }

    [TestMethod]
    public void DriveRootIsRefusedWithItsOwnMessage()
    {
        string driveRoot = Path.GetPathRoot(Path.GetFullPath(root))!;

        Assert.IsTrue(FreshReinstallMaintenance.IsDriveRoot(driveRoot));
        Assert.IsFalse(FreshReinstallMaintenance.IsDriveRoot(root));
        var error = Assert.ThrowsException<InvalidOperationException>(() => FreshReinstallMaintenance.VerifyPreviousPackage(driveRoot));
        Assert.AreEqual(FreshReinstallMaintenance.DriveRootMessage, error.Message);
    }
}
