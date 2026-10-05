using System.IO;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed record XTeaserRunResult(bool Active, XClipScanResult? Scan, int RevertPairings, XVerdictResult? Verdicts,
    IReadOnlyList<XClipMoveOutcome> Moves);

internal sealed record XTeaserOverviewResult(bool Active, XTeaserOverview Overview);

// Local X teaser folder manager: hourly clip index, 7-day verdicts and
// automatic Good/Failed moves, plus the dashboard read and undo operations.
// Inactive while the teaser root setting is unset. Catalogue access runs on
// the serial request dispatcher; file hashing during scans runs beside it.
// The hourly sheet write-back of discovered teaser links is independent of
// the teaser root.
internal sealed partial class XTeaserController(CatalogueStore store, WebMessageDispatcher dispatcher,
    Func<DesktopSettings> settings, Func<DateTimeOffset>? clock = null,
    Func<DateTimeOffset, XSheetWritebackRun>? sheetWriteback = null, XScanActivityBoard? scanActivity = null) : IDisposable
{
    internal static readonly TimeSpan FirstRunDelay = TimeSpan.FromMinutes(2);
    internal static readonly TimeSpan RunInterval = TimeSpan.FromHours(1);
    private readonly SemaphoreSlim running = new(1, 1);
    private System.Threading.Timer? timer;

    private DateTimeOffset Now => (clock ?? (() => DateTimeOffset.UtcNow))();

    internal void Start() => timer ??= new System.Threading.Timer(_ => _ = RunScheduledAsync(), null, FirstRunDelay, RunInterval);

    private async Task RunScheduledAsync()
    {
        try { await RunOnceAsync().ConfigureAwait(false); }
        catch { /* The next hourly run retries; refusals are recorded in the move log. */ }
        try { await WriteBackSheetLinksAsync().ConfigureAwait(false); }
        catch { /* The next hourly run retries; attempts are recorded in the audit log. */ }
    }

    internal async Task<XSheetWritebackRun?> WriteBackSheetLinksAsync() => sheetWriteback is null ? null
        : await dispatcher.EnqueueAsync(() => sheetWriteback(Now)).ConfigureAwait(false);

    internal async Task<XTeaserRunResult> RunOnceAsync()
    {
        DesktopSettings current = settings();
        if (current.XTeaserRoot is not { } root) return new(false, null, 0, null, []);
        if (!await running.WaitAsync(0).ConfigureAwait(false)) return new(true, null, 0, null, []);
        try
        {
            IReadOnlyList<XClipFingerprint> known = await dispatcher.EnqueueAsync(store.GetXClipFingerprints).ConfigureAwait(false);
            IReadOnlyList<XClipFingerprint> files = await Task.Run(() => XTeaserFolder.Scan(root, known)).ConfigureAwait(false);
            XClipScanResult scan = await dispatcher.EnqueueAsync(() => store.ApplyXClipScan(files, Now)).ConfigureAwait(false);
            int revert = current.XTeaserRevertListPath is { } revertList
                ? await dispatcher.EnqueueAsync(() => store.ImportXClipRevertList(root, revertList, Now)).ConfigureAwait(false)
                : 0;
            XVerdictResult verdicts = await dispatcher.EnqueueAsync(() => store.DecideXVerdicts(Now)).ConfigureAwait(false);
            List<XClipMoveOutcome> moves = [];
            foreach (XClipMoveCandidate candidate in await dispatcher.EnqueueAsync(store.GetXClipMoveCandidates).ConfigureAwait(false))
            {
                // Hash beside the request queue; a target that already exists is refused without reading the clip.
                XClipFreshFingerprint fresh = File.Exists(Path.Combine(root, CatalogueStore.XClipVerdictTarget(candidate)))
                    ? new(candidate.RelPath, -1, "", null, XClipFreshFingerprint.NotRead)
                    : await Task.Run(() => XTeaserFolder.FreshFingerprint(root, candidate.RelPath)).ConfigureAwait(false);
                if (await dispatcher.EnqueueAsync(() => store.ApplyXClipVerdictMove(root, candidate, fresh, Now)).ConfigureAwait(false)
                    is { } outcome)
                    moves.Add(outcome);
            }
            return new(true, scan, revert, verdicts, moves);
        }
        finally
        {
            running.Release();
        }
    }

    internal XTeaserOverviewResult Overview(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        return new(settings().XTeaserRoot is not null, store.GetXTeaserOverview());
    }

    // The automatic first-reply queue is independent of the teaser folder setting.
    internal XTeaserReplyQueue ReplyQueue(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        return store.GetXTeaserReplyQueue(Now);
    }

    internal async Task<XClipMoveOutcome> UndoAsync(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Count() != 1
            || !payload.TryGetProperty("moveId", out JsonElement id) || id.ValueKind != JsonValueKind.Number
            || !id.TryGetInt64(out long moveId) || moveId <= 0)
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        string root = settings().XTeaserRoot ?? throw new GoogleCatalogueControllerException("x-teaser-inactive");
        try
        {
            XClipUndoPlan plan = await dispatcher.EnqueueAsync(() => store.PlanXClipUndo(moveId)).ConfigureAwait(false);
            XClipFreshFingerprint fresh = await Task.Run(() => XTeaserFolder.FreshFingerprint(root, plan.CurrentRelPath))
                .ConfigureAwait(false);
            return await dispatcher.EnqueueAsync(() => store.UndoXClipMove(root, moveId, Now, fresh)).ConfigureAwait(false);
        }
        catch (XTeaserException exception) { throw new GoogleCatalogueControllerException(exception.Code); }
    }

    internal static readonly IReadOnlySet<string> Operations = new HashSet<string>(StringComparer.Ordinal)
    {
        "getTeaserOverview", "undoTeaserClipMove", "getTeaserReplyQueue", "getTeaserPlan", "setTeaserPlanSlot", "clearTeaserPlanSlot",
        "requestXScan", "getXScanActivity",
        "getTeaserClips", "getTeaserClipChunk", "openTeaserEpisodeFolder", "resolveScheduledTeaserResult",
    };

    internal const int MaxPlanDaysAhead = 60;

    // Shared entry for the agent pipe and the desktop workspace; catalogue
    // access runs on the serial request dispatcher.
    internal async Task<object> HandleAsync(string operation, JsonElement payload) => operation switch
    {
        "getTeaserOverview" => await dispatcher.EnqueueAsync<object>(() => Overview(payload)).ConfigureAwait(false),
        "undoTeaserClipMove" => await UndoAsync(payload).ConfigureAwait(false),
        "getTeaserReplyQueue" => await dispatcher.EnqueueAsync<object>(() => ReplyQueue(payload)).ConfigureAwait(false),
        "getTeaserPlan" => await dispatcher.EnqueueAsync<object>(() => GetPlan(payload)).ConfigureAwait(false),
        "setTeaserPlanSlot" => await dispatcher.EnqueueAsync<object>(() => SetPlanSlot(payload)).ConfigureAwait(false),
        "clearTeaserPlanSlot" => await dispatcher.EnqueueAsync<object>(() => ClearPlanSlot(payload)).ConfigureAwait(false),
        "requestXScan" => await dispatcher.EnqueueAsync<object>(() => RequestScan(payload)).ConfigureAwait(false),
        "getXScanActivity" => ScanActivity(payload),
        "getTeaserClips" => await dispatcher.EnqueueAsync<object>(() => Library(payload)).ConfigureAwait(false),
        "getTeaserClipChunk" => await dispatcher.EnqueueAsync<object>(() => ClipChunk(payload)).ConfigureAwait(false),
        "resolveScheduledTeaserResult" => await dispatcher.EnqueueAsync<object>(() => ScheduledResult(payload)).ConfigureAwait(false),
        "openTeaserEpisodeFolder" => await dispatcher.EnqueueAsync<object>(() => OpenEpisodeFolder(payload)).ConfigureAwait(false),
        _ => throw new GoogleCatalogueControllerException("unsupported-operation"),
    };

    // "Scan now" in the desktop workspace: Chrome's background scanner picks
    // the request up on its next check (every few minutes).
    internal object RequestScan(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        XScanStatus status = store.RequestXScan(Now);
        return new { requested = true, started = false, requestedUtc = status.RequestedUtc };
    }

    // The background scanner's live log (in memory; null before the first scan
    // of this session). Does not touch the catalogue, so it skips the dispatcher.
    internal object ScanActivity(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        return new { activity = scanActivity?.Latest(Now) };
    }

    // Plan dates are the owner's local calendar days; one day of slack either
    // side of UTC covers every time zone.
    internal XTeaserPlan GetPlan(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            throw new GoogleCatalogueControllerException("invalid-teaser-request");
        return store.GetXTeaserPlan(PlanDay(-1));
    }

    internal XTeaserPlanSlot SetPlanSlot(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || payload.EnumerateObject().Any(property => property.Name is not ("date" or "episodeKey" or "clipId"))
            || !payload.TryGetProperty("episodeKey", out JsonElement key) || key.ValueKind != JsonValueKind.String
            || key.GetString() is not { Length: > 0 and <= 200 } episodeKey || string.IsNullOrWhiteSpace(episodeKey))
            throw new GoogleCatalogueControllerException("invalid-teaser-plan");
        string date = PlanDate(payload);
        if (string.CompareOrdinal(date, PlanDay(-1)) < 0 || string.CompareOrdinal(date, PlanDay(MaxPlanDaysAhead + 1)) > 0)
            throw new GoogleCatalogueControllerException("invalid-teaser-plan");
        long? clipId = null;
        if (payload.TryGetProperty("clipId", out JsonElement clip) && clip.ValueKind != JsonValueKind.Null)
        {
            if (clip.ValueKind != JsonValueKind.Number || !clip.TryGetInt64(out long id) || id <= 0)
                throw new GoogleCatalogueControllerException("invalid-teaser-plan");
            clipId = id;
        }
        try { return store.SetXTeaserPlanSlot(date, episodeKey, clipId, Now); }
        catch (XTeaserException exception) { throw new GoogleCatalogueControllerException(exception.Code); }
    }

    internal object ClearPlanSlot(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any(property => property.Name != "date"))
            throw new GoogleCatalogueControllerException("invalid-teaser-plan");
        string date = PlanDate(payload);
        return new { date, cleared = store.ClearXTeaserPlanSlot(date) };
    }

    private static string PlanDate(JsonElement payload)
    {
        if (!payload.TryGetProperty("date", out JsonElement value) || value.ValueKind != JsonValueKind.String)
            throw new GoogleCatalogueControllerException("invalid-teaser-plan");
        string date = value.GetString()!;
        try { CatalogueStore.ParsePlanDate(date); }
        catch (XTeaserException exception) { throw new GoogleCatalogueControllerException(exception.Code); }
        return date;
    }

    private string PlanDay(int offset) =>
        DateOnly.FromDateTime(Now.UtcDateTime).AddDays(offset).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    public void Dispose()
    {
        timer?.Dispose();
        foreach (ClipRead read in clipReads.Values) read.Stream.Dispose();
        clipReads.Clear();
        timer = null;
    }
}
