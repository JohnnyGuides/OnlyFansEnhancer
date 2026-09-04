using OFEnhancer.Catalogue;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace OFEnhancer.Desktop;

public interface IGoogleCatalogueController : IDisposable
{
    GoogleCatalogueStatusView getGoogleCatalogueStatus();
    GoogleCatalogueStatusView saveGoogleClientId(string clientId);
    GoogleCatalogueStatusView startGoogleCatalogueConnection();
    GoogleCatalogueStatusView cancelGoogleCatalogueConnection();
    GoogleCatalogueStatusView inspectGoogleWorkbook();
    GoogleCatalogueStatusView applyGoogleWorkbookMigration(string planHash);
    GoogleCatalogueStatusView syncGoogleCatalogue();
    GoogleCatalogueStatusView disconnectGoogleCatalogue();
}

internal interface IGoogleConnectionSession : IDisposable
{
    GoogleConnectionSnapshot Snapshot { get; }
    void Start();
    void Cancel();
}

internal interface IGoogleCatalogueSession : IDisposable
{
    Task<WorkbookInspection> InspectAsync(CancellationToken cancellationToken);
    Task<WorkbookMigrationResult> ApplyMigrationAsync(
        string planHash,
        CancellationToken cancellationToken
    );
    Task<GoogleSyncSummary> SyncAsync(string sheetId, CancellationToken cancellationToken);
}

internal sealed class GoogleCatalogueController : IGoogleCatalogueController
{
    private const string CatalogueProfile = "catalogue-v1";
    private readonly object _gate = new();
    private readonly DesktopSettingsStore _settings;
    private readonly CatalogueStore _store;
    private readonly IGoogleTokenVault _tokenVault;
    private readonly Func<
        string,
        Action<GoogleConnectionCompletion>,
        IGoogleConnectionSession
    > _connectionFactory;
    private readonly Func<
        string,
        GoogleConnectionCompletion,
        IGoogleCatalogueSession
    > _sessionFactory;
    private readonly CancellationTokenSource _lifetime = new();
    private IGoogleConnectionSession? _connection;
    private IGoogleCatalogueSession? _session;
    private GoogleConnectionCompletion? _completion;
    private GoogleCatalogueSelection? _selection;
    private WorkbookInspection? _inspection;
    private string? _connectionErrorCode;
    private string? _syncIssueCode;
    private bool _ready;
    private bool _syncing;
    private bool _disposed;
    private int _catalogueOperationActive;
    private long _connectionEpoch;

    internal GoogleCatalogueController(
        DesktopSettingsStore settings,
        CatalogueStore store,
        IGoogleTokenVault tokenVault,
        Func<string, Action<GoogleConnectionCompletion>, IGoogleConnectionSession> connectionFactory,
        Func<string, GoogleConnectionCompletion, IGoogleCatalogueSession> sessionFactory
    )
    {
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _tokenVault = tokenVault ?? throw new ArgumentNullException(nameof(tokenVault));
        _connectionFactory = connectionFactory
            ?? throw new ArgumentNullException(nameof(connectionFactory));
        _sessionFactory = sessionFactory ?? throw new ArgumentNullException(nameof(sessionFactory));
        RestorePersistedSession();
    }

