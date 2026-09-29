using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace OFEnhancer.Catalogue.Tests;

[TestClass]
public sealed class CatalogueMatchingEquivalenceTests
{
    private const string GoldenSha256 = "0fd4e3e1b52628bd108cf5553257e42f0e765de99417a9cd1e415b7adc28b55f";
    private static readonly string[] Words = ["amber", "blue", "cove", "dawn", "echo", "frost"];
    private static readonly string[] SeriesNames = ["Amber", "Blue Cove", "Dawn Echo", "Frost"];

    [TestMethod]
    public void BuildViewAndRankOutputMatchGoldenForCollidingCatalogue()
    {
        using TestDirectory temp = new();
        using CatalogueStore store = BuildCollidingCatalogue(temp.Path, 300, 300);

        CatalogueView view = store.GetCatalogue();
        string serialised = Serialise(store, view);

        Assert.AreEqual(300, view.Items.Count);
        Assert.AreEqual(300, view.AvailableThumbnails);
        Assert.IsTrue(view.UnmatchedAssets.Any(asset => asset.Candidates.Count == 5));
        Assert.IsTrue(view.Items.Any(item => item.ThumbnailStatus == "bound"));
        Assert.IsTrue(view.Items.Any(item => item.ThumbnailStatus == "suggested"));
        Assert.AreEqual(GoldenSha256, Sha256Hex(serialised), "golden drifted; first 400 chars: " + serialised[..400]);
    }

    [TestMethod]
    public void IdenticalBytesUnderTwoNamesAndRolesCountAsOneAsset()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        File.WriteAllBytes(Path.Combine(root, "alpha.png"), [4, 2, 4, 2]);
        File.WriteAllBytes(Path.Combine(root, "alpha_33.png"), [4, 2, 4, 2]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(Snapshot([("alpha-01", "Alpha one", null, null, null)]));

        ThumbnailScanSummary summary = store.ScanThumbnails(root);
        CatalogueView view = store.GetCatalogue();
        MediaAssetSummary asset = store.GetAssets().Single();

        Assert.AreEqual(1, summary.AvailableAssets);
        Assert.AreEqual(1, summary.NewAssets);
        Assert.AreEqual(1, view.AvailableThumbnails);
        Assert.AreEqual(1, view.UnmatchedAssets.Count);
        // Paths sort case-insensitively and the later upsert wins, so the selected location is alpha_33.png.
        Assert.AreEqual("alpha_33.png", asset.FileName);
        Assert.AreEqual("pornhub-33", asset.Role);
        using SqliteCommand command = store.Connection.CreateCommand();
        command.CommandText = "SELECT details_json FROM audit_events WHERE kind = 'thumbnails-scanned'";
        StringAssert.Contains((string)command.ExecuteScalar()!, "\"availableAssets\":1");
    }

    [TestMethod]
    public void BuildViewReadsTheAssetInventoryOncePerView()
    {
        using TestDirectory temp = new();
        string root = Directory.CreateDirectory(Path.Combine(temp.Path, "thumbs")).FullName;
        for (int index = 0; index < 3; index++)
            File.WriteAllBytes(Path.Combine(root, $"file{index}.png"), [(byte)index, 9]);
        using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        store.ImportSnapshot(Snapshot([("file0", "File zero", null, null, null)]));
        store.ScanThumbnails(root);

        // A TEMP view shadows media_assets and counts every row the store scans through it; no production hook.
        int rowsRead = 0;
        store.Connection.CreateFunction("ofe_tick", () =>
        {
            rowsRead++;
            return 1;
        });
        using (SqliteCommand shadow = store.Connection.CreateCommand())
        {
            shadow.CommandText =
                "CREATE TEMP VIEW media_assets AS SELECT * FROM main.media_assets WHERE ofe_tick() = 1";
            shadow.ExecuteNonQuery();
        }

        CatalogueView view = store.GetCatalogue();

        Assert.AreEqual(3, view.AvailableThumbnails);
        // 3 rows from the single GetAssets read plus 3 from the primary-binding join read.
        Assert.AreEqual(6, rowsRead, "exactly one GetAssets read expected");
    }

