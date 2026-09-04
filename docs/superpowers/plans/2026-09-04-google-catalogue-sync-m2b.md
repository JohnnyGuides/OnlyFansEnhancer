# Google Catalogue Sync Milestone 2B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Windows desktop app a secure, user-selected Google catalogue connection with deterministic migration, stable row identity, and crash-safe verified synchronization.

**Architecture:** SQLite remains the operational source and gains a narrow row-binding/outbox schema. The WPF process performs system-browser Picker OAuth, stores only a DPAPI-protected refresh token, talks directly to allow-listed Drive/Sheets REST endpoints, and exposes coarse status/actions to the existing WebView. Every workbook mutation is derived from a fresh plan or outbox record and is verified by readback before local completion.

**Tech Stack:** .NET 8, WPF/WebView2, `Microsoft.Data.Sqlite` 8.0.20, `System.Security.Cryptography.ProtectedData` 8.0.0, Google OAuth/Drive/Sheets REST, vanilla HTML/CSS/JavaScript, MSTest, Node test runner, Playwright 1.62.0.

**Spec:** `docs/superpowers/specs/2026-09-04-google-catalogue-sync-m2b-design.md`

## Global Constraints

- Request exactly `https://www.googleapis.com/auth/drive.file`; do not request `drive`, `spreadsheets`, identity, or profile scopes.
- OAuth uses the system browser, `127.0.0.1` random-port loopback, state, PKCE S256, `prompt=consent`, `trigger_onepick=true`, and a one-spreadsheet MIME filter.
- No client secret, token, authorization code, bearer header, personal workbook ID, absolute path, or private request material may cross the WebView, enter SQLite audit details, logs, tests, or packages.
- Automated tests use fake HTTP/callback services and temporary files only; they never mutate the live Sheet, post, install registry entries, or move real media.
- Mutating HTTP requests never retry blindly. `attempted` outbox work reconciles by read only before any new authorization.
- Google rows are located by `ofenhancer.item_id.v1` developer metadata; a physical row number is supporting evidence only.
- Workbook migration is additive, idempotent, freshly re-planned, and authorized by one exact plan-hash Yes.
- Existing Sheet tabs/data and the legacy distribution ledger are preserved.
- UI copy stays concise and human; normal operation does not expose OAuth, metadata, fingerprint, or outbox jargon.
- Version all shipped surfaces together at `0.20.0`.

---

### Task 1: Schema 2, stable workbook bindings, and monotonic sync outbox

**Files:**
- Modify: `desktop/OFEnhancer.Catalogue/Migrations.cs`
- Modify: `desktop/OFEnhancer.Catalogue/Models.cs`
- Create: `desktop/OFEnhancer.Catalogue/WorkbookProjection.cs`
- Create: `desktop/OFEnhancer.Catalogue/SyncOutbox.cs`
- Modify: `desktop/OFEnhancer.Catalogue.Tests/CatalogueStoreTests.cs`
- Create: `desktop/OFEnhancer.Catalogue.Tests/WorkbookProjectionTests.cs`
- Create: `desktop/OFEnhancer.Catalogue.Tests/SyncOutboxTests.cs`

**Interfaces:**
- Produces: `WorkbookCatalogueItem`, `WorkbookProjection`, `GoogleRowBinding`, `SyncOutboxItem`, and `SyncOutboxState` records/enums in `OFEnhancer.Catalogue`.
- Produces: `CatalogueStore.ImportWorkbookProjection(WorkbookProjection)`, `ReplaceGoogleBindings(...)`, `GetGoogleBindings(...)`, `EnqueueProjection(...)`, `GetOpenSyncOperations()`, `MarkSyncAttempted(...)`, `MarkSyncCompleted(...)`, `MarkSyncConflict(...)`, and `MarkSyncUnresolved(...)`.
- Consumes: the existing one-writer `CatalogueStore.Connection`, verified migration backup, canonical URL validation, and item identity.

- [ ] **Step 1: Write failing schema and migration recovery tests**

Add tests proving a fresh database reaches schema 2 with only the two new tables, a version-1 fixture migrates with a verified sibling backup, and an injected version-3 failure restores the exact schema-2 rows.

