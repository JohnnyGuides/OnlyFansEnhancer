using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed partial class GoogleCatalogueController
{
    private int _workflowReadbackCursor;
    private sealed record CreatorWorkflowFlushWork(GoogleCatalogueSelection Selection,
        IGoogleCatalogueSession Session, CreatorWorkflowProjectionIntent[] Intents);

    internal void WriteBackCreatorWorkflows(bool reconcileConflicts = false) =>
        WriteBackCreatorWorkflowsCore(null, reconcileConflicts, CancellationToken.None).GetAwaiter().GetResult();

    // The timer uses the dispatcher-aware wrapper so provider I/O never occupies
    // the serial web-message dispatcher. The durable journal transitions still
    // run there, including the attempted marker before the first provider write.
    internal Task WriteBackCreatorWorkflowsAsync(WebMessageDispatcher dispatcher,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(dispatcher);
        return WriteBackCreatorWorkflowsCore(dispatcher, reconcileConflicts: false, cancellationToken);
    }

    private async Task WriteBackCreatorWorkflowsCore(WebMessageDispatcher? dispatcher,
        bool reconcileConflicts, CancellationToken cancellationToken)
    {
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken, _lifetime.Token);
        CancellationToken stop = linked.Token;

        Task<T> Catalogue<T>(Func<T> action) => dispatcher is null
            ? Task.FromResult(action())
            : dispatcher.EnqueueAsync(action);

        CreatorWorkflowFlushWork? work;
        try
        {
            work = await Catalogue(() =>
            {
                if (stop.IsCancellationRequested) return null;
                GoogleCatalogueSelection? selection = _store.GetGoogleCatalogueSelection();
                IGoogleCatalogueSession? session;
                lock (_gate)
                {
                    if (_disposed || selection is null || _session is null
                        || _completion?.WorkbookId != selection.WorkbookId)
                        return null;
                    session = _session;
                }

                CreatorWorkflowProjectionIntent[] queued = [.. _store.GetCreatorWorkflowProjectionIntents(selection.WorkbookId)];
                if (reconcileConflicts)
                {
                    foreach (CreatorWorkflowProjectionIntent intent in queued
                        .Where(value => value.State == "conflict" && value.ErrorCode == "google-workflow-ledger-full")
                        .Take(10))
                    {
                        try { _store.RetryCreatorWorkflowProjectionCapacityConflict(intent.Key); }
                        catch (CreatorWorkflowException) { }
                    }
                    queued = [.. _store.GetCreatorWorkflowProjectionIntents(selection.WorkbookId)];
                }
                CreatorWorkflowProjectionIntent[] readbacks = [.. queued.Where(value => value.State is "attempted" or "unresolved")];
                int readbackStart = readbacks.Length == 0 ? 0 : _workflowReadbackCursor % readbacks.Length;
                CreatorWorkflowProjectionIntent[] selectedReadbacks = readbacks.Length == 0 ? [] :
                    [.. Enumerable.Range(0, Math.Min(2, readbacks.Length))
                        .Select(offset => readbacks[(readbackStart + offset) % readbacks.Length])];
                IEnumerable<CreatorWorkflowProjectionIntent> batch = queued.Where(value => value.State == "pending").Take(10)
                    .Concat(selectedReadbacks);
                if (reconcileConflicts)
                    batch = batch.Concat(queued.Where(value => value.State == "conflict").Take(10));
                CreatorWorkflowProjectionIntent[] intents = [.. batch];
                if (Interlocked.CompareExchange(ref _catalogueOperationActive, 1, 0) != 0)
                    return null;
                if (readbacks.Length > 0)
                    _workflowReadbackCursor = (readbackStart + selectedReadbacks.Length) % readbacks.Length;
                return new CreatorWorkflowFlushWork(selection, session, intents);
            }).ConfigureAwait(false);
        }
        catch (WebMessageDispatcherClosedException) { return; }
        catch (OperationCanceledException) { return; }
        if (work is null) return;

        try
        {
            foreach (CreatorWorkflowProjectionIntent intent in work.Intents)
            {
                if (stop.IsCancellationRequested) break;
                CreatorWorkflowProjectionIntent outcome = intent;
                try
                {
                    GoogleWorkflowLedgerResult result = await work.Session.WriteWorkflowLedgerAsync(intent, sheetId =>
                    {
                        // Provider mutation cannot start until this journal marker
                        // is committed through the same catalogue execution path.
                        Catalogue(() =>
                        {
                            if (stop.IsCancellationRequested)
                                throw new OperationCanceledException(stop);
                            GoogleCatalogueSelection? current = _store.GetGoogleCatalogueSelection();
                            lock (_gate)
                            {
                                if (_disposed || !ReferenceEquals(work.Session, _session)
                                    || _completion?.WorkbookId != work.Selection.WorkbookId
                                    || current?.WorkbookId != work.Selection.WorkbookId)
                                    throw new GoogleCatalogueControllerException("google-catalogue-disconnected");
                            }
                            outcome = _store.RecordCreatorWorkflowProjection(intent with
                                { State = "attempted", LedgerSheetId = sheetId, ErrorCode = null });
                            return true;
                        }).GetAwaiter().GetResult();
                    }, stop).ConfigureAwait(false);

                    if (result.State != outcome.State || result.ErrorCode != outcome.ErrorCode)
                    {
                        // A pre-dispatch network failure leaves the original pending
                        // intent retryable; dispatched work follows writer readback.
                        if (result.State == "pending" && outcome.State == "pending") continue;
                        await Catalogue(() => _store.RecordCreatorWorkflowProjection(outcome with
                            { State = result.State, ErrorCode = result.ErrorCode })).ConfigureAwait(false);
                    }
                }
                catch (Exception error)
                {
                    if (outcome.State is "attempted" or "unresolved")
                    {
                        try
                        {
                            await Catalogue(() => _store.RecordCreatorWorkflowProjection(outcome with
                                { State = "unresolved", ErrorCode = SafeException(error).Code })).ConfigureAwait(false);
                        }
                        catch (WebMessageDispatcherClosedException) { }
                    }
                    // The immutable local intent remains retryable after connection
                    // failures; stop this pass and let the next timer run resume it.
                    break;
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (WebMessageDispatcherClosedException) { }
        finally { ExitCatalogueOperation(); }
    }
}
