namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CreatorWorkflowsTests
{
    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
            "OFEnhancerCreatorWorkflowTests", Guid.NewGuid().ToString("N"));

        internal TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private static readonly DateTimeOffset FileTime = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
    private const string ScriptUrl = "https://johnnyguides.com/sync/scripts/episode-1.funscript";

    [TestMethod]
    public void NewerRevisionWinsStaleRetryIsIgnoredAndLatestSnapshotSurvivesRestart()
    {
        using TempDirectory temp = new();
        string path = System.IO.Path.Combine(temp.Path, "catalogue.db");
        CreatorWorkflowSnapshot first = Snapshot("run-0001", 1, "episode-a");
        CreatorWorkflowSnapshot second = first with { Revision = 2, Targets = [new("fansly", "uploaded", "https://fansly.com/post/500")] };
        using (CatalogueStore store = StoreWithItems(path))
        {
            Assert.AreEqual("recorded", store.RecordCreatorWorkflow(first).Status);
            Assert.AreEqual("idempotent", store.RecordCreatorWorkflow(first).Status);
            Assert.AreEqual("recorded", store.RecordCreatorWorkflow(second).Status);
            Assert.AreEqual("stale", store.RecordCreatorWorkflow(first).Status);
            Assert.AreEqual("conflict", store.RecordCreatorWorkflow(second with { Script = new("failed") }).Status);
        }

        using CatalogueStore reopened = CatalogueStore.Open(path);
        CreatorWorkflowSnapshot saved = reopened.GetCreatorWorkflows("episode-a").Single();
        Assert.AreEqual(2L, saved.Revision);
        Assert.AreEqual("https://fansly.com/post/500", saved.Targets.Single().PostUrl);
        Assert.AreEqual(10, reopened.SchemaVersion);
    }

    [TestMethod]
    public void RunCannotBeReassociatedButMayBindOnceOnANewerRevision()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot original = Snapshot("run-0002", 1, "episode-a");
        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(original).Status);

        CreatorWorkflowRecordResult rewired = store.RecordCreatorWorkflow(original with { Revision = 2, SourceKey = "episode-b" });
        Assert.AreEqual("conflict", rewired.Status);
        Assert.AreEqual("creator-workflow-identity-conflict", rewired.Code);
        Assert.AreEqual("episode-a", store.GetCreatorWorkflows("episode-a").Single().SourceKey);
        Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflow(
            original with { RunId = "run-unknown", SourceKey = "missing-episode" }));

        CreatorWorkflowSnapshot unbound = Snapshot("run-0003", 1, null);
        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(unbound).Status);
        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(unbound with { Revision = 2, SourceKey = "episode-a" }).Status);
        Assert.AreEqual("episode-a", store.GetCreatorWorkflows("episode-a").Single(value => value.RunId == unbound.RunId).SourceKey);
        CreatorWorkflowRecordResult rebound = store.RecordCreatorWorkflow(unbound with { Revision = 3, SourceKey = "episode-b" });
        Assert.AreEqual("conflict", rebound.Status);
        Assert.AreEqual("creator-workflow-identity-conflict", rebound.Code);
        Assert.AreEqual("episode-a", store.GetCreatorWorkflows("episode-a").Single(value => value.RunId == unbound.RunId).SourceKey);
    }

    [TestMethod]
    public void SocialReplyAcceptsConfiguredPaidProfilesAndCanonicalPaidPlatformLinksWithoutSecrets()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        string[] accepted =
        [
            "https://onlyfans.com/johnny_guides",
            "https://fansly.com/Johnny_Guides/posts",
            "https://www.manyvids.com/Video/12345/sample-title/",
            "https://www.pornhub.com/view_video.php?viewkey=publicKey_123",
            "https://onlyfans.com/12345/johnny_guides",
            "https://fansly.com/post/12345",
        ];
        for (int index = 0; index < accepted.Length; index++)
        {
            CreatorWorkflowSnapshot snapshot = Snapshot($"paid-{index:0000}", 1, "episode-a") with
            {
                Kind = "social",
                Reply = new(accepted[index], false, 0),
            };
            CreatorWorkflowRecordResult result = store.RecordCreatorWorkflow(snapshot);
            Assert.AreEqual("recorded", result.Status);
            if (index < 2) Assert.AreEqual(accepted[index], result.Snapshot.Reply?.PaidUrl);
        }

        foreach (string rejected in new[]
        {
            "https://user:password@onlyfans.com/johnny_guides",
            "https://onlyfans.com:444/johnny_guides",
            "https://onlyfans.com/johnny_guides?token=secret",
            "https://fansly.com/Johnny_Guides/posts?token=secret",
            "https://www.pornhub.com/view_video.php?viewkey=publicKey_123&token=secret",
        })
        {
            Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflow(
                Snapshot($"bad-{Guid.NewGuid():N}", 1, "episode-a") with
                {
                    Kind = "social",
                    Reply = new(rejected, false, 0),
                }));
        }
    }

    [TestMethod]
    public void WorkflowSummaryNeverTreatsPendingAsPublishedAndUsesKnownScriptLinksForPartialAndUploaded()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot pending = Snapshot("run-0004", 1, "episode-a") with
        {
            Script = new("pending", Filename: "episode-1.funscript", Links: [ScriptUrl]),
        };
        store.RecordCreatorWorkflow(pending);
        CreatorWorkflowSummary selected = store.GetCreatorWorkflowSummary("episode-a");
        Assert.AreEqual("selected", selected.ScriptStatus);
        Assert.AreEqual(0, selected.KnownScriptLinkCount, "a pending workflow's candidate URL is not publication evidence");
        Assert.AreEqual("selected", store.GetCreatorScriptStatuses()["episode-a"]);

        CreatorWorkflowSnapshot uploaded = pending with { Revision = 2, Script = new("uploaded", Links: [ScriptUrl]) };
        store.RecordCreatorWorkflow(uploaded);
        CreatorWorkflowSummary complete = store.GetCreatorWorkflowSummary("episode-a");
        Assert.AreEqual("uploaded", complete.ScriptStatus);
        Assert.AreEqual(1, complete.KnownScriptLinkCount);
        Assert.AreEqual(ScriptUrl, complete.KnownScriptLinks.Single());
        Assert.AreEqual("uploaded", store.GetCreatorScriptStatuses()["episode-a"]);

        CreatorWorkflowSnapshot partial = uploaded with { Revision = 3, Script = new("partial", Links: [ScriptUrl, ScriptUrl.Replace("episode-1", "episode-2")], SentKeys: ["episode-1"]) };
        store.RecordCreatorWorkflow(partial);
        CreatorWorkflowSummary partialSummary = store.GetCreatorWorkflowSummary("episode-a");
        Assert.AreEqual("partial", partialSummary.ScriptStatus);
        Assert.AreEqual(2, partialSummary.KnownScriptLinkCount);
        Assert.AreEqual("partial", store.GetCreatorScriptStatuses()["episode-a"]);
    }

    [TestMethod]
    public void ScriptWritebackStateIsValidatedAndSurvivesReadback()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot snapshot = Snapshot("run-writeback-state", 1, "episode-a") with
        {
            Script = new("uploaded", Links: [ScriptUrl], WritebackState: "pending"),
        };

        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(snapshot).Status);
        Assert.AreEqual("pending", store.GetCreatorWorkflows("episode-a").Single().Script?.WritebackState);
        Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflow(
            snapshot with { RunId = "run-writeback-state-invalid", Script = new("uploaded", WritebackState: "retrying") }));
    }

    [TestMethod]
    public void FailedWithoutKnownLinkIsFailedAndMalformedOrPathBearingSnapshotIsRejected()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot failed = Snapshot("run-0005", 1, "episode-b") with { Script = new("failed", Error: "upload_failed") };
        store.RecordCreatorWorkflow(failed);
        Assert.AreEqual("failed", store.GetCreatorWorkflowSummary("episode-b").ScriptStatus);
        Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflow(
            Snapshot("run-0006", 1, "episode-a") with { Assets = [new("video", "C:\\secret\\video.mp4", 1, FileTime)] }));
        Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflow(
            Snapshot("run-0007", 1, "episode-a") with { Targets = [new("fansly", "uploaded", "https://evil.example/post/500")] }));
    }

    [TestMethod]
    public void UnboundWorkflowListIsCappedAtFiftyMostRecentSnapshots()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        for (int index = 0; index < 55; index++)
            store.RecordCreatorWorkflow(Snapshot($"run-{index:0000}", 1, null));

        Assert.AreEqual(50, store.GetCreatorWorkflows().Count);
        CreatorWorkflowPage firstPage = store.GetUnassignedCreatorWorkflows();
        CreatorWorkflowPage secondPage = store.GetUnassignedCreatorWorkflows(offset: 25);
        Assert.AreEqual(55, firstPage.TotalCount);
        Assert.AreEqual(25, firstPage.Items.Count);
        Assert.AreEqual(25, secondPage.Items.Count);
    }

    [TestMethod]
    public void UnassignedWorkflowPageReportsTotalAndAssociationRecordsOnlyVerifiedResultsPerUrl()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        store.ImportWorkbookProjection(new("work", "1", true,
        [
            new(2, "episode-a", "Episode A", "Description", null, null, null, 0, 0,
                new Dictionary<string, string> { ["onlyfans"] = "https://onlyfans.com/500/johnny_guides" }, null),
            new(3, "episode-b", "Episode B", "Description", null, null, null, 0, 0,
                new Dictionary<string, string>(), null),
        ]), updateGoogleBindings: false);
        store.SaveGoogleCatalogueWorkbook("work", "Current workbook");
        CreatorWorkflowSnapshot unbound = Snapshot("run-associate-01", 1, null) with
        {
            Targets = [
                new("onlyfans", "uploaded", "https://onlyfans.com/600/johnny_guides"),
                new("fansly", "failed"),
            ],
            Script = new("uploaded", Links: [ScriptUrl]),
        };
        store.RecordCreatorWorkflow(unbound);
        CreatorWorkflowPage page = store.GetUnassignedCreatorWorkflows(limit: 1);
        Assert.AreEqual(1, page.TotalCount);
        Assert.AreEqual(unbound.RunId, page.Items.Single().RunId);

        UploadCatalogueRow row = store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a");
        Assert.AreEqual(new UploadCatalogueDestination("work", "1"), row.Destination);
        CreatorWorkflowAssociationResult associated = store.AssociateCreatorWorkflow(unbound.RunId, "episode-a", row.Fingerprint);
        Assert.AreEqual("partial", associated.Status);
        Assert.AreEqual("episode-a", associated.Snapshot.SourceKey);
        Assert.AreEqual(row.Destination, associated.Snapshot.Destination,
            "owner-confirmed association freezes the current complete projection destination");
        Assert.AreEqual(2, associated.Results.Count);
        Assert.AreEqual("conflict", associated.Results.Single(value => value.Platform == "onlyfans").Result.Status,
            "the conflicting same-platform receipt remains visible rather than being overwritten");
        Assert.AreEqual("recorded-local", associated.Results.Single(value => value.Platform == "script").Result.Status);
        Assert.AreEqual("work", associated.Results.Single(value => value.Platform == "script").Result.SheetWriteback!.WorkbookId);
        Assert.AreEqual("uploaded", store.GetCreatorWorkflowSummary("episode-a").ScriptStatus);
        UploadCatalogueRow afterAssociation = store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a");
        CreatorWorkflowAssociationResult retry = store.AssociateCreatorWorkflow(unbound.RunId, "episode-a", afterAssociation.Fingerprint);
        Assert.AreEqual("partial", retry.Status);
        Assert.AreEqual("idempotent", retry.Results.Single(value => value.Platform == "script").Result.Status,
            "retrying owner association reconciles already-recorded URLs idempotently without a browser rerun");
        Assert.AreEqual("conflict", store.AssociateCreatorWorkflow(unbound.RunId, "episode-b", row.Fingerprint).Status);
    }

    [TestMethod]
    public void KnownSourceLegacyWorkflowIsExposedForExplicitDestinationBindingAndAppendsAllRedditOrXUrls()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        store.ImportWorkbookProjection(new("workbook", "1", true,
        [
            new(2, "episode-a", "Episode A", "Description", null, null, null, 0, 0,
                new Dictionary<string, string> { ["x"] = "https://x.com/owner/status/111" }, null),
            new(3, "episode-b", "Episode B", "Description", null, null, null, 0, 0,
                new Dictionary<string, string>(), null),
        ]), updateGoogleBindings: false);
        store.SaveGoogleCatalogueWorkbook("workbook", "Current workbook");
        CreatorWorkflowSnapshot legacy = Snapshot("run-known-unbound", 1, "episode-a") with
        {
            Targets = [new("x", "uploaded", "https://x.com/owner/status/111", PostUrls:
                ["https://x.com/owner/status/111", "https://x.com/owner/status/222", "https://x.com/owner/status/333", "https://x.com/owner/status/333"])],
        };
        Assert.AreEqual("recorded", store.RecordCreatorWorkflow(legacy).Status);
        CreatorWorkflowPage reviewPage = store.GetUnassignedCreatorWorkflows();
        Assert.AreEqual(1, reviewPage.TotalCount, "a known source still needs explicit workbook association");
        Assert.AreEqual("run-known-unbound", reviewPage.Items.Single().RunId);
        Assert.AreEqual(3, reviewPage.Items.Single().Targets.Single().PostUrls!.Count,
            "canonical duplicate URLs are normalized once in the persisted snapshot");

        UploadCatalogueRow row = store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a");
        CreatorWorkflowAssociationResult associated = store.AssociateCreatorWorkflow(legacy.RunId, "episode-a", row.Fingerprint);

        Assert.AreEqual("recorded", associated.Status);
        Assert.AreEqual("idempotent", associated.Results.Single(value => value.Url.EndsWith("/111", StringComparison.Ordinal)).Result.Status);
        Assert.AreEqual("recorded-local", associated.Results.Single(value => value.Url.EndsWith("/333", StringComparison.Ordinal)).Result.Status,
            "additional X results append even when the source already has a published link");
        Assert.AreEqual(0, store.GetUnassignedCreatorWorkflows().TotalCount,
            "the owner association records a durable destination and removes the run from the review queue");

        Assert.ThrowsException<CreatorWorkflowException>(() => store.RecordCreatorWorkflow(
            Snapshot("run-bad-post-urls", 1, "episode-a") with
            {
                Targets = [new("x", "uploaded", PostUrls: ["https://evil.example/status/1"])],
            }));
    }

    [TestMethod]
    public void PartialRedditWorkflowPreservesAndAssociatesEveryCapturedPostUrl()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        const string existing = "https://www.reddit.com/r/example/comments/abc123/old-title";
        const string additional = "https://www.reddit.com/r/example/comments/def456/new-title";
        store.ImportWorkbookProjection(new("workbook", "1", true,
        [
            new(2, "episode-a", "Episode A", "Description", null, null, null, 0, 0,
                new Dictionary<string, string> { ["reddit"] = existing }, null),
            new(3, "episode-b", "Episode B", "Description", null, null, null, 0, 0,
                new Dictionary<string, string>(), null),
        ]), updateGoogleBindings: false);
        store.SaveGoogleCatalogueWorkbook("workbook", "Current workbook");
        CreatorWorkflowSnapshot partial = Snapshot("run-partial-reddit", 1, null) with
        {
            Targets = [new("reddit", "partial", existing, PostUrls: [existing, additional])],
        };
        store.RecordCreatorWorkflow(partial);
        UploadCatalogueRow row = store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a");

        CreatorWorkflowAssociationResult associated = store.AssociateCreatorWorkflow(partial.RunId, "episode-a", row.Fingerprint);

        Assert.AreEqual("partial", associated.Snapshot.Targets.Single().Status,
            "owner association must retain the browser's partial outcome");
        Assert.AreEqual(2, associated.Snapshot.Targets.Single().PostUrls!.Count);
        Assert.AreEqual("idempotent", associated.Results.Single(value => value.Url == existing).Result.Status);
        Assert.AreEqual("recorded-local", associated.Results.Single(value => value.Url == additional).Result.Status,
            "the Reddit append action records the additional successful URL despite existing posts");
        CollectionAssert.AreEquivalent(new[] { existing, additional }, store.GetUploadCatalogueSnapshot().Rows
            .Single(value => value.Id == "episode-a").RedditPosts.Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }

    [TestMethod]
    public void OwnerAssociationCannotRecordFrozenWorkbookResultsAgainstAnotherWorkbook()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot frozen = Snapshot("run-frozen-workbook", 1, "episode-a") with
        {
            Destination = new("original-workbook", "1"),
            Targets = [new("fansly", "uploaded", "https://fansly.com/post/500")],
        };
        store.RecordCreatorWorkflow(frozen);
        store.SaveGoogleCatalogueWorkbook("workbook", "Different workbook");
        UploadCatalogueRow row = store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a");
        Assert.AreEqual(new UploadCatalogueDestination("workbook", "1"), row.Destination);

        CreatorWorkflowAssociationResult result = store.AssociateCreatorWorkflow(frozen.RunId, row.Id, row.Fingerprint);

        Assert.AreEqual("conflict", result.Status);
        Assert.AreEqual("creator-workflow-destination-conflict", result.Code);
        Assert.AreEqual(frozen.Destination, result.Snapshot.Destination);
        Assert.AreEqual(0, result.Results.Count);
        Assert.AreEqual("", store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == row.Id).FanslyLink);
        Assert.AreEqual(0, store.GetUploadSheetWritebacks("workbook").Count);
        Assert.AreEqual(0, store.GetUploadSheetWritebacks("original-workbook").Count);
    }

    [TestMethod]
    public void StaleOwnerAssociationDoesNotBindRunOrRecordItsPublication()
    {
        using TempDirectory temp = new();
        using CatalogueStore store = StoreWithItems(System.IO.Path.Combine(temp.Path, "catalogue.db"));
        CreatorWorkflowSnapshot unbound = Snapshot("run-associate-02", 1, null) with
        {
            Targets = [new("fansly", "uploaded", "https://fansly.com/post/500")],
        };
        store.RecordCreatorWorkflow(unbound);
        store.SaveGoogleCatalogueWorkbook("work", "Current workbook");
        UploadCatalogueRow row = store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a");
        CreatorWorkflowAssociationResult stale = store.AssociateCreatorWorkflow(unbound.RunId, "episode-a", new string('f', 64));
        Assert.AreEqual("stale", stale.Status);
        Assert.IsNull(store.GetCreatorWorkflows(unboundOnly: true).Single().SourceKey);
        Assert.AreEqual(row.FanslyLink, store.GetUploadCatalogueSnapshot().Rows.Single(value => value.Id == "episode-a").FanslyLink);
        Assert.AreEqual(0, store.GetUploadSheetWritebacks("work").Count);
        Assert.AreEqual(64, row.Fingerprint.Length);
    }

    private static CatalogueStore StoreWithItems(string path)
    {
        CatalogueStore store = CatalogueStore.Open(path);
        store.ImportWorkbookProjection(new("workbook", "1", true,
        [
            new(2, "episode-a", "Episode A", "Description", null, null, null, 0, 0,
                new Dictionary<string, string>(), null),
            new(3, "episode-b", "Episode B", "Description", null, null, null, 0, 0,
                new Dictionary<string, string>(), null),
        ]), updateGoogleBindings: false);
        return store;
    }

    private static CreatorWorkflowSnapshot Snapshot(string runId, long revision, string? sourceKey) => new(
        runId, "upload", revision, sourceKey, [],
        [new("video", "episode-1.mp4", 1_024, FileTime, new string('a', 64))]);
}