```csharp
[TestMethod]
public void VersionTwoAddsOnlyBindingsAndOutbox()
{
    using TempDirectory temp = new();
    using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
    Assert.AreEqual(2, store.SchemaVersion);
    CollectionAssert.Contains(ReadUserTables(store.DatabasePath), "google_row_bindings");
    CollectionAssert.Contains(ReadUserTables(store.DatabasePath), "sync_outbox");
}
```

- [ ] **Step 2: Run the store tests and verify the expected red state**

Run: `dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj --filter CatalogueStoreTests`

Expected: FAIL because schema version 2 and the two tables do not exist.

- [ ] **Step 3: Add migration version 2**

Create `google_row_bindings` with unique `(workbook_id, sheet_id, item_id)` and `(workbook_id, metadata_id)` constraints, and `sync_outbox` with unique `idempotency_key`, item foreign key, a five-value state check, non-negative attempt count, bounded-by-code payload fields, and timestamps. Append `VersionTwo` to `Migrations.All`; keep backup/transaction/restore unchanged.

- [ ] **Step 4: Run the store tests green**

Run: `dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj --filter CatalogueStoreTests`

Expected: PASS, including the prior forced-migration restore proof.

- [ ] **Step 5: Write failing workbook projection tests**

Cover adoption of a metadata GUID on a fresh store, retention of an existing local ID by source key before migration, complete-pull archival, all-or-nothing duplicate-ID rejection, and no archival on an incomplete snapshot.

```csharp
[TestMethod]
public void StableMetadataIdSurvivesRowMoveAndFreshLocalImport()
{
    Guid stable = Guid.NewGuid();
    store.ImportWorkbookProjection(Projection(complete: true, Row(93, stable)));
    store.ImportWorkbookProjection(Projection(complete: true, Row(14, stable)));
    Assert.AreEqual(stable.ToString("D"), store.GetItems().Single().ItemId);
    Assert.AreEqual(14, store.GetItems().Single().SourceRow);
}
```

- [ ] **Step 6: Run projection tests red, implement, then run green**

Run red: `dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj --filter WorkbookProjectionTests`

Implement strict bounded records and one transaction that resolves by stable item ID first, source key second, inserts an adopted valid GUID when safe, and archives only on `Complete == true`.

Run green: the same command. Expected: PASS.

- [ ] **Step 7: Write failing monotonic outbox tests**

Test idempotent enqueue, payload validation, `pending -> attempted -> completed`, `attempted -> conflict|unresolved`, refusal to move backward, immutable identity/value/fingerprints, and stable ordering.

```csharp
[TestMethod]
public void AttemptedOperationCannotReturnToPendingOrChangeItsIntent()
{
    SyncOutboxItem item = store.EnqueueProjection(Request("onlyfans", CanonicalOnlyFans));
    store.MarkSyncAttempted(item.OperationId, Clock);
    Assert.ThrowsException<SyncOutboxException>(() =>
        store.EnqueueProjection(Request("onlyfans", DifferentOnlyFans, item.IdempotencyKey)));
}
```

- [ ] **Step 8: Run outbox tests red, implement, then run all catalogue tests**

Run red: `dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj --filter SyncOutboxTests`

Implement parameterized SQLite commands and a transaction per transition. Validate allow-listed fields, public canonical URLs/counts/timestamps, SHA-256 hex fingerprints, GUID IDs, and maximum lengths before SQL.

Run green: `dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj`

Expected: all catalogue tests pass.

- [ ] **Step 9: Commit Task 1**

```powershell
git add desktop/OFEnhancer.Catalogue desktop/OFEnhancer.Catalogue.Tests
git commit -m "feat: add catalogue sync outbox"
```

---

### Task 2: OAuth protocol, protected token vault, and cancellable connection coordinator

**Files:**
- Modify: `desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj`
- Create: `desktop/OFEnhancer.Desktop/GoogleOAuthProtocol.cs`
- Create: `desktop/OFEnhancer.Desktop/GoogleTokenVault.cs`
- Create: `desktop/OFEnhancer.Desktop/GoogleConnectionCoordinator.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleOAuthProtocolTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleTokenVaultTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleConnectionCoordinatorTests.cs`

