using System.Text.Json;

namespace OFEnhancer.Desktop;

// A bounded, in-memory command channel. Chrome retains upload checkpoints;
// neither this queue nor the WebView receives account credentials.
public sealed class BrowserUploadChannel : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, DateTimeOffset> browsers = [];
    private readonly Dictionary<string, string> connections = [];
    private readonly HashSet<string> retiredConnections = [];
    private readonly Dictionary<string, TaskCompletionSource<JsonElement>> pending = [];
    private readonly Dictionary<string, object> commands = [];
    private string? selected;
    private bool selectionRequired;
    private string? integrationIdentity;
    private string? integrationFingerprint;
    private string? setupGeneration;
    private bool requireIdentity;

    // A local freshness challenge, not authentication against another process running as this user.
    public void ConfigureIntegration(string? identity, string fingerprint)
    {
        lock (gate)
        {
            requireIdentity = true;
            if (integrationIdentity == identity && integrationFingerprint == fingerprint) return;
            integrationIdentity = identity;
            integrationFingerprint = fingerprint;
            setupGeneration = Guid.NewGuid().ToString();
            selectionRequired |= selected is not null;
            foreach (var waiting in pending.Values)
                waiting.TrySetException(new InvalidOperationException("Chrome setup changed. Review progress before continuing."));
            pending.Clear();
            commands.Clear();
            browsers.Clear();
            connections.Clear();
            selected = null;
        }
    }
    private readonly System.Threading.Timer timer;
    public event Action<JsonElement>? EventReceived;

    private readonly TimeProvider clock;
    public BrowserUploadChannel(TimeProvider? clock = null)
    {
        this.clock = clock ?? TimeProvider.System;
        timer = new(_ => { lock (gate) Expire(); }, null, 3000, 3000);
    }

    private void Expire()
    {
        if (selected is null || (browsers.TryGetValue(selected, out var seen) && clock.GetUtcNow() - seen < TimeSpan.FromSeconds(10))) return;
        foreach (var waiting in pending.Values)
            waiting.TrySetException(new InvalidOperationException("The upload browser disconnected. Check the existing platform draft before retrying."));
        pending.Clear();
        commands.Clear();
        selectionRequired = true;
        selected = null;
    }

    public void Dispose()
    {
        timer.Dispose();
        lock (gate)
        {
            foreach (var waiting in pending.Values) waiting.TrySetException(new InvalidOperationException("The desktop upload window closed."));
            pending.Clear();
            commands.Clear();
        }
    }

    public object Exchange(JsonElement payload)
    {
        string id = payload.GetProperty("browserId").GetString() ?? "";
        string connectionId = payload.GetProperty("connectionId").GetString() ?? "";
        if (!Guid.TryParse(id, out _) || !Guid.TryParse(connectionId, out _)) throw new InvalidOperationException("invalid-browser");
        List<JsonElement> events = [];
        object[] work;
        lock (gate)
        {
            Expire();
            if (retiredConnections.Contains(connectionId)) throw new InvalidOperationException("stale-browser-connection");
            if (requireIdentity && (integrationIdentity is null
                || !payload.TryGetProperty("extensionId", out var extension) || extension.GetString() != integrationIdentity
                || !payload.TryGetProperty("bridgeExtensionId", out var bridge) || bridge.GetString() != integrationIdentity
                || !payload.TryGetProperty("setupGeneration", out var generation) || generation.GetString() != setupGeneration))
                return new { commands = Array.Empty<object>(), connectionId, setupGeneration };
            if (selected == id && connections.TryGetValue(id, out var previous) && previous != connectionId)
            {
                foreach (var waiting in pending.Values)
                    waiting.TrySetException(new InvalidOperationException("The upload browser restarted. Review the existing draft before continuing."));
                pending.Clear();
                commands.Clear();
                selected = null;
                selectionRequired = true;
            }
            if (connections.TryGetValue(id, out var oldConnection) && oldConnection != connectionId)
            {
                if (retiredConnections.Count >= 4096) throw new InvalidOperationException("browser-generation-limit");
                retiredConnections.Add(oldConnection);
            }
            if (!browsers.ContainsKey(id) && browsers.Count >= 128) throw new InvalidOperationException("browser-limit");
            connections[id] = connectionId;
            browsers[id] = clock.GetUtcNow();
            if (payload.TryGetProperty("replies", out JsonElement replies))
                foreach (JsonElement reply in replies.EnumerateArray().Take(64))
                {
                    if (selected != id) continue;
                    string key = reply.GetProperty("id").GetString() ?? "";
                    if (!pending.Remove(key, out var waiting)) continue;
                    if (reply.TryGetProperty("error", out var error))
                        waiting.TrySetException(new InvalidOperationException(error.GetString()));
                    else waiting.TrySetResult(reply.GetProperty("result").Clone());
                }
            if (selected == id && payload.TryGetProperty("events", out JsonElement incoming))
                events.AddRange(incoming.EnumerateArray().Take(64).Select(value => value.Clone()));
            work = selected == id ? commands.Values.ToArray() : [];
            if (selected == id) commands.Clear();
        }
        foreach (var value in events) EventReceived?.Invoke(value);
        return new { commands = work, connectionId, setupGeneration };
    }

    public object Status()
    {
        lock (gate)
        {
            Expire();
            var live = browsers.Where(pair => clock.GetUtcNow() - pair.Value < TimeSpan.FromSeconds(10))
                .Select(pair => pair.Key).ToArray();
            var relevant = selected is not null && live.Contains(selected) ? browsers[selected] : live.Select(id => browsers[id]).DefaultIfEmpty(DateTimeOffset.MinValue).Max();
            double expiresInMilliseconds = live.Length == 0 ? 0 : Math.Max(0, 10000 - (clock.GetUtcNow() - relevant).TotalMilliseconds);
            return new { browsers = live, selected, connected = selected is not null && live.Contains(selected), expiresInMilliseconds, selectionRequired };
        }
    }

    public object Select(string id)
    {
        lock (gate)
        {
            Expire();
            if (!browsers.TryGetValue(id, out var seen) || clock.GetUtcNow() - seen >= TimeSpan.FromSeconds(10))
                throw new InvalidOperationException("browser-unavailable");
            if (selected != id && pending.Count > 0) throw new InvalidOperationException("upload-in-progress");
            selected = id;
            selectionRequired = false;
        }
        return Status();
    }

    public Task<JsonElement> RequestAsync(JsonElement command)
    {
        if (command.ValueKind != JsonValueKind.Object || !command.TryGetProperty("kind", out var kind)
            || kind.ValueKind != JsonValueKind.String
            || kind.GetString() is not ("message" or "storageGet" or "storageSet" or "permissions" or "port" or "disconnect")
            || ContainsAttachment(command))
            throw new InvalidOperationException("invalid-upload-command");
        return QueueAsync(command);
    }

    private static bool ContainsAttachment(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array) return value.EnumerateArray().Any(ContainsAttachment);
        if (value.ValueKind != JsonValueKind.Object) return false;
        return value.EnumerateObject().Any(property =>
            property.Name.Equals("filePath", StringComparison.OrdinalIgnoreCase)
            || (property.Name == "kind" && property.Value.ValueKind == JsonValueKind.String && property.Value.GetString() == "file")
            || ContainsAttachment(property.Value));
    }

    // Only MainWindow's AdditionalObject selection path may create this command.
    internal Task<JsonElement> RequestNativeFileAsync(JsonElement command) => QueueAsync(command);

    internal Task<JsonElement> OpenChromePageAsync(string page, CancellationToken cancellationToken)
    {
        if (page is not ("extensions" or "newtab")) throw new InvalidOperationException("invalid-chrome-page");
        return QueueAsync(JsonSerializer.SerializeToElement(new { kind = "openChromePage", page }), cancellationToken);
    }

    private async Task<JsonElement> QueueAsync(JsonElement command, CancellationToken cancellationToken = default)
    {
        if (System.Text.Encoding.UTF8.GetByteCount(command.GetRawText()) > 64 * 1024)
            throw new InvalidOperationException("upload-command-too-large");
        string id = Guid.NewGuid().ToString();
        TaskCompletionSource<JsonElement> waiting = new(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            Expire();
            var live = browsers.Where(pair => clock.GetUtcNow() - pair.Value < TimeSpan.FromSeconds(10)).ToArray();
            if (selected is null && live.Length == 1 && !selectionRequired) selected = live[0].Key;
            if (selected is null) throw new InvalidOperationException(live.Length > 1 ? "choose-upload-browser" : "Open Chrome with the OFEnhancer extension to connect uploads.");
            if (!live.Any(pair => pair.Key == selected)) throw new InvalidOperationException("The selected browser disconnected. Reopen it before continuing.");
            if (pending.Count >= 64) throw new InvalidOperationException("browser-busy");
            if (System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(commands.Values).Length
                + System.Text.Encoding.UTF8.GetByteCount(command.GetRawText()) > 512 * 1024)
                throw new InvalidOperationException("browser-busy");
            pending.Add(id, waiting);
            commands.Add(id, new { id, command = command.Clone() });
        }
        try { return await waiting.Task.WaitAsync(TimeSpan.FromHours(2), cancellationToken); }
        finally { lock (gate) { pending.Remove(id); commands.Remove(id); } }
    }
}
