using System.Security.Principal;
using System.IO;
using System.Windows;
using System.Windows.Forms;
using OFEnhancer.Catalogue;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop;

public partial class App : System.Windows.Application
{
    private Mutex? instanceLock;
    private DesktopAgent? agent;
    private NotifyIcon? tray;
    private MainWindow? window;
    private CatalogueStore? catalogue;

    protected override void OnStartup(StartupEventArgs eventArgs)
    {
        base.OnStartup(eventArgs);
        if (eventArgs.Args.Contains("--status-json", StringComparer.Ordinal))
        {
            using StreamWriter output = new(Console.OpenStandardOutput()) { AutoFlush = true };
            output.Write(AgentProtocol.Serialize(AgentStatus.Current));
            Shutdown();
            return;
        }

        if (eventArgs.Args.Contains("--agent-once", StringComparer.Ordinal))
        {
            RunAgentOnce(eventArgs.Args);
            Shutdown();
            return;
        }

        string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        Mutex candidateLock = new(
            true,
            $"Local\\OFEnhancer.Desktop.{userKey}",
            out bool first
        );
        if (!first)
        {
            candidateLock.Dispose();
            if (eventArgs.Args.Contains("--chrome-setup", StringComparer.Ordinal))
            {
                try
                {
                    using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(3));
                    var response = new AgentPipeClient(DesktopAgent.DefaultPipeName(userKey)).SendAsync(
                        new AgentRequest(AgentProtocol.Version, Guid.NewGuid(), "showChromeSetup"), timeout.Token).GetAwaiter().GetResult();
                    if (!response.Ok) throw new InvalidOperationException("The running desktop does not support setup activation.");
                }
                catch { System.Windows.MessageBox.Show("Open the running OFEnhancer window and select its Chrome connection button.", "Chrome setup"); }
            }
            Shutdown();
            return;
        }
        instanceLock = candidateLock;

        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        AppConfiguration.ApplyFreshInstallerDefaults(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..")), AppConfiguration.SettingsPath);
        string? extensionId = AppConfiguration.ResolveExtensionId(
            eventArgs.Args,
            AppConfiguration.SettingsPath
        );
        try
        {
            catalogue = CatalogueStore.Open(AppConfiguration.CatalogueDatabasePath);
        }
        catch (Exception exception) when (exception is CatalogueMigrationException or IOException)
        {
            System.Windows.MessageBox.Show(
                "OFEnhancer could not open the local catalogue. No publishing action was started.",
                "Catalogue unavailable",
                MessageBoxButton.OK,
                MessageBoxImage.Error
            );
            Shutdown();
            return;
        }
        window = new MainWindow(extensionId, catalogue, eventArgs.Args.Contains("--extension-id", StringComparer.Ordinal));
        agent = new DesktopAgent(DesktopAgent.DefaultPipeName(userKey), window.HandleAgentRequest);
        agent.Start();
        MainWindow = window;
        window.Show();
        if (eventArgs.Args.Contains("--chrome-setup", StringComparer.Ordinal)) window.OpenChromeSetup();

        tray = new NotifyIcon
        {
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!),
            Text = "OFEnhancer",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip(),
        };
        tray.ContextMenuStrip.Items.Add("Open", null, (_, _) => ShowWindow());
        tray.ContextMenuStrip.Items.Add("Exit", null, (_, _) => ExitApp());
        tray.DoubleClick += (_, _) => ShowWindow();
    }

    protected override void OnExit(ExitEventArgs eventArgs)
    {
        window?.Dispose();
        tray?.Dispose();
        agent?.DisposeAsync().AsTask().GetAwaiter().GetResult();
        catalogue?.Dispose();
        if (instanceLock is not null)
        {
            instanceLock.ReleaseMutex();
            instanceLock.Dispose();
        }
        base.OnExit(eventArgs);
    }

    private void ShowWindow()
    {
        if (window is null)
            return;
        window.Show();
        window.WindowState = WindowState.Normal;
        window.Activate();
    }

    private async void ExitApp()
    {
        if (window is not null)
            await window.ExitAsync();
        Shutdown();
    }

    private static void RunAgentOnce(IReadOnlyList<string> args)
    {
        string userKey = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        string pipeName = DesktopAgent.DefaultPipeName(userKey);
        for (int index = 0; index < args.Count - 1; index++)
        {
            if (string.Equals(args[index], "--pipe-name", StringComparison.Ordinal))
                pipeName = args[index + 1];
        }

        try
        {
            AgentPipeServer server = new(pipeName);
            server
                .RunOnceAsync(
                    request => AgentResponse.Success(request, AgentStatus.Current),
                    CancellationToken.None
                )
                .GetAwaiter()
                .GetResult();
        }
        catch
        {
            Environment.ExitCode = 1;
        }
    }
}