**Interfaces:**
- Produces: `GoogleOAuthStart CreateStart(string clientId, Uri redirectUri)`, `GoogleOAuthCallback ParseCallback(Uri, string expectedState)`, and `Task<GoogleTokenSet> ExchangeCodeAsync(...)`.
- Produces: `IGoogleTokenVault` with `Load()`, `Save(GoogleRefreshCredential)`, and `Delete()`; production `DpapiGoogleTokenVault` and test `MemoryGoogleTokenVault`.
- Produces: `GoogleConnectionCoordinator.Start()`, `Cancel()`, `Snapshot`, and a completion callback containing only selected workbook ID/title and credential expiry.
- Consumes: an injected `HttpClient`, injected default-browser opener, injected callback receiver, configured client ID, and token vault.

- [ ] **Step 1: Write failing OAuth URL/callback tests**

Assert exact authorization host/path, exact single scope, offline access, consent and Picker flags, Sheets MIME filter, state, PKCE S256, no client secret, rejection of changed state/multiple IDs/error callbacks, and redacted `ToString()` values.

```csharp
[TestMethod]
public void PickerAuthorizationUsesOnlyDriveFileAndPkce()
{
    GoogleOAuthStart start = GoogleOAuthProtocol.CreateStart(ClientId, new("http://127.0.0.1:53123/"));
    NameValueCollection query = HttpUtility.ParseQueryString(start.AuthorizationUri.Query);
    Assert.AreEqual("https://www.googleapis.com/auth/drive.file", query["scope"]);
    Assert.AreEqual("true", query["trigger_onepick"]);
    Assert.AreEqual("S256", query["code_challenge_method"]);
    Assert.IsNull(query["client_secret"]);
}
```

- [ ] **Step 2: Run OAuth tests red, implement protocol, run green**

Run red: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleOAuthProtocolTests`

Implement cryptographic Base64URL state/verifier/challenge, strict callback query parsing, form-encoded token exchange, response size limits, exact token endpoint, and JSON models whose diagnostic strings reveal no token values.

Run green: same command. Expected: PASS.

- [ ] **Step 3: Write failing token-vault tests**

Use a temporary folder and injected `ITokenProtector` to prove atomic save/read/delete, permissions scoped to the current user, corrupt ciphertext rejection, no plaintext token in the file, and no token in exception messages.

- [ ] **Step 4: Run vault tests red, add DPAPI implementation, run green**

Add `System.Security.Cryptography.ProtectedData` 8.0.0 to the desktop project. Write to a random sibling, flush, then atomically replace/move. Use `DataProtectionScope.CurrentUser` with a fixed product entropy label. Delete only the exact configured token file.

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleTokenVaultTests`

Expected: PASS.

- [ ] **Step 5: Write failing coordinator tests**

Use a fake callback receiver and HTTP handler to prove Start returns immediately, opens one system-browser URL, rejects a second concurrent start, Cancel closes the receiver without an error, successful completion saves a refresh credential, and a changed state/wrong picked file saves nothing.

- [ ] **Step 6: Run coordinator tests red, implement, and run green**

Implement a one-shot `HttpListener` receiver bound to `127.0.0.1` on a random free port, a 5-minute cancellation timeout, a minimal no-store completion page, and an injectable receiver interface for tests. The coordinator owns one background task and exposes only coarse state.

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleConnectionCoordinatorTests`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add desktop/OFEnhancer.Desktop desktop/OFEnhancer.Protocol.Tests
git commit -m "feat: add secure Google picker OAuth"
```

---

### Task 3: Allow-listed Google REST client and deterministic workbook inspection

**Files:**
- Create: `desktop/OFEnhancer.Desktop/GoogleWorkspaceClient.cs`
- Create: `desktop/OFEnhancer.Desktop/GoogleWorkbookProfile.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleWorkspaceClientTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleWorkbookProfileTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/Fixtures/google-workbook-legacy.json`
- Create: `desktop/OFEnhancer.Protocol.Tests/Fixtures/google-workbook-ambiguous.json`

