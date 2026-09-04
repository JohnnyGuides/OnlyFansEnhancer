using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.IO;

namespace OFEnhancer.Desktop;

internal interface IGoogleTokenVault
{
    GoogleRefreshCredential? Load();
    void Save(GoogleRefreshCredential credential);
    void Delete();
}

internal interface ITokenProtector
{
    byte[] Protect(byte[] plaintext, byte[] entropy, DataProtectionScope scope);
    byte[] Unprotect(byte[] ciphertext, byte[] entropy, DataProtectionScope scope);
}

internal sealed class DpapiGoogleTokenVault : IGoogleTokenVault
{
    private const int MaximumCredentialFileBytes = 64 * 1024;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("OFEnhancer.GoogleOAuth.v1");
    private readonly string _path;
    private readonly ITokenProtector _protector;

    internal DpapiGoogleTokenVault(string path, ITokenProtector? protector = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        _path = Path.GetFullPath(path);
        _protector = protector ?? new CurrentUserDpapiTokenProtector();
    }

    public GoogleRefreshCredential? Load()
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        try
        {
            FileInfo file = new(_path);
            if (file.Length is <= 0 or > MaximumCredentialFileBytes)
            {
                throw new InvalidDataException();
            }
            byte[] ciphertext = File.ReadAllBytes(_path);
            byte[] plaintext = _protector.Unprotect(ciphertext, Entropy, DataProtectionScope.CurrentUser);
            try
            {
                CredentialPayload? payload = JsonSerializer.Deserialize<CredentialPayload>(
                    plaintext,
                    new JsonSerializerOptions { MaxDepth = 8 }
                );
                if (payload is null || string.IsNullOrEmpty(payload.RefreshToken) || payload.RefreshToken.Length > 8_192)
                {
                    throw new InvalidDataException();
                }
                return new(payload.RefreshToken, payload.AccessTokenExpiresAt);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
        catch
        {
            throw new InvalidDataException("The saved Google credential is invalid.");
        }
    }

    public void Save(GoogleRefreshCredential credential)
    {
        ArgumentNullException.ThrowIfNull(credential);
        if (string.IsNullOrEmpty(credential.RefreshToken) || credential.RefreshToken.Length > 8_192)
        {
            throw new ArgumentException("The Google refresh credential is invalid.", nameof(credential));
        }

        string? directory = Path.GetDirectoryName(_path);
        if (string.IsNullOrEmpty(directory))
        {
            throw new InvalidOperationException("Could not save the Google credential.");
        }
        string temporaryPath = $"{_path}.{Guid.NewGuid():N}.tmp";
        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(new CredentialPayload(
            credential.RefreshToken,
            credential.AccessTokenExpiresAt
        ));
        try
        {
            Directory.CreateDirectory(directory);
            byte[] ciphertext = _protector.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
            try
            {
                using FileStream output = new(
                    temporaryPath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    4_096,
                    FileOptions.WriteThrough
                );
                output.Write(ciphertext);
                output.Flush(flushToDisk: true);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(ciphertext);
            }
            File.Move(temporaryPath, _path, overwrite: true);
        }
        catch
        {
            TryDelete(temporaryPath);
            throw new InvalidOperationException("Could not save the Google credential.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    public void Delete() => TryDelete(_path);

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            throw new InvalidOperationException("Could not delete the Google credential.");
        }
    }

    private sealed record CredentialPayload(string RefreshToken, DateTimeOffset AccessTokenExpiresAt);
}

internal sealed class MemoryGoogleTokenVault : IGoogleTokenVault
{
    private readonly object _gate = new();
    private GoogleRefreshCredential? _credential;

    public GoogleRefreshCredential? Load()
    {
        lock (_gate)
        {
            return _credential;
        }
    }

    public void Save(GoogleRefreshCredential credential)
    {
        ArgumentNullException.ThrowIfNull(credential);
        lock (_gate)
        {
            _credential = credential;
        }
    }

    public void Delete()
    {
        lock (_gate)
        {
            _credential = null;
        }
    }
}

internal sealed class CurrentUserDpapiTokenProtector : ITokenProtector
{
    public byte[] Protect(byte[] plaintext, byte[] entropy, DataProtectionScope scope) =>
        ProtectedData.Protect(plaintext, entropy, scope);

    public byte[] Unprotect(byte[] ciphertext, byte[] entropy, DataProtectionScope scope) =>
        ProtectedData.Unprotect(ciphertext, entropy, scope);
}

internal sealed record GoogleRefreshCredential(string RefreshToken, DateTimeOffset AccessTokenExpiresAt)
{
    public override string ToString() =>
        $"GoogleRefreshCredential {{ RefreshToken = [redacted], AccessTokenExpiresAt = {AccessTokenExpiresAt:O} }}";
}
