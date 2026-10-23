using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue;

public sealed record CreatorWorkflowTarget(string Platform, string Status, string? PostUrl = null,
    string? Error = null, bool Submitted = false, string? GoogleError = null,
    IReadOnlyList<string>? PostUrls = null);
public sealed record CreatorWorkflowAsset(string Role, string Name, long Size, DateTimeOffset LastModified,
    string? Sha256 = null);
public sealed record CreatorWorkflowScript(string Status, string? Filename = null, string? Sha256 = null,
    IReadOnlyList<string>? Links = null, IReadOnlyList<string>? SentKeys = null, string? Error = null,
    string? WritebackState = null);
public sealed record CreatorWorkflowReply(string PaidUrl, bool AutoReply, int ReplyDelayMinutes,
    string? WordingTemplate = null, string? MainStatusUrl = null, string? ReplyStatusUrl = null,
    DateTimeOffset? DueAt = null, bool Attempted = false);
public sealed record CreatorWorkflowClip(string? ClipId = null, string? Sha256 = null, string? EpisodeKey = null);
public sealed record CreatorWorkflowSnapshot(string RunId, string Kind, long Revision, string? SourceKey,
    IReadOnlyList<CreatorWorkflowTarget> Targets, IReadOnlyList<CreatorWorkflowAsset> Assets,
    CreatorWorkflowScript? Script = null, CreatorWorkflowReply? Reply = null, CreatorWorkflowClip? Clip = null,
    UploadCatalogueDestination? Destination = null);
public sealed record CreatorWorkflowRecordResult(string Status, CreatorWorkflowSnapshot Snapshot, string? Code = null);
public sealed record CreatorWorkflowPage(IReadOnlyList<CreatorWorkflowSnapshot> Items, int TotalCount, int Offset, int Limit);
public sealed record CreatorWorkflowUploadResult(string Platform, string Url, UploadResult Result);
public sealed record CreatorWorkflowAssociationResult(string Status, CreatorWorkflowSnapshot Snapshot,
    IReadOnlyList<CreatorWorkflowUploadResult> Results, string? Code = null);
public sealed record CreatorWorkflowSummary(string SourceKey, string ItemId, int RecentWorkflowCount,
    string? ScriptStatus, int KnownScriptLinkCount, IReadOnlyList<string> KnownScriptLinks,
    IReadOnlyList<CreatorWorkflowSnapshot> RecentWorkflows);
public sealed record CreatorWorkflowProjectionIntent(string Key, string WorkbookId, string RunId,
    long Revision, CreatorWorkflowSnapshot Snapshot, string? SourceTitle = null, string State = "pending", string? ErrorCode = null,
    int? LedgerSheetId = null, string? SourceItemId = null);
public sealed record CreatorWorkflowProjectionCounts(int Pending, int Attempted, int Unresolved, int Conflicts);

public sealed class CreatorWorkflowException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public sealed partial class CatalogueStore
{
    private const int MaxCreatorWorkflowJsonBytes = 262_144;
    private static readonly HashSet<string> WorkflowKinds = new(StringComparer.Ordinal) { "upload", "social" };
    private static readonly HashSet<string> WorkflowPlatforms = new(StringComparer.Ordinal)
    {
        "pornhub", "onlyfans", "fansly", "manyvids", "x", "reddit", "redgifs", "clips4sale", "script",
    };
    private static readonly HashSet<string> TargetStatuses = new(StringComparer.Ordinal)
    {
        "selected", "pending", "submitted", "uploaded", "partial", "failed", "skipped", "cancelled",
    };
    private static readonly HashSet<string> ScriptStatuses = new(StringComparer.Ordinal)
    {
        "selected", "pending", "uploaded", "partial", "failed", "skipped",
    };
    private static readonly HashSet<string> AssetRoles = new(StringComparer.Ordinal)
    {
        "video", "poster", "thumbnail", "script", "subtitle", "audio", "archive", "other",
    };

    public CreatorWorkflowRecordResult RecordCreatorWorkflow(CreatorWorkflowSnapshot snapshot)
        => RecordCreatorWorkflowCore(snapshot, explicitOwnerBinding: false);

