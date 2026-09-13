using OFEnhancer.Protocol;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class WebMessageDispatcherTests
{
    [TestMethod]
    public async Task SlowCatalogueWorkRunsOffCallerAndRemainsStrictlySerialized()
    {
        TaskCompletionSource firstEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource releaseFirst = new(TaskCreationOptions.RunContinuationsAsynchronously);
        int callerThread = Environment.CurrentManagedThreadId;
        int calls = 0;
        int active = 0;
        int maximumActive = 0;
        int workerThread = callerThread;
        WebMessageDispatcher dispatcher = new(value =>
        {
            workerThread = Environment.CurrentManagedThreadId;
            int current = Interlocked.Increment(ref active);
            maximumActive = Math.Max(maximumActive, current);
            int call = Interlocked.Increment(ref calls);
            if (call == 1)
            {
                firstEntered.SetResult();
                releaseFirst.Task.GetAwaiter().GetResult();
            }
            Interlocked.Decrement(ref active);
            return value;
        });

        Task<string> first = dispatcher.HandleAsync("first");
        await firstEntered.Task;
        Task<string> second = dispatcher.HandleAsync("second");
        await Task.Delay(100);

        Assert.AreEqual(1, calls, "the second request entered while the first still owned the store");
        Assert.AreNotEqual(callerThread, workerThread, "slow work ran on the caller thread");
        releaseFirst.SetResult();
        CollectionAssert.AreEqual(new[] { "first", "second" }, await Task.WhenAll(first, second));
        Assert.AreEqual(1, maximumActive);
        await dispatcher.DrainAsync();
    }

    [TestMethod]
    public async Task Background_connection_start_does_not_hold_the_serial_dispatcher()
    {
        TaskCompletionSource browserFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
        int calls = 0;
        WebMessageDispatcher dispatcher = new(value =>
        {
            Interlocked.Increment(ref calls);
            if (value == "start")
                _ = Task.Run(() => browserFinished.Task);
            return value;
        });

        Assert.AreEqual("start", await dispatcher.HandleAsync("start"));
        Assert.AreEqual("status", await dispatcher.HandleAsync("status").WaitAsync(TimeSpan.FromSeconds(1)));
        Assert.AreEqual(2, calls);
        Assert.IsFalse(browserFinished.Task.IsCompleted);
        browserFinished.SetResult();
        await dispatcher.DrainAsync();
    }

    [TestMethod]
    public async Task Background_completion_queues_behind_active_catalogue_request()
    {
        TaskCompletionSource requestEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource releaseRequest = new(TaskCreationOptions.RunContinuationsAsynchronously);
        List<string> order = [];
        WebMessageDispatcher dispatcher = new(value =>
        {
            order.Add(value);
            requestEntered.SetResult();
            releaseRequest.Task.GetAwaiter().GetResult();
            return value;
        });

        Task<string> request = dispatcher.HandleAsync("request");
        await requestEntered.Task;
        Task completion = dispatcher.EnqueueAsync(() => order.Add("completion"));
        await Task.Delay(100);

        CollectionAssert.AreEqual(new[] { "request" }, order);
        releaseRequest.SetResult();
        await Task.WhenAll(request, completion);
        CollectionAssert.AreEqual(new[] { "request", "completion" }, order);
    }
}
