using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OFEnhancer.Protocol;

public sealed class ProductionHandoffException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed record ProductionFinalFile(Guid ArtifactId, string Role, string Path,
    long Size, string Sha256);

public sealed record ProductionHandoffRequest(int ProtocolVersion, Guid RequestId,
    string Operation, Guid HandoffId, Guid? EpisodeId = null, Guid? EditId = null,
    string? EpisodeCode = null, int? EditNumber = null,
    IReadOnlyList<ProductionFinalFile>? Files = null);

public sealed record ProductionHandoffStatus(Guid HandoffId, string State,
    Guid EpisodeId, Guid EditId, string EpisodeCode, int EditNumber,
    string? CatalogueItemId, IReadOnlyList<ProductionFinalFile> Files);

public sealed record ProductionHandoffResponse(int ProtocolVersion, Guid RequestId,
    bool Ok, ProductionHandoffStatus? Status = null, string? Error = null)
{
    public static ProductionHandoffResponse Success(ProductionHandoffRequest request,
        ProductionHandoffStatus status) =>
        new(ProductionHandoffProtocol.Version, request.RequestId, true, status);

    public static ProductionHandoffResponse Failure(Guid requestId, string code) =>
        new(ProductionHandoffProtocol.Version, requestId, false, Error: code);
}

public static class ProductionHandoffProtocol
{
    public const int Version = 1;
    public const string PrepareOperation = "PrepareProductionDraft";
    public const string StatusOperation = "GetProductionHandoffStatus";

    public static JsonSerializerOptions JsonOptions { get; } = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static ProductionHandoffRequest ParseRequest(string json)
    {
        ProductionHandoffRequest? request;
        try { request = JsonSerializer.Deserialize<ProductionHandoffRequest>(json, JsonOptions); }
        catch (JsonException) { throw new ProductionHandoffException("invalid-request", "Invalid production handoff request."); }
        if (request is null || request.RequestId == Guid.Empty || request.HandoffId == Guid.Empty)
            throw new ProductionHandoffException("invalid-request", "Missing handoff identity.");
        if (request.ProtocolVersion != Version)
            throw new ProductionHandoffException("unsupported-protocol", "Unsupported production handoff version.");
        if (request.Operation is not (PrepareOperation or StatusOperation))
            throw new ProductionHandoffException("unsupported-operation", "Unsupported production handoff operation.");
        if (request.Operation == PrepareOperation &&
            (request.EpisodeId is not Guid episodeId || episodeId == Guid.Empty ||
             request.EditId is not Guid editId || editId == Guid.Empty ||
             string.IsNullOrWhiteSpace(request.EpisodeCode) || request.EpisodeCode.Length > 80 ||
             request.EditNumber is not > 0 || request.Files is not { Count: > 0 and <= 8 }))
            throw new ProductionHandoffException("invalid-request", "Incomplete production draft.");
        if (request.Operation == StatusOperation &&
            (request.EpisodeId is not null || request.EditId is not null ||
             request.EpisodeCode is not null || request.EditNumber is not null || request.Files is not null))
            throw new ProductionHandoffException("invalid-request", "Status request contains draft fields.");
        return request;
    }

    public static ProductionHandoffResponse ParseResponse(string json)
    {
        ProductionHandoffResponse? response;
        try { response = JsonSerializer.Deserialize<ProductionHandoffResponse>(json, JsonOptions); }
        catch (JsonException) { throw new ProductionHandoffException("invalid-response", "Invalid handoff response."); }
        if (response is null || response.ProtocolVersion != Version || response.RequestId == Guid.Empty ||
            response.Ok == (response.Status is null) || response.Ok == (response.Error is not null))
            throw new ProductionHandoffException("invalid-response", "Incomplete handoff response.");
        return response;
    }

    public static string Serialize<T>(T value)
    {
        string json = JsonSerializer.Serialize(value, JsonOptions);
        if (Encoding.UTF8.GetByteCount(json) > AgentProtocol.MaxFrameBytes)
            throw new ProductionHandoffException("frame-too-large", "Production handoff is too large.");
        return json;
    }
}
