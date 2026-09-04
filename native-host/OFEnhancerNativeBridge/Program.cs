using System.Security.Principal;
using OFEnhancer.Protocol;

const int ExitFailure = 2;

return await RunAsync(args);

static async Task<int> RunAsync(string[] args)
{
    bool requestMode = args.Length == 3 && string.Equals(args[0], "--request", StringComparison.Ordinal);
    string requestId = string.Empty;
    bool framedOutput = !requestMode;
    try
    {
        string pipeName;
        string input;
        if (requestMode)
        {
            pipeName = args[1];
            FileInfo requestFile = new(args[2]);
            if (!requestFile.Exists || requestFile.Length is <= 0 or > AgentProtocol.MaxFrameBytes)
                throw new AgentProtocolException("invalid-request", "The desktop request is invalid.");
            input = await File.ReadAllTextAsync(requestFile.FullName);
        }
        else if (args.Length == 0)
        {
            string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
            string safeUserKey = new(
                userKey.Where(character => char.IsLetterOrDigit(character) || character == '-').ToArray()
            );
            pipeName = $"ofenhancer-v1-{safeUserKey}";
            input = await AgentPipeFrame.ReadAsync(Console.OpenStandardInput(), CancellationToken.None);
        }
        else
        {
            throw new AgentProtocolException("invalid-request", "The desktop request is invalid.");
        }

        AgentRequest request = AgentRequest.Parse(input);
        requestId = request.RequestId.ToString();
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(2));
        AgentResponse response;
        try
        {
            response = await new AgentPipeClient(pipeName).SendAsync(request, timeout.Token);
        }
        catch (Exception error) when (
            error is IOException or OperationCanceledException or TimeoutException
        )
        {
            response = AgentResponse.Failure(requestId, "desktop-unavailable");
        }
        await WriteAsync(response, framedOutput);
        return response.Ok ? 0 : ExitFailure;
    }
    catch (AgentProtocolException error)
    {
        await WriteAsync(AgentResponse.Failure(requestId, error.Code), framedOutput);
        return ExitFailure;
    }
    catch
    {
        await WriteAsync(AgentResponse.Failure(requestId, "internal-error"), framedOutput);
        return ExitFailure;
    }
}

static async Task WriteAsync(AgentResponse response, bool framed)
{
    string json = AgentProtocol.Serialize(response);
    if (framed)
    {
        await AgentPipeFrame.WriteAsync(Console.OpenStandardOutput(), json, CancellationToken.None);
        return;
    }
    await Console.Out.WriteAsync(json);
}