    internal GoogleCatalogueController(
        DesktopSettingsStore settings,
        CatalogueStore store,
        IGoogleTokenVault tokenVault,
        HttpClient httpClient,
        Action<Uri> openBrowser
    )
        : this(
            settings,
            store,
            tokenVault,
            (clientId, completed) => new GoogleConnectionCoordinator(
                clientId,
                httpClient,
                tokenVault,
                static () => new HttpListenerGoogleOAuthCallbackReceiver(),
                openBrowser,
                completed
            ),
            (clientId, completion) =>
            {
                GoogleRefreshAccessTokenSource tokens = new(clientId, httpClient, tokenVault);
                GoogleWorkspaceClient workspace = new(httpClient, tokens);
                return new GoogleCatalogueSession(completion.WorkbookId, workspace, store, tokens);
            }
        )
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(openBrowser);
    }

    public GoogleCatalogueStatusView getGoogleCatalogueStatus()
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            return StatusLocked();
        }
    }

    public GoogleCatalogueStatusView saveGoogleClientId(string clientId)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            DesktopSettings current = _settings.Load();
            try
            {
                _settings.Save(current with { GoogleOAuthClientId = clientId });
            }
            catch (DesktopSettingsException exception)
            {
                throw new GoogleCatalogueControllerException(exception.Code);
            }
            return StatusLocked();
        }
    }

    public GoogleCatalogueStatusView startGoogleCatalogueConnection()
    {
        string clientId;
        IGoogleConnectionSession connection;
        IGoogleConnectionSession? previousConnection;
        IGoogleCatalogueSession? previousSession;
        long epoch;
        lock (_gate)
        {
            ThrowIfDisposed();
            clientId = _settings.Load().GoogleOAuthClientId
                ?? throw new GoogleCatalogueControllerException("google-client-id-not-configured");
            if (Volatile.Read(ref _catalogueOperationActive) != 0)
                throw new GoogleCatalogueControllerException("google-operation-in-progress");
            if (_connection?.Snapshot.State == GoogleConnectionState.Connecting)
                throw new GoogleCatalogueControllerException("google-connection-in-progress");
            epoch = ++_connectionEpoch;
            previousConnection = _connection;
            previousSession = _session;
            _connection = null;
            _session = null;
            _completion = null;
            _selection = null;
            _inspection = null;
            _ready = false;
            _syncIssueCode = null;
            _connectionErrorCode = null;
            connection = _connectionFactory(
                clientId,
                completion => CompleteConnection(epoch, clientId, completion)
            );
            _connection = connection;
        }

        previousConnection?.Cancel();
        previousConnection?.Dispose();
        previousSession?.Dispose();

        try
        {
            connection.Start();
        }
        catch
        {
            lock (_gate)
            {
                if (ReferenceEquals(_connection, connection))
                {
                    _connection = null;
                    _connectionEpoch++;
                    connection.Dispose();
                }
            }
            throw new GoogleCatalogueControllerException("google-connection-failed");
        }
        return getGoogleCatalogueStatus();
    }

    public GoogleCatalogueStatusView cancelGoogleCatalogueConnection()
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            _connectionEpoch++;
            _connection?.Cancel();
            try
            {
                _tokenVault.Delete();
            }
            catch
            {
                throw new GoogleCatalogueControllerException("google-connection-cancel-failed");
            }
            _connectionErrorCode = null;
            return StatusLocked();
        }
    }

    public GoogleCatalogueStatusView inspectGoogleWorkbook()
    {
        IGoogleCatalogueSession session;
        lock (_gate)
        {
            ThrowIfDisposed();
            session = _session
                ?? throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
            EnterCatalogueOperationLocked();
        }
        try
        {
            WorkbookInspection inspection = session
                .InspectAsync(_lifetime.Token)
                .GetAwaiter()
                .GetResult();
            lock (_gate)
            {
                ThrowIfDisposed();
                DateTimeOffset inspectedUtc = DateTimeOffset.UtcNow;
                bool ready = inspection.AlreadyMigrated && inspection.Conflicts.Count == 0;
                if (ready)
                {
                    _store.ImportWorkbookProjection(inspection.Projection);
                    GoogleRowBinding[] verifiedBindings = inspection.Bindings
                        .Select(binding => binding with { VerifiedUtc = inspectedUtc })
                        .ToArray();
                    _store.ReplaceGoogleBindings(inspection.Projection.WorkbookId, verifiedBindings);
                    inspection = inspection with { Bindings = verifiedBindings };
                }
                if (inspection.Conflicts.Count == 0)
                {
                    _store.SaveGoogleCatalogueProfile(
                        inspection.Projection.WorkbookId,
                        inspection.Projection.SheetId,
                        inspection.CatalogueSheetTitle,
                        CatalogueProfile,
                        ready,
                        inspectedUtc
                    );
                    _selection = _store.GetGoogleCatalogueSelection();
                }
                _inspection = inspection;
                _ready = ready;
                _syncIssueCode = null;
                return StatusLocked();
            }
        }
        catch (Exception exception)
        {
            throw SafeException(exception);
        }
        finally
        {
            ExitCatalogueOperation();
        }
    }

    public GoogleCatalogueStatusView applyGoogleWorkbookMigration(string planHash)
    {
        IGoogleCatalogueSession session;
        lock (_gate)
        {
            ThrowIfDisposed();
            session = _session
                ?? throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
            if (_inspection is null
                || !string.Equals(_inspection.PlanHash, planHash, StringComparison.Ordinal))
            {
                throw new GoogleCatalogueControllerException("stale-migration-plan");
            }
            EnterCatalogueOperationLocked();
        }

        try
        {
            WorkbookMigrationResult result = session
                .ApplyMigrationAsync(planHash, _lifetime.Token)
                .GetAwaiter()
                .GetResult();
            if (string.Equals(result.Status, "unresolved", StringComparison.Ordinal))
                throw new GoogleCatalogueControllerException("google-migration-unresolved");
            if (result.Status is not ("applied" or "reconciled" or "already-migrated"))
                throw new GoogleCatalogueControllerException("google-migration-failed");
            lock (_gate)
            {
                ThrowIfDisposed();
                _inspection = result.Inspection ?? _inspection;
                _ready = true;
                WorkbookInspection readyInspection = _inspection
                    ?? throw new GoogleCatalogueControllerException("google-migration-failed");
                _store.SaveGoogleCatalogueProfile(
                    readyInspection.Projection.WorkbookId,
                    readyInspection.Projection.SheetId,
                    readyInspection.CatalogueSheetTitle,
                    CatalogueProfile,
                    ready: true,
                    DateTimeOffset.UtcNow
                );
                _selection = _store.GetGoogleCatalogueSelection();
                _syncIssueCode = null;
                return StatusLocked();
            }
        }
        catch (Exception exception)
        {
            throw SafeException(exception);
        }
        finally
        {
            ExitCatalogueOperation();
        }
    }

    public GoogleCatalogueStatusView syncGoogleCatalogue()
    {
        IGoogleCatalogueSession session;
        string workbookId;
        string sheetId;
        lock (_gate)
        {
            ThrowIfDisposed();
            session = _session
                ?? throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
            if (!_ready)
                throw new GoogleCatalogueControllerException("google-workbook-not-ready");
            if (_selection?.SheetId is null)
                throw new GoogleCatalogueControllerException("google-workbook-not-ready");
            workbookId = _selection.WorkbookId;
            sheetId = _selection.SheetId;
            EnterCatalogueOperationLocked();
        }

        lock (_gate)
            _syncing = true;
        try
        {
            GoogleSyncSummary summary = session
                .SyncAsync(sheetId, _lifetime.Token)
                .GetAwaiter()
                .GetResult();
            lock (_gate)
            {
                ThrowIfDisposed();
                if (summary.Conflicts == 0 && summary.Unresolved == 0 && summary.Pending == 0)
                {
                    _store.MarkGoogleCatalogueSync(
                        workbookId,
                        sheetId,
                        DateTimeOffset.UtcNow
                    );
                    _selection = _store.GetGoogleCatalogueSelection();
                }
                _syncIssueCode = summary.Conflicts > 0
                    ? "google-sync-conflict"
                    : summary.Unresolved > 0
                        ? "google-sync-unresolved"
                        : null;
                _syncing = false;
                return StatusLocked();
            }
        }
        catch (Exception exception)
        {
            throw SafeException(exception);
        }
        finally
        {
            lock (_gate)
                _syncing = false;
            ExitCatalogueOperation();
        }
    }

    public GoogleCatalogueStatusView disconnectGoogleCatalogue()
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            if (Volatile.Read(ref _catalogueOperationActive) != 0)
                throw new GoogleCatalogueControllerException("google-operation-in-progress");
            _connectionEpoch++;
            try
            {
                _connection?.Cancel();
                _tokenVault.Delete();
                _store.ClearGoogleCatalogueSelection();
            }
            catch
            {
                throw new GoogleCatalogueControllerException("google-disconnect-failed");
            }
            _connection?.Dispose();
            _session?.Dispose();
            _connection = null;
            _session = null;
            _completion = null;
            _selection = null;
            _inspection = null;
            _connectionErrorCode = null;
            _syncIssueCode = null;
            _ready = false;
            return StatusLocked();
        }
    }

    public void Dispose()
    {
        IGoogleConnectionSession? connection;
        IGoogleCatalogueSession? session;
        lock (_gate)
        {
            if (_disposed)
                return;
            _disposed = true;
            _connectionEpoch++;
            _lifetime.Cancel();
            connection = _connection;
            session = _session;
            _connection = null;
            _session = null;
        }
        connection?.Cancel();
        connection?.Dispose();
        session?.Dispose();
        _lifetime.Dispose();
    }

    private void CompleteConnection(
        long epoch,
        string clientId,
        GoogleConnectionCompletion completion
    )
    {
        lock (_gate)
        {
            if (_disposed || epoch != _connectionEpoch)
            {
                DeleteStaleCredential();
                return;
            }
        }

        IGoogleCatalogueSession? session = null;
        try
        {
            session = _sessionFactory(clientId, completion);
            lock (_gate)
            {
                if (_disposed || epoch != _connectionEpoch)
                {
                    DeleteStaleCredential();
                    return;
                }
                _store.SaveGoogleCatalogueWorkbook(completion.WorkbookId, completion.WorkbookTitle);
                _session?.Dispose();
                _session = session;
                session = null;
                _completion = completion;
                _selection = _store.GetGoogleCatalogueSelection();
                _inspection = null;
                _ready = false;
                _syncIssueCode = null;
                _connectionErrorCode = null;
            }
        }
        catch
        {
            lock (_gate)
            {
                if (!_disposed && epoch == _connectionEpoch)
                {
                    DeleteStaleCredential();
                    try
                    {
                        _store.ClearGoogleCatalogueSelection();
                    }
                    catch
                    {
                        // The safe status remains disconnected/error even if local cleanup needs retrying.
                    }
                    _selection = null;
                    _connectionErrorCode = "google-session-failed";
                }
            }
        }
        finally
        {
            session?.Dispose();
        }
    }

    private GoogleCatalogueStatusView StatusLocked()
    {
        DesktopSettings settings = _settings.Load();
        if (settings.GoogleOAuthClientId is null)
            return new("notConfigured");
        GoogleConnectionSnapshot? connection = _connection?.Snapshot;
        if (_connectionErrorCode is not null)
            return View("error", errorCode: _connectionErrorCode);
        if (connection?.State == GoogleConnectionState.Connecting)
            return View("connecting");
        if (connection?.State == GoogleConnectionState.Error)
            return View("error", errorCode: SafeCode(connection.ErrorCode));
        if (_session is null || _completion is null)
            return new("disconnected");
        if (_inspection is null && !_ready)
            return View("needsInspection");
        if (_inspection?.Conflicts.Count > 0)
            return View("conflict", errorCode: SafeCode(_inspection.Conflicts[0].Code));
        if (_syncIssueCode is not null)
            return View("conflict", errorCode: _syncIssueCode);
        if (_syncing)
            return View("syncing");
        return View(_ready ? "ready" : "migrationReady");
    }

    private GoogleCatalogueStatusView View(string state, string? errorCode = null)
    {
        SyncOutboxCounts counts = _selection?.SheetId is null
            ? new(0, 0, 0, 0)
            : _store.GetSyncOperationCounts(_selection.WorkbookId, _selection.SheetId);
        bool exposePlan = string.Equals(state, "migrationReady", StringComparison.Ordinal);
        return new(
            state,
            _selection?.WorkbookTitle ?? _completion?.WorkbookTitle,
            _inspection?.CatalogueSheetTitle ?? _selection?.SheetTitle,
            exposePlan ? _inspection?.PlanHash : null,
            RowsToBind(),
            _inspection?.MigrationPlan.Operations.Count ?? 0,
            counts.Pending,
            counts.Conflicts,
            _selection?.LastSuccessfulSyncUtc,
            errorCode
        );
    }

    private int RowsToBind() => _inspection?.MigrationPlan.Operations
        .Where(operation => operation.Kind is "add-metadata" or "set-stable-id")
        .Select(operation => operation.RowNumber)
        .Where(row => row.HasValue)
        .Distinct()
        .Count() ?? 0;

    private void EnterCatalogueOperationLocked()
    {
        if (Interlocked.CompareExchange(ref _catalogueOperationActive, 1, 0) != 0)
            throw new GoogleCatalogueControllerException("google-operation-in-progress");
    }

    private void ExitCatalogueOperation() => Volatile.Write(ref _catalogueOperationActive, 0);

    private void ThrowIfDisposed()
    {
        if (_disposed)
            throw new GoogleCatalogueControllerException("google-catalogue-unavailable");
    }

    private void DeleteStaleCredential()
    {
        try
        {
            _tokenVault.Delete();
        }
        catch
        {
            // A stale completion must never become visible; disconnect can be retried explicitly.
        }
    }

    private void RestorePersistedSession()
    {
        try
        {
            string? clientId = _settings.Load().GoogleOAuthClientId;
            GoogleRefreshCredential? credential = _tokenVault.Load();
            GoogleCatalogueSelection? selection = _store.GetGoogleCatalogueSelection();
            if (clientId is null || credential is null || selection is null)
                return;
            if (selection.SheetId is not null
                && !string.Equals(selection.Profile, CatalogueProfile, StringComparison.Ordinal))
            {
                return;
            }
            GoogleConnectionCompletion completion = new(
                selection.WorkbookId,
                selection.WorkbookTitle,
                credential.AccessTokenExpiresAt
            );
            _session = _sessionFactory(clientId, completion);
            _completion = completion;
            _selection = selection;
            _ready = selection.Ready
                && selection.SheetId is not null
                && selection.SheetTitle is not null
                && string.Equals(selection.Profile, CatalogueProfile, StringComparison.Ordinal);
        }
        catch
        {
            _session?.Dispose();
            _session = null;
            _completion = null;
            _selection = null;
            _ready = false;
        }
    }

    private static GoogleCatalogueControllerException SafeException(Exception exception) =>
        exception switch
        {
            GoogleCatalogueControllerException safe => safe,
            GoogleCatalogueException google => new(SafeCode(google.Code)),
            OperationCanceledException => new("google-operation-cancelled"),
            _ => new("google-catalogue-failed"),
        };

    private static string SafeCode(string? code)
    {
        string candidate = code?.Replace('_', '-') ?? string.Empty;
        return candidate.Length is > 0 and <= 64
            && candidate.All(character =>
                character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'
            )
            ? candidate
            : "google-catalogue-failed";
    }
}

