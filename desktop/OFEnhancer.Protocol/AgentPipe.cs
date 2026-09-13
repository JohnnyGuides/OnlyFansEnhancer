using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;

namespace OFEnhancer.Protocol;

public static class AgentPipeFrame
{
    public static async Task WriteAsync(Stream output, string message, CancellationToken stop)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(message);
        if (bytes.Length is <= 0 or > AgentProtocol.MaxFrameBytes)
            throw new AgentProtocolException("frame-too-large", "The desktop message is too large.");

        byte[] length = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        await output.WriteAsync(length, stop).ConfigureAwait(false);
        await output.WriteAsync(bytes, stop).ConfigureAwait(false);
        await output.FlushAsync(stop).ConfigureAwait(false);
    }

    public static async Task<string> ReadAsync(Stream input, CancellationToken stop)
        => await ReadOrEndAsync(input, stop).ConfigureAwait(false)
            ?? throw new AgentProtocolException("incomplete-frame", "The desktop message ended early.");

    public static async Task<string?> ReadOrEndAsync(Stream input, CancellationToken stop)
    {
        byte[] length = new byte[sizeof(int)];
        int first = await input.ReadAsync(length.AsMemory(0, 1), stop).ConfigureAwait(false);
        if (first == 0) return null;
        byte[] remaining = new byte[3];
        await ReadExactAsync(input, remaining, stop).ConfigureAwait(false);
        remaining.CopyTo(length, 1);
        int count = BinaryPrimitives.ReadInt32LittleEndian(length);
        if (count is <= 0 or > AgentProtocol.MaxFrameBytes)
            throw new AgentProtocolException("frame-too-large", "The desktop message is too large.");

        byte[] bytes = new byte[count];
        await ReadExactAsync(input, bytes, stop).ConfigureAwait(false);
        return Encoding.UTF8.GetString(bytes);
    }

    private static async Task ReadExactAsync(Stream input, byte[] buffer, CancellationToken stop)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await input.ReadAsync(buffer.AsMemory(offset), stop).ConfigureAwait(false);
            if (read == 0)
                throw new AgentProtocolException(
                    "incomplete-frame",
                    "The desktop message ended early."
                );
            offset += read;
        }
    }
}

public sealed partial class AgentPipeServer
{
    private const int RememberedRequestLimit = 1024;
    private const int ConcurrentConnections = 8;
    private readonly string pipeName;
    private readonly TimeSpan connectionLifetime;
    private readonly Queue<Guid> requestOrder = new();
    private readonly HashSet<Guid> recentRequests = [];

    public AgentPipeServer(string pipeName, TimeSpan? connectionLifetime = null)
    {
        this.pipeName = ValidatePipeName(pipeName);
        this.connectionLifetime = connectionLifetime ?? TimeSpan.FromSeconds(90);
        if (this.connectionLifetime <= TimeSpan.Zero || this.connectionLifetime > TimeSpan.FromSeconds(90))
            throw new ArgumentOutOfRangeException(nameof(connectionLifetime));
    }

    public Task RunAsync(
        Func<AgentRequest, AgentResponse> handle,
        CancellationToken stop
    ) => RunWithHandlerAsync(request => Task.FromResult(handle(request)), stop);

    public async Task RunWithHandlerAsync(
        Func<AgentRequest, Task<AgentResponse>> handle,
        CancellationToken stop
    )
    {
        ArgumentNullException.ThrowIfNull(handle);
        // Browser exchanges must remain responsive while a catalogue read awaits Google.
        await Task.WhenAll(Enumerable.Range(0, ConcurrentConnections).Select(_ => ServeAsync())).ConfigureAwait(false);
        async Task ServeAsync()
        {
            while (true)
            {
                stop.ThrowIfCancellationRequested();
                try { await RunOnceWithHandlerAsync(handle, stop).ConfigureAwait(false); }
                catch (IOException) when (!stop.IsCancellationRequested) { }
                catch (AgentProtocolException) when (!stop.IsCancellationRequested) { }
                catch (OperationCanceledException) when (!stop.IsCancellationRequested) { }
            }
        }
    }

