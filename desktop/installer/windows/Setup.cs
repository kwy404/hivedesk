// hivedesk-setup.exe: the entry point, the non interactive self-test and the offscreen renderer.
//   hivedesk-setup.exe                          the installer window
//   hivedesk-setup.exe --uninstall [--quiet]    remove hivedesk (Apps and Features runs uninstall.exe --uninstall)
//   hivedesk-setup.exe --quiet                  install with the defaults, no window
//   hivedesk-setup.exe --self-test --prefix <empty folder> [--payload <app package zip>]
//       checks the flow, the strings, the pages, the download resume and the SHA-256 check, then installs,
//       repairs, upgrades and removes inside the prefix only (install folder, shortcuts, home and a registry file)
//   hivedesk-setup.exe --render <folder> [--lang <code>|all]   draws every page to PNG files, no window
//   --lang <code> picks the language (default: the Windows display language); --prefix also works for the window.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

[assembly: AssemblyTitle("hivedesk Setup")]
[assembly: AssemblyProduct("hivedesk")]
[assembly: AssemblyCompany("Alexandre Kohler")]
[assembly: AssemblyCopyright("MIT License, Alexandre Kohler")]
[assembly: AssemblyVersion(HivedeskSetup.Payload.AssemblyVersion)]
[assembly: AssemblyFileVersion(HivedeskSetup.Payload.AssemblyVersion)]
[assembly: AssemblyInformationalVersion(HivedeskSetup.Payload.Version)]