    [TestMethod]
    public void MeasureMatchingAndReplayCost()
    {
        string? output = Environment.GetEnvironmentVariable("OFE_MEASURE_OUT");
        if (output is null)
            return;
        StringBuilder lines = new();
        using (TestDirectory temp = new())
        {
            using CatalogueStore store = BuildCollidingCatalogue(temp.Path, 2000, 2000);
            lines.AppendLine("BuildView 2000 items x 2000 unmatched assets, median ms of 5: "
                + Median(5, () => store.GetCatalogue()).ToString("F1", CultureInfo.InvariantCulture));
        }
        foreach (int rows in new[] { 1000, 5000, 20000 })
        {
            using TestDirectory temp = new();
            using CatalogueStore store = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
            store.ImportSnapshot(Snapshot(Enumerable.Range(0, 1000)
                .Select(index => ($"item-{index:D4}", $"Title {index}", (string?)null, (string?)null, (string?)null)).ToArray()));
            string[] ids = [.. store.GetItems().Select(item => item.ItemId)];
            using (SqliteTransaction transaction = store.Connection.BeginTransaction())
            {
                using SqliteCommand insert = store.Connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText =
                    "INSERT INTO audit_events(occurred_utc, kind, item_id, details_json) VALUES ('2026-09-29T00:00:00Z','upload-result',$id,$details)";
                SqliteParameter id = insert.Parameters.Add("$id", SqliteType.Text);
                SqliteParameter details = insert.Parameters.Add("$details", SqliteType.Text);
                for (int row = 0; row < rows; row++)
                {
                    id.Value = ids[row % ids.Length];
                    details.Value = $"{{\"Platform\":\"x\",\"PostUrl\":\"https://x.com/u/status/{row + 1000}\"}}";
                    insert.ExecuteNonQuery();
                }
                transaction.Commit();
            }
            lines.AppendLine($"GetUploadCatalogueSnapshot 1000 items, {rows} upload-result rows, median ms of 5: "
                + Median(5, () => store.GetUploadCatalogueSnapshot()).ToString("F1", CultureInfo.InvariantCulture));
            lines.AppendLine($"GetItems 1000 items, {rows} upload-result rows, median ms of 5: "
                + Median(5, () => store.GetItems()).ToString("F1", CultureInfo.InvariantCulture));
        }
        File.WriteAllText(output, lines.ToString());
    }

    private static double Median(int runs, Action action)
    {
        action();
        List<double> times = [];
        for (int run = 0; run < runs; run++)
        {
            Stopwatch watch = Stopwatch.StartNew();
            action();
            times.Add(watch.Elapsed.TotalMilliseconds);
        }
        times.Sort();
        return times[runs / 2];
    }

    private static CatalogueStore BuildCollidingCatalogue(string tempPath, int itemCount, int assetCount)
    {
        Random random = new(20260929);
        string root = Directory.CreateDirectory(Path.Combine(tempPath, "thumbs")).FullName;
        CatalogueStore store = CatalogueStore.Open(Path.Combine(tempPath, "catalogue.db"));
        (string, string, string?, string?, string?)[] rows = new (string, string, string?, string?, string?)[itemCount];
        for (int index = 0; index < itemCount; index++)
        {
            string word = Words[random.Next(Words.Length)];
            string key = index % 5 == 0 ? $"{word.ToUpperInvariant()}-{index:D4}" : $"{word}-{index:D4}";
            string title = $"{Words[random.Next(Words.Length)]} {Words[random.Next(Words.Length)]} Cut {random.Next(4)}";
            string? date = index % 7 == 0 ? null : $"2026-09-{1 + random.Next(28):D2}";
            string? series = index % 3 == 0 ? null : SeriesNames[random.Next(SeriesNames.Length)];
            string? episode = index % 4 == 0 ? null : (1 + random.Next(4)).ToString("D2", CultureInfo.InvariantCulture);
            rows[index] = (key, title, date, series, episode);
        }
        store.ImportSnapshot(Snapshot(rows));

        // Item ids are random per import; rewrite them so the ordinal tie-break is reproducible.
        using (SqliteCommand pragma = store.Connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA foreign_keys = OFF";
            pragma.ExecuteNonQuery();
        }
        using (SqliteCommand rewrite = store.Connection.CreateCommand())
        {
            rewrite.CommandText = "UPDATE catalogue_items SET item_id = printf('00000000-0000-0000-0000-%012d', source_row)";
            rewrite.ExecuteNonQuery();
        }
        using (SqliteCommand pragma = store.Connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA foreign_keys = ON";
            pragma.ExecuteNonQuery();
        }

        for (int index = 0; index < assetCount; index++)
        {
            (string key, _, string? date, _, string? episode) = rows[random.Next(itemCount)];
            string stamp = random.Next(3) switch
            {
                0 => "",
                1 => "_" + (date ?? "2026-09-15"),
                _ => "_" + (date ?? "2026-09-15").Replace("-", "", StringComparison.Ordinal),
            };
            string suffix = random.Next(5) switch { 0 => "_cover", 1 => "_v2", 2 => "_33", 3 => "_Thumb", _ => "" };
            string name = random.Next(3) switch
            {
                0 => $"{key}{suffix}{stamp}",
                1 => $"{key.ToUpperInvariant()}_{episode}{suffix}{stamp}",
                _ => $"{Words[random.Next(Words.Length)]}_{Words[random.Next(Words.Length)]}_{index:D4}{suffix}{stamp}",
            };
            byte[] bytes = BitConverter.GetBytes(index);
            File.WriteAllBytes(Path.Combine(root, name + $"~{index:D4}.png"), bytes);
        }
        store.ScanThumbnails(root, Math.Max(assetCount, 1));

        // Bind every 15th asset to a deterministic item so the bound path is exercised.
        IReadOnlyList<MediaAssetSummary> assets = store.GetAssets();
        IReadOnlyList<CatalogueItemSummary> items = store.GetItems();
        for (int index = 0; index < assets.Count; index += 15)
            store.ConfirmAssetBinding(assets[index].AssetId, items[(index * 7) % items.Count].ItemId);
        return store;
    }

