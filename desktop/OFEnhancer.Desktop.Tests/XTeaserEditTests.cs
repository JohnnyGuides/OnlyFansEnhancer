using System.IO;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class XTeaserEditTests
{
    [TestMethod]
    public void CopyNamesTheLinkedEpisodePreservesOriginalAndNeverOverwrites()
    {
        using Fixture fixture = new();
        string source = Path.Combine(fixture.Root, "misnamed final.MOV");
        byte[] bytes = [1, 2, 3, 4, 5];
        File.WriteAllBytes(source, bytes);
        DateTime originalTime = File.GetLastWriteTimeUtc(source);
        string occupied = Path.Combine(fixture.Tweets, "ep-a__t01.mov");
        File.WriteAllText(occupied, "keep existing teaser");
        Directory.Delete(fixture.Episode); // Linking a clip does not require a Vegas project folder.
        JsonElement copied = fixture.Copy(source);
        Assert.AreEqual("ep-a__t02.mov", copied.GetProperty("name").GetString());
        CollectionAssert.AreEqual(bytes, File.ReadAllBytes(source));
        CollectionAssert.AreEqual(bytes, File.ReadAllBytes(copied.GetProperty("path").GetString()!));
        Assert.AreEqual(originalTime, File.GetLastWriteTimeUtc(source));
        Assert.AreEqual("keep existing teaser", File.ReadAllText(occupied));
        long id = copied.GetProperty("clip").GetProperty("clipId").GetInt64();
        Assert.AreEqual("ep-a", fixture.Store.GetXTeaserLibraryClip(id)!.EpisodeKey);
        Assert.AreEqual("ep-a__t02.mov", fixture.Store.GetXTeaserEdit("ep-a").Renders["2026-10-20"]);
        Assert.AreEqual(id, fixture.Copy(source).GetProperty("clip").GetProperty("clipId").GetInt64(), "Retry reuses the identical managed copy");
        Assert.AreEqual(2, Directory.GetFiles(fixture.Tweets).Length);
    }

    [TestMethod]
    public void CopyRejectsUnknownEpisodeAndUnavailableRootBeforeWriting()
    {
        using Fixture fixture = new();
        string source = Path.Combine(fixture.Root, "source.mp4");
        File.WriteAllText(source, "source video");
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => fixture.Copy(source, "unknown"));
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => fixture.Copy(source, "../ep-a"));
        fixture.RenderRoot = Path.Combine(fixture.Root, "missing");
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => fixture.Copy(source));
        Assert.IsFalse(Directory.Exists(fixture.RenderRoot));
        Assert.AreEqual(0, Directory.GetFiles(fixture.Tweets).Length);
        Assert.AreEqual("source video", File.ReadAllText(source));
    }

    [TestMethod]
    public async Task CopyPreservesWebmFormatAndVegasStillReservesMp4()
    {
        using Fixture fixture = new();
        string source = Path.Combine(fixture.Root, "wrong.webm");
        File.WriteAllText(source, "webm bytes");
        Assert.AreEqual("ep-a__t01.webm", fixture.Copy(source).GetProperty("name").GetString());
        File.WriteAllText(Path.Combine(fixture.Episode, "TEASR.veg"), "project");
        JsonElement prepared = await fixture.Call("openTeaserProject", "TEASR.veg");
        Assert.AreEqual(".mp4", Path.GetExtension(prepared.GetProperty("renderName").GetString()));
    }

    [TestMethod]
    public async Task TemplateOnAnotherMediaRootPersistsAndCopiesWithoutEditingOriginal()
    {
        using Fixture fixture = new();
        string template = Path.Combine(Directory.CreateDirectory(Path.Combine(fixture.Root, "other-media")).FullName, "template.veg");
        File.WriteAllText(template, "original template");
        DesktopSettingsStore settings = new(Path.Combine(fixture.Root, "settings.json"));
        settings.Save(DesktopSettings.Empty with { XTeaserRoot = fixture.Tweets, XTeaserTemplatePath = template });
        fixture.TemplatePath = settings.Load().XTeaserTemplatePath;
        Assert.AreEqual(template, fixture.TemplatePath);
        Assert.IsTrue((await fixture.Call("getTeaserEdit")).GetProperty("templateAvailable").GetBoolean());
        await fixture.Call("createTeaserProject");
        Assert.AreEqual("original template", File.ReadAllText(template));
        Assert.AreEqual("original template", File.ReadAllText(Path.Combine(fixture.Episode, "ep-a__teaser.veg")));
        settings.Save(settings.Load() with { BrowserId = BrowserSelection.SystemDefaultId });
        Assert.AreEqual(template, settings.Load().XTeaserTemplatePath);
    }

    [TestMethod]
    public async Task ExplicitProjectSelectionPersistsAndNamesAreReservedPerDay()
    {
        using Fixture fixture = new();
        File.WriteAllText(Path.Combine(fixture.Episode, "odd_TEASR.veg"), "project");
        File.WriteAllText(Path.Combine(fixture.Episode, "main.veg"), "main");
        await fixture.Error("openTeaserProject", "teaser-project-choice-required");
        var initial = await fixture.Call("getTeaserEdit");
        Assert.AreEqual("", initial.GetProperty("renderName").GetString());
        var selected = await fixture.Call("openTeaserProject", "odd_TEASR.veg");
        Assert.AreEqual("odd_TEASR.veg", selected.GetProperty("projectName").GetString());
        Assert.AreEqual("ep-a__t01.mp4", selected.GetProperty("renderName").GetString());
        fixture.Restart();
        var reopened = await fixture.Call("openTeaserProject");
        Assert.AreEqual("ep-a__t01.mp4", reopened.GetProperty("renderName").GetString());
        var next = await fixture.Call("openTeaserProject", date: "2026-10-21");
        Assert.AreEqual("ep-a__t02.mp4", next.GetProperty("renderName").GetString());
        Assert.AreEqual(3, fixture.Opened.Count);
    }

    [TestMethod]
    public async Task TemplateCopyNeverOverwritesAndCancelledPickerDoesNotReserve()
    {
        using Fixture fixture = new();
        string template = Path.Combine(Directory.CreateDirectory(Path.Combine(fixture.Root, "_template")).FullName, "_.-TEMPLATE-._.veg");
        File.WriteAllText(template, "template");
        File.WriteAllText(Path.Combine(fixture.Episode, "ep-a__teaser.veg"), "existing");
        var cancelled = await fixture.Call("chooseTeaserProject");
        Assert.IsTrue(cancelled.GetProperty("cancelled").GetBoolean());
        Assert.AreEqual("", cancelled.GetProperty("renderName").GetString());
        var created = await fixture.Call("createTeaserProject");
        Assert.AreEqual("ep-a__teaser-2.veg", created.GetProperty("projectName").GetString());
        Assert.AreEqual("existing", File.ReadAllText(Path.Combine(fixture.Episode, "ep-a__teaser.veg")));
        Assert.AreEqual("template", File.ReadAllText(template));
        Assert.AreEqual("template", File.ReadAllText(Path.Combine(fixture.Episode, "ep-a__teaser-2.veg")));
    }

    [TestMethod]
    public async Task WatchedRenderWaitsForStableUnlockedFileAndRerenderCreatesFreshClip()
    {
        using Fixture fixture = new();
        File.WriteAllText(Path.Combine(fixture.Episode, "teaser.veg"), "project");
        var unrelated = fixture.Store.UpsertXTeaserRender(new("other__t01.mp4", 2, fixture.Now.ToString("O"), new string('a', 64)), fixture.Now);
        await fixture.Call("openTeaserProject");
        Assert.AreEqual("waiting", (await fixture.Call("checkTeaserRender")).GetProperty("status").GetString());
        string output = Path.Combine(fixture.Tweets, "ep-a__t01.mp4");
        File.WriteAllBytes(output, [1, 2, 3]);
        Assert.AreEqual("rendering", (await fixture.Call("checkTeaserRender")).GetProperty("status").GetString());
        fixture.Now = fixture.Now.AddSeconds(2);
        using (FileStream lease = new(output, FileMode.Open, FileAccess.Write, FileShare.None))
            Assert.AreEqual("rendering", (await fixture.Call("checkTeaserRender")).GetProperty("status").GetString());
        var first = await fixture.Call("checkTeaserRender");
        Assert.AreEqual("ready", first.GetProperty("status").GetString());
        long id = first.GetProperty("clip").GetProperty("clipId").GetInt64();
        File.WriteAllBytes(output, [3, 2, 1, 0]);
        await fixture.Call("checkTeaserRender");
        fixture.Now = fixture.Now.AddSeconds(2);
        var second = await fixture.Call("checkTeaserRender");
        Assert.AreNotEqual(id, second.GetProperty("clip").GetProperty("clipId").GetInt64());
        Assert.IsNull(fixture.Store.GetXTeaserLibraryClip(id));
        Assert.IsNotNull(fixture.Store.GetXTeaserLibraryClip(unrelated.ClipId));
    }

    [TestMethod]
    public async Task MissingRenderRootDoesNotCreateAnOrphanTemplateCopy()
    {
        using Fixture fixture = new();
        string template = Path.Combine(Directory.CreateDirectory(Path.Combine(fixture.Root, "_template")).FullName, "_.-TEMPLATE-._.veg");
        File.WriteAllText(template, "template");
        fixture.RenderRoot = Path.Combine(fixture.Root, "missing-output");
        await fixture.Error("createTeaserProject", "x-teaser-root-unavailable");
        Assert.AreEqual(0, Directory.GetFiles(fixture.Episode, "*.veg").Length);
        Assert.AreEqual("", (await fixture.Call("getTeaserEdit")).GetProperty("renderName").GetString());
    }

    [TestMethod]
    public async Task ReadyPollingDoesNotRewriteAndPreservedTimestampRerenderIsDetectedWithinHashInterval()
    {
        using Fixture fixture = new();
        File.WriteAllText(Path.Combine(fixture.Episode, "teaser.veg"), "project");
        await fixture.Call("openTeaserProject");
        string output = Path.Combine(fixture.Tweets, "ep-a__t01.mp4");
        File.WriteAllBytes(output, [1, 2, 3]);
        await fixture.Call("checkTeaserRender");
        fixture.Now = fixture.Now.AddSeconds(2);
        var first = await fixture.Call("checkTeaserRender");
        long clip = first.GetProperty("clip").GetProperty("clipId").GetInt64();
        long changes = fixture.Changes();
        fixture.Now = fixture.Now.AddSeconds(1);
        await fixture.Call("checkTeaserRender");
        fixture.Now = fixture.Now.Add(XTeaserController.RenderHashInterval);
        await fixture.Call("checkTeaserRender");
        Assert.AreEqual(changes, fixture.Changes(), "Unchanged ready polls, including periodic rehash, should not write the catalogue.");
        DateTime originalTime = File.GetLastWriteTimeUtc(output);
        File.WriteAllBytes(output, [3, 2, 1]);
        File.SetLastWriteTimeUtc(output, originalTime);
        fixture.Now = fixture.Now.Add(XTeaserController.RenderHashInterval);
        var second = await fixture.Call("checkTeaserRender");
        Assert.AreNotEqual(clip, second.GetProperty("clip").GetProperty("clipId").GetInt64());
    }

    [TestMethod]
    public async Task DirectClipLookupIsNotLimitedByLibraryPageAndWebPathsAreRejected()
    {
        using Fixture fixture = new();
        var first = fixture.Store.UpsertXTeaserRender(new("ep-a__t01.mp4", 1, fixture.Now.ToString("O"), new string('a', 64)), fixture.Now);
        for (int index = 2; index <= 202; index++)
            fixture.Store.UpsertXTeaserRender(new($"ep-a__t{index}.mp4", 1, fixture.Now.ToString("O"), index.ToString("x64")), fixture.Now);
        Assert.AreEqual(200, fixture.Store.GetXTeaserLibrary().Count);
        Assert.IsNotNull(fixture.Store.GetXTeaserLibraryClip(first.ClipId));
        await fixture.Error("openTeaserProject", "invalid-teaser-project", "../elsewhere.veg");
        await fixture.Error("createTeaserProject", "teaser-template-unavailable");
    }

    private sealed class Fixture : IDisposable
    {
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), "ofe-teaser-edit-" + Guid.NewGuid().ToString("N"));
        internal string Episode => Path.Combine(Root, "ep-a");
        internal string Tweets => Path.Combine(Root, ".TWEETS");
        internal string? RenderRoot;
        internal string? TemplatePath;
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-10-20T10:00:00Z");
        internal CatalogueStore Store = null!;
        private XTeaserController controller = null!;
        internal List<string> Opened = [];
        internal Fixture()
        {
            Directory.CreateDirectory(Episode);
            Directory.CreateDirectory(Tweets);
            Store = CatalogueStore.Open(Path.Combine(Root, "catalogue.db"));
            using var command = Store.Connection.CreateCommand();
            command.CommandText = "INSERT INTO catalogue_items(item_id,source_key,title,updated_utc) VALUES('item-a','ep-a','Episode A','2026-10-20T00:00:00Z')";
            command.ExecuteNonQuery();
            Store.ScanThumbnails(Directory.CreateDirectory(Path.Combine(Root, "thumbs")).FullName);
            Start();
        }
        private void Start() => controller = new XTeaserController(Store, new WebMessageDispatcher(_ => ""),
            () => DesktopSettings.Empty with { XTeaserRoot = RenderRoot ?? Tweets, XTeaserTemplatePath = TemplatePath }, () => Now) { OpenProject = Opened.Add, ChooseProject = _ => null };
        internal long Changes()
        {
            using var command = Store.Connection.CreateCommand();
            command.CommandText = "SELECT total_changes()";
            return (long)command.ExecuteScalar()!;
        }
        internal void Restart()
        {
            controller.Dispose(); Store.Dispose();
            Store = CatalogueStore.Open(Path.Combine(Root, "catalogue.db")); Start();
        }
        internal async Task<JsonElement> Call(string operation, string? project = null, string date = "2026-10-20")
        {
            var payload = new Dictionary<string, object> { ["episodeKey"] = "ep-a", ["date"] = date };
            if (project is not null) payload["projectName"] = project;
            return JsonSerializer.SerializeToElement(await controller.HandleAsync(operation, JsonSerializer.SerializeToElement(payload)),
                new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        }
        internal async Task Error(string operation, string expected, string? project = null)
            => Assert.AreEqual(expected, (await Assert.ThrowsExceptionAsync<GoogleCatalogueControllerException>(() => Call(operation, project))).Code);
        internal JsonElement Copy(string source, string key = "ep-a") => JsonSerializer.SerializeToElement(
            controller.CopyTeaserFile(JsonSerializer.SerializeToElement(new { episodeKey = key, date = "2026-10-20", role = "social" }), new FileInfo(source)),
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        public void Dispose() { controller.Dispose(); Store.Dispose(); Directory.Delete(Root, true); }
    }
}
