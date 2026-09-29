namespace OFEnhancer.Desktop;

internal sealed class WebMessageDispatcher(Func<string, string> handle)
{
    private readonly object sync = new();
    private Task tail = Task.CompletedTask;
    private bool closing;

    internal Task<string> HandleAsync(string json)
        => EnqueueAsync(() => handle(json));

    internal Task EnqueueAsync(Action action)
        => EnqueueAsync(() =>
        {
            action();
            return true;
        });

    internal Task<T> EnqueueAsync<T>(Func<T> action)
    {
        lock (sync)
        {
            if (closing) return Task.FromException<T>(new WebMessageDispatcherClosedException());
            Task<T> work = RunAfterAsync(tail, action);
            tail = work;
            return work;
        }
    }

    // Stops admission, then waits for queued work to settle. A queued request's
    // own failure belongs to its caller, never to the drain.
    internal async Task DrainAsync()
    {
        Task last;
        lock (sync)
        {
            closing = true;
            last = tail;
        }
        try { await last.ConfigureAwait(false); }
        catch { }
    }

    private static async Task<T> RunAfterAsync<T>(Task previous, Func<T> action)
    {
        try
        {
            await previous.ConfigureAwait(false);
        }
        catch
        {
            // One failed request must not permanently block later queued work.
        }
        return await Task.Run(action).ConfigureAwait(false);
    }
}

internal sealed class WebMessageDispatcherClosedException() : InvalidOperationException("desktop-closing");
