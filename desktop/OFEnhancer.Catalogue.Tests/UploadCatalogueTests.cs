namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class UploadCatalogueTests
{
    [TestMethod]
    public void ConfirmedRepeatPreservesOriginalAndNewLinksWithoutHidingFutureConflicts()
    {
        using TestStore test = new();
        test.Import(new Dictionary<string,string>{["fansly"]="https://fansly.com/post/111111111"});
        var row=test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        var request=new UploadResultRequest(row.Row,row.Fingerprint,"fansly","https://fansly.com/post/222222222",Id:row.Id);
        Assert.AreEqual("conflict",test.Store.RecordUploadResult(request).Status);
        Assert.AreEqual("recorded-local",test.Store.RecordUploadResult(request with {RepeatUploadConfirmed=true}).Status);
        var updated=test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        Assert.AreEqual("published",updated.PublicationState["fansly"]);
        Assert.AreEqual("https://fansly.com/post/111111111",updated.FanslyLink);
        Assert.AreEqual(2,test.Store.GetItems().Single().SourceLinkCells!["fansly"].Urls.Count);
        Assert.AreEqual("idempotent",test.Store.RecordUploadResult(request with {RepeatUploadConfirmed=true}).Status);
        test.Import(new Dictionary<string,string>{["fansly"]="https://fansly.com/post/333333333"});
        Assert.AreEqual("review",test.Store.GetUploadCatalogueSnapshot().Rows.Single().PublicationState["fansly"]);
    }

    [TestMethod]
    public void SourceConflictIsReviewAndCannotBeOverwrittenByResult()
    {
        using TestStore test = new();
        var row = test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        Assert.AreEqual("review", row.PublicationState["onlyfans"]);
        Assert.AreEqual("", row.OnlyfansLink);
        var result = test.Store.RecordUploadResult(new(row.Row, row.Fingerprint, "onlyfans",
            "https://onlyfans.com/333333333/creator", new(row.Id), row.ItemId));
        Assert.AreEqual("conflict", result.Status);
        Assert.AreEqual(0, test.Store.GetGoogleBindings("work").Count);
    }

    [TestMethod]
    public void MatchingResultRecordsLocallyAndIdempotentRetryDoesNotOverwriteNewerLinks()
    {
        using TestStore test = new();
        var row = test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        var request = new UploadResultRequest(row.Row, row.Fingerprint, "fansly", "https://fansly.com/post/123456789", new(row.Id), row.ItemId);
        var result = test.Store.RecordUploadResult(request);
        Assert.AreEqual("recorded-local", result.Status);
        Assert.IsFalse(result.GoogleSynced);
        Assert.AreEqual("https://fansly.com/post/123456789", test.Store.GetItems().Single().PlatformLinks["fansly"]);
        Assert.AreNotEqual(row.Fingerprint, result.Fingerprint);
        Assert.AreEqual("idempotent", test.Store.RecordUploadResult(request).Status);
        Assert.AreEqual("stale", test.Store.RecordUploadResult(request with { Platform="manyvids", PostUrl="https://www.manyvids.com/Video/123456789" }).Status);
        Assert.AreEqual(0, test.Store.GetOpenSyncOperations().Count);
    }

    [TestMethod]
    public void LocalResultSurvivesReimportAndConflictingGoogleEvidenceRequiresReview()
    {
        using TestStore test=new();
        var row=test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        test.Store.RecordUploadResult(new(row.Row,row.Fingerprint,"fansly","https://fansly.com/post/123456789",Id:row.Id));
        test.Import();
        Assert.AreEqual("https://fansly.com/post/123456789",test.Store.GetUploadCatalogueSnapshot().Rows.Single().FanslyLink);
        test.Import(new Dictionary<string,string>{["fansly"]="https://fansly.com/post/999999999"});
        var conflict=test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        Assert.AreEqual("review",conflict.PublicationState["fansly"]);
        Assert.AreEqual(2,test.Store.GetItems().Single().SourceLinkCells!["fansly"].Urls.Count);
        using CatalogueStore reopened=CatalogueStore.Open(test.Store.DatabasePath);
        Assert.AreEqual(conflict.Fingerprint,reopened.GetUploadCatalogueSnapshot().Rows.Single().Fingerprint);
        Assert.AreEqual(0,reopened.GetOpenSyncOperations().Count);
    }

    [TestMethod]
    public void SocialAppendPreservesImportedAndRecordedUrlsAndDerivesCount()
    {
        using TestStore test=new();
        test.Import(new Dictionary<string,string>{["x"]="https://x.com/creator/status/111111111"});
        var row=test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        var result=test.Store.RecordUploadResult(new(row.Row,row.Fingerprint,"x","https://x.com/creator/status/222222222",Id:row.Id,Action:"appendTwitterTeaser"));
        Assert.AreEqual("recorded-local",result.Status);
        var item=test.Store.GetItems().Single();
        Assert.AreEqual(2,item.XTeasers);
        CollectionAssert.AreEquivalent(new[]{"https://x.com/creator/status/111111111","https://x.com/creator/status/222222222"},item.SourceLinkCells!["x"].Urls.ToArray());
    }

    [TestMethod]
    public void LedgerIsBoundedIdempotentAuditAndDoesNotEstablishPublication()
    {
        using TestStore test=new();
        var before=test.Store.GetUploadCatalogueSnapshot().Rows.Single();
        DistributionLedgerRequest request=new("published","run_123456","x","x",before.Row,before.Id,"123456789",
            "https://x.com/creator/status/123456789","published",1789000000000,"appendDistributionLedger","https://x.com/creator/status/123456789");
        Assert.AreEqual("recorded-local",test.Store.RecordDistributionLedger(request).Status);
        Assert.AreEqual("idempotent",test.Store.RecordDistributionLedger(request).Status);
        Assert.AreEqual("conflict",test.Store.RecordDistributionLedger(request with{ResultId="987654321"}).Status);
        Assert.AreEqual(before.Fingerprint,test.Store.GetUploadCatalogueSnapshot().Rows.Single().Fingerprint);
        Assert.AreEqual("stale",test.Store.RecordDistributionLedger(request with{CatalogueId="other"}).Status);
        Assert.ThrowsException<WorkbookProjectionException>(()=>test.Store.RecordDistributionLedger(request with{PostUrl="https://evil.test"}));
        Assert.AreEqual(0,test.Store.GetOpenSyncOperations().Count);
    }

    private sealed class TestStore : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "ofe-upload-" + Guid.NewGuid().ToString("N"));
        internal CatalogueStore Store { get; }
        internal TestStore()
        {
            Directory.CreateDirectory(root);
            Store=CatalogueStore.Open(Path.Combine(root,"catalogue.db"));
            Import();
        }
        internal void Import(IReadOnlyDictionary<string,string>? links=null)
        {
            Store.ImportWorkbookProjection(new("work","1",true,[new(2,"episode","Title","Description","2026-09-11",null,null,0,0,
                links ?? new Dictionary<string,string>(),null,new Dictionary<string,CatalogueSourceLinkCell>
                { ["onlyfans"]=new("https://onlyfans.com/111111111/creator","https://onlyfans.com/222222222/creator",
                    ["https://onlyfans.com/111111111/creator","https://onlyfans.com/222222222/creator"],"catalogue-link-conflict") })]),false);
        }
        public void Dispose() { Store.Dispose(); Directory.Delete(root,true); }
    }
}
