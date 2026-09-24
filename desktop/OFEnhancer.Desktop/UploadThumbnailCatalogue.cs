using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text.Json;
using OFEnhancer.Catalogue;

namespace OFEnhancer.Desktop;

// Only catalogue-ID filenames in the configured, scanned thumbnail root are
// offered to the upload console. Asset IDs never grant arbitrary file access.
internal sealed class UploadThumbnailCatalogue(CatalogueStore store)
{
    private const long MaximumInputBytes = 50L * 1024 * 1024;
    private readonly ThumbnailResourceResolver resolver = new(store);

    internal object List(JsonElement payload)
    {
        string sourceKey = ReadSourceKey(payload);
        if (payload.TryGetProperty("refresh", out JsonElement refresh) && refresh.ValueKind == JsonValueKind.True)
        {
            string root = store.ConfiguredThumbnailRoot ?? throw new InvalidOperationException("thumbnail-folder-not-configured");
            store.ScanThumbnails(root);
        }
        bool configured = store.ConfiguredThumbnailRoot is not null;
        return new
        {
            configured,
            choices = configured ? Choices(sourceKey).Select(asset => new
            {
                assetId = asset.AssetId,
                name = asset.FileName,
                size = asset.SizeBytes,
                type = MimeType(asset.FileName),
                lastModified = LastModified(asset.AssetId),
                role = asset.Role,
            }).ToArray() : [],
        };
    }

    internal object Preview(JsonElement payload)
    {
        MediaAssetSummary asset = Select(payload);
        return PreviewAsset(asset);
    }

