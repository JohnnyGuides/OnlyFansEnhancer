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
    GoogleCatalogueStatusView saveGoogleSheetTarget(string sheetUrl);
    GoogleCatalogueStatusView startGoogleCatalogueConnection(string? sheetUrl = null);
    GoogleCatalogueStatusView cancelGoogleCatalogueConnection();
    GoogleCatalogueStatusView inspectGoogleWorkbook();
    GoogleCatalogueImportResult importGoogleCatalogue();
    GoogleCatalogueStatusView applyGoogleWorkbookMigration(string planHash);
    GoogleCatalogueStatusView syncGoogleCatalogue();
    GoogleCatalogueStatusView disconnectGoogleCatalogue();
}

internal interface IGoogleConnectionSession : IDisposable
{
    GoogleConnectionSnapshot Snapshot { get; }
    void Start(GoogleSheetReference? target = null);
    void Cancel();
}

internal interface IGoogleCatalogueSession : IDisposable
{
    Task<WorkbookInspection> InspectAsync(CancellationToken cancellationToken);
    Task<GoogleCatalogueImportPreview> ReadImportAsync(CancellationToken cancellationToken);
    Task<GoogleSubredditPresetSnapshot> ReadSubredditPresetsAsync(CancellationToken cancellationToken);
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
    private readonly object _credentialGate = new();
    private readonly DesktopSettingsStore _settings;
    private readonly CatalogueStore _store;
    private readonly IGoogleTokenVault _tokenVault;
    private readonly GoogleDesktopClientStore? _clientStore;
    private bool _importingClient;
    private readonly Func<
        string,
        IGoogleTokenVault,
        Action<GoogleConnectionCompletion>,
        IGoogleConnectionSession
    > _connectionFactory;
    private readonly Func<
        string,
        GoogleConnectionCompletion,
        IGoogleCatalogueSession
    > _sessionFactory;
    private readonly Func<Action, Task> _completionDispatcher;
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
        Func<string, IGoogleTokenVault, Action<GoogleConnectionCompletion>, IGoogleConnectionSession> connectionFactory,
        Func<string, GoogleConnectionCompletion, IGoogleCatalogueSession> sessionFactory,
        Func<Action, Task>? completionDispatcher = null,
        GoogleDesktopClientStore? clientStore = null
    )
    {
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _tokenVault = tokenVault ?? throw new ArgumentNullException(nameof(tokenVault));
        _clientStore = clientStore;
        _connectionFactory = connectionFactory
            ?? throw new ArgumentNullException(nameof(connectionFactory));
        _sessionFactory = sessionFactory ?? throw new ArgumentNullException(nameof(sessionFactory));
        _completionDispatcher = completionDispatcher ?? (action =>
        {
            action();
            return Task.CompletedTask;
        });
        RestorePersistedSession();
    }

    internal GoogleCatalogueController(
        DesktopSettingsStore settings,
        CatalogueStore store,
        IGoogleTokenVault tokenVault,
        HttpClient httpClient,
        Action<Uri> openBrowser,
        Func<Action, Task>? completionDispatcher = null,
        GoogleDesktopClientStore? clientStore = null
    )
        : this(
            settings,
            store,
            tokenVault,
            (clientId, connectionVault, completed) => new GoogleConnectionCoordinator(
                clientId,
                httpClient,
                connectionVault,
                static () => new HttpListenerGoogleOAuthCallbackReceiver(),
                openBrowser,
                completed,
                clientStore?.Load(clientId)?.ClientSecret
            ),
            (clientId, completion) =>
            {
                GoogleDesktopClientCredential? configuredClient = clientStore?.Load(clientId);
                GoogleRefreshAccessTokenSource tokens = new(clientId, httpClient, tokenVault,
                    configuredClient is null
                        ? null
                        : () => clientStore!.Load(clientId)?.ClientSecret
                            ?? throw new GoogleCatalogueException("google-client-configuration-required"));
                GoogleWorkspaceClient workspace = new(httpClient, tokens);
                return new GoogleCatalogueSession(
                    completion.WorkbookId,
                    workspace,
                    store,
                    tokens,
                    completion.PreferredSheetId
                );
            },
            completionDispatcher,
            clientStore
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
        IGoogleConnectionSession? previousConnection = null;
        IGoogleCatalogueSession? previousSession = null;
        GoogleCatalogueStatusView status;
        bool cleanupFailed = false;
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_importingClient)
                throw new GoogleCatalogueControllerException("google-operation-in-progress");
            DesktopSettings current = _settings.Load();
            try
            {
                _settings.Save(current with { GoogleOAuthClientId = clientId });
            }
            catch (DesktopSettingsException exception)
            {
                throw new GoogleCatalogueControllerException(exception.Code);
            }
            string? savedClientId = _settings.Load().GoogleOAuthClientId;
            if (string.Equals(current.GoogleOAuthClientId, savedClientId, StringComparison.Ordinal))
                return StatusLocked();
            previousConnection = _connection;
            previousSession = _session;
            try { InvalidateConnectionEpochLocked(deleteCredential: true); }
            catch { cleanupFailed = true; }
            try { previousConnection?.Cancel(); }
            catch { cleanupFailed = true; }
            try { _store.ClearGoogleCatalogueSelection(); }
            catch { cleanupFailed = true; }
            _connection = null;
            _session = null;
            _completion = null;
            _selection = null;
            _inspection = null;
            _connectionErrorCode = null;
            _syncIssueCode = null;
            _ready = false;
            status = StatusLocked();
        }
        try { previousConnection?.Dispose(); }
        catch { cleanupFailed = true; }
        try { previousSession?.Dispose(); }
        catch { cleanupFailed = true; }
        if (cleanupFailed)
            throw new GoogleCatalogueControllerException("google-client-id-change-failed");
        return status;
    }

    internal GoogleCatalogueStatusView ImportGoogleClientConfiguration(Func<string?> chooseFile)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            if (_clientStore is null)
                throw new GoogleCatalogueControllerException("google-client-configuration-required");
            if (_connection?.Snapshot.State == GoogleConnectionState.Connecting)
                throw new GoogleCatalogueControllerException("google-connection-in-progress");
            EnterCatalogueOperationLocked();
            _importingClient = true;
        }
        try
        {
            string? path = chooseFile();
            if (path is null) return getGoogleCatalogueStatus();
            GoogleDesktopClientCredential credential = GoogleDesktopClientStore.ReadFile(path);
            lock (_gate)
            {
                ThrowIfDisposed();
                DesktopSettings current = _settings.Load();
                if (current.GoogleOAuthClientId is not null
                    && !string.Equals(current.GoogleOAuthClientId, credential.ClientId, StringComparison.Ordinal))
                    throw new GoogleCatalogueControllerException("google-client-configuration-mismatch");
                _clientStore!.Save(credential);
                if (current.GoogleOAuthClientId is null)
                    _settings.Save(current with { GoogleOAuthClientId = credential.ClientId });
                _connectionErrorCode = null;
                if (_connection?.Snapshot.State == GoogleConnectionState.Error)
                {
                    _connection.Dispose();
                    _connection = null;
                }
                return StatusLocked();
            }
        }
        finally
        {
            lock (_gate)
            {
                _importingClient = false;
                ExitCatalogueOperation();
            }
        }
    }

    public GoogleCatalogueStatusView saveGoogleSheetTarget(string sheetUrl)
    {
        GoogleSheetReference target;
        try { target = GoogleSheetReference.Parse(sheetUrl); }
        catch (GoogleSheetReferenceException exception)
        { throw new GoogleCatalogueControllerException(exception.Code); }
        lock (_gate)
        {
            ThrowIfDisposed();
            DesktopSettings current = _settings.Load();
            _settings.Save(current with { GoogleSheetUrl = target.CanonicalUrl });
            return StatusLocked();
        }
    }

    public GoogleCatalogueStatusView startGoogleCatalogueConnection(string? sheetUrl = null)
    {
        if (!string.IsNullOrWhiteSpace(sheetUrl))
            saveGoogleSheetTarget(sheetUrl);
        sheetUrl ??= _settings.Load().GoogleSheetUrl;
        GoogleSheetReference? target = null;
        if (!string.IsNullOrWhiteSpace(sheetUrl))
        {
            try { target = GoogleSheetReference.Parse(sheetUrl); }
            catch (GoogleSheetReferenceException exception)
            {
                throw new GoogleCatalogueControllerException(exception.Code);
            }
        }
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
            if (_clientStore is not null && _clientStore.Load(clientId) is null)
                throw new GoogleCatalogueControllerException("google-client-configuration-required");
            if (_connection?.Snapshot.State == GoogleConnectionState.Connecting)
                throw new GoogleCatalogueControllerException("google-connection-in-progress");
            epoch = BeginConnectionEpochLocked();
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
                new EpochGoogleTokenVault(this, epoch),
                completion => QueueConnectionCompletion(epoch, clientId, completion)
            );
            _connection = connection;
        }

        previousConnection?.Cancel();
        previousConnection?.Dispose();
        previousSession?.Dispose();

        try
        {
            connection.Start(target);
        }
        catch
        {
            lock (_gate)
            {
                if (ReferenceEquals(_connection, connection))
                {
                    _connection = null;
                    InvalidateConnectionEpochLocked(deleteCredential: false);
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
            if (_connection?.Snapshot.State != GoogleConnectionState.Connecting)
                throw new GoogleCatalogueControllerException("google-connection-not-in-progress");
            try
            {
                InvalidateConnectionEpochLocked(deleteCredential: true);
                _connection.Cancel();
            }
            catch
            {
                throw new GoogleCatalogueControllerException("google-connection-cancel-failed");
            }
            _connectionErrorCode = null;
            return StatusLocked();
        }
    }

    internal GoogleSubredditPresetSnapshot ReadSubredditPresets()
    {
        IGoogleCatalogueSession session;
        lock(_gate)
        {
            ThrowIfDisposed();
            session=_session ?? throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
            EnterCatalogueOperationLocked();
        }
        try { return session.ReadSubredditPresetsAsync(_lifetime.Token).GetAwaiter().GetResult(); }
        catch(Exception exception) { throw SafeException(exception); }
        finally { ExitCatalogueOperation(); }
    }

    public GoogleCatalogueImportResult importGoogleCatalogue()
    {
        IGoogleCatalogueSession session;
        lock (_gate)
        {
            ThrowIfDisposed();
            session = _session ?? throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
            if (_ready) throw new GoogleCatalogueControllerException("google-import-sync-active");
            EnterCatalogueOperationLocked();
        }
        try
        {
            GoogleCatalogueImportPreview preview = session.ReadImportAsync(_lifetime.Token).GetAwaiter().GetResult();
            lock (_gate)
            {
                ThrowIfDisposed();
                if (!ReferenceEquals(session, _session))
                    throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
                _store.ImportWorkbookProjection(preview.Projection, updateGoogleBindings: false);
                return new(StatusLocked(), preview.CatalogueSheetTitle, preview.Projection.Items.Count, preview.Issues ?? []);
            }
        }
        catch (Exception exception) { throw SafeException(exception); }
        finally { ExitCatalogueOperation(); }
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
            // Persist the verification-in-progress state before reading new contrary evidence.
            // If persistence fails, do not inspect or perform any remote mutation.
            lock (_gate)
            {
                if (_selection is { Ready: true, SheetId: not null, SheetTitle: not null, Profile: not null })
                {
                    _ready = false;
                    _store.SaveGoogleCatalogueProfile(_selection.WorkbookId, _selection.SheetId,
                        _selection.SheetTitle, _selection.Profile, false, DateTimeOffset.UtcNow);
                    _selection = _store.GetGoogleCatalogueSelection();
                }
            }
            WorkbookInspection inspection = session
                .InspectAsync(_lifetime.Token)
                .GetAwaiter()
                .GetResult();
            lock (_gate)
            {
                ThrowIfDisposed();
                DateTimeOffset inspectedUtc = DateTimeOffset.UtcNow;
                bool ready = inspection.AlreadyMigrated && inspection.Conflicts.Count == 0;
                // Invalidate before persistence so a failed save cannot leave this process ready.
                _ready = false;
                if (inspection.Conflicts.Count > 0 && _selection is { SheetId: not null, SheetTitle: not null, Profile: not null })
                {
                    _store.SaveGoogleCatalogueProfile(_selection.WorkbookId, _selection.SheetId,
                        _selection.SheetTitle, _selection.Profile, false, inspectedUtc);
                    _selection = _store.GetGoogleCatalogueSelection();
                }
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
                if (summary.RemoteVerificationOccurred
                    && summary.Conflicts == 0
                    && summary.Unresolved == 0
                    && summary.Pending == 0)
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
            try
            {
                InvalidateConnectionEpochLocked(deleteCredential: true);
                _connection?.Cancel();
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
            InvalidateConnectionEpochLocked(deleteCredential: false);
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
            if (_disposed || !IsCurrentConnectionEpochLocked(epoch))
                return;
        }

        IGoogleCatalogueSession? session = null;
        try
        {
            session = _sessionFactory(clientId, completion);
            lock (_gate)
            {
                if (_disposed || !IsCurrentConnectionEpochLocked(epoch))
                    return;
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
                if (!_disposed && IsCurrentConnectionEpochLocked(epoch))
                {
                    DeleteCredentialIfCurrent(epoch);
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

    private void QueueConnectionCompletion(
        long epoch,
        string clientId,
        GoogleConnectionCompletion completion
    ) => _ = _completionDispatcher(() => CompleteConnection(epoch, clientId, completion));

    private GoogleCatalogueStatusView StatusLocked()
    {
        DesktopSettings settings = _settings.Load();
        if (settings.GoogleOAuthClientId is null)
            return new("notConfigured", PreferredSheetUrl: settings.GoogleSheetUrl);
        if (_clientStore is not null)
        {
            try
            {
                if (_clientStore.Load(settings.GoogleOAuthClientId) is null)
                    return View("error", errorCode: "google-client-configuration-required");
            }
            catch (GoogleCatalogueControllerException)
            {
                return View("error", errorCode: "google-client-configuration-required");
            }
        }
        GoogleConnectionSnapshot? connection = _connection?.Snapshot;
        if (_connectionErrorCode is not null)
            return View("error", errorCode: _connectionErrorCode);
        if (connection?.State == GoogleConnectionState.Connecting)
            return View("connecting");
        if (connection?.State == GoogleConnectionState.Error)
            return View("error", errorCode: SafeCode(connection.ErrorCode));
        if (_session is null || _completion is null)
            return new("disconnected", PreferredSheetUrl: settings.GoogleSheetUrl);
        SyncOutboxCounts counts = CurrentCountsLocked();
        if (_inspection is null && !_ready)
            return View("needsInspection", counts);
        if (_inspection?.Conflicts.Count > 0)
            return View("conflict", counts, SafeCode(_inspection.Conflicts[0].Code));
        if (_syncing)
            return View("syncing", counts);
        if (counts.Conflicts > 0)
            return View("conflict", counts, "google-sync-conflict");
        if (counts.Attempted > 0 || counts.Unresolved > 0)
            return View("conflict", counts, "google-sync-unresolved");
        if (_syncIssueCode is not null)
            return View("conflict", counts, _syncIssueCode);
        return View(_ready ? "ready" : "migrationReady", counts);
    }

    private SyncOutboxCounts CurrentCountsLocked() => _selection?.SheetId is null
        ? new(0, 0, 0, 0)
        : _store.GetSyncOperationCounts(_selection.WorkbookId, _selection.SheetId);

    private GoogleCatalogueStatusView View(
        string state,
        SyncOutboxCounts? counts = null,
        string? errorCode = null
    )
    {
        counts ??= CurrentCountsLocked();
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
            errorCode,
            counts.Attempted,
            counts.Unresolved,
            _settings.Load().GoogleSheetUrl
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

    private long BeginConnectionEpochLocked()
    {
        lock (_credentialGate)
        {
            return ++_connectionEpoch;
        }
    }

    private void InvalidateConnectionEpochLocked(bool deleteCredential)
    {
        lock (_credentialGate)
        {
            _connectionEpoch++;
            if (deleteCredential)
                _tokenVault.Delete();
        }
    }

    private bool IsCurrentConnectionEpochLocked(long epoch)
    {
        lock (_credentialGate)
        {
            return epoch == _connectionEpoch;
        }
    }

    private GoogleRefreshCredential? LoadCredential(long epoch)
    {
        lock (_credentialGate)
        {
            return epoch == _connectionEpoch ? _tokenVault.Load() : null;
        }
    }

    private void SaveCredential(long epoch, GoogleRefreshCredential credential)
    {
        lock (_credentialGate)
        {
            if (epoch == _connectionEpoch)
                _tokenVault.Save(credential);
        }
    }

    private void DeleteCredentialIfCurrent(long epoch)
    {
        lock (_credentialGate)
        {
            if (epoch == _connectionEpoch)
                _tokenVault.Delete();
        }
    }

    private sealed class EpochGoogleTokenVault(
        GoogleCatalogueController owner,
        long epoch
    ) : IGoogleTokenVault
    {
        public GoogleRefreshCredential? Load() => owner.LoadCredential(epoch);

        public void Save(GoogleRefreshCredential credential) => owner.SaveCredential(epoch, credential);

        public void Delete() => owner.DeleteCredentialIfCurrent(epoch);
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
            if (!string.Equals(credential.ClientId, clientId, StringComparison.Ordinal))
            {
                _tokenVault.Delete();
                return;
            }
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

public sealed record GoogleCatalogueImportResult(GoogleCatalogueStatusView Status, string SheetName, int ImportedItems,
    IReadOnlyList<GoogleCatalogueImportIssue>? Issues = null);

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
    string? ErrorCode = null,
    int AttemptedCount = 0,
    int UnresolvedCount = 0,
    string? PreferredSheetUrl = null
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
    private readonly int? _preferredSheetId;

    internal GoogleCatalogueSession(
        string workbookId,
        GoogleWorkspaceClient workspace,
        CatalogueStore store,
        IDisposable? authorization = null,
        int? preferredSheetId = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workbookId);
        _workbookId = workbookId;
        _workspace = workspace ?? throw new ArgumentNullException(nameof(workspace));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _authorization = authorization;
        _preferredSheetId = preferredSheetId;
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

    public async Task<GoogleCatalogueImportPreview> ReadImportAsync(CancellationToken cancellationToken)
    {
        GoogleWorkbookSnapshot snapshot = await _workspace.ReadImportWorkbookAsync(_workbookId, cancellationToken).ConfigureAwait(false);
        return GoogleCatalogueImportReader.Read(snapshot, _preferredSheetId);
    }

    public Task<GoogleSubredditPresetSnapshot> ReadSubredditPresetsAsync(CancellationToken cancellationToken) =>
        _workspace.ReadSubredditPresetsAsync(_workbookId,cancellationToken);

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
    private readonly Func<string>? _clientSecret;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private string? _accessToken;
    private DateTimeOffset _expiresAt;
    private int _disposed;

    internal GoogleRefreshAccessTokenSource(
        string clientId,
        HttpClient httpClient,
        IGoogleTokenVault vault,
        Func<string>? clientSecret = null
    )
    {
        if (!AppConfiguration.IsValidGoogleOAuthClientId(clientId))
            throw new ArgumentException("Google OAuth client ID is invalid.", nameof(clientId));
        _clientId = clientId;
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _vault = vault ?? throw new ArgumentNullException(nameof(vault));
        _clientSecret = clientSecret;
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
            if (!string.Equals(credential.ClientId, _clientId, StringComparison.Ordinal))
                throw new GoogleCatalogueException("google-authorization-required");
            Dictionary<string, string> form = new()
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = credential.RefreshToken,
                ["client_id"] = _clientId,
            };
            if (_clientSecret is not null) form["client_secret"] = _clientSecret();
            using FormUrlEncodedContent content = new(form);
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
        catch (GoogleCatalogueControllerException)
        {
            throw new GoogleCatalogueException("google-client-configuration-required");
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
        => CreateStartInfo(authorizationUri, BrowserSelection.SystemDefaultId, []);

    internal static ProcessStartInfo CreateStartInfo(
        Uri authorizationUri,
        string? browserId,
        IReadOnlyList<InstalledBrowser> installedBrowsers
    )
    {
        ArgumentNullException.ThrowIfNull(authorizationUri);
        ArgumentNullException.ThrowIfNull(installedBrowsers);
        if (authorizationUri.Scheme != Uri.UriSchemeHttps)
            throw new ArgumentException("Google authorization URI must use HTTPS.", nameof(authorizationUri));

        string normalized = BrowserSelection.NormalizeId(browserId ?? BrowserSelection.SystemDefaultId)
            ?? throw new BrowserLaunchException("invalid-browser");
        if (normalized == BrowserSelection.SystemDefaultId)
            return new(authorizationUri.AbsoluteUri) { UseShellExecute = true };

        InstalledBrowser? browser = installedBrowsers.FirstOrDefault(
            candidate => candidate.Id == normalized
        );
        if (browser is null)
            return new(authorizationUri.AbsoluteUri) { UseShellExecute = true };

        ProcessStartInfo start = new(browser.ExecutablePath)
        {
            UseShellExecute = false,
        };
        start.ArgumentList.Add(authorizationUri.AbsoluteUri);
        return start;
    }

    internal static void Open(Uri authorizationUri, DesktopSettingsStore settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ProcessStartInfo start = CreateStartInfo(
            authorizationUri,
            settings.Load().BrowserId,
            InstalledBrowserCatalog.Discover()
        );
        try
        {
            Process.Start(start);
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new BrowserLaunchException("browser-launch-failed");
        }
    }
}