public sealed record GoogleCatalogueStatusView(
    string State,
    string? WorkbookName = null,
    string? SheetName = null,
    string? PlanHash = null,
    int RowsToBind = 0,
    int MigrationChanges = 0,
    int PendingCount = 0,
    int ConflictCount = 0,
    DateTimeOffset? LastVerifiedSync = null,
    string? ErrorCode = null
);

internal sealed class GoogleCatalogueControllerException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

internal sealed class GoogleCatalogueSession : IGoogleCatalogueSession
{
    private readonly string _workbookId;
    private readonly GoogleWorkspaceClient _workspace;
    private readonly CatalogueStore _store;
    private readonly GoogleWorkbookMigrator _migrator;
    private readonly GoogleCatalogueSyncWorker _syncWorker;
    private readonly IDisposable? _authorization;

    internal GoogleCatalogueSession(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store,
        IDisposable? authorization = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workbookId);
        _workbookId = workbookId;
        _workspace = workspace ?? throw new ArgumentNullException(nameof(workspace));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _authorization = authorization;
        _migrator = new(workbookId, workspace, store);
        _syncWorker = new(workspace, store);
    }

    public async Task<WorkbookInspection> InspectAsync(CancellationToken cancellationToken)
    {
        GoogleWorkbookSnapshot snapshot = await _workspace
            .ReadWorkbookAsync(_workbookId, cancellationToken)
            .ConfigureAwait(false);
        return GoogleWorkbookProfile.Inspect(snapshot, _store);
    }

    public Task<WorkbookMigrationResult> ApplyMigrationAsync(
        string planHash,
        CancellationToken cancellationToken
    ) => _migrator.ApplyAsync(planHash, cancellationToken);

    public Task<GoogleSyncSummary> SyncAsync(string sheetId, CancellationToken cancellationToken) =>
        _syncWorker.RunOnceAsync(_workbookId, sheetId, cancellationToken);

    public void Dispose() => _authorization?.Dispose();
}

