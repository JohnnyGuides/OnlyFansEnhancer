using System.Text.Json;
using Microsoft.Data.Sqlite;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class XTeaserControllerTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);

    [DataTestMethod]
    [DataRow("getTeaserOverview")]
    [DataRow("undoTeaserClipMove")]
    [DataRow("getTeaserReplyQueue")]
    [DataRow("getTeaserPlan")]
    [DataRow("setTeaserPlanSlot")]
    [DataRow("clearTeaserPlanSlot")]
    public void TeaserOperationsAreAllowedAgentOperations(string operation)
    {
        AgentRequest request = AgentRequest.Parse(
            $$$"""{"protocolVersion":1,"requestId":"{{{Guid.NewGuid()}}}","operation":"{{{operation}}}","payload":{}}""");
        Assert.AreEqual(operation, request.Operation);
    }

    [TestMethod]
    public async Task SchedulerDoesNothingWhileTheTeaserRootIsUnset()
    {
        using TestDirectory temp = new();
        string root = Path.Combine(temp.Path, "TWEETS");
        Directory.CreateDirectory(Path.Combine(root, "Done"));
        File.WriteAllText(Path.Combine(root, "Done", "ep-a__t1.mp4"), "clip");
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        using XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty, () => Now);

        XTeaserRunResult inactive = await controller.RunOnceAsync();
        Assert.IsFalse(inactive.Active);
        Assert.IsNull(inactive.Scan);
        Assert.AreEqual(0L, Count(store, "x_local_clips"));
        Assert.IsFalse(controller.Overview(JsonDocument.Parse("{}").RootElement).Active);
        Assert.AreEqual("x-teaser-inactive", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.UndoAsync(JsonDocument.Parse("""{"moveId":1}""").RootElement))).Code);
    }

    [TestMethod]
    public async Task ConfiguredRootIsScannedAndReportedActive()
    {
        using TestDirectory temp = new();
        string root = Path.Combine(temp.Path, "TWEETS");
        Directory.CreateDirectory(Path.Combine(root, "Done"));
        File.WriteAllText(Path.Combine(root, "Done", "ep-a__t1.mp4"), "clip");
        File.WriteAllText(Path.Combine(root, "ep-a__t2.mp4"), "ready");
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        DesktopSettings settings = DesktopSettings.Empty with { XTeaserRoot = root };
        using XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => settings, () => Now);

        XTeaserRunResult run = await controller.RunOnceAsync();
        Assert.IsTrue(run.Active);
        Assert.AreEqual(2, run.Scan!.Present);
        Assert.AreEqual(0, run.Moves.Count);
        XTeaserOverviewResult overview = controller.Overview(JsonDocument.Parse("{}").RootElement);
        Assert.IsTrue(overview.Active);
        Assert.AreEqual(@"Done\ep-a__t1.mp4", overview.Overview.UnpairedClips.Single().RelPath);
        Assert.AreEqual("invalid-teaser-request", Assert.ThrowsException<GoogleCatalogueControllerException>(() =>
            controller.Overview(JsonDocument.Parse("""{"limit":5}""").RootElement)).Code);
        Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.UndoAsync(JsonDocument.Parse("""{"moveId":"1"}""").RootElement))).Code);
        Assert.AreEqual("x-move-not-found", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.UndoAsync(JsonDocument.Parse("""{"moveId":7}""").RootElement))).Code);
    }

    [TestMethod]
    public async Task SheetWritebackRunsOnTheDispatcherWithoutTheTeaserRoot()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        using (XTeaserController without = new(store, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty, () => Now))
            Assert.IsNull(await without.WriteBackSheetLinksAsync());
        List<DateTimeOffset> calls = [];
        using XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty, () => Now,
            now => { calls.Add(now); return new(true, 1, 0, 0); });
        Assert.AreEqual(new XSheetWritebackRun(true, 1, 0, 0), await controller.WriteBackSheetLinksAsync());
        CollectionAssert.AreEqual(new[] { Now }, calls);
    }

    [TestMethod]
    public void ReplyQueueWorksWithoutTheTeaserRootAndRejectsPayloads()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        using XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty, () => Now);
        XTeaserReplyQueue queue = controller.ReplyQueue(JsonDocument.Parse("{}").RootElement);
        Assert.IsNull(queue.OwnerHandle);
        Assert.AreEqual(0, queue.Items.Count);
        Assert.AreEqual("invalid-teaser-request", Assert.ThrowsException<GoogleCatalogueControllerException>(() =>
            controller.ReplyQueue(JsonDocument.Parse("""{"since":1}""").RootElement)).Code);
    }

    [TestMethod]
    public void TeaserPathsRoundTripAndInvalidValuesFailClosed()
    {
        using TestDirectory temp = new();
        string path = Path.Combine(temp.Path, "settings.json");
        DesktopSettingsStore store = new(path);
        string root = Path.Combine(temp.Path, "TWEETS");
        store.Save(DesktopSettings.Empty with { XTeaserRoot = root + Path.DirectorySeparatorChar,
            XTeaserRevertListPath = Path.Combine(temp.Path, "revert.csv") });
        DesktopSettings loaded = store.Load();
        Assert.AreEqual(root, loaded.XTeaserRoot);
        Assert.AreEqual(Path.Combine(temp.Path, "revert.csv"), loaded.XTeaserRevertListPath);
        Assert.AreEqual("invalid-x-teaser-root", Assert.ThrowsException<DesktopSettingsException>(() =>
            store.Save(loaded with { XTeaserRoot = "relative\\folder" })).Code);
        Assert.AreEqual("invalid-x-teaser-root", Assert.ThrowsException<DesktopSettingsException>(() =>
            store.Save(loaded with { XTeaserRoot = "C:\\" })).Code);
        File.WriteAllText(path, """{"xTeaserRoot":"relative"}""");
        Assert.IsTrue(store.TryLoad(out DesktopSettings relative));
        Assert.IsNull(relative.XTeaserRoot);
    }

    [TestMethod]
    public async Task PlanOperationsValidatePayloadsAndPersistThroughTheSharedEntry()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        using (SqliteCommand command = store.Connection.CreateCommand())
        {
            command.CommandText = """
                INSERT INTO catalogue_items(item_id,source_key,title,description,series,episode,category,updated_utc)
                VALUES ('item-1','series-a-e3','Series A E3','','Series A','3','Games','2026-09-01T00:00:00Z')
                """;
            command.ExecuteNonQuery();
        }
        using XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty, () => Now);
        Assert.IsTrue(XTeaserController.Operations.SetEquals(["getTeaserOverview", "undoTeaserClipMove", "getTeaserReplyQueue",
            "getTeaserPlan", "setTeaserPlanSlot", "clearTeaserPlanSlot", "requestXScan"]));

        var slot = (XTeaserPlanSlot)await controller.HandleAsync("setTeaserPlanSlot",
            Json("""{"date":"2026-09-29","episodeKey":"series-a-e3"}"""));
        Assert.AreEqual("item-1", slot.ItemId);
        await controller.HandleAsync("setTeaserPlanSlot", Json("""{"date":"2026-09-30","episodeKey":"series-a-e3","clipId":null}"""));
        var plan = (XTeaserPlan)await controller.HandleAsync("getTeaserPlan", Json("{}"));
        CollectionAssert.AreEqual(new[] { "2026-09-29", "2026-09-30" }, plan.Slots.Select(item => item.Date).ToArray());
        var overview = (XTeaserOverviewResult)await controller.HandleAsync("getTeaserOverview", Json("{}"));
        Assert.AreEqual("Games", overview.Overview.Episodes.Single().Category);

        foreach (string bad in new[]
        {
            """{"date":"2026-09-29"}""",
            """{"date":"2026-09-29","episodeKey":"  "}""",
            """{"date":"2026-09-29","episodeKey":"series-a-e3","extra":1}""",
            """{"date":"2026-09-29","episodeKey":"series-a-e3","clipId":"7"}""",
            """{"date":"2026-09-29","episodeKey":"series-a-e3","clipId":0}""",
            """{"date":"29-09-2026","episodeKey":"series-a-e3"}""",
            """{"date":"2026-09-26","episodeKey":"series-a-e3"}""",
            """{"date":"2026-11-29","episodeKey":"series-a-e3"}""",
        })
            Assert.AreEqual("invalid-teaser-plan", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
                controller.HandleAsync("setTeaserPlanSlot", Json(bad)))).Code, bad);
        Assert.AreEqual("x-plan-episode-not-found", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.HandleAsync("setTeaserPlanSlot", Json("""{"date":"2026-10-01","episodeKey":"unknown"}""")))).Code);
        Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.HandleAsync("getTeaserPlan", Json("""{"from":"2026-01-01"}""")))).Code);
        Assert.AreEqual("invalid-teaser-plan", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.HandleAsync("clearTeaserPlanSlot", Json("""{"date":"2026-09-29","episodeKey":"x"}""")))).Code);
        Assert.AreEqual("unsupported-operation", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.HandleAsync("deleteTeaserPlan", Json("{}")))).Code);

        await controller.HandleAsync("clearTeaserPlanSlot", Json("""{"date":"2026-09-29"}"""));
        Assert.AreEqual("2026-09-30", ((XTeaserPlan)await controller.HandleAsync("getTeaserPlan", Json("{}"))).Slots.Single().Date);
        Assert.AreEqual(1L, Count(store, "x_planned_slots"));
    }

    [TestMethod]
    public async Task ScanNowFromTheDesktopRecordsARequestForChromeAndIsNotAnAgentOperation()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        using XTeaserController controller = new(store, new WebMessageDispatcher(_ => ""), () => DesktopSettings.Empty, () => Now);
        object result = await controller.HandleAsync("requestXScan", Json("{}"));
        StringAssert.Contains(JsonSerializer.Serialize(result), "\"requested\":true");
        Assert.AreEqual(Now.ToString("O", System.Globalization.CultureInfo.InvariantCulture), store.GetXScanStatus().RequestedUtc);
        var overview = (XTeaserOverviewResult)await controller.HandleAsync("getTeaserOverview", Json("{}"));
        Assert.AreEqual(store.GetXScanStatus().RequestedUtc, overview.Overview.Scan!.RequestedUtc);
        Assert.AreEqual("invalid-teaser-request", (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() =>
            controller.HandleAsync("requestXScan", Json("""{"now":true}""")))).Code);
        // Only the desktop workspace asks; Chrome's own page starts the scan itself.
        Assert.AreEqual("unsupported-operation", Assert.ThrowsException<AgentProtocolException>(() => AgentRequest.Parse(
            $$$"""{"protocolVersion":1,"requestId":"{{{Guid.NewGuid()}}}","operation":"requestXScan","payload":{}}""")).Code);
    }

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    private static long Count(CatalogueStore store, string table)
    {
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {table}";
        return (long)command.ExecuteScalar()!;
    }

    private sealed class TestDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-xteaser-{Guid.NewGuid():N}");

        public TestDirectory() => Directory.CreateDirectory(Path);

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
