# hivedesk input helper for Windows (docs/1.0/PLAN.md section 12.3, option 1: no shipped binary).
# Started only by src/remote/helper.js, and only after this file's SHA-256 matched the entry in
# NATIVE_HELPERS of desktop/native.js. It injects input with SendInput, registers the kill switch
# hotkey Ctrl+Alt+Shift+K, shows an always on top indicator with Stop, and reports the lock state.
#
# stdin, one command per line:
#   M <px> <py>                 move the pointer to virtual desktop pixels
#   B <0|1|2> <0|1>             button left, middle or right; up (0) or down (1)
#   W <dx> <dy>                 wheel, in wheel delta units (120 per notch)
#   K <vk> <ext 0|1> <0|1>      key by virtual key code, extended flag, up or down
#   R                           release every key and button this helper holds down
#   I <off|view|control> <base64 of UTF-8 text>   the indicator
#   P                           ping, answered with {"t":"pong"}
#   C                           cursor position, answered with {"t":"cursor","x":0,"y":0}
#   CW <0|1>                    watch the clipboard (WM_CLIPBOARDUPDATE) off or on
#   CT <b64 text> <b64 html|->  put text, and HTML as CF_HTML, on the clipboard
#   CI <b64 png>                put an image on the clipboard (PNG and DIB)
#   CF <b64 path> ...           put files on the clipboard (CF_HDROP)
# stdout, JSON lines:
#   {"t":"ready","displays":[...],"hotkey":true,"test":false}
#   {"t":"lock","locked":true|false|null,"source":"..."}   on change and every 2 seconds
#   {"t":"hotkey"}   the kill switch hotkey was pressed
#   {"t":"stop"}     Stop was clicked on the indicator
#   {"t":"clip","text":"b64","html":"b64"} or {"t":"clip","png":"b64"} or {"t":"clip","files":["b64",...]}
#                    the person copied something (not reported for what this helper put there itself)
#   {"t":"clipset","ok":true|false}
# With -Test there is no indicator, no hotkey, no clipboard, and only M, R, P and C work (for the test suite).
# The helper releases everything and exits when stdin closes.
param([switch]$Test)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class HdIndicator : Form {
  public HdHelper Helper;
  Label label;
  Button stop;

  public HdIndicator() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(214, 40, 40);
    Padding = new Padding(3);
    Size = new Size(440, 38);
    Panel inner = new Panel();
    inner.Dock = DockStyle.Fill;
    inner.BackColor = Color.FromArgb(28, 22, 18);
    label = new Label();
    label.AutoSize = false;
    label.Dock = DockStyle.Fill;
    label.ForeColor = Color.White;
    label.TextAlign = ContentAlignment.MiddleLeft;
    label.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
    label.Padding = new Padding(10, 0, 0, 0);
    stop = new Button();
    stop.Text = "Stop";
    stop.Dock = DockStyle.Right;
    stop.Width = 72;
    stop.FlatStyle = FlatStyle.Flat;
    stop.ForeColor = Color.White;
    stop.BackColor = Color.FromArgb(214, 40, 40);
    stop.Click += delegate(object s, EventArgs e) { Helper.Emit("{\"t\":\"stop\"}"); };
    inner.Controls.Add(label);
    inner.Controls.Add(stop);
    Controls.Add(inner);
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; // no activate, tool window, topmost
      return cp;
    }
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312) Helper.Emit("{\"t\":\"hotkey\"}");
    if (m.Msg == 0x031D) Helper.OnClipboardUpdate();
    base.WndProc(ref m);
  }

  public void Apply(string mode, string text) {
    if (mode == "off") { Hide(); return; }
    label.Text = text;
    Rectangle wa = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + 6);
    if (!Visible) Show();
    TopMost = true;
  }
}