**Interfaces:**
- Produces: `ValidateSpreadsheetAsync(fileId)`, `ReadWorkbookAsync(fileId)`, `SearchItemMetadataAsync(...)`, `ReadProjectionCellAsync(...)`, `ApplyStructuralBatchAsync(...)`, and `UpdateValuesBatchAsync(...)`.
- Produces: pure `GoogleWorkbookProfile.Inspect(GoogleWorkbookSnapshot, CatalogueStore)` returning `WorkbookInspection` with normalized projection, bindings, conflicts, `WorkbookMigrationPlan`, and `PlanHash`.
- Consumes: `IGoogleAccessTokenSource`, injected `HttpClient`, `WorkbookProjection`, and existing canonical catalogue import rules.

- [ ] **Step 1: Write failing REST boundary tests**

Record fake requests and assert exact Drive/Sheets origins, percent-encoded IDs/ranges, bearer header placement, fields/range limits, response byte limits, one refresh/retry for a read-only 401, no redirect, and no retry after a mutating timeout.

```csharp
[TestMethod]
public async Task MutationTimeoutIsReturnedForReconciliationWithoutSecondPost()
{
    FakeHandler handler = FakeHandler.TimeoutAfterAcceptingMutation();
    await Assert.ThrowsExceptionAsync<GoogleMutationUncertainException>(() => client.UpdateValuesBatchAsync(batch));
    Assert.AreEqual(1, handler.PostCount);
}
```

- [ ] **Step 2: Run REST tests red, implement the minimal client, run green**

Run red: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleWorkspaceClientTests`

Implement explicit URI builders and bounded `JsonDocument` parsing. Do not add a Google SDK or general retry policy.

Run green: same command. Expected: PASS.

- [ ] **Step 3: Write failing profile-inspection tests**

Cover exact legacy profile discovery, tab-name tie-break only after schema match, zero/multiple profile failure, 5,000-row cap, malformed date/link rejection, duplicate metadata, metadata row move, conflicting U:X cells, missing companion tabs, already migrated workbook, and deterministic plan hash independent of JSON property order.

- [ ] **Step 4: Run profile tests red, implement pure inspection, run green**

Parse only the bounded snapshot models. Map the legacy columns, validate developer metadata key/value/location, resolve or create local item IDs through `ImportWorkbookProjection`, and sort plan operations before SHA-256 hashing canonical JSON.

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleWorkbookProfileTests`

Expected: PASS.

- [ ] **Step 5: Run both .NET suites and commit Task 3**

Run sequentially:

```powershell
dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj
dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj
```

Expected: all tests pass.

```powershell
git add desktop/OFEnhancer.Desktop desktop/OFEnhancer.Protocol.Tests
git commit -m "feat: inspect Google catalogue workbooks"
```

---

### Task 4: Idempotent workbook migration and verified binding persistence

**Files:**
- Create: `desktop/OFEnhancer.Desktop/GoogleWorkbookMigrator.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleWorkbookMigratorTests.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/Fixtures/google-workbook-legacy.json`

**Interfaces:**
- Produces: `Task<WorkbookMigrationResult> ApplyAsync(string expectedPlanHash, CancellationToken)`.
- Consumes: fresh `GoogleWorkbookProfile.Inspect`, `GoogleWorkspaceClient`, `CatalogueStore.ReplaceGoogleBindings`, and the exact versioned companion-tab/header contracts.

- [ ] **Step 1: Write failing migration tests**

Assert one fresh re-inspection before mutation, stale hash rejection with zero POSTs, additive requests for `_Publications`, `_Assets`, `_Audit`, U:X headers/grouping, stable-ID values, document-visible row metadata, exact companion headers, and no requests touching foreign ranges. Cover complete replay as idempotent success.

```csharp
[TestMethod]
public async Task ChangedWorkbookInvalidatesApprovedPlanBeforeMutation()
{
    Workspace.EnqueueSnapshot(ApprovedSnapshot);
    Workspace.EnqueueSnapshot(ChangedSnapshot);
    await Assert.ThrowsExceptionAsync<GoogleCatalogueException>(() => migrator.ApplyAsync(ApprovedHash, Token));
    Assert.AreEqual(0, Workspace.MutationCount);
}
```