internal sealed class GoogleRefreshAccessTokenSource : IGoogleAccessTokenSource, IDisposable
{
    private const int MaximumTokenResponseBytes = 64 * 1024;
    private static readonly Uri TokenEndpoint = new("https://oauth2.googleapis.com/token");
    private readonly string _clientId;
    private readonly HttpClient _httpClient;
    private readonly IGoogleTokenVault _vault;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private string? _accessToken;
    private DateTimeOffset _expiresAt;
    private int _disposed;

    internal GoogleRefreshAccessTokenSource(
        string clientId,
        HttpClient httpClient,
        IGoogleTokenVault vault
    )
    {
        if (!AppConfiguration.IsValidGoogleOAuthClientId(clientId))
            throw new ArgumentException("Google OAuth client ID is invalid.", nameof(clientId));
        _clientId = clientId;
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _vault = vault ?? throw new ArgumentNullException(nameof(vault));
    }

    public async ValueTask<string> GetAccessTokenAsync(
        bool forceRefresh,
        CancellationToken cancellationToken
    )
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!forceRefresh
                && _accessToken is not null
                && _expiresAt > DateTimeOffset.UtcNow.AddMinutes(1))
            {
                return _accessToken;
            }

            GoogleRefreshCredential credential = _vault.Load()
                ?? throw new GoogleCatalogueException("google-authorization-required");
            using FormUrlEncodedContent content = new(new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = credential.RefreshToken,
                ["client_id"] = _clientId,
            });
            using HttpRequestMessage request = new(HttpMethod.Post, TokenEndpoint)
            {
                Content = content,
            };
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            using HttpResponseMessage response = await _httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken
            ).ConfigureAwait(false);
            byte[] body = await GoogleOAuthProtocol.ReadBoundedAsync(
                response.Content,
                MaximumTokenResponseBytes,
                cancellationToken
            ).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode
                || !string.Equals(
                    response.RequestMessage?.RequestUri?.GetLeftPart(UriPartial.Authority),
                    TokenEndpoint.GetLeftPart(UriPartial.Authority),
                    StringComparison.Ordinal
                ))
            {
                throw new GoogleCatalogueException("google-token-refresh-failed");
            }

            try
            {
                using JsonDocument json = JsonDocument.Parse(body, new() { MaxDepth = 8 });
                JsonElement root = json.RootElement;
                string? accessToken = root.TryGetProperty("access_token", out JsonElement token)
                    && token.ValueKind == JsonValueKind.String
                    ? token.GetString()
                    : null;
                int expiresIn = root.TryGetProperty("expires_in", out JsonElement expiry)
                    && expiry.TryGetInt32(out int seconds)
                    ? seconds
                    : 0;
                if (string.IsNullOrWhiteSpace(accessToken)
                    || accessToken.Length > 8_192
                    || expiresIn is <= 0 or > 86_400)
                {
                    throw new GoogleCatalogueException("google-token-refresh-failed");
                }
                _accessToken = accessToken;
                _expiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
                return accessToken;
            }
            catch (GoogleCatalogueException)
            {
                throw;
            }
            catch
            {
                throw new GoogleCatalogueException("google-token-refresh-failed");
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (GoogleCatalogueException)
        {
            throw;
        }
        catch
        {
            throw new GoogleCatalogueException("google-token-refresh-failed");
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
            _refreshGate.Dispose();
    }
}

internal static class GoogleHttpClientFactory
{
    internal static HttpClientHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
    };

    internal static HttpClient Create() => new(CreateHandler())
    {
        Timeout = TimeSpan.FromSeconds(30),
    };
}

internal static class GoogleBrowserLauncher
{
    internal static ProcessStartInfo CreateStartInfo(Uri authorizationUri)
    {
        ArgumentNullException.ThrowIfNull(authorizationUri);
        if (authorizationUri.Scheme != Uri.UriSchemeHttps)
            throw new ArgumentException("Google authorization URI must use HTTPS.", nameof(authorizationUri));
        return new(authorizationUri.AbsoluteUri) { UseShellExecute = true };
    }

    internal static void Open(Uri authorizationUri) =>
        Process.Start(CreateStartInfo(authorizationUri));
}
