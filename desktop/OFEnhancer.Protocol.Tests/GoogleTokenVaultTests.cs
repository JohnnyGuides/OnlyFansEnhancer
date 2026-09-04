using System.Security.Cryptography;
using System.Text;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleTokenVaultTests
{
    [TestMethod]
    public void SaveLoadAndDeleteUseOneAtomicCurrentUserFile()
    {
        string root = CreateTempFolder();
        string path = Path.Combine(root, "google-token.dat");
        string sibling = Path.Combine(root, "keep.txt");
        File.WriteAllText(sibling, "keep");
        RecordingProtector protector = new();
        DpapiGoogleTokenVault vault = new(path, protector);
        GoogleRefreshCredential first = new("refresh-first", DateTimeOffset.Parse("2026-09-04T12:00:00Z"));
        GoogleRefreshCredential second = new("refresh-second", DateTimeOffset.Parse("2026-09-04T13:00:00Z"));

        try
        {
            vault.Save(first);
            vault.Save(second);

            Assert.AreEqual(second, vault.Load());
            Assert.AreEqual(DataProtectionScope.CurrentUser, protector.LastProtectScope);
            Assert.AreEqual(DataProtectionScope.CurrentUser, protector.LastUnprotectScope);
            Assert.AreEqual(1, Directory.GetFiles(root, "google-token.dat*", SearchOption.TopDirectoryOnly).Length);
            string ciphertext = Convert.ToHexString(File.ReadAllBytes(path));
            Assert.IsFalse(ciphertext.Contains(Convert.ToHexString(Encoding.UTF8.GetBytes(second.RefreshToken)), StringComparison.Ordinal));

            vault.Delete();

            Assert.IsFalse(File.Exists(path));
            Assert.IsTrue(File.Exists(sibling));
            Assert.IsNull(vault.Load());
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void CorruptCiphertextIsRejectedWithoutLeakingItsContents()
    {
        string root = CreateTempFolder();
        string path = Path.Combine(root, "google-token.dat");
        const string secret = "refresh-token-that-must-not-leak";
        File.WriteAllText(path, secret);
        DpapiGoogleTokenVault vault = new(path, new ThrowingProtector());

        try
        {
            Exception error = Assert.ThrowsException<InvalidDataException>(() => vault.Load());
            Assert.IsFalse(error.ToString().Contains(secret, StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void ProtectionFailureDoesNotLeakRefreshToken()
    {
        string root = CreateTempFolder();
        const string secret = "refresh-token-that-must-not-leak";
        DpapiGoogleTokenVault vault = new(Path.Combine(root, "google-token.dat"), new ThrowingProtector());

        try
        {
            Exception error = Assert.ThrowsException<InvalidOperationException>(() =>
                vault.Save(new(secret, DateTimeOffset.Parse("2026-09-04T12:00:00Z")))
            );
            Assert.IsFalse(error.ToString().Contains(secret, StringComparison.Ordinal));
            Assert.AreEqual(0, Directory.GetFiles(root).Length);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [TestMethod]
    public void MemoryVaultSupportsTheSameCredentialLifecycle()
    {
        MemoryGoogleTokenVault vault = new();
        GoogleRefreshCredential credential = new("refresh", DateTimeOffset.Parse("2026-09-04T12:00:00Z"));

        Assert.IsNull(vault.Load());
        vault.Save(credential);
        Assert.AreEqual(credential, vault.Load());
        vault.Delete();
        Assert.IsNull(vault.Load());
        Assert.IsFalse(credential.ToString().Contains("refresh", StringComparison.Ordinal));
    }

    private static string CreateTempFolder()
    {
        string path = Path.Combine(Path.GetTempPath(), $"ofenhancer-token-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private sealed class RecordingProtector : ITokenProtector
    {
        public DataProtectionScope? LastProtectScope { get; private set; }
        public DataProtectionScope? LastUnprotectScope { get; private set; }

        public byte[] Protect(byte[] plaintext, byte[] entropy, DataProtectionScope scope)
        {
            LastProtectScope = scope;
            return plaintext.Select(value => (byte)(value ^ 0xA5)).ToArray();
        }

        public byte[] Unprotect(byte[] ciphertext, byte[] entropy, DataProtectionScope scope)
        {
            LastUnprotectScope = scope;
            return ciphertext.Select(value => (byte)(value ^ 0xA5)).ToArray();
        }
    }

    private sealed class ThrowingProtector : ITokenProtector
    {
        public byte[] Protect(byte[] plaintext, byte[] entropy, DataProtectionScope scope) =>
            throw new CryptographicException(Encoding.UTF8.GetString(plaintext));

        public byte[] Unprotect(byte[] ciphertext, byte[] entropy, DataProtectionScope scope) =>
            throw new CryptographicException(Encoding.UTF8.GetString(ciphertext));
    }
}
