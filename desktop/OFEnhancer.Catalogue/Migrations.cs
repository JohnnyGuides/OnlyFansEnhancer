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

    internal static readonly MigrationStep VersionTwo = new(
        2,
        """
        CREATE TABLE google_row_bindings (
            workbook_id TEXT NOT NULL,
            sheet_id TEXT NOT NULL,
            item_id TEXT NOT NULL REFERENCES catalogue_items(item_id) ON DELETE RESTRICT,
            metadata_id TEXT NOT NULL,
            last_observed_row INTEGER NOT NULL CHECK (last_observed_row > 0),
            verified_remote_fingerprint TEXT NOT NULL,
            verified_utc TEXT NOT NULL,
            PRIMARY KEY (workbook_id, sheet_id, item_id),
            UNIQUE (workbook_id, metadata_id)
        );

        CREATE TABLE sync_outbox (
            operation_id TEXT PRIMARY KEY NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            item_id TEXT NOT NULL REFERENCES catalogue_items(item_id) ON DELETE RESTRICT,
            workbook_id TEXT NOT NULL,
            sheet_id TEXT NOT NULL,
            metadata_key TEXT NOT NULL,
            metadata_value TEXT NOT NULL,
            destination_field TEXT NOT NULL,
            payload_value TEXT NOT NULL,
            expected_remote_fingerprint TEXT NOT NULL,
            intended_value_fingerprint TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'attempted', 'completed', 'conflict', 'unresolved')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
            error_code TEXT,
            created_utc TEXT NOT NULL,
            attempted_utc TEXT,
            completed_utc TEXT,
            resolved_utc TEXT
        );
        CREATE INDEX sync_outbox_open_order ON sync_outbox(state, created_utc, operation_id);
        """
    );

    internal static readonly MigrationStep VersionThree = new(
        3,
        "ALTER TABLE catalogue_items ADD COLUMN source_link_cells_json TEXT NOT NULL DEFAULT '{}';"
    );

    internal static readonly MigrationStep VersionFour = new(
        4,
        """
        CREATE TABLE production_handoffs (
            handoff_id TEXT PRIMARY KEY NOT NULL,
            episode_id TEXT NOT NULL,
            edit_id TEXT NOT NULL,
            episode_code TEXT NOT NULL,
            edit_number INTEGER NOT NULL CHECK (edit_number > 0),
            files_json TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('awaiting_review', 'bound', 'rejected', 'changed_source')),
            catalogue_item_id TEXT REFERENCES catalogue_items(item_id) ON DELETE RESTRICT,
            created_utc TEXT NOT NULL,
            reviewed_utc TEXT
        );
        CREATE INDEX production_handoffs_state ON production_handoffs(state, created_utc);
        """
    );

    // Nullable so existing rows load unchanged; values fill on the next Google import or write.
    internal static readonly MigrationStep VersionFive = new(
        5,
        "ALTER TABLE catalogue_items ADD COLUMN category TEXT;"
    );

    // Passive X collection: the owner's own posts and point-in-time metric samples.
    internal static readonly MigrationStep VersionSix = new(
        6,
        """
        CREATE TABLE x_owner (
            singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
            account_id TEXT,
            handle TEXT NOT NULL,
            first_seen_utc TEXT NOT NULL,
            updated_utc TEXT NOT NULL
        );

        CREATE TABLE x_posts (
            status_id TEXT PRIMARY KEY NOT NULL,
            author_id TEXT,
            posted_utc TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            in_reply_to TEXT,
            conversation_id TEXT,
            is_retweet INTEGER NOT NULL DEFAULT 0 CHECK (is_retweet IN (0, 1)),
            media_json TEXT NOT NULL DEFAULT '[]',
            urls_json TEXT NOT NULL DEFAULT '[]',
            first_seen_utc TEXT NOT NULL,
            last_seen_utc TEXT NOT NULL
        );
        CREATE INDEX x_posts_posted_utc ON x_posts(posted_utc);

        CREATE TABLE x_metric_samples (
            sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
            status_id TEXT NOT NULL REFERENCES x_posts(status_id) ON DELETE CASCADE,
            observed_utc TEXT NOT NULL,
            age_hours REAL NOT NULL,
            views INTEGER CHECK (views IS NULL OR views >= 0),
            likes INTEGER CHECK (likes IS NULL OR likes >= 0),
            reposts INTEGER CHECK (reposts IS NULL OR reposts >= 0),
            replies INTEGER CHECK (replies IS NULL OR replies >= 0),
            quotes INTEGER CHECK (quotes IS NULL OR quotes >= 0),
            bookmarks INTEGER CHECK (bookmarks IS NULL OR bookmarks >= 0),
            source TEXT NOT NULL CHECK (source IN ('network', 'dom')),
            UNIQUE (status_id, observed_utc)
        );
        """
    );

    // X teaser management: post-to-episode bindings, first self-replies, the
    // local teaser clip index, 7-day verdicts and the clip move log.
    internal static readonly MigrationStep VersionSeven = new(
        7,
        """
        CREATE TABLE x_post_bindings (
            status_id TEXT PRIMARY KEY NOT NULL REFERENCES x_posts(status_id) ON DELETE CASCADE,
            item_id TEXT NOT NULL REFERENCES catalogue_items(item_id) ON DELETE RESTRICT,
            source_key TEXT NOT NULL,
            evidence TEXT NOT NULL CHECK (evidence IN ('sheet-link', 'reply-link', 'owner')),
            confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium')),
            bound_utc TEXT NOT NULL
        );
        CREATE INDEX x_post_bindings_item_id ON x_post_bindings(item_id);

        CREATE TABLE x_binding_conflicts (
            status_id TEXT PRIMARY KEY NOT NULL REFERENCES x_posts(status_id) ON DELETE CASCADE,
            candidates_json TEXT NOT NULL,
            detected_utc TEXT NOT NULL
        );

        CREATE TABLE x_first_replies (
            status_id TEXT PRIMARY KEY NOT NULL REFERENCES x_posts(status_id) ON DELETE CASCADE,
            reply_status_id TEXT NOT NULL REFERENCES x_posts(status_id) ON DELETE CASCADE,
            reply_link TEXT NOT NULL,
            link_kind TEXT NOT NULL CHECK (link_kind IN ('onlyfans', 'fansly')),
            link_post_id TEXT NOT NULL,
            replied_utc TEXT NOT NULL
        );

        CREATE TABLE x_local_clips (
            clip_id INTEGER PRIMARY KEY AUTOINCREMENT,
            rel_path TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            mtime_utc TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            episode_key TEXT,
            state TEXT NOT NULL CHECK (state IN ('ready', 'posted', 'good', 'failed')),
            status_id TEXT,
            pairing_evidence TEXT CHECK (pairing_evidence IS NULL OR pairing_evidence IN ('owner', 'revert-list', 'time-window')),
            first_seen_utc TEXT NOT NULL,
            last_seen_utc TEXT NOT NULL,
            missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
            CHECK ((status_id IS NULL) = (pairing_evidence IS NULL))
        );
        CREATE INDEX x_local_clips_sha256 ON x_local_clips(sha256);
        CREATE UNIQUE INDEX x_local_clips_present_path ON x_local_clips(rel_path COLLATE NOCASE) WHERE missing = 0;
        CREATE UNIQUE INDEX x_local_clips_status ON x_local_clips(status_id) WHERE status_id IS NOT NULL;

        CREATE TABLE x_teaser_verdicts (
            status_id TEXT PRIMARY KEY NOT NULL REFERENCES x_posts(status_id) ON DELETE CASCADE,
            verdict TEXT NOT NULL CHECK (verdict IN ('good', 'failed')),
            engagement_rate REAL NOT NULL,
            cohort_median REAL NOT NULL,
            cohort_size INTEGER NOT NULL CHECK (cohort_size >= 10),
            sample_age_hours REAL NOT NULL,
            decided_utc TEXT NOT NULL
        );

        CREATE TABLE x_clip_moves (
            move_id INTEGER PRIMARY KEY AUTOINCREMENT,
            clip_id INTEGER NOT NULL REFERENCES x_local_clips(clip_id) ON DELETE CASCADE,
            from_rel_path TEXT NOT NULL,
            to_rel_path TEXT NOT NULL,
            reason TEXT NOT NULL CHECK (reason IN ('verdict-good', 'verdict-failed', 'undo')),
            outcome TEXT NOT NULL CHECK (outcome IN ('moved', 'collision', 'fingerprint-mismatch', 'locked', 'error', 'unsafe-path')),
            occurred_utc TEXT NOT NULL,
            undone_utc TEXT
        );
        CREATE INDEX x_clip_moves_clip ON x_clip_moves(clip_id, move_id);
        """
    );

    // Owner-local teaser plan: at most one planned episode per calendar day.
    internal static readonly MigrationStep VersionEight = new(
        8,
        """
        CREATE TABLE x_planned_slots (
            slot_date TEXT PRIMARY KEY NOT NULL CHECK (length(slot_date) = 10),
            episode_key TEXT NOT NULL,
            clip_id INTEGER REFERENCES x_local_clips(clip_id) ON DELETE SET NULL,
            created_utc TEXT NOT NULL
        );
        """
    );

    // The owner's X scheduled posts as last listed by X (gone = no longer
    // listed), and the background scan's request flag and last outcome.
    internal static readonly MigrationStep VersionNine = new(
        9,
        """
        CREATE TABLE x_scheduled_posts (
            scheduled_id TEXT PRIMARY KEY NOT NULL,
            scheduled_utc TEXT NOT NULL,
            text_excerpt TEXT NOT NULL,
            media_summary TEXT NOT NULL,
            first_seen_utc TEXT NOT NULL,
            observed_utc TEXT NOT NULL,
            gone INTEGER NOT NULL DEFAULT 0 CHECK (gone IN (0, 1))
        );
        CREATE INDEX x_scheduled_posts_time ON x_scheduled_posts(gone, scheduled_utc);
        CREATE TABLE x_scan_state (
            singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
            requested_utc TEXT,
            last_trigger TEXT,
            last_mode TEXT,
            last_started_utc TEXT,
            last_finished_utc TEXT,
            last_outcome TEXT,
            last_detail TEXT,
            last_pages INTEGER,
            last_rows INTEGER,
            last_scheduled INTEGER
        );
        """
    );

    internal static IReadOnlyList<MigrationStep> All { get; } = [VersionOne, VersionTwo, VersionThree, VersionFour, VersionFive, VersionSix, VersionSeven,
        VersionEight, VersionNine];
}
