using System.IO;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal sealed record ExtensionResetObservation(bool Allowed, object[] Commands);

internal enum ChromeResetStage { Removal, Replacement, Admitted }
internal enum ChromeRemovalEvidence { None, Requested, ApiRejected, UserReportedRemoved, UserReportedAbsent, Unknown }

// The sole Chrome lifecycle coordinator. It records facts and provenance;
// requests, disconnects, timers, and user assertions never become proof.
internal sealed class ChromeExtensionReset
{
    private sealed record Journal(int Schema, string Generation, long StartedAt, bool Pending,
        string ExtensionId, string[] RetiredReceipts, string Stage, string RemovalEvidence,
        string? LastRemovalError, long RemovalRequestedAt, long UserAssertedAt,
        string? AdmittedReceipt, long AdmittedAt);
    private sealed record Attempt(string CommandId, DateTimeOffset SentAt, int Count);
    private readonly string path;
    private readonly string? legacyPath;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private readonly HashSet<string> receipts = [];
    private readonly Dictionary<string, Attempt> attempts = [];
    private readonly Dictionary<string, string> commandConnections = [];
    private readonly Action? completed;
    private Journal? state;
    private DateTime lastWrite;
    private bool invalid;

    internal ChromeExtensionReset(string path, TimeProvider? clock = null, Action? completed = null, string? legacyPath = null)
    {
        this.path = Path.GetFullPath(path);
        this.legacyPath = legacyPath is null ? null : Path.GetFullPath(legacyPath);
        this.clock = clock ?? TimeProvider.System;
        this.completed = completed;
        ImportLegacyRecord();
        Refresh();
    }