    private CreatorWorkflowRecordResult RecordCreatorWorkflowCore(CreatorWorkflowSnapshot snapshot,
        bool explicitOwnerBinding)
    {
        CreatorWorkflowSnapshot normalized = ValidateCreatorWorkflow(snapshot);
        byte[] snapshotBytes = JsonSerializer.SerializeToUtf8Bytes(normalized);
        if (snapshotBytes.Length > MaxCreatorWorkflowJsonBytes)
            throw new CreatorWorkflowException("creator-workflow-too-large");
        string snapshotJson = System.Text.Encoding.UTF8.GetString(snapshotBytes);
        string now = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        using SqliteTransaction transaction = connection.BeginTransaction();
        string? itemId = normalized.SourceKey is null ? null : ResolveCreatorWorkflowItemId(normalized.SourceKey, transaction);
        using SqliteCommand read = connection.CreateCommand();
        read.Transaction = transaction;
        read.CommandText = "SELECT item_id, source_key, kind, revision, snapshot_json FROM creator_workflows WHERE run_id=$run";
        read.Parameters.AddWithValue("$run", normalized.RunId);
        using SqliteDataReader reader = read.ExecuteReader();
        if (reader.Read())
        {
            string? existingItemId = reader.IsDBNull(0) ? null : reader.GetString(0);
            string? existingSourceKey = reader.IsDBNull(1) ? null : reader.GetString(1);
            string existingKind = reader.GetString(2);
            long existingRevision = reader.GetInt64(3);
            CreatorWorkflowSnapshot current = JsonSerializer.Deserialize<CreatorWorkflowSnapshot>(reader.GetString(4))!;
            reader.Close();
            string? affinityWorkbook = GetCreatorWorkflowProjectionWorkbook(normalized.RunId, transaction);
            UploadCatalogueDestination? frozenDestination = affinityWorkbook is null ? null
                : GetCreatorWorkflowProjectionDestination(normalized.RunId, transaction);
            if (frozenDestination is not null)
            {
                if (normalized.Destination is not null && normalized.Destination != frozenDestination)
                    return new("conflict", current, "creator-workflow-destination-conflict");
                normalized = normalized with { Destination = frozenDestination };
            }
            else if (!explicitOwnerBinding)
            {
                // A changed session cannot attach a legacy run to the currently selected workbook.
                normalized = normalized with { Destination = current.Destination };
            }
            else if (current.Destination is not null && normalized.Destination is not null
                && current.Destination != normalized.Destination)
                return new("conflict", current, "creator-workflow-destination-conflict");
            byte[] normalizedBytes = JsonSerializer.SerializeToUtf8Bytes(normalized);
            if (normalizedBytes.Length > MaxCreatorWorkflowJsonBytes)
                throw new CreatorWorkflowException("creator-workflow-too-large");
            snapshotJson = System.Text.Encoding.UTF8.GetString(normalizedBytes);
            bool bindPreviouslyUnbound = existingSourceKey is null && existingItemId is null
                && normalized.SourceKey is not null && itemId is not null
                && normalized.Revision > existingRevision && existingKind == normalized.Kind;
            if ((!bindPreviouslyUnbound && (existingSourceKey != normalized.SourceKey || existingItemId != itemId))
                || existingKind != normalized.Kind)
                return new("conflict", current, "creator-workflow-identity-conflict");
            if (normalized.Revision < existingRevision) return new("stale", current);
            if (normalized.Revision == existingRevision)
                return new(snapshotJson == JsonSerializer.Serialize(current) ? "idempotent" : "conflict", current,
                    snapshotJson == JsonSerializer.Serialize(current) ? null : "creator-workflow-revision-conflict");

            using SqliteCommand update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = "UPDATE creator_workflows SET item_id=CASE WHEN $bind=1 THEN $item ELSE item_id END,source_key=CASE WHEN $bind=1 THEN $source ELSE source_key END,revision=$revision,snapshot_json=$snapshot,updated_utc=$updated WHERE run_id=$run";
            update.Parameters.AddWithValue("$bind", bindPreviouslyUnbound ? 1 : 0);
            update.Parameters.AddWithValue("$item", (object?)itemId ?? DBNull.Value);
            update.Parameters.AddWithValue("$source", (object?)normalized.SourceKey ?? DBNull.Value);
            update.Parameters.AddWithValue("$revision", normalized.Revision);
            update.Parameters.AddWithValue("$snapshot", snapshotJson);
            update.Parameters.AddWithValue("$updated", now);
            update.Parameters.AddWithValue("$run", normalized.RunId);
            update.ExecuteNonQuery();
            if (affinityWorkbook is not null)
                QueueCreatorWorkflowProjection(affinityWorkbook, normalized, transaction);
            else if (explicitOwnerBinding && normalized.Destination is not null)
                QueueCreatorWorkflowProjection(normalized.Destination.WorkbookId, normalized, transaction);
            transaction.Commit();
            return new("recorded", normalized);
        }
        reader.Close();

        using SqliteCommand insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = "INSERT INTO creator_workflows(run_id,item_id,source_key,kind,revision,snapshot_json,created_utc,updated_utc) VALUES ($run,$item,$source,$kind,$revision,$snapshot,$created,$updated)";
        insert.Parameters.AddWithValue("$run", normalized.RunId);
        insert.Parameters.AddWithValue("$item", (object?)itemId ?? DBNull.Value);
        insert.Parameters.AddWithValue("$source", (object?)normalized.SourceKey ?? DBNull.Value);
        insert.Parameters.AddWithValue("$kind", normalized.Kind);
        insert.Parameters.AddWithValue("$revision", normalized.Revision);
        insert.Parameters.AddWithValue("$snapshot", snapshotJson);
        insert.Parameters.AddWithValue("$created", now);
        insert.Parameters.AddWithValue("$updated", now);
        insert.ExecuteNonQuery();
        if (normalized.Destination is not null)
            QueueCreatorWorkflowProjection(normalized.Destination.WorkbookId, normalized, transaction);
        transaction.Commit();
        return new("recorded", normalized);
    }

