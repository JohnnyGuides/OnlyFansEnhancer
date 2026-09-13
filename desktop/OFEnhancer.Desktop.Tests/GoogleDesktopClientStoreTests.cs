using OFEnhancer.Protocol;
using System.Security.Cryptography;
using System.Text;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleDesktopClientStoreTests
{
    private const string ClientId = "123456789-desktopclient.apps.googleusercontent.com";
    private const string Secret = "desktop-secret-value";
    private static string Configuration(string extra = "") =>
        "{\"installed\":{\"client_id\":\"" + ClientId + "\",\"client_secret\":\"" + Secret + "\"" + extra + "}}";

    [TestMethod]
    public void ImportedCredentialIsEncryptedBoundToClientAndAtomic()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofenhancer-client-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string path = Path.Combine(root, "client.dat");
            GoogleDesktopClientStore store = new(path);
            GoogleDesktopClientCredential credential = GoogleDesktopClientStore.Parse(Encoding.UTF8.GetBytes(Configuration()));
            store.Save(credential);
            Assert.AreEqual(Secret, store.Load(ClientId)!.ClientSecret);
            Assert.IsNull(store.Load("987654321-other.apps.googleusercontent.com"));
            Assert.IsFalse(Encoding.UTF8.GetString(File.ReadAllBytes(path)).Contains(Secret));
            Assert.IsFalse(credential.ToString().Contains(Secret));
            store.Save(credential);
            Assert.AreEqual(1, Directory.GetFiles(root).Length);
        }
        finally { Directory.Delete(root, true); }
    }

    [DataTestMethod]
    [DataRow("{\"web\":{\"client_id\":\"123456789-desktopclient.apps.googleusercontent.com\",\"client_secret\":\"secret\"}}")]
    [DataRow("{\"installed\":{\"client_id\":\"123456789-desktopclient.apps.googleusercontent.com\"}}")]
    [DataRow("{\"installed\":{\"client_id\":\"123456789-desktopclient.apps.googleusercontent.com\",\"client_secret\":\"secret\",\"token_uri\":\"https://evil.example/token\"}}")]
    [DataRow("{\"installed\":{\"client_id\":\"123456789-desktopclient.apps.googleusercontent.com\",\"client_secret\":\"secret\",\"client_secret\":\"other\"}}")]
    public void InvalidOrNonDesktopFilesAreRejectedWithoutContentsInErrors(string json)
    {
        var error = Assert.ThrowsException<GoogleCatalogueControllerException>(() =>
            GoogleDesktopClientStore.Parse(Encoding.UTF8.GetBytes(json)));
        Assert.AreEqual("google-client-configuration-invalid", error.Code);
        Assert.IsFalse(error.ToString().Contains(json));
    }

    [TestMethod]
    public void StandardGoogleDesktopDownloadEndpointsAreAccepted()
    {
        var credential = GoogleDesktopClientStore.Parse(Encoding.UTF8.GetBytes(Configuration(
            ",\"auth_uri\":\"https://accounts.google.com/o/oauth2/auth\",\"token_uri\":\"https://oauth2.googleapis.com/token\",\"auth_provider_x509_cert_url\":\"https://www.googleapis.com/oauth2/v1/certs\",\"redirect_uris\":[\"http://localhost\"]")));
        Assert.AreEqual(ClientId, credential.ClientId);
        Assert.AreEqual(Secret, credential.ClientSecret);
    }

    [TestMethod]
    public void FailedProtectionPreservesExistingCredentialAndRedactsSecret()
    {
        string root = Path.Combine(Path.GetTempPath(), "ofenhancer-client-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string path = Path.Combine(root, "client.dat");
            GoogleDesktopClientStore store = new(path);
            GoogleDesktopClientCredential credential = GoogleDesktopClientStore.Parse(Encoding.UTF8.GetBytes(Configuration()));
            store.Save(credential);
            byte[] original = File.ReadAllBytes(path);
            var error = Assert.ThrowsException<GoogleCatalogueControllerException>(() =>
                new GoogleDesktopClientStore(path, new FailingProtector()).Save(credential));
            Assert.AreEqual("google-client-configuration-save-failed", error.Code);
            Assert.IsFalse(error.ToString().Contains(Secret));
            CollectionAssert.AreEqual(original, File.ReadAllBytes(path));
            Assert.AreEqual(1, Directory.GetFiles(root).Length);
        }
        finally { Directory.Delete(root, true); }
    }

    private sealed class FailingProtector : ITokenProtector
    {
        public byte[] Protect(byte[] plaintext, byte[] entropy, DataProtectionScope scope) =>
            throw new CryptographicException(Encoding.UTF8.GetString(plaintext));
        public byte[] Unprotect(byte[] ciphertext, byte[] entropy, DataProtectionScope scope) =>
            throw new CryptographicException();
    }

    [TestMethod]
    public void OversizedConfigurationIsRejected()
    {
        Assert.ThrowsException<GoogleCatalogueControllerException>(() =>
            GoogleDesktopClientStore.Parse(new byte[65_537]));
    }
}