public class HdHelper {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr h, int index, byte[] info, int len, out int needed);
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr h);
  [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();

  uint ownSeq = 0;
  bool watching = false;
  const int MAX_TEXT = 1024 * 1024;
  const int MAX_HTML = 2 * 1024 * 1024;
  const int MAX_PNG = 8 * 1024 * 1024;

  static string B64(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s)); }
  static string Dec(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }

  // The fragment of a CF_HTML string, by its byte offsets, or between the fragment comments.
  static string HtmlFragment(string raw) {
    if (raw == null) return null;
    byte[] all = Encoding.UTF8.GetBytes(raw);
    System.Text.RegularExpressions.Match a = System.Text.RegularExpressions.Regex.Match(raw, "StartFragment:(\\d+)");
    System.Text.RegularExpressions.Match b = System.Text.RegularExpressions.Regex.Match(raw, "EndFragment:(\\d+)");
    if (a.Success && b.Success) {
      int s = int.Parse(a.Groups[1].Value), e = int.Parse(b.Groups[1].Value);
      if (s >= 0 && e > s && e <= all.Length) return Encoding.UTF8.GetString(all, s, e - s);
    }
    int i = raw.IndexOf("<!--StartFragment-->"), j = raw.IndexOf("<!--EndFragment-->");
    if (i >= 0 && j > i) return raw.Substring(i + 20, j - i - 20);
    return null;
  }

  static string CfHtml(string fragment) {
    const string head = "Version:0.9\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
    const string pre = "<html><body>\r\n<!--StartFragment-->";
    const string post = "<!--EndFragment-->\r\n</body></html>";
    int h = string.Format(head, 0, 0, 0, 0).Length;
    int sf = h + Encoding.UTF8.GetByteCount(pre);
    int ef = sf + Encoding.UTF8.GetByteCount(fragment);
    int eh = ef + Encoding.UTF8.GetByteCount(post);
    return string.Format(head, h, eh, sf, ef) + pre + fragment + post;
  }

  string ReadClipboard() {
    if (Clipboard.ContainsFileDropList()) {
      StringBuilder sb = new StringBuilder("{\"t\":\"clip\",\"files\":[");
      int n = 0;
      foreach (string f in Clipboard.GetFileDropList()) {
        if (n >= 2000) break;
        if (n++ > 0) sb.Append(",");
        sb.Append("\"" + B64(f) + "\"");
      }
      return sb.Append("]}").ToString();
    }
    byte[] png = null;
    if (Clipboard.ContainsData("PNG")) {
      System.IO.MemoryStream o = Clipboard.GetData("PNG") as System.IO.MemoryStream;
      if (o != null) png = o.ToArray();
    }
    if (png == null && Clipboard.ContainsImage()) {
      using (Image img = Clipboard.GetImage()) {
        if (img != null) using (System.IO.MemoryStream ms = new System.IO.MemoryStream()) { img.Save(ms, System.Drawing.Imaging.ImageFormat.Png); png = ms.ToArray(); }
      }
    }
    if (png != null) return png.Length > MAX_PNG ? "{\"t\":\"clip\",\"tooLarge\":\"image\"}" : "{\"t\":\"clip\",\"png\":\"" + Convert.ToBase64String(png) + "\"}";
    string text = Clipboard.ContainsText(TextDataFormat.UnicodeText) ? Clipboard.GetText(TextDataFormat.UnicodeText) : null;
    string html = Clipboard.ContainsText(TextDataFormat.Html) ? HtmlFragment(Clipboard.GetText(TextDataFormat.Html)) : null;
    if (text == null && html == null) return null;
    if ((text != null && text.Length > MAX_TEXT) || (html != null && html.Length > MAX_HTML)) return "{\"t\":\"clip\",\"tooLarge\":\"text\"}";
    return "{\"t\":\"clip\",\"text\":\"" + B64(text ?? "") + "\"" + (html != null ? ",\"html\":\"" + B64(html) + "\"" : "") + "}";
  }

  public void OnClipboardUpdate() {
    if (!watching || GetClipboardSequenceNumber() == ownSeq) return;
    for (int attempt = 0; attempt < 3; attempt++) {
      try { string json = ReadClipboard(); if (json != null) Emit(json); return; }
      catch (ExternalException) { Thread.Sleep(40); }
      catch { return; }
    }
  }

  void ClipSet(string[] p) {
    DataObject d = new DataObject();
    Bitmap keep = null;
    try {
      if (p[0] == "CT" && p.Length >= 2) {
        d.SetText(Dec(p[1]), TextDataFormat.UnicodeText);
        if (p.Length >= 3 && p[2] != "-") d.SetData(DataFormats.Html, new System.IO.MemoryStream(Encoding.UTF8.GetBytes(CfHtml(Dec(p[2])))));
      } else if (p[0] == "CI" && p.Length == 2) {
        byte[] png = Convert.FromBase64String(p[1]);
        keep = new Bitmap(new System.IO.MemoryStream(png));
        d.SetImage(keep);
        d.SetData("PNG", new System.IO.MemoryStream(png));
      } else if (p[0] == "CF" && p.Length >= 2) {
        System.Collections.Specialized.StringCollection sc = new System.Collections.Specialized.StringCollection();
        for (int i = 1; i < p.Length; i++) sc.Add(Dec(p[i]));
        d.SetFileDropList(sc);
      } else { Emit("{\"t\":\"clipset\",\"ok\":false}"); return; }
      for (int attempt = 0; attempt < 3; attempt++) {
        try { Clipboard.SetDataObject(d, true); ownSeq = GetClipboardSequenceNumber(); Emit("{\"t\":\"clipset\",\"ok\":true}"); return; }
        catch (ExternalException) { Thread.Sleep(40); }
      }
      Emit("{\"t\":\"clipset\",\"ok\":false}");
    } catch { Emit("{\"t\":\"clipset\",\"ok\":false}"); }
    finally { if (keep != null) keep.Dispose(); }
  }

  readonly object outLock = new object();
  readonly object inLock = new object();
  readonly HashSet<int> keys = new HashSet<int>();
  readonly bool[] buttons = new bool[3];
  HdIndicator form;
  bool test;

  public void Emit(string json) {
    lock (outLock) { Console.Out.Write(json + "\n"); Console.Out.Flush(); }
  }

  static string Num(int v) { return v.ToString(System.Globalization.CultureInfo.InvariantCulture); }

  void Send(INPUT[] inputs) {
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  INPUT Mouse(int dx, int dy, int data, uint flags) {
    INPUT i = new INPUT();
    i.type = 0;
    i.U.mi.dx = dx; i.U.mi.dy = dy; i.U.mi.mouseData = data; i.U.mi.dwFlags = flags;
    return i;
  }

  void Move(int px, int py) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    if (vw < 2 || vh < 2) return;
    px = Math.Max(vx, Math.Min(vx + vw - 1, px));
    py = Math.Max(vy, Math.Min(vy + vh - 1, py));
    int nx = (int)Math.Round((px - vx) * 65535.0 / (vw - 1));
    int ny = (int)Math.Round((py - vy) * 65535.0 / (vh - 1));
    Send(new INPUT[] { Mouse(nx, ny, 0, 0x0001 | 0x4000 | 0x8000) });
  }

  static readonly uint[] DOWN = { 0x0002, 0x0020, 0x0008 };
  static readonly uint[] UP = { 0x0004, 0x0040, 0x0010 };

  void Button(int b, bool down) {
    if (b < 0 || b > 2 || buttons[b] == down) return;
    buttons[b] = down;
    Send(new INPUT[] { Mouse(0, 0, 0, down ? DOWN[b] : UP[b]) });
  }

  void Wheel(int dx, int dy) {
    if (dy != 0) Send(new INPUT[] { Mouse(0, 0, Math.Max(-1200, Math.Min(1200, dy)), 0x0800) });
    if (dx != 0) Send(new INPUT[] { Mouse(0, 0, Math.Max(-1200, Math.Min(1200, dx)), 0x1000) });
  }

  void Key(int vk, bool ext, bool down) {
    if (vk <= 0 || vk > 254) return;
    int id = vk * 2 + (ext ? 1 : 0);
    if (down) keys.Add(id); else if (!keys.Remove(id)) return;
    INPUT i = new INPUT();
    i.type = 1;
    i.U.ki.wVk = (ushort)vk;
    i.U.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
    i.U.ki.dwFlags = (ext ? 0x0001u : 0u) | (down ? 0u : 0x0002u);
    Send(new INPUT[] { i });
  }

  void Release() {
    foreach (int id in new List<int>(keys)) Key(id / 2, (id & 1) == 1, false);
    keys.Clear();
    for (int b = 0; b < 3; b++) if (buttons[b]) Button(b, false);
  }

  static bool? WtsLocked() {
    IntPtr buf; int bytes;
    try {
      if (!WTSQuerySessionInformationW(IntPtr.Zero, -1, 25, out buf, out bytes)) return null;
    } catch { return null; }
    try {
      if (bytes < 20 || Marshal.ReadInt32(buf, 0) != 1) return null;
      // Check the layout: the session id in WTSINFOEX_LEVEL1 must be ours, or the offsets are wrong.
      if (Marshal.ReadInt32(buf, 8) != Process.GetCurrentProcess().SessionId) return null;
      int flags = Marshal.ReadInt32(buf, 16);
      if (flags == 0) return true;
      if (flags == 1) return false;
      return null;
    } finally { WTSFreeMemory(buf); }
  }

  static bool? DesktopLocked() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return true; // the lock screen and the secure desktop are not ours to open
    try {
      byte[] name = new byte[256]; int need;
      if (!GetUserObjectInformationW(d, 2, name, name.Length, out need)) return null;
      string s = Encoding.Unicode.GetString(name, 0, Math.Max(0, Math.Min(name.Length, need) - 2)).TrimEnd('\0');
      return !string.Equals(s, "Default", StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(d); }
  }

  void LockLoop() {
    string last = "";
    DateTime sent = DateTime.MinValue;
    while (true) {
      bool? w = WtsLocked();
      bool? d = DesktopLocked();
      string v;
      if (w == true || d == true) v = "true";
      else if (w == false || d == false) v = "false";
      else v = "null";
      string src = (w.HasValue ? "wts" : "") + (d.HasValue ? (w.HasValue ? "+desktop" : "desktop") : "");
      if (v != last || (DateTime.UtcNow - sent).TotalMilliseconds >= 2000) {
        if (v == "true") lock (inLock) { Release(); }
        Emit("{\"t\":\"lock\",\"locked\":" + v + ",\"source\":\"" + (src == "" ? "none" : src) + "\"}");
        last = v;
        sent = DateTime.UtcNow;
      }
      Thread.Sleep(400);
    }
  }

  string Displays() {
    StringBuilder sb = new StringBuilder("[");
    Screen[] all = Screen.AllScreens;
    for (int i = 0; i < all.Length; i++) {
      Rectangle b = all[i].Bounds;
      if (i > 0) sb.Append(",");
      sb.Append("{\"x\":" + Num(b.X) + ",\"y\":" + Num(b.Y) + ",\"w\":" + Num(b.Width) + ",\"h\":" + Num(b.Height) + ",\"primary\":" + (all[i].Primary ? "true" : "false") + "}");
    }
    return sb.Append("]").ToString();
  }

  void Handle(string line) {
    string[] p = line.Trim().Split(' ');
    if (p.Length == 0 || p[0].Length == 0) return;
    int a = 0, b = 0, c = 0;
    if (p.Length > 1) int.TryParse(p[1], out a);
    if (p.Length > 2) int.TryParse(p[2], out b);
    if (p.Length > 3) int.TryParse(p[3], out c);
    switch (p[0]) {
      case "M": if (p.Length == 3) Move(a, b); break;
      case "B": if (!test && p.Length == 3) Button(a, b == 1); break;
      case "W": if (!test && p.Length == 3) Wheel(a, b); break;
      case "K": if (!test && p.Length == 4) Key(a, b == 1, c == 1); break;
      case "R": Release(); break;
      case "P": Emit("{\"t\":\"pong\"}"); break;
      case "C": { POINT pt; GetCursorPos(out pt); Emit("{\"t\":\"cursor\",\"x\":" + Num(pt.X) + ",\"y\":" + Num(pt.Y) + "}"); break; }
      case "CW": {
        if (test || form == null) break;
        bool on = a == 1;
        form.BeginInvoke((MethodInvoker)delegate {
          if (on && !watching) watching = AddClipboardFormatListener(form.Handle);
          else if (!on && watching) { RemoveClipboardFormatListener(form.Handle); watching = false; }
        });
        break;
      }
      case "CT": case "CI": case "CF": {
        if (test || form == null) break;
        string[] parts = p;
        form.BeginInvoke((MethodInvoker)delegate { ClipSet(parts); });
        break;
      }
      case "I": {
        if (test || form == null || p.Length < 2) break;
        string mode = p[1];
        string text = "";
        try { if (p.Length > 2) text = Encoding.UTF8.GetString(Convert.FromBase64String(p[2])); } catch { text = ""; }
        if (text.Length > 120) text = text.Substring(0, 120);
        form.BeginInvoke((MethodInvoker)delegate { form.Apply(mode, text); });
        break;
      }
    }
  }

  void ReadLoop() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      // Input lines are short; clipboard lines carry base64 content up to the caps.
      if (line.Length > 200 && !(line.StartsWith("C") && line.Length <= 16 * 1024 * 1024)) continue;
      lock (inLock) { Handle(line); }
    }
    lock (inLock) { Release(); }
    Environment.Exit(0);
  }

  public void Run(bool testMode) {
    test = testMode;
    try { SetProcessDPIAware(); } catch { }
    Console.InputEncoding = new UTF8Encoding(false);
    bool hotkey = false;
    if (!test) {
      form = new HdIndicator();
      form.Helper = this;
      IntPtr h = form.Handle;
      hotkey = RegisterHotKey(h, 1, 0x0001 | 0x0002 | 0x0004 | 0x4000, 0x4B);
    }
    Emit("{\"t\":\"ready\",\"displays\":" + Displays() + ",\"hotkey\":" + (hotkey ? "true" : "false") + ",\"test\":" + (test ? "true" : "false") + "}");
    Thread locks = new Thread(LockLoop); locks.IsBackground = true; locks.Start();
    Thread reader = new Thread(ReadLoop); reader.IsBackground = true; reader.Start();
    Application.Run(new ApplicationContext());
  }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
$helper = New-Object HdHelper
$helper.Run($Test.IsPresent)