    public IReadOnlyList<CreatorWorkflowSnapshot> GetCreatorWorkflows(string? sourceKey = null,
        bool unboundOnly = false, int offset = 0, int limit = 50)
    {
        ValidateWorkflowPage(offset, limit);
        if (sourceKey is not null)
        {
            ValidateText(sourceKey, 200, "creator-workflow-source-invalid");
            if (!GetItems(includeArchived: true).Any(item => item.SourceKey == sourceKey))
                throw new CreatorWorkflowException("creator-workflow-source-not-found");
        }
        using SqliteCommand command = connection.CreateCommand();
        string filter = unboundOnly
            ? "(source_key IS NULL OR json_extract(snapshot_json, '$.Destination') IS NULL)"
            : "1=1";
        command.CommandText = sourceKey is null
            ? $"SELECT snapshot_json FROM creator_workflows WHERE {filter} ORDER BY updated_utc DESC, run_id LIMIT $limit OFFSET $offset"
            : $"SELECT snapshot_json FROM creator_workflows WHERE {filter} AND source_key=$source ORDER BY updated_utc DESC, run_id LIMIT $limit OFFSET $offset";
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        if (sourceKey is not null) command.Parameters.AddWithValue("$source", sourceKey);
        using SqliteDataReader reader = command.ExecuteReader();
        List<CreatorWorkflowSnapshot> result = [];
        while (reader.Read())
            result.Add(JsonSerializer.Deserialize<CreatorWorkflowSnapshot>(reader.GetString(0))!);
        return result;
    }

    public CreatorWorkflowPage GetUnassignedCreatorWorkflows(int offset = 0, int limit = 25)
    {
        ValidateWorkflowPage(offset, limit);
        using SqliteCommand count = connection.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM creator_workflows WHERE source_key IS NULL OR json_extract(snapshot_json, '$.Destination') IS NULL";
        int total = Convert.ToInt32(count.ExecuteScalar(), CultureInfo.InvariantCulture);
        return new(GetCreatorWorkflows(unboundOnly: true, offset: offset, limit: limit), total, offset, limit);
    }

