using System.IO;
using System.Text.Json;

namespace OFEnhancer.Desktop;

internal sealed record ExtensionResetObservation(bool Allowed, object[] Commands);

// This journal belongs to OFEnhancer, not to Chrome. A disconnect alone never
// completes a reset: only Chrome's true-install receipt can cross the barrier.
internal sealed class ChromeExtensionReset
{
    private sealed record Journal(int Schema, string Generation, long StartedAt, bool Pending, string ExtensionId, string[] RetiredReceipts);
    private readonly string path;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private readonly HashSet<string> receipts = [];
    private readonly HashSet<string> sent = [];
    private Journal? state;
    private DateTimeOffset lastOldSeen = DateTimeOffset.MinValue;
    private DateTime lastWrite;
    private bool invalid;
    internal ChromeExtensionReset(string path, TimeProvider? clock = null)
    {
        this.path = path;
        this.clock = clock ?? TimeProvider.System;
        Refresh();
    }
    private void Refresh()
    {
        if (!File.Exists(path))
        {
            // Deleting a journal while this process is live does not cancel it.
            if (state is not null) invalid = true;
            return;
        }
        var stamp = File.GetLastWriteTimeUtc(path);
        if (stamp == lastWrite) return;
        try
        {
            var info = new FileInfo(path);
            if (info.Length is <= 0 or > 65536) throw new InvalidOperationException();
            var loaded = JsonSerializer.Deserialize<Journal>(File.ReadAllText(path));
            if (loaded is null || loaded.Schema != 1 || !Guid.TryParse(loaded.Generation, out _)
                || loaded.StartedAt <= 0 || AppConfiguration.NormalizeExtensionId(loaded.ExtensionId) is null
                || loaded.RetiredReceipts is null || loaded.RetiredReceipts.Length > 256)
                throw new InvalidOperationException();
            if (state?.Generation != loaded.Generation)
            {
                sent.Clear();
                lastOldSeen = clock.GetUtcNow();
            }
            state = loaded;
            lastWrite = stamp;
            invalid = false;
        }
        catch (Exception error) when (error is JsonException or IOException or InvalidOperationException or UnauthorizedAccessException)
        { invalid = true; }
    }
    private void Save(Journal value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(value));
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        state = value;
        lastWrite = File.GetLastWriteTimeUtc(path);
        invalid = false;
    }
    internal bool Pending { get { lock (gate) { Refresh(); return invalid || state?.Pending == true; } } }
    internal string? PreviousExtensionId { get { lock (gate) { Refresh(); return state?.ExtensionId; } } }
    internal string Message => invalid
        ? "The Chrome reset record could not be verified. Start Fresh reset again; uploads remain blocked."
        : "Remove Creator Workflow Toolkit in chrome://extensions, then load the extension-keyed folder below. A reload does not finish Fresh reset.";
    internal void Begin(string extensionId)
    {
        if (AppConfiguration.NormalizeExtensionId(extensionId) is null) throw new InvalidOperationException("Invalid extension identity.");
        lock (gate)
        {
            Refresh();
            Save(new(1, Guid.NewGuid().ToString(), clock.GetUtcNow().ToUnixTimeMilliseconds(), true, extensionId,
                receipts.Concat(state?.RetiredReceipts ?? []).Distinct().TakeLast(256).ToArray()));
            sent.Clear();
            lastOldSeen = clock.GetUtcNow();
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
                && value.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && Guid.TryParse(id.GetString(), out _)
                && value.TryGetProperty("installedAt", out var at) && at.ValueKind == JsonValueKind.Number && at.TryGetInt64(out installedAt)) receipt = id.GetString();
            if (state is null)
            {
                if (receipt is not null && receipts.Count < 256) receipts.Add(receipt);
                return new(true, []);
            }
            bool fresh = receipt is not null && installedAt >= state.StartedAt
                && installedAt <= clock.GetUtcNow().AddSeconds(5).ToUnixTimeMilliseconds()
                && !state.RetiredReceipts.Contains(receipt);
            if (!fresh)
            {
                lastOldSeen = clock.GetUtcNow();
                if (state.Pending && sent.Count < 256 && sent.Add(connectionId))
                    return new(false, [new { id = Guid.NewGuid().ToString(), command = new { kind = "resetExtension", generation = state.Generation } }]);
                return new(false, []);
            }
            if (!matchingVersion) return new(false, []);
            if (state.Pending)
            {
                if (clock.GetUtcNow() - lastOldSeen < TimeSpan.FromSeconds(10)) return new(false, []);
                Save(state with { Pending = false });
            }
            return new(true, []);
        }
    }
}
