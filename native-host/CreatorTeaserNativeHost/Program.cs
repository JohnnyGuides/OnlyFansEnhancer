using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;

namespace CreatorTeaserNativeHost;

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
            throw new InvalidOperationException("Invalid configured Done directory name.");
        }
        doneRoot = Path.GetFullPath(Path.Combine(teaserRoot, config.DoneName));
        EnsureInside(teaserRoot, doneRoot, "Done directory");
        if (!Directory.Exists(doneRoot))
            throw new InvalidOperationException("The configured Done directory is missing.");
        RejectReparsePath(doneRoot);
    }

    public HostResponse Handle(HostRequest request)
    {
        return request.Operation switch
        {
            "audit" => Audit(request),
            "move" => Move(request),
            _ => throw new InvalidOperationException("Unsupported native host operation."),
        };
    }

    private HostResponse Audit(HostRequest request)
    {
        FileProof proof = RequireProof(request);
        string source = ResolveOneSource(request.Basename, proof);
        StatusProof status = request.Status
            ?? throw new InvalidOperationException("Audit status metadata is missing.");
        CatalogueProof catalogue = request.Catalogue
            ?? throw new InvalidOperationException("Audit catalogue metadata is missing.");
        ValidateStatus(status);
        if (catalogue.Row < 2 || catalogue.Row > 5000 || !SafeIdPattern.IsMatch(catalogue.Id))
            throw new InvalidOperationException("Invalid audit catalogue row or ID.");
        if (request.Frames is not { Length: 3 })
            throw new InvalidOperationException("Exactly three audit frames are required.");

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
            throw new InvalidOperationException("The configured audit frames directory is missing.");
        RejectReparsePath(framesRoot);
        for (int index = 0; index < frames.Length; index++)
        {
            string target = Path.GetFullPath(Path.Combine(framesRoot, frameNames[index]));
            EnsureInside(framesRoot, target, "Audit frame");
            WriteNewOrVerify(target, frames[index], frameHashes[index]);
        }

        string cataloguePath = AuditFile("catalogue.json");
        string frameDataPath = AuditFile("frame-data.json");
        string templatePath = AuditFile("report-template.html");
        string indexPath = AuditFile("index.html", mustExist: false);
        JsonObject catalogueData = ReadObject(cataloguePath);
        JsonObject frameData = ReadObject(frameDataPath);
        JsonObject catalogueRow = FindCatalogueRow(catalogueData, catalogue.Row, catalogue.Id);
        AppendUrl(catalogueRow, status.StatusUrl);

        JsonArray entries = frameData["entries"]?.AsArray()
            ?? throw new InvalidOperationException("Audit frame-data entries are missing.");
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
                throw new InvalidOperationException("Existing audit entry conflicts with the confirmed catalogue row.");
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
            throw new InvalidOperationException("Audit template must contain one data marker.");
        string frameJson = frameData.ToJsonString(JsonOptions);
        string generatedHtml = template.Replace("__AUDIT_DATA__", frameJson, StringComparison.Ordinal);

        WriteAtomic(cataloguePath, catalogueData.ToJsonString(JsonOptions));
        WriteAtomic(frameDataPath, frameJson);
        WriteAtomic(indexPath, generatedHtml);
        expectedReceipt.AggregateFiles = ["catalogue.json", "frame-data.json", "index.html"];
        expectedReceipt.AuditEntrySha256 = Sha256(
            Encoding.UTF8.GetBytes(auditEntry.ToJsonString(JsonOptions))
        );
        expectedReceipt.Receipt = ReceiptToken(expectedReceipt);
        WriteNewOrVerify(
            receiptPath,
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(expectedReceipt, JsonOptions)),
            Sha256(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(expectedReceipt, JsonOptions)))
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
            throw new InvalidOperationException("Invalid move status ID.");
        string receiptPath = Path.Combine(
            auditRoot,
            ".creator-x-teaser-receipts",
            $"{request.StatusId}.json"
        );
        RejectReparsePath(Path.GetDirectoryName(receiptPath)!);
        if (!File.Exists(receiptPath))
            throw new InvalidOperationException("A durable audit receipt is required before moving.");
        RejectReparsePath(receiptPath);
        ReceiptRecord receipt = ReadReceipt(receiptPath);
        VerifyReceiptToken(receipt);
        if (
            string.IsNullOrWhiteSpace(request.Receipt)
            || receipt.Receipt != request.Receipt
            || receipt.Basename != proof.Basename
            || receipt.FileSha256 != proof.Sha256
        )
            throw new InvalidOperationException("The audit receipt does not match this source file.");
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
            throw new InvalidOperationException("Expected exactly one matching source file.");
        if (File.Exists(destination))
            throw new InvalidOperationException("Done destination collision; nothing was moved.");
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
            ?? throw new InvalidOperationException("Stable file identity is missing.");
        if (
            proof.Basename != request.Basename
            || proof.Size <= 0
            || proof.LastModified <= 0
            || proof.Duration <= 0
            || proof.Duration > 8 * 60 * 60
            || !Regex.IsMatch(proof.Sha256 ?? "", @"^[a-f0-9]{64}$")
        )
            throw new InvalidOperationException("Invalid stable file identity.");
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
            throw new InvalidOperationException("Invalid source basename or path.");
    }

    private string ResolveOneSource(string basename, FileProof proof)
    {
        List<string> candidates = FindSources(basename);
        if (candidates.Count != 1)
            throw new InvalidOperationException("Expected exactly one matching source file.");
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
            throw new InvalidOperationException("Source file identity size mismatch.");
        double modified = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
        if (Math.Abs(modified - proof.LastModified) > 2000)
            throw new InvalidOperationException("Source file identity timestamp mismatch.");
        using FileStream stream = File.OpenRead(path);
        string hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (hash != proof.Sha256)
            throw new InvalidOperationException("Source file identity SHA-256 mismatch.");
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
            throw new InvalidOperationException("Invalid captured X status metadata.");
    }

    private static byte[] ParseJpegDataUrl(string value)
    {
        const string prefix = "data:image/jpeg;base64,";
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal) || value.Length > 7_000_000)
            throw new InvalidOperationException("Invalid bounded JPEG audit frame.");
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(value[prefix.Length..]);
        }
        catch (FormatException error)
        {
            throw new InvalidOperationException("Invalid bounded JPEG audit frame.", error);
        }
        if (
            bytes.Length < 4
            || bytes[0] != 0xff
            || bytes[1] != 0xd8
            || bytes[^2] != 0xff
            || bytes[^1] != 0xd9
        )
            throw new InvalidOperationException("Invalid bounded JPEG audit frame.");
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
            throw new InvalidOperationException("Audit receipt token does not match its durable proof.");
    }

    private void VerifyReceiptFrames(ReceiptRecord receipt)
    {
        if (receipt.FrameFiles.Length != 3 || receipt.FrameSha256.Length != 3)
            throw new InvalidOperationException("Audit receipt frame proof is incomplete.");
        for (int index = 0; index < 3; index++)
        {
            string path = Path.GetFullPath(Path.Combine(auditRoot, receipt.FrameFiles[index]));
            EnsureInside(auditRoot, path, "Receipt frame");
            RejectReparsePath(path);
            if (!File.Exists(path) || Sha256(File.ReadAllBytes(path)) != receipt.FrameSha256[index])
                throw new InvalidOperationException("Audit receipt frame proof does not match disk.");
        }
    }

    private void VerifyReceiptAggregates(ReceiptRecord receipt)
    {
        string[] expectedFiles = ["catalogue.json", "frame-data.json", "index.html"];
        if (!receipt.AggregateFiles.SequenceEqual(expectedFiles) || !Regex.IsMatch(receipt.AuditEntrySha256, "^[a-f0-9]{64}$"))
            throw new InvalidOperationException("Audit receipt aggregate proof is incomplete.");
        string cataloguePath = AuditFile(expectedFiles[0]);
        string frameDataPath = AuditFile(expectedFiles[1]);
        string indexPath = AuditFile(expectedFiles[2]);
        JsonObject catalogueData = ReadObject(cataloguePath);
        JsonObject catalogueRow = FindCatalogueRow(catalogueData, receipt.Row, receipt.CatalogueId);
        string[] urls = catalogueRow["urls"]?.AsArray().Select(value => value?.GetValue<string>() ?? "").ToArray() ?? [];
        if (!urls.Contains(receipt.StatusUrl))
            throw new InvalidOperationException("Audit receipt aggregate catalogue proof does not match disk.");
        JsonArray entries = ReadObject(frameDataPath)["entries"]?.AsArray()
            ?? throw new InvalidOperationException("Audit receipt aggregate entries are missing.");
        JsonObject entry = entries.OfType<JsonObject>().SingleOrDefault(value => StringValue(value, "url") == receipt.StatusUrl)
            ?? throw new InvalidOperationException("Audit receipt aggregate entry does not match disk.");
        if (IntValue(entry, "row") != receipt.Row || StringValue(entry, "id") != receipt.CatalogueId || Sha256(Encoding.UTF8.GetBytes(entry.ToJsonString(JsonOptions))) != receipt.AuditEntrySha256)
            throw new InvalidOperationException("Audit receipt aggregate entry proof does not match disk.");
        string index = File.ReadAllText(indexPath, Encoding.UTF8);
        if (!index.Contains(receipt.StatusUrl, StringComparison.Ordinal) || receipt.FrameFiles.Any(frame => !index.Contains(frame, StringComparison.Ordinal)))
            throw new InvalidOperationException("Audit receipt aggregate index proof does not match disk.");
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
            throw new InvalidOperationException("Existing audit receipt conflicts with this request.");
    }

    private static ReceiptRecord ReadReceipt(string path)
    {
        return JsonSerializer.Deserialize<ReceiptRecord>(File.ReadAllText(path), JsonOptions)
            ?? throw new InvalidOperationException("Invalid audit receipt.");
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
            ?? throw new InvalidOperationException("Audit catalogue rows are missing.");
        return FindRow(rows, row, id);
    }

    private static JsonObject FindRow(JsonArray rows, int row, string id)
    {
        JsonObject[] matches = rows
            .OfType<JsonObject>()
            .Where(item => IntValue(item, "row") == row && StringValue(item, "id") == id)
            .ToArray();
        if (matches.Length != 1)
            throw new InvalidOperationException("The audit catalogue row is missing or ambiguous.");
        return matches[0];
    }

    private static void UpdateSummary(JsonObject frameData)
    {
        JsonArray entries = frameData["entries"]?.AsArray()
            ?? throw new InvalidOperationException("Audit entries are missing.");
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
            throw new InvalidOperationException($"Required audit file is missing: {name}");
        if (File.Exists(path)) RejectReparsePath(path);
        return path;
    }

    private static JsonObject ReadObject(string path)
    {
        return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8))?.AsObject()
            ?? throw new InvalidOperationException($"Invalid JSON file: {Path.GetFileName(path)}");
    }

    private static string StringValue(JsonObject value, string name) =>
        value[name]?.GetValue<string>() ?? "";

    private static int IntValue(JsonObject value, string name) =>
        value[name]?.GetValue<int>() ?? 0;

    private static void WriteAtomic(string path, string value)
    {
        string temp = Path.Combine(
            Path.GetDirectoryName(path)!,
            $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp"
        );
        File.WriteAllText(temp, value, new UTF8Encoding(false));
        File.Move(temp, path, true);
    }

    private static void WriteNewOrVerify(string path, byte[] bytes, string expectedHash)
    {
        if (File.Exists(path))
        {
            RejectReparsePath(path);
            if (Sha256(File.ReadAllBytes(path)) != expectedHash)
                throw new InvalidOperationException("Existing audit artifact collision.");
            return;
        }
        using FileStream output = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        output.Write(bytes);
        output.Flush(true);
    }

    private static string ResolveConfiguredRoot(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
            throw new InvalidOperationException($"The configured {label} root must be absolute.");
        string full = Path.GetFullPath(value);
        if (!Directory.Exists(full))
            throw new InvalidOperationException($"The configured {label} root is missing.");
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
            throw new InvalidOperationException($"{label} escapes its configured root.");
    }

    private static void RejectReparsePath(string path)
    {
        string full = Path.GetFullPath(path);
        string? current = Path.GetPathRoot(full);
        if (current is null) throw new InvalidOperationException("Invalid filesystem path.");
        foreach (string part in full[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            if (File.Exists(current) || Directory.Exists(current)) RejectReparse(current);
        }
    }

    private static void RejectReparse(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Reparse points are not allowed inside configured roots.");
    }

    private static string Sha256(byte[] value) =>
        Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
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
        while (TryReadMessage(input, out string? message))
        {
            HostResponse response = Execute(configPath, message!);
            WriteMessage(output, JsonSerializer.Serialize(response, JsonOptions));
        }
        return 0;
    }

    private static HostResponse Execute(string configPath, string requestJson)
    {
        try
        {
            HostConfig config = JsonSerializer.Deserialize<HostConfig>(
                File.ReadAllText(configPath, Encoding.UTF8),
                JsonOptions
            ) ?? throw new InvalidOperationException("Invalid native host configuration.");
            HostRequest request = JsonSerializer.Deserialize<HostRequest>(requestJson, JsonOptions)
                ?? throw new InvalidOperationException("Invalid native host request.");
            return new TeaserHost(config).Handle(request);
        }
        catch (Exception error)
        {
            return new HostResponse { Ok = false, Error = error.Message };
        }
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
            throw new InvalidOperationException("Native message exceeds the bounded size.");
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