    public Task RunOnceAsync(
        Func<AgentRequest, AgentResponse> handle,
        CancellationToken stop
    ) => RunOnceWithHandlerAsync(request => Task.FromResult(handle(request)), stop);

    public async Task RunOnceWithHandlerAsync(
        Func<AgentRequest, Task<AgentResponse>> handle,
        CancellationToken stop
    )
    {
        ArgumentNullException.ThrowIfNull(handle);
        await using NamedPipeServerStream pipe = new(
            pipeName,
            PipeDirection.InOut,
            ConcurrentConnections,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
        );
        await pipe.WaitForConnectionAsync(stop).ConfigureAwait(false);
        using CancellationTokenSource lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop);
        lifetime.CancelAfter(connectionLifetime);
        stop = lifetime.Token;
        AgentResponse response;
        string requestId = string.Empty;
        try
        {
            AgentRequest request = AgentRequest.Parse(
                await AgentPipeFrame.ReadAsync(pipe, stop).ConfigureAwait(false)
            );
            requestId = request.RequestId.ToString();
            response = TryRemember(request.RequestId)
                ? await handle(request).WaitAsync(stop).ConfigureAwait(false)
                : AgentResponse.Failure(request.RequestId.ToString(), "duplicate-request");
        }
        catch (AgentProtocolException error)
        {
            response = AgentResponse.Failure(requestId, error.Code);
        }
        catch (Exception)
        {
            response = AgentResponse.Failure(requestId, "internal-error");
        }
        // Serialize before writing any bytes so a size failure can return a correlated error.
        string serialized;
        try { serialized = AgentProtocol.Serialize(response); }
        catch (AgentProtocolException error) { serialized = AgentProtocol.Serialize(AgentResponse.Failure(requestId, error.Code)); }
        await AgentPipeFrame
            .WriteAsync(pipe, serialized, stop)
            .ConfigureAwait(false);
    }

    private static string ValidatePipeName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !PipeNamePattern().IsMatch(value))
            throw new ArgumentException("The pipe name is invalid.", nameof(value));
        return value;
    }

    private bool TryRemember(Guid requestId)
    {
        lock (recentRequests)
        {
            if (!recentRequests.Add(requestId))
                return false;
            requestOrder.Enqueue(requestId);
            if (requestOrder.Count > RememberedRequestLimit)
                recentRequests.Remove(requestOrder.Dequeue());
            return true;
        }
    }

    [GeneratedRegex("^[A-Za-z0-9._-]{1,120}$", RegexOptions.CultureInvariant)]
    private static partial Regex PipeNamePattern();
}

public sealed class AgentPipeClient
{
    private readonly string pipeName;

    public AgentPipeClient(string pipeName)
    {
        if (string.IsNullOrWhiteSpace(pipeName))
            throw new ArgumentException("The pipe name is invalid.", nameof(pipeName));
        this.pipeName = pipeName;
    }

    public async Task<AgentResponse> SendAsync(AgentRequest request, CancellationToken stop)
    {
        await using NamedPipeClientStream pipe = new(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
        );
        await pipe.ConnectAsync(stop).ConfigureAwait(false);
        await AgentPipeFrame
            .WriteAsync(pipe, AgentProtocol.Serialize(request), stop)
            .ConfigureAwait(false);
        AgentResponse response = AgentProtocol.ParseResponse(
            await AgentPipeFrame.ReadAsync(pipe, stop).ConfigureAwait(false)
        );
        if (!string.Equals(response.RequestId, request.RequestId.ToString(), StringComparison.Ordinal))
            throw new AgentProtocolException("response-mismatch", "The desktop response does not match.");
        return response;
    }
}
