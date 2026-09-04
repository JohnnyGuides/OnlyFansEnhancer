using OFEnhancer.Protocol;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class AgentPipeTests
{
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
        Assert.AreEqual("0.18.0", response.Status?.ProductVersion);
        CollectionAssert.AreEqual(
            new[] { "desktop-shell", "local-file-attach", "native-bridge" },
            response.Status?.Capabilities.ToArray()
        );
        await Assert.ThrowsExceptionAsync<OperationCanceledException>(async () => await serverTask);
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
}
