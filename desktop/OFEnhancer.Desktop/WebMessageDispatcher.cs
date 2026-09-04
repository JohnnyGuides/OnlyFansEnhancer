namespace OFEnhancer.Desktop;

internal sealed class WebMessageDispatcher(Func<string, string> handle)
{
    private readonly object sync = new();
    private Task tail = Task.CompletedTask;

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
            Task<T> work = RunAfterAsync(tail, action);
            tail = work;
            return work;
        }
    }

    internal Task DrainAsync()
    {
        lock (sync)
            return tail;
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