    internal object CataloguePreviews(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("catalogueIds", out JsonElement ids)
            || ids.ValueKind != JsonValueKind.Array
            || ids.GetArrayLength() is < 1 or > 18)
            throw new InvalidOperationException("invalid-thumbnail-catalogue-ids");
        Dictionary<string, string?> previews = new(StringComparer.Ordinal);
        int totalLength = 0;
        foreach (JsonElement id in ids.EnumerateArray())
        {
            if (id.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException("invalid-thumbnail-catalogue-ids");
            string sourceKey = ReadSourceKey(JsonSerializer.SerializeToElement(new { catalogueId = id.GetString() }));
            if (previews.ContainsKey(sourceKey)) continue;
            string? dataUrl;
            try { dataUrl = PreviewCatalogueItem(sourceKey); }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException)
            { dataUrl = null; }
            if (dataUrl is not null && totalLength + dataUrl.Length <= 700_000)
            {
                previews[sourceKey] = dataUrl;
                totalLength += dataUrl.Length;
            }
            else previews[sourceKey] = null;
        }
        return new { previews };
    }

    private string? PreviewCatalogueItem(string sourceKey)
    {
        CatalogueItemSummary? item = store.GetItems().SingleOrDefault(candidate => candidate.SourceKey == sourceKey);
        if (item is null) throw new InvalidOperationException("thumbnail-catalogue-item-not-found");
        MediaAssetSummary? asset = store.GetAssets()
            .Where(candidate => candidate.BoundItemId == item.ItemId
                || candidate.BoundItemId is null
                    && (Path.GetFileNameWithoutExtension(candidate.FileName) == sourceKey
                        || Path.GetFileNameWithoutExtension(candidate.FileName).StartsWith(sourceKey + "_", StringComparison.Ordinal)))
            .OrderBy(candidate => candidate.BoundItemId == item.ItemId ? 0
                : Path.GetFileNameWithoutExtension(candidate.FileName) == sourceKey ? 1 : 2)
            .ThenBy(candidate => candidate.FileName, StringComparer.Ordinal)
            .FirstOrDefault();
        if (asset is not null)
        {
            if (Path.GetExtension(asset.FileName).Equals(".webp", StringComparison.OrdinalIgnoreCase))
            {
                using ThumbnailResource source = Open(asset.AssetId);
                if (source.Stream.Length > 128_000) return null;
                using MemoryStream output = new();
                source.Stream.CopyTo(output);
                return "data:image/webp;base64," + Convert.ToBase64String(output.ToArray());
            }
            JsonElement preview = JsonSerializer.SerializeToElement(PreviewAsset(asset));
            return preview.GetProperty("dataUrl").GetString();
        }
        string path = Path.Combine(AppContext.BaseDirectory, "app", "legacy-thumbnails", sourceKey + ".safe.webp");
        if (!File.Exists(path)) return null;
        byte[] bytes = File.ReadAllBytes(path);
        if (bytes.Length is < 1 or > 128_000) return null;
        return "data:image/webp;base64," + Convert.ToBase64String(bytes);
    }

    private object PreviewAsset(MediaAssetSummary asset)
    {
        using ThumbnailResource source = Open(asset.AssetId);
        using Image image = Image.FromStream(source.Stream, useEmbeddedColorManagement: true);
        if (image.Width is < 1 or > 10000 || image.Height is < 1 or > 10000)
            throw new InvalidOperationException("thumbnail-image-invalid");
        const int width = 240;
        const int height = 135;
        double ratio = (double)width / height;
        RectangleF crop = image.Width / (double)image.Height > ratio
            ? new RectangleF((float)((image.Width - image.Height * ratio) / 2), 0,
                (float)(image.Height * ratio), image.Height)
            : new RectangleF(0, (float)((image.Height - image.Width / ratio) / 2),
                image.Width, (float)(image.Width / ratio));
        using Bitmap scaled = new(width, height, PixelFormat.Format24bppRgb);
        using (Graphics graphics = Graphics.FromImage(scaled))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(image, new RectangleF(0, 0, width, height), crop, GraphicsUnit.Pixel);
        }
        using MemoryStream output = new();
        scaled.Save(output, ImageFormat.Jpeg);
        if (output.Length > 128_000)
            throw new InvalidOperationException("thumbnail-preview-too-large");
        return new { assetId = asset.AssetId, dataUrl = "data:image/jpeg;base64," + Convert.ToBase64String(output.ToArray()) };
    }

    internal FileInfo ConvertSelected(JsonElement payload)
    {
        MediaAssetSummary asset = Select(payload);
        if (!payload.TryGetProperty("name", out JsonElement name) || name.GetString() != asset.FileName
            || !payload.TryGetProperty("size", out JsonElement size) || size.GetInt64() != asset.SizeBytes
            || !payload.TryGetProperty("lastModified", out JsonElement modified)
            || Math.Abs(modified.GetInt64() - LastModified(asset.AssetId)) > 2)
            throw new InvalidOperationException("Selected thumbnail changed. Choose it again.");
        using ThumbnailResource source = Open(asset.AssetId);
        FileInfo original = new(source.Stream.Name);
        return UploadThumbnailConverter.Convert(original);
    }

    private static string ReadSourceKey(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("catalogueId", out JsonElement id)
            || id.ValueKind != JsonValueKind.String
            || id.GetString() is not { Length: > 0 and <= 200 } sourceKey
            || sourceKey.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-'))
            throw new InvalidOperationException("invalid-thumbnail-catalogue-id");
        return sourceKey;
    }

    private IReadOnlyList<MediaAssetSummary> Choices(string sourceKey)
    {
        CatalogueItemSummary[] items = store.GetItems().Where(item => item.SourceKey == sourceKey).ToArray();
        if (items.Length != 1) throw new InvalidOperationException("thumbnail-catalogue-item-not-found");
        return store.GetAssets().Where(asset =>
            asset.SizeBytes is > 0 and <= MaximumInputBytes
            && MimeType(asset.FileName) is not null
            && (Path.GetFileNameWithoutExtension(asset.FileName) == sourceKey
                || Path.GetFileNameWithoutExtension(asset.FileName).StartsWith(sourceKey + "_", StringComparison.Ordinal))
            && (asset.BoundItemId is null || asset.BoundItemId == items[0].ItemId)
        ).Take(40).ToArray();
    }

    private MediaAssetSummary Select(JsonElement payload)
    {
        string sourceKey = ReadSourceKey(payload);
        if (!payload.TryGetProperty("assetId", out JsonElement id)
            || id.ValueKind != JsonValueKind.String || !Guid.TryParse(id.GetString(), out _))
            throw new InvalidOperationException("invalid-thumbnail-asset-id");
        return Choices(sourceKey).SingleOrDefault(asset => asset.AssetId == id.GetString())
            ?? throw new InvalidOperationException("thumbnail-asset-unavailable");
    }

    private ThumbnailResource Open(string assetId) => resolver.Open(
        new Uri($"https://thumbs.ofenhancer.local/{assetId}"))
        ?? throw new InvalidOperationException("thumbnail-asset-unavailable");

    private long LastModified(string assetId)
    {
        AvailableAssetLocation location = store.ResolveAvailableAssetLocation(assetId)
            ?? throw new InvalidOperationException("thumbnail-asset-unavailable");
        return new DateTimeOffset(File.GetLastWriteTimeUtc(location.Path)).ToUnixTimeMilliseconds();
    }

    private static string? MimeType(string name) => Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        _ => null,
    };
}
