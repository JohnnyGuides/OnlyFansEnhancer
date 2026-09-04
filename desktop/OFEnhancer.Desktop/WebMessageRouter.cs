using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

public sealed partial class WebMessageRouter(Action<Uri> openUri, Func<string?> extensionId)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public string Handle(string json)
    {
        string requestId = string.Empty;
        try
        {
            WebRequest? request = JsonSerializer.Deserialize<WebRequest>(json, JsonOptions);
            if (
                request is null
                || !Guid.TryParse(request.RequestId, out _)
                || string.IsNullOrWhiteSpace(request.Operation)
            )
                return Failure(requestId, "invalid-request");
            requestId = request.RequestId;
            return request.Operation switch
            {
                "getStatus" => Success(requestId, AgentStatus.Current),
                "openChromeUploader" => OpenUploader(requestId),
                _ => Failure(requestId, "unsupported-operation"),
            };
        }
        catch (JsonException)
        {
            return Failure(requestId, "invalid-request");
        }
        catch (Exception)
        {
            return Failure(requestId, "internal-error");
        }
    }

    private string OpenUploader(string requestId)
    {
        string? id = extensionId()?.Trim();
        if (id is null || !ExtensionIdPattern().IsMatch(id))
            return Failure(requestId, "extension-not-configured");
        openUri(new Uri($"chrome-extension://{id}/upload-console.html", UriKind.Absolute));
        return Success(requestId, new { opened = true });
    }

    private static string Success(string requestId, object result) =>
        JsonSerializer.Serialize(new WebResponse(true, requestId, result), JsonOptions);

    private static string Failure(string requestId, string code) =>
        JsonSerializer.Serialize(
            new WebResponse(false, requestId, Error: new WebError(code)),
            JsonOptions
        );

    [GeneratedRegex("^[a-p]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdPattern();

    private sealed record WebRequest(string RequestId, string Operation, JsonElement Payload);

    private sealed record WebError(string Code);

    private sealed record WebResponse(
        bool Ok,
        string RequestId,
        object? Result = null,
        WebError? Error = null
    );
}
