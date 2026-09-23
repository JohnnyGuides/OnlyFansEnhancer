using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace OFEnhancer.Desktop;

// The upload console keeps the user's original file. A normalized cache copy
// remains available while Chrome finishes reading the selected file.
internal static class UploadThumbnailConverter
{
    internal const int Width = 640;
    internal const int Height = 360;
    private const long MaximumInputBytes = 50L * 1024 * 1024;

    internal static FileInfo Convert(FileInfo original)
    {
        if (!original.Exists || original.Length == 0 || original.Length > MaximumInputBytes)
            throw new InvalidOperationException("Choose a PNG or JPEG thumbnail under 50 MB.");

        string cacheRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OFEnhancer", "cache", "upload-thumbnails");
        ReapOldOutputs(cacheRoot);
        string outputDirectory = Path.Combine(cacheRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        string sourceStem = Path.GetFileNameWithoutExtension(original.Name);
        string safeStem = new(sourceStem.Take(100).Select(character =>
            Path.GetInvalidFileNameChars().Contains(character) ? '_' : character).ToArray());
        string outputPath = Path.Combine(outputDirectory, $"{safeStem} (640x360).png");
        bool completed = false;
        try
        {
            using Image image = Image.FromFile(original.FullName, useEmbeddedColorManagement: true);
            if (image.RawFormat.Guid != ImageFormat.Png.Guid && image.RawFormat.Guid != ImageFormat.Jpeg.Guid)
                throw new InvalidOperationException("Choose a readable PNG or JPEG thumbnail.");
            ApplyOrientation(image);
            if (image.Width == 0 || image.Height == 0 || image.Width > 10000 || image.Height > 10000)
                throw new InvalidOperationException("The thumbnail dimensions are unsupported.");

            double sourceRatio = (double)image.Width / image.Height;
            double targetRatio = (double)Width / Height;
            RectangleF crop = sourceRatio > targetRatio
                ? new RectangleF((float)((image.Width - image.Height * targetRatio) / 2), 0,
                    (float)(image.Height * targetRatio), image.Height)
                : new RectangleF(0, (float)((image.Height - image.Width / targetRatio) / 2),
                    image.Width, (float)(image.Width / targetRatio));
            using Bitmap output = new(Width, Height, PixelFormat.Format24bppRgb);
            using (Graphics graphics = Graphics.FromImage(output))
            {
                graphics.Clear(Color.Black);
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.DrawImage(image, new RectangleF(0, 0, Width, Height), crop, GraphicsUnit.Pixel);
            }
            output.Save(outputPath, ImageFormat.Png);
            FileInfo result = new(outputPath);
            if (result.Length >= 2_000_000)
                throw new InvalidOperationException("The converted thumbnail exceeds 2 MB.");
            completed = true;
            return result;
        }
        catch (Exception error) when (error is ArgumentException or OutOfMemoryException or System.Runtime.InteropServices.ExternalException)
        {
            throw new InvalidOperationException("Choose a readable PNG or JPEG thumbnail.", error);
        }
        finally
        {
            if (!completed)
            {
                try { Directory.Delete(outputDirectory, recursive: true); }
                catch (IOException) { /* Preserve the conversion error. */ }
                catch (UnauthorizedAccessException) { /* Preserve the conversion error. */ }
            }
        }
    }

    internal static void Delete(FileInfo output)
    {
        try
        {
            File.Delete(output.FullName);
            output.Directory?.Delete();
        }
        catch (IOException) { /* A stale cache file can be removed on a later run. */ }
        catch (UnauthorizedAccessException) { /* Preserve the original upload outcome. */ }
    }

    private static void ReapOldOutputs(string root)
    {
        if (!Directory.Exists(root)) return;
        DateTime threshold = DateTime.UtcNow.AddDays(-30);
        foreach (string path in Directory.EnumerateDirectories(root))
        {
            DirectoryInfo directory = new(path);
            if (!Guid.TryParseExact(directory.Name, "N", out _) || directory.LastWriteTimeUtc >= threshold)
                continue;
            try { directory.Delete(recursive: true); }
            catch (IOException) { /* A browser may still hold a stale file. */ }
            catch (UnauthorizedAccessException) { /* Preserve the current conversion. */ }
        }
    }

    private static void ApplyOrientation(Image image)
    {
        const int orientationTag = 0x0112;
        if (!image.PropertyIdList.Contains(orientationTag)) return;
        int orientation = image.GetPropertyItem(orientationTag)?.Value?.FirstOrDefault() ?? 1;
        RotateFlipType rotation = orientation switch
        {
            2 => RotateFlipType.RotateNoneFlipX,
            3 => RotateFlipType.Rotate180FlipNone,
            4 => RotateFlipType.Rotate180FlipX,
            5 => RotateFlipType.Rotate90FlipX,
            6 => RotateFlipType.Rotate90FlipNone,
            7 => RotateFlipType.Rotate270FlipX,
            8 => RotateFlipType.Rotate270FlipNone,
            _ => RotateFlipType.RotateNoneFlipNone,
        };
        if (rotation != RotateFlipType.RotateNoneFlipNone) image.RotateFlip(rotation);
    }
}
