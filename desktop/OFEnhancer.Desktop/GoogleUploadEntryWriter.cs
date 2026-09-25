using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

internal sealed record GoogleUploadEntryRequest(
    string Mode, string Title, string Description, string ReleaseDate,
    string? FileName = null, long? FileSize = null, long? FileLastModified = null,
    string? Id = null, string? ExpectedTitle = null, string? ExpectedDescription = null,
    string Category = "", string SeasonArc = "");

internal sealed record GoogleUploadEntryResult(string Id, int Row, string Status,
    GoogleCatalogueImportPreview Preview);

internal sealed class GoogleUploadEntryWriter(
    string workbookId, int? preferredSheetId, GoogleWorkspaceClient workspace)
{
    internal async Task<GoogleUploadEntryResult> WriteAsync(
        GoogleUploadEntryRequest request, CancellationToken cancellationToken)
    {
        Validate(request);
        GoogleCatalogueImportPreview before = await ReadAsync(cancellationToken).ConfigureAwait(false);
        string id = request.Mode == "new" ? NewId(request) : request.Id!;
        WorkbookCatalogueItem? existing = before.Projection.Items.SingleOrDefault(item => item.SourceKey == id);
        if (request.Mode == "new")
        {
            if (!before.Columns.ContainsKey("plannedDate") || !before.Columns.ContainsKey("description"))
                throw new GoogleCatalogueException("catalogue-layout-changed");
            if (!string.IsNullOrEmpty(request.Category) && !before.Columns.ContainsKey("category")
                || !string.IsNullOrEmpty(request.SeasonArc) && !before.Columns.ContainsKey("series"))
                throw new GoogleCatalogueException("catalogue-layout-changed");
            if (existing is not null)
                return ExactNew(existing, request)
                    ? new(id, existing.SourceRow, "already-created", before)
                    : throw new GoogleCatalogueException("catalogue-new-entry-conflict");
            try
            {
                await workspace.AppendCatalogueRowAsync(workbookId, before.CatalogueSheetTitle,
                    before.HeaderRow, before.Columns, id, request.ReleaseDate,
                    request.Title, request.Description, request.Category, request.SeasonArc,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (GoogleMutationUncertainException)
            {
                // Read back by the deterministic ID. Never blindly append again.
            }
        }
        else
        {
            if (existing is null) throw new GoogleCatalogueException("catalogue-entry-missing");
            bool detailsAlreadyMatch = existing.Title == request.Title
                && existing.Description == request.Description
                && (existing.Series ?? "") == request.SeasonArc;
            if (detailsAlreadyMatch && (string.IsNullOrEmpty(request.Category)
                || await ReadFieldAsync(before, existing, "category", cancellationToken).ConfigureAwait(false) == request.Category))
                return new(id, existing.SourceRow, "already-updated", before);
            if (existing.Title != request.ExpectedTitle || existing.Description != request.ExpectedDescription)
                throw new GoogleCatalogueException("catalogue-entry-changed");
            List<GoogleValueUpdate> updates = [];
            if (existing.Title != request.Title)
                updates.Add(await CheckedUpdateAsync(before, existing, "title", request.Title,
                    request.ExpectedTitle!, cancellationToken).ConfigureAwait(false));
            if (existing.Description != request.Description)
                updates.Add(await CheckedUpdateAsync(before, existing, "description", request.Description,
                    request.ExpectedDescription!, cancellationToken).ConfigureAwait(false));
            if ((existing.Series ?? "") != request.SeasonArc)
                updates.Add(await CheckedUpdateAsync(before, existing, "series", request.SeasonArc,
                    existing.Series ?? "", cancellationToken).ConfigureAwait(false));
            if (!string.IsNullOrEmpty(request.Category))
            {
                string currentCategory = await ReadFieldAsync(before, existing, "category", cancellationToken)
                    .ConfigureAwait(false);
                if (currentCategory != request.Category)
                    updates.Add(await CheckedUpdateAsync(before, existing, "category", request.Category,
                        currentCategory, cancellationToken).ConfigureAwait(false));
            }
            if (updates.Count == 0)
                return new(id, existing.SourceRow, "already-updated", before);
            try
            {
                await workspace.UpdateValuesBatchAsync(new(workbookId, updates), cancellationToken, raw: true)
                    .ConfigureAwait(false);
            }
            catch (GoogleMutationUncertainException)
            {
                // A readback decides whether the one attempted write completed.
            }
        }
        GoogleCatalogueImportPreview after = await ReadAsync(cancellationToken).ConfigureAwait(false);
        if (!before.HasSameMapping(after)) throw new GoogleCatalogueException("catalogue-layout-changed");
        WorkbookCatalogueItem? written = after.Projection.Items.SingleOrDefault(item => item.SourceKey == id);
        if (written is null || written.Title != request.Title || written.Description != request.Description
            || written.Series != (string.IsNullOrEmpty(request.SeasonArc) ? null : request.SeasonArc)
            || request.Mode == "new" && written.PlannedDate != request.ReleaseDate)
            throw new GoogleCatalogueException("google-row-write-unresolved");
        if (!string.IsNullOrEmpty(request.Category)
            && await ReadFieldAsync(after, written, "category", cancellationToken).ConfigureAwait(false) != request.Category)
            throw new GoogleCatalogueException("google-row-write-unresolved");
        return new(id, written.SourceRow, request.Mode == "new" ? "created" : "updated", after);
    }

    private async Task<GoogleValueUpdate> CheckedUpdateAsync(GoogleCatalogueImportPreview preview,
        WorkbookCatalogueItem item, string field, string value, string expected,
        CancellationToken cancellationToken)
    {
        if (!preview.Columns.TryGetValue(field, out int column))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        string sheet = preview.CatalogueSheetTitle.Replace("'", "''", StringComparison.Ordinal);
        string range = $"'{sheet}'!{(char)('A' + column - 1)}{item.SourceRow}";
        GoogleProjectionCell cell = await workspace.ReadProjectionCellAsync(workbookId, range, cancellationToken)
            .ConfigureAwait(false);
        if (cell.Range != range || (cell.Value ?? "") != expected)
            throw new GoogleCatalogueException("catalogue-entry-changed");
        return new(range, value);
    }

    private async Task<string> ReadFieldAsync(GoogleCatalogueImportPreview preview,
        WorkbookCatalogueItem item, string field, CancellationToken cancellationToken)
    {
        if (!preview.Columns.TryGetValue(field, out int column))
            throw new GoogleCatalogueException("catalogue-layout-changed");
        string sheet = preview.CatalogueSheetTitle.Replace("'", "''", StringComparison.Ordinal);
        string range = $"'{sheet}'!{(char)('A' + column - 1)}{item.SourceRow}";
        GoogleProjectionCell cell = await workspace.ReadProjectionCellAsync(workbookId, range, cancellationToken)
            .ConfigureAwait(false);
        if (cell.Range != range) throw new GoogleCatalogueException("catalogue-entry-changed");
        return cell.Value ?? "";
    }

    private async Task<GoogleCatalogueImportPreview> ReadAsync(CancellationToken cancellationToken)
    {
        GoogleWorkbookSnapshot snapshot = await workspace.ReadImportWorkbookAsync(workbookId, cancellationToken)
            .ConfigureAwait(false);
        return GoogleCatalogueImportReader.Read(snapshot, preferredSheetId);
    }

    private static bool ExactNew(WorkbookCatalogueItem item, GoogleUploadEntryRequest request) =>
        item.Title == request.Title && item.Description == request.Description
        && item.PlannedDate == request.ReleaseDate;

    private static string NewId(GoogleUploadEntryRequest request)
    {
        string slug = Regex.Replace(request.Title.ToLowerInvariant().Normalize(NormalizationForm.FormKD),
            "[^a-z0-9]+", "-").Trim('-');
        if (slug.Length == 0) slug = "video";
        if (slug.Length > 70) slug = slug[..70].TrimEnd('-');
        string identity = string.Join("|", request.FileName, request.FileSize!.Value.ToString(CultureInfo.InvariantCulture),
            request.FileLastModified!.Value.ToString(CultureInfo.InvariantCulture), request.Title, request.ReleaseDate);
        string suffix = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..12].ToLowerInvariant();
        return slug + "-" + suffix;
    }

    private static void Validate(GoogleUploadEntryRequest request)
    {
        if (request.Mode is not ("new" or "update")
            || request.Title is not { Length: > 0 and <= 300 }
            || request.Description is not { Length: <= 10_000 }
            || request.Category is not { Length: <= 200 }
            || request.SeasonArc is not { Length: <= 200 }
            || request.Title.Any(char.IsControl) || request.Description.Any(c => c is '\0' or '\r')
            || request.Category.Any(char.IsControl) || request.SeasonArc.Any(char.IsControl)
            || !DateOnly.TryParseExact(request.ReleaseDate, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out _))
            throw new GoogleCatalogueException("invalid-catalogue-entry");
        if (request.Mode == "new")
        {
            if (request.FileName is not { Length: > 0 and <= 255 }
                || request.FileSize is not > 0 || request.FileLastModified is not > 0)
                throw new GoogleCatalogueException("invalid-catalogue-entry");
        }
        else if (request.Id is not { Length: > 0 and <= 200 }
            || request.ExpectedTitle is null || request.ExpectedDescription is null)
            throw new GoogleCatalogueException("invalid-catalogue-entry");
    }
}
