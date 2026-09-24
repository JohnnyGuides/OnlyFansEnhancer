using System.Text.Json;
using System.Text.Json.Serialization;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed class UploadCatalogueController(CatalogueStore store, Func<GoogleSubredditPresetSnapshot>? readSubredditPresets=null)
{
    private readonly UploadThumbnailCatalogue thumbnails = new(store);
    private static readonly JsonSerializerOptions JsonOptions=new()
    {
        PropertyNamingPolicy=JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow,
        MaxDepth=8,
    };

    internal UploadCatalogueSnapshot GetSnapshot() => store.GetUploadCatalogueSnapshot();
    internal GoogleSubredditPresetSnapshot GetSubredditPresets() => readSubredditPresets?.Invoke()
        ?? throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
    internal UploadResult RecordResult(JsonElement payload)
    {
        try
        {
            if(payload.ValueKind!=JsonValueKind.Object) throw new JsonException();
            if(payload.TryGetProperty("action",out JsonElement action) && action.ValueKind==JsonValueKind.String
                && action.GetString()=="appendDistributionLedger")
                return store.RecordDistributionLedger(payload.Deserialize<DistributionLedgerRequest>(JsonOptions) ?? throw new JsonException());
            UploadResultRequest request=payload.Deserialize<UploadResultRequest>(JsonOptions) ?? throw new JsonException();
            return store.RecordUploadResult(request);
        }
        catch(JsonException) {throw new GoogleCatalogueControllerException("invalid-upload-result");}
        catch(WorkbookProjectionException exception) {throw new GoogleCatalogueControllerException(exception.Code);}
    }
    internal object Handle(string operation,JsonElement payload)
    {
        if(operation=="recordUploadResult") return RecordResult(payload);
        if(operation=="getUploadThumbnailOptions") return thumbnails.List(payload);
        if(operation=="getUploadThumbnailPreview") return thumbnails.Preview(payload);
        if(payload.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)
            && (payload.ValueKind!=JsonValueKind.Object || payload.EnumerateObject().Any()))
            throw new GoogleCatalogueControllerException("invalid-payload");
        return operation switch
        {
            "getCatalogue"=>store.GetCatalogue(),
            "getUploadCatalogueSnapshot"=>GetSnapshot(),
            "getSubredditPresets"=>GetSubredditPresets(),
            _=>throw new GoogleCatalogueControllerException("unsupported-operation"),
        };
    }
}