    public CreatorWorkflowAssociationResult AssociateCreatorWorkflow(string runId, string sourceKey,
        string expectedFingerprint)
    {
        ValidateText(runId, 128, "creator-workflow-run-invalid");
        ValidateText(sourceKey, 200, "creator-workflow-source-invalid");
        if (expectedFingerprint is not { Length: 64 } || !expectedFingerprint.All(Uri.IsHexDigit))
            throw new CreatorWorkflowException("creator-workflow-fingerprint-invalid");
        CreatorWorkflowSnapshot snapshot = ReadCreatorWorkflow(runId)
            ?? throw new CreatorWorkflowException("creator-workflow-not-found");
        bool needsBinding = snapshot.SourceKey is null;
        if (snapshot.SourceKey is not null)
        {
            if (snapshot.SourceKey != sourceKey)
                return new("conflict", snapshot, [], "creator-workflow-identity-conflict");
        }

        CatalogueItemSummary item = GetItems(includeArchived: true).SingleOrDefault(value => value.SourceKey == sourceKey)
            ?? throw new CreatorWorkflowException("creator-workflow-source-not-found");
        UploadCatalogueRow row = ToUploadRow(item) with { Destination = GetTrustedUploadCatalogueDestination() };
        if (!string.Equals(row.Fingerprint, expectedFingerprint, StringComparison.OrdinalIgnoreCase))
            return new("stale", snapshot, [], "catalogue-entry-changed");
        if (snapshot.Destination is not null && row.Destination is not null
            && snapshot.Destination != row.Destination)
            return new("conflict", snapshot, [], "creator-workflow-destination-conflict");

        UploadCatalogueDestination? confirmedDestination = snapshot.Destination ?? row.Destination;
        bool needsDestinationBinding = snapshot.Destination is null && confirmedDestination is not null;
        CreatorWorkflowSnapshot boundSnapshot = snapshot;
        if (needsBinding || needsDestinationBinding)
        {
            CreatorWorkflowRecordResult binding = RecordCreatorWorkflowCore(snapshot with
            {
                SourceKey = sourceKey,
                Destination = confirmedDestination,
                Revision = checked(snapshot.Revision + 1),
            }, explicitOwnerBinding: true);
            if (binding.Status != "recorded")
                return new(binding.Status, binding.Snapshot, [], binding.Code);
            boundSnapshot = binding.Snapshot;
        }

        List<(string Platform, string Url)> publications = [];
        foreach (CreatorWorkflowTarget target in boundSnapshot.Targets
            .Where(value => value.Status is "uploaded" or "partial"))
        {
            foreach (string url in (target.PostUrls ?? []).Prepend(target.PostUrl).OfType<string>())
                publications.Add((target.Platform, url));
        }
        if (boundSnapshot.Script is { Status: "uploaded" or "partial" } script)
            foreach (string url in script.Links ?? []) publications.Add(("script", url));

        List<CreatorWorkflowUploadResult> results = [];
        HashSet<string> seen = new(StringComparer.Ordinal);
        foreach ((string platform, string rawUrl) in publications)
        {
            if (!TryCanonicalLink(platform, rawUrl, out string canonical))
            {
                results.Add(new(platform, rawUrl, new UploadResult("conflict", row.Fingerprint,
                    PostUrl: rawUrl)));
                continue;
            }
            if (!seen.Add($"{platform}\n{canonical}")) continue;
            CatalogueItemSummary currentItem = GetItems(includeArchived: true).Single(value => value.SourceKey == sourceKey);
            UploadCatalogueRow currentRow = ToUploadRow(currentItem);
            UploadResult result = RecordUploadResult(new UploadResultRequest(currentRow.Row,
                currentRow.Fingerprint, platform, canonical, Id: sourceKey, ItemId: currentRow.ItemId,
                Action: platform == "x" ? "appendTwitterTeaser" : platform == "reddit" ? "appendRedditPost" : null,
                Destination: boundSnapshot.Destination));
            results.Add(new(platform, canonical, result));
        }

        CreatorWorkflowUploadResult[] failed = [.. results.Where(value => value.Result.Status is "conflict" or "stale")];
        string status = failed.Length > 0 ? results.Count == failed.Length ? "conflict" : "partial"
            : results.Count > 0 && results.All(value => value.Result.Status == "idempotent") ? "idempotent" : "recorded";
        return new(status, boundSnapshot, results);
    }

    private static void ValidateWorkflowPage(int offset, int limit)
    {
        if (offset is < 0 or > 1_000_000 || limit is < 1 or > 50)
            throw new CreatorWorkflowException("creator-workflow-page-invalid");
    }

