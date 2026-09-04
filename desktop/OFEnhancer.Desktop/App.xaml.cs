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
        instanceLock = new Mutex(true, $"Local\\OFEnhancer.Desktop.{userKey}", out bool first);
        if (!first)
        {
            Shutdown();
            return;
        }

        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        agent = new DesktopAgent(DesktopAgent.DefaultPipeName(userKey));
        agent.Start();

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
        window = new MainWindow(extensionId, catalogue);
        MainWindow = window;
        window.Show();

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
