using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;

namespace CreatorTeaserNativeHost;

// Only authored, static validation text may cross the native message boundary.
internal sealed class HostValidationException(string publicMessage, Exception? inner = null)
    : Exception(publicMessage, inner)
{
    public string PublicMessage { get; } = publicMessage;
}

internal sealed class HostConfig
{
    public string TeaserRoot { get; set; } = "";
    public string AuditRoot { get; set; } = "";
    public string DoneName { get; set; } = "Done";
}

internal sealed class FileProof
{
    public string Basename { get; set; } = "";
    public long Size { get; set; }
    public double LastModified { get; set; }
    public double Duration { get; set; }
    public string Sha256 { get; set; } = "";
}

internal sealed class StatusProof
{
    public string StatusId { get; set; } = "";
    public string StatusUrl { get; set; } = "";
    public string Caption { get; set; } = "";
    public string Timestamp { get; set; } = "";
    public double Duration { get; set; }
    public string Poster { get; set; } = "";
}

internal sealed class CatalogueProof
{
    public int Row { get; set; }
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
}

internal sealed class HostRequest
{
    public string Operation { get; set; } = "";
    public string Basename { get; set; } = "";
    public FileProof? FileProof { get; set; }
    public StatusProof? Status { get; set; }
    public CatalogueProof? Catalogue { get; set; }
    public string[]? Frames { get; set; }
    public string StatusId { get; set; } = "";
    public string Receipt { get; set; } = "";
}

internal sealed class HostResponse
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? StatusId { get; set; }
    public string? AuditOutcome { get; set; }
    public string? MoveOutcome { get; set; }
    public string? Receipt { get; set; }
}

internal sealed class ReceiptRecord
{
    public string Receipt { get; set; } = "";
    public string StatusId { get; set; } = "";
    public string StatusUrl { get; set; } = "";
    public string Basename { get; set; } = "";
    public string FileSha256 { get; set; } = "";
    public int Row { get; set; }
    public string CatalogueId { get; set; } = "";
    public string[] FrameFiles { get; set; } = [];
    public string[] FrameSha256 { get; set; } = [];
    public string[] AggregateFiles { get; set; } = [];
    public string AuditEntrySha256 { get; set; } = "";
}

