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
