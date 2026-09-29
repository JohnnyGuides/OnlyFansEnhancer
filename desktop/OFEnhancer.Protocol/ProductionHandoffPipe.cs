using System.IO.Pipes;
using System.Text.RegularExpressions;

namespace OFEnhancer.Protocol;

public sealed partial class ProductionHandoffPipeServer(string pipeName)
{
    private readonly string pipeName = ValidateName(pipeName);

    public static string DefaultPipeName(string userKey)
    {
        var safe = new string(userKey.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
        return $"ofenhancer-production-v1-{safe}";
    }

    public async Task RunAsync(Func<ProductionHandoffRequest, CancellationToken,
        Task<ProductionHandoffResponse>> handle, CancellationToken stop)
    {
        await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => ServeAsync())).ConfigureAwait(false);
        async Task ServeAsync()
        {
            while (true)
            {
                stop.ThrowIfCancellationRequested();
                try { await RunOnceAsync(handle, stop).ConfigureAwait(false); }
                catch (IOException) when (!stop.IsCancellationRequested) { }
                catch (OperationCanceledException) when (!stop.IsCancellationRequested) { }
            }
        }
    }

    public async Task RunOnceAsync(Func<ProductionHandoffRequest, CancellationToken,
        Task<ProductionHandoffResponse>> handle, CancellationToken stop)
    {
        await using NamedPipeServerStream pipe = new(pipeName, PipeDirection.InOut, 2,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.WaitForConnectionAsync(stop).ConfigureAwait(false);
        using CancellationTokenSource lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop);
        lifetime.CancelAfter(TimeSpan.FromMinutes(30));
        ProductionHandoffResponse response;
        Guid requestId = Guid.Empty;
        try
        {
            var request = ProductionHandoffProtocol.ParseRequest(
                await AgentPipeFrame.ReadAsync(pipe, lifetime.Token).ConfigureAwait(false));
            requestId = request.RequestId;
            response = await handle(request, lifetime.Token).ConfigureAwait(false);
        }
        catch (ProductionHandoffException error)
        { response = ProductionHandoffResponse.Failure(requestId, error.Code); }
        catch (AgentProtocolException error)
        { response = ProductionHandoffResponse.Failure(requestId, error.Code); }
        catch (Exception) when (!stop.IsCancellationRequested)
        { response = ProductionHandoffResponse.Failure(requestId, "handoff-failed"); }
        await AgentPipeFrame.WriteAsync(pipe, ProductionHandoffProtocol.Serialize(response),
            lifetime.Token).ConfigureAwait(false);
    }

    private static string ValidateName(string value) =>
        !string.IsNullOrWhiteSpace(value) && PipeNamePattern().IsMatch(value)
            ? value : throw new ArgumentException("Invalid handoff pipe name.", nameof(value));

    [GeneratedRegex("^[A-Za-z0-9._-]{1,120}$", RegexOptions.CultureInvariant)]
    private static partial Regex PipeNamePattern();
}

public sealed class ProductionHandoffPipeClient(string pipeName)
{
    public async Task<ProductionHandoffResponse> SendAsync(ProductionHandoffRequest request,
        CancellationToken stop)
    {
        await using NamedPipeClientStream pipe = new(".", pipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(stop).ConfigureAwait(false);
        await AgentPipeFrame.WriteAsync(pipe, ProductionHandoffProtocol.Serialize(request),
            stop).ConfigureAwait(false);
        var response = ProductionHandoffProtocol.ParseResponse(
            await AgentPipeFrame.ReadAsync(pipe, stop).ConfigureAwait(false));
        if (response.RequestId != request.RequestId)
            throw new ProductionHandoffException("response-mismatch", "Handoff response does not match.");
        return response;
    }
}
