using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal sealed class GoogleDesktopClientStore(string path, ITokenProtector? protector = null)
{
    private const int MaximumBytes = 64 * 1024;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("OFEnhancer.GoogleDesktopClient.v1");
    private readonly string _path = Path.GetFullPath(path);
    private readonly ITokenProtector _protector = protector ?? new CurrentUserDpapiTokenProtector();

    internal static GoogleDesktopClientCredential ReadFile(string path)
    {
        byte[]? bytes = null;
        try
        {
            using FileStream input = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (input.Length is <= 0 or > MaximumBytes) throw Invalid();
            bytes = new byte[(int)input.Length];
            input.ReadExactly(bytes);
            return Parse(bytes);
        }
        catch { throw Invalid(); }
        finally { if (bytes is not null) CryptographicOperations.ZeroMemory(bytes); }
    }

    internal static GoogleDesktopClientCredential Parse(byte[] bytes)
    {
        try
        {
            if (bytes.Length is <= 0 or > MaximumBytes) throw Invalid();
            using JsonDocument json = JsonDocument.Parse(bytes, new() { MaxDepth = 8 });
            JsonElement root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || root.EnumerateObject().Count() != 1
                || !root.TryGetProperty("installed", out JsonElement installed)
                || installed.ValueKind != JsonValueKind.Object) throw Invalid();
            HashSet<string> properties = new(StringComparer.Ordinal);
            foreach (JsonProperty property in installed.EnumerateObject())
                if (!properties.Add(property.Name)) throw Invalid();
            string clientId = installed.GetProperty("client_id").GetString() ?? "";
            string secret = installed.GetProperty("client_secret").GetString() ?? "";
            if (clientId.Length > 256 || clientId != clientId.Trim()
                || !AppConfiguration.IsValidGoogleOAuthClientId(clientId)
                || string.IsNullOrWhiteSpace(secret) || secret.Length > 4096
                || secret.Any(char.IsControl)) throw Invalid();
            ValidateEndpoint(installed, "token_uri", "https://oauth2.googleapis.com/token");
            ValidateEndpoint(installed, "auth_uri", "https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth");
            ValidateEndpoint(installed, "auth_provider_x509_cert_url", "https://www.googleapis.com/oauth2/v1/certs");
            return new(clientId, secret);
        }
        catch { throw Invalid(); }
    }

    internal GoogleDesktopClientCredential? Load(string clientId)
    {
        if (!File.Exists(_path)) return null;
        byte[]? plaintext = null;
        try
        {
            using FileStream input = new(_path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (input.Length is <= 0 or > MaximumBytes) throw Invalid();
            byte[] ciphertext = new byte[(int)input.Length];
            input.ReadExactly(ciphertext);
            plaintext = _protector.Unprotect(ciphertext, Entropy, DataProtectionScope.CurrentUser);
            GoogleDesktopClientCredential credential = Parse(plaintext);
            return string.Equals(credential.ClientId, clientId, StringComparison.Ordinal) ? credential : null;
        }
        catch { throw new GoogleCatalogueControllerException("google-client-configuration-required"); }
        finally { if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext); }
    }

    internal void Save(GoogleDesktopClientCredential credential)
    {
        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(new
        {
            installed = new { client_id = credential.ClientId, client_secret = credential.ClientSecret }
        });
        string temporary = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Parse(plaintext);
            byte[] ciphertext = _protector.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                4096, FileOptions.WriteThrough))
            {
                output.Write(ciphertext);
                output.Flush(flushToDisk: true);
            }
            File.Move(temporary, _path, overwrite: true);
        }
        catch { throw new GoogleCatalogueControllerException("google-client-configuration-save-failed"); }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            try { File.Delete(temporary); } catch { }
        }
    }

    private static void ValidateEndpoint(JsonElement installed, string name, params string[] allowed)
    {
        if (installed.TryGetProperty(name, out JsonElement value)
            && (value.ValueKind != JsonValueKind.String || !allowed.Contains(value.GetString(), StringComparer.Ordinal)))
            throw Invalid();
    }

    private static GoogleCatalogueControllerException Invalid() => new("google-client-configuration-invalid");
}

internal sealed record GoogleDesktopClientCredential(string ClientId, string ClientSecret)
{
    public override string ToString() => "GoogleDesktopClientCredential { ClientId = [redacted], ClientSecret = [redacted] }";
}
