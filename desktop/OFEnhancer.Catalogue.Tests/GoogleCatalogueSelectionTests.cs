namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class GoogleCatalogueSelectionTests
{
    private static readonly DateTimeOffset InspectedUtc = new(2026, 9, 4, 13, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset SyncedUtc = InspectedUtc.AddMinutes(5);

    [TestMethod]
    public void SelectedWorkbookProfileReadinessAndTimestampsSurviveRestart()
    {
        using TestDirectory temp = new();
        string databasePath = Path.Combine(temp.Path, "catalogue.db");
        using (CatalogueStore store = CatalogueStore.Open(databasePath))
        {
            store.SaveGoogleCatalogueWorkbook("workbook-1", "Private catalogue");
            store.SaveGoogleCatalogueProfile(
                "workbook-1",
                "2126708696",
                "2026 Video Catalogue",
                "catalogue-v1",
                ready: true,
                InspectedUtc
            );
            store.MarkGoogleCatalogueSync("workbook-1", "2126708696", SyncedUtc);
        }

        using CatalogueStore reopened = CatalogueStore.Open(databasePath);
        GoogleCatalogueSelection selection = reopened.GetGoogleCatalogueSelection()!;

        Assert.AreEqual("workbook-1", selection.WorkbookId);
        Assert.AreEqual("Private catalogue", selection.WorkbookTitle);
        Assert.AreEqual("2126708696", selection.SheetId);
        Assert.AreEqual("2026 Video Catalogue", selection.SheetTitle);
        Assert.AreEqual("catalogue-v1", selection.Profile);
        Assert.IsTrue(selection.Ready);
        Assert.AreEqual(InspectedUtc, selection.LastInspectedUtc);
        Assert.AreEqual(SyncedUtc, selection.LastSuccessfulSyncUtc);
    }

    [TestMethod]
    public void ClearingSelectionAtomicallyRemovesItsProfileAndBindingsButNotCatalogue()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        string itemId = Guid.NewGuid().ToString("D");
        store.ImportWorkbookProjection(new(
            "workbook-1",
            "1",
            true,
            [new(2, "episode-1", "Episode", "", null, null, null, 0, 0, new Dictionary<string, string>(), itemId)]
        ));
        store.ReplaceGoogleBindings("workbook-1", [new(
            "workbook-1",
            "1",
            itemId,
            Guid.NewGuid().ToString("D"),
            2,
            new('0', 64),
            InspectedUtc
        )]);
        store.SaveGoogleCatalogueWorkbook("workbook-1", "Private catalogue");
        store.SaveGoogleCatalogueProfile("workbook-1", "1", "Catalogue", "catalogue-v1", true, InspectedUtc);

        store.ClearGoogleCatalogueSelection();

        Assert.IsNull(store.GetGoogleCatalogueSelection());
        Assert.AreEqual(0, store.GetGoogleBindings("workbook-1").Count);
        Assert.AreEqual(1, store.GetCatalogue().Items.Count);
    }

    [TestMethod]
    public void SelectionRejectsUnboundedOrMismatchedIdentifiersWithoutPartialWrites()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));

        Assert.ThrowsException<CatalogueSettingsException>(
            () => store.SaveGoogleCatalogueWorkbook(new string('a', 257), "Private catalogue")
        );
        store.SaveGoogleCatalogueWorkbook("workbook-1", "Private catalogue");
        Assert.ThrowsException<CatalogueSettingsException>(() => store.SaveGoogleCatalogueProfile(
            "different-workbook",
            "1",
            "Catalogue",
            "catalogue-v1",
            true,
            InspectedUtc
        ));

        GoogleCatalogueSelection selection = store.GetGoogleCatalogueSelection()!;
        Assert.AreEqual("workbook-1", selection.WorkbookId);
        Assert.IsNull(selection.SheetId);
    }

    private sealed class TestDirectory : IDisposable
    {
        internal TestDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"ofenhancer-google-selection-{Guid.NewGuid():N}"
            );
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
