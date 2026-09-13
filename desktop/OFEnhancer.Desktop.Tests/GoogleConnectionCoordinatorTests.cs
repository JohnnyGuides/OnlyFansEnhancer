using OFEnhancer.Protocol;
using System.Diagnostics;
using System.Net;
using System.Text;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleConnectionCoordinatorTests
{
    private const string ClientId =
        "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
    private static readonly Uri RedirectUri = new("http://127.0.0.1:53123/");

    [TestMethod]
    public async Task BrowserLaunchFailurePreservesActionableErrorAndClosesReceiver()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        MemoryGoogleTokenVault vault = new();
        GoogleConnectionCoordinator coordinator = CreateCoordinator(
            receiver, new ThrowingHandler(), vault,
            _ => throw new BrowserLaunchException("browser-launch-failed")
        );

        coordinator.Start();
        await receiver.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.AreEqual(GoogleConnectionState.Error, coordinator.Snapshot.State);
        Assert.AreEqual("browser-launch-failed", coordinator.Snapshot.ErrorCode);
        Assert.AreEqual(0, receiver.ReceiveCalls);
        Assert.AreEqual(1, receiver.CloseCalls);
        Assert.IsNull(vault.Load());
    }

    [TestMethod]
    public async Task StartReturnsImmediatelyOpensOneSystemBrowserAndRejectsConcurrentStart()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        TaskCompletionSource<Uri> browserOpened = new(TaskCreationOptions.RunContinuationsAsynchronously);
        GoogleConnectionCoordinator coordinator = CreateCoordinator(
            receiver,
            new ThrowingHandler(),
            new MemoryGoogleTokenVault(),
            uri => browserOpened.TrySetResult(uri)
        );
        Stopwatch stopwatch = Stopwatch.StartNew();

        coordinator.Start();

        stopwatch.Stop();
        Assert.IsTrue(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
        Uri authorizationUri = await browserOpened.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.AreEqual("accounts.google.com", authorizationUri.Host);
        await WaitUntilAsync(() => receiver.ReceiveCalls == 1);
        Assert.AreEqual(1, receiver.ReceiveCalls);
        Assert.ThrowsException<InvalidOperationException>(() => coordinator.Start());

        coordinator.Cancel();
        await WaitForStateAsync(coordinator, GoogleConnectionState.Disconnected);
        Assert.AreEqual(1, receiver.CloseCalls);
        Assert.IsNull(coordinator.Snapshot.ErrorCode);
    }

    [TestMethod]
    public async Task SuccessfulConnectionValidatesWorkbookThenSavesOnlyRefreshCredential()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        SequenceHandler handler = new(
            Json(HttpStatusCode.OK, """{"access_token":"access-value","refresh_token":"refresh-value","expires_in":3600}"""),
            Json(HttpStatusCode.OK, """{"id":"sheet-123","name":"2026 Video Catalogue","mimeType":"application/vnd.google-apps.spreadsheet","capabilities":{"canEdit":true}}""")
        );
        MemoryGoogleTokenVault vault = new();
        TaskCompletionSource<GoogleConnectionCompletion> completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        GoogleConnectionCoordinator coordinator = CreateCoordinator(receiver, handler, vault, _ => { }, value => completed.TrySetResult(value));

        coordinator.Start();
        await WaitUntilAsync(() => receiver.AuthorizationUri is not null);
        string state = QueryValue(receiver.AuthorizationUri!, "state");
        receiver.Complete(new($"{RedirectUri}?state={state}&code=authorization-code&picked_file_ids=sheet-123"));

        GoogleConnectionCompletion result = await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.AreEqual("sheet-123", result.WorkbookId);
        Assert.AreEqual("2026 Video Catalogue", result.WorkbookTitle);
        Assert.IsTrue(result.CredentialExpiry > DateTimeOffset.UtcNow);
        Assert.AreEqual("refresh-value", vault.Load()?.RefreshToken);
        Assert.AreEqual(GoogleConnectionState.NeedsInspection, coordinator.Snapshot.State);
        Assert.AreEqual(2, handler.Requests.Count);
        Assert.AreEqual(new("https://oauth2.googleapis.com/token"), handler.Requests[0].Uri);
        Assert.AreEqual(new("https://www.googleapis.com/drive/v3/files/sheet-123?fields=id%2Cname%2CmimeType%2Ccapabilities%28canEdit%29"), handler.Requests[1].Uri);
        Assert.AreEqual("Bearer access-value", handler.Requests[1].Authorization);
        Assert.IsFalse(result.ToString().Contains("refresh-value", StringComparison.Ordinal));
        Assert.IsFalse(coordinator.Snapshot.ToString().Contains("access-value", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task ChangedStateDoesNotCallGoogleOrSaveCredential()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        MemoryGoogleTokenVault vault = new();
        GoogleConnectionCoordinator coordinator = CreateCoordinator(receiver, new ThrowingHandler(), vault, _ => { });

        coordinator.Start();
        await WaitUntilAsync(() => receiver.AuthorizationUri is not null);
        receiver.Complete(new($"{RedirectUri}?state=changed&code=authorization-code&picked_file_ids=sheet-123"));

        await WaitForStateAsync(coordinator, GoogleConnectionState.Error);
        Assert.AreEqual("state_mismatch", coordinator.Snapshot.ErrorCode);
        Assert.IsNull(vault.Load());
    }

    [TestMethod]
    public async Task NonEditableOrNonSpreadsheetPickDoesNotSaveCredential()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        SequenceHandler handler = new(
            Json(HttpStatusCode.OK, """{"access_token":"access-value","refresh_token":"refresh-value","expires_in":3600}"""),
            Json(HttpStatusCode.OK, """{"id":"sheet-123","name":"Wrong file","mimeType":"application/pdf","capabilities":{"canEdit":false}}""")
        );
        MemoryGoogleTokenVault vault = new();
        GoogleConnectionCoordinator coordinator = CreateCoordinator(receiver, handler, vault, _ => { });

        coordinator.Start();
        await WaitUntilAsync(() => receiver.AuthorizationUri is not null);
        string state = QueryValue(receiver.AuthorizationUri!, "state");
        receiver.Complete(new($"{RedirectUri}?state={state}&code=authorization-code&picked_file_ids=sheet-123"));

        await WaitForStateAsync(coordinator, GoogleConnectionState.Error);
        Assert.AreEqual("invalid_picked_file", coordinator.Snapshot.ErrorCode);
        Assert.IsNull(vault.Load());
    }

    [TestMethod]
    public async Task CancelBeforeFinalizationPreservesExistingCredentialWithoutVaultMutation()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        PausingDriveHandler handler = new();
        GoogleRefreshCredential existing = new(
            "existing-refresh-value",
            DateTimeOffset.Parse("2026-09-04T10:00:00Z"),
            ClientId
        );
        TrackingTokenVault vault = new(existing);
        TaskCompletionSource<GoogleConnectionCompletion> completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        GoogleConnectionCoordinator coordinator = CreateCoordinator(
            receiver,
            handler,
            vault,
            _ => { },
            value => completed.TrySetResult(value)
        );

        coordinator.Start();
        await WaitUntilAsync(() => receiver.AuthorizationUri is not null);
        string state = QueryValue(receiver.AuthorizationUri!, "state");
        receiver.Complete(new($"{RedirectUri}?state={state}&code=authorization-code&picked_file_ids=sheet-123"));
        await handler.DriveRequestEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        coordinator.Cancel();
        handler.ReleaseDriveResponse();
        await receiver.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.AreEqual(existing, vault.Load());
        Assert.AreEqual(0, vault.SaveCalls);
        Assert.AreEqual(0, vault.DeleteCalls);
        Assert.IsFalse(completed.Task.IsCompleted);
        Assert.AreEqual(GoogleConnectionState.Disconnected, coordinator.Snapshot.State);
        Assert.IsNull(coordinator.Snapshot.ErrorCode);
    }

    [TestMethod]
    public async Task CancelAfterFinalizationTransitionCannotRollbackCommittedCredential()
    {
        FakeCallbackReceiver receiver = new(RedirectUri);
        SequenceHandler handler = new(
            Json(HttpStatusCode.OK, """{"access_token":"access-value","refresh_token":"refresh-value","expires_in":3600}"""),
            Json(HttpStatusCode.OK, """{"id":"sheet-123","name":"2026 Video Catalogue","mimeType":"application/vnd.google-apps.spreadsheet","capabilities":{"canEdit":true}}""")
        );
        PausingTokenVault vault = new();
        TaskCompletionSource<GoogleConnectionCompletion> completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        GoogleConnectionCoordinator coordinator = CreateCoordinator(
            receiver,
            handler,
            vault,
            _ => { },
            value => completed.TrySetResult(value)
        );

        coordinator.Start();
        await WaitUntilAsync(() => receiver.AuthorizationUri is not null);
        string state = QueryValue(receiver.AuthorizationUri!, "state");
        receiver.Complete(new($"{RedirectUri}?state={state}&code=authorization-code&picked_file_ids=sheet-123"));
        await vault.SaveEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        coordinator.Cancel();
        vault.ReleaseSave();

        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.AreEqual("refresh-value", vault.Load()?.RefreshToken);
        Assert.AreEqual(1, vault.SaveCalls);
        Assert.AreEqual(0, vault.DeleteCalls);
        Assert.AreEqual(GoogleConnectionState.NeedsInspection, coordinator.Snapshot.State);
        Assert.IsNull(coordinator.Snapshot.ErrorCode);
    }

    private static GoogleConnectionCoordinator CreateCoordinator(
        FakeCallbackReceiver receiver,
        HttpMessageHandler handler,
        IGoogleTokenVault vault,
        Action<Uri> openBrowser,
        Action<GoogleConnectionCompletion>? completed = null
    ) => new(
        ClientId,
        new HttpClient(handler),
        vault,
        () => receiver,
        uri =>
        {
            receiver.AuthorizationUri = uri;
            openBrowser(uri);
        },
        completed ?? (_ => { })
    );

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
    };

    private static async Task WaitForStateAsync(GoogleConnectionCoordinator coordinator, GoogleConnectionState state) =>
        await WaitUntilAsync(() => coordinator.Snapshot.State == state);

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(2));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private static string QueryValue(Uri uri, string key) => uri.Query.TrimStart('?')
        .Split('&', StringSplitOptions.RemoveEmptyEntries)
        .Select(part => part.Split('=', 2))
        .Where(part => Uri.UnescapeDataString(part[0]) == key)
        .Select(part => Uri.UnescapeDataString(part[1]))
        .Single();

    private sealed class FakeCallbackReceiver(Uri redirectUri) : IGoogleOAuthCallbackReceiver
    {
        private readonly TaskCompletionSource<Uri> _callback = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _closed;

        public Uri RedirectUri { get; } = redirectUri;
        public Uri? AuthorizationUri { get; set; }
        public int ReceiveCalls { get; private set; }
        public int CloseCalls { get; private set; }
        public TaskCompletionSource Disposed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<Uri> ReceiveAsync(CancellationToken cancellationToken)
        {
            ReceiveCalls++;
            cancellationToken.Register(() => _callback.TrySetCanceled(cancellationToken));
            return _callback.Task;
        }

        public void Complete(Uri callback) => _callback.TrySetResult(callback);

        public void Close()
        {
            if (Interlocked.Exchange(ref _closed, 1) == 0)
            {
                CloseCalls++;
                _callback.TrySetCanceled();
            }
        }

        public void Dispose()
        {
            Close();
            Disposed.TrySetResult();
        }
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new AssertFailedException("No network request was expected.");
    }

    private sealed class SequenceHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        private int _index;
        public List<RequestRecord> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new(
                request.Method,
                request.RequestUri!,
                request.Headers.Authorization?.ToString(),
                request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken)
            ));
            HttpResponseMessage response = responses[_index++];
            response.RequestMessage = request;
            return response;
        }
    }

    private sealed class PausingTokenVault : IGoogleTokenVault
    {
        private readonly MemoryGoogleTokenVault _inner = new();
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource SaveEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int SaveCalls { get; private set; }
        public int DeleteCalls { get; private set; }

        public GoogleRefreshCredential? Load() => _inner.Load();

        public void Save(GoogleRefreshCredential credential)
        {
            SaveEntered.TrySetResult();
            _release.Task.GetAwaiter().GetResult();
            _inner.Save(credential);
            SaveCalls++;
        }

        public void Delete()
        {
            _inner.Delete();
            DeleteCalls++;
        }

        public void ReleaseSave() => _release.TrySetResult();
    }

    private sealed class TrackingTokenVault(GoogleRefreshCredential existing) : IGoogleTokenVault
    {
        private GoogleRefreshCredential? _credential = existing;

        public int SaveCalls { get; private set; }
        public int DeleteCalls { get; private set; }

        public GoogleRefreshCredential? Load() => _credential;

        public void Save(GoogleRefreshCredential credential)
        {
            _credential = credential;
            SaveCalls++;
        }

        public void Delete()
        {
            _credential = null;
            DeleteCalls++;
        }
    }

    private sealed class PausingDriveHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _requestIndex;

        public TaskCompletionSource DriveRequestEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void ReleaseDriveResponse() => _release.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            if (Interlocked.Increment(ref _requestIndex) == 1)
            {
                HttpResponseMessage token = Json(
                    HttpStatusCode.OK,
                    """{"access_token":"access-value","refresh_token":"refresh-value","expires_in":3600}"""
                );
                token.RequestMessage = request;
                return token;
            }

            DriveRequestEntered.TrySetResult();
            await _release.Task;
            HttpResponseMessage drive = Json(
                HttpStatusCode.OK,
                """{"id":"sheet-123","name":"2026 Video Catalogue","mimeType":"application/vnd.google-apps.spreadsheet","capabilities":{"canEdit":true}}"""
            );
            drive.RequestMessage = request;
            return drive;
        }
    }

    private sealed record RequestRecord(HttpMethod Method, Uri Uri, string? Authorization, string Body);
}