- [ ] **Step 2: Run migration tests red, implement request planning, run green**

Run red: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleWorkbookMigratorTests`

Create one structural batch in deterministic order. Assign each new tab a random positive sheet ID that is absent from the freshly inspected workbook so dependent metadata/header requests can remain in the same atomic batch. No existing sheet is renamed or deleted.

Run green: same command. Expected: PASS.

- [ ] **Step 3: Add uncertain-result reconciliation tests and implementation**

Test a timeout after the fake server applies the batch. The migrator must re-inspect, recognize every intended structure/value/metadata item, persist bindings, and return `reconciled`; if readback is incomplete it returns `unresolved` and sends no second mutation.

- [ ] **Step 4: Run migration and full protocol tests**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj`

Expected: PASS with exactly one mutation in every uncertain-result fixture.

- [ ] **Step 5: Commit Task 4**

```powershell
git add desktop/OFEnhancer.Desktop desktop/OFEnhancer.Protocol.Tests
git commit -m "feat: migrate Google catalogue safely"
```

---

### Task 5: Serialized outbox synchronization and reconciliation

**Files:**
- Create: `desktop/OFEnhancer.Desktop/GoogleCatalogueSyncWorker.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleCatalogueSyncWorkerTests.cs`

**Interfaces:**
- Produces: `Task<GoogleSyncSummary> RunOnceAsync(CancellationToken)`.
- Consumes: `CatalogueStore.GetOpenSyncOperations`, monotonic transition methods, exactly-one metadata row search, exact cell read/write, and canonical field-to-column mapping from `GoogleWorkbookProfile`.

- [ ] **Step 1: Write failing pending-operation tests**

Cover metadata row movement, already-applied idempotency, expected-fingerprint drift, non-empty foreign value protection, attempted-before-POST ordering, exact one-cell batch, readback completion, and sibling isolation.

```csharp
[TestMethod]
public async Task RowMoveUsesMetadataAndWritesOnlyTheResolvedOwnedCell()
{
    Store.EnqueueProjection(OperationForRowEvidence(12));
    Workspace.MetadataRow = 93;
    GoogleSyncSummary summary = await worker.RunOnceAsync(Token);
    Assert.AreEqual("'2026 Video Catalogue'!J93", Workspace.SingleWrittenRange);
    Assert.AreEqual(SyncOutboxState.Completed, Store.GetOperation(OperationId).State);
}
```

- [ ] **Step 2: Run worker tests red, implement pending path, run green**

Run red: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter GoogleCatalogueSyncWorkerTests`

Implement one in-process semaphore, stable operation ordering, metadata re-resolution, fingerprint comparison, `attempted` transaction before HTTP, exact values batch, and readback.

Run green: same command. Expected: PASS.

- [ ] **Step 3: Write failing attempted/unresolved reconciliation tests**

Prove attempted rows never POST, intended value completes by read, differing value conflicts, missing/unavailable read remains unresolved, and a later manual Sync read may resolve without resetting state.

- [ ] **Step 4: Implement reconciliation and run all .NET tests**

Run sequentially:

```powershell
dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj
dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj
```

Expected: all tests pass, and fake mutation counters prove no repost/rewrite after uncertainty.

- [ ] **Step 5: Commit Task 5**

```powershell
git add desktop/OFEnhancer.Desktop desktop/OFEnhancer.Protocol.Tests
git commit -m "feat: synchronize catalogue outbox safely"
```

---

### Task 6: Desktop configuration, controller, strict WebView operations, and system-browser wiring

**Files:**
- Modify: `desktop/OFEnhancer.Desktop/AppConfiguration.cs`
- Create: `desktop/OFEnhancer.Desktop/DesktopSettingsStore.cs`
- Create: `desktop/OFEnhancer.Desktop/GoogleCatalogueController.cs`
- Modify: `desktop/OFEnhancer.Desktop/WebMessageRouter.cs`
- Modify: `desktop/OFEnhancer.Desktop/MainWindow.xaml.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/AppConfigurationTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/DesktopSettingsStoreTests.cs`
- Create: `desktop/OFEnhancer.Protocol.Tests/GoogleCatalogueControllerTests.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/WebMessageRouterTests.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/WebMessageDispatcherTests.cs`

**Interfaces:**
- Produces: atomic settings read/write for `extensionId` and `googleOAuthClientId`, plus `GoogleTokenPath` under the data folder.
- Produces: controller methods named exactly after the eight spec operations, returning `GoogleCatalogueStatusView` only.
- Consumes: coordinator, inspector, migrator, sync worker, catalogue store, system default-browser opener, and existing serialized dispatcher.

- [ ] **Step 1: Write failing settings tests**

Prove a valid installed-app client ID round-trips without losing extension ID, malformed/unknown JSON fails safely, atomic replace leaves valid old or new JSON after injected failure, and neither token nor workbook ID belongs in `settings.json` before connection.

- [ ] **Step 2: Run settings tests red, implement store, run green**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter "AppConfigurationTests|DesktopSettingsStoreTests"`

