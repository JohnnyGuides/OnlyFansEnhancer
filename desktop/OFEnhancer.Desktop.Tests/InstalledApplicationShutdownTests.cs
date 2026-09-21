using System.Diagnostics;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class InstalledApplicationShutdownTests
{
    [DataTestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void Graceful_shutdown_honors_refusal_and_preserves_same_named_neighbor(bool refuse)
    {
        string scratch = Path.Combine(Path.GetTempPath(), "ofenhancer-shutdown-" + Guid.NewGuid().ToString("N"));
        string owned = Path.Combine(scratch, "owned");
        string neighbor = Path.Combine(scratch, "neighbor");
        string desktop = Path.Combine(owned, "desktop");
        Directory.CreateDirectory(desktop);
        Directory.CreateDirectory(Path.Combine(neighbor, "desktop"));
        string source = Path.Combine(scratch, "Holder.cs");
        File.WriteAllText(source, """
            using System;
            using System.IO;
            using System.Windows.Forms;
            class Holder : Form {
                FileStream held;
                string root;
                public Holder(string directory) { root=directory; ShowInTaskbar=false; }
                protected override void OnShown(EventArgs e) {
                    base.OnShown(e); Hide();
                    held=new FileStream(Path.Combine(root,"clrjit.dll"),FileMode.Open,FileAccess.Read,FileShare.Read);
                    File.WriteAllText(Path.Combine(root,"ready"),"ready");
                }
                protected override void WndProc(ref Message m) {
                    if ((m.LParam.ToInt64() & 1)!=0 && m.Msg==0x11) { m.Result=File.Exists(Path.Combine(root,"refuse"))?IntPtr.Zero:(IntPtr)1; return; }
                    if ((m.LParam.ToInt64() & 1)!=0 && m.Msg==0x16 && m.WParam!=IntPtr.Zero) {
                        held.Dispose(); File.WriteAllText(Path.Combine(root,"graceful"),"yes"); Application.Exit(); return;
                    }
                    base.WndProc(ref m);
                }
                [STAThread] static void Main(string[] args) { Application.Run(new Holder(args[0])); }
            }
            """);
        string executable = Path.Combine(desktop, "OFEnhancer.Desktop.exe");
        ProcessStartInfo compile = new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")) { UseShellExecute = false, CreateNoWindow = true };
        foreach (string argument in new[] { "/nologo", "/target:winexe", "/r:System.Windows.Forms.dll", "/out:" + executable, source })
            compile.ArgumentList.Add(argument);
        using (Process compiler = Process.Start(compile)!)
        {
            Assert.IsTrue(compiler.WaitForExit(30_000));
            Assert.AreEqual(0, compiler.ExitCode);
        }
        string otherDesktop = Path.Combine(neighbor, "desktop");
        File.Copy(executable, Path.Combine(otherDesktop, "OFEnhancer.Desktop.exe"));
        File.WriteAllText(Path.Combine(desktop, "clrjit.dll"), "fixture runtime lock");
        File.WriteAllText(Path.Combine(otherDesktop, "clrjit.dll"), "neighbor runtime lock");
        if (refuse) File.WriteAllText(Path.Combine(desktop, "refuse"), "refuse");
        using Process app = Start(executable, desktop);
        using Process other = Start(Path.Combine(otherDesktop, "OFEnhancer.Desktop.exe"), otherDesktop);
        try
        {
            Assert.IsTrue(SpinWait.SpinUntil(() => File.Exists(Path.Combine(desktop, "ready"))
                && File.Exists(Path.Combine(otherDesktop, "ready")), 15_000));
            Assert.ThrowsException<IOException>(() => File.Delete(Path.Combine(desktop, "clrjit.dll")));
            if (refuse)
            {
                Assert.ThrowsException<IOException>(() => InstalledApplicationShutdown.Stop(owned));
                Assert.IsFalse(app.HasExited, "a refusing process must not be killed");
                Assert.IsFalse(other.HasExited);
                Assert.IsTrue(File.Exists(Path.Combine(desktop, "clrjit.dll")));
                return;
            }
            InstalledApplicationShutdown.Stop(owned);
            Assert.IsTrue(app.WaitForExit(10_000));
            Assert.IsTrue(File.Exists(Path.Combine(desktop, "graceful")), "must deliver graceful session-end, not terminate");
            Assert.IsFalse(other.HasExited, "same name outside approved install root is not authority to close it");
            File.Delete(Path.Combine(desktop, "clrjit.dll"));
            InstalledApplicationShutdown.Stop(owned); // Resuming with no process is harmless.
        }
        finally
        {
            foreach (Process process in new[] { app, other })
                if (!process.HasExited) { process.Kill(); process.WaitForExit(); }
            Directory.Delete(scratch, true);
        }
    }

    private static Process Start(string executable, string directory)
    {
        ProcessStartInfo info = new(executable) { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add(directory);
        return Process.Start(info)!;
    }
}
