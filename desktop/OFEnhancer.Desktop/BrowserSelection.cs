using System.IO;

namespace OFEnhancer.Desktop;

internal static class BrowserSelection
{
    internal const string SystemDefaultId = "system";

    private static readonly string[] SelectableIds =
    [
        "chrome",
        "edge",
        "firefox",
        "brave",
        "opera",
        "vivaldi",
    ];

    internal static string? NormalizeId(string? value)
    {
        string candidate = value?.Trim().ToLowerInvariant() ?? string.Empty;
        if (candidate == SystemDefaultId || SelectableIds.Contains(candidate, StringComparer.Ordinal))
            return candidate;
        return null;
    }
}

internal sealed record InstalledBrowser(string Id, string Name, string ExecutablePath);

public sealed record BrowserOption(string Id, string Name);

public sealed record BrowserSettingsView(string SelectedId, IReadOnlyList<BrowserOption> Options);

internal static class InstalledBrowserCatalog
{
    private static readonly (string Id, string Name)[] Definitions =
    [
        ("chrome", "Google Chrome"),
        ("edge", "Microsoft Edge"),
        ("firefox", "Mozilla Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
    ];

    internal static IReadOnlyList<InstalledBrowser> Discover()
    {
        List<InstalledBrowser> browsers = [];
        foreach ((string id, string name) in Definitions)
        {
            string? executable = CandidatePaths(id).FirstOrDefault(File.Exists);
            if (executable is not null)
                browsers.Add(new(id, name, executable));
        }
        return browsers;
    }

    private static IEnumerable<string> CandidatePaths(string id)
    {
        string? local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string? roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string? programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string? programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");

        IEnumerable<string> Paths(params (string? Root, string Relative)[] candidates)
            => candidates
                .Where(candidate => !string.IsNullOrWhiteSpace(candidate.Root))
                .Select(candidate => Path.Combine(candidate.Root!, candidate.Relative))
                .Distinct(StringComparer.OrdinalIgnoreCase);

        return id switch
        {
            "chrome" => Paths(
                (local, @"Google\Chrome\Application\chrome.exe"),
                (programFiles, @"Google\Chrome\Application\chrome.exe"),
                (programFilesX86, @"Google\Chrome\Application\chrome.exe")
            ),
            "edge" => Paths(
                (programFiles, @"Microsoft\Edge\Application\msedge.exe"),
                (programFilesX86, @"Microsoft\Edge\Application\msedge.exe"),
                (local, @"Microsoft\Edge\Application\msedge.exe")
            ),
            "firefox" => Paths(
                (programFiles, @"Mozilla Firefox\firefox.exe"),
                (programFilesX86, @"Mozilla Firefox\firefox.exe"),
                (local, @"Mozilla Firefox\firefox.exe")
            ),
            "brave" => Paths(
                (local, @"BraveSoftware\Brave-Browser\Application\brave.exe"),
                (programFiles, @"BraveSoftware\Brave-Browser\Application\brave.exe"),
                (programFilesX86, @"BraveSoftware\Brave-Browser\Application\brave.exe")
            ),
            "opera" => Paths(
                (local, @"Programs\Opera\launcher.exe"),
                (roaming, @"Opera Software\Opera Stable\launcher.exe"),
                (programFiles, @"Opera\launcher.exe"),
                (programFilesX86, @"Opera\launcher.exe")
            ),
            "vivaldi" => Paths(
                (local, @"Vivaldi\Application\vivaldi.exe"),
                (programFiles, @"Vivaldi\Application\vivaldi.exe"),
                (programFilesX86, @"Vivaldi\Application\vivaldi.exe")
            ),
            _ => [],
        };
    }
}

internal sealed class BrowserSettingsController
{
    private readonly DesktopSettingsStore _settings;
    private readonly Func<IReadOnlyList<InstalledBrowser>> _discover;

    internal BrowserSettingsController(
        DesktopSettingsStore settings,
        Func<IReadOnlyList<InstalledBrowser>>? discover = null
    )
    {
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        _discover = discover ?? InstalledBrowserCatalog.Discover;
    }

    internal BrowserSettingsView Get() => CreateView(Installed());

    internal BrowserSettingsView Save(string browserId)
    {
        string normalized = BrowserSelection.NormalizeId(browserId)
            ?? throw new BrowserSettingsException("invalid-browser");
        IReadOnlyList<InstalledBrowser> installed = Installed();
        if (normalized != BrowserSelection.SystemDefaultId
            && installed.All(browser => browser.Id != normalized))
        {
            throw new BrowserSettingsException("browser-not-installed");
        }

        DesktopSettings current = _settings.Load();
        _settings.Save(
            current with
            {
                BrowserId = normalized == BrowserSelection.SystemDefaultId ? null : normalized,
            }
        );
        return CreateView(installed);
    }

    private IReadOnlyList<InstalledBrowser> Installed()
        => _discover()
            .Where(browser => BrowserSelection.NormalizeId(browser.Id) is not null
                && browser.Id != BrowserSelection.SystemDefaultId
                && !string.IsNullOrWhiteSpace(browser.Name)
                && !string.IsNullOrWhiteSpace(browser.ExecutablePath))
            .GroupBy(browser => browser.Id, StringComparer.Ordinal)
            .Select(group => group.First())
            .ToArray();

    private BrowserSettingsView CreateView(IReadOnlyList<InstalledBrowser> installed)
    {
        string selectedId = _settings.Load().BrowserId ?? BrowserSelection.SystemDefaultId;
        if (selectedId != BrowserSelection.SystemDefaultId
            && installed.All(browser => browser.Id != selectedId))
        {
            selectedId = BrowserSelection.SystemDefaultId;
        }

        BrowserOption[] options =
        [
            new(BrowserSelection.SystemDefaultId, "System default"),
            .. installed.Select(browser => new BrowserOption(browser.Id, browser.Name)),
        ];
        return new(selectedId, options);
    }
}

internal sealed class BrowserSettingsException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

internal sealed class BrowserLaunchException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}
