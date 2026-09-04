namespace OFEnhancer.Desktop;

internal sealed class WebMessageDispatcher(Func<string, string> handle)
{
    private readonly object sync = new();
    private Task tail = Task.CompletedTask;

    internal Task<string> HandleAsync(string json)
    {
        lock (sync)
        {
            Task<string> work = RunAfterAsync(tail, json);
            tail = work;
            return work;
        }
    }

    internal Task DrainAsync()
    {
        lock (sync)
            return tail;
    }

    private async Task<string> RunAfterAsync(Task previous, string json)
    {
        try
        {
            await previous.ConfigureAwait(false);
        }
        catch
        {
            // One failed request must not permanently block later queued work.
        }
        return await Task.Run(() => handle(json)).ConfigureAwait(false);
    }
}