    private void ImportLegacyRecord()
    {
        if (File.Exists(path) || legacyPath is null || !File.Exists(legacyPath)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.Copy(legacyPath, temporary, false);
            File.Move(temporary, path, false);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private void Refresh()
    {
        if (!File.Exists(path)) { if (state is not null) invalid = true; return; }
        DateTime stamp = File.GetLastWriteTimeUtc(path);
        if (stamp == lastWrite) return;
        try
        {
            FileInfo info = new(path);
            if (info.Length is <= 0 or > 65536) throw new InvalidOperationException();
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            JsonElement root = document.RootElement;
            int schema = root.GetProperty("Schema").GetInt32();
            Journal? loaded = schema == 5 ? JsonSerializer.Deserialize<Journal>(root.GetRawText()) : MigrateLegacy(root, schema);
            Validate(loaded);
            if (state?.Generation != loaded!.Generation) { attempts.Clear(); commandConnections.Clear(); }
            state = loaded;
            invalid = false;
            if (schema != 5) Save(loaded!); else lastWrite = stamp;
            if (legacyPath is not null && !SamePath(legacyPath, path) && File.Exists(legacyPath)) File.Delete(legacyPath);
        }
        catch (Exception error) when (error is JsonException or IOException or InvalidOperationException or UnauthorizedAccessException or KeyNotFoundException)
        { invalid = true; }
    }

    private static Journal MigrateLegacy(JsonElement root, int schema)
    {
        if (schema is < 1 or > 4) throw new InvalidOperationException();
        bool pending = root.GetProperty("Pending").GetBoolean();
        bool legacyVerified = schema >= 2 && root.TryGetProperty("RemovalVerified", out JsonElement verified) && verified.ValueKind == JsonValueKind.True;
        long manualConfirmed = schema >= 4 && root.TryGetProperty("ManualConfirmedAt", out JsonElement manual) ? manual.GetInt64() : 0;
        long requestedAt = schema >= 4 && root.TryGetProperty("RemovalRequestedAt", out JsonElement requested) ? requested.GetInt64() : 0;
        ChromeRemovalEvidence evidence = manualConfirmed > 0 ? ChromeRemovalEvidence.UserReportedRemoved
            : legacyVerified ? ChromeRemovalEvidence.Unknown : requestedAt > 0 ? ChromeRemovalEvidence.Requested : ChromeRemovalEvidence.None;
        ChromeResetStage stage = !pending ? ChromeResetStage.Admitted : legacyVerified ? ChromeResetStage.Replacement : ChromeResetStage.Removal;
        return new(5, root.GetProperty("Generation").GetString() ?? "", root.GetProperty("StartedAt").GetInt64(), pending,
            root.GetProperty("ExtensionId").GetString() ?? "",
            root.GetProperty("RetiredReceipts").EnumerateArray().Select(item => item.GetString() ?? "").ToArray(),
            stage.ToString(), evidence.ToString(),
            schema >= 2 && root.TryGetProperty("LastRemovalError", out JsonElement error) && error.ValueKind == JsonValueKind.String ? error.GetString() : null,
            requestedAt, manualConfirmed, null, 0);
    }

    private static void Validate(Journal? value)
    {
        if (value is null || value.Schema != 5 || !Guid.TryParse(value.Generation, out _) || value.StartedAt <= 0
            || AppConfiguration.NormalizeExtensionId(value.ExtensionId) is null || value.RetiredReceipts is null
            || value.RetiredReceipts.Length > 256 || value.RetiredReceipts.Any(receipt => !Guid.TryParse(receipt, out _))
            || !Enum.TryParse<ChromeResetStage>(value.Stage, false, out _) || !Enum.TryParse<ChromeRemovalEvidence>(value.RemovalEvidence, false, out _)
            || value.LastRemovalError?.Length > 500 || value.RemovalRequestedAt < 0 || value.UserAssertedAt < 0 || value.AdmittedAt < 0
            || value.AdmittedReceipt is not null && !Guid.TryParse(value.AdmittedReceipt, out _)) throw new InvalidOperationException();
    }

    private void Save(Journal value)
    {
        Validate(value);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value);
            using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { output.Write(bytes); output.Flush(true); }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        state = value; lastWrite = File.GetLastWriteTimeUtc(path); invalid = false;
    }

    internal bool Pending { get { lock (gate) { Refresh(); return invalid || state?.Pending == true; } } }
    internal bool IsValid { get { lock (gate) { Refresh(); return !invalid; } } }
    internal ChromeResetStage Stage { get { lock (gate) { Refresh(); return ParseStage(); } } }
    internal ChromeRemovalEvidence RemovalEvidence { get { lock (gate) { Refresh(); return ParseEvidence(); } } }
    internal string? PreviousExtensionId { get { lock (gate) { Refresh(); return state?.ExtensionId; } } }
    internal string? AdmittedReceipt { get { lock (gate) { Refresh(); return state?.AdmittedReceipt; } } }

    internal string Message
    {
        get
        {
            lock (gate)
            {
                Refresh();
                if (invalid) return "The Chrome reset record could not be verified. Chrome access remains blocked; repair the record before continuing.";
                if (state is null || !state.Pending) return "Chrome setup is ready.";
                if (ParseStage() == ChromeResetStage.Replacement)
                {
                    string prefix = ParseEvidence() switch
                    {
                        ChromeRemovalEvidence.UserReportedRemoved => "You reported that the previous extension was removed. ",
                        ChromeRemovalEvidence.UserReportedAbsent => "You reported that the previous extension was already absent. ",
                        ChromeRemovalEvidence.ApiRejected => "Chrome refused automatic removal. ",
                        _ => "Previous extension removal was not confirmed. ",
                    };
                    return prefix + "Load the installed extension-keyed folder. A Reload is not a new installation.";
                }
                if (!string.IsNullOrWhiteSpace(state.LastRemovalError)) return state.LastRemovalError + " Remove Creator Workflow Toolkit manually, or leave this task pending.";
                if (ParseEvidence() == ChromeRemovalEvidence.Requested) return "Chrome received the removal request, but removal is not confirmed. Check Chrome, then continue to replacement.";
                return "Remove Creator Workflow Toolkit in Chrome before loading its replacement. Desktop features remain available.";
            }
        }
    }

    internal void Begin(string extensionId)
    {
        if (AppConfiguration.NormalizeExtensionId(extensionId) is null) throw new InvalidOperationException("Invalid extension identity.");
        lock (gate)
        {
            Refresh();
            if (invalid) throw new InvalidOperationException("The existing Chrome reset record could not be verified.");
            if (!invalid && state?.Pending == true) return;
            Save(new(5, Guid.NewGuid().ToString(), clock.GetUtcNow().ToUnixTimeMilliseconds(), true, extensionId,
                receipts.Concat(state?.RetiredReceipts ?? []).Distinct().TakeLast(256).ToArray(), ChromeResetStage.Removal.ToString(),
                ChromeRemovalEvidence.None.ToString(), null, 0, 0, null, 0));
            attempts.Clear(); commandConnections.Clear();
        }
    }

    internal void ContinueToReplacement(ChromeRemovalEvidence evidence)
    {
        if (evidence is not (ChromeRemovalEvidence.UserReportedRemoved or ChromeRemovalEvidence.UserReportedAbsent
            or ChromeRemovalEvidence.Unknown or ChromeRemovalEvidence.ApiRejected or ChromeRemovalEvidence.Requested))
            throw new InvalidOperationException("Chrome removal evidence is invalid.");
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending) throw new InvalidOperationException("The Chrome reset record is unavailable.");
            Save(state with { Stage = ChromeResetStage.Replacement.ToString(), RemovalEvidence = evidence.ToString(),
                UserAssertedAt = evidence is ChromeRemovalEvidence.UserReportedRemoved or ChromeRemovalEvidence.UserReportedAbsent
                    ? clock.GetUtcNow().ToUnixTimeMilliseconds() : state.UserAssertedAt });
        }
    }

    internal ExtensionResetObservation Observe(string browserId, string connectionId, JsonElement? installation, bool matchingVersion)
    {
        lock (gate)
        {
            Refresh();
            if (invalid) return new(false, []);
            (string? receipt, long installedAt) = ReadReceipt(installation);
            if (state is null)
            {
                if (receipt is not null && receipts.Count < 256) receipts.Add(receipt);
                return new(true, []);
            }
            if (!state.Pending)
            {
                // A completed reset remains an admission decision, not a
                // temporary gate. Legacy terminal records without an admitted
                // receipt preserve normal-update compatibility.
                return new(state.AdmittedReceipt is null
                    || matchingVersion && receipt == state.AdmittedReceipt, []);
            }
            bool fresh = receipt is not null && installedAt >= state.StartedAt
                && installedAt <= clock.GetUtcNow().AddMinutes(5).ToUnixTimeMilliseconds() && !state.RetiredReceipts.Contains(receipt);
            if (ParseStage() == ChromeResetStage.Replacement)
            {
                if (!matchingVersion || !fresh) return new(false, []);
                Save(state with { Pending = false, Stage = ChromeResetStage.Admitted.ToString(), AdmittedReceipt = receipt,
                    AdmittedAt = clock.GetUtcNow().ToUnixTimeMilliseconds() });
                completed?.Invoke();
                return new(true, []);
            }
            if (!matchingVersion)
            {
                const string error = "This loaded extension version cannot be removed automatically without risking its stored recovery data.";
                if (state.LastRemovalError != error) Save(state with { LastRemovalError = error });
                return new(false, []);
            }
            attempts.TryGetValue(connectionId, out Attempt? previous);
            if (previous is not null && (previous.Count >= 1 || clock.GetUtcNow() - previous.SentAt < TimeSpan.FromSeconds(2))) return new(false, []);
            string commandId = Guid.NewGuid().ToString();
            attempts[connectionId] = new(commandId, clock.GetUtcNow(), (previous?.Count ?? 0) + 1);
            commandConnections[commandId] = connectionId;
            Save(state with { RemovalRequestedAt = clock.GetUtcNow().ToUnixTimeMilliseconds(),
                RemovalEvidence = ChromeRemovalEvidence.Requested.ToString(), LastRemovalError = null });
            return new(false, [new { id = commandId, command = new { kind = "resetExtension", generation = state.Generation } }]);
        }
    }

    internal void ObserveReplies(string connectionId, JsonElement replies)
    {
        if (replies.ValueKind != JsonValueKind.Array) return;
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending) return;
            foreach (JsonElement reply in replies.EnumerateArray().Take(64))
            {
                if (!reply.TryGetProperty("id", out JsonElement id) || id.ValueKind != JsonValueKind.String) continue;
                string commandId = id.GetString() ?? "";
                if (!commandConnections.TryGetValue(commandId, out string? expected) || expected != connectionId) continue;
                commandConnections.Remove(commandId);
                if (!reply.TryGetProperty("error", out JsonElement error) || error.ValueKind != JsonValueKind.String) continue;
                string message = (error.GetString() ?? "Chrome refused automatic removal.").Trim();
                if (message.Length > 500) message = message[..500];
                Save(state with { RemovalEvidence = ChromeRemovalEvidence.ApiRejected.ToString(), LastRemovalError = message });
            }
        }
    }

    private ChromeResetStage ParseStage() => state is null ? ChromeResetStage.Admitted : Enum.Parse<ChromeResetStage>(state.Stage, false);
    private ChromeRemovalEvidence ParseEvidence() => state is null ? ChromeRemovalEvidence.None : Enum.Parse<ChromeRemovalEvidence>(state.RemovalEvidence, false);
    private static (string? Id, long InstalledAt) ReadReceipt(JsonElement? installation)
    {
        if (installation is not { ValueKind: JsonValueKind.Object } value || !value.TryGetProperty("id", out JsonElement id)
            || id.ValueKind != JsonValueKind.String || !Guid.TryParse(id.GetString(), out _) || !value.TryGetProperty("installedAt", out JsonElement at)
            || at.ValueKind != JsonValueKind.Number || !at.TryGetInt64(out long installedAt)) return (null, 0);
        return (id.GetString(), installedAt);
    }
    private static bool SamePath(string left, string right) => Path.GetFullPath(left).Equals(Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
}
