// hivedesk-setup.exe: strings, the flow state machine, install targets, the install engine and the downloader.
// C# 5 for the compiler that ships with Windows (.NET Framework 4.8). No dependencies outside the framework.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace HivedeskSetup
{
    /// <summary>The installer strings in the 10 languages of hivedesk (strings.json, embedded).</summary>
    public static class Lang
    {
        public static readonly string[] Codes = { "en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ru" };
        static Dictionary<string, Dictionary<string, string>> all;
        public static string Current = "en";

        public static Dictionary<string, Dictionary<string, string>> All
        {
            get
            {
                if (all == null)
                {
                    var ser = new JavaScriptSerializer();
                    all = ser.Deserialize<Dictionary<string, Dictionary<string, string>>>(Res.Text("strings.json"));
                }
                return all;
            }
        }

        /// <summary>A supported code for a culture tag: exact, then by language, else English.</summary>
        public static string Pick(string tag)
        {
            if (string.IsNullOrEmpty(tag)) return "en";
            string t = tag.Replace('_', '-').ToLowerInvariant();
            foreach (var c in Codes) if (c.ToLowerInvariant() == t) return c;
            string lang = t.Split('-')[0];
            foreach (var c in Codes) if (c.Split('-')[0].ToLowerInvariant() == lang) return c;
            return "en";
        }

        public static string T(string key, params string[] kv)
        {
            string s;
            Dictionary<string, string> table;
            if (!All.TryGetValue(Current, out table) || !table.TryGetValue(key, out s))
            {
                if (!All["en"].TryGetValue(key, out s)) s = key;
            }
            for (int i = 0; i + 1 < kv.Length; i += 2) s = s.Replace("{" + kv[i] + "}", kv[i + 1]);
            return s;
        }

        public static CultureInfo Culture
        {
            get { try { return CultureInfo.GetCultureInfo(Current); } catch (Exception) { return CultureInfo.InvariantCulture; } }
        }

        public static string Bytes(double n)
        {
            string[] u = { "B", "KB", "MB", "GB" };
            int i = 0;
            while (n >= 1000 && i < u.Length - 1) { n /= 1000; i++; }
            return n.ToString(i >= 2 ? (n < 10 ? "0.0" : "0") : "0", Culture) + " " + u[i];
        }

        /// <summary>Whole megabytes, at least 1 MB: download sizes on the pages.</summary>
        public static string Megabytes(double n)
        {
            return Math.Max(1, Math.Round(n / 1e6)).ToString("0", Culture) + " MB";
        }

        public static string Seconds(double s)
        {
            if (double.IsNaN(s) || double.IsInfinity(s) || s < 0) return "";
            if (s >= 90) return Math.Ceiling(s / 60).ToString("0", Culture) + " min";
            return Math.Max(1, Math.Round(s)).ToString("0", Culture) + " s";
        }
    }

    /// <summary>Embedded resources: strings, XAML, the license, the icon, and (offline build) the app package.</summary>
    public static class Res
    {
        public static Stream Open(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        }
        public static bool Has(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceNames().Contains(name);
        }
        public static string Text(string name)
        {
            using (var s = Open(name))
            {
                if (s == null) throw new FileNotFoundException("missing resource " + name);
                using (var r = new StreamReader(s, Encoding.UTF8)) return r.ReadToEnd();
            }
        }
    }

    public enum Step { Welcome, Tour, License, Location, Profile, Installing, Done, Failed, UConfirm, URemoving, UDone }
    public enum Ev { Next, Back, Install, Done, Fail, Retry, Remove }

    /// <summary>
    /// The page flow. Welcome, the tour (the download starts here), the license, the location and options,
    /// then installing, done or failed. Uninstall: confirm, removing, done (or failed).
    /// </summary>
    public class Flow
    {
        public Step Step;
        public readonly bool Uninstall;

        public Flow(bool uninstall)
        {
            Uninstall = uninstall;
            Step = uninstall ? Step.UConfirm : Step.Welcome;
        }

        public bool Fire(Ev e)
        {
            Step n = Next(Step, e, Uninstall);
            if (n == Step) return false;
            Step = n;
            return true;
        }

        public static Step Next(Step s, Ev e, bool uninstall)
        {
            switch (s)
            {
                case Step.Welcome: return e == Ev.Next ? Step.Tour : s;
                case Step.Tour: return e == Ev.Next ? Step.License : e == Ev.Back ? Step.Welcome : s;
                case Step.License: return e == Ev.Next ? Step.Location : e == Ev.Back ? Step.Tour : s;
                case Step.Location: return e == Ev.Next ? Step.Profile : e == Ev.Back ? Step.License : s;
                case Step.Profile: return e == Ev.Install ? Step.Installing : e == Ev.Back ? Step.Location : s;
                case Step.Installing: return e == Ev.Done ? Step.Done : e == Ev.Fail ? Step.Failed : s;
                case Step.Failed: return e == Ev.Retry ? (uninstall ? Step.URemoving : Step.Installing) : s;
                case Step.UConfirm: return e == Ev.Remove ? Step.URemoving : s;
                case Step.URemoving: return e == Ev.Done ? Step.UDone : e == Ev.Fail ? Step.Failed : s;
                default: return s;
            }
        }

        /// <summary>The download runs from the tour on, and again on a retry when it had failed.</summary>
        public static bool NeedsDownload(Step s) { return s == Step.Tour || s == Step.License || s == Step.Location || s == Step.Profile || s == Step.Installing; }
        public static bool CanClose(Step s) { return s != Step.Installing && s != Step.URemoving; }
        /// <summary>The highlighted item of the step list on the left (0 to 5).</summary>
        public static int Index(Step s)
        {
            switch (s)
            {
                case Step.Welcome: return 0;
                case Step.Tour: return 1;
                case Step.License: return 2;
                case Step.Location: return 3;
                case Step.Profile: return 4;
                default: return 5;
            }
        }
    }

    public class Options
    {
        public string InstallDir;
        public bool StartMenu = true;
        public bool Desktop = true;
        public bool StartWithWindows = false;
        public bool AutoUpdate = true;
        /// <summary>The local profile; null name when the user skipped (the app asks later).</summary>
        public string ProfileName;
        public string ProfileAvatar;
    }

    /// <summary>
    /// The local profile (docs/1.0/PROFILE.md of the design stream): &lt;home&gt;\profile.json with
    /// { "name": up to 32 characters, "avatar": an id of the gallery in avatars.json }.
    /// </summary>
    public static class Profile
    {
        public const int NameMax = 32;
        public class Avatar { public string Id, Bg, Fg; }
        static List<Avatar> all;

        public static List<Avatar> Gallery
        {
            get
            {
                if (all == null)
                {
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Res.Text("avatars.json"));
                    all = ((System.Collections.ArrayList)d["avatars"]).Cast<Dictionary<string, object>>()
                        .Select(a => new Avatar { Id = (string)a["id"], Bg = (string)a["bg"], Fg = (string)a["fg"] }).ToList();
                }
                return all;
            }
        }

        public static int Length(string s)
        {
            int n = 0;
            foreach (char c in s) if (!char.IsLowSurrogate(c)) n++;
            return n;
        }

        /// <summary>The trimmed name with inner spaces collapsed, or null when it is empty, too long or has control characters.</summary>
        public static string CleanName(string name)
        {
            string n = System.Text.RegularExpressions.Regex.Replace((name ?? "").Normalize(NormalizationForm.FormC), @"\s+", " ").Trim();
            if (n.Length == 0 || Length(n) > NameMax) return null;
            foreach (char c in n)
            {
                if (char.IsControl(c) || (c >= '\u200b' && c <= '\u200f') || (c >= '\u2028' && c <= '\u202e') || (c >= '\u2066' && c <= '\u2069')) return null;
            }
            return n;
        }

        public static string Initials(string name)
        {
            var words = (name ?? "").Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0) return "";
            Func<string, string> first = w => char.IsHighSurrogate(w[0]) && w.Length > 1 ? w.Substring(0, 2) : w.Substring(0, 1);
            string r = first(words[0]);
            if (words.Length > 1) r += first(words[words.Length - 1]);
            return r.ToUpperInvariant();
        }

        public static void Write(string home, string name, string avatar)
        {
            string n = CleanName(name);
            if (n == null) throw new SetupException("profile", "bad name");
            if (!Gallery.Any(a => a.Id == avatar)) throw new SetupException("profile", "the avatar is not in the gallery");
            Directory.CreateDirectory(home);
            string file = Path.Combine(home, "profile.json");
            string json = "{\n  \"name\": " + new JavaScriptSerializer().Serialize(n) + ",\n  \"avatar\": " + new JavaScriptSerializer().Serialize(avatar) + "\n}\n";
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
        }

        /// <summary>The saved profile, to fill the page in again (repair or upgrade).</summary>
        public static bool TryRead(string home, out string name, out string avatar)
        {
            name = null; avatar = null;
            try
            {
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(home, "profile.json")));
                name = CleanName(d["name"] as string);
                string av = d["avatar"] as string;
                avatar = av;
                return name != null && Gallery.Any(g => g.Id == av);
            }
            catch (Exception) { return false; }
        }
    }

    /// <summary>Where an install writes. Real: the user profile. Sandbox: everything under one folder (tests).</summary>
    public class Targets
    {
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\hivedesk";
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public string DefaultInstallDir, StartMenuDir, DesktopDir, Home, LogFile;
        public bool Sandbox;
        public IReg Reg;

        public static Targets Real()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string home = Environment.GetEnvironmentVariable("HIVEDESK_HOME");
            if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hivedesk");
            return new Targets
            {
                DefaultInstallDir = Path.Combine(local, "Programs", "hivedesk"),
                StartMenuDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                DesktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Home = home,
                LogFile = Path.Combine(Path.GetTempPath(), "hivedesk-setup.log"),
                Reg = new RealReg(),
                Sandbox = false
            };
        }

        /// <summary>Everything inside <paramref name="prefix"/>: install folder, shortcuts, home and a registry file.</summary>
        public static Targets InSandbox(string prefix)
        {
            prefix = Path.GetFullPath(prefix);
            return new Targets
            {
                DefaultInstallDir = Path.Combine(prefix, "Programs", "hivedesk"),
                StartMenuDir = Path.Combine(prefix, "StartMenu"),
                DesktopDir = Path.Combine(prefix, "Desktop"),
                Home = Path.Combine(prefix, "home", ".hivedesk"),
                LogFile = Path.Combine(prefix, "setup.log"),
                Reg = new FileReg(Path.Combine(prefix, "registry.json")),
                Sandbox = true
            };
        }
    }

    public interface IReg
    {
        void SetUninstall(Dictionary<string, object> values);
        string GetUninstall(string name);
        void DeleteUninstall();
        void SetRun(string command);
        string GetRun();
        void DeleteRun();
    }

    public class RealReg : IReg
    {
        public void SetUninstall(Dictionary<string, object> values)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(Targets.UninstallKey))
            {
                foreach (var kv in values)
                {
                    if (kv.Value is int) k.SetValue(kv.Key, kv.Value, RegistryValueKind.DWord);
                    else k.SetValue(kv.Key, Convert.ToString(kv.Value, CultureInfo.InvariantCulture), RegistryValueKind.String);
                }
            }
        }
        public string GetUninstall(string name)
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Targets.UninstallKey))
            {
                if (k == null) return null;
                object v = k.GetValue(name);
                return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
            }
        }
        public void DeleteUninstall() { Registry.CurrentUser.DeleteSubKeyTree(Targets.UninstallKey, false); }
        public void SetRun(string command)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(Targets.RunKey)) k.SetValue("hivedesk", command, RegistryValueKind.String);
        }
        public string GetRun()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Targets.RunKey))
            {
                if (k == null) return null;
                object v = k.GetValue("hivedesk");
                return v == null ? null : v.ToString();
            }
        }
        public void DeleteRun()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Targets.RunKey, true)) { if (k != null) k.DeleteValue("hivedesk", false); }
        }
    }

    /// <summary>The registry of a sandbox install, as a JSON file.</summary>
    public class FileReg : IReg
    {
        readonly string file;
        public FileReg(string file) { this.file = file; }
        Dictionary<string, object> Load()
        {
            if (!File.Exists(file)) return new Dictionary<string, object>();
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
        }
        void Save(Dictionary<string, object> d)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, new JavaScriptSerializer().Serialize(d));
        }
        public void SetUninstall(Dictionary<string, object> values) { var d = Load(); d["uninstall"] = values; Save(d); }
        public string GetUninstall(string name)
        {
            var d = Load();
            object u;
            if (!d.TryGetValue("uninstall", out u)) return null;
            var m = u as Dictionary<string, object>;
            object v;
            return m != null && m.TryGetValue(name, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null;
        }
        public void DeleteUninstall() { var d = Load(); d.Remove("uninstall"); Save(d); }
        public void SetRun(string command) { var d = Load(); d["run"] = command; Save(d); }
        public string GetRun() { var d = Load(); object v; return d.TryGetValue("run", out v) && v != null ? v.ToString() : null; }
        public void DeleteRun() { var d = Load(); d.Remove("run"); Save(d); }
    }

    public class SetupException : Exception
    {
        public readonly string Code;
        public SetupException(string code, string message) : base(message) { Code = code; }
    }

    /// <summary>Installs, repairs and removes hivedesk in the versioned layout the app updates itself in.</summary>
    public class Engine
    {
        public readonly Targets T;
        readonly object logLock = new object();
        public Engine(Targets t) { T = t; }

        public void Log(string line)
        {
            lock (logLock)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(T.LogFile));
                    File.AppendAllText(T.LogFile, DateTime.Now.ToString("s", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine);
                }
                catch (Exception) { }
            }
        }

        public static string Sha256(string file)
        {
            using (var sha = SHA256.Create())
            using (var s = File.OpenRead(file))
            {
                return string.Concat(sha.ComputeHash(s).Select(b => b.ToString("x2")));
            }
        }

        /// <summary>Throws code "checksum" (and deletes the file) when it does not match.</summary>
        public void Verify(string file, string sha256, long size)
        {
            var fi = new FileInfo(file);
            if (!fi.Exists) throw new SetupException("package", "the app package is missing");
            if ((size > 0 && fi.Length != size) || !string.Equals(Sha256(file), sha256, StringComparison.OrdinalIgnoreCase))
            {
                Log("checksum mismatch for " + file);
                try { File.Delete(file); } catch (Exception) { }
                throw new SetupException("checksum", "SHA-256 mismatch");
            }
        }

        /// <summary>The install manifest: the top level names the installer created in the install folder.</summary>
        public const string ManifestName = "install-manifest.txt";
        /// <summary>Every top level name an install (or the in-app updater) can create; nothing else is ever removed.</summary>
        public static readonly string[] Owned = { "versions", "hivedesk.exe", "hivedesk.exe.old", "current.txt", "current.txt.tmp", "update-state.json", "uninstall.exe", "hivedesk.ico", ManifestName };

        static bool PlainName(string n)
        {
            return !string.IsNullOrEmpty(n) && n.Length < 120 && n.IndexOfAny(new[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|' }) < 0 && n != "." && n != "..";
        }

        /// <summary>The names in the manifest that the installer may own, or null when there is no manifest (an install from before 1.0).</summary>
        public static List<string> ReadManifest(string root)
        {
            string file = Path.Combine(root, ManifestName);
            if (!File.Exists(file)) return null;
            return File.ReadAllLines(file).Select(l => l.Trim()).Where(n => PlainName(n) && Owned.Contains(n, StringComparer.OrdinalIgnoreCase)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        /// <summary>A folder that a previous hivedesk install made (its manifest, or current.txt with the versions folder).</summary>
        public static bool IsHivedeskInstall(string root)
        {
            return File.Exists(Path.Combine(root, ManifestName)) || (File.Exists(Path.Combine(root, "current.txt")) && Directory.Exists(Path.Combine(root, "versions")));
        }

        /// <summary>True when hivedesk may install here: a new or empty folder, or a previous hivedesk install.</summary>
        public static bool FolderFree(string root)
        {
            try
            {
                root = Path.GetFullPath(root);
                if (!Directory.Exists(root)) return !File.Exists(root);
                return !Directory.EnumerateFileSystemEntries(root).Any() || IsHivedeskInstall(root);
            }
            catch (Exception) { return false; }
        }

        public static string InstalledVersion(string root)
        {
            try { return File.ReadAllText(Path.Combine(root, "current.txt")).Trim(); } catch (Exception) { return null; }
        }

        public string ExistingInstallDir()
        {
            string loc = T.Reg.GetUninstall("InstallLocation");
            if (!string.IsNullOrEmpty(loc) && Directory.Exists(loc)) return loc;
            return null;
        }

        /// <summary>True when a file can be created in the folder or in its first existing parent.</summary>
        public static bool Writable(string dir)
        {
            try
            {
                string p = Path.GetFullPath(dir);
                while (!Directory.Exists(p))
                {
                    string parent = Path.GetDirectoryName(p);
                    if (parent == null || parent == p) return false;
                    p = parent;
                }
                string probe = Path.Combine(p, ".hivedesk-probe-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return true;
            }
            catch (Exception) { return false; }
        }

        public static long FreeSpace(string dir)
        {
            try { return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(dir))).AvailableFreeSpace; } catch (Exception) { return -1; }
        }

        static bool SafeVersion(string v)
        {
            return !string.IsNullOrEmpty(v) && v.Length < 64 && v.All(c => char.IsLetterOrDigit(c) || c == '.' || c == '-' || c == '+');
        }

        static void WriteAtomic(string file, string text)
        {
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(tmp, file, null);
            else File.Move(tmp, file);
        }

        static void RmRf(string dir)
        {
            if (!Directory.Exists(dir)) return;
            foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) { try { File.SetAttributes(f, FileAttributes.Normal); } catch (Exception) { } }
            for (int i = 0; ; i++)
            {
                try { Directory.Delete(dir, true); return; }
                catch (Exception) { if (i >= 4) throw; Thread.Sleep(300); }
            }
        }

        /// <summary>
        /// Installs a verified package zip (hivedesk/ at the top) as versions\&lt;version&gt; and points current.txt at it.
        /// progress(stage, fraction): stage is "extract", "shortcuts" or "register".
        /// </summary>
        public string Install(string zip, string version, Options o, string selfExe, Action<string, double> progress)
        {
            if (!SafeVersion(version)) throw new SetupException("package", "bad version " + version);
            string root = Path.GetFullPath(o.InstallDir);
            // Never into a folder that holds other things: the uninstaller would otherwise have to guess what is ours.
            if (!FolderFree(root)) throw new SetupException("notempty", "the folder is not empty and is not a hivedesk install: " + root);
            Log("install " + version + " into " + root);
            Directory.CreateDirectory(root);
            var created = ReadManifest(root) ?? new List<string>();
            string versions = Path.Combine(root, "versions");
            string dir = Path.Combine(versions, version);
            string staging = Path.Combine(versions, "." + version + ".staging");
            RmRf(staging);
            Directory.CreateDirectory(staging);
            progress("extract", 0);
            using (var archive = ZipFile.OpenRead(zip))
            {
                long total = Math.Max(1, archive.Entries.Sum(e => e.Length));
                long done = 0;
                string stagingFull = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
                foreach (var e in archive.Entries)
                {
                    string name = e.FullName.Replace('\\', '/');
                    int slash = name.IndexOf('/');
                    if (slash < 0) continue;
                    string rel = name.Substring(slash + 1);
                    if (rel.Length == 0) continue;
                    if (rel.Split('/').Any(p => p == ".." || p.Contains(":"))) throw new SetupException("package", "unsafe path " + name);
                    string dest = Path.GetFullPath(Path.Combine(staging, rel.Replace('/', Path.DirectorySeparatorChar)));
                    if (!dest.StartsWith(stagingFull, StringComparison.OrdinalIgnoreCase)) throw new SetupException("package", "unsafe path " + name);
                    if (name.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                    done += e.Length;
                    progress("extract", (double)done / total);
                }
            }
            if (!File.Exists(Path.Combine(staging, "app", "desktop", "main.js")) || !File.Exists(Path.Combine(staging, "node", "node.exe")) || !File.Exists(Path.Combine(staging, "hivedesk.exe")))
                throw new SetupException("package", "the package has no app, Node runtime or launcher");
            string previous = InstalledVersion(root);
            if (previous == version) previous = null;
            RmRf(dir);
            Directory.Move(staging, dir);

            // The root launcher: a running hivedesk.exe can be renamed, not overwritten.
            string launcher = Path.Combine(root, "hivedesk.exe");
            if (File.Exists(launcher))
            {
                string old = launcher + ".old";
                try { if (File.Exists(old)) File.Delete(old); } catch (Exception) { }
                File.Move(launcher, old);
            }
            File.Copy(Path.Combine(dir, "hivedesk.exe"), launcher, true);
            WriteAtomic(Path.Combine(root, "current.txt"), version + "\n");
            // Keep the version that was there as the rollback, drop older ones.
            foreach (var d in Directory.GetDirectories(versions))
            {
                string n = Path.GetFileName(d);
                if (n != version && n != previous) { try { RmRf(d); } catch (Exception) { } }
            }
            File.WriteAllText(Path.Combine(root, "update-state.json"), "{\"state\":\"ok\",\"version\":\"" + version + "\"" + (previous != null ? ",\"previous\":\"" + previous + "\"" : "") + "}");

            // The uninstaller: this program, or the small online build that the offline build carries.
            string uninstaller = Path.Combine(root, "uninstall.exe");
            if (Res.Has("uninstall.exe"))
            {
                using (var s = Res.Open("uninstall.exe"))
                using (var f = File.Create(uninstaller)) s.CopyTo(f);
            }
            else if (!string.Equals(Path.GetFullPath(selfExe), uninstaller, StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(selfExe, uninstaller, true);
            }
            using (var s = Res.Open("hivedesk.ico"))
            using (var f = File.Create(Path.Combine(root, "hivedesk.ico"))) s.CopyTo(f);
            // The manifest: what this install created at the top of the folder, merged with what earlier installs did.
            foreach (var n in Owned) if (File.Exists(Path.Combine(root, n)) || Directory.Exists(Path.Combine(root, n))) if (!created.Contains(n, StringComparer.OrdinalIgnoreCase)) created.Add(n);
            if (!created.Contains(ManifestName)) created.Add(ManifestName);
            WriteAtomic(Path.Combine(root, ManifestName), string.Join("\n", created) + "\n");

            progress("shortcuts", 0);
            string lnk = "hivedesk.lnk";
            if (o.StartMenu) { Directory.CreateDirectory(T.StartMenuDir); Shortcut.Create(Path.Combine(T.StartMenuDir, lnk), launcher, root, launcher); }
            else TryDelete(Path.Combine(T.StartMenuDir, lnk));
            if (o.Desktop) { Directory.CreateDirectory(T.DesktopDir); Shortcut.Create(Path.Combine(T.DesktopDir, lnk), launcher, root, launcher); }
            else TryDelete(Path.Combine(T.DesktopDir, lnk));

            progress("register", 0);
            if (o.StartWithWindows) T.Reg.SetRun("\"" + launcher + "\"");
            else T.Reg.DeleteRun();
            long kb = DirSize(dir) / 1024;
            T.Reg.SetUninstall(new Dictionary<string, object>
            {
                { "DisplayName", "hivedesk" },
                { "DisplayVersion", version },
                { "Publisher", "Alexandre Kohler" },
                { "DisplayIcon", launcher + ",0" },
                { "InstallLocation", root },
                { "UninstallString", "\"" + uninstaller + "\" --uninstall" },
                { "QuietUninstallString", "\"" + uninstaller + "\" --uninstall --quiet" },
                { "URLInfoAbout", "https://github.com/kwy404/hivedesk" },
                { "HelpLink", "https://kwy404.github.io/hivedesk/" },
                { "URLUpdateInfo", "https://github.com/kwy404/hivedesk/releases" },
                { "InstallDate", DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture) },
                { "EstimatedSize", (int)Math.Min(int.MaxValue, kb) },
                { "NoModify", 1 },
                { "NoRepair", 1 }
            });
            WriteUpdatePrefs(o.AutoUpdate);
            progress("register", 1);
            Log("installed " + version);
            return root;
        }

        /// <summary>The app's update setting (~/.hivedesk/update/prefs.json), keeping the other keys.</summary>
        void WriteUpdatePrefs(bool autoUpdate)
        {
            string file = Path.Combine(T.Home, "update", "prefs.json");
            var ser = new JavaScriptSerializer();
            Dictionary<string, object> d = null;
            try { if (File.Exists(file)) d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(file)); } catch (Exception) { d = null; }
            if (d == null) d = new Dictionary<string, object>();
            d["autoUpdate"] = autoUpdate;
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, ser.Serialize(d));
        }

        static long DirSize(string dir)
        {
            try { return Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length); } catch (Exception) { return 0; }
        }

        static void TryDelete(string f) { try { if (File.Exists(f)) File.Delete(f); } catch (Exception) { } }

        /// <summary>Processes started from inside the install folder (the launcher, Node, the runtime).</summary>
        public static List<Process> RunningFrom(string root)
        {
            var list = new List<Process>();
            string r = Path.GetFullPath(root).TrimEnd('\\') + "\\";
            int self = Process.GetCurrentProcess().Id;
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (p.Id == self) continue;
                    string path = p.MainModule.FileName;
                    if (path.StartsWith(r, StringComparison.OrdinalIgnoreCase)) list.Add(p);
                }
                catch (Exception) { }
            }
            return list;
        }

        /// <summary>Removes the install folder, shortcuts and registry entries; the projects are never touched.</summary>
        public void Uninstall(string root, bool removeData, Action<double> progress)
        {
            root = Path.GetFullPath(root);
            if (!IsHivedeskInstall(root))
                throw new SetupException("package", "this is not a hivedesk install folder: " + root);
            Log("uninstall " + root);
            foreach (var p in RunningFrom(root)) { try { p.Kill(); p.WaitForExit(5000); } catch (Exception) { } }
            progress(0.2);
            TryDelete(Path.Combine(T.StartMenuDir, "hivedesk.lnk"));
            TryDelete(Path.Combine(T.DesktopDir, "hivedesk.lnk"));
            T.Reg.DeleteRun();
            T.Reg.DeleteUninstall();
            progress(0.4);
            // The running uninstaller may live in the folder: everything else goes now, the folder at exit.
            // Only what the installer created (the manifest; the fixed list for an install from before 1.0): a file
            // someone put in the folder later stays, and so does the folder then.
            string self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            var owned = ReadManifest(root) ?? Owned.ToList();
            var files = new List<string>();
            foreach (var n in owned)
            {
                string p = Path.Combine(root, n);
                if (Directory.Exists(p)) RmRf(p);
                else if (File.Exists(p)) files.Add(p);
            }
            // Leftovers of an atomic write by the in-app updater (current.txt.<pid>.<time>.tmp).
            foreach (var f in Directory.GetFiles(root))
            {
                string n = Path.GetFileName(f);
                if (n.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase) && (n.StartsWith("current.txt.", StringComparison.OrdinalIgnoreCase) || n.StartsWith("update-state.json.", StringComparison.OrdinalIgnoreCase) || n.StartsWith(ManifestName + ".", StringComparison.OrdinalIgnoreCase))) files.Add(f);
            }
            // The manifest goes last, so a failed uninstall can run again.
            files = files.OrderBy(f => string.Equals(Path.GetFileName(f), ManifestName, StringComparison.OrdinalIgnoreCase) ? 1 : 0).ToList();
            foreach (var f in files)
            {
                if (string.Equals(Path.GetFullPath(f), self, StringComparison.OrdinalIgnoreCase)) continue;
                File.SetAttributes(f, FileAttributes.Normal);
                File.Delete(f);
            }
            progress(0.8);
            if (Directory.GetFileSystemEntries(root).Length == 0) Directory.Delete(root);
            if (removeData && Directory.Exists(T.Home)) RmRf(T.Home);
            progress(1);
            Log("uninstalled");
        }

        /// <summary>WebView2, which the hivedesk window needs (read only check of the registry).</summary>
        public static bool WebView2Installed()
        {
            const string id = @"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            string[] keys = { @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\" + id, @"SOFTWARE\Microsoft\EdgeUpdate\Clients\" + id };
            foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
                foreach (var k in keys)
                {
                    try
                    {
                        using (var key = hive.OpenSubKey(k))
                        {
                            var v = key == null ? null : key.GetValue("pv") as string;
                            if (!string.IsNullOrEmpty(v) && v != "0.0.0.0") return true;
                        }
                    }
                    catch (Exception) { }
                }
            return false;
        }
    }

    /// <summary>
    /// The size of the Windows app package as the release's latest.json lists it. Only for what the pages show:
    /// the download itself stays pinned to the SHA-256 and size this installer was built with.
    /// </summary>
    public static class ReleaseInfo
    {
        public static string ManifestUrl(string version)
        {
            return "https://github.com/kwy404/hivedesk/releases/download/v" + version + "/latest.json";
        }

        /// <summary>assets["windows-x64"].size of a manifest for this version, or -1.</summary>
        public static long PackageSize(string json, string version)
        {
            try
            {
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                if (d == null || (d["product"] as string) != "hivedesk" || (d["version"] as string) != version) return -1;
                var assets = d["assets"] as Dictionary<string, object>;
                var win = assets == null ? null : assets["windows-x64"] as Dictionary<string, object>;
                if (win == null) return -1;
                long size = Convert.ToInt64(win["size"], CultureInfo.InvariantCulture);
                return size > 0 ? size : -1;
            }
            catch (Exception) { return -1; }
        }

        public static long Fetch(string version)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(ManifestUrl(version));
                req.UserAgent = "hivedesk-setup";
                req.Timeout = 15000;
                req.ReadWriteTimeout = 15000;
                using (var res = req.GetResponse())
                using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    char[] buf = new char[256 * 1024];
                    int n = r.ReadBlock(buf, 0, buf.Length);
                    return PackageSize(new string(buf, 0, n), version);
                }
            }
            catch (Exception) { return -1; }
        }
    }

    /// <summary>Downloads one file on a background thread, with resume (HTTP Range on a .part file).</summary>
    public class Downloader
    {
        public long Got, Total;
        public double Speed;
        public bool Running, Finished;
        public Exception Error;
        volatile bool cancel;
        Thread thread;

        static Downloader()
        {
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
        }

        /// <summary>onProgress and onDone run on the download thread.</summary>
        public void Start(string url, string dest, long size, Action onProgress, Action onDone)
        {
            if (Running) return;
            cancel = false;
            Error = null;
            Finished = false;
            Running = true;
            Total = size;
            thread = new Thread(() =>
            {
                try { Run(url, dest, size, onProgress); Finished = true; }
                catch (Exception e) { Error = e; }
                finally { Running = false; if (onDone != null) onDone(); }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        public void Cancel() { cancel = true; }

        public void Wait() { if (thread != null) thread.Join(); }

        void Run(string url, string dest, long size, Action onProgress)
        {
            string part = dest + ".part";
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            if (File.Exists(dest) && new FileInfo(dest).Length == size) { Got = size; if (onProgress != null) onProgress(); return; }
            long have = File.Exists(part) ? new FileInfo(part).Length : 0;
            if (have > size) { File.Delete(part); have = 0; }
            var req = WebRequest.Create(url);
            var http = req as HttpWebRequest;
            if (http != null)
            {
                http.UserAgent = "hivedesk-setup";
                http.AllowAutoRedirect = true;
                http.Timeout = 30000;
                http.ReadWriteTimeout = 30000;
                if (have > 0) http.AddRange(have);
            }
            else have = 0;
            using (var res = req.GetResponse())
            {
                var hres = res as HttpWebResponse;
                bool resumed = hres != null && hres.StatusCode == HttpStatusCode.PartialContent && have > 0;
                if (!resumed) have = 0;
                using (var input = res.GetResponseStream())
                using (var output = new FileStream(part, resumed ? FileMode.Append : FileMode.Create, FileAccess.Write))
                {
                    var buf = new byte[1 << 16];
                    Got = have;
                    var sw = Stopwatch.StartNew();
                    long lastBytes = Got;
                    double lastT = 0;
                    int n;
                    while ((n = input.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (cancel) throw new OperationCanceledException();
                        output.Write(buf, 0, n);
                        Got += n;
                        if (Got > size) throw new SetupException("network", "the file is larger than expected");
                        double t = sw.Elapsed.TotalSeconds;
                        if (t - lastT >= 0.25)
                        {
                            double inst = (Got - lastBytes) / (t - lastT);
                            Speed = Speed <= 0 ? inst : Speed * 0.7 + inst * 0.3;
                            lastBytes = Got;
                            lastT = t;
                            if (onProgress != null) onProgress();
                        }
                    }
                }
            }
            if (Got != size) throw new SetupException("network", "the download ended early (" + Got + " of " + size + " bytes)");
            if (File.Exists(dest)) File.Delete(dest);
            File.Move(part, dest);
            if (onProgress != null) onProgress();
        }
    }

    /// <summary>Windows shortcuts (.lnk) through the shell's own COM object.</summary>
    public static class Shortcut
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        class CShellLink { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
            void GetIDList(out IntPtr ppidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
            void GetHotkey(out short pwHotkey);
            void SetHotkey(short wHotkey);
            void GetShowCmd(out int piShowCmd);
            void SetShowCmd(int iShowCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
            void Resolve(IntPtr hwnd, int fFlags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
        }

        public static void Create(string lnk, string target, string workDir, string icon)
        {
            var link = (IShellLinkW)new CShellLink();
            link.SetPath(target);
            link.SetWorkingDirectory(workDir);
            link.SetIconLocation(icon, 0);
            link.SetDescription("hivedesk");
            ((System.Runtime.InteropServices.ComTypes.IPersistFile)link).Save(lnk, true);
            Marshal.FinalReleaseComObject(link);
        }

        public static string TargetOf(string lnk)
        {
            var link = (IShellLinkW)new CShellLink();
            ((System.Runtime.InteropServices.ComTypes.IPersistFile)link).Load(lnk, 0);
            var sb = new StringBuilder(1024);
            link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0);
            Marshal.FinalReleaseComObject(link);
            return sb.ToString();
        }
    }

    /// <summary>A tiny local HTTP server with Range support, for the resume self-test only (127.0.0.1).</summary>
    public class TestServer : IDisposable
    {
        readonly TcpListener listener;
        readonly byte[] body;
        public int Requests;
        public string LastRange;
        public int CutAfter = -1;
        public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }

        public TestServer(byte[] body)
        {
            this.body = body;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var t = new Thread(Loop);
            t.IsBackground = true;
            t.Start();
        }

        void Loop()
        {
            while (true)
            {
                TcpClient c;
                try { c = listener.AcceptTcpClient(); } catch (Exception) { return; }
                try { Serve(c); } catch (Exception) { }
                try { c.Close(); } catch (Exception) { }
            }
        }

        void Serve(TcpClient c)
        {
            var s = c.GetStream();
            var r = new StreamReader(s, Encoding.ASCII);
            string line;
            long from = 0;
            string range = null;
            while (!string.IsNullOrEmpty(line = r.ReadLine()))
            {
                if (line.StartsWith("Range:", StringComparison.OrdinalIgnoreCase))
                {
                    range = line.Substring(6).Trim();
                    from = long.Parse(range.Replace("bytes=", "").Split('-')[0], CultureInfo.InvariantCulture);
                }
            }
            Requests++;
            LastRange = range;
            long len = body.Length - from;
            string head = (range != null ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + from + "-" + (body.Length - 1) + "/" + body.Length + "\r\n" : "HTTP/1.1 200 OK\r\n")
                + "Content-Length: " + len + "\r\nConnection: close\r\n\r\n";
            var hb = Encoding.ASCII.GetBytes(head);
            s.Write(hb, 0, hb.Length);
            int send = (int)len;
            if (CutAfter >= 0 && Requests == 1) send = Math.Min(send, CutAfter);
            s.Write(body, (int)from, send);
            s.Flush();
        }

        public void Dispose() { try { listener.Stop(); } catch (Exception) { } }
    }
}
