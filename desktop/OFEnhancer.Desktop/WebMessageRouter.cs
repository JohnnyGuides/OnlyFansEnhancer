using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

public sealed partial class WebMessageRouter(
    Action<Uri> openUri,
    Func<string?> extensionId,
    CatalogueStore? catalogue = null,
    Func<string?>? chooseThumbnailRoot = null
)
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
                "getStatus" => WithEmptyPayload(request, () => Success(requestId, AgentStatus.Current)),
                "openChromeUploader" => WithEmptyPayload(request, () => OpenUploader(requestId)),
                "getCatalogue" => WithCatalogue(requestId, request, GetCatalogue),
                "importCatalogueSnapshot" => WithCatalogue(requestId, request, ImportCatalogue),
                "scanThumbnails" => WithCatalogue(requestId, request, ScanThumbnails),
                "confirmAssetBinding" => WithCatalogue(requestId, request, ConfirmBinding),
                _ => Failure(requestId, "unsupported-operation"),
            };
        }
        catch (JsonException)
        {
            return Failure(requestId, "invalid-request");
        }
        catch (WebPayloadException)
        {
            return Failure(requestId, "invalid-payload");
        }
        catch (CatalogueSnapshotException exception)
        {
            return Failure(requestId, exception.Code);
        }
        catch (CatalogueInventoryException exception)
        {
            return Failure(requestId, exception.Code);
        }
        catch (CatalogueBindingException exception)
        {
            return Failure(requestId, exception.Code);
        }
        catch (Exception)
        {
            return Failure(requestId, "internal-error");
        }
    }

    private string WithCatalogue(
        string requestId,
        WebRequest request,
        Func<WebRequest, string> action
    ) => catalogue is null ? Failure(requestId, "catalogue-unavailable") : action(request);

    private string WithEmptyPayload(WebRequest request, Func<string> action)
    {
        DeserializePayload<EmptyPayload>(request.Payload);
        return action();
    }

    private string GetCatalogue(WebRequest request)
    {
        DeserializePayload<EmptyPayload>(request.Payload);
        return Success(request.RequestId, catalogue!.GetCatalogue());
    }

    private string ImportCatalogue(WebRequest request)
    {
        ImportPayload payload = DeserializePayload<ImportPayload>(request.Payload);
        if (payload.Json is null)
            return Failure(request.RequestId, "invalid-payload");
        return Success(request.RequestId, catalogue!.ImportSnapshot(payload.Json));
    }

    private string ScanThumbnails(WebRequest request)
    {
        ScanPayload payload = DeserializePayload<ScanPayload>(request.Payload);
        string? configuredRoot = catalogue!.ConfiguredThumbnailRoot;
        string? root = string.IsNullOrWhiteSpace(payload.Root)
            ? !string.IsNullOrWhiteSpace(configuredRoot) && Directory.Exists(configuredRoot)
                ? configuredRoot
                : chooseThumbnailRoot?.Invoke()
            : payload.Root;
        if (string.IsNullOrWhiteSpace(root))
            return Failure(request.RequestId, "thumbnail-folder-not-selected");
        return Success(request.RequestId, catalogue!.ScanThumbnails(root));
    }

    private string ConfirmBinding(WebRequest request)
    {
        BindingPayload payload = DeserializePayload<BindingPayload>(request.Payload);
        return Success(
            request.RequestId,
            catalogue!.ConfirmAssetBinding(payload.AssetId ?? "", payload.ItemId ?? "")
        );
    }

    private static T DeserializePayload<T>(JsonElement payload)
    {
        try
        {
            if (payload.ValueKind != JsonValueKind.Object)
                throw new JsonException("Payload must be an object.");
            return JsonSerializer.Deserialize<T>(payload.GetRawText(), JsonOptions)
                ?? throw new JsonException("Payload is invalid.");
        }
        catch (JsonException exception)
        {
            throw new WebPayloadException(exception);
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

    private sealed record EmptyPayload;

    private sealed record ImportPayload(string? Json);

    private sealed record ScanPayload(string? Root);

    private sealed record BindingPayload(string? AssetId, string? ItemId);

    private sealed class WebPayloadException(Exception innerException)
        : Exception("Web payload is invalid.", innerException);

    private sealed record WebError(string Code);

    private sealed record WebResponse(
        bool Ok,
        string RequestId,
        object? Result = null,
        WebError? Error = null
    );
}
