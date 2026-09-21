using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Text.Json;
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
        else if (IsChromeInvocation(args))
        {
            string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
            string safeUserKey = new(
                userKey.Where(character => char.IsLetterOrDigit(character) || character == '-').ToArray()
            );
            pipeName = $"ofenhancer-v1-{safeUserKey}";
            Stream inputStream = Console.OpenStandardInput();
            while (true)
            {
                requestId = string.Empty;
                string? frame = await AgentPipeFrame.ReadOrEndAsync(inputStream, CancellationToken.None);
                if (frame is null) return 0;
                AgentRequest framedRequest = AgentRequest.Parse(frame);
                var payload = framedRequest.Payload is JsonElement supplied && supplied.ValueKind == JsonValueKind.Object
                    ? supplied.EnumerateObject().ToDictionary(item => item.Name, item => (object)item.Value.Clone())
                    : [];
                // Replace caller-supplied identity evidence on every browser
                // operation, including direct catalogue reads/result writes.
                payload["bridgeExtensionId"] = args.Length > 0 ? args[0]["chrome-extension://".Length..].TrimEnd('/') : "";
                framedRequest = framedRequest with { Payload = JsonSerializer.SerializeToElement(payload) };
                requestId = framedRequest.RequestId.ToString();
                AgentResponse framedResponse = await ForwardAsync(pipeName, framedRequest);
                await WriteAsync(framedResponse, framed: true);
            }
        }
        else
        {
            throw new AgentProtocolException("invalid-request", "The desktop request is invalid.");
        }

        AgentRequest request = AgentRequest.Parse(input);
        requestId = request.RequestId.ToString();
        AgentResponse response = await ForwardAsync(pipeName, request);
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

static bool IsChromeInvocation(string[] arguments)
{
    if (arguments.Length == 0) return true;
    if (arguments.Length is < 1 or > 2
        || !Regex.IsMatch(arguments[0], "\\Achrome-extension://[a-p]{32}/\\z", RegexOptions.CultureInvariant)) return false;
    if (arguments.Length == 1) return true;
    const string prefix = "--parent-window=";
    if (!arguments[1].StartsWith(prefix, StringComparison.Ordinal)) return false;
    string handle = arguments[1][prefix.Length..];
    return handle.Length > 0 && handle.All(char.IsAsciiDigit)
        && ulong.TryParse(handle, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out ulong value)
        && (IntPtr.Size == 8 || value <= uint.MaxValue);
}

static async Task<AgentResponse> ForwardAsync(string pipeName, AgentRequest request)
{
    using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(request.Operation switch
    { "getStatus" or "browserExchange" => 2, "getSubredditPresets" => 60, _ => 35 }));
    try { return await new AgentPipeClient(pipeName).SendAsync(request, timeout.Token); }
    catch (Exception error) when (error is IOException or OperationCanceledException or TimeoutException)
    { return AgentResponse.Failure(request.RequestId.ToString(), "desktop-unavailable"); }
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
