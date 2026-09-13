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
        stop.Cancel();
        if (runTask is not null)
        {
            try
            {
                await runTask;
            }
            catch (OperationCanceledException)
            {
            }
        }
        stop.Dispose();
    }
}
