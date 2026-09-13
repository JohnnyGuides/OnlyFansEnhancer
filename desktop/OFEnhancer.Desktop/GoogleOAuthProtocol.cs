using System.Net.Http.Headers;
using System.Net.Http;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OFEnhancer.Desktop;

internal static partial class GoogleOAuthProtocol
{
    private const int MaximumCallbackQueryLength = 8 * 1024;
    private const int MaximumTokenResponseLength = 64 * 1024;
    private const string DriveFileScope = "https://www.googleapis.com/auth/drive.file";
    private static readonly Uri AuthorizationEndpoint = new("https://accounts.google.com/o/oauth2/v2/auth");
    private static readonly Uri TokenEndpoint = new("https://oauth2.googleapis.com/token");

    internal static GoogleOAuthStart CreateStart(string clientId, Uri redirectUri)
    {
        ValidateClient(clientId, redirectUri);
        string state = RandomBase64Url(32);
        string verifier = RandomBase64Url(64);
        string challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        Dictionary<string, string> values = new()
        {
            ["client_id"] = clientId,
            ["redirect_uri"] = redirectUri.AbsoluteUri,
            ["response_type"] = "code",
            ["scope"] = DriveFileScope,
            ["access_type"] = "offline",
            ["prompt"] = "consent",
            ["trigger_onepick"] = "true",
            ["mimetypes"] = "application/vnd.google-apps.spreadsheet",
            ["state"] = state,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256"
        };
        string query = string.Join("&", values.Select(pair =>
            $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"
        ));
        return new(new($"{AuthorizationEndpoint}?{query}"), state, verifier);
    }

    internal static GoogleOAuthCallback ParseCallback(Uri callbackUri, string expectedState)
    {
        ArgumentNullException.ThrowIfNull(callbackUri);
        ArgumentException.ThrowIfNullOrEmpty(expectedState);
        if (!callbackUri.IsAbsoluteUri || callbackUri.Query.Length > MaximumCallbackQueryLength)
        {
            throw new GoogleOAuthException("invalid_callback");
        }

        Dictionary<string, string> query = ParseStrictQuery(callbackUri.Query);
        if (query.ContainsKey("error"))
        {
            throw new GoogleOAuthException("authorization_denied");
        }

        if (!query.TryGetValue("state", out string? state) || !FixedTimeEquals(state, expectedState))
        {
            throw new GoogleOAuthException("state_mismatch");
        }

        if (!query.TryGetValue("code", out string? code) || string.IsNullOrWhiteSpace(code) || code.Length > 4_096)
        {
            throw new GoogleOAuthException("missing_code");
        }

        if (!query.TryGetValue("picked_file_ids", out string? workbookId)
            || !GoogleFileId().IsMatch(workbookId))
        {
            throw new GoogleOAuthException("invalid_picked_file");
        }

        return new(code, workbookId);
    }

    internal static async Task<GoogleTokenSet> ExchangeCodeAsync(
        HttpClient httpClient,
        string clientId,
        string authorizationCode,
        Uri redirectUri,
        string codeVerifier,
        CancellationToken cancellationToken,
        string? clientSecret = null
    )
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ValidateClient(clientId, redirectUri);
        if (string.IsNullOrWhiteSpace(authorizationCode) || authorizationCode.Length > 4_096
            || string.IsNullOrWhiteSpace(codeVerifier) || codeVerifier.Length > 128)
        {
            throw new GoogleOAuthException("invalid_token_request");
        }

