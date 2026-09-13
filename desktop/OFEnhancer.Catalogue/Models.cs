namespace OFEnhancer.Catalogue;

public sealed record CatalogueImportSummary(
    int ActiveItems,
    int ArchivedItems,
    bool Unchanged
);

public sealed record CatalogueItemSummary(
    string ItemId,
    string SourceKey,
    int? SourceRow,
    string Title,
    string Description,
    string? PlannedDate,
    string? Series,
    string? Episode,
    int XTeasers,
    int RedditTeasers,
    IReadOnlyDictionary<string, string> PlatformLinks,
    bool Archived,
    string? ThumbnailAssetId = null,
    string ThumbnailStatus = "missing",
    IReadOnlyList<CatalogueCandidate>? Candidates = null,
    IReadOnlyDictionary<string, CatalogueSourceLinkCell>? SourceLinkCells = null
);

public sealed record CatalogueSourceLinkCell(string Text, string? Hyperlink, IReadOnlyList<string> Urls, string? IssueCode = null);

public sealed record CatalogueCandidate(
    string ItemId,
    string Title,
    string? PlannedDate,
    int Score,
    string? ThumbnailAssetId
);

public sealed record ThumbnailScanSummary(
    int AvailableAssets,
    int NewAssets,
    int UnavailableAssets
);

public sealed record MediaAssetSummary(
    string AssetId,
    string FileName,
    string Role,
    long SizeBytes,
    bool Available,
    string? BoundItemId
);

public sealed record UnmatchedAssetSummary(
    string AssetId,
    string FileName,
    string Role,
    IReadOnlyList<CatalogueCandidate> Candidates
);

public sealed record CatalogueView(
    IReadOnlyList<CatalogueItemSummary> Items,
    IReadOnlyList<UnmatchedAssetSummary> UnmatchedAssets,
    int AvailableThumbnails,
    string InventoryStatus
);

public sealed record BindingSummary(string AssetId, string ItemId, bool Changed);

public sealed record WorkbookCatalogueItem
{
    public WorkbookCatalogueItem(
        int sourceRow,
        string sourceKey,
        string title,
        string description,
        string? plannedDate,
        string? series,
        string? episode,
        int xTeasers,
        int redditTeasers,
        IReadOnlyDictionary<string, string> platformLinks,
        string? metadataId,
        IReadOnlyDictionary<string, CatalogueSourceLinkCell>? sourceLinkCells = null
    )
    {
        SourceRow = sourceRow;
        SourceKey = sourceKey;
        Title = title;
        Description = description;
        PlannedDate = plannedDate;
        Series = series;
        Episode = episode;
        XTeasers = xTeasers;
        RedditTeasers = redditTeasers;
        PlatformLinks = platformLinks;
        MetadataId = metadataId;
        SourceLinkCells = sourceLinkCells;
    }

    public int SourceRow { get; }
    public string SourceKey { get; }
    public string Title { get; }
    public string Description { get; }
    public string? PlannedDate { get; }
    public string? Series { get; }
    public string? Episode { get; }
    public int XTeasers { get; }
    public int RedditTeasers { get; }
    public IReadOnlyDictionary<string, string> PlatformLinks { get; }
    public string? MetadataId { get; }
    public IReadOnlyDictionary<string, CatalogueSourceLinkCell>? SourceLinkCells { get; }
}

public sealed record WorkbookProjection(string WorkbookId, string SheetId, bool Complete, IReadOnlyList<WorkbookCatalogueItem> Items);

public sealed record GoogleRowBinding(
    string WorkbookId,
    string SheetId,
    string ItemId,
    string MetadataId,
    int LastObservedRow,
    string VerifiedRemoteFingerprint,
    DateTimeOffset VerifiedUtc
);

public sealed class WorkbookProjectionException : Exception
{
    public WorkbookProjectionException(string code, string message)
        : base(message) => Code = code;

    public string Code { get; }
}

public enum SyncOutboxState
{
    Pending,
    Attempted,
    Completed,
    Conflict,
    Unresolved,
}

public sealed record SyncOutboxItem(
    string OperationId,
    string IdempotencyKey,
    string ItemId,
    string WorkbookId,
    string SheetId,
    string MetadataKey,
    string MetadataValue,
    string DestinationField,
    string PayloadValue,
    string ExpectedRemoteFingerprint,
    string IntendedValueFingerprint,
    SyncOutboxState State,
    int AttemptCount,
    string? ErrorCode,
    DateTimeOffset CreatedUtc,
    DateTimeOffset? AttemptedUtc,
    DateTimeOffset? CompletedUtc,
    DateTimeOffset? ResolvedUtc
);

public sealed class SyncOutboxException : Exception
{
    public SyncOutboxException(string code, string message)
        : base(message) => Code = code;

    public string Code { get; }
}

public sealed class CatalogueSnapshotException : Exception
{
    public CatalogueSnapshotException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public CatalogueSnapshotException(string code, string message, Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    public string Code { get; }
}
