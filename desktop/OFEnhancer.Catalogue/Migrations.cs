namespace OFEnhancer.Catalogue;

internal sealed record MigrationStep(int Version, string Sql);

internal static class Migrations
{
    internal static readonly MigrationStep VersionOne = new(
        1,
        """
        CREATE TABLE catalogue_items (
            item_id TEXT PRIMARY KEY NOT NULL,
            source_key TEXT NOT NULL UNIQUE,
            source_row INTEGER,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            planned_date TEXT,
            series TEXT,
            episode TEXT,
            x_teasers INTEGER NOT NULL DEFAULT 0 CHECK (x_teasers >= 0),
            reddit_teasers INTEGER NOT NULL DEFAULT 0 CHECK (reddit_teasers >= 0),
            platform_links_json TEXT NOT NULL DEFAULT '{}',
            archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
            updated_utc TEXT NOT NULL
        );

        CREATE TABLE media_assets (
            asset_id TEXT PRIMARY KEY NOT NULL,
            sha256 TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            file_name TEXT NOT NULL,
            absolute_path TEXT NOT NULL,
            scan_root TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            last_write_utc TEXT NOT NULL,
            available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
            updated_utc TEXT NOT NULL
        );

        CREATE TABLE asset_bindings (
            asset_id TEXT PRIMARY KEY NOT NULL REFERENCES media_assets(asset_id) ON DELETE RESTRICT,
            item_id TEXT NOT NULL REFERENCES catalogue_items(item_id) ON DELETE RESTRICT,
            confirmed_utc TEXT NOT NULL,
            evidence TEXT NOT NULL
        );
        CREATE INDEX asset_bindings_item_id ON asset_bindings(item_id);

        CREATE TABLE audit_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_utc TEXT NOT NULL,
            kind TEXT NOT NULL,
            item_id TEXT REFERENCES catalogue_items(item_id) ON DELETE SET NULL,
            asset_id TEXT REFERENCES media_assets(asset_id) ON DELETE SET NULL,
            details_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
        """
    );

    internal static IReadOnlyList<MigrationStep> All { get; } = [VersionOne];
}