    private static string Serialise(CatalogueStore store, CatalogueView view)
    {
        Dictionary<string, string> names = store.GetAssets(includeUnavailable: true)
            .ToDictionary(asset => asset.AssetId, asset => asset.FileName, StringComparer.Ordinal);
        string Name(string? id) => id is null ? "-" : names[id];
        StringBuilder text = new();
        text.Append("status=").Append(view.InventoryStatus).Append(";count=").Append(view.AvailableThumbnails).Append('\n');
        foreach (CatalogueItemSummary item in view.Items)
            text.Append("I|").Append(item.ItemId).Append('|').Append(item.SourceKey).Append('|').Append(item.Title)
                .Append('|').Append(item.PlannedDate).Append('|').Append(item.Series).Append('|').Append(item.Episode)
                .Append('|').Append(item.ThumbnailStatus).Append('|').Append(Name(item.ThumbnailAssetId)).Append('\n');
        foreach (UnmatchedAssetSummary asset in view.UnmatchedAssets)
        {
            text.Append("U|").Append(asset.FileName).Append('|').Append(asset.Role).Append('\n');
            foreach (CatalogueCandidate candidate in asset.Candidates)
                AppendCandidate(text, candidate, Name);
        }
        foreach (MediaAssetSummary asset in store.GetAssets())
        {
            text.Append("R|").Append(asset.FileName).Append('\n');
            foreach (CatalogueCandidate candidate in CatalogueMatcher.Rank(asset.FileName, view.Items))
                AppendCandidate(text, candidate, Name);
        }
        return text.ToString();
    }

    private static void AppendCandidate(StringBuilder text, CatalogueCandidate candidate, Func<string?, string> name) =>
        text.Append("C|").Append(candidate.ItemId).Append('|').Append(candidate.Title).Append('|')
            .Append(candidate.PlannedDate).Append('|').Append(candidate.Score.ToString(CultureInfo.InvariantCulture))
            .Append('|').Append(name(candidate.ThumbnailAssetId)).Append('\n');

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string Snapshot(IEnumerable<(string Key, string Title, string? Date, string? Series, string? Episode)> rows)
    {
        int row = 10;
        string items = string.Join(",", rows.Select(item =>
            $"{{\"sourceKey\":\"{item.Key}\",\"sourceRow\":{row++},\"title\":\"{item.Title}\",\"description\":\"\","
            + $"\"plannedDate\":{Quote(item.Date)},\"series\":{Quote(item.Series)},\"episode\":{Quote(item.Episode)},"
            + "\"xTeasers\":0,\"redditTeasers\":0,\"platformLinks\":{}}"));
        return $"{{\"version\":1,\"items\":[{items}]}}";
    }

    private static string Quote(string? value) => value is null ? "null" : $"\"{value}\"";

    private sealed class TestDirectory : IDisposable
    {
        public TestDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"ofenhancer-equiv-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
