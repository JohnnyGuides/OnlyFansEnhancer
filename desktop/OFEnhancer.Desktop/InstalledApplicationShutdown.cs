using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace OFEnhancer.Desktop;

// PrepareToInstall runs before Inno's normal Restart Manager pass. Fresh cleanup
// must release the old runtime first, including an application hidden in the tray.
internal static class InstalledApplicationShutdown
{
    internal static void Stop(string installRoot)
    {
        string root = Path.GetFullPath(installRoot);
        string[] paths = [Path.Combine(root, "desktop", "OFEnhancer.Desktop.exe"),
            Path.Combine(root, "native", "OFEnhancerNativeBridge.exe")];
        List<Process> owned = [];
        using Process current = Process.GetCurrentProcess();
        try
        {
            foreach (string path in paths)
                foreach (Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(path)))
                {
                    bool keep = false;
                    try
                    {
                        keep = process.Id != Environment.ProcessId
                            && process.SessionId == current.SessionId
                            && string.Equals(process.MainModule?.FileName, path, StringComparison.OrdinalIgnoreCase);
                        if (keep) owned.Add(process);
                    }
                    catch (InvalidOperationException) { /* Process already exited. */ }
                    finally { if (!keep) process.Dispose(); }
                }
            if (owned.Count == 0) return;
            foreach (Process process in owned)
            {
                List<nint> windows = [];
                EnumWindows((window, _) =>
                {
                    GetWindowThreadProcessId(window, out uint owner);
                    if (owner == process.Id) windows.Add(window);
                    return true;
                }, nint.Zero);
                foreach (nint window in windows)
                {
                    if (process.HasExited) break;
                    if (SendMessageTimeout(window, RestartManagerMessage.QueryEndSession, nint.Zero,
                        new nint(RestartManagerMessage.CloseApplication), 2, 3_000, out nint accepted) == nint.Zero
                        || accepted == nint.Zero) continue;
                    SendMessageTimeout(window, RestartManagerMessage.EndSession, new nint(1),
                        new nint(RestartManagerMessage.CloseApplication), 2, 3_000, out _);
                }
            }
            foreach (Process process in owned)
                if (!process.WaitForExit(10_000))
                    throw new IOException("OFEnhancer is still running. Exit it from the tray, then rerun Setup to resume. No cleanup was started by this attempt.");
        }
        finally { foreach (Process process in owned) process.Dispose(); }
    }

    private delegate bool EnumWindowCallback(nint window, nint parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowCallback callback, nint parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern nint SendMessageTimeout(nint window, int message, nint wParam,
        nint lParam, uint flags, uint timeout, out nint result);
}
