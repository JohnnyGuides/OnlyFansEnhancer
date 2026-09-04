using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed class GoogleCatalogueSyncWorker
{
    private readonly GoogleWorkspaceClient _workspace;
    private readonly CatalogueStore _store;
    private readonly Func<DateTimeOffset> _utcNow;
    private readonly SemaphoreSlim _runGate = new(1, 1);

    internal GoogleCatalogueSyncWorker(
        GoogleWorkspaceClient workspace,
        CatalogueStore store
    ) : this(workspace, store, static () => DateTimeOffset.UtcNow)
    {
    }

    internal GoogleCatalogueSyncWorker(
        GoogleWorkspaceClient workspace,
        CatalogueStore store,
        Func<DateTimeOffset> utcNow
    )
    {
        _workspace = workspace ?? throw new ArgumentNullException(nameof(workspace));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
    }

    internal async Task<GoogleSyncSummary> RunOnceAsync(CancellationToken cancellationToken)
    {
        await _runGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            int completed = 0;
            int conflicts = 0;
            int unresolved = 0;
            foreach (SyncOutboxItem operation in _store.GetOpenSyncOperations())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (operation.State == SyncOutboxState.Conflict)
                    continue;
                try
                {
                    SyncOutcome outcome = operation.State == SyncOutboxState.Pending
                        ? await ProcessPendingAsync(operation, cancellationToken).ConfigureAwait(false)
                        : await ReconcileReadOnlyAsync(operation, cancellationToken).ConfigureAwait(false);
                    switch (outcome)
                    {
                        case SyncOutcome.Completed:
                            completed++;
                            break;
                        case SyncOutcome.Conflict:
                            conflicts++;
                            break;
                        case SyncOutcome.Unresolved:
                            unresolved++;
                            break;
                    }
                }
                catch (GoogleCatalogueException)
                {
                    // A read-only preflight failure leaves pending work eligible for a later manual run.
                }
                catch (SyncOutboxException)
                {
                    // Another serialized owner may have resolved this immutable operation.
                }
            }

            int pending = _store.GetOpenSyncOperations().Count(operation =>
                operation.State == SyncOutboxState.Pending);
            return new(completed, conflicts, unresolved, pending);
        }
        finally
        {
            _runGate.Release();
        }
    }

    private async Task<SyncOutcome> ProcessPendingAsync(
        SyncOutboxItem operation,
        CancellationToken cancellationToken
    )
    {
        if (!string.Equals(Fingerprint(operation.PayloadValue), operation.IntendedValueFingerprint, StringComparison.Ordinal))
            return MarkPendingConflict(operation, "intended-fingerprint-invalid");

        TargetCell target = await ResolveTargetAsync(operation, cancellationToken).ConfigureAwait(false);
        if (target.ErrorCode is not null)
            return MarkPendingConflict(operation, target.ErrorCode);

        GoogleProjectionCell cell = target.Cell!;
        if (string.Equals(cell.Value, operation.PayloadValue, StringComparison.Ordinal))
            return MarkPendingCompleted(operation);
        if (!string.Equals(cell.Fingerprint, operation.ExpectedRemoteFingerprint, StringComparison.Ordinal))
            return MarkPendingConflict(operation, "remote-fingerprint-changed");
        if (!string.IsNullOrEmpty(cell.Value))
            return MarkPendingConflict(operation, "remote-value-not-empty");

        _store.MarkSyncAttempted(operation.OperationId, UtcNow());
        try
        {
            await _workspace.UpdateValuesBatchAsync(
                new GoogleValuesBatch(
                    operation.WorkbookId,
                    [new GoogleValueUpdate(target.Range!, operation.PayloadValue)]
                ),
                cancellationToken
            ).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            _store.MarkSyncUnresolved(operation.OperationId, "google-mutation-uncertain", UtcNow());
            throw;
        }
        catch (GoogleCatalogueException)
        {
            return await ReconcileAttemptedAsync(operation, cancellationToken).ConfigureAwait(false);
        }
        return await ReconcileAttemptedAsync(operation, cancellationToken).ConfigureAwait(false);
    }

    private async Task<SyncOutcome> ReconcileAttemptedAsync(
        SyncOutboxItem operation,
        CancellationToken cancellationToken
    )
    {
        try
        {
            TargetCell target = await ResolveTargetAsync(operation, cancellationToken).ConfigureAwait(false);
            if (target.ErrorCode is not null)
                return MarkAttemptedUnresolved(operation, "sync-readback-unavailable");
            if (string.Equals(target.Cell!.Value, operation.PayloadValue, StringComparison.Ordinal))
            {
                _store.MarkSyncCompleted(operation.OperationId, UtcNow());
                return SyncOutcome.Completed;
            }
            _store.MarkSyncConflict(operation.OperationId, "sync-readback-differed", UtcNow());
            return SyncOutcome.Conflict;
        }
        catch (GoogleCatalogueException)
        {
            return MarkAttemptedUnresolved(operation, "sync-readback-unavailable");
        }
    }

    private async Task<SyncOutcome> ReconcileReadOnlyAsync(
        SyncOutboxItem operation,
        CancellationToken cancellationToken
    )
    {
        try
        {
            TargetCell target = await ResolveTargetAsync(operation, cancellationToken).ConfigureAwait(false);
            if (target.ErrorCode is not null)
                return KeepOrMarkUnresolved(operation);
            if (string.Equals(target.Cell!.Value, operation.PayloadValue, StringComparison.Ordinal))
            {
                _store.MarkSyncCompleted(operation.OperationId, UtcNow());
                return SyncOutcome.Completed;
            }
            _store.MarkSyncConflict(operation.OperationId, "sync-readback-differed", UtcNow());
            return SyncOutcome.Conflict;
        }
        catch (GoogleCatalogueException)
        {
            return KeepOrMarkUnresolved(operation);
        }
    }

    private async Task<TargetCell> ResolveTargetAsync(
        SyncOutboxItem operation,
        CancellationToken cancellationToken
    )
    {
        if (!int.TryParse(operation.SheetId, NumberStyles.None, CultureInfo.InvariantCulture, out int sheetId)
            || sheetId < 0)
        {
            return new(null, null, "metadata-sheet-invalid");
        }

        IReadOnlyList<GoogleMetadataMatch> matches = await _workspace.SearchItemMetadataAsync(
            operation.WorkbookId,
            operation.MetadataValue,
            cancellationToken
        ).ConfigureAwait(false);
        if (matches.Count == 0)
            return new(null, null, "metadata-row-not-found");
        if (matches.Count != 1)
            return new(null, null, "metadata-row-ambiguous");
        GoogleMetadataMatch match = matches[0];
        if (match.SheetId != sheetId)
            return new(null, null, "metadata-sheet-mismatch");

        string column = GoogleWorkbookProfile.ColumnForDestination(operation.DestinationField);
        GoogleSheetIdentity sheet = await _workspace.ReadSheetIdentityAsync(
            operation.WorkbookId,
            match.SheetId,
            cancellationToken
        ).ConfigureAwait(false);
        string title = sheet.Title.Replace("'", "''", StringComparison.Ordinal);
        string range = $"'{title}'!{column}{match.RowNumber}";
        GoogleProjectionCell cell = await _workspace.ReadProjectionCellAsync(
            operation.WorkbookId,
            range,
            cancellationToken
        ).ConfigureAwait(false);
        return string.Equals(cell.Range, range, StringComparison.Ordinal)
            ? new(range, cell, null)
            : new(null, null, "projection-cell-range-mismatch");
    }

    private SyncOutcome MarkPendingCompleted(SyncOutboxItem operation)
    {
        _store.MarkSyncPendingCompleted(operation.OperationId, UtcNow());
        return SyncOutcome.Completed;
    }

    private SyncOutcome MarkPendingConflict(SyncOutboxItem operation, string errorCode)
    {
        _store.MarkSyncPendingConflict(operation.OperationId, errorCode, UtcNow());
        return SyncOutcome.Conflict;
    }

    private SyncOutcome MarkAttemptedUnresolved(SyncOutboxItem operation, string errorCode)
    {
        _store.MarkSyncUnresolved(operation.OperationId, errorCode, UtcNow());
        return SyncOutcome.Unresolved;
    }

    private SyncOutcome KeepOrMarkUnresolved(SyncOutboxItem operation)
    {
        if (operation.State == SyncOutboxState.Attempted)
            _store.MarkSyncUnresolved(operation.OperationId, "sync-readback-unavailable", UtcNow());
        return SyncOutcome.Unresolved;
    }

    private DateTimeOffset UtcNow() => _utcNow().ToUniversalTime();

    private static string Fingerprint(string value) => Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(value))
    ).ToLowerInvariant();

    private enum SyncOutcome
    {
        Completed,
        Conflict,
        Unresolved,
    }

    private sealed record TargetCell(string? Range, GoogleProjectionCell? Cell, string? ErrorCode);
}

internal sealed record GoogleSyncSummary(int Completed, int Conflicts, int Unresolved, int Pending);
