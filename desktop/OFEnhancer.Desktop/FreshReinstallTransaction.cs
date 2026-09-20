using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OFEnhancer.Desktop;

internal enum FreshReinstallPhase
{
    Preflight,
    ExtensionRemovalPending,
    ExtensionRemovalVerified,
    PreviousPackageRemoved,
    OwnedStatePurged,
    CleanPackageInstalled,
    ChromeSetupPending,
    Complete,
}

internal sealed class FreshReinstallTransaction
{
    private sealed record Journal(
        int Schema,
        string Generation,
        long StartedAt,
        string PackageVersion,
        string Phase,
        string InstallRoot,
        string DataRoot,
        string WebViewRoot,
        bool DataRootExclusive,
        bool WebViewRootExclusive,
        string[] ExtensionIds,
        string[] Observations
    );

    private const int MaximumBytes = 64 * 1024;
    private static readonly Regex VersionPattern = new("^[0-9]+\\.[0-9]+\\.[0-9]+$", RegexOptions.CultureInvariant);
    private readonly string path;
    private Journal journal;

    private FreshReinstallTransaction(string path, Journal journal)
    {
        this.path = Path.GetFullPath(path);
        this.journal = journal;
    }

    internal FreshReinstallPhase Phase => Enum.Parse<FreshReinstallPhase>(journal.Phase, false);
    internal string Generation => journal.Generation;
    internal long StartedAt => journal.StartedAt;
    internal string PackageVersion => journal.PackageVersion;
    internal string InstallRoot => journal.InstallRoot;
    internal string DataRoot => journal.DataRoot;
    internal string WebViewRoot => journal.WebViewRoot;
    internal IReadOnlyList<string> ExtensionIds => journal.ExtensionIds;
    internal string TransactionDirectory => Path.GetDirectoryName(path)!;

    internal static FreshReinstallTransaction Create(
        string path,
        string packageVersion,
        string installRoot,
        string dataRoot,
        string webViewRoot,
        IEnumerable<string> extensionIds,
        bool dataRootExclusive = true,
        bool webViewRootExclusive = true
    )
    {
        string transactionPath = Path.GetFullPath(path);
        string transactionRoot = Path.GetDirectoryName(transactionPath)
            ?? throw new InvalidOperationException("The Fresh reinstall transaction path is invalid.");
        string install = ValidateRoot(installRoot, "installation");
        string data = ValidateRoot(dataRoot, "data");
        string webView = ValidateRoot(webViewRoot, "WebView2");
        ValidateSeparate(transactionRoot, install, "installation");
        ValidateSeparate(transactionRoot, data, "data");
        ValidateSeparate(transactionRoot, webView, "WebView2");
        if (!VersionPattern.IsMatch(packageVersion))
            throw new InvalidOperationException("The Fresh reinstall package version is invalid.");
        string[] identities = extensionIds
            .Select(AppConfiguration.NormalizeExtensionId)
            .Where(value => value is not null)
            .Cast<string>()
            .Distinct(StringComparer.Ordinal)
            .Take(16)
            .ToArray();
        if (identities.Length == 0)
            throw new InvalidOperationException("Fresh reinstall has no verified Chrome extension identity.");
        var value = new Journal(
            1,
            Guid.NewGuid().ToString(),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            packageVersion,
            FreshReinstallPhase.Preflight.ToString(),
            install,
            data,
            webView,
            dataRootExclusive,
            webViewRootExclusive,
            identities,
            []
        );
        var transaction = new FreshReinstallTransaction(transactionPath, value);
        transaction.Save(value);
        return transaction;
    }

