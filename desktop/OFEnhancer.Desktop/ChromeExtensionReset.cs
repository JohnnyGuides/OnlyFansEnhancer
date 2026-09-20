using System.IO;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal sealed record ExtensionResetObservation(bool Allowed, object[] Commands);
internal sealed record ExtensionPresence(string Id, bool Enabled);

// Fresh reset first asks the exact connected extension to clear its own storage
// and uninstall itself. The final call cannot reply on success because Chrome
// destroys its caller, so a bounded silence window completes that trusted
// request. Manual removal is an explicit fallback, not the default workflow.
internal sealed class ChromeExtensionReset
{
    private sealed record Journal(int Schema, string Generation, long StartedAt, bool Pending,
        string ExtensionId, string[] RetiredReceipts, bool RemovalVerified, string? LastRemovalError,
        bool VerifierSawTarget, long RemovalRequestedAt, long ManualPromptAt,
        long ManualConfirmedAt, long LastObservedAt);
    private sealed record Attempt(string CommandId, DateTimeOffset SentAt, int Count);
    private readonly string path;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private readonly HashSet<string> receipts = [];
    private readonly Dictionary<string, Attempt> attempts = [];
    private readonly Dictionary<string, string> commandConnections = [];
    private readonly HashSet<string> manualOpenConnections = [];
    private Journal? state;
    private DateTime lastWrite;
    private bool invalid;
    private readonly Action? completed;

