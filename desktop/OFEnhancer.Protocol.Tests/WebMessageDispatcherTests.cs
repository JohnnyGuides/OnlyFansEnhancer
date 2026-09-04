using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

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
}
