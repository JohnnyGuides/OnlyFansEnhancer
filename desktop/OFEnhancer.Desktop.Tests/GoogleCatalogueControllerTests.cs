using OFEnhancer.Protocol;
using System.Security.Cryptography;
using System.Text;
using System.Net;
using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleCatalogueControllerTests
{
    [TestMethod]
    public void UploadResultWritebackKeepsLocalEvidenceAndReconcilesAnAttemptReadOnly()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Store.SaveGoogleCatalogueProfile(WorkbookId, "17", "Catalogue", "catalogue-v1", true, DateTimeOffset.UtcNow);
        harness.Store.ImportWorkbookProjection(new(WorkbookId, "17", true,
            [new(2, "episode-1", "Episode 1", "", null, null, null, 0, 0, new Dictionary<string,string>(), null)]), false);
        var row = harness.Store.GetUploadCatalogueSnapshot().Rows.Single();
        var request = new UploadResultRequest(row.Row, row.Fingerprint, "fansly", "https://fansly.com/post/500", Id: row.Id);
        var local = harness.Store.RecordUploadResult(request);
        int calls = 0;
        harness.Session.WriteUploadLinkAction = (intent, beforeWrite) =>
        {
            calls++;
            if (intent.State == "pending")
            {
                beforeWrite(17);
                Assert.AreEqual("attempted", harness.Store.GetUploadSheetWritebacks(WorkbookId).Single().State);
                return Task.FromException<GoogleTeaserLinkResult>(new GoogleCatalogueException("google-row-write-unresolved"));
            }
            Assert.AreEqual("unresolved", intent.State);
            Assert.AreEqual("17", intent.SheetId);
            return Task.FromResult(new GoogleTeaserLinkResult("already-present",
                new(new(WorkbookId, "17", true,
                    [new(2, row.Id, row.Title, row.Description, null, null, null, 0, 0,
                        new Dictionary<string,string> { ["fansly"] = request.PostUrl }, null)]),
                    17, "Catalogue", 1, new Dictionary<string,int> { ["sourceKey"] = 1, ["title"] = 2, ["fansly"] = 3 })));
        };
        var first = harness.Controller.WriteBackUploadResult(request, local);
        Assert.AreEqual("recorded-local", first.Status);
        Assert.IsFalse(first.GoogleSynced);
        Assert.AreEqual("google-row-write-unresolved", first.GoogleError);
        Assert.AreEqual(request.PostUrl, harness.Store.GetUploadCatalogueSnapshot().Rows.Single().FanslyLink);
        harness.Controller.WriteBackUploadLinks();
        Assert.AreEqual(2, calls);
        Assert.AreEqual(0, harness.Store.GetUploadSheetWritebacks(WorkbookId).Count);
        Assert.IsTrue(harness.Controller.WriteBackUploadResult(request, local).GoogleSynced);
        Assert.AreEqual(2, calls, "a completed intent never calls the writer again");
    }

    [TestMethod]
    public void UnreadySelectionKeepsTheIntentWithoutMutatingGoogle()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Store.SaveGoogleCatalogueProfile(WorkbookId, "17", "Catalogue", "catalogue-v1", false, DateTimeOffset.UtcNow);
        harness.Store.ImportWorkbookProjection(new(WorkbookId, "17", true,
            [new(2, "episode-1", "Episode 1", "", null, null, null, 0, 0, new Dictionary<string, string>(), null)]), false);
        var row = harness.Store.GetUploadCatalogueSnapshot().Rows.Single();
        var request = new UploadResultRequest(row.Row, row.Fingerprint, "fansly", "https://fansly.com/post/500", Id: row.Id);
        var local = harness.Store.RecordUploadResult(request);
        Assert.AreEqual("17", local.SheetWriteback!.SheetId);
        harness.Session.WriteUploadLinkAction = (_, _) => throw new AssertFailedException("Unready destination must not write.");
        Assert.IsFalse(harness.Controller.WriteBackUploadResult(request, local).GoogleSynced);
        harness.Controller.WriteBackUploadLinks();
        Assert.AreEqual("pending", harness.Store.GetUploadSheetWritebacks(WorkbookId).Single().State);
        harness.Store.SaveGoogleCatalogueWorkbook("another-workbook", "Other workbook");
        harness.Controller.WriteBackUploadResult(request, local);
        Assert.AreEqual(0, harness.Store.GetUploadSheetWritebacks("another-workbook").Count);
        Assert.AreEqual("17", harness.Store.GetUploadSheetWritebacks(WorkbookId).Single().SheetId);
    }

    [TestMethod]
    public void PersistenceFailureAfterInspectionCannotRestoreStaleReadiness()
    {
        using ControllerHarness harness = ReadyHarness();
        harness.Session.InspectAction = _ =>
        {
            using var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={harness.Store.DatabasePath};Pooling=False");
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "CREATE TRIGGER fail_ready BEFORE UPDATE ON settings WHEN NEW.key='google.catalogue.ready' BEGIN SELECT RAISE(ABORT,'fixture failure'); END";
            command.ExecuteNonQuery();
            return Task.FromResult(Inspection(true) with { Conflicts = [new("technical-column-conflict", "U1")] });
        };
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => harness.Controller.inspectGoogleWorkbook());
        Assert.IsFalse(harness.Store.GetGoogleCatalogueSelection()!.Ready);
        using GoogleCatalogueController restarted = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, _) => harness.Session);
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => restarted.syncGoogleCatalogue());
    }

    [TestMethod]
    public void ConfirmedConflictInvalidatesReadinessAcrossControllerRestart()
    {
        using ControllerHarness harness = ReadyHarness();
        harness.Session.Inspection = Inspection(true) with { Conflicts = [new("technical-column-conflict", "U1")] };
        harness.Controller.inspectGoogleWorkbook();
        Assert.IsFalse(harness.Store.GetGoogleCatalogueSelection()!.Ready);
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => harness.Controller.syncGoogleCatalogue());
        using GoogleCatalogueController restarted = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, _) => harness.Session);
        Assert.ThrowsException<GoogleCatalogueControllerException>(() => restarted.syncGoogleCatalogue());
        Assert.AreEqual(0, harness.Session.MigrationCalls - 1);
    }

    [TestMethod]
    public void SaveFailureAfterMigrationLeavesTheControllerNotReadyAndSyncRefused()
    {
        using ControllerHarness harness = ConnectedHarness();
        WorkbookInspection inspection = Inspection(alreadyMigrated: false);
        harness.Session.Inspection = inspection;
        harness.Session.Migration = new("applied", inspection with
        {
            AlreadyMigrated = true,
            MigrationPlan = inspection.MigrationPlan with { Operations = [] },
        });
        harness.Controller.inspectGoogleWorkbook();
        using (var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={harness.Store.DatabasePath};Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "CREATE TRIGGER fail_ready BEFORE UPDATE ON settings WHEN NEW.key='google.catalogue.ready' BEGIN SELECT RAISE(ABORT,'fixture failure'); END";
            command.ExecuteNonQuery();
        }

        Assert.ThrowsException<GoogleCatalogueControllerException>(() => harness.Controller.applyGoogleWorkbookMigration(PlanHash));

        Assert.AreNotEqual("ready", harness.Controller.getGoogleCatalogueStatus().State);
        Assert.AreEqual("google-workbook-not-ready", Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.syncGoogleCatalogue()).Code);
    }

    [DataTestMethod]
    [DataRow(false, "google-sync-conflict")]
    [DataRow(true, "google-sync-unresolved")]
    public void OldStoredConflictOrAttemptedOperationKeepsSyncFromAdvancingLastVerified(bool attempted, string expectedCode)
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(1, []);
        harness.Controller.inspectGoogleWorkbook();
        string itemId = harness.Store.GetCatalogue().Items.Single().ItemId;
        SyncOutboxItem old = harness.Store.EnqueueProjection(Projection(itemId, "old-issue", WorkbookId));
        if (attempted)
            harness.Store.MarkSyncAttempted(old.OperationId, DateTimeOffset.UtcNow);
        else
            harness.Store.MarkSyncPendingConflict(old.OperationId, "remote-value-not-empty", DateTimeOffset.UtcNow);
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(1, 0, 0, 0, true));

        GoogleCatalogueStatusView status = harness.Controller.syncGoogleCatalogue();

        Assert.IsNull(status.LastVerifiedSync);
        Assert.IsNull(harness.Store.GetGoogleCatalogueSelection()!.LastSuccessfulSyncUtc);
        Assert.AreEqual("conflict", status.State);
        Assert.AreEqual(expectedCode, status.ErrorCode);
        Assert.AreEqual(attempted ? SyncOutboxState.Attempted : SyncOutboxState.Conflict,
            harness.Store.GetSyncOperation(old.OperationId).State);
    }

    [TestMethod]
    public void SyncThatLeavesPendingWorkUnsentIsNotReportedReady()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(1, []);
        harness.Controller.inspectGoogleWorkbook();
        string itemId = harness.Store.GetCatalogue().Items.Single().ItemId;
        SyncOutboxItem leftover = harness.Store.EnqueueProjection(Projection(itemId, "leftover", WorkbookId));
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(0, 0, 0, 1, false, Deferred: 1));

        GoogleCatalogueStatusView status = harness.Controller.syncGoogleCatalogue();

        Assert.AreEqual("conflict", status.State);
        Assert.AreEqual("google-sync-incomplete", status.ErrorCode);
        Assert.AreEqual(1, status.PendingCount);
        Assert.IsNull(status.LastVerifiedSync);
        Assert.AreEqual(SyncOutboxState.Pending, harness.Store.GetSyncOperation(leftover.OperationId).State);

        // A later run that sends it clears the flag.
        harness.Store.MarkSyncPendingCompleted(leftover.OperationId, DateTimeOffset.UtcNow);
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(1, 0, 0, 0, true));
        Assert.AreEqual("ready", harness.Controller.syncGoogleCatalogue().State);
    }

    [TestMethod]
    public void ConflictInAnotherWorkbookDoesNotBlockSyncSuccess()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(1, []);
        harness.Controller.inspectGoogleWorkbook();
        string itemId = harness.Store.GetCatalogue().Items.Single().ItemId;
        SyncOutboxItem other = harness.Store.EnqueueProjection(Projection(itemId, "other-workbook", "workbook-a"));
        harness.Store.MarkSyncPendingConflict(other.OperationId, "remote-value-not-empty", DateTimeOffset.UtcNow);
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(1, 0, 0, 0, true));

        GoogleCatalogueStatusView status = harness.Controller.syncGoogleCatalogue();

        Assert.IsNotNull(status.LastVerifiedSync);
        Assert.AreEqual("ready", status.State);
    }

    [TestMethod]
    public void RestoreHandsTheStoredSheetIdToTheSessionAsTheApprovedIdentity()
    {
        using ControllerHarness harness = ReadyHarness();
        GoogleConnectionCompletion? seen = null;

        using GoogleCatalogueController restarted = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, completion) =>
            {
                seen = completion;
                return harness.Session;
            });

        Assert.AreEqual(1, seen!.PreferredSheetId);
    }

    [TestMethod]
    public void RestoredControllerImportsOnlyTheStoredSheetThroughTheProductionSessionFactory()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Store.SaveGoogleCatalogueProfile(WorkbookId, "44", "Second tab", "catalogue-v1", false, DateTimeOffset.UtcNow);
        GoogleRoutingHandler handler = new();
        string metadata = GoogleRoutingHandler.Metadata(("First tab", 1), ("Second tab", 44));
        handler.Sheets(metadata);
        handler.Sheets(GoogleRoutingHandler.Tab(("Second tab", 44), false));
        handler.Sheets(GoogleRoutingHandler.Tab(("Second tab", 44), true));
        using HttpClient http = new(handler);
        using GoogleCatalogueController restarted = new(harness.Settings, harness.Store, harness.Vault, http, _ => { });

        GoogleCatalogueImportResult result = restarted.importGoogleCatalogue();

        Assert.AreEqual("Second tab", result.SheetName);
        Assert.AreEqual(1, result.ImportedItems);
        Assert.AreEqual(3, handler.SheetsRequests.Count);
        Assert.IsTrue(handler.SheetsRequests.All(uri => !Uri.UnescapeDataString(uri.Query).Contains("First tab", StringComparison.Ordinal)));
    }

    [TestMethod]
    public async Task CancellingInFlightGoogleWorkEndsAnImportBeforeDispose()
    {
        using ControllerHarness harness = ConnectedHarness();
        TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        harness.Session.ReadImportAction = async cancellationToken =>
        {
            entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
            throw new InvalidOperationException("unreachable");
        };
        Task<GoogleCatalogueControllerException> import = Task.Run(() =>
            Assert.ThrowsException<GoogleCatalogueControllerException>(() => harness.Controller.importGoogleCatalogue()));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));

        harness.Controller.CancelInFlightGoogleWork();

        Task finished = await Task.WhenAny(import, Task.Delay(TimeSpan.FromSeconds(10)));
        Assert.AreSame(import, finished, "the import kept running after the cancel call");
        Assert.AreEqual("google-operation-cancelled", (await import).Code);
    }

    [TestMethod]
    public async Task StalledGoogleBodyEndsAtTheDeadlineAndReleasesTheOperationGate()
    {
        using ControllerHarness harness = ConnectedHarness();
        GoogleRoutingHandler handler = new();
        handler.StallNextSheetsBody();
        handler.Sheets(GoogleRoutingHandler.Metadata(("First tab", 1)));
        handler.Sheets(GoogleRoutingHandler.Tab(("First tab", 1), false));
        handler.Sheets(GoogleRoutingHandler.Tab(("First tab", 1), true));
        using HttpClient http = new(handler);
        using GoogleCatalogueController controller = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(),
            (_, completion) => new GoogleCatalogueSession(WorkbookId,
                new GoogleWorkspaceClient(http, new FixedTokenSource(), TimeSpan.FromMilliseconds(200)),
                harness.Store, null, completion.PreferredSheetId));

        Task<GoogleCatalogueControllerException> stalled = Task.Run(() =>
            Assert.ThrowsException<GoogleCatalogueControllerException>(() => controller.importGoogleCatalogue()));
        Task finished = await Task.WhenAny(stalled, Task.Delay(TimeSpan.FromSeconds(10)));
        Assert.AreSame(stalled, finished, "the stalled read never ended");
        Assert.AreEqual("google-request-timeout", (await stalled).Code);

        Assert.AreEqual(1, controller.importGoogleCatalogue().ImportedItems);
    }

    [TestMethod]
    public async Task StalledTokenEndpointFailsAtTheDeadlineAndTheNextRefreshProceeds()
    {
        MemoryGoogleTokenVault vault = new();
        vault.Save(new("private-refresh-token", DateTimeOffset.UtcNow.AddMinutes(-1), ClientId));
        StallOnceTokenHandler handler = new();
        using HttpClient http = new(handler);
        using GoogleRefreshAccessTokenSource source = new(ClientId, http, vault, null, TimeSpan.FromMilliseconds(200));
        using CancellationTokenSource caller = new();

        Task<GoogleCatalogueException> stalled = Assert.ThrowsExceptionAsync<GoogleCatalogueException>(async () =>
            await source.GetAccessTokenAsync(false, caller.Token));
        Task finished = await Task.WhenAny(stalled, Task.Delay(TimeSpan.FromSeconds(10)));
        if (!ReferenceEquals(finished, stalled))
        {
            caller.Cancel();
            Assert.Fail("The token refresh did not end at its own deadline.");
        }
        Assert.AreEqual("google-token-refresh-timeout", (await stalled).Code);

        Assert.AreEqual("private-access-token-2",
            await source.GetAccessTokenAsync(false, CancellationToken.None).AsTask().WaitAsync(TimeSpan.FromSeconds(10)));
    }

    private const string ClientId =
        "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
    private const string OtherClientId =
        "987654321098-zyxwvutsrqponmlkjihgfedcba654321.apps.googleusercontent.com";
    private const string WorkbookId = "private-workbook-id";
    private static readonly string PlanHash = new('a', 64);

    [TestMethod]
    public void PastedSheetUrlIsValidatedBeforeConnectionAndPassedAsTheBrowserSelectionTarget()
    {
        using ControllerHarness harness = new();

        GoogleCatalogueControllerException invalid = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.startGoogleCatalogueConnection("https://example.com/not-google")
        );
        Assert.AreEqual("invalid-google-sheet-url", invalid.Code);
        Assert.AreEqual(0, harness.Connections.Count);

        GoogleCatalogueStatusView status = harness.Controller.startGoogleCatalogueConnection(
            "https://docs.google.com/spreadsheets/d/private-workbook-id/edit#gid=17"
        );
        Assert.AreEqual("connecting", status.State);
        Assert.AreEqual(new GoogleSheetReference("private-workbook-id", 17), harness.Connection.Target);
    }

    [TestMethod]
    public void MissingDesktopClientConfigurationStopsBeforeOpeningGoogle()
    {
        using ControllerHarness harness = new();
        using TestDirectory clientDirectory = new();
        FakeConnection? connection = null;
        using GoogleCatalogueController controller = new(
            harness.Settings,
            harness.Store,
            harness.Vault,
            (_, scopedVault, completed) =>
            {
                connection = new(scopedVault) { Completed = completed };
                return connection;
            },
            (_, _) => harness.Session,
            clientStore: new(Path.Combine(clientDirectory.Path, "missing-client.dat"))
        );

        Assert.AreEqual("google-client-configuration-required", controller.getGoogleCatalogueStatus().ErrorCode);
        Assert.AreEqual("google-client-configuration-required", Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => controller.startGoogleCatalogueConnection()).Code);
        Assert.IsNull(connection);
        Assert.IsNull(harness.Vault.Load());
    }

    [TestMethod]
    public void NativeClientImportCancellationMismatchAndSuccessPreserveConnectedSelection()
    {
        using ControllerHarness harness = ReadyHarness();
        using TestDirectory temp = new();
        GoogleDesktopClientStore clientStore = new(Path.Combine(temp.Path, "client.dat"));
        using GoogleCatalogueController controller = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, _) => harness.Session, clientStore: clientStore);
        var selection = harness.Store.GetGoogleCatalogueSelection();
        var refresh = harness.Vault.Load();
        Assert.AreEqual("google-client-configuration-required", controller.getGoogleCatalogueStatus().ErrorCode);
        Assert.AreEqual(controller.getGoogleCatalogueStatus(), controller.ImportGoogleClientConfiguration(() => null));
        string file = Path.Combine(temp.Path, "download.json");
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new { installed = new { client_id = OtherClientId, client_secret = "secret" } }));
        Assert.AreEqual("google-client-configuration-mismatch", Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => controller.ImportGoogleClientConfiguration(() => file)).Code);
        Assert.IsNull(clientStore.Load(ClientId));
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new { installed = new { client_id = ClientId, client_secret = "secret" } }));
        Assert.AreEqual("ready", controller.ImportGoogleClientConfiguration(() =>
        {
            Assert.AreEqual("google-operation-in-progress", Assert.ThrowsException<GoogleCatalogueControllerException>(
                () => controller.saveGoogleClientId(OtherClientId)).Code);
            Assert.AreEqual("google-operation-in-progress", Assert.ThrowsException<GoogleCatalogueControllerException>(
                () => controller.startGoogleCatalogueConnection()).Code);
            return file;
        }).State);
        Assert.AreEqual(selection, harness.Store.GetGoogleCatalogueSelection());
        Assert.AreEqual(refresh, harness.Vault.Load());
        Assert.IsFalse(File.ReadAllText(Path.Combine(temp.Path, "client.dat")).Contains("secret"));
    }

    [TestMethod]
    public async Task ClientSecretCheckWithStalledBodyEndsAtTheDeadlineAndKeepsTheStoredSecret()
    {
        using ControllerHarness harness = ReadyHarness();
        using TestDirectory temp = new();
        GoogleDesktopClientStore clientStore = new(Path.Combine(temp.Path, "client.dat"));
        clientStore.Save(new(ClientId, "working-secret"));
        string file = Path.Combine(temp.Path, "download.json");
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new
        {
            installed = new { client_id = ClientId, client_secret = "new-secret" }
        }));
        using HttpClient http = new(new StalledBodyHandler());
        using GoogleCatalogueController controller = new(harness.Settings, harness.Store, harness.Vault, http, _ => { },
            clientStore: clientStore, operationTimeout: TimeSpan.FromMilliseconds(200));

        Task<GoogleCatalogueControllerException> import = Task.Run(() =>
            Assert.ThrowsException<GoogleCatalogueControllerException>(() => controller.ImportGoogleClientConfiguration(() => file)));
        Task finished = await Task.WhenAny(import, Task.Delay(TimeSpan.FromSeconds(10)));
        Assert.AreSame(import, finished, "The client secret check did not end at its own deadline.");
        Assert.AreEqual("google-client-configuration-check-failed", (await import).Code);
        Assert.AreEqual("working-secret", clientStore.Load(ClientId)!.ClientSecret);
    }

    private static void AssertSettingsRefusedAndUntouched(string path, Action operation)
    {
        byte[] damaged = Encoding.UTF8.GetBytes("{\"extensionId\": ");
        File.WriteAllBytes(path, damaged);
        Assert.AreEqual("invalid-settings", Assert.ThrowsException<GoogleCatalogueControllerException>(operation).Code);
        CollectionAssert.AreEqual(damaged, File.ReadAllBytes(path), "unreadable settings were rewritten");
    }

    [TestMethod]
    public void UnreadableSettingsAreRefusedAtEverySaveSiteAndLeftUntouched()
    {
        using ControllerHarness harness = ReadyHarness();
        using TestDirectory temp = new();
        GoogleDesktopClientStore clientStore = new(Path.Combine(temp.Path, "client.dat"));
        string file = Path.Combine(temp.Path, "download.json");
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new { installed = new { client_id = ClientId, client_secret = "secret" } }));
        using GoogleCatalogueController controller = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, _) => harness.Session,
            clientStore: clientStore, validateClientSecret: _ => Task.CompletedTask);
        string path = harness.Settings.SettingsPath;

        AssertSettingsRefusedAndUntouched(path, () => controller.saveGoogleClientId(OtherClientId));
        AssertSettingsRefusedAndUntouched(path, () => controller.saveGoogleSheetTarget("https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=2126708696"));
        AssertSettingsRefusedAndUntouched(path, () => controller.ImportGoogleClientConfiguration(() => file));
        Assert.IsNull(clientStore.Load(ClientId), "the credential was stored although settings could not be saved");
    }

    [TestMethod]
    public void ImportRefusesSettingsThatBecameUnreadableDuringTheSecretCheckAndLeavesThemUntouched()
    {
        using ControllerHarness harness = ReadyHarness();
        using TestDirectory temp = new();
        GoogleDesktopClientStore clientStore = new(Path.Combine(temp.Path, "client.dat"));
        string file = Path.Combine(temp.Path, "download.json");
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new { installed = new { client_id = ClientId, client_secret = "secret" } }));
        string path = harness.Settings.SettingsPath;
        byte[] damaged = Encoding.UTF8.GetBytes("{\"extensionId\": ");
        using GoogleCatalogueController controller = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, _) => harness.Session,
            clientStore: clientStore,
            validateClientSecret: _ => { File.WriteAllBytes(path, damaged); return Task.CompletedTask; });

        Assert.AreEqual("invalid-settings", Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => controller.ImportGoogleClientConfiguration(() => file)).Code);
        CollectionAssert.AreEqual(damaged, File.ReadAllBytes(path), "unreadable settings were rewritten");
        Assert.IsNull(clientStore.Load(ClientId), "the credential was stored although settings could not be saved");
    }

    [TestMethod]
    public void AbsentSettingsFileStillBehavesAsBefore()
    {
        using ControllerHarness harness = new(configure: false);
        Assert.IsFalse(File.Exists(harness.Settings.SettingsPath));
        harness.Controller.saveGoogleSheetTarget("https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=2126708696");
        Assert.IsNotNull(harness.Settings.Load().GoogleSheetUrl);
        File.Delete(harness.Settings.SettingsPath);
        harness.Controller.saveGoogleClientId(ClientId);
        Assert.AreEqual(ClientId, harness.Settings.Load().GoogleOAuthClientId);
    }

    private sealed class StalledBodyHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new StalledBodyContent() });
    }

    [TestMethod]
    public void RejectedDownloadedSecretDoesNotReplaceSavedCredential()
    {
        using ControllerHarness harness = ReadyHarness();
        using TestDirectory temp = new();
        GoogleDesktopClientStore clientStore = new(Path.Combine(temp.Path, "client.dat"));
        clientStore.Save(new(ClientId, "working-secret"));
        string file = Path.Combine(temp.Path, "old-download.json");
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new
        {
            installed = new { client_id = ClientId, client_secret = "stale-secret" }
        }));
        using GoogleCatalogueController controller = new(harness.Settings, harness.Store, harness.Vault,
            (_, _, _) => throw new AssertFailedException(), (_, _) => harness.Session,
            clientStore: clientStore,
            validateClientSecret: _ => Task.FromException(new GoogleOAuthException("google_client_secret_rejected")));

        GoogleCatalogueControllerException error = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => controller.ImportGoogleClientConfiguration(() => file));
        Assert.AreEqual("google-client-secret-rejected", error.Code);
        Assert.AreEqual("working-secret", clientStore.Load(ClientId)!.ClientSecret);
    }

    [TestMethod]
    public void ReadOnlyImportAddsLocalRowsWithoutMarkingSyncReadyOrCreatingBindings()
    {
        using ControllerHarness harness = new();
        harness.Controller.startGoogleCatalogueConnection();
        harness.Connection.Complete(new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow));
        var selection = harness.Store.GetGoogleCatalogueSelection();
        GoogleCatalogueImportResult result = harness.Controller.importGoogleCatalogue();
        Assert.AreEqual("needsInspection", result.Status.State);
        Assert.AreEqual(harness.Session.Inspection.Projection.Items.Count, result.ImportedItems);
        Assert.AreEqual(result.ImportedItems, harness.Store.GetCatalogue().Items.Count);
        Assert.AreEqual(0, harness.Store.GetGoogleBindings(WorkbookId).Count);
        Assert.AreEqual(selection, harness.Store.GetGoogleCatalogueSelection());
        Assert.AreEqual(0, harness.Session.MigrationCalls);
    }

    [TestMethod]
    public void MissingUploadEntryRefreshesTheLocalCatalogueAndRetriesTheSameIdOnce()
    {
        using ControllerHarness harness = ConnectedHarness();
        GoogleCatalogueImportPreview preview = new(harness.Session.Inspection.Projection, 17,
            harness.Session.Inspection.CatalogueSheetTitle, 1, new Dictionary<string, int>());
        int attempts = 0;
        harness.Session.WriteUploadEntryAction = request => ++attempts == 1
            ? Task.FromException<GoogleUploadEntryResult>(new GoogleCatalogueException("catalogue-entry-missing"))
            : Task.FromResult(new GoogleUploadEntryResult(request.Id!, 2, "already-updated", preview));

        object written = harness.Controller.WriteUploadEntry(UploadEntryPayload("stale-id"));

        StringAssert.Contains(JsonSerializer.Serialize(written), "\"status\":\"already-updated\"");
        Assert.AreEqual(1, harness.Session.ReadImportCalls);
        Assert.AreEqual(harness.Session.Inspection.Projection.Items.Count, harness.Store.GetItems().Count);
        CollectionAssert.AreEqual(new[] { "update:stale-id", "update:stale-id" },
            harness.Session.UploadEntryRequests.Select(request => $"{request.Mode}:{request.Id}").ToArray());
    }

    [TestMethod]
    public void UploadEntryStillMissingAfterRefreshFailsWithADistinctCodeAndNoNewRow()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.WriteUploadEntryAction = _ =>
            Task.FromException<GoogleUploadEntryResult>(new GoogleCatalogueException("catalogue-entry-missing"));

        GoogleCatalogueControllerException error = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.WriteUploadEntry(UploadEntryPayload("removed-id")));

        Assert.AreEqual("catalogue-entry-not-on-sheet", error.Code);
        Assert.AreEqual(1, harness.Session.ReadImportCalls);
        CollectionAssert.AreEqual(new[] { "update:removed-id", "update:removed-id" },
            harness.Session.UploadEntryRequests.Select(request => $"{request.Mode}:{request.Id}").ToArray());
    }

    [TestMethod]
    public void TeaserLinkWritebackRecordsOutcomesReimportsAndStaysWithinTheRunLimit()
    {
        using ControllerHarness harness = ConnectedHarness();
        DateTimeOffset now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);
        Dictionary<string, List<string>> sheet = [];
        bool refuseFirst = true;
        harness.Session.AppendTeaserLinkAction = (key, url) =>
        {
            if (key == "ep-1" && refuseFirst)
            {
                refuseFirst = false;
                return Task.FromException<GoogleTeaserLinkResult>(new GoogleCatalogueException("catalogue-entry-changed"));
            }
            if (!sheet.TryGetValue(key, out List<string>? urls)) sheet[key] = urls = [];
            urls.Add(url);
            return Task.FromResult(new GoogleTeaserLinkResult("appended", TeaserPreview(sheet)));
        };
        SeedBoundTeasers(harness.Store, sheet, now);

        XSheetWritebackRun first = harness.Controller.WriteBackTeaserLinks(now);

        Assert.AreEqual(new XSheetWritebackRun(true, 4, 0, 1), first);
        CollectionAssert.AreEqual(new[] { "ep-1", "ep-2", "ep-3", "ep-4", "ep-5" },
            harness.Session.TeaserLinkRequests.Select(request => request.Split('|')[0]).ToArray());
        Assert.AreEqual("ep-2|https://x.com/Owner_Handle/status/202", harness.Session.TeaserLinkRequests[1]);
        Assert.AreEqual(4L, Scalar(harness.Store, "SELECT COUNT(*) FROM x_post_bindings WHERE evidence='sheet-link'"),
            "re-import turns written links into sheet-link evidence");
        Assert.AreEqual(5L, Scalar(harness.Store, "SELECT COUNT(*) FROM audit_events WHERE kind='x-sheet-writeback'"));

        XSheetWritebackRun second = harness.Controller.WriteBackTeaserLinks(now.AddMinutes(10));
        Assert.AreEqual(new XSheetWritebackRun(true, 2, 0, 0), second, "the refused row waits for its backoff");
        XSheetWritebackRun third = harness.Controller.WriteBackTeaserLinks(now.AddHours(1));
        Assert.AreEqual(new XSheetWritebackRun(true, 1, 0, 0), third);
        Assert.AreEqual(new XSheetWritebackRun(true, 0, 0, 0), harness.Controller.WriteBackTeaserLinks(now.AddHours(2)));
        Assert.IsFalse(harness.Session.TeaserLinkRequests.Any(request => request.StartsWith("ep-8|", StringComparison.Ordinal)
            || request.EndsWith("/209", StringComparison.Ordinal) || request.EndsWith("/210", StringComparison.Ordinal)),
            "conflicted and unbound teasers are never written");
        XSheetWritebackStatus status = harness.Store.GetXSheetWritebackStatus(now.AddHours(2));
        Assert.AreEqual(7, status.Written);
        Assert.AreEqual(0, status.Pending);
    }

    [TestMethod]
    public void TeaserLinkWritebackNeedsAConnectionAndStopsOnAConnectionFailure()
    {
        DateTimeOffset now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);
        using (ControllerHarness offline = new())
        {
            SeedBoundTeasers(offline.Store, [], now);
            Assert.AreEqual(new XSheetWritebackRun(false, 0, 0, 0), offline.Controller.WriteBackTeaserLinks(now));
            Assert.AreEqual(0, offline.Session.TeaserLinkRequests.Count);
        }
        using ControllerHarness harness = ConnectedHarness();
        SeedBoundTeasers(harness.Store, [], now);
        harness.Session.AppendTeaserLinkAction = (_, _) =>
            Task.FromException<GoogleTeaserLinkResult>(new GoogleCatalogueException("google-reauthorization-required"));

        Assert.AreEqual(new XSheetWritebackRun(true, 0, 0, 1), harness.Controller.WriteBackTeaserLinks(now));
        Assert.AreEqual(1, harness.Session.TeaserLinkRequests.Count);
        Assert.AreEqual("google-reauthorization-required", harness.Store.GetXSheetWritebackStatus(now).LastCode);
    }

    // Seven teasers bound by first-reply paid links (ep-1..ep-7), one owner
    // binding contradicted by its reply link (209 -> ep-8) and one unbound (210).
    private static void SeedBoundTeasers(CatalogueStore store, Dictionary<string, List<string>> sheet, DateTimeOffset now)
    {
        store.ImportWorkbookProjection(TeaserPreview(sheet).Projection, updateGoogleBindings: false);
        XOwnerIdentity owner = new("1000000000000000001", "Owner_Handle");
        List<XObservation> posts = [];
        XObservation Post(string id, DateTimeOffset at, string? replyTo = null, string? link = null) =>
            new(id, "1000000000000000001", "Owner_Handle", at.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                link is null ? "benign teaser" : "full vid -> " + link, replyTo, replyTo ?? id, false,
                replyTo is null ? [new XObservedMedia("video", "7_1", 15_000, null)] : [], link is null ? [] : [link], null, "network");
        for (int index = 1; index <= 7; index++)
        {
            DateTimeOffset at = now.AddDays(-1).AddHours(index);
            posts.Add(Post($"20{index}", at));
            posts.Add(Post($"30{index}", at.AddMinutes(5), $"20{index}", $"https://fansly.com/post/70{index}"));
        }
        posts.Add(Post("209", now.AddHours(-2)));
        posts.Add(Post("309", now.AddHours(-1.9), "209", "https://fansly.com/post/702"));
        posts.Add(Post("210", now.AddHours(-1)));
        store.RecordXObservations(new(owner, posts), now);
        using Microsoft.Data.Sqlite.SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = "INSERT OR REPLACE INTO x_post_bindings VALUES "
            + "('209', (SELECT item_id FROM catalogue_items WHERE source_key = 'ep-8'), 'ep-8', 'owner', 'high', 'x')";
        command.ExecuteNonQuery();
        store.RefreshXBindings(now);
    }

    private static GoogleCatalogueImportPreview TeaserPreview(Dictionary<string, List<string>> sheet) => new(
        new(WorkbookId, "1", true, [.. Enumerable.Range(1, 8).Select(index => new WorkbookCatalogueItem(index + 1,
            $"ep-{index}", $"Episode {index}", "", null, null, null, 0, 0,
            new Dictionary<string, string> { ["fansly"] = $"https://fansly.com/post/{(index == 8 ? 800 : 700 + index)}" }, null,
            sheet.TryGetValue($"ep-{index}", out List<string>? urls)
                ? new Dictionary<string, CatalogueSourceLinkCell> { ["x"] = new(string.Join("\n", urls), null, [.. urls]) }
                : null))]),
        17, "2026 Video Catalogue", 1, new Dictionary<string, int>());

    private static object? Scalar(CatalogueStore store, string sql)
    {
        using Microsoft.Data.Sqlite.SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    private static JsonElement UploadEntryPayload(string id) => JsonSerializer.SerializeToElement(new
    {
        mode = "update", title = "Episode 2", description = "", releaseDate = "2026-09-18",
        id, expectedTitle = "Episode 2", expectedDescription = "",
    });

    [TestMethod]
    public void Configuration_and_background_connection_expose_only_coarse_status()
    {
        using ControllerHarness harness = new(configure: false);

        Assert.AreEqual("notConfigured", harness.Controller.getGoogleCatalogueStatus().State);
        GoogleCatalogueControllerException invalid = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.saveGoogleClientId("not-a-client-id")
        );
        Assert.AreEqual("invalid-google-client-id", invalid.Code);
        Assert.AreEqual("notConfigured", harness.Controller.getGoogleCatalogueStatus().State);
        Assert.AreEqual("disconnected", harness.Controller.saveGoogleClientId(ClientId).State);
        Assert.AreEqual("connecting", harness.Controller.startGoogleCatalogueConnection().State);
        GoogleCatalogueControllerException concurrent = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.startGoogleCatalogueConnection()
        );
        Assert.AreEqual("google-connection-in-progress", concurrent.Code);

        harness.Connection.Complete(new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow));
        GoogleCatalogueStatusView connected = harness.Controller.getGoogleCatalogueStatus();

        Assert.AreEqual("needsInspection", connected.State);
        Assert.AreEqual("Private catalogue", connected.WorkbookName);
        Assert.IsNull(connected.SheetName);
        Assert.IsNull(connected.PlanHash);
        Assert.IsNull(connected.ErrorCode);
        Assert.IsFalse(connected.ToString()!.Contains(WorkbookId, StringComparison.Ordinal));
    }

    [TestMethod]
    public void Cancel_returns_to_disconnected_without_an_error()
    {
        using ControllerHarness harness = new();
        harness.Controller.startGoogleCatalogueConnection();

        GoogleCatalogueStatusView cancelled = harness.Controller.cancelGoogleCatalogueConnection();

        Assert.AreEqual("disconnected", cancelled.State);
        Assert.IsNull(cancelled.ErrorCode);
        Assert.AreEqual(1, harness.Connection.CancelCalls);
    }

    [TestMethod]
    public void Changing_client_id_cancels_inflight_authorization_and_rejects_its_late_credential()
    {
        using ControllerHarness harness = new();
        harness.Controller.startGoogleCatalogueConnection();
        FakeConnection oldConnection = harness.Connection;

        GoogleCatalogueStatusView changed = harness.Controller.saveGoogleClientId(OtherClientId);
        oldConnection.Complete(
            new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow),
            new("old-client-refresh", DateTimeOffset.UtcNow, ClientId)
        );

        Assert.AreEqual("disconnected", changed.State);
        Assert.AreEqual(1, oldConnection.CancelCalls);
        Assert.IsTrue(oldConnection.Disposed);
        Assert.IsNull(harness.Vault.Load());
        Assert.IsNull(harness.Store.GetGoogleCatalogueSelection());
        Assert.AreEqual("disconnected", harness.Controller.getGoogleCatalogueStatus().State);
    }

    [TestMethod]
    public void Changing_client_id_disconnects_restored_state_and_stays_disconnected_after_restart()
    {
        using ControllerHarness harness = ReadyHarness();

        GoogleCatalogueStatusView changed = harness.Controller.saveGoogleClientId(OtherClientId);

        Assert.AreEqual("disconnected", changed.State);
        Assert.IsTrue(harness.Session.Disposed);
        Assert.IsNull(harness.Vault.Load());
        Assert.IsNull(harness.Store.GetGoogleCatalogueSelection());
        harness.RestartController();
        Assert.AreEqual("disconnected", harness.Controller.getGoogleCatalogueStatus().State);
    }

    [TestMethod]
    public void Failed_old_credential_deletion_still_invalidates_the_connected_session()
    {
        FailingDeleteTokenVault vault = new();
        using ControllerHarness harness = ReadyHarness(vault);
        vault.FailDelete = true;

        GoogleCatalogueControllerException error = Assert.ThrowsException<GoogleCatalogueControllerException>(() =>
            harness.Controller.saveGoogleClientId(OtherClientId)
        );

        Assert.AreEqual("google-client-id-change-failed", error.Code);
        Assert.IsTrue(harness.Session.Disposed);
        Assert.AreEqual("disconnected", harness.Controller.getGoogleCatalogueStatus().State);
        harness.RestartController();
        Assert.AreEqual("disconnected", harness.Controller.getGoogleCatalogueStatus().State);
    }

    [TestMethod]
    public void Cancel_outside_connecting_rejects_without_touching_restored_ready_state()
    {
        using ControllerHarness harness = ReadyHarness();
        harness.RestartController();
        GoogleRefreshCredential before = harness.Vault.Load()!;
        GoogleCatalogueSelection selectionBefore = harness.Store.GetGoogleCatalogueSelection()!;

        GoogleCatalogueControllerException error = Assert.ThrowsException<GoogleCatalogueControllerException>(
            harness.Controller.cancelGoogleCatalogueConnection
        );

        GoogleCatalogueStatusView status = harness.Controller.getGoogleCatalogueStatus();
        Assert.AreEqual("google-connection-not-in-progress", error.Code);
        Assert.AreEqual("ready", status.State);
        Assert.AreEqual(before, harness.Vault.Load());
        Assert.AreEqual(selectionBefore, harness.Store.GetGoogleCatalogueSelection());
        Assert.IsFalse(harness.Session.Disposed);
    }

    [TestMethod]
    public void Inspection_and_exact_hash_migration_reach_ready()
    {
        using ControllerHarness harness = ConnectedHarness();
        WorkbookInspection inspection = Inspection(alreadyMigrated: false);
        harness.Session.Inspection = inspection;
        harness.Session.Migration = new(
            "applied",
            inspection with
            {
                AlreadyMigrated = true,
                MigrationPlan = inspection.MigrationPlan with { Operations = [] },
            }
        );

        GoogleCatalogueStatusView preview = harness.Controller.inspectGoogleWorkbook();

        Assert.AreEqual("migrationReady", preview.State);
        Assert.AreEqual("2026 Video Catalogue", preview.SheetName);
        Assert.AreEqual(PlanHash, preview.PlanHash);
        Assert.AreEqual(0, preview.RowsToBind);
        Assert.AreEqual(1, preview.MigrationChanges);

        GoogleCatalogueControllerException stale = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.applyGoogleWorkbookMigration(new('b', 64))
        );
        Assert.AreEqual("stale-migration-plan", stale.Code);
        Assert.AreEqual(0, harness.Session.MigrationCalls);

        GoogleCatalogueStatusView ready = harness.Controller.applyGoogleWorkbookMigration(PlanHash);
        Assert.AreEqual("ready", ready.State);
        Assert.IsNull(ready.PlanHash);
        Assert.AreEqual(1, harness.Session.MigrationCalls);
    }

    [TestMethod]
    public void Already_migrated_inspection_imports_verified_projection_and_is_ready_with_zero_rows_to_bind()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(100, []);

        GoogleCatalogueStatusView ready = harness.Controller.inspectGoogleWorkbook();

        Assert.AreEqual("ready", ready.State);
        Assert.AreEqual(0, ready.RowsToBind);
        Assert.AreEqual(100, harness.Store.GetCatalogue().Items.Count);
        Assert.AreEqual(100, harness.Store.GetGoogleBindings(WorkbookId).Count);
    }

    [TestMethod]
    public void Rows_to_bind_counts_only_distinct_rows_missing_owned_identity_evidence()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(100, [17, 83]);

        GoogleCatalogueStatusView preview = harness.Controller.inspectGoogleWorkbook();

        Assert.AreEqual("migrationReady", preview.State);
        Assert.AreEqual(2, preview.RowsToBind);
        Assert.AreEqual(3, preview.MigrationChanges);
    }

    [TestMethod]
    public void Protected_credential_and_persisted_ready_selection_restore_without_browser_then_disconnect_clears_both()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Vault.Save(new("protected-refresh-token", DateTimeOffset.UtcNow, ClientId));
        harness.Session.Inspection = InspectionWithRows(2, []);
        Assert.AreEqual("ready", harness.Controller.inspectGoogleWorkbook().State);
        int factoriesBeforeRestart = harness.SessionFactoryCalls;

        harness.RestartController();
        GoogleCatalogueStatusView restored = harness.Controller.getGoogleCatalogueStatus();

        Assert.AreEqual("ready", restored.State);
        Assert.AreEqual("Private catalogue", restored.WorkbookName);
        Assert.AreEqual("2026 Video Catalogue", restored.SheetName);
        Assert.AreEqual(factoriesBeforeRestart + 1, harness.SessionFactoryCalls);
        Assert.AreEqual(0, harness.Connections.Count);
        Assert.AreEqual("ready", harness.Controller.syncGoogleCatalogue().State);
        Assert.AreEqual("1", harness.Session.LastSyncSheetId);

        Assert.AreEqual("disconnected", harness.Controller.disconnectGoogleCatalogue().State);
        harness.RestartController();
        GoogleCatalogueStatusView cleared = harness.Controller.getGoogleCatalogueStatus();
        Assert.AreEqual("disconnected", cleared.State);
        Assert.IsNull(cleared.WorkbookName);
        Assert.IsNull(cleared.SheetName);
        Assert.IsNull(harness.Vault.Load());
        Assert.IsNull(harness.Store.GetGoogleCatalogueSelection());
        Assert.AreEqual(0, harness.Store.GetGoogleBindings(WorkbookId).Count);
    }

    [TestMethod]
    public void Inconsistent_credential_and_selection_fail_closed_without_exposing_identifiers()
    {
        using ControllerHarness harness = new();
        harness.Store.SaveGoogleCatalogueWorkbook(WorkbookId, "Private catalogue");
        harness.Store.SaveGoogleCatalogueProfile(
            WorkbookId,
            "1",
            "2026 Video Catalogue",
            "catalogue-v1",
            true,
            DateTimeOffset.UtcNow
        );

        harness.RestartController();
        GoogleCatalogueStatusView status = harness.Controller.getGoogleCatalogueStatus();

        Assert.AreEqual("disconnected", status.State);
        Assert.IsNull(status.WorkbookName);
        Assert.IsNull(status.SheetName);
        Assert.IsFalse(status.ToString()!.Contains(WorkbookId, StringComparison.Ordinal));

        harness.Vault.Save(new("protected-refresh-token", DateTimeOffset.UtcNow, ClientId));
        harness.RestartController();
        GoogleCatalogueStatusView consistentPair = harness.Controller.getGoogleCatalogueStatus();
        Assert.AreEqual("ready", consistentPair.State);

        harness.Store.ClearGoogleCatalogueSelection();
        harness.RestartController();
        GoogleCatalogueStatusView credentialOnly = harness.Controller.getGoogleCatalogueStatus();
        Assert.AreEqual("disconnected", credentialOnly.State);
        Assert.IsNull(credentialOnly.WorkbookName);
        Assert.IsNull(credentialOnly.SheetName);
    }

    [TestMethod]
    public void Restart_rejects_and_removes_a_credential_minted_for_another_client()
    {
        using ControllerHarness harness = new();
        harness.Store.SaveGoogleCatalogueWorkbook(WorkbookId, "Private catalogue");
        harness.Store.SaveGoogleCatalogueProfile(
            WorkbookId,
            "1",
            "2026 Video Catalogue",
            "catalogue-v1",
            true,
            DateTimeOffset.UtcNow
        );
        harness.Vault.Save(new(
            "protected-refresh-token",
            DateTimeOffset.UtcNow,
            OtherClientId
        ));

        harness.RestartController();

        Assert.AreEqual("disconnected", harness.Controller.getGoogleCatalogueStatus().State);
        Assert.IsNull(harness.Vault.Load());
        Assert.AreEqual(0, harness.SessionFactoryCalls);
    }

    [TestMethod]
    public async Task Migration_and_sync_share_one_non_overlapping_operation_gate()
    {
        using ControllerHarness harness = ReadyHarness();
        TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        harness.Session.SyncAction = async cancellationToken =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(cancellationToken);
            return new GoogleSyncSummary(0, 0, 0, 0);
        };

        Task<GoogleCatalogueStatusView> first = Task.Run(
            harness.Controller.syncGoogleCatalogue
        );
        await entered.Task;

        GoogleCatalogueControllerException concurrent = Assert.ThrowsException<GoogleCatalogueControllerException>(
            harness.Controller.syncGoogleCatalogue
        );
        Assert.AreEqual("google-operation-in-progress", concurrent.Code);
        release.SetResult();
        Assert.AreEqual("ready", (await first).State);
    }

    [TestMethod]
    public async Task Connection_cannot_start_during_sync_and_starting_connection_hides_the_old_session()
    {
        using (ControllerHarness syncing = ReadyHarness())
        {
            TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            syncing.Session.SyncAction = async cancellationToken =>
            {
                entered.SetResult();
                await release.Task.WaitAsync(cancellationToken);
                return new GoogleSyncSummary(0, 0, 0, 0);
            };
            Task<GoogleCatalogueStatusView> sync = Task.Run(syncing.Controller.syncGoogleCatalogue);
            await entered.Task;

            GoogleCatalogueControllerException concurrent = Assert.ThrowsException<GoogleCatalogueControllerException>(
                () => syncing.Controller.startGoogleCatalogueConnection()
            );

            Assert.AreEqual("google-operation-in-progress", concurrent.Code);
            release.SetResult();
            Assert.AreEqual("ready", (await sync).State);
        }

        using ControllerHarness reconnecting = ReadyHarness();
        Assert.AreEqual("connecting", reconnecting.Controller.startGoogleCatalogueConnection().State);

        GoogleCatalogueControllerException unavailable = Assert.ThrowsException<GoogleCatalogueControllerException>(
            reconnecting.Controller.syncGoogleCatalogue
        );

        Assert.AreEqual("google-catalogue-disconnected", unavailable.Code);
        Assert.IsTrue(reconnecting.Session.Disposed);
    }

    [TestMethod]
    public async Task Connection_cannot_start_while_migration_is_mutating()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = Inspection(alreadyMigrated: false);
        harness.Controller.inspectGoogleWorkbook();
        TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        harness.Session.MigrationAction = async (_, cancellationToken) =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(cancellationToken);
            return harness.Session.Migration;
        };
        Task<GoogleCatalogueStatusView> migration = Task.Run(
            () => harness.Controller.applyGoogleWorkbookMigration(PlanHash)
        );
        await entered.Task;

        GoogleCatalogueControllerException concurrent = Assert.ThrowsException<GoogleCatalogueControllerException>(
            () => harness.Controller.startGoogleCatalogueConnection()
        );

        Assert.AreEqual("google-operation-in-progress", concurrent.Code);
        release.SetResult();
        Assert.AreEqual("ready", (await migration).State);
    }

    [TestMethod]
    public void Stale_connection_cannot_overwrite_or_delete_a_newer_connection_credential()
    {
        using ControllerHarness harness = new();
        harness.Controller.startGoogleCatalogueConnection();
        FakeConnection oldConnection = harness.Connection;
        harness.Controller.disconnectGoogleCatalogue();
        harness.Controller.startGoogleCatalogueConnection();
        FakeConnection newConnection = harness.Connection;
        GoogleRefreshCredential expected = new(
            "refresh-token-b",
            new DateTimeOffset(2026, 9, 4, 12, 0, 0, TimeSpan.Zero),
            ClientId
        );

        newConnection.Complete(
            new("workbook-b", "Workbook B", DateTimeOffset.UtcNow),
            expected
        );
        oldConnection.Complete(
            new("workbook-a", "Workbook A", DateTimeOffset.UtcNow),
            new("refresh-token-a", DateTimeOffset.UtcNow, ClientId)
        );

        GoogleRefreshCredential credential = harness.Vault.Load()!;
        GoogleCatalogueStatusView status = harness.Controller.getGoogleCatalogueStatus();

        Assert.AreEqual(expected, credential);
        Assert.AreEqual("needsInspection", status.State);
        Assert.AreEqual("Workbook B", status.WorkbookName);
        Assert.AreEqual(1, harness.SessionFactoryCalls);
    }

    [TestMethod]
    public async Task Disconnect_serializes_with_a_final_credential_save_and_leaves_no_credential()
    {
        BlockingGoogleTokenVault vault = new();
        using ControllerHarness harness = new(vault: vault);
        harness.Controller.startGoogleCatalogueConnection();
        Task completion = Task.Run(() => harness.Connection.Complete(
            new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow),
            new("final-refresh-token", DateTimeOffset.UtcNow, ClientId)
        ));
        await vault.SaveEntered;

        Task<GoogleCatalogueStatusView> disconnect = Task.Run(
            harness.Controller.disconnectGoogleCatalogue
        );
        vault.ReleaseSave();
        await Task.WhenAll(completion, disconnect);

        Assert.IsNull(vault.Load());
        Assert.AreEqual("disconnected", harness.Controller.getGoogleCatalogueStatus().State);
    }

    [TestMethod]
    public void OAuth_completion_uses_the_shared_catalogue_dispatcher_before_store_access()
    {
        List<Action> queued = [];
        using ControllerHarness harness = new(
            completionDispatcher: action =>
            {
                queued.Add(action);
                return Task.CompletedTask;
            }
        );
        harness.Controller.startGoogleCatalogueConnection();

        harness.Connection.Complete(new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow));

        Assert.AreEqual(1, queued.Count);
        Assert.IsNull(harness.Store.GetGoogleCatalogueSelection());
        queued.Single()();
        Assert.AreEqual(WorkbookId, harness.Store.GetGoogleCatalogueSelection()?.WorkbookId);
        Assert.AreEqual("needsInspection", harness.Controller.getGoogleCatalogueStatus().State);
    }

    [TestMethod]
    public void Status_counts_only_the_selected_workbook_and_sheet()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(1, []);
        harness.Controller.inspectGoogleWorkbook();
        string itemId = harness.Store.GetCatalogue().Items.Single().ItemId;
        SyncOutboxItem preservedPending = harness.Store.EnqueueProjection(Projection(
            itemId,
            "preserved-pending",
            "workbook-a"
        ));
        SyncOutboxItem preservedConflict = harness.Store.EnqueueProjection(Projection(
            itemId,
            "preserved-conflict",
            "workbook-a"
        ));
        harness.Store.MarkSyncPendingConflict(
            preservedConflict.OperationId,
            "remote-value-not-empty",
            DateTimeOffset.UtcNow
        );
        harness.Store.EnqueueProjection(Projection(itemId, "selected-pending", WorkbookId));
        SyncOutboxItem selectedConflict = harness.Store.EnqueueProjection(Projection(
            itemId,
            "selected-conflict",
            WorkbookId
        ));
        harness.Store.MarkSyncPendingConflict(
            selectedConflict.OperationId,
            "remote-value-not-empty",
            DateTimeOffset.UtcNow
        );

        GoogleCatalogueStatusView status = harness.Controller.getGoogleCatalogueStatus();

        Assert.AreEqual(1, status.PendingCount);
        Assert.AreEqual(1, status.ConflictCount);
        Assert.AreEqual(SyncOutboxState.Pending, harness.Store.GetSyncOperation(preservedPending.OperationId).State);
    }

    [TestMethod]
    public void Restart_restores_attempted_and_unresolved_counts_as_recovery_state()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.Inspection = InspectionWithRows(1, []);
        harness.Controller.inspectGoogleWorkbook();
        string itemId = harness.Store.GetCatalogue().Items.Single().ItemId;
        SyncOutboxItem attempted = harness.Store.EnqueueProjection(Projection(
            itemId,
            "selected-attempted",
            WorkbookId
        ));
        harness.Store.MarkSyncAttempted(attempted.OperationId, DateTimeOffset.UtcNow);
        SyncOutboxItem unresolved = harness.Store.EnqueueProjection(Projection(
            itemId,
            "selected-unresolved",
            WorkbookId
        ));
        harness.Store.MarkSyncAttempted(unresolved.OperationId, DateTimeOffset.UtcNow);
        harness.Store.MarkSyncUnresolved(
            unresolved.OperationId,
            "sync-readback-unavailable",
            DateTimeOffset.UtcNow
        );

        harness.RestartController();
        GoogleCatalogueStatusView status = harness.Controller.getGoogleCatalogueStatus();
        string json = System.Text.Json.JsonSerializer.Serialize(
            status,
            new System.Text.Json.JsonSerializerOptions
            {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
            }
        );

        Assert.AreEqual("conflict", status.State);
        Assert.AreEqual("google-sync-unresolved", status.ErrorCode);
        StringAssert.Contains(json, "\"attemptedCount\":1");
        StringAssert.Contains(json, "\"unresolvedCount\":1");
        Assert.AreEqual(SyncOutboxState.Attempted, harness.Store.GetSyncOperation(attempted.OperationId).State);
        Assert.AreEqual(SyncOutboxState.Unresolved, harness.Store.GetSyncOperation(unresolved.OperationId).State);
    }

    [TestMethod]
    public void Empty_sync_preserves_null_and_prior_last_verified_timestamp()
    {
        using ControllerHarness harness = ReadyHarness();
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(0, 0, 0, 0, false));

        GoogleCatalogueStatusView first = harness.Controller.syncGoogleCatalogue();

        Assert.IsNull(first.LastVerifiedSync);
        DateTimeOffset prior = new(2026, 9, 4, 9, 0, 0, TimeSpan.Zero);
        harness.Store.MarkGoogleCatalogueSync(WorkbookId, "1", prior);
        harness.RestartController();
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(0, 0, 0, 0, false));

        GoogleCatalogueStatusView second = harness.Controller.syncGoogleCatalogue();

        Assert.AreEqual(prior, second.LastVerifiedSync);
    }

    [TestMethod]
    public void Remote_readback_advances_last_verified_timestamp()
    {
        using ControllerHarness harness = ReadyHarness();
        DateTimeOffset before = DateTimeOffset.UtcNow.AddSeconds(-1);
        harness.Session.SyncAction = _ => Task.FromResult(new GoogleSyncSummary(1, 0, 0, 0, true));

        GoogleCatalogueStatusView result = harness.Controller.syncGoogleCatalogue();

        Assert.IsNotNull(result.LastVerifiedSync);
        Assert.IsTrue(result.LastVerifiedSync > before);
    }

    [TestMethod]
    public void Safe_error_mapping_never_returns_exception_text()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Session.InspectAction = _ => throw new InvalidOperationException(
            "refresh-token=secret authorization-code=secret C:\\private\\catalogue.db"
        );

        GoogleCatalogueControllerException error = Assert.ThrowsException<GoogleCatalogueControllerException>(
            harness.Controller.inspectGoogleWorkbook
        );

        Assert.AreEqual("google-catalogue-failed", error.Code);
        Assert.IsFalse(error.ToString().Contains("refresh-token", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(error.ToString().Contains("catalogue.db", StringComparison.OrdinalIgnoreCase));
    }

    [TestMethod]
    public void Disconnect_deletes_credentials_and_bindings_but_preserves_catalogue_and_outbox()
    {
        using ControllerHarness harness = ConnectedHarness();
        harness.Vault.Save(new("refresh-token", DateTimeOffset.UtcNow, ClientId));
        WorkbookCatalogueItem row = new(
            2,
            "episode-1",
            "Episode 1",
            "",
            null,
            null,
            null,
            0,
            0,
            new Dictionary<string, string>(),
            null
        );
        harness.Store.ImportWorkbookProjection(new(WorkbookId, "1", true, [row]));
        string itemId = harness.Store.GetCatalogue().Items.Single().ItemId;
        harness.Store.ReplaceGoogleBindings(
            WorkbookId,
            [
                new(
                    WorkbookId,
                    "1",
                    itemId,
                    Guid.NewGuid().ToString("D"),
                    2,
                    new('0', 64),
                    DateTimeOffset.UtcNow
                ),
            ]
        );
        string payload = "https://onlyfans.com/123456789/johnny_guides";
        harness.Store.EnqueueProjection(new(
            Guid.NewGuid().ToString("D"),
            Guid.NewGuid().ToString("D"),
            itemId,
            WorkbookId,
            "1",
            "ofenhancer.item_id.v1",
            itemId,
            "onlyfans",
            payload,
            new('0', 64),
            Fingerprint(payload),
            SyncOutboxState.Pending,
            0,
            null,
            DateTimeOffset.UtcNow,
            null,
            null,
            null
        ));

        GoogleCatalogueStatusView result = harness.Controller.disconnectGoogleCatalogue();

        Assert.AreEqual("disconnected", result.State);
        Assert.IsNull(harness.Vault.Load());
        Assert.AreEqual(0, harness.Store.GetGoogleBindings(WorkbookId).Count);
        Assert.AreEqual(1, harness.Store.GetCatalogue().Items.Count);
        Assert.AreEqual(1, harness.Store.GetOpenSyncOperations().Count);
        Assert.IsTrue(harness.Session.Disposed);
    }

    [TestMethod]
    public async Task Refresh_token_source_caches_access_tokens_and_force_refreshes_without_a_secret()
    {
        MemoryGoogleTokenVault vault = new();
        vault.Save(new("private-refresh-token", DateTimeOffset.UtcNow.AddMinutes(-1), ClientId));
        RecordingTokenHandler handler = new();
        using HttpClient http = new(handler);
        GoogleRefreshAccessTokenSource source = new(ClientId, http, vault);

        Assert.AreEqual("private-access-token-1", await source.GetAccessTokenAsync(false, CancellationToken.None));
        Assert.AreEqual("private-access-token-1", await source.GetAccessTokenAsync(false, CancellationToken.None));
        Assert.AreEqual("private-access-token-2", await source.GetAccessTokenAsync(true, CancellationToken.None));

        Assert.AreEqual(2, handler.Calls);
        Assert.IsTrue(handler.Bodies.All(body => body.Contains("grant_type=refresh_token", StringComparison.Ordinal)));
        Assert.IsTrue(handler.Bodies.All(body => body.Contains("refresh_token=private-refresh-token", StringComparison.Ordinal)));
        Assert.IsTrue(handler.Bodies.All(body => body.Contains($"client_id={ClientId}", StringComparison.Ordinal)));
        Assert.IsTrue(handler.Bodies.All(body => !body.Contains("client_secret", StringComparison.Ordinal)));
        source.Dispose();
        await Assert.ThrowsExceptionAsync<ObjectDisposedException>(async () =>
            await source.GetAccessTokenAsync(false, CancellationToken.None)
        );
    }

    [TestMethod]
    public async Task DesktopRefreshIncludesMatchingClientSecretOnlyInTokenPost()
    {
        MemoryGoogleTokenVault vault = new();
        vault.Save(new("refresh", DateTimeOffset.UtcNow, ClientId));
        RecordingTokenHandler handler = new();
        using HttpClient http = new(handler);
        using GoogleRefreshAccessTokenSource source = new(ClientId, http, vault, () => "desktop-secret");
        await source.GetAccessTokenAsync(false, CancellationToken.None);
        Assert.IsTrue(handler.Bodies.Single().Contains("client_secret=desktop-secret"));
    }

    [TestMethod]
    public async Task Refresh_token_source_rejects_a_credential_for_another_client_without_http()
    {
        MemoryGoogleTokenVault vault = new();
        vault.Save(new(
            "private-refresh-token",
            DateTimeOffset.UtcNow.AddMinutes(-1),
            OtherClientId
        ));
        RecordingTokenHandler handler = new();
        using HttpClient http = new(handler);
        using GoogleRefreshAccessTokenSource source = new(ClientId, http, vault);

        GoogleCatalogueException error = await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(async () =>
            await source.GetAccessTokenAsync(false, CancellationToken.None)
        );

        Assert.AreEqual("google-authorization-required", error.Code);
        Assert.AreEqual(0, handler.Calls);
    }

    [TestMethod]
    public void Production_http_and_browser_boundaries_disable_redirects_and_use_the_system_default()
    {
        using HttpClientHandler handler = GoogleHttpClientFactory.CreateHandler();
        using HttpClient client = GoogleHttpClientFactory.Create();
        Uri authorization = new("https://accounts.google.com/o/oauth2/v2/auth?redacted=true");
        System.Diagnostics.ProcessStartInfo start = GoogleBrowserLauncher.CreateStartInfo(authorization);

        Assert.IsFalse(handler.AllowAutoRedirect);
        Assert.AreEqual(TimeSpan.FromSeconds(30), client.Timeout);
        Assert.IsTrue(start.UseShellExecute);
        Assert.AreEqual(authorization.AbsoluteUri, start.FileName);
        Assert.AreEqual(0, start.ArgumentList.Count);
        Assert.IsFalse(start.FileName.Contains("chrome", StringComparison.OrdinalIgnoreCase));
    }

    private static ControllerHarness ConnectedHarness()
    {
        ControllerHarness harness = new();
        harness.Controller.startGoogleCatalogueConnection();
        harness.Connection.Complete(new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow));
        return harness;
    }

    private static ControllerHarness ReadyHarness(IGoogleTokenVault? vault = null)
    {
        ControllerHarness harness = vault is null ? ConnectedHarness() : new(vault: vault);
        if (vault is not null)
        {
            harness.Controller.startGoogleCatalogueConnection();
            harness.Connection.Complete(new(WorkbookId, "Private catalogue", DateTimeOffset.UtcNow));
        }
        WorkbookInspection inspection = Inspection(alreadyMigrated: false);
        harness.Session.Inspection = inspection;
        harness.Session.Migration = new(
            "applied",
            inspection with
            {
                AlreadyMigrated = true,
                MigrationPlan = inspection.MigrationPlan with { Operations = [] },
            }
        );
        harness.Controller.inspectGoogleWorkbook();
        harness.Controller.applyGoogleWorkbookMigration(PlanHash);
        return harness;
    }

    private static WorkbookInspection Inspection(bool alreadyMigrated)
    {
        WorkbookCatalogueItem row = new(
            2,
            "episode-1",
            "Episode 1",
            "",
            null,
            null,
            null,
            0,
            0,
            new Dictionary<string, string>(),
            Guid.NewGuid().ToString("D")
        );
        WorkbookProjection projection = new(WorkbookId, "1", true, [row]);
        GoogleRowBinding binding = new(
            WorkbookId,
            "1",
            row.MetadataId!,
            "7",
            2,
            new('0', 64),
            DateTimeOffset.UtcNow
        );
        WorkbookMigrationPlan plan = new(
            WorkbookId,
            1,
            "2026 Video Catalogue",
            new('1', 64),
            alreadyMigrated
                ? []
                : [new WorkbookMigrationOperation("set-technical-headers", "U1:X1", 1, [])]
        );
        return new(
            1,
            "2026 Video Catalogue",
            projection,
            [binding],
            [],
            [],
            plan,
            new('2', 64),
            PlanHash,
            alreadyMigrated
        );
    }

    private static WorkbookInspection InspectionWithRows(int rowCount, int[] missingRows)
    {
        WorkbookCatalogueItem[] rows = Enumerable.Range(2, rowCount).Select(row =>
        {
            string itemId = Guid.NewGuid().ToString("D");
            return new WorkbookCatalogueItem(
                row,
                $"episode-{row}",
                $"Episode {row}",
                "",
                null,
                null,
                null,
                0,
                0,
                new Dictionary<string, string>(),
                itemId
            );
        }).ToArray();
        GoogleRowBinding[] bindings = rows.Select(row => new GoogleRowBinding(
            WorkbookId,
            "1",
            row.MetadataId!,
            row.MetadataId!,
            row.SourceRow,
            new('0', 64),
            DateTimeOffset.UtcNow
        )).ToArray();
        List<WorkbookMigrationOperation> operations = missingRows.SelectMany((row, index) =>
        {
            List<WorkbookMigrationOperation> rowOperations =
            [
                new("add-metadata", $"1:{row}", row, ["ofenhancer.item_id.v1", bindings[row - 2].ItemId]),
            ];
            if (index == 0)
                rowOperations.Add(new("set-stable-id", $"'2026 Video Catalogue'!U{row}", row, [bindings[row - 2].ItemId]));
            return rowOperations;
        }).ToList();
        WorkbookProjection projection = new(WorkbookId, "1", true, rows);
        return new(
            1,
            "2026 Video Catalogue",
            projection,
            bindings,
            [],
            [],
            new(WorkbookId, 1, "2026 Video Catalogue", new('1', 64), operations),
            new('2', 64),
            PlanHash,
            operations.Count == 0
        );
    }

    private static string Fingerprint(string value) => Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(value))
    ).ToLowerInvariant();

    private static SyncOutboxItem Projection(string itemId, string idempotencyKey, string workbookId)
    {
        const string payload = "https://onlyfans.com/123456789/johnny_guides";
        return new(
            Guid.NewGuid().ToString("D"),
            idempotencyKey,
            itemId,
            workbookId,
            "1",
            "ofenhancer.item_id.v1",
            itemId,
            "onlyfans",
            payload,
            new('0', 64),
            Fingerprint(payload),
            SyncOutboxState.Pending,
            0,
            null,
            DateTimeOffset.UtcNow,
            null,
            null,
            null
        );
    }

    private sealed class ControllerHarness : IDisposable
    {
        private readonly TestDirectory _temp = new();

        internal ControllerHarness(
            bool configure = true,
            IGoogleTokenVault? vault = null,
            Func<Action, Task>? completionDispatcher = null
        )
        {
            Settings = new(Path.Combine(_temp.Path, "settings.json"));
            if (configure)
                Settings.Save(new(null, ClientId));
            Store = CatalogueStore.Open(Path.Combine(_temp.Path, "catalogue.db"));
            Vault = vault ?? new MemoryGoogleTokenVault();
            Session = new();
            CompletionDispatcher = completionDispatcher;
            Controller = CreateController();
        }

        private GoogleCatalogueController CreateController() => new(
                Settings,
                Store,
                Vault,
                (_, scopedVault, completed) =>
                {
                    FakeConnection connection = new(scopedVault) { Completed = completed };
                    Connections.Add(connection);
                    return connection;
                },
                (_, _) =>
                {
                    SessionFactoryCalls++;
                    return Session;
                },
                CompletionDispatcher
            );

        internal DesktopSettingsStore Settings { get; }
        internal CatalogueStore Store { get; }
        internal IGoogleTokenVault Vault { get; }
        internal Func<Action, Task>? CompletionDispatcher { get; }
        internal List<FakeConnection> Connections { get; } = [];
        internal FakeConnection Connection => Connections[^1];
        internal FakeSession Session { get; private set; }
        internal GoogleCatalogueController Controller { get; private set; }
        internal int SessionFactoryCalls { get; private set; }

        internal void RestartController()
        {
            Controller.Dispose();
            Connections.Clear();
            Session = new();
            Controller = CreateController();
        }

        public void Dispose()
        {
            Controller.Dispose();
            Store.Dispose();
            _temp.Dispose();
        }
    }

    private sealed class FakeConnection : IGoogleConnectionSession
    {
        private readonly IGoogleTokenVault _vault;

        internal FakeConnection(IGoogleTokenVault vault)
        {
            _vault = vault;
        }

        internal Action<GoogleConnectionCompletion>? Completed { get; set; }
        internal int CancelCalls { get; private set; }
        internal bool Disposed { get; private set; }
        internal GoogleSheetReference? Target { get; private set; }

        public GoogleConnectionSnapshot Snapshot { get; private set; } =
            new(GoogleConnectionState.Disconnected, null);

        public void Start(GoogleSheetReference? target = null)
        {
            Target = target;
            Snapshot = new(GoogleConnectionState.Connecting, null);
        }

        public void Cancel()
        {
            CancelCalls++;
            Snapshot = new(GoogleConnectionState.Disconnected, null);
        }

        internal void Complete(
            GoogleConnectionCompletion completion,
            GoogleRefreshCredential? credential = null
        )
        {
            _vault.Save(credential ?? new("fake-refresh-token", DateTimeOffset.UtcNow, ClientId));
            Snapshot = new(GoogleConnectionState.NeedsInspection, null);
            Completed!(completion);
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class FakeSession : IGoogleCatalogueSession
    {
        internal Func<UploadSheetWriteback, Action<int>, Task<GoogleTeaserLinkResult>>? WriteUploadLinkAction { get; set; }
        public Task<GoogleTeaserLinkResult> WriteUploadLinkAsync(UploadSheetWriteback intent, Action<int> beforeWrite,
            CancellationToken cancellationToken) => WriteUploadLinkAction!(intent, beforeWrite);
        internal WorkbookInspection Inspection { get; set; } =
            GoogleCatalogueControllerTests.Inspection(alreadyMigrated: false);
        internal WorkbookMigrationResult Migration { get; set; } =
            new("applied", GoogleCatalogueControllerTests.Inspection(alreadyMigrated: true));
        internal Func<CancellationToken, Task<WorkbookInspection>>? InspectAction { get; set; }
        internal Func<string, CancellationToken, Task<WorkbookMigrationResult>>? MigrationAction { get; set; }
        internal Func<CancellationToken, Task<GoogleSyncSummary>>? SyncAction { get; set; }
        internal int MigrationCalls { get; private set; }
        internal bool Disposed { get; private set; }
        internal string? LastSyncSheetId { get; private set; }

        public Task<WorkbookInspection> InspectAsync(CancellationToken cancellationToken) =>
            InspectAction?.Invoke(cancellationToken) ?? Task.FromResult(Inspection);

        internal Func<CancellationToken, Task<GoogleCatalogueImportPreview>>? ReadImportAction { get; set; }

        public Task<GoogleCatalogueImportPreview> ReadImportAsync(CancellationToken cancellationToken)
        {
            ReadImportCalls++;
            return ReadImportAction?.Invoke(cancellationToken) ?? Task.FromResult(new GoogleCatalogueImportPreview(Inspection.Projection, 17, Inspection.CatalogueSheetTitle, 1,
                new Dictionary<string, int>()));
        }

        public Task<GoogleSubredditPresetSnapshot> ReadSubredditPresetsAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new GoogleSubredditPresetSnapshot("snapshot",[],Inspection.CatalogueSheetTitle));

        internal Func<GoogleUploadEntryRequest, Task<GoogleUploadEntryResult>>? WriteUploadEntryAction { get; set; }
        internal List<GoogleUploadEntryRequest> UploadEntryRequests { get; } = [];
        internal int ReadImportCalls { get; private set; }

        public Task<GoogleUploadEntryResult> WriteUploadEntryAsync(GoogleUploadEntryRequest request,
            CancellationToken cancellationToken)
        {
            UploadEntryRequests.Add(request);
            return WriteUploadEntryAction!(request);
        }

        internal Func<string, string, Task<GoogleTeaserLinkResult>>? AppendTeaserLinkAction { get; set; }
        internal List<string> TeaserLinkRequests { get; } = [];

        public Task<GoogleTeaserLinkResult> AppendTeaserLinkAsync(string sourceKey, string url,
            CancellationToken cancellationToken)
        {
            TeaserLinkRequests.Add($"{sourceKey}|{url}");
            return AppendTeaserLinkAction!(sourceKey, url);
        }

        public Task<WorkbookMigrationResult> ApplyMigrationAsync(
            string planHash,
            CancellationToken cancellationToken
        )
        {
            MigrationCalls++;
            return MigrationAction?.Invoke(planHash, cancellationToken)
                ?? Task.FromResult(Migration);
        }

        public Task<GoogleSyncSummary> SyncAsync(string sheetId, CancellationToken cancellationToken)
        {
            LastSyncSheetId = sheetId;
            return SyncAction?.Invoke(cancellationToken)
                ?? Task.FromResult(new GoogleSyncSummary(0, 0, 0, 0));
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class TestDirectory : IDisposable
    {
        internal TestDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"ofenhancer-google-controller-{Guid.NewGuid():N}"
            );
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private sealed class FixedTokenSource : IGoogleAccessTokenSource
    {
        public ValueTask<string> GetAccessTokenAsync(bool forceRefresh, CancellationToken cancellationToken) =>
            ValueTask.FromResult("access");
    }

    private sealed class StallOnceTokenHandler : HttpMessageHandler
    {
        private int _calls;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            int call = Interlocked.Increment(ref _calls);
            if (call == 1)
                await Task.Delay(Timeout.Infinite, cancellationToken);
            return new(HttpStatusCode.OK)
            {
                RequestMessage = request,
                Content = new StringContent($$"""{"access_token":"private-access-token-{{call}}","expires_in":3600,"token_type":"Bearer"}""",
                    Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class StalledBodyContent : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => Task.Delay(Timeout.Infinite);
        protected override bool TryComputeLength(out long length) { length = -1; return false; }
        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new StalledBodyStream());
        protected override Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken) =>
            Task.FromResult<Stream>(new StalledBodyStream());
    }

    private sealed class StalledBodyStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class GoogleRoutingHandler : HttpMessageHandler
    {
        private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _sheets = [];
        internal List<Uri> SheetsRequests { get; } = [];

        internal void Sheets(string json) => _sheets.Enqueue(request => new(HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        });

        internal void StallNextSheetsBody() => _sheets.Enqueue(request => new(HttpStatusCode.OK)
        {
            RequestMessage = request,
            Content = new StalledBodyContent(),
        });

        internal static string Metadata(params (string Title, int Id)[] tabs) => $$"""
            {"spreadsheetId":"{{WorkbookId}}","properties":{"title":"Work"},"sheets":[{{string.Join(",", tabs.Select(tab => Properties(tab)))}}]}
            """;

        internal static string Tab((string Title, int Id) tab, bool withItem)
        {
            string item = withItem ? """,{"values":[{"formattedValue":"item-one"},{"formattedValue":"Video one"}]}""" : "";
            return $$"""
                {"spreadsheetId":"{{WorkbookId}}","properties":{"title":"Work"},"sheets":[{"properties":{{PropertiesBody(tab)}},"data":[{"rowData":[
                {"values":[{"formattedValue":"ID"},{"formattedValue":"Title"}]}{{item}}
                ]}]}]}
                """;
        }

        private static string Properties((string Title, int Id) tab) => "{\"properties\":" + PropertiesBody(tab) + "}";

        private static string PropertiesBody((string Title, int Id) tab) =>
            "{\"sheetId\":" + tab.Id + ",\"title\":\"" + tab.Title + "\",\"hidden\":false,\"gridProperties\":{\"rowCount\":50,\"columnCount\":6}}";

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.Host == "oauth2.googleapis.com")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    RequestMessage = request,
                    Content = new StringContent("""{"access_token":"private-access-token","expires_in":3600,"token_type":"Bearer"}""",
                        Encoding.UTF8, "application/json"),
                });
            SheetsRequests.Add(request.RequestUri);
            return Task.FromResult(_sheets.Dequeue()(request));
        }
    }

    private sealed class RecordingTokenHandler : HttpMessageHandler
    {
        internal int Calls { get; private set; }
        internal List<string> Bodies { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            Calls++;
            Bodies.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
            return new(HttpStatusCode.OK)
            {
                RequestMessage = request,
                Content = new StringContent(
                    $$"""{"access_token":"private-access-token-{{Calls}}","expires_in":3600,"token_type":"Bearer"}""",
                    Encoding.UTF8,
                    "application/json"
                ),
            };
        }
    }

    private sealed class BlockingGoogleTokenVault : IGoogleTokenVault
    {
        private readonly MemoryGoogleTokenVault _inner = new();
        private readonly TaskCompletionSource _saveEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _saveRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal Task SaveEntered => _saveEntered.Task;

        public GoogleRefreshCredential? Load() => _inner.Load();

        public void Save(GoogleRefreshCredential credential)
        {
            _saveEntered.TrySetResult();
            _saveRelease.Task.GetAwaiter().GetResult();
            _inner.Save(credential);
        }

        public void Delete() => _inner.Delete();

        internal void ReleaseSave() => _saveRelease.TrySetResult();
    }

    private sealed class FailingDeleteTokenVault : IGoogleTokenVault
    {
        private readonly MemoryGoogleTokenVault _inner = new();

        internal bool FailDelete { get; set; }

        public GoogleRefreshCredential? Load() => _inner.Load();

        public void Save(GoogleRefreshCredential credential) => _inner.Save(credential);

        public void Delete()
        {
            if (FailDelete)
                throw new InvalidOperationException("injected delete failure");
            _inner.Delete();
        }
    }
}
