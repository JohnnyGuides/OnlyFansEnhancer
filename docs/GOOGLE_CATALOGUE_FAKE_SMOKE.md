# Google catalogue fake smoke test

Run these commands from the repository root. They use fake HTTP handlers,
captured browser callbacks, in-memory credentials, temporary databases, and
temporary package data. They do not connect to a Google account or mutate a
spreadsheet.

## Protocol, workbook, and sync fixtures

```powershell
dotnet test desktop\OFEnhancer.Protocol.Tests\OFEnhancer.Protocol.Tests.csproj --filter "GoogleOAuthProtocolTests|GoogleTokenVaultTests|GoogleConnectionCoordinatorTests|GoogleWorkspaceClientTests|GoogleWorkbookProfileTests|GoogleWorkbookMigratorTests|GoogleCatalogueSyncWorkerTests|DesktopSettingsStoreTests|GoogleCatalogueControllerTests|WebMessageRouterTests|WebMessageDispatcherTests"
dotnet test desktop\OFEnhancer.Catalogue.Tests\OFEnhancer.Catalogue.Tests.csproj
```

The protocol tests inject `HttpMessageHandler` implementations instead of
opening network connections. They use a fake callback receiver and an injected
browser opener instead of starting a browser. Workbook parsing reads
`desktop/OFEnhancer.Protocol.Tests/Fixtures/google-workbook-legacy.json` and
`google-workbook-ambiguous.json`. Catalogue and settings tests create their
SQLite, token, and settings files under temporary test folders and remove them
after each run.

## UI and package fixtures

```powershell
npm run test:desktop-catalogue-ui
node --test tests/upload-milestone.test.cjs tests/desktop-package.test.cjs
```

The UI suite supplies every Google state through its local test host. The
package suite creates a temporary local app-data tree with fake client, token,
database, backup, and workbook-fixture values. It then checks the source,
personal ZIP, store ZIP, staged tree, and desktop output for leaks. The staged
desktop starts with temporary data and WebView folders and never starts a
Google connection.

These fixture commands are the Milestone 2B smoke path. Do not replace them
with a live workbook mutation.
