// hivedesk-setup.exe: the installer window. WPF built in code over two XAML resource dictionaries
// (Theme.xaml: colors, type and controls; Art.xaml: the tour illustrations).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Documents;
using Ellipse = System.Windows.Shapes.Ellipse;
using Shape = System.Windows.Shapes.Shape;
using Vec = System.Windows.Shapes.Path;
using System.Windows.Threading;

namespace HivedeskSetup
{
    /// <summary>The whole installer surface (720 by 480 plus a 16 px shadow margin). Rendered in a window or offscreen.</summary>
    public class SetupView : Grid
    {
        public const double W = 720, H = 480, Shadow = 16;
        public readonly Flow Flow;
        public readonly Engine Engine;
        public readonly Options Opt = new Options();
        public readonly Downloader Dl = new Downloader();
        public readonly bool Offline;
        public readonly bool RenderOnly;
        public string ZipPath;
        public bool Verified;
        public string InstalledRoot;
        public string ErrorText;
        public string UninstallRoot;
        public bool RemoveData;
        public double StageFrac;
        public string Stage = "wait";
        public string SelfExe;
        /// <summary>The package size from latest.json, once known (-1 until then); the offline build never shows one.</summary>
        public long KnownSize = -1;
        TextBlock welcomeMeta;
        public Action CloseRequested, MinimizeRequested, DragRequested;

        Grid page;
        StackPanel actionsRight;
        StackPanel miniStatus;
        TextBlock miniText;
        Border miniFill;
        StackPanel stepList;
        Carousel carousel;
        TextBlock bigStage, bigPercent, bigMeta;
        Border bigFill;
        bool installing;
        readonly DispatcherTimer tick;

        public SetupView(Engine engine, bool uninstall, bool offline, bool renderOnly)
        {
            Engine = engine;
            Flow = new Flow(uninstall);
            Offline = offline;
            RenderOnly = renderOnly;
            Resources.MergedDictionaries.Add(LoadDict("Theme.xaml"));
            Resources.MergedDictionaries.Add(LoadDict("Art.xaml"));
            TextElement.SetFontFamily(this, (FontFamily)FindResource("Ui"));
            TextElement.SetForeground(this, Br("Text"));
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
            Width = W + Shadow * 2;
            Height = H + Shadow * 2;
            string existing = engine.ExistingInstallDir();
            Opt.InstallDir = existing ?? engine.T.DefaultInstallDir;
            UninstallRoot = existing;
            string pn, pa;
            if (Profile.TryRead(engine.T.Home, out pn, out pa)) { profileName = pn; profileAvatar = pa; }
            else profileAvatar = Profile.Gallery[0].Id;
            Build();
            ShowStep(false);
            tick = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            tick.Tick += delegate { RefreshProgress(); };
            if (!renderOnly) tick.Start();
            if (!renderOnly && !offline && !uninstall)
            {
                var th = new Thread(() =>
                {
                    long size = ReleaseInfo.Fetch(Payload.Version);
                    if (size > 0) Dispatcher.BeginInvoke(new Action(() => { KnownSize = size; RefreshSizes(); }));
                });
                th.IsBackground = true;
                th.Start();
            }
        }

        static ResourceDictionary LoadDict(string name)
        {
            using (var s = Res.Open(name)) return (ResourceDictionary)XamlReader.Load(s);
        }

        Brush Br(string key) { return (Brush)FindResource(key); }
        Style St(string key) { return (Style)FindResource(key); }
        static string T(string key, params string[] kv) { return Lang.T(key, kv); }

        TextBlock Text(string s, string style, double size = 0)
        {
            var t = new TextBlock { Text = s, Style = St(style) };
            if (size > 0) t.FontSize = size;
            return t;
        }

        Button Btn(string label, string style, Action click)
        {
            var b = new Button { Content = label, Style = St(style), Margin = new Thickness(10, 0, 0, 0) };
            b.Click += delegate { if (!RenderOnly && click != null) click(); };
            return b;
        }

        Image MarkImage(double size)
        {
            return new Image { Source = (ImageSource)FindResource("Mark"), Width = size, Height = size, SnapsToDevicePixels = true };
        }

        // ---------------------------------------------------------------- layout

        void Build()
        {
            var frame = new Border
            {
                Margin = new Thickness(Shadow),
                CornerRadius = new CornerRadius(14),
                Background = Br("Bg"),
                BorderBrush = Br("Line"),
                BorderThickness = new Thickness(1),
                Effect = new DropShadowEffect { BlurRadius = 26, ShadowDepth = 6, Direction = 270, Opacity = 0.6, Color = Colors.Black }
            };
            Children.Add(frame);
            var inner = new Grid { Clip = new RectangleGeometry(new Rect(0, 0, W - 2, H - 2), 13, 13) };
            frame.Child = inner;
            inner.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(252) });
            inner.ColumnDefinitions.Add(new ColumnDefinition());
            inner.MouseLeftButtonDown += (s, e) =>
            {
                if (e.OriginalSource is TextBox || FindParent<ButtonBase>(e.OriginalSource as DependencyObject) != null || FindParent<ScrollBar>(e.OriginalSource as DependencyObject) != null) return;
                if (DragRequested != null) DragRequested();
            };
            inner.Children.Add(BuildSidebar());

