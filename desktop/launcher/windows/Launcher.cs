// hivedesk.exe: the Windows launcher of the downloadable package.
// Runs node\node.exe (bundled) or the system Node with app\desktop\main.js, with no console window.
// Built by .github/workflows/desktop.yml with the C# compiler that ships with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("hivedesk")]
[assembly: System.Reflection.AssemblyProduct("hivedesk")]
[assembly: System.Reflection.AssemblyCopyright("MIT, Alexandre Kohler")]

static class Launcher
{
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        return "\"" + a.Replace("\\\"", "\\\\\"").Replace("\"", "\\\"") + "\"";
    }

    static string FindNode(string root)
    {
        string bundled = Path.Combine(root, "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(Path.PathSeparator))
        {
            try
            {
                string p = Path.Combine(dir.Trim('"'), "node.exe");
                if (File.Exists(p)) return p;
            }
            catch (ArgumentException) { }
        }
        return null;
    }

    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string cli = Path.Combine(root, "app", "desktop", "main.js");
        string home = Environment.GetEnvironmentVariable("HIVEDESK_HOME");
        if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hivedesk");
        string logDir = Path.Combine(home, "desktop");
        Directory.CreateDirectory(logDir);
        string log = Path.Combine(logDir, "launcher.log");

        string node = FindNode(root);
        if (node == null || !File.Exists(cli))
        {
            MessageBox.Show(
                "hivedesk could not find Node.js.\n\nThe package should contain node\\node.exe next to hivedesk.exe. Download the package again, or install Node.js 18 or newer from nodejs.org.",
                "hivedesk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        var psi = new ProcessStartInfo(node, Quote(cli) + " " + string.Join(" ", args.Select(Quote)))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        psi.EnvironmentVariables["HIVEDESK_DESKTOP"] = "1";

        var tail = new System.Collections.Generic.Queue<string>();
        using (var writer = new StreamWriter(log, false, new UTF8Encoding(false)) { AutoFlush = true })
        using (var p = new Process { StartInfo = psi })
        {
            DataReceivedEventHandler onLine = (s, e) =>
            {
                if (e.Data == null) return;
                lock (tail)
                {
                    writer.WriteLine(e.Data);
                    tail.Enqueue(e.Data);
                    while (tail.Count > 14) tail.Dequeue();
                }
            };
            p.OutputDataReceived += onLine;
            p.ErrorDataReceived += onLine;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            if (p.ExitCode != 0 && p.ExitCode != 130)
            {
                string last;
                lock (tail) last = string.Join("\n", tail.ToArray());
                MessageBox.Show(
                    "hivedesk stopped with an error.\n\n" + last + "\n\nThe full log is in " + log,
                    "hivedesk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return p.ExitCode;
        }
    }
}
