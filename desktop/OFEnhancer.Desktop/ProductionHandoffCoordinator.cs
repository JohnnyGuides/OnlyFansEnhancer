using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Threading;
using OFEnhancer.Catalogue;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

internal sealed class ProductionHandoffCoordinator(
    CatalogueStore catalogue, Dispatcher? dispatcher = null,
    Action<ProductionHandoffStatus>? showReview = null)
{
    private static readonly IReadOnlyDictionary<string, string[]> Extensions =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["final-render"] = [".mp4", ".mov", ".mkv"],
            ["final-motion"] = [".funscript"],
            ["final-captions"] = [".srt", ".vtt"],
            ["final-thumbnail"] = [".png", ".jpg", ".jpeg", ".webp"]
        };

    public async Task<ProductionHandoffResponse> HandleAsync(ProductionHandoffRequest request,
        CancellationToken stop)
    {
        try
        {
            ProductionHandoffStatus status = request.Operation switch
            {
                ProductionHandoffProtocol.PrepareOperation => await PrepareAsync(request, stop),
                ProductionHandoffProtocol.StatusOperation => await GetStatusAsync(request.HandoffId, stop),
                _ => throw new ProductionHandoffException("unsupported-operation", "Unsupported handoff operation.")
            };
            return ProductionHandoffResponse.Success(request, status);
        }
        catch (ProductionHandoffException error)
        { return ProductionHandoffResponse.Failure(request.RequestId, error.Code); }
        catch (InvalidOperationException error) when (error.Message is
            "handoff-conflict" or "handoff-not-found" or "handoff-not-reviewable" or "catalogue-item-not-found")
        { return ProductionHandoffResponse.Failure(request.RequestId, error.Message); }
    }

    public async Task<ProductionHandoffStatus> PrepareAsync(ProductionHandoffRequest request,
        CancellationToken stop)
    {
        if (request.EpisodeId is not Guid episodeId || request.EditId is not Guid editId ||
            request.EditNumber is not int editNumber || request.Files is not { Count: > 0 and <= 8 } files ||
            string.IsNullOrWhiteSpace(request.EpisodeCode) || request.EpisodeCode.Length > 80 ||
            request.EpisodeCode.Any(char.IsControl))
            throw new ProductionHandoffException("invalid-request", "Incomplete production draft.");
        ValidateFileClaims(files);
        string filesJson = ProductionHandoffProtocol.Serialize(files.OrderBy(f => f.ArtifactId).ToArray());
        string fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            ProductionHandoffProtocol.Serialize(new
            {
                episodeId, editId, request.EpisodeCode, editNumber, filesJson
            })))).ToLowerInvariant();
        var existing = await InCatalogueAsync(() => catalogue.GetProductionHandoff(
            request.HandoffId.ToString("D")));
        if (existing is not null && existing.RequestFingerprint != fingerprint)
            throw new ProductionHandoffException("handoff-conflict", "Handoff ID already has different files.");
        if (!await FilesMatchAsync(files, stop))
        {
            if (existing is not null && existing.State is "awaiting_review" or "bound")
                existing = await InCatalogueAsync(() => catalogue.ReviewProductionHandoff(
                    request.HandoffId.ToString("D"), "changed_source"));
            if (existing is null)
                throw new ProductionHandoffException("changed-source", "Selected final file changed.");
            return ToStatus(existing);
        }
        stop.ThrowIfCancellationRequested();
        var draft = await InCatalogueAsync(() => catalogue.SaveProductionDraft(
            request.HandoffId.ToString("D"), episodeId.ToString("D"), editId.ToString("D"),
            request.EpisodeCode, editNumber, filesJson, fingerprint));
        var status = ToStatus(draft);
        if (draft.State == "awaiting_review" && showReview is not null && dispatcher is not null)
            _ = dispatcher.BeginInvoke(() => showReview(status));
        return status;
    }

    public async Task<ProductionHandoffStatus> GetStatusAsync(Guid handoffId,
        CancellationToken stop)
    {
        var saved = await InCatalogueAsync(() => catalogue.GetProductionHandoff(
            handoffId.ToString("D")))
            ?? throw new ProductionHandoffException("handoff-not-found", "Production handoff is missing.");
        if (saved.State is "awaiting_review" or "bound" &&
            !await FilesMatchAsync(ReadFiles(saved), stop))
            saved = await InCatalogueAsync(() => catalogue.ReviewProductionHandoff(
                handoffId.ToString("D"), "changed_source"));
        return ToStatus(saved);
    }

    public async Task<ProductionHandoffStatus> ReviewAsync(Guid handoffId,
        string decision, string? catalogueItemId, CancellationToken stop)
    {
        if (decision is not ("bound" or "rejected"))
            throw new ProductionHandoffException("invalid-decision", "Choose a review decision.");
        var saved = await InCatalogueAsync(() => catalogue.GetProductionHandoff(
            handoffId.ToString("D")))
            ?? throw new ProductionHandoffException("handoff-not-found", "Production handoff is missing.");
        List<FileStream>? leases = null;
        try
        {
            if (decision == "bound")
            {
                leases = await LeaseVerifiedFilesAsync(ReadFiles(saved), stop);
                if (leases is null)
                {
                    await InCatalogueAsync(() => catalogue.ReviewProductionHandoff(
                        handoffId.ToString("D"), "changed_source"));
                    throw new ProductionHandoffException("changed-source", "Final file changed before review.");
                }
            }
            stop.ThrowIfCancellationRequested();
            return ToStatus(await InCatalogueAsync(() => catalogue.ReviewProductionHandoff(
                handoffId.ToString("D"), decision, catalogueItemId)));
        }
        finally
        {
            if (leases is not null)
                foreach (var lease in leases) await lease.DisposeAsync();
        }
    }

    private static ProductionHandoffStatus ToStatus(CatalogueProductionHandoff saved) =>
        new(Guid.Parse(saved.HandoffId), saved.State.Replace('_', '-'),
            Guid.Parse(saved.EpisodeId), Guid.Parse(saved.EditId), saved.EpisodeCode,
            saved.EditNumber, saved.CatalogueItemId, ReadFiles(saved));

    private static IReadOnlyList<ProductionFinalFile> ReadFiles(CatalogueProductionHandoff saved) =>
        JsonSerializer.Deserialize<ProductionFinalFile[]>(saved.FilesJson,
            ProductionHandoffProtocol.JsonOptions)
        ?? throw new ProductionHandoffException("invalid-saved-handoff", "Saved draft files are invalid.");

    private static void ValidateFileClaims(IReadOnlyList<ProductionFinalFile> files)
    {
        if (files.Select(f => f.ArtifactId).Distinct().Count() != files.Count ||
            files.Count(f => f.Role == "final-render") != 1)
            throw new ProductionHandoffException("invalid-files", "Select one final video and unique files.");
        foreach (var file in files)
        {
            if (file.ArtifactId == Guid.Empty || file.Size <= 0 ||
                file.Path is null || file.Path.Length > 2048 ||
                !Regex.IsMatch(file.Sha256 ?? "", "^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant) ||
                string.IsNullOrWhiteSpace(file.Role) ||
                !Extensions.TryGetValue(file.Role, out var allowed) ||
                !allowed.Contains(Path.GetExtension(file.Path), StringComparer.OrdinalIgnoreCase) ||
                !Regex.IsMatch(file.Path, "^[A-Za-z]:\\\\", RegexOptions.CultureInvariant) ||
                file.Path.AsSpan(2).Contains(':'))
                throw new ProductionHandoffException("invalid-files", "Final file identity is invalid.");
            string full;
            try { full = Path.GetFullPath(file.Path); }
            catch (Exception error) when (error is ArgumentException or NotSupportedException)
            { throw new ProductionHandoffException("invalid-files", "Final path is invalid."); }
            if (!string.Equals(full, file.Path, StringComparison.OrdinalIgnoreCase))
                throw new ProductionHandoffException("invalid-files", "Final path must be canonical.");
            for (string? current = full; current is not null; current = Path.GetDirectoryName(current))
            {
                if ((File.Exists(current) || Directory.Exists(current)) &&
                    (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new ProductionHandoffException("invalid-files", "Final path traverses a link.");
                if (Path.GetDirectoryName(current) == current) break;
            }
        }
        if (files.Select(f => f.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Count)
            throw new ProductionHandoffException("invalid-files", "Final paths must be unique.");
    }

    private static async Task<bool> FilesMatchAsync(IReadOnlyList<ProductionFinalFile> files,
        CancellationToken stop)
    {
        var leases = await LeaseVerifiedFilesAsync(files, stop);
        if (leases is null) return false;
        foreach (var lease in leases) await lease.DisposeAsync();
        return true;
    }

    private static async Task<List<FileStream>?> LeaseVerifiedFilesAsync(
        IReadOnlyList<ProductionFinalFile> files, CancellationToken stop)
    {
        List<FileStream> leases = [];
        var accepted = false;
        try
        {
            ValidateFileClaims(files);
            foreach (var file in files)
            {
                var info = new FileInfo(file.Path);
                if (!info.Exists || info.Length != file.Size) return null;
                var modified = info.LastWriteTimeUtc;
                var stream = new FileStream(file.Path, FileMode.Open,
                    FileAccess.Read, FileShare.Read, 1024 * 1024,
                    FileOptions.Asynchronous | FileOptions.SequentialScan);
                leases.Add(stream);
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, stop));
                info.Refresh();
                if (!info.Exists || info.Length != file.Size ||
                    info.LastWriteTimeUtc != modified ||
                    !hash.Equals(file.Sha256, StringComparison.OrdinalIgnoreCase)) return null;
            }
            accepted = true;
            return leases;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ProductionHandoffException)
        { return null; }
        finally
        {
            if (!accepted)
                foreach (var lease in leases) await lease.DisposeAsync();
        }
    }

    private Task<T> InCatalogueAsync<T>(Func<T> action) =>
        dispatcher is null || dispatcher.CheckAccess()
            ? Task.FromResult(action()) : dispatcher.InvokeAsync(action).Task;
}