            var right = new Grid();
            Grid.SetColumn(right, 1);
            right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(44) });
            right.RowDefinitions.Add(new RowDefinition());
            right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(78) });
            inner.Children.Add(right);

            var chrome = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 6, 8, 0) };
            var min = new Button { Style = St("Chrome"), Content = new Vec { Data = Geometry.Parse("M0,0 H10"), Stroke = Br("Text2"), StrokeThickness = 1.2, Width = 10, Height = 1 } };
            min.Click += delegate { if (MinimizeRequested != null) MinimizeRequested(); };
            var close = new Button { Style = St("Chrome"), Tag = "close", Content = new Vec { Data = Geometry.Parse("M0,0 L10,10 M10,0 L0,10"), Stroke = Br("Text2"), StrokeThickness = 1.2, Width = 10, Height = 10 } };
            ((Vec)close.Content).SetBinding(Shape.StrokeProperty, new System.Windows.Data.Binding("Foreground") { Source = close });
            ((Vec)min.Content).SetBinding(Shape.StrokeProperty, new System.Windows.Data.Binding("Foreground") { Source = min });
            close.Click += delegate { if (CloseRequested != null) CloseRequested(); };
            chrome.Children.Add(min);
            chrome.Children.Add(close);
            right.Children.Add(chrome);

            page = new Grid { Margin = new Thickness(40, 0, 40, 0) };
            Grid.SetRow(page, 1);
            right.Children.Add(page);

            var bar = new Grid { Margin = new Thickness(40, 0, 32, 26), VerticalAlignment = VerticalAlignment.Bottom };
            Grid.SetRow(bar, 2);
            miniStatus = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Left };
            miniText = Text("", "Small", 11.5);
            miniText.TextWrapping = TextWrapping.NoWrap;
            var miniTrack = new Border { Width = 150, Height = 4, CornerRadius = new CornerRadius(2), Background = new SolidColorBrush(Color.FromArgb(0x18, 0xF2, 0xE9, 0xDA)), Margin = new Thickness(0, 7, 0, 0), HorizontalAlignment = HorizontalAlignment.Left };
            miniFill = new Border { Width = 0, CornerRadius = new CornerRadius(2), Background = Br("AmberGrad"), HorizontalAlignment = HorizontalAlignment.Left };
            miniTrack.Child = miniFill;
            miniStatus.Children.Add(miniText);
            miniStatus.Children.Add(miniTrack);
            bar.Children.Add(miniStatus);
            actionsRight = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            bar.Children.Add(actionsRight);
            right.Children.Add(bar);
        }

        static TParent FindParent<TParent>(DependencyObject d) where TParent : DependencyObject
        {
            while (d != null)
            {
                var p = d as TParent;
                if (p != null) return p;
                d = d is Visual || d is System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d);
            }
            return null;
        }

        UIElement BuildSidebar()
        {
            var side = new Grid();
            var bg = new Border
            {
                Background = new LinearGradientBrush(Color.FromRgb(0x1B, 0x1C, 0x20), Color.FromRgb(0x12, 0x13, 0x16), 90),
                BorderBrush = Br("Line"),
                BorderThickness = new Thickness(0, 0, 1, 0)
            };
            side.Children.Add(bg);
            side.Children.Add(new Border { Background = Br("Comb"), Opacity = 0.9 });
            var glow = new RadialGradientBrush(Color.FromArgb(0x38, 0xFF, 0xB5, 0x31), Color.FromArgb(0, 0xFF, 0xB5, 0x31)) { Center = new Point(0.5, 0.3), GradientOrigin = new Point(0.5, 0.3), RadiusX = 0.85, RadiusY = 0.45 };
            side.Children.Add(new Border { Background = glow });

            var col = new Grid { Margin = new Thickness(26, 22, 22, 22) };
            col.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            col.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            col.RowDefinitions.Add(new RowDefinition());
            col.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            side.Children.Add(col);

            var brand = new StackPanel { Orientation = Orientation.Horizontal };
            brand.Children.Add(MarkImage(22));
            var name = Text("hivedesk", "Base", 15);
            name.FontWeight = FontWeights.SemiBold;
            name.Margin = new Thickness(9, 0, 0, 1);
            name.VerticalAlignment = VerticalAlignment.Center;
            brand.Children.Add(name);
            var chip = new Border { CornerRadius = new CornerRadius(6), Background = Br("AmberDim"), Padding = new Thickness(7, 2, 7, 3), Margin = new Thickness(9, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            var chipText = Text(T("chip.setup"), "Base", 10.5);
            chipText.Foreground = Br("Amber");
            chipText.FontWeight = FontWeights.SemiBold;
            chipText.TextWrapping = TextWrapping.NoWrap;
            chip.Child = chipText;
            brand.Children.Add(chip);
            col.Children.Add(brand);

            var hero = new StackPanel { Margin = new Thickness(0, 28, 0, 0) };
            var big = MarkImage(62);
            big.HorizontalAlignment = HorizontalAlignment.Left;
            big.Effect = new DropShadowEffect { Color = Color.FromRgb(0xF2, 0xA1, 0x1F), BlurRadius = 40, ShadowDepth = 0, Opacity = 0.45 };
            hero.Children.Add(big);
            var tag = Text(T("tagline"), "Base", 14.5);
            tag.FontFamily = (FontFamily)FindResource("UiDisplay");
            tag.FontWeight = FontWeights.SemiBold;
            tag.Margin = new Thickness(0, 14, 0, 0);
            tag.LineHeight = 20;
            hero.Children.Add(tag);
            Grid.SetRow(hero, 1);
            col.Children.Add(hero);

            stepList = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 18) };
            Grid.SetRow(stepList, 2);
            col.Children.Add(stepList);

            var foot = new StackPanel();
            var links = new WrapPanel();
            links.Children.Add(LinkBtn("GitHub", "https://github.com/kwy404/hivedesk"));
            links.Children.Add(Dot());
            links.Children.Add(LinkBtn("npm", "https://www.npmjs.com/package/hivedesk"));
            links.Children.Add(Dot());
            links.Children.Add(LinkBtn(T("footer.site"), "https://kwy404.github.io/hivedesk/"));
            foot.Children.Add(links);
            var byText = Text(T("footer.by"), "Small", 11.5);
            byText.Margin = new Thickness(0, 8, 0, 0);
            foot.Children.Add(byText);
            var by = new WrapPanel { Margin = new Thickness(0, 3, 0, 0) };
            by.Children.Add(LinkBtn("GitHub", "https://github.com/kwy404"));
            by.Children.Add(Dot());
            by.Children.Add(LinkBtn("LinkedIn", "https://www.linkedin.com/in/alexandre-silva-173687256/"));
            foot.Children.Add(by);
            var ver = Text("v" + Payload.Version + "  MIT", "Small", 10.5);
            ver.Margin = new Thickness(0, 6, 0, 0);
            ver.Opacity = 0.7;
            foot.Children.Add(ver);
            Grid.SetRow(foot, 3);
            col.Children.Add(foot);
            return side;
        }

        UIElement Dot()
        {
            var t = Text("·", "Small", 11.5);
            t.Margin = new Thickness(6, 0, 6, 0);
            return t;
        }

        Button LinkBtn(string label, string url)
        {
            var b = new Button { Content = label, Style = St("Link") };
            b.Click += delegate { if (!RenderOnly && !Engine.T.Sandbox) OpenUrl(url); };
            return b;
        }

        static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception) { }
        }

        void RenderSteps()
        {
            stepList.Children.Clear();
            if (Flow.Uninstall) return;
            string[] keys = { "step.welcome", "step.tour", "step.license", "step.location", "step.profile", "step.install" };
            int cur = Flow.Index(Flow.Step);
            for (int i = 0; i < keys.Length; i++)
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };
                bool done = i < cur || Flow.Step == Step.Done;
                bool now = i == cur && Flow.Step != Step.Done;
                FrameworkElement dot;
                if (done)
                {
                    dot = new Vec { Data = Geometry.Parse("M1,5 L4,8 L10,1"), Stroke = Br("Amber"), StrokeThickness = 1.8, Width = 12, Height = 10, Stretch = Stretch.None, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round };
                }
                else
                {
                    var e = new Ellipse { Width = 8, Height = 8, Margin = new Thickness(2, 0, 2, 0), Fill = now ? Br("Amber") : new SolidColorBrush(Color.FromArgb(0x40, 0xF2, 0xE9, 0xDA)) };
                    if (now) e.Effect = new DropShadowEffect { Color = Color.FromRgb(0xFF, 0xB5, 0x31), BlurRadius = 10, ShadowDepth = 0, Opacity = 0.9 };
                    dot = e;
                }
                dot.VerticalAlignment = VerticalAlignment.Center;
                dot.Width = 12;
                row.Children.Add(dot);
                var t = Text(T(keys[i]), "Base", 12.5);
                t.Margin = new Thickness(10, 0, 0, 0);
                t.Foreground = now ? Br("Text") : done ? Br("Text2") : Br("Muted");
                if (now) t.FontWeight = FontWeights.SemiBold;
                row.Children.Add(t);
                stepList.Children.Add(row);
            }
        }

        // ---------------------------------------------------------------- pages

        public void ShowStep(bool animate)
        {
            if (carousel != null) carousel.Stop();
            carousel = null;
            bigFill = null;
            page.Children.Clear();
            actionsRight.Children.Clear();
            RenderSteps();
            FrameworkElement content;
            switch (Flow.Step)
            {
                case Step.Welcome: content = PageWelcome(); break;
                case Step.Tour: content = PageTour(); break;
                case Step.License: content = PageLicense(); break;
                case Step.Location: content = PageLocation(); break;
                case Step.Profile: content = PageProfile(); break;
                case Step.Installing: content = PageInstalling(); break;
                case Step.Done: content = PageDone(); break;
                case Step.Failed: content = PageFailed(); break;
                case Step.UConfirm: content = PageUninstall(); break;
                case Step.URemoving: content = PageRemoving(); break;
                default: content = PageUninstalled(); break;
            }
            page.Children.Add(content);
            RefreshProgress();
            if (animate)
            {
                var tt = new TranslateTransform(14, 0);
                content.RenderTransform = tt;
                content.Opacity = 0;
                var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
                content.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260)));
                tt.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(14, 0, TimeSpan.FromMilliseconds(320)) { EasingFunction = ease });
            }
        }

        public void Go(Ev e)
        {
            if (!Flow.Fire(e)) return;
            if (Flow.NeedsDownload(Flow.Step)) StartDownload();
            ShowStep(!RenderOnly);
            if (Flow.Step == Step.Installing) BeginInstall();
            if (Flow.Step == Step.URemoving) BeginUninstall();
        }

        StackPanel Column() { return new StackPanel { VerticalAlignment = VerticalAlignment.Top }; }

        TextBlock Eyebrow(string s)
        {
            var t = Text(s.ToUpperInvariant(), "Base", 11);
            t.Foreground = Br("Amber");
            t.FontWeight = FontWeights.SemiBold;
            t.Margin = new Thickness(0, 0, 0, 8);
            return t;
        }

        FrameworkElement PageWelcome()
        {
            var c = Column();
            c.Margin = new Thickness(0, 10, 0, 0);
            c.Children.Add(Eyebrow("hivedesk " + Payload.Version));
            c.Children.Add(Text(T("welcome.title"), "H1"));
            c.Children.Add(Text(T("welcome.body"), "Body"));
            var list = new StackPanel { Margin = new Thickness(0, 22, 0, 0) };
            string[] icons = {
                "M2,13 L8,9 L8,2 L14,6 L14,13 Z M10,13 V9 M4,13 V11",
                "M3,8 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0 Z M9,8 H13 M13,8 a2,2 0 1 0 4,0 a2,2 0 1 0 -4,0 Z",
                "M8,1 L14,4 V8 C14,11 11.5,13.5 8,15 C4.5,13.5 2,11 2,8 V4 Z M5.5,8 L7.3,9.8 L10.8,6.2"
            };
            for (int i = 0; i < 3; i++)
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12) };
                var box = new Border { Width = 32, Height = 32, CornerRadius = new CornerRadius(9), Background = Br("AmberDim"), BorderBrush = new SolidColorBrush(Color.FromArgb(0x33, 0xFF, 0xB5, 0x31)), BorderThickness = new Thickness(1) };
                box.Child = new Vec { Data = Geometry.Parse(icons[i]), Stroke = Br("Amber"), StrokeThickness = 1.5, Width = 18, Height = 16, Stretch = Stretch.Uniform, StrokeLineJoin = PenLineJoin.Round, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
                row.Children.Add(box);
                var t = Text(T("welcome.f" + (i + 1)), "Base", 13.5);
                t.VerticalAlignment = VerticalAlignment.Center;
                t.Margin = new Thickness(14, 0, 0, 0);
                t.Width = 360;
                row.Children.Add(t);
                list.Children.Add(row);
            }
            c.Children.Add(list);
            welcomeMeta = Text(WelcomeMeta(), "Small");
            welcomeMeta.Margin = new Thickness(0, 10, 0, 0);
            c.Children.Add(welcomeMeta);
            actionsRight.Children.Add(Btn(T("welcome.start"), "Primary", () => Go(Ev.Next)));
            return c;
        }

        /// <summary>The size line: the download size only when latest.json gave it, never in the offline build.</summary>
        public string WelcomeMeta()
        {
            return !Offline && KnownSize > 0 ? T("welcome.meta", "size", Lang.Megabytes(KnownSize)) : T("welcome.noAdmin");
        }

        void RefreshSizes()
        {
            if (welcomeMeta != null && Flow.Step == Step.Welcome) welcomeMeta.Text = WelcomeMeta();
            RefreshProgress();
        }

        FrameworkElement PageTour()
        {
            var c = Column();
            var title = Text(T("tour.title"), "H1", 20);
            title.Margin = new Thickness(0, 4, 0, 14);
            c.Children.Add(title);
            carousel = new Carousel(this, 150, RenderOnly);
            c.Children.Add(carousel);
            actionsRight.Children.Add(Btn(T("nav.back"), "Ghost", () => Go(Ev.Back)));
            actionsRight.Children.Add(Btn(T("nav.next"), "Primary", () => Go(Ev.Next)));
            return c;
        }

        FrameworkElement PageLicense()
        {
            var c = Column();
            c.Children.Add(Text(T("license.title"), "H1"));
            c.Children.Add(Text(T("license.intro"), "Body"));
            var box = new Border { Margin = new Thickness(0, 16, 0, 0), CornerRadius = new CornerRadius(12), Background = new SolidColorBrush(Color.FromRgb(0x0D, 0x0E, 0x10)), BorderBrush = Br("Line"), BorderThickness = new Thickness(1), Height = 222 };
            var sv = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(16, 12, 10, 12) };
            var lic = new TextBlock { Text = Res.Text("LICENSE"), FontFamily = (FontFamily)FindResource("Mono"), FontSize = 11.5, Foreground = Br("Text2"), TextWrapping = TextWrapping.Wrap, LineHeight = 17 };
            sv.Content = lic;
            box.Child = sv;
            c.Children.Add(box);
            actionsRight.Children.Add(Btn(T("nav.back"), "Ghost", () => Go(Ev.Back)));
            actionsRight.Children.Add(Btn(T("license.accept"), "Primary", () => Go(Ev.Next)));
            return c;
        }

        TextBlock locInfo;
        Button installBtn;

        FrameworkElement PageLocation()
        {
            var c = Column();
            c.Children.Add(Text(T("location.title"), "H1"));
            c.Children.Add(Text(T("location.body"), "Body"));
            var row = new Grid { Margin = new Thickness(0, 18, 0, 0) };
            row.ColumnDefinitions.Add(new ColumnDefinition());
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var field = new TextBox { Style = St("Field"), Text = Opt.InstallDir };
            field.TextChanged += delegate { Opt.InstallDir = field.Text; CheckLocation(); };
            field.Loaded += delegate { field.CaretIndex = field.Text.Length; field.ScrollToHorizontalOffset(double.MaxValue); };
            row.Children.Add(field);
            var change = Btn(T("location.change"), "Secondary", () =>
            {
                using (var dlg = new System.Windows.Forms.FolderBrowserDialog { Description = T("location.pick"), SelectedPath = Directory.Exists(Opt.InstallDir) ? Opt.InstallDir : Path.GetDirectoryName(Opt.InstallDir) })
                {
                    if (dlg.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                    {
                        string p = dlg.SelectedPath;
                        // A picked parent gets its own hivedesk subfolder; so does a folder named hivedesk that holds other things.
                        if (!string.Equals(Path.GetFileName(p), "hivedesk", StringComparison.OrdinalIgnoreCase) || !Engine.FolderFree(p)) p = Path.Combine(p, "hivedesk");
                        field.Text = p;
                    }
                }
            });
            Grid.SetColumn(change, 1);
            row.Children.Add(change);
            c.Children.Add(row);
            locInfo = Text("", "Small");
            locInfo.Margin = new Thickness(2, 8, 0, 18);
            c.Children.Add(locInfo);
            c.Children.Add(Switch(T("opt.startMenu"), Opt.StartMenu, v => Opt.StartMenu = v));
            c.Children.Add(Switch(T("opt.desktop"), Opt.Desktop, v => Opt.Desktop = v));
            c.Children.Add(Switch(T("opt.startup"), Opt.StartWithWindows, v => Opt.StartWithWindows = v));
            c.Children.Add(Switch(T("opt.autoUpdate"), Opt.AutoUpdate, v => Opt.AutoUpdate = v));
            actionsRight.Children.Add(Btn(T("nav.back"), "Ghost", () => Go(Ev.Back)));
            installBtn = Btn(T("nav.next"), "Primary", () => Go(Ev.Next));
            actionsRight.Children.Add(installBtn);
            CheckLocation();
            return c;
        }

        string profileName = "", profileAvatar;
        TextBlock profileError;
        Button profileInstall;
        Border profileBig;
        WrapPanel profileGrid;

        static Brush Hex(string hex) { return (Brush)new BrushConverter().ConvertFromString(hex); }

        Border Monogram(Profile.Avatar a, double size, string text, bool selected)
        {
            var b = new Border { Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), Background = Hex(a.Bg) };
            var t = new TextBlock { Text = text, Foreground = Hex(a.Fg), FontWeight = FontWeights.Bold, FontSize = size * 0.36, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            b.Child = t;
            if (selected) b.Effect = new DropShadowEffect { Color = Color.FromRgb(0xF2, 0xA9, 0x3B), BlurRadius = 0, ShadowDepth = 0, Opacity = 1 };
            return b;
        }

        void PaintProfile()
        {
            if (profileGrid == null) return;
            string ini = Profile.Initials(profileName);
            if (ini.Length == 0) ini = "?";
            var a = Profile.Gallery.FirstOrDefault(x => x.Id == profileAvatar) ?? Profile.Gallery[0];
            profileBig.Background = Hex(a.Bg);
            ((TextBlock)profileBig.Child).Text = ini;
            ((TextBlock)profileBig.Child).Foreground = Hex(a.Fg);
            profileGrid.Children.Clear();
            foreach (var g in Profile.Gallery)
            {
                var av = g;
                bool on = g.Id == profileAvatar;
                var ring = new Border { Width = 42, Height = 42, CornerRadius = new CornerRadius(21), Margin = new Thickness(0, 0, 6, 6), BorderThickness = new Thickness(2), BorderBrush = on ? Br("Amber") : Brushes.Transparent, Padding = new Thickness(2), Cursor = Cursors.Hand, Background = Brushes.Transparent };
                ring.Child = Monogram(g, 34, ini, false);
                ring.MouseLeftButtonUp += delegate { profileAvatar = av.Id; PaintProfile(); };
                profileGrid.Children.Add(ring);
            }
            bool tooLong = Profile.Length((profileName ?? "").Trim()) > Profile.NameMax;
            profileError.Text = tooLong ? T("profile.tooLong") : "";
            if (profileInstall != null) profileInstall.IsEnabled = Profile.CleanName(profileName) != null;
        }

        FrameworkElement PageProfile()
        {
            var c = Column();
            var head = new Grid();
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            head.ColumnDefinitions.Add(new ColumnDefinition());
            profileBig = new Border { Width = 58, Height = 58, CornerRadius = new CornerRadius(29), Margin = new Thickness(0, 4, 16, 0), VerticalAlignment = VerticalAlignment.Top };
            profileBig.Child = new TextBlock { FontWeight = FontWeights.Bold, FontSize = 21, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            head.Children.Add(profileBig);
            var titles = new StackPanel();
            var h = Text(T("profile.title"), "H1", 22);
            h.Margin = new Thickness(0, 0, 0, 6);
            titles.Children.Add(h);
            titles.Children.Add(Text(T("profile.body"), "Body", 12.5));
            Grid.SetColumn(titles, 1);
            head.Children.Add(titles);
            c.Children.Add(head);
            var l1 = Text(T("profile.name").ToUpperInvariant(), "Small", 11);
            l1.FontWeight = FontWeights.SemiBold;
            l1.Margin = new Thickness(0, 18, 0, 6);
            c.Children.Add(l1);
            var field = new TextBox { Style = St("Field"), Text = profileName ?? "", MaxLength = 64 };
            field.TextChanged += delegate { profileName = field.Text; PaintProfile(); };
            field.Loaded += delegate { if (!RenderOnly) field.Focus(); field.CaretIndex = field.Text.Length; };
            c.Children.Add(field);
            profileError = Text("", "Small", 11.5);
            profileError.Foreground = Br("Danger");
            profileError.Margin = new Thickness(2, 4, 0, 0);
            c.Children.Add(profileError);
            var l2 = Text(T("profile.avatar").ToUpperInvariant(), "Small", 11);
            l2.FontWeight = FontWeights.SemiBold;
            l2.Margin = new Thickness(0, 8, 0, 8);
            c.Children.Add(l2);
            profileGrid = new WrapPanel();
            c.Children.Add(profileGrid);
            actionsRight.Children.Add(Btn(T("profile.skip"), "Ghost", () => { Opt.ProfileName = null; Opt.ProfileAvatar = null; Go(Ev.Install); }));
            actionsRight.Children.Add(Btn(T("nav.back"), "Ghost", () => Go(Ev.Back)));
            profileInstall = Btn(T("location.install"), "Primary", () =>
            {
                Opt.ProfileName = Profile.CleanName(profileName);
                Opt.ProfileAvatar = profileAvatar;
                Go(Ev.Install);
            });
            actionsRight.Children.Add(profileInstall);
            PaintProfile();
            return c;
        }

        /// <summary>For screenshots: a typed name and a picked avatar.</summary>
        public void PoseProfile(string name, int avatar)
        {
            profileName = name;
            profileAvatar = Profile.Gallery[avatar].Id;
        }

        CheckBox Switch(string label, bool value, Action<bool> set)
        {
            var cb = new CheckBox { Content = label, IsChecked = value, Style = St("Switch") };
            cb.Checked += delegate { set(true); };
            cb.Unchecked += delegate { set(false); };
            return cb;
        }

        void CheckLocation()
        {
            if (locInfo == null) return;
            string dir = Opt.InstallDir ?? "";
            bool ok = true;
            string msg;
            long need = (long)(Payload.InstalledSize * 1.1) + (Offline ? 0 : Payload.Size);
            if (dir.Trim().Length == 0 || !Path.IsPathRooted(dir) || (!RenderOnly && !Engine.Writable(dir))) { msg = T("location.notWritable"); ok = false; }
            else if (!RenderOnly && !Engine.FolderFree(dir)) { msg = T("location.notEmpty"); ok = false; }
            else if (!RenderOnly && Engine.FreeSpace(dir) >= 0 && Engine.FreeSpace(dir) < need) { msg = T("location.noSpace"); ok = false; }
            else
            {
                string old = Directory.Exists(dir) ? Engine.InstalledVersion(dir) : null;
                if (old == Payload.Version) msg = T("location.same");
                else if (old != null) msg = T("location.upgrade", "old", old, "version", Payload.Version);
                else msg = T("location.space", "size", Lang.Megabytes(Payload.InstalledSize));
            }
            locInfo.Text = msg;
            locInfo.Foreground = ok ? Br("Muted") : Br("Danger");
            if (installBtn != null) installBtn.IsEnabled = ok;
        }

        FrameworkElement PageInstalling()
        {
            var c = Column();
            var title = Text(T("installing.title"), "H1", 20);
            title.Margin = new Thickness(0, 4, 0, 14);
            c.Children.Add(title);
            carousel = new Carousel(this, 96, RenderOnly);
            c.Children.Add(carousel);
            var head = new Grid { Margin = new Thickness(0, 16, 0, 0) };
            bigStage = Text("", "Base", 13);
            bigStage.FontWeight = FontWeights.SemiBold;
            bigPercent = Text("", "Base", 13);
            bigPercent.HorizontalAlignment = HorizontalAlignment.Right;
            bigPercent.Foreground = Br("Amber");
            head.Children.Add(bigStage);
            head.Children.Add(bigPercent);
            c.Children.Add(head);
            var track = new Border { Height = 6, CornerRadius = new CornerRadius(3), Background = new SolidColorBrush(Color.FromArgb(0x18, 0xF2, 0xE9, 0xDA)), Margin = new Thickness(0, 8, 0, 0) };
            bigFill = new Border { Width = 0, CornerRadius = new CornerRadius(3), Background = Br("AmberGrad"), HorizontalAlignment = HorizontalAlignment.Left };
            track.Child = bigFill;
            c.Children.Add(track);
            bigMeta = Text("", "Small", 11.5);
            bigMeta.Margin = new Thickness(0, 6, 0, 0);
            c.Children.Add(bigMeta);
            return c;
        }

        Border Badge(bool ok)
        {
            var b = new Border { Width = 58, Height = 58, CornerRadius = new CornerRadius(29), HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 6, 0, 18) };
            if (ok)
            {
                b.Background = Br("AmberGrad");
                b.Effect = new DropShadowEffect { Color = Color.FromRgb(0xF2, 0xA1, 0x1F), BlurRadius = 30, ShadowDepth = 0, Opacity = 0.5 };
                b.Child = new Vec { Data = Geometry.Parse("M1,9 L8,16 L22,1"), Stroke = Br("Ink"), StrokeThickness = 3, Width = 24, Height = 18, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            }
            else
            {
                b.Background = new SolidColorBrush(Color.FromArgb(0x26, 0xE5, 0x60, 0x4F));
                b.BorderBrush = new SolidColorBrush(Color.FromArgb(0x66, 0xE5, 0x60, 0x4F));
                b.BorderThickness = new Thickness(1);
                b.Child = new Vec { Data = Geometry.Parse("M10,0 V12 M10,17 V19"), Stroke = Br("Danger"), StrokeThickness = 3, Width = 20, Height = 20, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            }
            return b;
        }

        public bool WebView2Missing;

        FrameworkElement PageDone()
        {
            var c = Column();
            c.Margin = new Thickness(0, 16, 0, 0);
            c.Children.Add(Badge(true));
            c.Children.Add(Text(T("done.title"), "H1"));
            c.Children.Add(Text(T("done.body", "path", InstalledRoot ?? Opt.InstallDir), "Body"));
            if (WebView2Missing)
            {
                var note = new Border { Margin = new Thickness(0, 18, 0, 0), Padding = new Thickness(14, 12, 14, 12), CornerRadius = new CornerRadius(12), Background = Br("Panel"), BorderBrush = Br("Line"), BorderThickness = new Thickness(1) };
                var sp = new StackPanel();
                sp.Children.Add(Text(T("done.webview"), "Small", 12));
                var cmd = new TextBox { Text = "winget install Microsoft.EdgeWebView2Runtime", IsReadOnly = true, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Foreground = Br("AmberSoft"), FontFamily = (FontFamily)FindResource("Mono"), FontSize = 12, Margin = new Thickness(0, 8, 0, 0) };
                sp.Children.Add(cmd);
                note.Child = sp;
                c.Children.Add(note);
            }
            actionsRight.Children.Add(Btn(T("done.finish"), "Ghost", () => { if (CloseRequested != null) CloseRequested(); }));
            actionsRight.Children.Add(Btn(T("done.open"), "Primary", () =>
            {
                if (!Engine.T.Sandbox)
                {
                    string exe = Path.Combine(InstalledRoot, "hivedesk.exe");
                    try { Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = InstalledRoot, UseShellExecute = true }); } catch (Exception) { }
                }
                if (CloseRequested != null) CloseRequested();
            }));
            return c;
        }

        FrameworkElement PageFailed()
        {
            var c = Column();
            c.Margin = new Thickness(0, 16, 0, 0);
            c.Children.Add(Badge(false));
            c.Children.Add(Text(T("failed.title"), "H1"));
            c.Children.Add(Text(ErrorText ?? "", "Body"));
            var log = Text(Engine.T.LogFile, "Small", 11);
            log.Margin = new Thickness(0, 14, 0, 0);
            log.FontFamily = (FontFamily)FindResource("Mono");
            c.Children.Add(log);
            actionsRight.Children.Add(Btn(T("failed.log"), "Ghost", () => { try { Process.Start(new ProcessStartInfo("notepad.exe", "\"" + Engine.T.LogFile + "\"")); } catch (Exception) { } }));
            actionsRight.Children.Add(Btn(T("failed.retry"), "Primary", () => Go(Ev.Retry)));
            return c;
        }

        FrameworkElement PageUninstall()
        {
            var c = Column();
            c.Margin = new Thickness(0, 10, 0, 0);
            c.Children.Add(Eyebrow("hivedesk " + (UninstallRoot != null ? Engine.InstalledVersion(UninstallRoot) ?? "" : "")));
            c.Children.Add(Text(T("uninstall.title"), "H1"));
            c.Children.Add(Text(T("uninstall.body", "path", UninstallRoot ?? ""), "Body"));
            var sw = Switch(T("uninstall.data"), RemoveData, v => RemoveData = v);
            sw.Margin = new Thickness(0, 22, 0, 0);
            c.Children.Add(sw);
            if (UninstallRoot != null && !RenderOnly && Engine.RunningFrom(UninstallRoot).Count > 0)
            {
                var r = Text(T("uninstall.running"), "Small");
                r.Foreground = Br("Amber");
                r.Margin = new Thickness(0, 14, 0, 0);
                c.Children.Add(r);
            }
            actionsRight.Children.Add(Btn(T("nav.close"), "Ghost", () => { if (CloseRequested != null) CloseRequested(); }));
            var go = Btn(T("uninstall.go"), "Primary", () => Go(Ev.Remove));
            go.IsEnabled = UninstallRoot != null;
            actionsRight.Children.Add(go);
            return c;
        }

        FrameworkElement PageRemoving()
        {
            var c = Column();
            c.Margin = new Thickness(0, 40, 0, 0);
            c.Children.Add(Text(T("uninstall.removing"), "H1"));
            var track = new Border { Height = 6, CornerRadius = new CornerRadius(3), Background = new SolidColorBrush(Color.FromArgb(0x18, 0xF2, 0xE9, 0xDA)), Margin = new Thickness(0, 18, 0, 0) };
            bigFill = new Border { Width = 0, CornerRadius = new CornerRadius(3), Background = Br("AmberGrad"), HorizontalAlignment = HorizontalAlignment.Left };
            track.Child = bigFill;
            c.Children.Add(track);
            return c;
        }

        FrameworkElement PageUninstalled()
        {
            var c = Column();
            c.Margin = new Thickness(0, 16, 0, 0);
            c.Children.Add(Badge(true));
            c.Children.Add(Text(T("uninstall.done"), "H1"));
            c.Children.Add(Text(T("uninstall.thanks"), "Body"));
            actionsRight.Children.Add(Btn(T("nav.close"), "Primary", () => { if (CloseRequested != null) CloseRequested(); }));
            return c;
        }

        // ---------------------------------------------------------------- download and install

        public string DownloadDest()
        {
            string dir = Engine.T.Sandbox ? Path.Combine(Path.GetDirectoryName(Engine.T.LogFile), "tmp") : Path.Combine(Path.GetTempPath(), "hivedesk-setup");
            return Path.Combine(dir, "hivedesk-windows-x64-" + Payload.Version + ".zip");
        }

        void StartDownload()
        {
            if (Offline || RenderOnly || Verified || Dl.Running || Dl.Finished) return;
            ZipPath = DownloadDest();
            Engine.Log("download " + Payload.Url);
            Dl.Start(Payload.Url, ZipPath, Payload.Size, null, () =>
            {
                if (Dl.Error != null) Engine.Log("download failed: " + Dl.Error.Message);
                Dispatcher.BeginInvoke(new Action(RefreshProgress));
            });
        }

        /// <summary>The app package: waits for the download (or writes the embedded one), then checks its SHA-256.</summary>
        void PreparePackage()
        {
            if (Verified) return;
            if (Offline)
            {
                ZipPath = DownloadDest();
                Directory.CreateDirectory(Path.GetDirectoryName(ZipPath));
                using (var s = Res.Open("payload.zip"))
                using (var f = File.Create(ZipPath)) s.CopyTo(f);
            }
            else
            {
                if (!Dl.Running && !Dl.Finished) Dispatcher.Invoke(new Action(StartDownload));
                while (Dl.Running) Thread.Sleep(100);
                if (Dl.Error != null)
                {
                    var err = Dl.Error;
                    Dl.Error = null;
                    throw new SetupException("network", err.Message);
                }
            }
            SetStage("verify", 0);
            Engine.Verify(ZipPath, Payload.Sha256, Payload.Size);
            Verified = true;
        }

        void SetStage(string stage, double f)
        {
            Stage = stage;
            StageFrac = f;
        }

        void BeginInstall()
        {
            if (installing || RenderOnly) return;
            installing = true;
            ErrorText = null;
            SetStage(Offline || Verified ? "extract" : "wait", 0);
            var opt = new Options { InstallDir = Opt.InstallDir, StartMenu = Opt.StartMenu, Desktop = Opt.Desktop, StartWithWindows = Opt.StartWithWindows, AutoUpdate = Opt.AutoUpdate, ProfileName = Opt.ProfileName, ProfileAvatar = Opt.ProfileAvatar };
            var th = new Thread(() =>
            {
                try
                {
                    PreparePackage();
                    InstalledRoot = Engine.Install(ZipPath, Payload.Version, opt, SelfExe, SetStage);
                    if (opt.ProfileName != null) Profile.Write(Engine.T.Home, opt.ProfileName, opt.ProfileAvatar);
                    WebView2Missing = !Engine.WebView2Installed();
                    try { File.Delete(ZipPath); } catch (Exception) { }
                    Dispatcher.BeginInvoke(new Action(() => { installing = false; Go(Ev.Done); }));
                }
                catch (Exception e)
                {
                    Engine.Log("install failed: " + e);
                    var se = e as SetupException;
                    string code = se != null ? se.Code : e is IOException || e is UnauthorizedAccessException ? "disk" : "disk";
                    string msg = code == "checksum" ? T("err.checksum") : code == "network" ? T("err.network", "error", e.Message) : code == "package" ? T("err.package") : code == "notempty" ? T("location.notEmpty") : T("err.disk", "error", e.Message);
                    if (code == "disk" && Engine.RunningFrom(opt.InstallDir).Count > 0) msg = T("err.running");
                    if (code == "checksum") { Verified = false; Dl.Finished = false; }
                    Dispatcher.BeginInvoke(new Action(() => { installing = false; ErrorText = msg; Go(Ev.Fail); }));
                }
            });
            th.IsBackground = true;
            th.SetApartmentState(ApartmentState.STA);
            th.Start();
        }

        void BeginUninstall()
        {
            if (RenderOnly) return;
            string root = UninstallRoot;
            bool data = RemoveData;
            var th = new Thread(() =>
            {
                try
                {
                    Engine.Uninstall(root, data, f => SetStage("remove", f));
                    Dispatcher.BeginInvoke(new Action(() => Go(Ev.Done)));
                }
                catch (Exception e)
                {
                    Engine.Log("uninstall failed: " + e);
                    Dispatcher.BeginInvoke(new Action(() => { ErrorText = T("err.disk", "error", e.Message); Go(Ev.Fail); }));
                }
            });
            th.IsBackground = true;
            th.Start();
        }

        /// <summary>Updates the mini status in the action bar and the big progress of the install page.</summary>
        public void RefreshProgress()
        {
            if (miniStatus == null) return;
            bool showMini = !Flow.Uninstall && (Flow.Step == Step.Tour || Flow.Step == Step.License || Flow.Step == Step.Location);
            miniStatus.Visibility = showMini ? Visibility.Visible : Visibility.Collapsed;
            double dlFrac = Offline || Verified ? 1 : Payload.Size > 0 ? Math.Min(1, (double)Dl.Got / Payload.Size) : 0;
            if (Offline) miniText.Text = T("dl.included");
            else if (Dl.Error != null) miniText.Text = T("dl.failed");
            else if (Dl.Finished || Verified) miniText.Text = T("dl.done");
            else miniText.Text = T("dl.short", "percent", Math.Floor(dlFrac * 100).ToString("0", Lang.Culture));
            miniText.Foreground = Dl.Error != null ? Br("Danger") : Br("Muted");
            miniFill.Width = 150 * dlFrac;

            if (bigFill == null) return;
            if (Flow.Step == Step.URemoving) { bigFill.Width = Math.Max(0, ((FrameworkElement)bigFill.Parent).ActualWidth) * StageFrac; return; }
            double total;
            string stageText;
            string meta = "";
            bool dlPart = !Offline;
            switch (Stage)
            {
                case "wait":
                    total = dlPart ? 0.72 * dlFrac : 0;
                    stageText = T("dl.downloading", "version", Payload.Version);
                    meta = KnownSize > 0 ? T("dl.progress", "done", Lang.Bytes(Dl.Got), "size", Lang.Bytes(KnownSize)) : T("dl.got", "done", Lang.Bytes(Dl.Got));
                    if (Dl.Speed > 0) meta += "   " + T("dl.rate", "speed", Lang.Bytes(Dl.Speed), "eta", Lang.Seconds((Payload.Size - Dl.Got) / Dl.Speed));
                    break;
                case "verify": total = dlPart ? 0.74 : 0.05; stageText = T("installing.verify"); break;
                case "extract": total = (dlPart ? 0.75 : 0.08) + (dlPart ? 0.2 : 0.85) * StageFrac; stageText = T("installing.extract"); break;
                case "shortcuts": total = 0.96; stageText = T("installing.shortcuts"); break;
                default: total = 0.98 + 0.02 * StageFrac; stageText = T("installing.register"); break;
            }
            bigStage.Text = stageText;
            bigPercent.Text = Math.Floor(total * 100).ToString("0", Lang.Culture) + "%";
            bigMeta.Text = meta;
            double w = ((FrameworkElement)bigFill.Parent).ActualWidth;
            if (w <= 0) w = W - 252 - 80;
            bigFill.Width = w * total;
        }

        /// <summary>Stops the timers and the download (the window is closing).</summary>
        public void Shutdown()
        {
            tick.Stop();
            if (carousel != null) carousel.Stop();
            Dl.Cancel();
        }

        // ---------------------------------------------------------------- render support

        /// <summary>For screenshots: puts the view in a step with a given download and install state.</summary>
        public void Pose(Step s, double dl, string stage, double frac, int slide, long knownSize = -1)
        {
            KnownSize = knownSize;
            Flow.Step = s;
            Dl.Got = (long)(Payload.Size * dl);
            Dl.Speed = dl > 0 && dl < 1 ? 6.4e6 : 0;
            Dl.Finished = dl >= 1;
            Verified = false;
            Stage = stage;
            StageFrac = frac;
            if (s == Step.Done) InstalledRoot = Opt.InstallDir;
            ShowStep(false);
            if (carousel != null) carousel.Show(slide, false);
        }

        public Carousel CurrentCarousel { get { return carousel; } }
    }

    /// <summary>The "what hivedesk is" slides, shown while the app downloads and installs.</summary>
    public class Carousel : Border
    {
        public static readonly string[] Keys = { "city", "agents", "p2p", "compute", "workbench", "remote", "phone" };
        readonly FrameworkElement res;
        readonly Image art;
        readonly TextBlock title, desc;
        readonly StackPanel dots;
        readonly Grid body;
        readonly DispatcherTimer timer;
        public int Index;

        public Carousel(FrameworkElement res, double artHeight, bool still)
        {
            this.res = res;
            CornerRadius = new CornerRadius(14);
            Background = (Brush)res.FindResource("Panel");
            BorderBrush = (Brush)res.FindResource("Line");
            BorderThickness = new Thickness(1);
            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(artHeight + 16) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var stage = new Border
            {
                CornerRadius = new CornerRadius(13, 13, 0, 0),
                Background = new RadialGradientBrush(Color.FromArgb(0x30, 0xFF, 0xB5, 0x31), Color.FromArgb(0x00, 0xFF, 0xB5, 0x31)) { Center = new Point(0.5, 0.6), GradientOrigin = new Point(0.5, 0.6), RadiusX = 0.6, RadiusY = 0.8 }
            };
            root.Children.Add(new Border { CornerRadius = new CornerRadius(13, 13, 0, 0), Background = (Brush)res.FindResource("Comb"), Opacity = 0.7 });
            root.Children.Add(stage);
            body = new Grid();
            Grid.SetRowSpan(body, 2);
            body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(artHeight + 16) });
            body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            art = new Image { Height = artHeight, Width = artHeight * 1.6, Margin = new Thickness(0, 10, 0, 6), Stretch = Stretch.Uniform };
            body.Children.Add(art);
            var text = new StackPanel { Margin = new Thickness(20, 12, 20, 14) };
            Grid.SetRow(text, 1);
            title = new TextBlock { FontSize = 16, FontWeight = FontWeights.SemiBold, Foreground = (Brush)res.FindResource("Text"), FontFamily = (FontFamily)res.FindResource("UiDisplay") };
            desc = new TextBlock { FontSize = 13, Foreground = (Brush)res.FindResource("Text2"), TextWrapping = TextWrapping.Wrap, LineHeight = 19, Margin = new Thickness(0, 4, 0, 0), Height = 58 };
            text.Children.Add(title);
            text.Children.Add(desc);
            body.Children.Add(text);
            root.Children.Add(body);
            dots = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 14, 16, 0) };
            Grid.SetRow(dots, 0);
            for (int i = 0; i < Keys.Length; i++)
            {
                int n = i;
                var d = new Border { Height = 6, Width = 6, CornerRadius = new CornerRadius(3), Margin = new Thickness(3, 0, 0, 0), Cursor = Cursors.Hand, Background = Brushes.Transparent };
                d.MouseLeftButtonUp += delegate { Show(n, true); Restart(); };
                dots.Children.Add(d);
            }
            root.Children.Add(dots);
            Child = root;
            Show(0, false);
            timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4.6) };
            timer.Tick += delegate { Show(Index + 1, true); };
            if (!still) timer.Start();
        }

        void Restart() { timer.Stop(); timer.Start(); }

        public void Stop() { timer.Stop(); }

        public void Show(int i, bool animate)
        {
            Index = ((i % Keys.Length) + Keys.Length) % Keys.Length;
            string k = Keys[Index];
            art.Source = (ImageSource)res.FindResource("art." + k);
            title.Text = Lang.T("slide." + k + ".t");
            desc.Text = Lang.T("slide." + k + ".d");
            for (int n = 0; n < dots.Children.Count; n++)
            {
                var d = (Border)dots.Children[n];
                bool on = n == Index;
                d.Width = on ? 18 : 6;
                d.Background = on ? (Brush)res.FindResource("AmberGrad") : new SolidColorBrush(Color.FromArgb(0x40, 0xF2, 0xE9, 0xDA));
            }
            if (!animate) return;
            var tt = new TranslateTransform();
            body.RenderTransform = tt;
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            body.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(380)));
            tt.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(22, 0, TimeSpan.FromMilliseconds(460)) { EasingFunction = ease });
        }
    }

    /// <summary>The borderless, rounded window around the view.</summary>
    public class SetupWindow : Window
    {
        public SetupWindow(SetupView view)
        {
            Content = view;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.CanMinimize;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Title = Lang.T("app.title");
            using (var s = Res.Open("hivedesk.ico")) Icon = BitmapFrame.Create(s, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            view.CloseRequested = () => Close();
            view.MinimizeRequested = () => { WindowState = WindowState.Minimized; };
            view.DragRequested = () => { try { DragMove(); } catch (InvalidOperationException) { } };
            Closing += (s, e) =>
            {
                if (!Flow.CanClose(view.Flow.Step)) { e.Cancel = true; return; }
                view.Shutdown();
            };
            KeyDown += (s, e) => { if (e.Key == Key.Escape && Flow.CanClose(view.Flow.Step)) Close(); };
        }
    }
}
