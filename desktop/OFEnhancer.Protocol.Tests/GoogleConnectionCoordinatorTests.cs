using System.Diagnostics;
using System.Net;
using System.Text;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleConnectionCoordinatorTests
{
    private const string ClientId = "123456789-desktop.apps.googleusercontent.com";
    private static readonly Uri RedirectUri = new("http://127.0.0.1:53123/");

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

        public void Dispose() => Close();
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

    private sealed record RequestRecord(HttpMethod Method, Uri Uri, string? Authorization, string Body);
}
