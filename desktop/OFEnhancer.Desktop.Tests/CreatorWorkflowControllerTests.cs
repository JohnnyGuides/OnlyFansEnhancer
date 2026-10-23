using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class CreatorWorkflowControllerTests
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase };

    [TestMethod]
    public void NativeMirrorKeepsPartialResultsAndRequiresConfirmedFingerprintForRecovery()
    {
        using TestDirectory temp=new();
        using CatalogueStore store=OpenStore(temp.Path);
        UploadCatalogueController native=new(store);
        CreatorWorkflowSnapshot snapshot=new("upload-recovery-001","upload",1,null,
            [new("onlyfans","failed",Error:"provider-failed"),new("fansly","uploaded","https://fansly.com/post/500")],
            [new("video","episode.mp4",128,DateTimeOffset.Parse("2026-10-23T10:00:00Z"))],
            new("partial","episode.funscript",Links:["https://johnnyguides.com/sync/scripts/episode.funscript"],SentKeys:["fansly_500"]));
        CreatorWorkflowRecordResult receipt=(CreatorWorkflowRecordResult)native.Handle("recordCreatorWorkflow",Payload(snapshot));
        Assert.AreEqual("recorded",receipt.Status);
        Assert.AreEqual("idempotent",((CreatorWorkflowRecordResult)native.Handle("recordCreatorWorkflow",Payload(snapshot))).Status);
        CreatorWorkflowPage page=(CreatorWorkflowPage)native.Handle("getCreatorWorkflows",Payload(new {unboundOnly=true,limit=25}));
        Assert.AreEqual(1,page.TotalCount);
        Assert.AreEqual("failed",page.Items[0].Targets[0].Status);
        Assert.AreEqual("partial",page.Items[0].Script!.Status);
        UploadCatalogueRow row=store.GetUploadCatalogueSnapshot().Rows.Single();
        AssertCode(()=>native.Handle("associateCreatorWorkflow",Payload(new {runId=snapshot.RunId,sourceKey=row.Id,expectedFingerprint=row.Fingerprint})),"invalid-payload");
        CreatorWorkflowAssociationResult stale=(CreatorWorkflowAssociationResult)native.Handle("associateCreatorWorkflow",
            Payload(new {runId=snapshot.RunId,sourceKey=row.Id,expectedFingerprint=new string('0',64),confirmSource=true}));
        Assert.AreEqual("stale",stale.Status);
        CreatorWorkflowAssociationResult bound=(CreatorWorkflowAssociationResult)native.Handle("associateCreatorWorkflow",
            Payload(new {runId=snapshot.RunId,sourceKey=row.Id,expectedFingerprint=row.Fingerprint,confirmSource=true}));
        Assert.AreEqual("recorded",bound.Status);
        Assert.AreEqual(2,bound.Results.Count);
        Assert.IsTrue(bound.Results.All(value=>value.Result.Status=="recorded-local"));
        Assert.AreEqual("partial",store.GetUploadCatalogueSnapshot().Rows.Single().ScriptStatus);
        // The source is now known, but this fixture has no Google import provenance.
        // Keep it in recovery until the owner can bind a proven workbook destination.
        CreatorWorkflowPage unfinished=store.GetUnassignedCreatorWorkflows();
        Assert.AreEqual(1,unfinished.TotalCount);
        Assert.AreEqual(row.Id,unfinished.Items.Single().SourceKey);
        Assert.IsNull(unfinished.Items.Single().Destination);
        Assert.AreEqual("https://fansly.com/post/500",store.GetUploadCatalogueSnapshot().Rows.Single().FanslyLink);
        Assert.AreEqual("",store.GetUploadCatalogueSnapshot().Rows.Single().OnlyfansLink);
        AssertCode(()=>native.Handle("getCreatorWorkflows",Payload(new {unboundOnly=true,sourceKey=row.Id})),"invalid-payload");
        AssertCode(()=>native.Handle("getCreatorWorkflows",Payload(new {limit=51})),"creator-workflow-page-invalid");
        AssertCode(()=>native.Handle("recordCreatorWorkflow",Payload(new {runId="raw",accessToken="must-not-persist"})),"creator-workflow-invalid");
    }

    [TestMethod]
    public void WebRecoveryUsesTheSameControllerAndDoesNotClaimUnavailableGoogleSync()
    {
        using TestDirectory temp=new();
        using CatalogueStore store=OpenStore(temp.Path);
        WebMessageRouter web=new(_=>Assert.Fail(),()=>null,store);
        UploadCatalogueController native=new(store);
        CreatorWorkflowSnapshot snapshot=new("upload-web-001","upload",1,null,[],[]);
        native.Handle("recordCreatorWorkflow",Payload(snapshot));
        using JsonDocument page=JsonDocument.Parse(web.Handle(Request("getCreatorWorkflows",new {unboundOnly=true})));
        Assert.IsTrue(page.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(1,page.RootElement.GetProperty("result").GetProperty("totalCount").GetInt32());
        using JsonDocument pending=JsonDocument.Parse(web.Handle(Request("getUploadWritebacks",new {})));
        Assert.AreEqual(0,pending.RootElement.GetProperty("result").GetArrayLength());
        AssertWebError(web,"associateCreatorWorkflow",new {runId=snapshot.RunId,sourceKey="episode-a",expectedFingerprint=new string('0',64)},"invalid-payload");
        AssertWebError(web,"rebaseUploadWriteback",new {key="missing",expectedFingerprint=new string('0',64)},"invalid-payload");
        AssertWebError(web,"rebaseUploadWriteback",new {key="missing",expectedFingerprint=new string('0',64),confirmCurrentDetails=true},"upload-sheet-writeback-not-found");
        AssertWebError(web,"retryUploadWritebacks",new {},"google-catalogue-unavailable");
    }

    private static CatalogueStore OpenStore(string path)
    {
        CatalogueStore store=CatalogueStore.Open(System.IO.Path.Combine(path,"catalogue.db"));
        try
        {
            store.ImportSnapshot("""{"version":1,"items":[{"sourceKey":"episode-a","sourceRow":4,"title":"Neutral episode","description":"","plannedDate":"2026-10-23","series":"Neutral","episode":"1","xTeasers":0,"redditTeasers":0,"platformLinks":{}}]}""");
            return store;
        }
        catch {store.Dispose();throw;}
    }
    private static JsonElement Payload(object value)=>JsonSerializer.SerializeToElement(value,JsonOptions);
    private static string Request(string operation,object payload)=>JsonSerializer.Serialize(new {requestId=Guid.NewGuid().ToString(),operation,payload});
    private static void AssertCode(Action action,string code)=>Assert.AreEqual(code,Assert.ThrowsException<GoogleCatalogueControllerException>(action).Code);
    private static void AssertWebError(WebMessageRouter router,string operation,object payload,string code)
    {
        using JsonDocument result=JsonDocument.Parse(router.Handle(Request(operation,payload)));
        Assert.IsFalse(result.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(code,result.RootElement.GetProperty("error").GetProperty("code").GetString());
    }
    private sealed class TestDirectory : IDisposable
    {
        internal string Path {get;}=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"OFEnhancerWorkflowBridge",Guid.NewGuid().ToString("N"));
        internal TestDirectory()=>Directory.CreateDirectory(Path);
        public void Dispose()
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(Path,recursive:true);
        }
    }
}
