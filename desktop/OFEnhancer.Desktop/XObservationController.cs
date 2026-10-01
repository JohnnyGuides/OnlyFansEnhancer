using System.Text.Json;
using System.Text.Json.Serialization;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

// Desktop end of the passive X collector: strict parsing of one
// recordXObservations payload into the catalogue's X tables.
internal sealed class XObservationController(CatalogueStore store, Func<DateTimeOffset>? clock=null)
{
    private static readonly JsonSerializerOptions JsonOptions=new()
    {
        PropertyNamingPolicy=JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow,
        MaxDepth=8,
    };

    internal XObservationResult Record(JsonElement payload)
    {
        try
        {
            if(payload.ValueKind!=JsonValueKind.Object) throw new JsonException();
            XObservationBatch batch=payload.Deserialize<XObservationBatch>(JsonOptions) ?? throw new JsonException();
            return store.RecordXObservations(batch,(clock ?? (() => DateTimeOffset.UtcNow))());
        }
        catch(JsonException) {throw new GoogleCatalogueControllerException("invalid-x-observations");}
        catch(XObservationException exception) {throw new GoogleCatalogueControllerException(exception.Code);}
    }
}