Expected after implementation: PASS.

- [ ] **Step 3: Write failing controller/router tests**

Cover every operation's exact empty/payload schema, unavailable service, invalid client ID, concurrent connect/sync, cancellation, stale migration hash, disconnect preservation, safe error-code mapping, and the absence of token/code/path fields in serialized responses.

```csharp
[TestMethod]
public void MigrationRouteAcceptsOnlyOnePlanHash()
{
    AssertError(router.Handle(Request("applyGoogleWorkbookMigration", new { planHash = "bad" })), "invalid-payload");
    AssertError(router.Handle(Request("applyGoogleWorkbookMigration", new { planHash = ValidHash, extra = true })), "invalid-payload");
}
```

- [ ] **Step 4: Run router tests red, implement controller/routes, run green**

Run: `dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj --filter "GoogleCatalogueControllerTests|WebMessageRouterTests|WebMessageDispatcherTests"`

Keep the router as a strict serializer/validator; no token models enter it. Long work executes on the existing serialized worker. Connection start itself schedules its background browser wait and returns immediately.

- [ ] **Step 5: Wire production services and run desktop build/tests**

Use `ProcessStartInfo { UseShellExecute = true }` with the authorization URI and no `chrome.exe` override for Google; retain explicit Chrome opening only for the uploader. Construct one HttpClient with redirects disabled and a bounded timeout. Dispose controller/coordinator/client on app exit.

Run:

```powershell
dotnet build desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj
dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj
```

Expected: PASS with no real network/browser action in tests.

- [ ] **Step 6: Commit Task 6**

```powershell
git add desktop/OFEnhancer.Desktop desktop/OFEnhancer.Protocol.Tests
git commit -m "feat: expose Google catalogue sync to desktop UI"
```

---

### Task 7: Compact Catalogue sync UI and one Yes/No migration review

**Files:**
- Modify: `app/index.html`
- Modify: `app/app.css`
- Modify: `app/app.js`
- Modify: `tests/desktop-catalogue-ui.test.cjs`
- Modify: `tests/desktop-native-bridge.test.cjs`

**Interfaces:**
- Consumes: the eight strict host operations and `GoogleCatalogueStatusView` states from Task 6.
- Produces: one `#googleCatalogue` status strip, `#googleMigrationDialog`, and collapsed `#googleSetup` settings group; no new top-level navigation.

- [ ] **Step 1: Load the Impeccable craft floor before editing UI**

Read: `C:\Users\osi_c\.codex\skills\impeccable\reference\craft-floor.md`

Preserve the incumbent dark Operate system, existing tokens, list density, navigation, catalogue functionality, and logo.

- [ ] **Step 2: Write failing Playwright UI-state tests**

Add host fixtures for `notConfigured`, `disconnected`, `connecting`, `needsInspection`, `migrationReady`, `ready`, `conflict`, and `error`. Assert concise labels/actions, polling only while connecting/syncing, Settings client-ID validation, No causing zero mutation, Yes sending exactly the displayed plan hash, stale-plan recovery, focus return, and no technical jargon in the default strip.

```javascript
test("migration review sends the frozen hash only after Yes", async () => {
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Yes, update the workbook" }).click();
  assert.deepEqual(hostCalls.at(-1), {
    operation: "applyGoogleWorkbookMigration",
    payload: { planHash: fixture.planHash },
  });
});
```

