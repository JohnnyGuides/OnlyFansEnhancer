using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal sealed class GoogleConnectionCoordinator : IGoogleConnectionSession
{
    private const int ConnectionInactive = 0;
    private const int ConnectionActive = 1;
    private const int ConnectionCancelled = 2;
    private const int ConnectionFinalizing = 3;
    private const int ConnectionFinished = 4;
    private const string SpreadsheetMimeType = "application/vnd.google-apps.spreadsheet";
    private static readonly TimeSpan ConnectionTimeout = TimeSpan.FromMinutes(5);
    private readonly object _gate = new();
    private readonly string _clientId;
    private readonly string? _clientSecret;
    private readonly HttpClient _httpClient;
    private readonly IGoogleTokenVault _tokenVault;
    private readonly Func<IGoogleOAuthCallbackReceiver> _receiverFactory;
    private readonly Action<Uri> _openBrowser;
    private readonly Action<GoogleConnectionCompletion> _completed;
    private CancellationTokenSource? _currentCancellation;
    private IGoogleOAuthCallbackReceiver? _currentReceiver;
    private Task? _currentTask;
    private int _connectionPhase = ConnectionInactive;
    private GoogleConnectionSnapshot _snapshot = new(GoogleConnectionState.Disconnected, null);

    internal GoogleConnectionCoordinator(
        string clientId,
        HttpClient httpClient,
        IGoogleTokenVault tokenVault,
        Func<IGoogleOAuthCallbackReceiver> receiverFactory,
        Action<Uri> openBrowser,
        Action<GoogleConnectionCompletion> completed,
        string? clientSecret = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(clientId);
        _clientId = clientId;
        _clientSecret = clientSecret;
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _tokenVault = tokenVault ?? throw new ArgumentNullException(nameof(tokenVault));
        _receiverFactory = receiverFactory ?? throw new ArgumentNullException(nameof(receiverFactory));
        _openBrowser = openBrowser ?? throw new ArgumentNullException(nameof(openBrowser));
        _completed = completed ?? throw new ArgumentNullException(nameof(completed));
    }

    internal GoogleConnectionSnapshot Snapshot
    {
        get
        {
            lock (_gate)
            {
                return _snapshot;
            }
        }
    }

    internal void Start()
    {
        lock (_gate)
        {
            if (_currentTask is not null)
            {
                throw new InvalidOperationException("A Google connection is already in progress.");
            }

            IGoogleOAuthCallbackReceiver receiver = _receiverFactory();
            GoogleOAuthStart start;
            try
            {
                start = GoogleOAuthProtocol.CreateStart(_clientId, receiver.RedirectUri);
            }
            catch
            {
                receiver.Dispose();
                throw;
            }

            CancellationTokenSource cancellation = new(ConnectionTimeout);
            _currentReceiver = receiver;
            _currentCancellation = cancellation;
            Volatile.Write(ref _connectionPhase, ConnectionActive);
            _snapshot = new(GoogleConnectionState.Connecting, null);
            _currentTask = Task.Run(() => RunAsync(start, receiver, cancellation));
        }
    }

    internal void Cancel()
    {
        lock (_gate)
        {
            if (_currentTask is null)
            {
                return;
            }
            if (Interlocked.CompareExchange(
                ref _connectionPhase,
                ConnectionCancelled,
                ConnectionActive
            ) != ConnectionActive)
            {
                return;
            }
            _snapshot = new(GoogleConnectionState.Disconnected, null);
            _currentCancellation!.Cancel();
            _currentReceiver!.Close();
        }
    }

    GoogleConnectionSnapshot IGoogleConnectionSession.Snapshot => Snapshot;

    void IGoogleConnectionSession.Start() => Start();

    void IGoogleConnectionSession.Cancel() => Cancel();

    void IDisposable.Dispose()
    {
        Cancel();
        Task? current;
        lock (_gate)
            current = _currentTask;
        try
        {
            current?.Wait(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // Cancellation already closed the loopback receiver; completion owns final cleanup.
        }
    }

    private async Task RunAsync(
        GoogleOAuthStart start,
        IGoogleOAuthCallbackReceiver receiver,
        CancellationTokenSource cancellation
    )
    {
        try
        {
            _openBrowser(start.AuthorizationUri);
            Uri callbackUri = await receiver.ReceiveAsync(cancellation.Token).ConfigureAwait(false);
            GoogleOAuthCallback callback = GoogleOAuthProtocol.ParseCallback(callbackUri, start.State);
            GoogleTokenSet tokens = await GoogleOAuthProtocol.ExchangeCodeAsync(
                _httpClient,
                _clientId,
                callback.AuthorizationCode,
                receiver.RedirectUri,
                start.CodeVerifier,
                cancellation.Token,
                _clientSecret
            ).ConfigureAwait(false);
            if (tokens.RefreshToken is null)
            {
                throw new GoogleOAuthException("missing_refresh_token");
            }

            GoogleWorkbookIdentity workbook = await ValidatePickedWorkbookAsync(
                callback.WorkbookId,
                tokens.AccessToken,
                cancellation.Token
            ).ConfigureAwait(false);
            GoogleRefreshCredential credential = new(tokens.RefreshToken, tokens.ExpiresAt, _clientId);
            if (Volatile.Read(ref _connectionPhase) != ConnectionActive
                || cancellation.IsCancellationRequested)
            {
                SetSnapshot(new(GoogleConnectionState.Disconnected, null));
                return;
            }
            if (Interlocked.CompareExchange(
                ref _connectionPhase,
                ConnectionFinalizing,
                ConnectionActive
            ) != ConnectionActive)
            {
                SetSnapshot(new(GoogleConnectionState.Disconnected, null));
                return;
            }
            _tokenVault.Save(credential);

            GoogleConnectionCompletion completion = new(workbook.Id, workbook.Title, credential.AccessTokenExpiresAt);
            SetSnapshot(new(GoogleConnectionState.NeedsInspection, null));
            _completed(completion);
            Volatile.Write(ref _connectionPhase, ConnectionFinished);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            SetSnapshot(new(GoogleConnectionState.Disconnected, null));
        }
        catch (Exception) when (cancellation.IsCancellationRequested)
        {
            SetSnapshot(new(GoogleConnectionState.Disconnected, null));
        }
        catch (GoogleOAuthException error)
        {
            SetSnapshot(new(GoogleConnectionState.Error, error.ErrorCode));
        }
        catch (BrowserLaunchException error)
        {
            SetSnapshot(new(GoogleConnectionState.Error, error.Code));
        }
        catch
        {
            SetSnapshot(new(GoogleConnectionState.Error, "connection_failed"));
        }
        finally
        {
            receiver.Dispose();
            cancellation.Dispose();
            lock (_gate)
            {
                if (ReferenceEquals(_currentReceiver, receiver))
                {
                    _currentReceiver = null;
                    _currentCancellation = null;
                    _currentTask = null;
                }
            }
        }
    }

    private async Task<GoogleWorkbookIdentity> ValidatePickedWorkbookAsync(
        string workbookId,
        string accessToken,
        CancellationToken cancellationToken
    )
    {
        const string fields = "id,name,mimeType,capabilities(canEdit)";
        Uri endpoint = new(
            $"https://www.googleapis.com/drive/v3/files/{Uri.EscapeDataString(workbookId)}?fields={Uri.EscapeDataString(fields)}"
        );
        using HttpRequestMessage request = new(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using HttpResponseMessage response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken
        ).ConfigureAwait(false);
        byte[] body = await GoogleOAuthProtocol.ReadBoundedAsync(response.Content, 64 * 1024, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode
            || response.RequestMessage?.RequestUri?.GetLeftPart(UriPartial.Authority) is string origin
                && !string.Equals(origin, endpoint.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal))
        {
            throw new GoogleOAuthException("picked_file_validation_failed");
        }

        try
        {
            using JsonDocument json = JsonDocument.Parse(body, new() { MaxDepth = 8 });
            JsonElement root = json.RootElement;
            string? id = ReadString(root, "id", 256);
            string? title = ReadString(root, "name", 512);
            string? mimeType = ReadString(root, "mimeType", 128);
            bool canEdit = root.TryGetProperty("capabilities", out JsonElement capabilities)
                && capabilities.ValueKind == JsonValueKind.Object
                && capabilities.TryGetProperty("canEdit", out JsonElement canEditElement)
                && canEditElement.ValueKind is JsonValueKind.True;
            if (!string.Equals(id, workbookId, StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(title)
                || !string.Equals(mimeType, SpreadsheetMimeType, StringComparison.Ordinal)
                || !canEdit)
            {
                throw new GoogleOAuthException("invalid_picked_file");
            }
            return new(id!, title!);
        }
        catch (GoogleOAuthException)
        {
            throw;
        }
        catch
        {
            throw new GoogleOAuthException("picked_file_validation_failed");
        }
    }

    private static string? ReadString(JsonElement root, string property, int maximumLength)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        string? text = value.GetString();
        return text is { Length: > 0 } && text.Length <= maximumLength ? text : null;
    }

    private void SetSnapshot(GoogleConnectionSnapshot snapshot)
    {
        lock (_gate)
        {
            _snapshot = snapshot;
        }
    }

    private sealed record GoogleWorkbookIdentity(string Id, string Title);
}

internal interface IGoogleOAuthCallbackReceiver : IDisposable
{
    Uri RedirectUri { get; }
    Task<Uri> ReceiveAsync(CancellationToken cancellationToken);
    void Close();
}

internal sealed class HttpListenerGoogleOAuthCallbackReceiver : IGoogleOAuthCallbackReceiver
{
    private const int FirstDynamicPort = 49_152;
    private const int LastDynamicPortExclusive = 65_536;
    private readonly HttpListener _listener;
    private int _closed;
    private int _received;

    internal HttpListenerGoogleOAuthCallbackReceiver()
    {
        for (int attempt = 0; attempt < 32; attempt++)
        {
            int port = RandomNumberGenerator.GetInt32(FirstDynamicPort, LastDynamicPortExclusive);
            HttpListener candidate = new();
            Uri redirectUri = new($"http://127.0.0.1:{port}/");
            candidate.Prefixes.Add(redirectUri.AbsoluteUri);
            try
            {
                candidate.Start();
                _listener = candidate;
                RedirectUri = redirectUri;
                return;
            }
            catch (HttpListenerException)
            {
                candidate.Close();
            }
        }
        throw new InvalidOperationException("Could not open a loopback OAuth receiver.");
    }

    public Uri RedirectUri { get; }

    public async Task<Uri> ReceiveAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _received, 1) != 0)
        {
            throw new InvalidOperationException("The OAuth receiver accepts one callback.");
        }

        using CancellationTokenRegistration registration = cancellationToken.Register(Close);
        HttpListenerContext context = await _listener.GetContextAsync().WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (context.Request.HttpMethod != "GET" || context.Request.Url is null || context.Request.Url.AbsolutePath != "/")
            {
                throw new GoogleOAuthException("invalid_callback");
            }

            byte[] page = Encoding.UTF8.GetBytes(
                "<!doctype html><meta charset=utf-8><title>OFEnhancer</title><p>You can return to OFEnhancer.</p>"
            );
            context.Response.StatusCode = (int)HttpStatusCode.OK;
            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.Headers[HttpResponseHeader.CacheControl] = "no-store";
            context.Response.ContentLength64 = page.Length;
            await context.Response.OutputStream.WriteAsync(page, cancellationToken).ConfigureAwait(false);
            return context.Request.Url;
        }
        finally
        {
            context.Response.Close();
            Close();
        }
    }

    public void Close()
    {
        if (Interlocked.Exchange(ref _closed, 1) == 0)
        {
            _listener.Close();
        }
    }

    public void Dispose() => Close();
}

internal enum GoogleConnectionState
{
    Disconnected,
    Connecting,
    NeedsInspection,
    Error
}

internal sealed record GoogleConnectionSnapshot(GoogleConnectionState State, string? ErrorCode)
{
    public override string ToString() => $"GoogleConnectionSnapshot {{ State = {State}, ErrorCode = {ErrorCode ?? "none"} }}";
}

internal sealed record GoogleConnectionCompletion(
    string WorkbookId,
    string WorkbookTitle,
    DateTimeOffset CredentialExpiry
)
{
    public override string ToString() =>
        $"GoogleConnectionCompletion {{ WorkbookId = {WorkbookId}, WorkbookTitle = {WorkbookTitle}, CredentialExpiry = {CredentialExpiry:O} }}";
}