    private CreatorWorkflowSnapshot? ReadCreatorWorkflow(string runId)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT snapshot_json FROM creator_workflows WHERE run_id=$run";
        command.Parameters.AddWithValue("$run", runId);
        string? json = command.ExecuteScalar() as string;
        return json is null ? null : JsonSerializer.Deserialize<CreatorWorkflowSnapshot>(json);
    }

    public CreatorWorkflowSummary GetCreatorWorkflowSummary(string sourceKey)
    {
        ValidateText(sourceKey, 200, "creator-workflow-source-invalid");
        CatalogueItemSummary item = GetItems(includeArchived: true).SingleOrDefault(value => value.SourceKey == sourceKey)
            ?? throw new CreatorWorkflowException("creator-workflow-source-not-found");
        IReadOnlyList<CreatorWorkflowSnapshot> recent = GetCreatorWorkflows(sourceKey);
        CreatorWorkflowSnapshot? latestScriptWorkflow = recent.FirstOrDefault(value => value.Script is not null);
        CreatorWorkflowScript? script = latestScriptWorkflow?.Script;
        HashSet<string> knownLinks = new(StringComparer.Ordinal);
        AddKnownScriptLink(item.PlatformLinks.GetValueOrDefault("script"));
        if (item.SourceLinkCells?.TryGetValue("script", out CatalogueSourceLinkCell? cell) == true)
            foreach (string value in cell.Urls) AddKnownScriptLink(value);
        foreach (string value in GetRecordedScriptUrls(item.ItemId)) AddKnownScriptLink(value);

        if (script is { Status: "uploaded" or "partial" })
            foreach (string value in script.Links ?? []) AddKnownScriptLink(value);
        foreach (CreatorWorkflowTarget target in recent.SelectMany(value => value.Targets)
            .Where(value => value.Platform == "script" && value.Status is "uploaded" or "partial"))
            AddKnownScriptLink(target.PostUrl);

        bool partial = knownLinks.Count > 0 && (script?.Status is "partial" or "failed"
            || latestScriptWorkflow?.Targets.Any(value => value.Platform == "script" && value.Status == "failed") == true
            || script is { Links.Count: > 0, SentKeys.Count: > 0 } && script.SentKeys.Count < script.Links.Count);
        string? scriptStatus = knownLinks.Count > 0 ? partial ? "partial" : "uploaded"
            : script?.Status == "failed" ? "failed"
            : script is not null ? "selected" : null;
        return new(sourceKey, item.ItemId, recent.Count, scriptStatus, knownLinks.Count,
            [.. knownLinks.Order(StringComparer.Ordinal)], recent);

        void AddKnownScriptLink(string? value)
        {
            if (value is not null && TryCanonicalLink("script", value, out string canonical)) knownLinks.Add(canonical);
        }
    }

    public IReadOnlyDictionary<string, string> GetCreatorScriptStatuses()
    {
        IReadOnlyList<CatalogueItemSummary> items = GetItems(includeArchived: true);
        Dictionary<string, CatalogueItemSummary> byItemId = items.ToDictionary(value => value.ItemId, StringComparer.Ordinal);
        Dictionary<string, CatalogueItemSummary> bySourceKey = items.ToDictionary(value => value.SourceKey, StringComparer.Ordinal);
        Dictionary<string, CreatorWorkflowSnapshot> latest = new(StringComparer.Ordinal);
        Dictionary<string, List<CreatorWorkflowSnapshot>> workflows = new(StringComparer.Ordinal);
        using (SqliteCommand command = connection.CreateCommand())
        {
            command.CommandText = "SELECT source_key,snapshot_json FROM creator_workflows WHERE source_key IS NOT NULL ORDER BY updated_utc DESC,run_id";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                string sourceKey = reader.GetString(0);
                CreatorWorkflowSnapshot? workflow = JsonSerializer.Deserialize<CreatorWorkflowSnapshot>(reader.GetString(1));
                if (workflow is null) continue;
                if (!workflows.TryGetValue(sourceKey, out List<CreatorWorkflowSnapshot>? sourceWorkflows))
                    workflows[sourceKey] = sourceWorkflows = [];
                sourceWorkflows.Add(workflow);
                if (workflow.Script is not null && !latest.ContainsKey(sourceKey)) latest[sourceKey] = workflow;
            }
        }

        Dictionary<string, HashSet<string>> recordedLinks = new(StringComparer.Ordinal);
        using (SqliteCommand command = connection.CreateCommand())
        {
            command.CommandText = "SELECT item_id,details_json FROM audit_events WHERE kind='upload-result' AND item_id IS NOT NULL";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                string itemId = reader.GetString(0);
                if (!byItemId.TryGetValue(itemId, out CatalogueItemSummary? item)) continue;
                RecordedWorkflowPublication? publication = JsonSerializer.Deserialize<RecordedWorkflowPublication>(reader.GetString(1));
                if (publication?.Platform != "script" || publication.PostUrl is null
                    || !TryCanonicalLink("script", publication.PostUrl, out string canonical)) continue;
                if (!recordedLinks.TryGetValue(item.SourceKey, out HashSet<string>? links))
                    recordedLinks[item.SourceKey] = links = new(StringComparer.Ordinal);
                links.Add(canonical);
            }
        }

        Dictionary<string, string> statuses = new(StringComparer.Ordinal);
        foreach ((string sourceKey, CreatorWorkflowSnapshot workflow) in latest)
        {
            CatalogueItemSummary item = bySourceKey[sourceKey];
            CreatorWorkflowScript? script = workflow.Script;
            HashSet<string> knownLinks = new(StringComparer.Ordinal);
            AddKnown(item.PlatformLinks.GetValueOrDefault("script"));
            if (item.SourceLinkCells?.TryGetValue("script", out CatalogueSourceLinkCell? cell) == true)
                foreach (string value in cell.Urls) AddKnown(value);
            if (recordedLinks.TryGetValue(sourceKey, out HashSet<string>? priorLinks)) knownLinks.UnionWith(priorLinks);
            foreach (CreatorWorkflowSnapshot snapshot in workflows[sourceKey])
            {
                if (snapshot.Script is { Status: "uploaded" or "partial" } savedScript)
                    foreach (string value in savedScript.Links ?? []) AddKnown(value);
                foreach (CreatorWorkflowTarget target in snapshot.Targets
                    .Where(value => value.Platform == "script" && value.Status is "uploaded" or "partial"))
                    AddKnown(target.PostUrl);
            }
            bool partial = knownLinks.Count > 0 && (script?.Status is "partial" or "failed"
                || workflow.Targets.Any(value => value.Platform == "script" && value.Status == "failed")
                || script is { Links.Count: > 0, SentKeys.Count: > 0 } && script.SentKeys.Count < script.Links.Count);
            string? status = knownLinks.Count > 0 ? partial ? "partial" : "uploaded"
                : script?.Status == "failed" ? "failed" : "selected";
            statuses[sourceKey] = status;

            void AddKnown(string? value)
            {
                if (value is not null && TryCanonicalLink("script", value, out string canonical)) knownLinks.Add(canonical);
            }
        }
        return statuses;
    }

    private string? ResolveCreatorWorkflowItemId(string sourceKey, SqliteTransaction transaction)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT item_id FROM catalogue_items WHERE source_key=$source";
        command.Parameters.AddWithValue("$source", sourceKey);
        return command.ExecuteScalar() as string
            ?? throw new CreatorWorkflowException("creator-workflow-source-not-found");
    }

    private IReadOnlyList<string> GetRecordedScriptUrls(string itemId)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind='upload-result' AND item_id=$item";
        command.Parameters.AddWithValue("$item", itemId);
        using SqliteDataReader reader = command.ExecuteReader();
        List<string> urls = [];
        while (reader.Read())
        {
            RecordedWorkflowPublication? publication = JsonSerializer.Deserialize<RecordedWorkflowPublication>(reader.GetString(0));
            if (publication?.Platform == "script" && publication.PostUrl is not null) urls.Add(publication.PostUrl);
        }
        return urls;
    }

    private static CreatorWorkflowSnapshot ValidateCreatorWorkflow(CreatorWorkflowSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        if (snapshot.RunId is null || !Regex.IsMatch(snapshot.RunId, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant))
            throw new CreatorWorkflowException("creator-workflow-run-invalid");
        if (!WorkflowKinds.Contains(snapshot.Kind) || snapshot.Revision <= 0)
            throw new CreatorWorkflowException("creator-workflow-invalid");
        if (snapshot.SourceKey is not null) ValidateText(snapshot.SourceKey, 200, "creator-workflow-source-invalid");
        UploadCatalogueDestination? destination;
        try { destination = ValidateUploadCatalogueDestination(snapshot.Destination); }
        catch (WorkbookProjectionException) { throw new CreatorWorkflowException("creator-workflow-invalid-destination"); }
        if (snapshot.Targets is null || snapshot.Targets.Count > 20 || snapshot.Assets is null || snapshot.Assets.Count > 100)
            throw new CreatorWorkflowException("creator-workflow-invalid");
        if (snapshot.Targets.Any(target => target is null) || snapshot.Assets.Any(asset => asset is null))
            throw new CreatorWorkflowException("creator-workflow-invalid");
        if (snapshot.Targets.Select(value => value.Platform).Distinct(StringComparer.Ordinal).Count() != snapshot.Targets.Count)
            throw new CreatorWorkflowException("creator-workflow-duplicate-target");

        CreatorWorkflowTarget[] targets = snapshot.Targets.Select(target =>
        {
            if (target is null || !WorkflowPlatforms.Contains(target.Platform) || !TargetStatuses.Contains(target.Status))
                throw new CreatorWorkflowException("creator-workflow-invalid-target");
            string? url = target.PostUrl is null ? null : CanonicalLink(target.Platform, target.PostUrl);
            if (target.PostUrls is { Count: > 100 })
                throw new CreatorWorkflowException("creator-workflow-invalid-target");
            return target with
            {
                PostUrl = url,
                Error = ValidateError(target.Error),
                GoogleError = ValidateError(target.GoogleError),
                PostUrls = ValidateLinks(target.Platform, target.PostUrls ?? []),
            };
        }).ToArray();

        CreatorWorkflowAsset[] assets = snapshot.Assets.Select(asset =>
        {
            if (!AssetRoles.Contains(asset.Role) || !IsBasename(asset.Name, 255)
                || asset.Size is < 0 or > 1_099_511_627_776L || asset.LastModified == default)
                throw new CreatorWorkflowException("creator-workflow-invalid-asset");
            return asset with { Sha256 = ValidateHash(asset.Sha256) };
        }).ToArray();

        CreatorWorkflowScript? script = snapshot.Script;
        if (script is not null)
        {
            IReadOnlyList<string> scriptLinks = script.Links ?? [];
            IReadOnlyList<string> sentKeys = script.SentKeys ?? [];
            if (!ScriptStatuses.Contains(script.Status) || scriptLinks.Count > 100 || sentKeys.Count > 100
                || script.WritebackState is not null and not ("not-associated" or "pending" or "synced"))
                throw new CreatorWorkflowException("creator-workflow-invalid-script");
            script = script with
            {
                Filename = script.Filename is null ? null : ValidateBasename(script.Filename, 255),
                Sha256 = ValidateHash(script.Sha256),
                Links = ValidateLinks("script", scriptLinks),
                SentKeys = ValidateKeys(sentKeys),
                Error = ValidateError(script.Error),
            };
        }

        CreatorWorkflowReply? reply = snapshot.Reply;
        if (reply is not null)
        {
            reply = reply with
            {
                PaidUrl = CanonicalPaidUrl(reply.PaidUrl),
                MainStatusUrl = reply.MainStatusUrl is null ? null : CanonicalLink("x", reply.MainStatusUrl),
                ReplyStatusUrl = reply.ReplyStatusUrl is null ? null : CanonicalLink("x", reply.ReplyStatusUrl),
                WordingTemplate = ValidateWording(reply.WordingTemplate),
            };
            if (reply.ReplyDelayMinutes is < 0 or > 10_080)
                throw new CreatorWorkflowException("creator-workflow-invalid-reply");
        }

        CreatorWorkflowClip? clip = snapshot.Clip;
        if (clip is not null)
        {
            if (clip.ClipId is not null && (clip.ClipId.Length > 128
                || !Regex.IsMatch(clip.ClipId, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant)))
                throw new CreatorWorkflowException("creator-workflow-invalid-clip");
            if (clip.EpisodeKey is not null) ValidateText(clip.EpisodeKey, 200, "creator-workflow-invalid-clip");
            clip = clip with { Sha256 = ValidateHash(clip.Sha256) };
        }

        CreatorWorkflowSnapshot normalized = snapshot with
        { Targets = targets, Assets = assets, Script = script, Reply = reply, Clip = clip, Destination = destination };
        if (JsonSerializer.SerializeToUtf8Bytes(normalized).Length > MaxCreatorWorkflowJsonBytes)
            throw new CreatorWorkflowException("creator-workflow-too-large");
        return normalized;
    }

    private static string CanonicalPaidUrl(string value)
    {
        if (value.Length is 0 or > 2048 || value.Any(char.IsWhiteSpace)
            || !Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Fragment))
            throw new CreatorWorkflowException("creator-workflow-invalid-url");
        string? canonical = null;
        if (string.Equals(uri.IdnHost, "onlyfans.com", StringComparison.OrdinalIgnoreCase)
            && string.IsNullOrEmpty(uri.Query)
            && Regex.IsMatch(uri.AbsolutePath, @"^/[A-Za-z0-9._]{1,64}/?$", RegexOptions.CultureInvariant))
            canonical = $"https://onlyfans.com/{uri.AbsolutePath.Trim('/')}";
        else if (string.Equals(uri.IdnHost, "fansly.com", StringComparison.OrdinalIgnoreCase)
            && string.IsNullOrEmpty(uri.Query)
            && Regex.IsMatch(uri.AbsolutePath, @"^/[A-Za-z0-9._]{1,64}/posts/?$", RegexOptions.CultureInvariant))
            canonical = $"https://fansly.com/{uri.AbsolutePath.Trim('/')}";
        else
            canonical = CatalogueSnapshotImporter.CanonicalPlatformLink("onlyfans", uri)
                ?? CatalogueSnapshotImporter.CanonicalPlatformLink("fansly", uri)
                ?? CatalogueSnapshotImporter.CanonicalPlatformLink("manyvids", uri)
                ?? CatalogueSnapshotImporter.CanonicalPlatformLink("pornhubPaid", uri);
        return canonical ?? throw new CreatorWorkflowException("creator-workflow-invalid-url");
    }

    private static string CanonicalLink(string platform, string value)
    {
        if (!TryCanonicalLink(platform, value, out string canonical))
            throw new CreatorWorkflowException("creator-workflow-invalid-url");
        return canonical;
    }

    private static bool TryCanonicalLink(string platform, string value, out string canonical)
    {
        canonical = "";
        if (value.Length is 0 or > 2048 || value.Any(char.IsWhiteSpace)
            || !Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo))
            return false;
        string platformKey = platform == "pornhub" ? "pornhubFree" : platform;
        string? result = CatalogueSnapshotImporter.CanonicalPlatformLink(platformKey, uri);
        if (result is null) return false;
        canonical = result;
        return true;
    }

    private static IReadOnlyList<string> ValidateLinks(string platform, IReadOnlyList<string> values)
    {
        List<string> result = [];
        foreach (string value in values)
        {
            if (value is null) throw new CreatorWorkflowException("creator-workflow-invalid-script");
            string canonical = CanonicalLink(platform, value);
            if (!result.Contains(canonical, StringComparer.Ordinal)) result.Add(canonical);
        }
        return result;
    }

    private static IReadOnlyList<string> ValidateKeys(IReadOnlyList<string> values)
    {
        List<string> result = [];
        foreach (string value in values)
        {
            if (value is null || !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$", RegexOptions.CultureInvariant))
                throw new CreatorWorkflowException("creator-workflow-invalid-script");
            ValidateText(value, 200, "creator-workflow-invalid-script");
            if (!result.Contains(value, StringComparer.Ordinal)) result.Add(value);
        }
        return result;
    }

    private static string? ValidateHash(string? value)
    {
        if (value is null) return null;
        if (value.Length != 64 || !value.All(Uri.IsHexDigit))
            throw new CreatorWorkflowException("creator-workflow-invalid-hash");
        return value.ToLowerInvariant();
    }

    private static string? ValidateError(string? value)
    {
        if (value is null) return null;
        if (value.Length is 0 or > 64 || !Regex.IsMatch(value, "^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant))
            throw new CreatorWorkflowException("creator-workflow-invalid-error");
        return value;
    }

    private static string? ValidateWording(string? value)
    {
        if (value is null) return null;
        if (value.Length > 5000 || value.Any(character => char.IsControl(character) && character is not ('\r' or '\n' or '\t')))
            throw new CreatorWorkflowException("creator-workflow-invalid-reply");
        return value;
    }

    private static string ValidateBasename(string value, int max) =>
        IsBasename(value, max) ? value : throw new CreatorWorkflowException("creator-workflow-invalid-asset");

    private static bool IsBasename(string value, int max) => value is not null && value.Length is > 0 && value.Length <= max
        && value is not ("." or "..") && !value.Any(character => char.IsControl(character) || character is '/' or '\\' or ':');

    private static void ValidateText(string value, int max, string code)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > max || value.Trim() != value
            || value.Any(char.IsControl))
            throw new CreatorWorkflowException(code);
    }

    private sealed record RecordedWorkflowPublication(string Platform, string PostUrl);
}