    internal static FreshReinstallTransaction Load(string path)
    {
        try
        {
            string fullPath = Path.GetFullPath(path);
            FileInfo info = new(fullPath);
            if (!info.Exists || info.Length is <= 0 or > MaximumBytes)
                throw new InvalidOperationException();
            Journal? value = JsonSerializer.Deserialize<Journal>(ReadUtf8(fullPath));
            if (value is null || value.Schema != 1 || !Guid.TryParse(value.Generation, out _)
                || value.StartedAt <= 0 || !VersionPattern.IsMatch(value.PackageVersion)
                || !Enum.TryParse<FreshReinstallPhase>(value.Phase, false, out _)
                || value.ExtensionIds is null or { Length: 0 } || value.ExtensionIds.Length > 16
                || value.ExtensionIds.Any(id => AppConfiguration.NormalizeExtensionId(id) is null)
                || value.Observations is null || value.Observations.Length > 128
                || value.Observations.Any(item => item.Length > 256))
                throw new InvalidOperationException();
            string transactionRoot = Path.GetDirectoryName(fullPath)!;
            value = value with
            {
                InstallRoot = ValidateRoot(value.InstallRoot, "installation"),
                DataRoot = ValidateRoot(value.DataRoot, "data"),
                WebViewRoot = ValidateRoot(value.WebViewRoot, "WebView2"),
            };
            ValidateSeparate(transactionRoot, value.InstallRoot, "installation");
            ValidateSeparate(transactionRoot, value.DataRoot, "data");
            ValidateSeparate(transactionRoot, value.WebViewRoot, "WebView2");
            return new(fullPath, value);
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        {
            throw new InvalidOperationException(
                "The Fresh reinstall transaction could not be verified. Setup remains blocked until it is repaired or safely resumed.",
                error
            );
        }
    }

    internal void Advance(FreshReinstallPhase phase, string observation)
    {
        if (phase < Phase || phase > Phase + 1)
            throw new InvalidOperationException("The Fresh reinstall transaction phase is invalid.");
        string note = observation.Trim();
        if (note.Length is <= 0 or > 256)
            throw new InvalidOperationException("The Fresh reinstall observation is invalid.");
        Journal next = journal with
        {
            Phase = phase.ToString(),
            Observations = journal.Observations.Append(note).TakeLast(128).ToArray(),
        };
        Save(next);
    }

    internal void AdoptPendingPackage(string packageVersion, string installRoot, string dataRoot, string webViewRoot)
    {
        if (Phase >= FreshReinstallPhase.ExtensionRemovalVerified)
            throw new InvalidOperationException("A destructive Fresh reinstall phase cannot change package version.");
        if (!VersionPattern.IsMatch(packageVersion)
            || !SameRoot(journal.InstallRoot, ValidateRoot(installRoot, "installation"))
            || !SameRoot(journal.DataRoot, ValidateRoot(dataRoot, "data"))
            || !SameRoot(journal.WebViewRoot, ValidateRoot(webViewRoot, "WebView2")))
            throw new InvalidOperationException("A different Fresh reinstall transaction is already in progress.");
        if (string.Equals(journal.PackageVersion, packageVersion, StringComparison.Ordinal)) return;
        Save(journal with
        {
            PackageVersion = packageVersion,
            Observations = journal.Observations.Append("pending-package-updated").TakeLast(128).ToArray(),
        });
    }

    internal void CleanOwnedState()
    {
        if (Phase >= FreshReinstallPhase.OwnedStatePurged) return;
        if (Phase is not (FreshReinstallPhase.ExtensionRemovalVerified or FreshReinstallPhase.PreviousPackageRemoved))
            throw new InvalidOperationException("Chrome removal must be confirmed before desktop state is removed.");
        if (Phase == FreshReinstallPhase.ExtensionRemovalVerified)
        {
            DeleteOwnedRoot(journal.InstallRoot, exclusive: true);
            Advance(FreshReinstallPhase.PreviousPackageRemoved, "previous-package-removed");
        }
        if (journal.DataRootExclusive)
            DeleteOwnedRoot(journal.DataRoot, exclusive: true);
        else
            DeleteSharedDataRoot(journal.DataRoot);
        if (journal.WebViewRootExclusive)
            DeleteOwnedRoot(journal.WebViewRoot, exclusive: true);
        else if (Directory.Exists(journal.WebViewRoot))
            throw new InvalidOperationException("The configured WebView2 folder is not proven exclusive to OFEnhancer.");
        Advance(FreshReinstallPhase.OwnedStatePurged, "owned-state-purged");
    }

    internal void CompleteAndDelete()
    {
        if (Phase != FreshReinstallPhase.ChromeSetupPending)
            throw new InvalidOperationException("Fresh reinstall cannot complete before Chrome setup is admitted.");
        Advance(FreshReinstallPhase.Complete, "new-install-admitted");
        File.Delete(path);
        string removalJournal = Path.Combine(TransactionDirectory, "chrome-reset.json");
        if (File.Exists(removalJournal)) File.Delete(removalJournal);
        if (Directory.Exists(TransactionDirectory) && !Directory.EnumerateFileSystemEntries(TransactionDirectory).Any())
            Directory.Delete(TransactionDirectory);
    }

    private void Save(Journal value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        if (bytes.Length is <= 0 or > MaximumBytes)
            throw new InvalidOperationException("The Fresh reinstall transaction is too large.");
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (FileStream output = new(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough
            ))
            {
                output.Write(bytes);
                output.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        journal = value;
    }

    private static string ReadUtf8(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        return new System.Text.UTF8Encoding(false, true).GetString(bytes);
    }

    private static string ValidateRoot(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
            throw new InvalidOperationException($"The Fresh reinstall {name} root is invalid.");
        string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        string volume = Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!);
        if (string.Equals(full, volume, StringComparison.OrdinalIgnoreCase) || File.Exists(full))
            throw new InvalidOperationException($"The Fresh reinstall {name} root is unsafe.");
        return full;
    }

    private static void ValidateSeparate(string transactionRoot, string target, string name)
    {
        if (Contains(transactionRoot, target) || Contains(target, transactionRoot))
            throw new InvalidOperationException($"The Fresh reinstall transaction overlaps the {name} root.");
    }

    private static bool Contains(string parent, string child)
    {
        string prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(parent)) + Path.DirectorySeparatorChar;
        string candidate = Path.GetFullPath(child);
        return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            || string.Equals(Path.TrimEndingDirectorySeparator(parent), Path.TrimEndingDirectorySeparator(child), StringComparison.OrdinalIgnoreCase);
    }