        Dictionary<string, string> form = new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = authorizationCode,
            ["client_id"] = clientId,
            ["redirect_uri"] = redirectUri.AbsoluteUri,
            ["code_verifier"] = codeVerifier
        };
        if (clientSecret is not null) form["client_secret"] = clientSecret;
        using FormUrlEncodedContent content = new(form);
        using HttpRequestMessage request = new(HttpMethod.Post, TokenEndpoint) { Content = content };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        try
        {
            using HttpResponseMessage response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken
            ).ConfigureAwait(false);
            byte[] body = await ReadBoundedAsync(response.Content, MaximumTokenResponseLength, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode
                || !string.Equals(
                    response.RequestMessage?.RequestUri?.GetLeftPart(UriPartial.Authority),
                    TokenEndpoint.GetLeftPart(UriPartial.Authority),
                    StringComparison.Ordinal
                ))
            {
                throw new GoogleOAuthException("token_exchange_failed");
            }

            using JsonDocument json = JsonDocument.Parse(body, new() { MaxDepth = 8 });
            JsonElement root = json.RootElement;
            string accessToken = ReadBoundedString(root, "access_token", 8_192, required: true)!;
            string? refreshToken = ReadBoundedString(root, "refresh_token", 8_192, required: false);
            if (!root.TryGetProperty("expires_in", out JsonElement expiresElement)
                || !expiresElement.TryGetInt32(out int expiresIn)
                || expiresIn is <= 0 or > 86_400)
            {
                throw new GoogleOAuthException("invalid_token_response");
            }

            return new(accessToken, refreshToken, DateTimeOffset.UtcNow.AddSeconds(expiresIn));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (GoogleOAuthException)
        {
            throw;
        }
        catch
        {
            throw new GoogleOAuthException("invalid_token_response");
        }
    }

    internal static async Task<byte[]> ReadBoundedAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken
    )
    {
        if (content.Headers.ContentLength > maximumBytes)
        {
            throw new GoogleOAuthException("response_too_large");
        }

        await using Stream input = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using MemoryStream output = new(Math.Min(maximumBytes, 8_192));
        byte[] buffer = new byte[8_192];
        while (true)
        {
            int read = await input.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, maximumBytes + 1 - (int)output.Length)), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                return output.ToArray();
            }

            output.Write(buffer, 0, read);
            if (output.Length > maximumBytes)
            {
                throw new GoogleOAuthException("response_too_large");
            }
        }
    }

    private static Dictionary<string, string> ParseStrictQuery(string query)
    {
        Dictionary<string, string> values = new(StringComparer.Ordinal);
        foreach (string part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            string[] pair = part.Split('=', 2);
            string key = Decode(pair[0]);
            string value = Decode(pair.ElementAtOrDefault(1) ?? string.Empty);
            if (key.Length == 0 || value.Length > 4_096 || !values.TryAdd(key, value))
            {
                throw new GoogleOAuthException("invalid_callback");
            }
        }
        return values;
    }

    private static string Decode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static string? ReadBoundedString(JsonElement root, string property, int maximumLength, bool required)
    {
        if (!root.TryGetProperty(property, out JsonElement element) || element.ValueKind == JsonValueKind.Null)
        {
            if (required)
            {
                throw new GoogleOAuthException("invalid_token_response");
            }
            return null;
        }

        if (element.ValueKind != JsonValueKind.String)
        {
            throw new GoogleOAuthException("invalid_token_response");
        }
        string? value = element.GetString();
        if (string.IsNullOrEmpty(value) || value.Length > maximumLength)
        {
            throw new GoogleOAuthException("invalid_token_response");
        }
        return value;
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static void ValidateClient(string clientId, Uri redirectUri)
    {
        if (string.IsNullOrWhiteSpace(clientId) || clientId.Length > 256 || !InstalledClientId().IsMatch(clientId))
        {
            throw new ArgumentException("A valid Google desktop client ID is required.", nameof(clientId));
        }
        if (!redirectUri.IsAbsoluteUri
            || !string.Equals(redirectUri.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal)
            || !string.Equals(redirectUri.Host, "127.0.0.1", StringComparison.Ordinal)
            || redirectUri.IsDefaultPort
            || redirectUri.AbsolutePath != "/")
        {
            throw new ArgumentException("A loopback redirect URI is required.", nameof(redirectUri));
        }
    }

    private static string RandomBase64Url(int bytes)
    {
        byte[] value = RandomNumberGenerator.GetBytes(bytes);
        return Base64Url(value);
    }

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value)
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

    [GeneratedRegex("^[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com$", RegexOptions.CultureInvariant)]
    private static partial Regex InstalledClientId();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,256}$", RegexOptions.CultureInvariant)]
    private static partial Regex GoogleFileId();
}

internal sealed record GoogleOAuthStart(Uri AuthorizationUri, string State, string CodeVerifier)
{
    public override string ToString() => "GoogleOAuthStart { AuthorizationUri = [redacted], State = [redacted], CodeVerifier = [redacted] }";
}

internal sealed record GoogleOAuthCallback(string AuthorizationCode, string WorkbookId)
{
    public override string ToString() => $"GoogleOAuthCallback {{ AuthorizationCode = [redacted], WorkbookId = {WorkbookId} }}";
}

internal sealed record GoogleTokenSet(string AccessToken, string? RefreshToken, DateTimeOffset ExpiresAt)
{
    public override string ToString() => $"GoogleTokenSet {{ AccessToken = [redacted], RefreshToken = [redacted], ExpiresAt = {ExpiresAt:O} }}";
}

internal sealed class GoogleOAuthException(string errorCode) : Exception(errorCode)
{
    internal string ErrorCode { get; } = errorCode;
}
