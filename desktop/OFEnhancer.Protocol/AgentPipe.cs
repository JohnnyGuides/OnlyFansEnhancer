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
        await output.WriteAsync(length, stop);
        await output.WriteAsync(bytes, stop);
        await output.FlushAsync(stop);
    }

    public static async Task<string> ReadAsync(Stream input, CancellationToken stop)
    {
        byte[] length = new byte[sizeof(int)];
        await ReadExactAsync(input, length, stop);
        int count = BinaryPrimitives.ReadInt32LittleEndian(length);
        if (count is <= 0 or > AgentProtocol.MaxFrameBytes)
            throw new AgentProtocolException("frame-too-large", "The desktop message is too large.");

        byte[] bytes = new byte[count];
        await ReadExactAsync(input, bytes, stop);
        return Encoding.UTF8.GetString(bytes);
    }

    private static async Task ReadExactAsync(Stream input, byte[] buffer, CancellationToken stop)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await input.ReadAsync(buffer.AsMemory(offset), stop);
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
    private readonly string pipeName;

    public AgentPipeServer(string pipeName) => this.pipeName = ValidatePipeName(pipeName);

    public async Task RunAsync(
        Func<AgentRequest, AgentResponse> handle,
        CancellationToken stop
    )
    {
        ArgumentNullException.ThrowIfNull(handle);
        while (true)
        {
            stop.ThrowIfCancellationRequested();
            await using NamedPipeServerStream pipe = new(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
            );
            await pipe.WaitForConnectionAsync(stop);
            AgentResponse response;
            try
            {
                AgentRequest request = AgentRequest.Parse(await AgentPipeFrame.ReadAsync(pipe, stop));
                response = handle(request);
            }
            catch (AgentProtocolException error)
            {
                response = AgentResponse.Failure(string.Empty, error.Code);
            }
            catch (Exception)
            {
                response = AgentResponse.Failure(string.Empty, "internal-error");
            }
            await AgentPipeFrame.WriteAsync(pipe, AgentProtocol.Serialize(response), stop);
        }
    }

    private static string ValidatePipeName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !PipeNamePattern().IsMatch(value))
            throw new ArgumentException("The pipe name is invalid.", nameof(value));
        return value;
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
        await pipe.ConnectAsync(stop);
        await AgentPipeFrame.WriteAsync(pipe, AgentProtocol.Serialize(request), stop);
        AgentResponse response = AgentProtocol.ParseResponse(
            await AgentPipeFrame.ReadAsync(pipe, stop)
        );
        if (!string.Equals(response.RequestId, request.RequestId.ToString(), StringComparison.Ordinal))
            throw new AgentProtocolException("response-mismatch", "The desktop response does not match.");
        return response;
    }
}
