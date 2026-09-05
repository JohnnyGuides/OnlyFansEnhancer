using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OFEnhancer.Protocol;

public sealed class AgentProtocolException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed record AgentRequest(int ProtocolVersion, Guid RequestId, string Operation)
{
    public static AgentRequest CreateStatus() =>
        new(AgentProtocol.Version, Guid.NewGuid(), AgentProtocol.GetStatusOperation);

    public static AgentRequest Parse(string json)
    {
        AgentRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<AgentRequest>(json, AgentProtocol.JsonOptions);
        }
        catch (JsonException)
        {
            throw new AgentProtocolException("invalid-request", "The desktop request is invalid.");
        }

        if (request is null || request.RequestId == Guid.Empty || string.IsNullOrWhiteSpace(request.Operation))
            throw new AgentProtocolException("invalid-request", "The desktop request is invalid.");
        if (request.ProtocolVersion != AgentProtocol.Version)
            throw new AgentProtocolException(
                "unsupported-protocol",
                "The desktop request uses an unsupported protocol."
            );
        if (!string.Equals(request.Operation, AgentProtocol.GetStatusOperation, StringComparison.Ordinal))
            throw new AgentProtocolException(
                "unsupported-operation",
                "The desktop request uses an unsupported operation."
            );
        return request;
    }
}

public sealed record AgentStatus(
    string ProductVersion,
    int ProtocolVersion,
    IReadOnlyList<string> Capabilities
)
{
    public static AgentStatus Current { get; } =
        new(
            AgentProtocol.ProductVersion,
            AgentProtocol.Version,
            ["desktop-shell", "local-file-attach", "native-bridge"]
        );
}

public sealed record AgentError(string Code);

public sealed record AgentResponse(
    bool Ok,
    string RequestId,
    AgentStatus? Status = null,
    AgentError? Error = null
)
{
    public static AgentResponse Success(AgentRequest request, AgentStatus status) =>
        new(true, request.RequestId.ToString(), status);

    public static AgentResponse Failure(string requestId, string code) =>
        new(false, requestId, Error: new AgentError(code));
}

public static class AgentProtocol
{
    public const int Version = 1;
    public const int MaxFrameBytes = 1_048_576;
    public const string ProductVersion = "0.20.4";
    public const string GetStatusOperation = "getStatus";

    internal static JsonSerializerOptions JsonOptions { get; } =
        new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = false,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        };

    public static string Serialize<T>(T value)
    {
        string json = JsonSerializer.Serialize(value, JsonOptions);
        if (Encoding.UTF8.GetByteCount(json) > MaxFrameBytes)
            throw new AgentProtocolException("frame-too-large", "The desktop message is too large.");
        return json;
    }

    public static AgentResponse ParseResponse(string json)
    {
        AgentResponse? response;
        try
        {
            response = JsonSerializer.Deserialize<AgentResponse>(json, JsonOptions);
        }
        catch (JsonException)
        {
            throw new AgentProtocolException("invalid-response", "The desktop response is invalid.");
        }

        if (
            response is null
            || string.IsNullOrWhiteSpace(response.RequestId)
            || (response.Ok && response.Status is null)
            || (!response.Ok && response.Error is null)
        )
            throw new AgentProtocolException("invalid-response", "The desktop response is invalid.");
        return response;
    }
}