- [ ] **Step 3: Run UI tests red, implement semantic markup/state renderer, run green**

Run red/green: `npm run test:desktop-catalogue-ui`

Use one state-render function, existing button classes, `role=status`, a semantic `<dialog>`, a real `<label>` for client ID, and disabled/busy states. Poll at 1.5 seconds only during `connecting` or `syncing` and stop on navigation/unload.

- [ ] **Step 4: Add responsive, keyboard, reduced-motion, and console tests**

Exercise 1440x900, 800x700, and 390x844. Tab through Connect/Check/Review/Yes/No/Sync/Settings, assert no horizontal overflow, focus visibility, Escape closes review as No, sensitive fixture titles never enter status copy, and collect page errors/console errors.

- [ ] **Step 5: Run native bridge and UI suites**

Run:

```powershell
npm run test:desktop-catalogue-ui
npm run test:desktop-shell-ui
npm run test:desktop-native-bridge
```

Expected: PASS at all viewports with no console errors.

- [ ] **Step 6: Run the one mechanical Impeccable detector pass and fix mechanical findings**

Run:

```powershell
node C:\Users\osi_c\.codex\skills\impeccable\scripts\detect.mjs --json app/index.html app/app.css app/app.js
```

Apply one bounded fix batch for applicable findings, then rerun the three UI/native commands from Step 5. Do not run the detector a second time.

- [ ] **Step 7: Commit Task 7**

```powershell
git add app tests/desktop-catalogue-ui.test.cjs tests/desktop-native-bridge.test.cjs
git commit -m "feat: add Google catalogue sync controls"
```

---

### Task 8: Remove the personal bridge ID, bump 0.20.0, and harden package evidence

**Files:**
- Modify: `apps-script/catalogue-bridge.gs`
- Modify: `tests/upload-milestone.test.cjs`
- Modify: `tests/desktop-package.test.cjs`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `desktop/OFEnhancer.Desktop/OFEnhancer.Desktop.csproj`
- Modify: `desktop/OFEnhancer.Protocol/AgentProtocol.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/AgentProtocolTests.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/AgentPipeTests.cs`
- Modify: `desktop/OFEnhancer.Protocol.Tests/WebMessageRouterTests.cs`
- Modify: `README.md`
- Create: `docs/GOOGLE_CATALOGUE_SETUP.md`
- Create: `docs/GOOGLE_CATALOGUE_FAKE_SMOKE.md`

**Interfaces:**
- Produces: version `0.20.0` across extension, desktop, protocol status, packages, tests, and docs.
- Produces: legacy Apps Script `CREATOR_UPLOAD_SPREADSHEET_ID` lookup from Script Properties with an explicit missing-config failure; no literal personal ID.
- Consumes: the completed desktop sync implementation and existing package/staging scripts.

- [ ] **Step 1: Write failing privacy/package tests**

Assert source/staged/personal/store/desktop output contains neither the former personal workbook ID nor token/client-secret patterns, token/database/backup files, fake Google fixtures, or the configured client ID. Assert the legacy bridge fails clearly without its script property and works with a fake property.

- [ ] **Step 2: Run targeted tests red, remove hardcoded ID, run green**

Run: `node --test tests/upload-milestone.test.cjs tests/desktop-package.test.cjs`

Replace the literal ID with a bounded `CREATOR_UPLOAD_SPREADSHEET_ID` Script Property lookup. Update test contexts to inject only a fake workbook ID. Do not deploy the Apps Script.

Run the same command. Expected: PASS.

- [ ] **Step 3: Bump every shipped version to 0.20.0 and update assertions**

Update only explicit product-version fields and related documentation/artifact names. Do not bump protocol version 1 because the native contract remains compatible.

- [ ] **Step 4: Write setup and fake-smoke documentation**

`GOOGLE_CATALOGUE_SETUP.md` must list: create a Desktop OAuth client, enable Google Picker/Drive/Sheets APIs, paste only the client ID in Settings, Connect, select one spreadsheet, Check workbook, review, Yes, and the explicit statement that the first real migration requires a disposable-copy acceptance before the live workbook.