    private static bool SameRoot(string left, string right) =>
        string.Equals(Path.TrimEndingDirectorySeparator(left), Path.TrimEndingDirectorySeparator(right), StringComparison.OrdinalIgnoreCase);

    private static void DeleteOwnedRoot(string root, bool exclusive)
    {
        if (!exclusive || !Directory.Exists(root)) return;
        RejectReparsePoints(root);
        Directory.Delete(root, true);
        if (Directory.Exists(root))
            throw new IOException("An owned Fresh reinstall root remained after cleanup.");
    }

    private static void DeleteSharedDataRoot(string root)
    {
        if (!Directory.Exists(root)) return;
        RejectReparsePoints(root, descend: false);
        string data = Path.Combine(root, "data");
        if (Directory.Exists(data)) DeleteOwnedRoot(data, exclusive: true);
        foreach (string name in new[] { "settings.json", ".ofenhancer-owned-root.json" })
        {
            string target = Path.Combine(root, name);
            if (File.Exists(target))
            {
                RejectReparsePoints(target, descend: false);
                File.Delete(target);
            }
            foreach (string temporary in Directory.EnumerateFiles(root, name + ".*.tmp", SearchOption.TopDirectoryOnly))
            {
                if (!Regex.IsMatch(Path.GetFileName(temporary), "^" + Regex.Escape(name) + "\\.[a-f0-9]{32}\\.tmp$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                    continue;
                RejectReparsePoints(temporary, descend: false);
                File.Delete(temporary);
            }
        }
    }

    private static void RejectReparsePoints(string path, bool descend = true)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Fresh reinstall refused a redirected owned path.");
        if (!descend || (attributes & FileAttributes.Directory) == 0) return;
        foreach (string child in Directory.EnumerateFileSystemEntries(path, "*", SearchOption.AllDirectories))
            if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Fresh reinstall refused a redirected owned path.");
    }
}
