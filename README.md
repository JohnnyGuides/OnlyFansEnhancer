# OFEnhancer

A local-first creator workspace for Windows and the user's signed-in Chrome
session. The personal **Creator Workflow Toolkit** extension provides publishing
workflows and identity masking. The separate **Fan Identity Mask** store edition
is consent-gated and display-only; it contains no publishing or native integration.

## Start here

Use Node.js 22.13+ (22.x) or 24+. Install the pinned development dependencies with
`npm ci`, then install the test browser with `npx playwright install chromium`.

```sh
npm run build:personal
npm run build:store
```

The builds create loadable folders at `dist/extensions/personal` and
`dist/extensions/store`, plus versioned ZIPs in `dist/`. In Chrome's extension
manager, enable Developer mode and load the appropriate **generated** folder.
Neither the repository root nor `extensions/personal` is a loadable package.
Keep the two editions in separate test profiles.

**Existing installations:** unpacked extension identity depends on its load
location. Preserve the current profile and load location; replace its generated
runtime files deliberately rather than loading a new path and assuming settings
or native registrations will migrate. See [development and release](docs/development.md).

Windows desktop development additionally needs the .NET 8 SDK, WebView2 Runtime,
and Windows PowerShell. The full installer build uses Inno Setup 6.

```sh
dotnet test desktop/OFEnhancer.sln
npm run stage:desktop
```

Staging does not install the app, register a native host, sign in, publish, or
modify a real catalogue. Read the installation procedure before using a package.

## Repository

```text
extensions/    Personal and store-specific Chrome runtime source
shared/        Shared identity masking and desktop/extension workspace UI
desktop/       Windows app, catalogue, protocol, and their .NET tests
native-host/   Desktop relay and separate X audit/file-reconciliation host
integrations/  Creator-owned Google Apps Script catalogue bridge
packaging/     Extension composition recipe, Windows installer, store listing
tools/         Build, release, and current-user registration tools
tests/         Extension, desktop UI, native, packaging, and synthetic fixtures
docs/          Product, architecture, operations, acceptance, and privacy
```

Builds compose shared source through [packaging/extensions.json](packaging/extensions.json).
There is no hand-maintained distributable mirror. `dist/`, dependencies, browser
profiles, local credentials, test captures, and .NET output are disposable and
are not source.

## Verification

```sh
npm run check:web      # Static checks, both extension builds, Node/browser tests
npm run check:windows  # .NET, native host, registration, packaging tests
npm run check         # Both; requires the complete Windows toolchain
```

Tests use synthetic pages, fake services, and temporary files. They do not
establish live-site compatibility or authorize public actions. Private saved-page
checks are opt-in. Detailed commands and prerequisites are in
[development and release](docs/development.md); real-account acceptance is in
[acceptance](docs/acceptance.md).

## Knowledge boundaries

| Document                                       | Owns                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Product](docs/product.md)                     | Required behavior, supported surfaces, and explicitly deferred capabilities        |
| [Architecture](docs/architecture.md)           | Runtime ownership, state/identity boundaries, and non-obvious rationale            |
| [Development and release](docs/development.md) | Builds, tests, installation, update/uninstall, and release gates                   |
| [Google catalogue](docs/google-catalogue.md)   | OAuth setup, import, reviewed migration, sync recovery, and Apps Script deployment |
| [Acceptance](docs/acceptance.md)               | Authorized manual checks and trace evidence required for platform changes          |
| [Personal privacy](docs/privacy-personal.md)   | Personal extension/desktop data handling and retention                             |
| [Store privacy](docs/privacy.html)             | Public and packaged store-edition policy                                           |
| [Store listing](packaging/store/listing.md)    | Listing copy, reviewer instructions, and submission-specific declarations          |

Source and tests establish implementation, not permission to change the product
contract. A fixture-passing adapter is not proof that a live website still has the
same controls.
