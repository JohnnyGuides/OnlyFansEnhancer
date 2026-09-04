using System.Net;
using System.Security.Cryptography;
using System.Text;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleOAuthProtocolTests
{
    private const string ClientId = "123456789-desktop.apps.googleusercontent.com";
    private static readonly Uri RedirectUri = new("http://127.0.0.1:53123/");

    [TestMethod]
    public void PickerAuthorizationUsesOnlyDriveFileAndPkce()
    {
        GoogleOAuthStart start = GoogleOAuthProtocol.CreateStart(ClientId, RedirectUri);
        Dictionary<string, string> query = ParseQuery(start.AuthorizationUri);

        Assert.AreEqual("https://accounts.google.com/o/oauth2/v2/auth", start.AuthorizationUri.GetLeftPart(UriPartial.Path));
        Assert.AreEqual(ClientId, query["client_id"]);
        Assert.AreEqual(RedirectUri.AbsoluteUri, query["redirect_uri"]);
        Assert.AreEqual("code", query["response_type"]);
        Assert.AreEqual("https://www.googleapis.com/auth/drive.file", query["scope"]);
        Assert.AreEqual("offline", query["access_type"]);
        Assert.AreEqual("consent", query["prompt"]);
        Assert.AreEqual("true", query["trigger_onepick"]);
        Assert.AreEqual("application/vnd.google-apps.spreadsheet", query["mimetypes"]);
        Assert.AreEqual(start.State, query["state"]);
        Assert.AreEqual("S256", query["code_challenge_method"]);
        Assert.AreEqual(Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(start.CodeVerifier))), query["code_challenge"]);
        Assert.IsFalse(query.ContainsKey("client_secret"));
        Assert.IsFalse(query.ContainsKey("allow_multiple"));
    }

    [TestMethod]
    public void AuthorizationStateAndVerifierAreFreshUrlSafeValues()
    {
        GoogleOAuthStart first = GoogleOAuthProtocol.CreateStart(ClientId, RedirectUri);
        GoogleOAuthStart second = GoogleOAuthProtocol.CreateStart(ClientId, RedirectUri);

        Assert.AreNotEqual(first.State, second.State);
        Assert.AreNotEqual(first.CodeVerifier, second.CodeVerifier);
        StringAssert.Matches(first.State, new("^[A-Za-z0-9_-]{43}$"));
        StringAssert.Matches(first.CodeVerifier, new("^[A-Za-z0-9_-]{43,128}$"));
    }

    [TestMethod]
    public void CallbackAcceptsOnePickedFileWithMatchingState()
    {
        GoogleOAuthCallback callback = GoogleOAuthProtocol.ParseCallback(
            new("http://127.0.0.1:53123/?state=expected&code=authorization-code&picked_file_ids=sheet-123"),
            "expected"
        );

        Assert.AreEqual("authorization-code", callback.AuthorizationCode);
        Assert.AreEqual("sheet-123", callback.WorkbookId);
    }

    [DataTestMethod]
    [DataRow("?state=changed&code=code&picked_file_ids=sheet-123")]
    [DataRow("?state=expected&code=code&picked_file_ids=sheet-1%2Csheet-2")]
    [DataRow("?state=expected&state=expected&code=code&picked_file_ids=sheet-123")]
    [DataRow("?state=expected&code=code&picked_file_ids=sheet-123&error=access_denied")]
    public void CallbackRejectsChangedStateMultipleIdsDuplicatesAndErrors(string query)
    {
        Assert.ThrowsException<GoogleOAuthException>(() =>
            GoogleOAuthProtocol.ParseCallback(new($"http://127.0.0.1:53123/{query}"), "expected")
        );
    }

    [TestMethod]
    public async Task CodeExchangeUsesExactEndpointWithoutClientSecretAndBoundsTokenJson()
    {
        RecordingHandler handler = new(
            """{"access_token":"access-value","refresh_token":"refresh-value","expires_in":3600,"token_type":"Bearer","scope":"https://www.googleapis.com/auth/drive.file"}"""
        );
        using HttpClient client = new(handler);

        GoogleTokenSet tokens = await GoogleOAuthProtocol.ExchangeCodeAsync(
            client,
            ClientId,
            "authorization-code",
            RedirectUri,
            "code-verifier",
            CancellationToken.None
        );

        Assert.AreEqual(new("https://oauth2.googleapis.com/token"), handler.RequestUri);
        Assert.AreEqual(HttpMethod.Post, handler.Method);
        Dictionary<string, string> form = ParseForm(handler.Body);
        Assert.AreEqual("authorization_code", form["grant_type"]);
        Assert.AreEqual("authorization-code", form["code"]);
        Assert.AreEqual(ClientId, form["client_id"]);
        Assert.AreEqual(RedirectUri.AbsoluteUri, form["redirect_uri"]);
        Assert.AreEqual("code-verifier", form["code_verifier"]);
        Assert.IsFalse(form.ContainsKey("client_secret"));
        Assert.AreEqual("access-value", tokens.AccessToken);
        Assert.AreEqual("refresh-value", tokens.RefreshToken);

        using HttpClient oversizedClient = new(new RecordingHandler(new string('x', 65_537)));
        await Assert.ThrowsExceptionAsync<GoogleOAuthException>(() =>
            GoogleOAuthProtocol.ExchangeCodeAsync(
                oversizedClient,
                ClientId,
                "authorization-code",
                RedirectUri,
                "code-verifier",
                CancellationToken.None
            )
        );
    }

    [TestMethod]
    public async Task CodeExchangeRejectsAResponseRedirectedAwayFromGoogleTokenOrigin()
    {
        using HttpClient client = new(new RedirectedResponseHandler());

        GoogleOAuthException error = await Assert.ThrowsExceptionAsync<GoogleOAuthException>(() =>
            GoogleOAuthProtocol.ExchangeCodeAsync(
                client,
                ClientId,
                "authorization-code",
                RedirectUri,
                "code-verifier",
                CancellationToken.None
            )
        );

        Assert.AreEqual("token_exchange_failed", error.ErrorCode);
    }

    [TestMethod]
    public void DiagnosticsNeverRevealCodesVerifiersOrTokens()
    {
        GoogleOAuthStart start = GoogleOAuthProtocol.CreateStart(ClientId, RedirectUri);
        GoogleOAuthCallback callback = new("authorization-code", "sheet-123");
        GoogleTokenSet tokens = new("access-value", "refresh-value", DateTimeOffset.Parse("2026-09-04T12:00:00Z"));

        string text = string.Join(" | ", start, callback, tokens);
        Assert.IsFalse(text.Contains(start.State, StringComparison.Ordinal));
        Assert.IsFalse(text.Contains(start.CodeVerifier, StringComparison.Ordinal));
        Assert.IsFalse(text.Contains("authorization-code", StringComparison.Ordinal));
        Assert.IsFalse(text.Contains("access-value", StringComparison.Ordinal));
        Assert.IsFalse(text.Contains("refresh-value", StringComparison.Ordinal));
    }

    private static Dictionary<string, string> ParseQuery(Uri uri) => ParseForm(uri.Query.TrimStart('?'));

    private static Dictionary<string, string> ParseForm(string value) => value
        .Split('&', StringSplitOptions.RemoveEmptyEntries)
        .Select(part => part.Split('=', 2))
        .ToDictionary(
            part => Uri.UnescapeDataString(part[0].Replace('+', ' ')),
            part => Uri.UnescapeDataString(part.ElementAtOrDefault(1)?.Replace('+', ' ') ?? string.Empty),
            StringComparer.Ordinal
        );

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value)
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

    private sealed class RecordingHandler(string responseBody) : HttpMessageHandler
    {
        public Uri? RequestUri { get; private set; }
        public HttpMethod? Method { get; private set; }
        public string Body { get; private set; } = string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestUri = request.RequestUri;
            Method = request.Method;
            Body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            return new(HttpStatusCode.OK)
            {
                RequestMessage = request,
                Content = new StringContent(responseBody, Encoding.UTF8, "application/json")
            };
        }
    }

    private sealed class RedirectedResponseHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                RequestMessage = new(HttpMethod.Post, "https://example.invalid/token"),
                Content = new StringContent(
                    """{"access_token":"access-value","refresh_token":"refresh-value","expires_in":3600}""",
                    Encoding.UTF8,
                    "application/json"
                )
            });
    }
}
