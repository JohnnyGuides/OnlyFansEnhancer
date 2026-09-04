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
    IReadOnlyList<CatalogueCandidate>? Candidates = null
);

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
