using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

internal sealed class ProductionHandoffAgent(string pipeName,
    Func<ProductionHandoffRequest, CancellationToken, Task<ProductionHandoffResponse>> handle)
    : IAsyncDisposable
{
    private readonly CancellationTokenSource stop = new();
    private Task? runTask;

    public void Start()
    {
        if (runTask is not null) throw new InvalidOperationException("Production handoff is already running.");
        runTask = new ProductionHandoffPipeServer(pipeName).RunAsync(handle, stop.Token);
    }

    public async ValueTask DisposeAsync()
    {
        var cancellation = stop.CancelAsync();
        var shutdown = runTask is null ? cancellation : Task.WhenAll(cancellation, runTask);
        try { await shutdown.WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        catch (TimeoutException) { return; }
        stop.Dispose();
    }
}
