using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

public sealed class DesktopAgent(string pipeName, Func<AgentRequest, Task<AgentResponse>>? handle = null) : IAsyncDisposable
{
    private readonly CancellationTokenSource stop = new();
    private Task? runTask;

    public static string DefaultPipeName(string userKey)
    {
        string safeUserKey = new(
            userKey.Where(character => char.IsLetterOrDigit(character) || character == '-').ToArray()
        );
        return $"ofenhancer-v1-{safeUserKey}";
    }

    public void Start()
    {
        if (runTask is not null)
            throw new InvalidOperationException("The desktop agent is already running.");
        AgentPipeServer server = new(pipeName);
        runTask = server.RunWithHandlerAsync(
            handle ?? (request => Task.FromResult(request.Operation == AgentProtocol.GetStatusOperation
                ? AgentResponse.Success(request, AgentStatus.Current)
                : AgentResponse.Failure(request.RequestId.ToString(), "unsupported-operation"))),
            stop.Token
        );
    }

    public async ValueTask DisposeAsync()
    {
        // Cancellation callbacks for pending Windows named-pipe accepts can
        // occasionally block the calling thread. Initiate them asynchronously
        // so the shutdown deadline also covers cancellation itself.
        Task cancellation = stop.CancelAsync();
        Task shutdown = runTask is null ? cancellation : Task.WhenAll(cancellation, runTask);
        bool stopped = false;
        try
        {
            await shutdown.WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
            stopped = true;
        }
        catch (OperationCanceledException) { stopped = true; }
        catch (TimeoutException) { }
        // A named-pipe implementation or connected client must never keep the
        // installer or tray process alive forever during shutdown. Leave the
        // cancellation source undisposed only in that exceptional bounded case;
        // the process is already exiting and active operations still own its token.
        if (stopped) stop.Dispose();
    }
}