    internal ChromeExtensionReset(string path, TimeProvider? clock = null, Action? completed = null)
    {
        this.path = path;
        this.clock = clock ?? TimeProvider.System;
        this.completed = completed;
        Refresh();
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
            Journal? loaded = schema switch
            {
                1 => new Journal(4, root.GetProperty("Generation").GetString() ?? "",
                    root.GetProperty("StartedAt").GetInt64(), root.GetProperty("Pending").GetBoolean(),
                    root.GetProperty("ExtensionId").GetString() ?? "",
                    root.GetProperty("RetiredReceipts").EnumerateArray().Select(item => item.GetString() ?? "").ToArray(),
                    false, null, false, 0, 0, 0, 0),
                2 => new Journal(4, root.GetProperty("Generation").GetString() ?? "",
                    root.GetProperty("StartedAt").GetInt64(), root.GetProperty("Pending").GetBoolean(),
                    root.GetProperty("ExtensionId").GetString() ?? "",
                    root.GetProperty("RetiredReceipts").EnumerateArray().Select(item => item.GetString() ?? "").ToArray(),
                    root.GetProperty("RemovalVerified").GetBoolean(),
                    root.TryGetProperty("LastRemovalError", out JsonElement oldError) && oldError.ValueKind == JsonValueKind.String ? oldError.GetString() : null,
                    false, 0, 0, 0, 0),
                3 => new Journal(4, root.GetProperty("Generation").GetString() ?? "",
                    root.GetProperty("StartedAt").GetInt64(), root.GetProperty("Pending").GetBoolean(),
                    root.GetProperty("ExtensionId").GetString() ?? "",
                    root.GetProperty("RetiredReceipts").EnumerateArray().Select(item => item.GetString() ?? "").ToArray(),
                    root.GetProperty("RemovalVerified").GetBoolean(),
                    root.TryGetProperty("LastRemovalError", out JsonElement priorError) && priorError.ValueKind == JsonValueKind.String ? priorError.GetString() : null,
                    root.TryGetProperty("VerifierSawTarget", out JsonElement sawTarget) && sawTarget.ValueKind == JsonValueKind.True,
                    0, 0, 0, 0),
                4 => JsonSerializer.Deserialize<Journal>(root.GetRawText()),
                _ => null,
            };
            if (loaded is null || !Guid.TryParse(loaded.Generation, out _) || loaded.StartedAt <= 0
                || AppConfiguration.NormalizeExtensionId(loaded.ExtensionId) is null
                || loaded.RetiredReceipts is null || loaded.RetiredReceipts.Length > 256
                || loaded.LastRemovalError?.Length > 500 || loaded.RemovalRequestedAt < 0
                || loaded.ManualPromptAt < 0 || loaded.ManualConfirmedAt < 0 || loaded.LastObservedAt < 0)
                throw new InvalidOperationException();
            if (state?.Generation != loaded.Generation)
            { attempts.Clear(); commandConnections.Clear(); manualOpenConnections.Clear(); }
            state = loaded;
            lastWrite = stamp;
            invalid = false;
        }
        catch (Exception error) when (error is JsonException or IOException or InvalidOperationException or UnauthorizedAccessException or KeyNotFoundException)
        { invalid = true; }
    }

    private void Save(Journal value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value);
            using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { output.Write(bytes); output.Flush(true); }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        state = value;
        lastWrite = File.GetLastWriteTimeUtc(path);
        invalid = false;
    }

    internal bool Pending { get { lock (gate) { Refresh(); return invalid || state?.Pending == true; } } }
    internal bool RemovalVerified { get { lock (gate) { Refresh(); return !invalid && state?.RemovalVerified == true; } } }
    internal string? PreviousExtensionId { get { lock (gate) { Refresh(); return state?.ExtensionId; } } }
    internal string Message
    {
        get
        {
            lock (gate)
            {
                Refresh();
                if (invalid) return "The Chrome reset record could not be verified. Start the operation again; uploads remain blocked.";
                if (!string.IsNullOrWhiteSpace(state?.LastRemovalError))
                    return "Chrome could not remove the previous OFEnhancer extension automatically: " + state.LastRemovalError + ". Use its Remove button in chrome://extensions; do not click Reload.";
                if (state?.ManualPromptAt > 0)
                    return "Chrome needs one manual Remove click for the previous OFEnhancer extension. Do not use Reload.";
                if (state?.RemovalVerified != true)
                    return "OFEnhancer is asking Chrome to remove the previous extension automatically. Keep Chrome open.";
                return "The previous extension was removed. Load the new extension-keyed folder; a Reload is not a new installation.";
            }
        }
    }

    internal void Begin(string extensionId)
    {
        if (AppConfiguration.NormalizeExtensionId(extensionId) is null) throw new InvalidOperationException("Invalid extension identity.");
        lock (gate)
        {
            Refresh();
            Save(new(4, Guid.NewGuid().ToString(), clock.GetUtcNow().ToUnixTimeMilliseconds(), true, extensionId,
                receipts.Concat(state?.RetiredReceipts ?? []).Distinct().TakeLast(256).ToArray(),
                false, null, false, 0, 0, 0, 0));
            attempts.Clear();
            commandConnections.Clear();
            manualOpenConnections.Clear();
        }
    }

    internal ExtensionResetObservation Observe(string browserId, string connectionId, JsonElement? installation, bool matchingVersion)
    {
        lock (gate)
        {
            Refresh();
            if (invalid) return new(false, []);
            string? receipt = null;
            long installedAt = 0;
            if (installation is { ValueKind: JsonValueKind.Object } value
                && value.TryGetProperty("id", out JsonElement id) && id.ValueKind == JsonValueKind.String && Guid.TryParse(id.GetString(), out _)
                && value.TryGetProperty("installedAt", out JsonElement at) && at.ValueKind == JsonValueKind.Number && at.TryGetInt64(out installedAt))
                receipt = id.GetString();
            if (state is null)
            {
                if (receipt is not null && receipts.Count < 256) receipts.Add(receipt);
                return new(true, []);
            }
            bool fresh = receipt is not null && installedAt >= state.StartedAt
                && installedAt <= clock.GetUtcNow().AddSeconds(5).ToUnixTimeMilliseconds()
                && !state.RetiredReceipts.Contains(receipt);
            if (fresh)
            {
                if (!state.RemovalVerified || !matchingVersion) return new(false, []);
                if (state.Pending)
                {
                    Save(state with { Pending = false });
                    completed?.Invoke();
                }
                return new(true, []);
            }
            if (!state.Pending || state.RemovalVerified) return new(false, []);
            long now = clock.GetUtcNow().ToUnixTimeMilliseconds();
            if (state.ManualPromptAt > 0)
            {
                if (now - state.LastObservedAt >= 500)
                    Save(state with { LastObservedAt = now });
                if (manualOpenConnections.Add(connectionId))
                    return new(false, [new { id = Guid.NewGuid().ToString(), command = new { kind = "openChromePage", page = "extensions" } }]);
                return new(false, []);
            }
            attempts.TryGetValue(connectionId, out Attempt? previous);
            if (previous is not null && (previous.Count >= 3 || clock.GetUtcNow() - previous.SentAt < TimeSpan.FromSeconds(2)))
                return new(false, []);
            string commandId = Guid.NewGuid().ToString();
            attempts[connectionId] = new(commandId, clock.GetUtcNow(), (previous?.Count ?? 0) + 1);
            commandConnections[commandId] = connectionId;
            Save(state with { RemovalRequestedAt = now, LastObservedAt = now, LastRemovalError = null });
            return new(false, [new { id = commandId, command = new { kind = "resetExtension", generation = state.Generation } }]);
        }
    }

    internal bool TryConfirmAutomaticRemoval(TimeSpan silence)
    {
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending || state.RemovalVerified) return state?.RemovalVerified == true;
            long now = clock.GetUtcNow().ToUnixTimeMilliseconds();
            if (state.ManualPromptAt == 0 && state.RemovalRequestedAt > 0
                && string.IsNullOrWhiteSpace(state.LastRemovalError)
                && now - state.RemovalRequestedAt >= silence.TotalMilliseconds)
            {
                Save(state with { RemovalVerified = true });
                return true;
            }
            return false;
        }
    }

    internal void RequestManualRemoval()
    {
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending || state.RemovalVerified) return;
            long now = clock.GetUtcNow().ToUnixTimeMilliseconds();
            Save(state with { ManualPromptAt = now, ManualConfirmedAt = 0, LastObservedAt = now });
            manualOpenConnections.Clear();
        }
    }

    internal void BeginManualConfirmation()
    {
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending || state.ManualPromptAt == 0)
                throw new InvalidOperationException("Manual Chrome removal is not active.");
            Save(state with { ManualConfirmedAt = clock.GetUtcNow().ToUnixTimeMilliseconds() });
        }
    }

    internal bool TryConfirmManualRemoval(TimeSpan silence)
    {
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending || state.RemovalVerified) return state?.RemovalVerified == true;
            long now = clock.GetUtcNow().ToUnixTimeMilliseconds();
            if (state.ManualConfirmedAt > 0
                && now - Math.Max(state.ManualConfirmedAt, state.LastObservedAt) >= silence.TotalMilliseconds)
            {
                Save(state with { RemovalVerified = true, LastRemovalError = null });
                return true;
            }
            return false;
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
                if (reply.TryGetProperty("error", out JsonElement error) && error.ValueKind == JsonValueKind.String)
                {
                    string message = (error.GetString() ?? "extension-removal-failed").Trim();
                    if (message.Length > 500) message = message[..500];
                    Save(state with { LastRemovalError = message });
                }
            }
        }
    }

    internal void ObserveVerifier(string verifierExtensionId, IReadOnlyCollection<ExtensionPresence> installed,
        IReadOnlyCollection<string> uninstallEvents)
    {
        if (AppConfiguration.NormalizeExtensionId(verifierExtensionId) is null) throw new InvalidOperationException("Invalid verifier identity.");
        lock (gate)
        {
            Refresh();
            if (invalid || state is null || !state.Pending) return;
            bool targetPresent = installed.Any(item => item.Id == state.ExtensionId);
            bool eventObserved = uninstallEvents.Contains(state.ExtensionId, StringComparer.Ordinal);
            if (targetPresent && !state.VerifierSawTarget)
                Save(state with { VerifierSawTarget = true });
            if (!targetPresent && (eventObserved || !state.VerifierSawTarget))
                Save(state with { RemovalVerified = true, LastRemovalError = null });
        }
    }
}
