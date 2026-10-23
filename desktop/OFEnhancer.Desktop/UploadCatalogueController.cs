using System.Text.Json;
using System.Text.Json.Serialization;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed class UploadCatalogueController(CatalogueStore store, Func<GoogleSubredditPresetSnapshot>? readSubredditPresets=null,
    Func<UploadResultRequest, UploadResult, UploadResult>? writeback=null, Action? refreshCatalogue=null,
    Func<GoogleCatalogueStatusView>? retryWritebacks=null)
{
    private readonly UploadThumbnailCatalogue thumbnails = new(store);
    private static readonly JsonSerializerOptions JsonOptions=new()
    {
        PropertyNamingPolicy=JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow,
        MaxDepth=8,
    };

    internal UploadCatalogueSnapshot GetSnapshot()
    {
        refreshCatalogue?.Invoke();
        return store.GetUploadCatalogueSnapshot();
    }
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
            UploadResult result = store.RecordUploadResult(request);
            return result.Status is "recorded-local" or "idempotent" && writeback is not null
                ? writeback(request, result) : result;
        }
        catch(JsonException) {throw new GoogleCatalogueControllerException("invalid-upload-result");}
        catch(WorkbookProjectionException exception) {throw new GoogleCatalogueControllerException(exception.Code);}
    }
    internal object Handle(string operation,JsonElement payload)
    {
        if(operation=="recordCreatorWorkflow")
        {
            try
            {
                CreatorWorkflowSnapshot snapshot=payload.Deserialize<CreatorWorkflowSnapshot>(JsonOptions) ?? throw new JsonException();
                CreatorWorkflowRecordResult result=store.RecordCreatorWorkflow(snapshot);
                if(result.Status is "recorded" or "idempotent" && snapshot.Kind=="social"
                    && snapshot.Clip is { Sha256: not null, ClipId: not null } clip
                    && snapshot.SourceKey is not null && snapshot.Reply?.MainStatusUrl is string statusUrl
                    && long.TryParse(clip.ClipId,out long clipId))
                {
                    try { store.RecordPublishedTeaserClip(clipId,clip.Sha256,snapshot.SourceKey,statusUrl); }
                    catch(XTeaserException error) { return result with { Status="conflict",Code=error.Code }; }
                }
                return result;
            }
            catch(JsonException) {throw new GoogleCatalogueControllerException("creator-workflow-invalid");}
            catch(CreatorWorkflowException error) {throw new GoogleCatalogueControllerException(error.Code);}
        }
        if(operation=="getCreatorWorkflows")
        {
            try
            {
                WorkflowQuery query=payload.Deserialize<WorkflowQuery>(JsonOptions) ?? throw new JsonException();
                if(query.UnboundOnly && query.SourceKey is not null) throw new JsonException();
                return query.UnboundOnly ? store.GetUnassignedCreatorWorkflows(query.Offset,query.Limit)
                    : store.GetCreatorWorkflows(query.SourceKey,offset:query.Offset,limit:query.Limit);
            }
            catch(JsonException) {throw new GoogleCatalogueControllerException("invalid-payload");}
            catch(CreatorWorkflowException error) {throw new GoogleCatalogueControllerException(error.Code);}
        }
        if(operation=="associateCreatorWorkflow")
        {
            try
            {
                WorkflowAssociation query=payload.Deserialize<WorkflowAssociation>(JsonOptions) ?? throw new JsonException();
                if(!query.ConfirmSource) throw new JsonException();
                CreatorWorkflowAssociationResult association=store.AssociateCreatorWorkflow(query.RunId,query.SourceKey,query.ExpectedFingerprint);
                if(writeback is null || association.Status is "conflict" or "stale") return association;
                UploadCatalogueRow row=store.GetUploadCatalogueSnapshot().Rows.Single(value=>value.Id==query.SourceKey);
                return association with { Results=[..association.Results.Select(value=>value with
                {
                    Result=value.Result.Status is "recorded-local" or "idempotent"
                        ? writeback(new(row.Row,row.Fingerprint,value.Platform,value.Url,Id:row.Id,ItemId:row.ItemId,
                            Destination:association.Snapshot.Destination),value.Result)
                        : value.Result,
                })] };
            }
            catch(JsonException) {throw new GoogleCatalogueControllerException("invalid-payload");}
            catch(CreatorWorkflowException error) {throw new GoogleCatalogueControllerException(error.Code);}
            catch(WorkbookProjectionException error) {throw new GoogleCatalogueControllerException(error.Code);}
        }
        if(operation=="rebaseUploadWriteback")
        {
            try
            {
                WritebackRebase query=payload.Deserialize<WritebackRebase>(JsonOptions) ?? throw new JsonException();
                if(!query.ConfirmCurrentDetails) throw new JsonException();
                return store.RebaseUploadSheetWriteback(query.Key,query.ExpectedFingerprint);
            }
            catch(JsonException) {throw new GoogleCatalogueControllerException("invalid-payload");}
            catch(WorkbookProjectionException error) {throw new GoogleCatalogueControllerException(error.Code);}
        }
        if(operation=="recordUploadResult") return RecordResult(payload);
        if(operation=="getUploadThumbnailOptions") return thumbnails.List(payload);
        if(operation=="getUploadThumbnailPreview") return thumbnails.Preview(payload);
        if(operation=="getCatalogueThumbnailPreviews") return thumbnails.CataloguePreviews(payload);
        if(payload.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)
            && (payload.ValueKind!=JsonValueKind.Object || payload.EnumerateObject().Any()))
            throw new GoogleCatalogueControllerException("invalid-payload");
        return operation switch
        {
            "getCatalogue"=>store.GetCatalogue(),
            "getUploadCatalogueSnapshot"=>GetSnapshot(),
            "getSubredditPresets"=>GetSubredditPresets(),
            "getUploadWritebacks"=>store.GetGoogleCatalogueSelection() is { } selection
                ? store.GetUploadSheetWritebackDetails(selection.WorkbookId) : [],
            "getCreatorWorkflowWritebacks"=>store.GetGoogleCatalogueSelection() is { } workflowSelection
                ? store.GetCreatorWorkflowProjectionIntents(workflowSelection.WorkbookId) : [],
            "retryUploadWritebacks"=>retryWritebacks?.Invoke()
                ?? throw new GoogleCatalogueControllerException("google-catalogue-unavailable"),
            _=>throw new GoogleCatalogueControllerException("unsupported-operation"),
        };
    }
    private sealed record WorkflowQuery(string? SourceKey=null,bool UnboundOnly=false,int Offset=0,int Limit=25);
    private sealed record WorkflowAssociation(string RunId,string SourceKey,string ExpectedFingerprint,bool ConfirmSource=false);
    private sealed record WritebackRebase(string Key,string ExpectedFingerprint,bool ConfirmCurrentDetails=false);
}
