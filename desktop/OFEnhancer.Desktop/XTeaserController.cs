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
internal sealed class XTeaserController(CatalogueStore store, WebMessageDispatcher dispatcher,
    Func<DesktopSettings> settings, Func<DateTimeOffset>? clock = null) : IDisposable
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
    }

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

    public void Dispose()
    {
        timer?.Dispose();
        timer = null;
    }
}
