using System.Drawing;
using System.Drawing.Imaging;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class UploadThumbnailConverterTests
{
    [TestMethod]
    public void CenterCropsASelectedImageToAShortLived640x360Png()
    {
        string sourcePath = Path.Combine(Path.GetTempPath(), $"ofenhancer-thumb-test-{Guid.NewGuid():N}.png");
        FileInfo? output = null;
        try
        {
            using (Bitmap source = new(100, 100))
            using (Graphics graphics = Graphics.FromImage(source))
            {
                graphics.Clear(Color.Green);
                graphics.FillRectangle(Brushes.Red, 0, 0, 100, 20);
                graphics.FillRectangle(Brushes.Blue, 0, 80, 100, 20);
                source.Save(sourcePath, ImageFormat.Png);
            }

            output = UploadThumbnailConverter.Convert(new FileInfo(sourcePath));
            Assert.AreEqual(".png", output.Extension);
            Assert.IsTrue(output.Length < 2_000_000);
            using Bitmap result = new(output.FullName);
            Assert.AreEqual(640, result.Width);
            Assert.AreEqual(360, result.Height);
            Assert.AreEqual(Color.Green.ToArgb(), result.GetPixel(320, 180).ToArgb());
            Assert.AreEqual(Color.Green.ToArgb(), result.GetPixel(320, 0).ToArgb());
            Assert.AreEqual(Color.Green.ToArgb(), result.GetPixel(320, 359).ToArgb());
            Assert.IsTrue(File.Exists(sourcePath), "The chosen original must remain untouched.");
        }
        finally
        {
            if (output is not null) UploadThumbnailConverter.Delete(output);
            File.Delete(sourcePath);
        }
        if (output is not null) Assert.IsFalse(File.Exists(output.FullName));
    }
}
