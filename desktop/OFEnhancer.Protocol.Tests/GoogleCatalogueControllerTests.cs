using System.Security.Cryptography;
using System.Text;
using System.Net;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class GoogleCatalogueControllerTests
{
    private const string ClientId =
        "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
    private const string WorkbookId = "private-workbook-id";
    private static readonly string PlanHash = new('a', 64);

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
        harness.Vault.Save(new("protected-refresh-token", DateTimeOffset.UtcNow));
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

        harness.Vault.Save(new("protected-refresh-token", DateTimeOffset.UtcNow));
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
                syncing.Controller.startGoogleCatalogueConnection
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
            harness.Controller.startGoogleCatalogueConnection
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
            new DateTimeOffset(2026, 9, 4, 12, 0, 0, TimeSpan.Zero)
        );

        newConnection.Complete(
            new("workbook-b", "Workbook B", DateTimeOffset.UtcNow),
            expected
        );
        oldConnection.Complete(
            new("workbook-a", "Workbook A", DateTimeOffset.UtcNow),
            new("refresh-token-a", DateTimeOffset.UtcNow)
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
            new("final-refresh-token", DateTimeOffset.UtcNow)
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
        harness.Vault.Save(new("refresh-token", DateTimeOffset.UtcNow));
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
        vault.Save(new("private-refresh-token", DateTimeOffset.UtcNow.AddMinutes(-1)));
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

    private static ControllerHarness ReadyHarness()
    {
        ControllerHarness harness = ConnectedHarness();
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

        internal ControllerHarness(bool configure = true, IGoogleTokenVault? vault = null)
        {
            Settings = new(Path.Combine(_temp.Path, "settings.json"));
            if (configure)
                Settings.Save(new(null, ClientId));
            Store = CatalogueStore.Open(Path.Combine(_temp.Path, "catalogue.db"));
            Vault = vault ?? new MemoryGoogleTokenVault();
            Session = new();
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
                }
            );

        internal DesktopSettingsStore Settings { get; }
        internal CatalogueStore Store { get; }
        internal IGoogleTokenVault Vault { get; }
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

        public GoogleConnectionSnapshot Snapshot { get; private set; } =
            new(GoogleConnectionState.Disconnected, null);

        public void Start()
        {
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
            _vault.Save(credential ?? new("fake-refresh-token", DateTimeOffset.UtcNow));
            Snapshot = new(GoogleConnectionState.NeedsInspection, null);
            Completed!(completion);
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class FakeSession : IGoogleCatalogueSession
    {
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
}