namespace HivedeskSetup
{
    public static class Program
    {
        [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

        static string Arg(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        public static string SelfPath { get { return Path.GetFullPath(Assembly.GetExecutingAssembly().Location); } }

        [STAThread]
        public static int Main(string[] args)
        {
            string lang = Arg(args, "--lang");
            Lang.Current = Lang.Pick(lang ?? CultureInfo.CurrentUICulture.Name);
            bool offline = Res.Has("payload.zip");
            if (args.Contains("--self-test"))
            {
                string prefix = Arg(args, "--prefix");
                if (prefix == null) { Out("self-test: --prefix <empty folder> is required"); return 2; }
                return SelfTest.Run(prefix, Arg(args, "--payload"));
            }
            if (args.Contains("--render")) return Render.Run(Arg(args, "--render"), lang ?? Lang.Current);

            string px = Arg(args, "--prefix");
            Targets t = px != null ? Targets.InSandbox(px) : Targets.Real();
            var engine = new Engine(t);
            bool uninstall = args.Contains("--uninstall");
            bool quiet = args.Contains("--quiet");

            if (uninstall)
            {
                string root = Arg(args, "--root") ?? engine.ExistingInstallDir();
                if (root == null && File.Exists(Path.Combine(Path.GetDirectoryName(SelfPath), "current.txt"))) root = Path.GetDirectoryName(SelfPath);
                // Running from inside the install folder: continue from a temporary copy so the folder can go.
                if (root != null && !t.Sandbox && SelfPath.StartsWith(Path.GetFullPath(root).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                {
                    string copy = Path.Combine(Path.GetTempPath(), "hivedesk-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                    File.Copy(SelfPath, copy, true);
                    string rest = "--uninstall --cleanup-self --root \"" + root + "\"" + (quiet ? " --quiet" : "") + (lang != null ? " --lang " + lang : "");
                    Process.Start(new ProcessStartInfo(copy, rest) { UseShellExecute = false });
                    return 0;
                }
                int code = 0;
                if (quiet)
                {
                    try { if (root != null) engine.Uninstall(root, false, f => { }); } catch (Exception e) { engine.Log("uninstall failed: " + e); code = 1; }
                }
                else code = RunWindow(engine, true, offline, root);
                if (args.Contains("--cleanup-self")) ScheduleSelfDelete();
                return code;
            }
            if (quiet) return QuietInstall(engine, offline);
            return RunWindow(engine, false, offline, null);
        }

        static int RunWindow(Engine engine, bool uninstall, bool offline, string root)
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var view = new SetupView(engine, uninstall, offline, false) { SelfExe = SelfPath };
            if (root != null) view.UninstallRoot = root;
            if (uninstall) view.ShowStep(false);
            var w = new SetupWindow(view);
            return app.Run(w);
        }

        /// <summary>Installs with the default options and no window (the offline build, or the online one with a network).</summary>
        static int QuietInstall(Engine engine, bool offline)
        {
            try
            {
                var view = new SetupView(engine, false, offline, true) { SelfExe = SelfPath };
                string zip = view.DownloadDest();
                if (offline)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(zip));
                    using (var s = Res.Open("payload.zip")) using (var f = File.Create(zip)) s.CopyTo(f);
                }
                else
                {
                    var dl = new Downloader();
                    dl.Start(Payload.Url, zip, Payload.Size, null, null);
                    dl.Wait();
                    if (dl.Error != null) throw dl.Error;
                }
                engine.Verify(zip, Payload.Sha256, Payload.Size);
                engine.Install(zip, Payload.Version, view.Opt, SelfPath, (s, f) => { });
                File.Delete(zip);
                return 0;
            }
            catch (Exception e)
            {
                engine.Log("quiet install failed: " + e);
                return 1;
            }
        }

        static void ScheduleSelfDelete()
        {
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & del /f /q \"" + SelfPath + "\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch (Exception) { }
        }

        static bool consoleTried;
        public static void Out(string line)
        {
            if (!consoleTried) { consoleTried = true; try { AttachConsole(-1); } catch (Exception) { } }
            try { Console.WriteLine(line); } catch (Exception) { }
        }
    }

    /// <summary>The non interactive self-test. Never touches the real profile: every target is inside the prefix.</summary>
    public static class SelfTest
    {
        static int pass, fail;
        static StringBuilder log;

        static void Check(bool ok, string what)
        {
            if (ok) pass++; else fail++;
            string line = (ok ? "ok   " : "FAIL ") + what;
            log.AppendLine(line);
            Program.Out(line);
        }

        static void Throws(Action a, string code, string what)
        {
            try { a(); Check(false, what + " (no error)"); }
            catch (SetupException e) { Check(e.Code == code, what + (e.Code == code ? "" : " (got " + e.Code + ")")); }
            catch (Exception e) { Check(false, what + " (" + e.GetType().Name + ": " + e.Message + ")"); }
        }

        public static int Run(string prefix, string payload)
        {
            log = new StringBuilder();
            prefix = Path.GetFullPath(prefix);
            if (Directory.Exists(prefix) && Directory.EnumerateFileSystemEntries(prefix).Any())
            {
                Program.Out("self-test: the prefix must be an empty or new folder: " + prefix);
                return 2;
            }
            Directory.CreateDirectory(prefix);
            var t = Targets.InSandbox(prefix);
            Check(t.Sandbox && new[] { t.DefaultInstallDir, t.StartMenuDir, t.DesktopDir, t.Home, t.LogFile }.All(p => p.StartsWith(prefix + "\\", StringComparison.OrdinalIgnoreCase)), "sandbox targets stay inside the prefix");
            try
            {
                FlowTests();
                StringTests();
                PageTests(t);
                SizeTests(t);
                ProfileTests(t);
                if (payload != null) PackageTests(t, Path.GetFullPath(payload), prefix);
                else Program.Out("self-test: no --payload, the install tests were skipped");
            }
            catch (Exception e)
            {
                Check(false, "unexpected " + e);
            }
            string summary = "self-test: " + pass + " passed, " + fail + " failed";
            log.AppendLine(summary);
            Program.Out(summary);
            File.WriteAllText(Path.Combine(prefix, "self-test.log"), log.ToString());
            return fail == 0 ? 0 : 1;
        }

        static void FlowTests()
        {
            var f = new Flow(false);
            Check(f.Step == Step.Welcome, "flow starts at welcome");
            Check(!f.Fire(Ev.Back) && f.Step == Step.Welcome, "flow: no back from welcome");
            Check(!f.Fire(Ev.Install), "flow: cannot install from welcome");
            f.Fire(Ev.Next);
            Check(f.Step == Step.Tour && Flow.NeedsDownload(f.Step), "flow: tour next, the download starts there");
            f.Fire(Ev.Back);
            Check(f.Step == Step.Welcome, "flow: back to welcome");
            f.Fire(Ev.Next); f.Fire(Ev.Next);
            Check(f.Step == Step.License, "flow: tour, then the license");
            f.Fire(Ev.Next);
            Check(f.Step == Step.Location, "flow: license, then the location");
            Check(!f.Fire(Ev.Install), "flow: no install before the profile");
            f.Fire(Ev.Next);
            Check(f.Step == Step.Profile && Flow.NeedsDownload(f.Step), "flow: location, then the profile");
            f.Fire(Ev.Back);
            Check(f.Step == Step.Location, "flow: back from the profile");
            f.Fire(Ev.Next);
            Check(!f.Fire(Ev.Next), "flow: the profile needs Install (or skip, which also installs)");
            f.Fire(Ev.Install);
            Check(f.Step == Step.Installing && !Flow.CanClose(f.Step), "flow: installing, the window cannot close");
            Check(!f.Fire(Ev.Back), "flow: no back while installing");
            f.Fire(Ev.Fail);
            Check(f.Step == Step.Failed && Flow.CanClose(f.Step), "flow: failed");
            f.Fire(Ev.Retry);
            Check(f.Step == Step.Installing, "flow: retry installs again");
            f.Fire(Ev.Done);
            Check(f.Step == Step.Done && Flow.Index(f.Step) == 5, "flow: done");
            var u = new Flow(true);
            Check(u.Step == Step.UConfirm, "uninstall flow starts at confirm");
            u.Fire(Ev.Remove);
            Check(u.Step == Step.URemoving && !Flow.CanClose(u.Step), "uninstall flow: removing");
            u.Fire(Ev.Fail); u.Fire(Ev.Retry);
            Check(u.Step == Step.URemoving, "uninstall flow: retry removes again");
            u.Fire(Ev.Done);
            Check(u.Step == Step.UDone, "uninstall flow: done");
        }

        static void StringTests()
        {
            var en = Lang.All["en"];
            Check(Lang.Codes.All(c => Lang.All.ContainsKey(c)), "strings: all 10 languages");
            var ph = new Regex(@"\{(\w+)\}");
            foreach (var c in Lang.Codes)
            {
                var table = Lang.All[c];
                var missing = en.Keys.Where(k => !table.ContainsKey(k) || string.IsNullOrWhiteSpace(table[k])).ToList();
                var badPh = en.Keys.Where(k => table.ContainsKey(k) && !ph.Matches(en[k]).Cast<Match>().Select(m => m.Value).OrderBy(x => x).SequenceEqual(ph.Matches(table[k]).Cast<Match>().Select(m => m.Value).OrderBy(x => x))).ToList();
                var dashes = table.Where(kv => kv.Value.IndexOf('–') >= 0 || kv.Value.IndexOf('—') >= 0).Select(kv => kv.Key).ToList();
                Check(missing.Count == 0, "strings " + c + ": every key" + (missing.Count > 0 ? " (missing " + string.Join(", ", missing) + ")" : ""));
                Check(badPh.Count == 0, "strings " + c + ": same placeholders" + (badPh.Count > 0 ? " (" + string.Join(", ", badPh) + ")" : ""));
                Check(dashes.Count == 0, "strings " + c + ": no long dashes");
            }
            Check(Lang.Pick("pt-BR") == "pt-BR" && Lang.Pick("pt-PT") == "pt-BR" && Lang.Pick("de-AT") == "de" && Lang.Pick("zh-TW") == "zh-CN" && Lang.Pick("nl-NL") == "en" && Lang.Pick("") == "en", "language from the OS tag");
            string keep = Lang.Current;
            Lang.Current = "pt-BR";
            Check(Lang.Bytes(2.7e6) == "2,7 MB" && Lang.T("dl.progress", "done", "1", "size", "2") == "1 de 2", "formatting in Portuguese");
            Lang.Current = "en";
            Check(Lang.Bytes(44e6) == "44 MB" && Lang.Seconds(125) == "3 min" && Lang.Seconds(8.2) == "8 s", "formatting in English");
            Lang.Current = keep;
        }

        static void ProfileTests(Targets t)
        {
            Check(Profile.Gallery.Count >= 6 && Profile.Gallery.All(a => !string.IsNullOrEmpty(a.Id) && a.Bg.StartsWith("#")), "the avatar gallery loads (" + Profile.Gallery.Count + " ids)");
            Check(Profile.CleanName("  Ana   Maria ") == "Ana Maria", "profile: the name is trimmed and spaces collapsed");
            Check(Profile.CleanName(new string('x', 32)) != null && Profile.CleanName(new string('x', 33)) == null, "profile: up to 32 characters");
            Check(Profile.CleanName("\U0001F41D" + new string('x', 31)) != null, "profile: a character outside the BMP counts once");
            Check(Profile.CleanName("") == null && Profile.CleanName("a\u0007b") == null && Profile.CleanName("a\u202eb") == null, "profile: empty names and control characters are refused");
            Check(Profile.Initials("Alexandre Silva Kohler") == "AK" && Profile.Initials("ana") == "A" && Profile.Initials("  ") == "", "profile: monogram initials");
            string home = t.Home;
            string id = Profile.Gallery[2].Id;
            Profile.Write(home, " Alexandre   Kohler ", id);
            string json = File.ReadAllText(Path.Combine(home, "profile.json"));
            var d = new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            Check(d.Count == 2 && (string)d["name"] == "Alexandre Kohler" && (string)d["avatar"] == id, "profile.json is { name, avatar } in the hivedesk home");
            Check(json[0] != (char)0xFEFF && File.ReadAllBytes(Path.Combine(home, "profile.json"))[0] == (byte)'{', "profile.json is UTF-8 without a BOM");
            string rn, ra;
            Check(Profile.TryRead(home, out rn, out ra) && rn == "Alexandre Kohler" && ra == id, "the saved profile fills the page again");
            Throws(() => Profile.Write(home, "Ana", "not-in-gallery"), "profile", "an avatar outside the gallery is refused");
            Throws(() => Profile.Write(home, new string('y', 40), id), "profile", "a name over 32 characters is refused");
            Check(File.ReadAllText(Path.Combine(home, "profile.json")) == json, "a refused write leaves the saved profile as it was");
            Directory.Delete(home, true);
        }

        static void SizeTests(Targets t)
        {
            string v = Payload.Version;
            string m = "{\"product\":\"hivedesk\",\"version\":\"" + v + "\",\"assets\":{\"windows-x64\":{\"size\":44123456,\"sha256\":\"x\"}}}";
            Check(ReleaseInfo.PackageSize(m, v) == 44123456, "the package size comes from latest.json");
            Check(ReleaseInfo.PackageSize(m.Replace("\"" + v + "\"", "\"0.0.1\""), v) == -1 && ReleaseInfo.PackageSize("not json", v) == -1 && ReleaseInfo.PackageSize("{}", v) == -1, "a manifest of another version, or a broken one, gives no size");
            Check(ReleaseInfo.ManifestUrl(v) == "https://github.com/kwy404/hivedesk/releases/download/v" + v + "/latest.json", "latest.json of this installer's own release");
            string keep = Lang.Current;
            var engine = new Engine(t);
            foreach (var c in Lang.Codes)
            {
                Lang.Current = c;
                Check(Lang.Megabytes(44123456) == "44 MB" && Lang.Megabytes(2.4e6) == "2 MB" && Lang.Megabytes(80000) == "1 MB", "sizes in whole MB (" + c + ")");
                var online = new SetupView(engine, false, false, true);
                online.Pose(Step.Welcome, 0, "wait", 0, 0);
                string unknown = online.WelcomeMeta();
                online.Pose(Step.Welcome, 0, "wait", 0, 0, 44123456);
                string known = online.WelcomeMeta();
                var offline = new SetupView(engine, false, true, true);
                offline.Pose(Step.Welcome, 0, "wait", 0, 0, 44123456);
                string off = offline.WelcomeMeta();
                Check(unknown == Lang.T("welcome.noAdmin") && !unknown.Contains("MB") && !unknown.Contains("KB"), "welcome hides the size until latest.json gives it (" + c + ")");
                Check(known.Contains("44 MB"), "welcome shows the size from latest.json in MB (" + c + ")");
                Check(off == Lang.T("welcome.noAdmin"), "the offline build says nothing about a download (" + c + ")");
            }
            Lang.Current = keep;
        }

        static void PageTests(Targets t)
        {
            var engine = new Engine(t);
            foreach (Step s in Enum.GetValues(typeof(Step)))
            {
                try
                {
                    var v = new SetupView(engine, s >= Step.UConfirm, false, true);
                    v.Pose(s, 0.4, "wait", 0, 1);
                    v.Measure(new Size(v.Width, v.Height));
                    v.Arrange(new Rect(0, 0, v.Width, v.Height));
                    v.UpdateLayout();
                    Check(v.ActualWidth > 700, "page " + s + " builds and lays out");
                }
                catch (Exception e) { Check(false, "page " + s + ": " + e.Message); }
            }
        }

        static void PackageTests(Targets t, string payload, string prefix)
        {
            var engine = new Engine(t);
            // Work on a copy: a failed check deletes the file it checked.
            string copy = Path.Combine(prefix, "tmp", "payload.zip");
            Directory.CreateDirectory(Path.GetDirectoryName(copy));
            File.Copy(payload, copy, true);
            payload = copy;
            string sha = Engine.Sha256(payload);
            long size = new FileInfo(payload).Length;
            string version = Payload.Version;

            // SHA-256 mismatch is rejected and the file deleted.
            string bad = Path.Combine(prefix, "tmp", "bad.zip");
            Directory.CreateDirectory(Path.GetDirectoryName(bad));
            var bytes = File.ReadAllBytes(payload);
            bytes[bytes.Length / 2] ^= 0x5A;
            File.WriteAllBytes(bad, bytes);
            Throws(() => engine.Verify(bad, sha, size), "checksum", "a package with a wrong SHA-256 is rejected");
            Check(!File.Exists(bad), "the rejected package is deleted");
            string sized = Path.Combine(prefix, "tmp", "sized.zip");
            File.Copy(payload, sized, true);
            Throws(() => engine.Verify(sized, sha, size + 1), "checksum", "a package with a wrong size is rejected");

            // Download with resume against a local server that drops the first connection.
            var good = File.ReadAllBytes(payload);
            using (var server = new TestServer(good) { CutAfter = good.Length / 3 })
            {
                string dest = Path.Combine(prefix, "tmp", "dl.zip");
                var dl = new Downloader();
                dl.Start("http://127.0.0.1:" + server.Port + "/pkg.zip", dest, good.Length, null, null);
                dl.Wait();
                long partLen = File.Exists(dest + ".part") ? new FileInfo(dest + ".part").Length : 0;
                Check(dl.Error != null && partLen == good.Length / 3, "an interrupted download keeps its part (" + partLen + " bytes)");
                dl = new Downloader();
                dl.Start("http://127.0.0.1:" + server.Port + "/pkg.zip", dest, good.Length, null, null);
                dl.Wait();
                Check(dl.Error == null && server.LastRange == "bytes=" + partLen + "-", "the download resumes with a Range request (" + server.LastRange + ")");
                Check(File.Exists(dest) && Engine.Sha256(dest) == sha, "the resumed file matches the SHA-256");
            }

            // Install with every option on.
            var o = new Options { InstallDir = t.DefaultInstallDir, StartMenu = true, Desktop = true, StartWithWindows = true, AutoUpdate = false };
            string self = Program.SelfPath;
            string root = engine.Install(payload, version, o, self, (s, f) => { });
            string launcher = Path.Combine(root, "hivedesk.exe");
            Check(Engine.InstalledVersion(root) == version, "current.txt names " + version);
            Check(File.Exists(Path.Combine(root, "versions", version, "app", "desktop", "main.js")) && File.Exists(Path.Combine(root, "versions", version, "node", "node.exe")), "the app and Node are in versions\\" + version);
            Check(File.Exists(launcher) && File.Exists(Path.Combine(root, "uninstall.exe")) && File.Exists(Path.Combine(root, "hivedesk.ico")), "launcher, uninstaller and icon at the root");
            Check(File.Exists(Path.Combine(t.StartMenuDir, "hivedesk.lnk")) && string.Equals(Shortcut.TargetOf(Path.Combine(t.StartMenuDir, "hivedesk.lnk")), launcher, StringComparison.OrdinalIgnoreCase), "Start menu shortcut to the launcher");
            Check(File.Exists(Path.Combine(t.DesktopDir, "hivedesk.lnk")), "desktop shortcut");
            Check(t.Reg.GetUninstall("DisplayVersion") == version && t.Reg.GetUninstall("InstallLocation") == root && (t.Reg.GetUninstall("UninstallString") ?? "").Contains("uninstall.exe\" --uninstall"), "Apps and Features entry");
            Check(t.Reg.GetRun() == "\"" + launcher + "\"", "start with Windows");
            string prefs = File.ReadAllText(Path.Combine(t.Home, "update", "prefs.json"));
            Check(prefs.Contains("\"autoUpdate\":false"), "the auto update choice reaches the app settings");
            Check(engine.ExistingInstallDir() == root, "the next run finds the install");
            Check(!File.Exists(Path.Combine(t.Home, "profile.json")), "an install with the profile skipped writes no profile.json");
            var manifest = Engine.ReadManifest(root);
            Check(manifest != null && manifest.Contains("versions") && manifest.Contains("hivedesk.exe") && manifest.Contains("uninstall.exe") && manifest.Contains(Engine.ManifestName), "the install writes its manifest (" + (manifest == null ? "none" : string.Join(", ", manifest)) + ")");

            // A folder that holds other things is refused, and nothing in it is touched.
            string busy = Path.Combine(prefix, "busy");
            Directory.CreateDirectory(busy);
            File.WriteAllText(Path.Combine(busy, "thesis.docx"), "mine");
            Check(!Engine.FolderFree(busy) && Engine.FolderFree(root) && Engine.FolderFree(Path.Combine(prefix, "new-folder")), "only a new or empty folder, or a hivedesk install, is free");
            Throws(() => engine.Install(payload, version, new Options { InstallDir = busy }, self, (s, f) => { }), "notempty", "installing into a folder that holds other files is refused");
            Check(Directory.GetFileSystemEntries(busy).Length == 1 && File.ReadAllText(Path.Combine(busy, "thesis.docx")) == "mine", "the refused folder is untouched");

            // Repair the same version with fewer options.
            o.Desktop = false; o.StartWithWindows = false; o.AutoUpdate = true;
            engine.Install(payload, version, o, self, (s, f) => { });
            Check(!File.Exists(Path.Combine(t.DesktopDir, "hivedesk.lnk")) && t.Reg.GetRun() == null, "repair removes the shortcut and the start entry that were turned off");
            Check(File.ReadAllText(Path.Combine(t.Home, "update", "prefs.json")).Contains("\"autoUpdate\":true"), "repair updates the auto update choice");

            // Upgrade over an older version: the older one stays as the rollback.
            string older = Path.Combine(root, "versions", "0.9.0");
            Directory.CreateDirectory(Path.Combine(older, "app"));
            File.WriteAllText(Path.Combine(root, "current.txt"), "0.9.0\n");
            Directory.CreateDirectory(Path.Combine(root, "versions", "0.8.0"));
            engine.Install(payload, version, o, self, (s, f) => { });
            var names = Directory.GetDirectories(Path.Combine(root, "versions")).Select(Path.GetFileName).OrderBy(x => x).ToArray();
            Check(Engine.InstalledVersion(root) == version && names.SequenceEqual(new[] { "0.9.0", version }.OrderBy(x => x)), "upgrade keeps one previous version (" + string.Join(", ", names) + ")");
            Check(File.ReadAllText(Path.Combine(root, "update-state.json")).Contains("\"previous\":\"0.9.0\""), "the update state records the previous version");

            // A package with a path that leaves the folder is refused.
            string evil = Path.Combine(prefix, "tmp", "evil.zip");
            using (var z = System.IO.Compression.ZipFile.Open(evil, System.IO.Compression.ZipArchiveMode.Create))
            {
                var e = z.CreateEntry("hivedesk/../../escape.txt");
                using (var w = new StreamWriter(e.Open())) w.Write("x");
            }
            Throws(() => engine.Install(evil, "9.9.9", new Options { InstallDir = Path.Combine(prefix, "evil") }, self, (s, f) => { }), "package", "a package with an unsafe path is refused");
            Check(!File.Exists(Path.Combine(prefix, "escape.txt")), "nothing was written outside");

            // Remove everything, data included; a file someone put in the install folder later stays, with the folder.
            File.WriteAllText(Path.Combine(root, "notes.txt"), "mine");
            Directory.CreateDirectory(Path.Combine(root, "my-project"));
            File.WriteAllText(Path.Combine(root, "my-project", "a.txt"), "mine");
            engine.Uninstall(root, true, f => { });
            var left = Directory.Exists(root) ? Directory.GetFileSystemEntries(root).Select(Path.GetFileName).OrderBy(x => x).ToArray() : new string[0];
            Check(left.SequenceEqual(new[] { "my-project", "notes.txt" }), "uninstall removes only what the installer created (left: " + string.Join(", ", left) + ")");
            Directory.Delete(root, true);
            Throws(() => engine.Uninstall(busy, false, f => { }), "package", "uninstall refuses a plain folder of files");
            Check(!File.Exists(Path.Combine(t.StartMenuDir, "hivedesk.lnk")), "uninstall removes the shortcuts");
            Check(t.Reg.GetUninstall("DisplayName") == null && t.Reg.GetRun() == null, "uninstall removes the registry entries");
            Check(!Directory.Exists(t.Home), "uninstall with data removes ~/.hivedesk");
            Throws(() => engine.Uninstall(Path.Combine(prefix, "StartMenu"), false, f => { }), "package", "uninstall refuses a folder that is not an install");
        }
    }

    /// <summary>Draws every page offscreen to PNG files (2x), for review and the docs. No window is created.</summary>
    public static class Render
    {
        public static int Run(string outDir, string lang)
        {
            if (string.IsNullOrEmpty(outDir)) { Program.Out("render: --render <folder>"); return 2; }
            Directory.CreateDirectory(outDir);
            string sandbox = Path.Combine(Path.GetTempPath(), "hivedesk-render-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            var engine = new Engine(Targets.InSandbox(sandbox));
            var langs = lang == "all" ? Lang.Codes : new[] { Lang.Pick(lang) };
            string shown = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "hivedesk");
            try
            {
                foreach (var l in langs)
                {
                    Lang.Current = l;
                    Shot(engine, outDir, l, "01-welcome", false, v => v.Pose(Step.Welcome, 0, "wait", 0, 0));
                    Shot(engine, outDir, l, "02-tour", false, v => v.Pose(Step.Tour, 0.38, "wait", 0, 0));
                    Shot(engine, outDir, l, "03-tour-p2p", false, v => v.Pose(Step.Tour, 0.56, "wait", 0, 2));
                    Shot(engine, outDir, l, "04-license", false, v => v.Pose(Step.License, 0.71, "wait", 0, 0));
                    Shot(engine, outDir, l, "05-location", false, v => { v.Opt.InstallDir = shown; v.Pose(Step.Location, 1, "wait", 0, 0); });
                    Shot(engine, outDir, l, "05b-profile", false, v => { v.PoseProfile("Alexandre Kohler", 0); v.Pose(Step.Profile, 1, "wait", 0, 0); });
                    Shot(engine, outDir, l, "06-installing", false, v => v.Pose(Step.Installing, 0.83, "wait", 0, 3));
                    Shot(engine, outDir, l, "07-installing-copy", false, v => v.Pose(Step.Installing, 1, "extract", 0.6, 4));
                    Shot(engine, outDir, l, "08-done", false, v => { v.Opt.InstallDir = shown; v.Pose(Step.Done, 1, "register", 1, 0); });
                    Shot(engine, outDir, l, "09-failed", false, v => { v.ErrorText = Lang.T("err.checksum"); v.Pose(Step.Failed, 0, "wait", 0, 0); });
                    Shot(engine, outDir, l, "10-uninstall", true, v => { v.UninstallRoot = shown; v.Pose(Step.UConfirm, 0, "wait", 0, 0); });
                }
            }
            finally
            {
                try { Directory.Delete(sandbox, true); } catch (Exception) { }
            }
            return 0;
        }

        static void Shot(Engine engine, string dir, string lang, string name, bool uninstall, Action<SetupView> pose)
        {
            var v = new SetupView(engine, uninstall, false, true);
            pose(v);
            for (int i = 0; i < 2; i++)
            {
                v.Measure(new Size(v.Width, v.Height));
                v.Arrange(new Rect(0, 0, v.Width, v.Height));
                v.UpdateLayout();
                v.RefreshProgress();
            }
            const double scale = 2;
            var rtb = new RenderTargetBitmap((int)(v.Width * scale), (int)(v.Height * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);
            rtb.Render(v);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(rtb));
            string file = Path.Combine(dir, "installer-" + lang + "-" + name + ".png");
            using (var f = File.Create(file)) enc.Save(f);
            Program.Out(file);
        }
    }
}