internal sealed class TeaserHost
{
    private static readonly Regex StatusPattern = new(
        @"^https://x\.com/([A-Za-z0-9_]{1,15})/status/(\d{1,30})$",
        RegexOptions.CultureInvariant
    );
    private static readonly Regex SafeIdPattern = new(
        @"^[A-Za-z0-9_-]{1,100}$",
        RegexOptions.CultureInvariant
    );
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
        WriteIndented = true,
    };

    private readonly string teaserRoot;
    private readonly string auditRoot;
    private readonly string doneRoot;

    public TeaserHost(HostConfig config)
    {
        teaserRoot = ResolveConfiguredRoot(config.TeaserRoot, "teaser");
        auditRoot = ResolveConfiguredRoot(config.AuditRoot, "audit");
        if (
            string.IsNullOrWhiteSpace(config.DoneName)
            || Path.IsPathRooted(config.DoneName)
            || config.DoneName != Path.GetFileName(config.DoneName)
            || config.DoneName is "." or ".."
        )
        {
            throw new HostValidationException("Invalid configured Done directory name.");
        }
        doneRoot = Path.GetFullPath(Path.Combine(teaserRoot, config.DoneName));
        EnsureInside(teaserRoot, doneRoot, "Done directory");
        if (!Directory.Exists(doneRoot))
            throw new HostValidationException("The configured Done directory is missing.");
        RejectReparsePath(doneRoot);
    }

    public HostResponse Handle(HostRequest request)
    {
        if (request.Operation is not ("audit" or "move"))
            throw new HostValidationException("Unsupported native host operation.");
        using AuditRootLock owner = AuditRootLock.Acquire(auditRoot, TestHooks.LockTimeoutMs());
        RemoveStagingLeftovers();
        return request.Operation == "audit" ? Audit(request) : Move(request);
    }

    // Only names the host itself stages (".<name>.<guid>.ofe-audit.tmp") are removed.
    private void RemoveStagingLeftovers()
    {
        string[] directories =
        [
            auditRoot,
            Path.Combine(auditRoot, "frames"),
            Path.Combine(auditRoot, ".creator-x-teaser-receipts"),
        ];
        foreach (string directory in directories)
        {
            if (!Directory.Exists(directory)) continue;
            RejectReparsePath(directory);
            foreach (string file in Directory.EnumerateFiles(directory, "*" + StagingSuffix))
            {
                if (!Path.GetFileName(file).StartsWith('.')) continue;
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) continue;
                File.Delete(file);
            }
        }
    }

    private HostResponse Audit(HostRequest request)
    {
        FileProof proof = RequireProof(request);
        string source = ResolveOneSource(request.Basename, proof);
        StatusProof status = request.Status
            ?? throw new HostValidationException("Audit status metadata is missing.");
        CatalogueProof catalogue = request.Catalogue
            ?? throw new HostValidationException("Audit catalogue metadata is missing.");
        ValidateStatus(status);
        if (catalogue.Row < 2 || catalogue.Row > 5002 || !SafeIdPattern.IsMatch(catalogue.Id))
            throw new HostValidationException("Invalid audit catalogue row or ID.");
        if (request.Frames is not { Length: 3 })
            throw new HostValidationException("Exactly three audit frames are required.");

        byte[][] frames = request.Frames.Select(ParseJpegDataUrl).ToArray();
        string[] frameHashes = frames.Select(Sha256).ToArray();
        string[] frameNames = Enumerable.Range(1, 3)
            .Select(index => $"{catalogue.Id}-{status.StatusId}-f{index}.jpg")
            .ToArray();
        string[] frameRelative = frameNames.Select(name => $"frames/{name}").ToArray();
        string receiptDirectory = Path.Combine(auditRoot, ".creator-x-teaser-receipts");
        Directory.CreateDirectory(receiptDirectory);
        RejectReparsePath(receiptDirectory);
        string receiptPath = Path.Combine(receiptDirectory, $"{status.StatusId}.json");
        ReceiptRecord expectedReceipt = CreateReceipt(
            proof,
            status,
            catalogue,
            frameRelative,
            frameHashes
        );
        if (File.Exists(receiptPath))
        {
            RejectReparsePath(receiptPath);
            ReceiptRecord existing = ReadReceipt(receiptPath);
            VerifyReceiptToken(existing);
            RequireMatchingReceipt(existing, expectedReceipt);
            VerifyReceiptFrames(existing);
            VerifyReceiptAggregates(existing);
            return new HostResponse
            {
                Ok = true,
                StatusId = status.StatusId,
                AuditOutcome = "idempotent",
                Receipt = existing.Receipt,
            };
        }

        string framesRoot = Path.Combine(auditRoot, "frames");
        if (!Directory.Exists(framesRoot))
            throw new HostValidationException("The configured audit frames directory is missing.");
        RejectReparsePath(framesRoot);
        for (int index = 0; index < frames.Length; index++)
        {
            string target = Path.GetFullPath(Path.Combine(framesRoot, frameNames[index]));
            EnsureInside(framesRoot, target, "Audit frame");
            WriteNewOrVerify(target, frames[index], frameHashes[index], $"frame-{index + 1}");
            TestHooks.At($"after-frame-{index + 1}");
        }

        string cataloguePath = AuditFile("catalogue.json");
        string frameDataPath = AuditFile("frame-data.json");
        string templatePath = AuditFile("report-template.html");
        string indexPath = AuditFile("index.html", mustExist: false);
        JsonObject catalogueData = ReadObject(cataloguePath);
        JsonObject frameData = ReadObject(frameDataPath);
        TestHooks.PauseHoldingLock();
        JsonObject catalogueRow = FindCatalogueRow(catalogueData, catalogue.Row, catalogue.Id);
        AppendUrl(catalogueRow, status.StatusUrl);

        JsonArray entries = frameData["entries"]?.AsArray()
            ?? throw new HostValidationException("Audit frame-data entries are missing.");
        JsonObject? existingEntry = entries
            .OfType<JsonObject>()
            .SingleOrDefault(entry => StringValue(entry, "url") == status.StatusUrl);
        JsonObject auditEntry;
        if (existingEntry is not null)
        {
            if (
                IntValue(existingEntry, "row") != catalogue.Row
                || StringValue(existingEntry, "id") != catalogue.Id
            )
                throw new HostValidationException("Existing audit entry conflicts with the confirmed catalogue row.");
            auditEntry = existingEntry;
        }
        else
        {
            auditEntry = BuildAuditEntry(catalogueRow, status, frameRelative);
            entries.Add(auditEntry);
        }

        if (frameData["catalogue"] is JsonArray frameCatalogue)
        {
            JsonObject frameCatalogueRow = FindRow(frameCatalogue, catalogue.Row, catalogue.Id);
            AppendUrl(frameCatalogueRow, status.StatusUrl);
        }
        UpdateSummary(frameData);
        string template = File.ReadAllText(templatePath, Encoding.UTF8);
        if (template.Split("__AUDIT_DATA__").Length != 2)
            throw new HostValidationException("Audit template must contain one data marker.");
        string frameJson = frameData.ToJsonString(JsonOptions);
        string generatedHtml = template.Replace("__AUDIT_DATA__", frameJson, StringComparison.Ordinal);

        WriteAtomic(cataloguePath, catalogueData.ToJsonString(JsonOptions));
        TestHooks.At("after-catalogue");
        WriteAtomic(frameDataPath, frameJson);
        TestHooks.At("after-frame-data");
        WriteAtomic(indexPath, generatedHtml);
        TestHooks.At("before-receipt");
        expectedReceipt.AggregateFiles = ["catalogue.json", "frame-data.json", "index.html"];
        expectedReceipt.AuditEntrySha256 = Sha256(
            Encoding.UTF8.GetBytes(auditEntry.ToJsonString(JsonOptions))
        );
        expectedReceipt.Receipt = ReceiptToken(expectedReceipt);
        WriteNewOrVerify(
            receiptPath,
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(expectedReceipt, JsonOptions)),
            Sha256(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(expectedReceipt, JsonOptions))),
            "receipt"
        );
        _ = source;
        return new HostResponse
        {
            Ok = true,
            StatusId = status.StatusId,
            AuditOutcome = "updated",
            Receipt = expectedReceipt.Receipt,
        };
    }

    private HostResponse Move(HostRequest request)
    {
        FileProof proof = RequireProof(request);
        if (!Regex.IsMatch(request.StatusId ?? "", @"^\d{1,30}$"))
            throw new HostValidationException("Invalid move status ID.");
        string receiptPath = Path.Combine(
            auditRoot,
            ".creator-x-teaser-receipts",
            $"{request.StatusId}.json"
        );
        RejectReparsePath(Path.GetDirectoryName(receiptPath)!);
        if (!File.Exists(receiptPath))
            throw new HostValidationException("A durable audit receipt is required before moving.");
        RejectReparsePath(receiptPath);
        ReceiptRecord receipt = ReadReceipt(receiptPath);
        VerifyReceiptToken(receipt);
        if (
            string.IsNullOrWhiteSpace(request.Receipt)
            || receipt.Receipt != request.Receipt
            || receipt.Basename != proof.Basename
            || receipt.FileSha256 != proof.Sha256
        )
            throw new HostValidationException("The audit receipt does not match this source file.");
        VerifyReceiptFrames(receipt);
        VerifyReceiptAggregates(receipt);

        string destination = Path.GetFullPath(Path.Combine(doneRoot, proof.Basename));
        EnsureInside(doneRoot, destination, "Done destination");
        List<string> sources = FindSources(proof.Basename);
        if (sources.Count == 0 && File.Exists(destination))
        {
            VerifyIdentity(destination, proof);
            return new HostResponse
            {
                Ok = true,
                StatusId = request.StatusId,
                MoveOutcome = "idempotent",
                Receipt = receipt.Receipt,
            };
        }
        if (sources.Count != 1)
            throw new HostValidationException("Expected exactly one matching source file.");
        if (File.Exists(destination))
            throw new HostValidationException("Done destination collision; nothing was moved.");
        VerifyIdentity(sources[0], proof);
        File.Move(sources[0], destination);
        return new HostResponse
        {
            Ok = true,
            StatusId = request.StatusId,
            MoveOutcome = "moved",
            Receipt = receipt.Receipt,
        };
    }

    private FileProof RequireProof(HostRequest request)
    {
        ValidateBasename(request.Basename);
        FileProof proof = request.FileProof
            ?? throw new HostValidationException("Stable file identity is missing.");
        if (
            proof.Basename != request.Basename
            || proof.Size <= 0
            || proof.LastModified <= 0
            || proof.Duration <= 0
            || proof.Duration > 8 * 60 * 60
            || !Regex.IsMatch(proof.Sha256 ?? "", @"^[a-f0-9]{64}$")
        )
            throw new HostValidationException("Invalid stable file identity.");
        return proof;
    }

    private static void ValidateBasename(string basename)
    {
        if (
            string.IsNullOrWhiteSpace(basename)
            || basename.Length > 255
            || Path.IsPathRooted(basename)
            || basename != Path.GetFileName(basename)
            || basename.Contains('/')
            || basename.Contains('\\')
            || basename is "." or ".."
        )
            throw new HostValidationException("Invalid source basename or path.");
    }

    private string ResolveOneSource(string basename, FileProof proof)
    {
        List<string> candidates = FindSources(basename);
        if (candidates.Count != 1)
            throw new HostValidationException("Expected exactly one matching source file.");
        VerifyIdentity(candidates[0], proof);
        return candidates[0];
    }

    private List<string> FindSources(string basename)
    {
        ValidateBasename(basename);
        List<string> matches = [];
        Stack<string> pending = new();
        pending.Push(teaserRoot);
        while (pending.Count > 0)
        {
            string directory = pending.Pop();
            RejectReparsePath(directory);
            foreach (string file in Directory.EnumerateFiles(directory))
            {
                RejectReparse(file);
                string full = Path.GetFullPath(file);
                EnsureInside(teaserRoot, full, "Source file");
                if (string.Equals(Path.GetFileName(full), basename, StringComparison.OrdinalIgnoreCase))
                    matches.Add(full);
            }
            foreach (string child in Directory.EnumerateDirectories(directory))
            {
                string full = Path.GetFullPath(child);
                EnsureInside(teaserRoot, full, "Source directory");
                if (string.Equals(full, doneRoot, StringComparison.OrdinalIgnoreCase))
                    continue;
                RejectReparse(full);
                pending.Push(full);
            }
        }
        return matches;
    }

    private static void VerifyIdentity(string path, FileProof proof)
    {
        RejectReparsePath(path);
        FileInfo info = new(path);
        if (!info.Exists || info.Length != proof.Size)
            throw new HostValidationException("Source file identity size mismatch.");
        double modified = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
        if (Math.Abs(modified - proof.LastModified) > 2000)
            throw new HostValidationException("Source file identity timestamp mismatch.");
        using FileStream stream = File.OpenRead(path);
        string hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (hash != proof.Sha256)
            throw new HostValidationException("Source file identity SHA-256 mismatch.");
    }

    private static void ValidateStatus(StatusProof status)
    {
        Match match = StatusPattern.Match(status.StatusUrl ?? "");
        if (
            !match.Success
            || match.Groups[1].Value.Equals("i", StringComparison.OrdinalIgnoreCase)
            || match.Groups[2].Value != status.StatusId
            || !DateTimeOffset.TryParse(status.Timestamp, out _)
            || status.Duration <= 0
            || status.Duration > 8 * 60 * 60
            || !Uri.TryCreate(status.Poster, UriKind.Absolute, out Uri? poster)
            || poster.Scheme != Uri.UriSchemeHttps
            || !(poster.Host == "pbs.twimg.com" || poster.Host.EndsWith(".twimg.com"))
        )
            throw new HostValidationException("Invalid captured X status metadata.");
    }

    private static byte[] ParseJpegDataUrl(string value)
    {
        const string prefix = "data:image/jpeg;base64,";
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal) || value.Length > 7_000_000)
            throw new HostValidationException("Invalid bounded JPEG audit frame.");
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(value[prefix.Length..]);
        }
        catch (FormatException error)
        {
            throw new HostValidationException("Invalid bounded JPEG audit frame.", error);
        }
        if (
            bytes.Length < 4
            || bytes[0] != 0xff
            || bytes[1] != 0xd8
            || bytes[^2] != 0xff
            || bytes[^1] != 0xd9
        )
            throw new HostValidationException("Invalid bounded JPEG audit frame.");
        return bytes;
    }

    private ReceiptRecord CreateReceipt(
        FileProof proof,
        StatusProof status,
        CatalogueProof catalogue,
        string[] frameFiles,
        string[] frameHashes
    )
    {
        return new ReceiptRecord
        {
            Receipt = "",
            StatusId = status.StatusId,
            StatusUrl = status.StatusUrl,
            Basename = proof.Basename,
            FileSha256 = proof.Sha256,
            Row = catalogue.Row,
            CatalogueId = catalogue.Id,
            FrameFiles = frameFiles,
            FrameSha256 = frameHashes,
        };
    }

    private static string ReceiptToken(ReceiptRecord receipt) =>
        Sha256(
            Encoding.UTF8.GetBytes(
                string.Join(
                    "\u001f",
                    receipt.StatusId,
                    receipt.StatusUrl,
                    receipt.Basename,
                    receipt.FileSha256,
                    receipt.Row,
                    receipt.CatalogueId,
                    string.Join(",", receipt.FrameFiles),
                    string.Join(",", receipt.FrameSha256),
                    string.Join(",", receipt.AggregateFiles),
                    receipt.AuditEntrySha256
                )
            )
        );

    private static void VerifyReceiptToken(ReceiptRecord receipt)
    {
        if (receipt.Receipt != ReceiptToken(receipt))
            throw new HostValidationException("Audit receipt token does not match its durable proof.");
    }

    private void VerifyReceiptFrames(ReceiptRecord receipt)
    {
        if (receipt.FrameFiles.Length != 3 || receipt.FrameSha256.Length != 3)
            throw new HostValidationException("Audit receipt frame proof is incomplete.");
        for (int index = 0; index < 3; index++)
        {
            string path = Path.GetFullPath(Path.Combine(auditRoot, receipt.FrameFiles[index]));
            EnsureInside(auditRoot, path, "Receipt frame");
            RejectReparsePath(path);
            if (!File.Exists(path) || Sha256(File.ReadAllBytes(path)) != receipt.FrameSha256[index])
                throw new HostValidationException("Audit receipt frame proof does not match disk.");
        }
    }

    private void VerifyReceiptAggregates(ReceiptRecord receipt)
    {
        string[] expectedFiles = ["catalogue.json", "frame-data.json", "index.html"];
        if (!receipt.AggregateFiles.SequenceEqual(expectedFiles) || !Regex.IsMatch(receipt.AuditEntrySha256, "^[a-f0-9]{64}$"))
            throw new HostValidationException("Audit receipt aggregate proof is incomplete.");
        string cataloguePath = AuditFile(expectedFiles[0]);
        string frameDataPath = AuditFile(expectedFiles[1]);
        string indexPath = AuditFile(expectedFiles[2]);
        JsonObject catalogueData = ReadObject(cataloguePath);
        JsonObject catalogueRow = FindCatalogueRow(catalogueData, receipt.Row, receipt.CatalogueId);
        string[] urls = catalogueRow["urls"]?.AsArray().Select(value => value?.GetValue<string>() ?? "").ToArray() ?? [];
        if (!urls.Contains(receipt.StatusUrl))
            throw new HostValidationException("Audit receipt aggregate catalogue proof does not match disk.");
        JsonArray entries = ReadObject(frameDataPath)["entries"]?.AsArray()
            ?? throw new HostValidationException("Audit receipt aggregate entries are missing.");
        JsonObject entry = entries.OfType<JsonObject>().SingleOrDefault(value => StringValue(value, "url") == receipt.StatusUrl)
            ?? throw new HostValidationException("Audit receipt aggregate entry does not match disk.");
        if (IntValue(entry, "row") != receipt.Row || StringValue(entry, "id") != receipt.CatalogueId || Sha256(Encoding.UTF8.GetBytes(entry.ToJsonString(JsonOptions))) != receipt.AuditEntrySha256)
            throw new HostValidationException("Audit receipt aggregate entry proof does not match disk.");
        string index = File.ReadAllText(indexPath, Encoding.UTF8);
        if (!index.Contains(receipt.StatusUrl, StringComparison.Ordinal) || receipt.FrameFiles.Any(frame => !index.Contains(frame, StringComparison.Ordinal)))
            throw new HostValidationException("Audit receipt aggregate index proof does not match disk.");
    }

    private static void RequireMatchingReceipt(ReceiptRecord left, ReceiptRecord right)
    {
        if (
            left.StatusId != right.StatusId
            || left.StatusUrl != right.StatusUrl
            || left.Basename != right.Basename
            || left.FileSha256 != right.FileSha256
            || left.Row != right.Row
            || left.CatalogueId != right.CatalogueId
            || !left.FrameFiles.SequenceEqual(right.FrameFiles)
            || !left.FrameSha256.SequenceEqual(right.FrameSha256)
        )
            throw new HostValidationException("Existing audit receipt conflicts with this request.");
    }

    private static ReceiptRecord ReadReceipt(string path)
    {
        return JsonSerializer.Deserialize<ReceiptRecord>(File.ReadAllText(path), JsonOptions)
            ?? throw new HostValidationException("Invalid audit receipt.");
    }

    private static JsonObject BuildAuditEntry(
        JsonObject row,
        StatusProof status,
        string[] frameRelative
    )
    {
        JsonArray frames = [];
        foreach (string file in frameRelative)
            frames.Add(new JsonObject { ["file"] = file });
        return new JsonObject
        {
            ["url"] = status.StatusUrl,
            ["kind"] = "catalogue",
            ["row"] = IntValue(row, "row"),
            ["id"] = StringValue(row, "id"),
            ["title"] = StringValue(row, "title"),
            ["desc"] = StringValue(row, "description"),
            ["arc"] = StringValue(row, "arc"),
            ["category"] = StringValue(row, "category"),
            ["releaseDate"] = StringValue(row, "releaseDate"),
            ["onlyfans"] = StringValue(row, "onlyfans"),
            ["fansly"] = StringValue(row, "fansly"),
            ["manyvids"] = StringValue(row, "manyvids"),
            ["pornhub"] = StringValue(row, "pornhub"),
            ["frames"] = frames,
            ["poster"] = status.Poster,
            ["duration"] = status.Duration,
            ["video"] = true,
            ["caption"] = status.Caption,
            ["timestamp"] = status.Timestamp,
            ["tweetText"] = status.Caption,
            ["contextLinks"] = new JsonArray(),
            ["verdict"] = "matched",
            ["note"] = "",
            ["suggestedRow"] = null,
            ["suggestedId"] = null,
        };
    }

    private static void AppendUrl(JsonObject row, string statusUrl)
    {
        JsonArray urls = row["urls"] as JsonArray ?? [];
        if (row["urls"] is null) row["urls"] = urls;
        if (!urls.Any(item => item?.GetValue<string>() == statusUrl))
            urls.Add(statusUrl);
        row["teaserCount"] = urls.Count.ToString();
    }

    private static JsonObject FindCatalogueRow(JsonObject root, int row, string id)
    {
        JsonArray rows = root["rows"]?.AsArray()
            ?? throw new HostValidationException("Audit catalogue rows are missing.");
        return FindRow(rows, row, id);
    }

    private static JsonObject FindRow(JsonArray rows, int row, string id)
    {
        JsonObject[] matches = rows
            .OfType<JsonObject>()
            .Where(item => IntValue(item, "row") == row && StringValue(item, "id") == id)
            .ToArray();
        if (matches.Length != 1)
            throw new HostValidationException("The audit catalogue row is missing or ambiguous.");
        return matches[0];
    }

    private static void UpdateSummary(JsonObject frameData)
    {
        JsonArray entries = frameData["entries"]?.AsArray()
            ?? throw new HostValidationException("Audit entries are missing.");
        JsonObject summary = frameData["summary"]?.AsObject() ?? new JsonObject();
        frameData["summary"] = summary;
        int complete = entries.OfType<JsonObject>().Count(entry => entry["frames"]?.AsArray().Count == 3);
        int partial = entries.OfType<JsonObject>().Count(entry =>
        {
            int count = entry["frames"]?.AsArray().Count ?? 0;
            return count > 0 && count < 3;
        });
        HashSet<string> urls = entries
            .OfType<JsonObject>()
            .Select(entry => StringValue(entry, "url"))
            .Where(value => value.Length > 0)
            .ToHashSet(StringComparer.Ordinal);
        summary["catalogueLinks"] = entries.OfType<JsonObject>().Count(entry => StringValue(entry, "kind") == "catalogue");
        summary["uniqueCatalogueLinks"] = urls.Count;
        summary["liveCatalogueLinks"] = urls.Count;
        summary["completeFrameEntries"] = complete;
        summary["partialFrameEntries"] = partial;
    }

    private string AuditFile(string name, bool mustExist = true)
    {
        string path = Path.GetFullPath(Path.Combine(auditRoot, name));
        EnsureInside(auditRoot, path, "Audit file");
        if (mustExist && !File.Exists(path))
            throw new HostValidationException("Required audit file is missing.");
        if (File.Exists(path)) RejectReparsePath(path);
        return path;
    }

    private static JsonObject ReadObject(string path)
    {
        return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8))?.AsObject()
            ?? throw new HostValidationException("Invalid audit JSON file.");
    }

    private static string StringValue(JsonObject value, string name) =>
        value[name]?.GetValue<string>() ?? "";

    private static int IntValue(JsonObject value, string name) =>
        value[name]?.GetValue<int>() ?? 0;

    private const string StagingSuffix = ".ofe-audit.tmp";

    private static string StagingPath(string path) =>
        Path.Combine(
            Path.GetDirectoryName(path)!,
            $".{Path.GetFileName(path)}.{Guid.NewGuid():N}{StagingSuffix}"
        );

    private static void WriteAtomic(string path, string value)
    {
        string temp = StagingPath(path);
        try
        {
            File.WriteAllText(temp, value, new UTF8Encoding(false));
            File.Move(temp, path, true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    // A new artifact is staged beside its final name, verified, then published without overwrite.
    private static void WriteNewOrVerify(string path, byte[] bytes, string expectedHash, string label)
    {
        if (File.Exists(path))
        {
            RejectReparsePath(path);
            if (Sha256(File.ReadAllBytes(path)) != expectedHash)
                throw new HostValidationException("Existing audit artifact collision.");
            return;
        }
        string temp = StagingPath(path);
        try
        {
            using (FileStream output = new(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                int half = bytes.Length / 2;
                output.Write(bytes, 0, half);
                output.Flush(true);
                TestHooks.At($"mid-write-{label}");
                output.Write(bytes, half, bytes.Length - half);
                output.Flush(true);
            }
            TestHooks.At($"staged-{label}");
            if (Sha256(File.ReadAllBytes(temp)) != expectedHash)
                throw new HostValidationException("Staged audit artifact failed verification.");
            File.Move(temp, path, false);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static string ResolveConfiguredRoot(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
            throw new HostValidationException("The configured root must be absolute.");
        string full = Path.GetFullPath(value);
        if (!Directory.Exists(full))
            throw new HostValidationException("The configured root is missing.");
        RejectReparsePath(full);
        return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void EnsureInside(string root, string candidate, string label)
    {
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (
            !candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(candidate, root, StringComparison.OrdinalIgnoreCase)
        )
            throw new HostValidationException("Path escapes its configured root.");
    }

    private static void RejectReparsePath(string path)
    {
        string full = Path.GetFullPath(path);
        string? current = Path.GetPathRoot(full);
        if (current is null) throw new HostValidationException("Invalid filesystem path.");
        foreach (string part in full[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            if (File.Exists(current) || Directory.Exists(current)) RejectReparse(current);
        }
    }

    private static void RejectReparse(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new HostValidationException("Reparse points are not allowed inside configured roots.");
    }

    private static string Sha256(byte[] value) =>
        Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
}

// One owner per canonical audit root across host processes (Chrome starts one per message).
internal sealed class AuditRootLock : IDisposable
{
    private readonly Mutex mutex;

    private AuditRootLock(Mutex mutex) => this.mutex = mutex;

    public static AuditRootLock Acquire(string root, int timeoutMs)
    {
        string canonical = Path.GetFullPath(root).ToLowerInvariant();
        string name = "Local\\OFEnhancer-XTeaserAudit-"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)))[..32];
        Mutex mutex = new(false, name);
        bool held;
        try
        {
            held = mutex.WaitOne(timeoutMs);
        }
        catch (AbandonedMutexException)
        {
            held = true;
        }
        if (!held)
        {
            mutex.Dispose();
            throw new HostValidationException("The audit root is busy; another native host operation holds it.");
        }
        return new AuditRootLock(mutex);
    }

    public void Dispose()
    {
        mutex.ReleaseMutex();
        mutex.Dispose();
    }
}

// Test-only fault injection. Honoured only when OFENHANCER_TEST_FAULT_DIR names an existing
// directory under the system temp path; otherwise every hook is inert.
//   OFENHANCER_TEST_FAULT           exit(87) at the named point
//   OFENHANCER_TEST_PAUSE_MS        sleep inside the critical section (writes a .marker file)
//   OFENHANCER_TEST_LOCK_TIMEOUT_MS shorten the lock acquisition bound
internal static class TestHooks
{
    private const int DefaultLockTimeoutMs = 10_000;
    private static readonly string? FaultDirectory = ResolveDirectory();

    private static string? ResolveDirectory()
    {
        string? value = Environment.GetEnvironmentVariable("OFENHANCER_TEST_FAULT_DIR");
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value)) return null;
        char separator = Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(value).TrimEnd(separator);
        string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(separator);
        if (!Directory.Exists(full)) return null;
        return full.StartsWith(temp + separator, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    private static int? IntSetting(string name) =>
        FaultDirectory is not null && int.TryParse(Environment.GetEnvironmentVariable(name), out int value)
            ? value
            : null;

    public static int LockTimeoutMs() =>
        IntSetting("OFENHANCER_TEST_LOCK_TIMEOUT_MS") ?? DefaultLockTimeoutMs;

    public static void At(string point)
    {
        if (FaultDirectory is null) return;
        if (Environment.GetEnvironmentVariable("OFENHANCER_TEST_FAULT") == point)
            Environment.Exit(87);
    }

    public static void PauseHoldingLock()
    {
        int? pause = IntSetting("OFENHANCER_TEST_PAUSE_MS");
        if (pause is null) return;
        File.WriteAllText(Path.Combine(FaultDirectory!, $"paused-{Environment.ProcessId}.marker"), "");
        Thread.Sleep(pause.Value);
    }
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--request")
        {
            HostResponse response = Execute(args[1], File.ReadAllText(args[2], Encoding.UTF8));
            Console.Out.Write(JsonSerializer.Serialize(response, JsonOptions));
            return response.Ok ? 0 : 1;
        }

        string configPath = Path.Combine(AppContext.BaseDirectory, "config.json");
        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();
        while (true)
        {
            string? message;
            try
            {
                if (!TryReadMessage(input, out message)) return 0;
            }
            catch (Exception error)
            {
                // Framing is lost after a bad prefix, so answer once and stop cleanly.
                WriteMessage(output, JsonSerializer.Serialize(ErrorResponse(error), JsonOptions));
                return 1;
            }
            HostResponse response = Execute(configPath, message!);
            WriteMessage(output, JsonSerializer.Serialize(response, JsonOptions));
        }
    }

    private static HostResponse Execute(string configPath, string requestJson)
    {
        try
        {
            HostConfig config = JsonSerializer.Deserialize<HostConfig>(
                File.ReadAllText(configPath, Encoding.UTF8),
                JsonOptions
            ) ?? throw new HostValidationException("Invalid native host configuration.");
            HostRequest request = JsonSerializer.Deserialize<HostRequest>(requestJson, JsonOptions)
                ?? throw new HostValidationException("Invalid native host request.");
            return new TeaserHost(config).Handle(request);
        }
        catch (Exception error)
        {
            return ErrorResponse(error);
        }
    }

    private static HostResponse ErrorResponse(Exception error)
    {
        return new HostResponse
        {
            Ok = false,
            Error = error switch
            {
                HostValidationException validation => validation.PublicMessage,
                IOException => "native-filesystem-failure",
                UnauthorizedAccessException => "native-access-denied",
                JsonException => "native-invalid-json",
                _ => "native-operation-failed",
            },
        };
    }

    private static bool TryReadMessage(Stream input, out string? message)
    {
        message = null;
        Span<byte> lengthBytes = stackalloc byte[4];
        int first = input.ReadByte();
        if (first < 0) return false;
        lengthBytes[0] = (byte)first;
        ReadExact(input, lengthBytes[1..]);
        int length = BitConverter.ToInt32(lengthBytes);
        if (length <= 0 || length > 20_000_000)
            throw new HostValidationException("Native message exceeds the bounded size.");
        byte[] bytes = new byte[length];
        ReadExact(input, bytes);
        message = Encoding.UTF8.GetString(bytes);
        return true;
    }

    private static void WriteMessage(Stream output, string message)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(message);
        output.Write(BitConverter.GetBytes(bytes.Length));
        output.Write(bytes);
        output.Flush();
    }

    private static void ReadExact(Stream input, Span<byte> buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = input.Read(buffer[offset..]);
            if (read <= 0) throw new EndOfStreamException("Native message ended early.");
            offset += read;
        }
    }

    private static void ReadExact(Stream input, byte[] buffer) => ReadExact(input, buffer.AsSpan());
}