`GOOGLE_CATALOGUE_FAKE_SMOKE.md` must identify fixture commands and prove they use fake endpoints/temp data. It must not instruct a live mutation.

- [ ] **Step 5: Run format/lint/typecheck and targeted package tests**

Run:

```powershell
npm run lint
npm run typecheck
npm run format:check
npm run test:desktop-package
```

If Prettier reports only files changed by this milestone, run `npx prettier --write` on those exact files and rerun. Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```powershell
git add apps-script tests manifest.json package.json desktop README.md docs
git commit -m "chore: release Google catalogue sync 0.20.0"
```

---

### Task 9: Full verification, rendered audit, independent reviews, and local merge

**Files:**
- Modify only when a verification/reviewer finding requires a tested correction.
- Create captures under ignored `.impeccable/review/`.

**Interfaces:**
- Consumes: the entire milestone branch.
- Produces: verified local merge commit on `main`; no push, live Google action, extension installation, registry change, or media mutation.

- [ ] **Step 1: Run the complete deterministic test/build matrix sequentially where projects share outputs**

Run:

```powershell
npm run check
dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj
dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj
npm run stage:desktop
npm run build:desktop
```

Expected: all tests/builds pass. If Inno Setup is absent, `build:desktop` must truthfully stage the package and report the installer as unavailable; it is not a test failure unless the script claims an installer.

- [ ] **Step 2: Inspect the real rendered UI with Playwright CLI**

Read the `playwright-cli` skill, serve `app/` locally with the test host, and capture valid full-page `desktop.png` at 1440x900 and `mobile.png` at 390x844 after motion settles. Open both files once and verify they show the intended sync states, not blank/wrong pages.

- [ ] **Step 3: Run the Web Interface Guidelines audit and fix applicable findings**

Read the `web-design-guidelines` skill, inspect the changed HTML/CSS/JS and rendered evidence, apply one tested batch for accessibility/usability violations, and recapture the same viewports if UI changed.

- [ ] **Step 4: Request independent code review**

Read `superpowers:requesting-code-review`. Review the branch diff against the M2B spec with special attention to token redaction, mutation retries, monotonic outbox state, stale plan binding, row-move behavior, package leakage, and live-side-effect absence. Reproduce every accepted finding with a failing test before fixing it.

- [ ] **Step 5: Run the Impeccable finish review**

Spawn the shipped `impeccable_finish_reviewer` with no forked history and pass: original request, M2B spec, `app/index.html`, desktop/mobile captures, incumbent Operate direction, detector results, and craft-floor path. Apply at most the skill's bounded review/fix rounds and rerun affected tests.

- [ ] **Step 6: Run verification-before-completion from a clean branch**

Read `superpowers:verification-before-completion`. Confirm `git diff --check`, clean status except intentional ignored outputs, version 0.20.0, no forbidden IDs/secrets, and rerun every command whose evidence was invalidated by a later fix.

- [ ] **Step 7: Commit final reviewed corrections**

```powershell
git add -- app desktop tests apps-script docs README.md manifest.json package.json
git diff --cached --check
git commit -m "fix: close catalogue sync review findings"
```

Skip this commit only when there are no corrections.

- [ ] **Step 8: Merge locally into main and verify the merged tree**

From `F:\WORK\Creations\OFEnhancer`, require a clean `main`, then:

```powershell
git -c safe.directory=F:/WORK/Creations/OFEnhancer merge --no-ff codex/catalogue-sync-m2b -m "Merge Google catalogue sync milestone 2B"
npm test
dotnet test desktop/OFEnhancer.Catalogue.Tests/OFEnhancer.Catalogue.Tests.csproj
dotnet test desktop/OFEnhancer.Protocol.Tests/OFEnhancer.Protocol.Tests.csproj
```

Expected: merge succeeds and all merged-tree tests pass. Do not push.

- [ ] **Step 9: Remove only this completed worktree and branch after merged verification**

Verify the resolved worktree path is exactly `F:\WORK\Creations\OFEnhancer\.worktrees\catalogue-sync-m2b`, then remove it with `git worktree remove` and delete only `codex/catalogue-sync-m2b`. Do not touch `.worktrees/social-trace-recorder`.
