using System.Text.Json;
using System.Text.Json.Serialization;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

// Desktop end of the passive X collector: strict parsing of one
// recordXObservations payload into the catalogue's X tables.
internal sealed class XObservationController(CatalogueStore store, Func<DateTimeOffset>? clock=null,
    XScanActivityBoard? scanActivity=null, DateTimeOffset? startedUtc=null)
{
    // When this OFEnhancer process started: the scanner runs one scan after each start.
    private readonly DateTimeOffset started=(startedUtc ?? (clock ?? (() => DateTimeOffset.UtcNow))()).ToUniversalTime();

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

    // The owner's current scheduled-post list, read by the collector on X's scheduled page.
    internal XScheduledResult RecordScheduled(JsonElement payload) => Parse<XScheduledBatch, XScheduledResult>(payload,
        "invalid-x-scheduled", batch => store.RecordXScheduledPosts(batch,Now));

    // The background scanner's per-tick question: owner, pending request, recent post times.
    internal XScanPlan ScanPlan(JsonElement payload)
    {
        if(payload.ValueKind!=JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-x-scan");
        return store.GetXScanPlan(Now) with {DesktopStartedUtc=started.ToString("O",System.Globalization.CultureInfo.InvariantCulture)};
    }

    // The scanner's live log, kept in memory for the workspace's Twitter view.
    internal XScanActivity RecordActivity(JsonElement payload) =>
        Parse<XScanActivity, XScanActivity>(payload, "invalid-x-scan-activity",
            activity => (scanActivity ?? throw new GoogleCatalogueControllerException("unsupported-operation")).Record(activity));

    internal XScanStatus RecordScan(JsonElement payload) =>
        Parse<XScanReport, XScanStatus>(payload, "invalid-x-scan", store.RecordXScanResult);

    private DateTimeOffset Now => (clock ?? (() => DateTimeOffset.UtcNow))();

    private static TResult Parse<TPayload, TResult>(JsonElement payload, string invalid, Func<TPayload, TResult> apply)
        where TPayload : class
    {
        try
        {
            if(payload.ValueKind!=JsonValueKind.Object) throw new JsonException();
            TPayload value=payload.Deserialize<TPayload>(JsonOptions) ?? throw new JsonException();
            return apply(value);
        }
        catch(JsonException) {throw new GoogleCatalogueControllerException(invalid);}
        catch(XObservationException exception) {throw new GoogleCatalogueControllerException(exception.Code);}
    }
}
