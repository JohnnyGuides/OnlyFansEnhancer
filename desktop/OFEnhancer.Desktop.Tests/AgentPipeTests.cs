using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class AgentPipeTests
{
    private sealed class NeverPostContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state) { }
    }

    [TestMethod]
    public async Task Stalled_partial_frames_expire_and_release_all_workers()
    {
        string name = $"ofenhancer-test-{Guid.NewGuid():N}";
        using CancellationTokenSource stop = new(TimeSpan.FromSeconds(5));
        Task server = new AgentPipeServer(name, TimeSpan.FromMilliseconds(300)).RunAsync(
            request => AgentResponse.Success(request, AgentStatus.Current), stop.Token);
        List<System.IO.Pipes.NamedPipeClientStream> stalled = [];
        try
        {
            for (int i = 0; i < 8; i++)
            {
                var client = new System.IO.Pipes.NamedPipeClientStream(".", name, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous);
                stalled.Add(client);
                await client.ConnectAsync(stop.Token);
                await client.WriteAsync(new byte[] { 4 }, stop.Token);
            }
            await Task.Delay(600, stop.Token);
            Assert.IsTrue((await new AgentPipeClient(name).SendAsync(AgentRequest.CreateStatus(), stop.Token)).Ok);
        }
        finally { foreach (var client in stalled) client.Dispose(); stop.Cancel(); await AssertCancelled(server); }
    }

    [TestMethod]
    public async Task Frame_boundary_counts_utf8_bytes_before_any_write()
    {
        using MemoryStream output = new();
        string boundary = new('x', AgentProtocol.MaxFrameBytes);
        await AgentPipeFrame.WriteAsync(output, boundary, CancellationToken.None);
        Assert.AreEqual(AgentProtocol.MaxFrameBytes + 4L, output.Length);
        output.SetLength(0);
        await Assert.ThrowsExceptionAsync<AgentProtocolException>(() => AgentPipeFrame.WriteAsync(output, new string('界', AgentProtocol.MaxFrameBytes / 3 + 1), CancellationToken.None));
        Assert.AreEqual(0L, output.Length);
    }

    [TestMethod]
    public async Task Oversized_replies_do_not_exhaust_accept_workers()
    {
        string name = $"ofenhancer-test-{Guid.NewGuid():N}";
        using CancellationTokenSource stop = new(TimeSpan.FromSeconds(15));
        Task server = new AgentPipeServer(name).RunAsync(request => request.Operation == "getCatalogue"
            ? AgentResponse.SuccessResult(request, new { text = new string('界', AgentProtocol.MaxFrameBytes) })
            : AgentResponse.Success(request, AgentStatus.Current), stop.Token);
        try
        {
            for (int i = 0; i < 12; i++)
            {
                AgentRequest request = new(1, Guid.NewGuid(), "getCatalogue");
                AgentResponse response = await new AgentPipeClient(name).SendAsync(request, stop.Token);
                Assert.AreEqual(request.RequestId.ToString(), response.RequestId);
                Assert.AreEqual("frame-too-large", response.Error?.Code);
            }
            foreach (string operation in new[] { "getStatus", "browserExchange" })
                Assert.IsTrue((await new AgentPipeClient(name).SendAsync(new(1, Guid.NewGuid(), operation), stop.Token)).Ok);
        }
        finally { stop.Cancel(); try { await server; } catch (OperationCanceledException) { } }
    }

    [TestMethod]
    public async Task Browser_exchange_remains_available_during_a_slow_catalogue_read()
    {
        string name=$"ofenhancer-test-{Guid.NewGuid():N}";
        using CancellationTokenSource stop=new(TimeSpan.FromSeconds(5));
        TaskCompletionSource entered=new(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource release=new(TaskCreationOptions.RunContinuationsAsynchronously);
        Task server=new AgentPipeServer(name).RunWithHandlerAsync(async request=>
        {
            if(request.Operation=="getSubredditPresets") { entered.SetResult(); await release.Task.WaitAsync(stop.Token); }
            return AgentResponse.SuccessResult(request,new { ready=true });
        },stop.Token);
        Task<AgentResponse> slow=new AgentPipeClient(name).SendAsync(new(1,Guid.NewGuid(),"getSubredditPresets"),stop.Token);
        try
        {
            await entered.Task.WaitAsync(stop.Token);
            AgentResponse response=await new AgentPipeClient(name).SendAsync(new(1,Guid.NewGuid(),"browserExchange"),stop.Token).WaitAsync(TimeSpan.FromSeconds(1));
            Assert.IsTrue(response.Ok);
        }
        finally { release.TrySetResult(); await slow; stop.Cancel(); await AssertCancelled(server); }
    }

    [TestMethod]
    public async Task Native_stream_reads_repeated_frames_and_distinguishes_clean_end_from_truncation()
    {
        using MemoryStream stream=new();
        await AgentPipeFrame.WriteAsync(stream,"one",CancellationToken.None);
        await AgentPipeFrame.WriteAsync(stream,"two",CancellationToken.None);
        stream.Position=0;
        Assert.AreEqual("one",await AgentPipeFrame.ReadOrEndAsync(stream,CancellationToken.None));
        Assert.AreEqual("two",await AgentPipeFrame.ReadOrEndAsync(stream,CancellationToken.None));
        Assert.IsNull(await AgentPipeFrame.ReadOrEndAsync(stream,CancellationToken.None));
        using MemoryStream truncated=new([4,0]);
        await Assert.ThrowsExceptionAsync<AgentProtocolException>(()=>AgentPipeFrame.ReadOrEndAsync(truncated,CancellationToken.None));
    }
    [TestMethod]
    public async Task Current_user_pipe_round_trips_one_status_request()
    {
        string pipeName = $"ofenhancer-test-{Guid.NewGuid():N}";
        using CancellationTokenSource stop = new(TimeSpan.FromSeconds(5));
        AgentPipeServer server = new(pipeName);
        Task serverTask = server.RunAsync(
            request => AgentResponse.Success(request, AgentStatus.Current),
            stop.Token
        );
        AgentPipeClient client = new(pipeName);
        AgentRequest request = AgentRequest.CreateStatus();

        AgentResponse response = await client.SendAsync(request, stop.Token);
        stop.Cancel();

        Assert.IsTrue(response.Ok);
        Assert.AreEqual(request.RequestId.ToString(), response.RequestId);
        Assert.AreEqual("0.20.40", response.Status?.ProductVersion);
        CollectionAssert.AreEqual(
            new[] { "desktop-shell", "local-file-attach", "native-bridge" },
            response.Status?.Capabilities.ToArray()
        );
        await AssertCancelled(serverTask);
    }

    [TestMethod]
    public async Task Frame_writer_rejects_more_than_one_mebibyte_before_writing()
    {
        await using MemoryStream stream = new();
        string oversized = new('x', AgentProtocol.MaxFrameBytes + 1);

        AgentProtocolException error = await Assert.ThrowsExceptionAsync<AgentProtocolException>(
            async () => await AgentPipeFrame.WriteAsync(stream, oversized, CancellationToken.None)
        );

        Assert.AreEqual("frame-too-large", error.Code);
        Assert.AreEqual(0, stream.Length);
    }

    [TestMethod]
    public async Task Server_cancels_while_waiting_for_a_client()
    {
        string pipeName = $"ofenhancer-test-{Guid.NewGuid():N}";
        using CancellationTokenSource stop = new(TimeSpan.FromMilliseconds(50));
        AgentPipeServer server = new(pipeName);

        await Assert.ThrowsExceptionAsync<OperationCanceledException>(
            async () =>
                await server.RunAsync(
                    request => AgentResponse.Success(request, AgentStatus.Current),
                    stop.Token
                )
        );
    }

    [TestMethod]
    public void Desktop_agent_can_be_disposed_from_a_blocked_synchronization_context()
    {
        string pipeName = $"ofenhancer-test-{Guid.NewGuid():N}";
        SynchronizationContext? previous = SynchronizationContext.Current;
        try
        {
            SynchronizationContext.SetSynchronizationContext(new NeverPostContext());
            var agent = new DesktopAgent(pipeName);
            agent.Start();
            agent.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }
    }

    [TestMethod]
    public async Task Server_rejects_a_recent_duplicate_request_without_rehandling_it()
    {
        string pipeName = $"ofenhancer-test-{Guid.NewGuid():N}";
        using CancellationTokenSource stop = new(TimeSpan.FromSeconds(5));
        int handled = 0;
        AgentPipeServer server = new(pipeName);
        Task serverTask = server.RunAsync(
            request =>
            {
                handled++;
                return AgentResponse.Success(request, AgentStatus.Current);
            },
            stop.Token
        );
        AgentPipeClient client = new(pipeName);
        AgentRequest request = AgentRequest.CreateStatus();

        AgentResponse first = await client.SendAsync(request, stop.Token);
        AgentResponse duplicate = await client.SendAsync(request, stop.Token);
        stop.Cancel();

        Assert.IsTrue(first.Ok);
        Assert.IsFalse(duplicate.Ok);
        Assert.AreEqual("duplicate-request", duplicate.Error?.Code);
        Assert.AreEqual(1, handled);
        await AssertCancelled(serverTask);
    }

    private static async Task AssertCancelled(Task task)
    {
        try
        {
            await task;
            Assert.Fail("The server task completed without cancellation.");
        }
        catch (OperationCanceledException)
        {
            // TaskCanceledException and OperationCanceledException both represent the contract.
        }
    }
}
