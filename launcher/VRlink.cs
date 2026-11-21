using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class VRlinkLauncher
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    // 窗口边框/标题栏固定成 #111：只设「深色模式」时，窗口一失焦 Windows
    // 就把边框画回默认浅色，和深色界面割裂（BOSS 2026-11-18 反馈）。
    // 34 = DWMWA_BORDER_COLOR, 35 = DWMWA_CAPTION_COLOR, 36 = DWMWA_TEXT_COLOR
    // （Win11 22000+ 才有；Win10 会返回失败，忽略即可）。
    static void ApplyDarkFrame(IntPtr hwnd)
    {
        int dark = 1;
        try { DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int)); } catch { }
        int frame = 0x00111111; // COLORREF = 0x00BBGGRR -> #111111
        try { DwmSetWindowAttribute(hwnd, 34, ref frame, sizeof(int)); } catch { }
        try { DwmSetWindowAttribute(hwnd, 35, ref frame, sizeof(int)); } catch { }
        int text = 0x00EDEDED; // #ededed
        try { DwmSetWindowAttribute(hwnd, 36, ref text, sizeof(int)); } catch { }
    }

    static string BaseDir
    {
        get { return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName); }
    }

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length > 0 && (args[0] == "--stop" || args[0] == "/stop"))
        {
            StopHub();
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (!Healthy())
            {
                StartHub();
            }
            if (!WaitHealthy(30000))
            {
                MessageBox.Show("VRlink 启动失败：本地服务没有在 30 秒内就绪。\n请确认本文件夹完整，或查看 data 目录权限。", "VRlink", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            LaunchWindow();
        }
        catch (Exception ex)
        {
            MessageBox.Show("VRlink 启动失败：" + ex.Message, "VRlink", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static bool Healthy()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:5274/api/health");
            request.Timeout = 1500;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                return reader.ReadToEnd().Contains("\"ok\":true");
            }
        }
        catch
        {
            return false;
        }
    }

    static void StartHub()
    {
        var node = Path.Combine(BaseDir, "node.exe");
        var app = Path.Combine(BaseDir, "app", "src", "server.mjs");
        if (!File.Exists(node) || !File.Exists(app))
        {
            throw new FileNotFoundException("缺少 node.exe 或 app\\src\\server.mjs");
        }
        var psi = new ProcessStartInfo(node, "\"" + app + "\"");
        psi.WorkingDirectory = BaseDir;
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.EnvironmentVariables["VRLINK_EDITION"] = "seed";
        psi.EnvironmentVariables["VRLINK_V2_PORT"] = "5274";
        psi.EnvironmentVariables["VRLINK_FEDERATION_PORT"] = "5275";
        psi.EnvironmentVariables["VRLINK_V2_DATA"] = Path.Combine(BaseDir, "data");
        psi.EnvironmentVariables["VRLINK_FEDERATION_HOST"] = "0.0.0.0";
        psi.EnvironmentVariables["VRLINK_RECONNECT_MS"] = "30000";
        psi.EnvironmentVariables["VRLINK_RATE_LIMIT"] = "1200";
        Process.Start(psi);
    }

    static bool WaitHealthy(int milliseconds)
    {
        var deadline = DateTime.Now.AddMilliseconds(milliseconds);
        while (DateTime.Now < deadline)
        {
            if (Healthy()) return true;
            Thread.Sleep(350);
        }
        return false;
    }

    // Native WinForms frame: DWM dark-mode attribute 20 works on Windows 10/11
    // and gives the same #111 surface as the VRlink UI, including the caption
    // buttons (minimize / maximize / close). The old Edge --app window painted
    // its own light frame and ignored this.
    static void LaunchWindow()
    {
        var form = new Form();
        form.Text = "VRlink";
        form.Width = 1280;
        form.Height = 860;
        form.MinimumSize = new Size(900, 600);
        form.StartPosition = FormStartPosition.CenterScreen;
        form.BackColor = Color.FromArgb(17, 17, 17);

        var web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(17, 17, 17);
        form.Controls.Add(web);

        // 关闭窗口 = 收到托盘：后台节点继续跑（能收消息、能补发）。
        // 真要退出用托盘菜单「退出 VRlink」，会连同本地节点一起停掉。
        var tray = new NotifyIcon();
        try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        tray.Text = "VRlink（后台运行中）";
        tray.Visible = true;
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("打开 VRlink", null, (s, e) =>
        {
            form.Show();
            form.WindowState = FormWindowState.Normal;
            form.Activate();
        });
        trayMenu.Items.Add("退出 VRlink（停止后台）", null, (s, e) =>
        {
            tray.Visible = false;
            StopHub();
            Application.Exit();
        });
        tray.ContextMenuStrip = trayMenu;
        tray.DoubleClick += (s, e) =>
        {
            form.Show();
            form.WindowState = FormWindowState.Normal;
            form.Activate();
        };
        form.FormClosing += (s, e) =>
        {
            // 只有系统关机/真正退出（托盘菜单 Application.Exit）才放行；
            // 其余（点 X、Alt+F4、任务管理器 WM_CLOSE）一律收到托盘，
            // 原来只判断 UserClosing，任务管理器发来的 CloseReason 是 None，会被直接放走。
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.ApplicationExitCall) return;
            e.Cancel = true;
            form.Hide();
            // 不再弹系统气泡：那是带 Windows 通知音的弹窗（BOSS 2026-11-18 嫌吵）。
            // 静默进托盘，来消息时用自绘提示窗（无声）提醒。
        };

        // 后台消息提醒：托盘/最小化时轮询一次会话，用自绘的无声小窗提示
        var notifier = new Notifier(form, web);
        notifier.Start();

        // 失焦/回焦都重刷一次边框色，避免系统把边框改回浅色
        form.Activated += (sender, e) => ApplyDarkFrame(form.Handle);
        form.Deactivate += (sender, e) => ApplyDarkFrame(form.Handle);

        form.Shown += async (sender, e) =>
        {
            ApplyDarkFrame(form.Handle);

            try
            {
                var userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "VRlink", "WebView2");
                var environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await web.EnsureCoreWebView2Async(environment);
                web.CoreWebView2.Navigate("http://127.0.0.1:5274/");
            }
            catch (Exception ex)
            {
                MessageBox.Show("VRlink 窗口初始化失败：" + ex.Message + "\n将改用系统浏览器打开。", "VRlink", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                try { Process.Start("http://127.0.0.1:5274/"); } catch { }
            }
        };

        Application.Run(form);
    }

    static void StopHub()
    {
        try
        {
            var query = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'");
            foreach (ManagementObject item in query.Get())
            {
                var commandLine = Convert.ToString(item["CommandLine"]);
                if (commandLine != null && commandLine.Contains("app\\src\\server.mjs"))
                {
                    try
                    {
                        Process.GetProcessById(Convert.ToInt32(item["ProcessId"])).Kill();
                    }
                    catch { }
                }
            }
        }
        catch { }
    }
}

/// <summary>
/// 后台消息提醒：主窗口隐藏/最小化/不在前台时，每 2.5 秒看一次本地节点，
/// 有新的人-人消息或群消息就弹一个自绘的无声小窗（不用系统气泡，避免 Windows 通知音）。
/// 点击小窗恢复主窗口并跳到对应会话。
/// </summary>
class Notifier
{
    readonly Form main;
    readonly WebView2 web;
    readonly System.Windows.Forms.Timer timer;
    readonly Dictionary<string, long> seen = new Dictionary<string, long>();
    bool primed;
    ToastForm current;

    public Notifier(Form main, WebView2 web)
    {
        this.main = main;
        this.web = web;
        timer = new System.Windows.Forms.Timer { Interval = 2500 };
        timer.Tick += (s, e) => Poll();
    }

    public void Start()
    {
        timer.Start();
    }

    bool Front()
    {
        return main.Visible && main.WindowState != FormWindowState.Minimized && main.ContainsFocus;
    }

    static string Fetch(string url)
    {
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Timeout = 2000;
        request.ReadWriteTimeout = 2000;
        request.Proxy = null;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    static Dictionary<string, object> Json(string text)
    {
        return new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
    }

    static List<Dictionary<string, object>> Items(Dictionary<string, object> root, string key)
    {
        var list = new List<Dictionary<string, object>>();
        object raw;
        if (root == null || !root.TryGetValue(key, out raw)) return list;
        var items = raw as System.Collections.IEnumerable;
        if (items == null) return list;
        foreach (var item in items)
        {
            var map = item as Dictionary<string, object>;
            if (map != null) list.Add(map);
        }
        return list;
    }

    static long Num(Dictionary<string, object> map, string key)
    {
        object raw;
        if (map == null || !map.TryGetValue(key, out raw) || raw == null) return 0;
        try { return Convert.ToInt64(raw); } catch { return 0; }
    }

    static string Str(Dictionary<string, object> map, string key)
    {
        object raw;
        if (map == null || !map.TryGetValue(key, out raw) || raw == null) return "";
        return Convert.ToString(raw);
    }

    static bool Bool(Dictionary<string, object> map, string key)
    {
        object raw;
        if (map == null || !map.TryGetValue(key, out raw) || raw == null) return false;
        try { return Convert.ToBoolean(raw); } catch { return false; }
    }

    static void Log(string line)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRlink");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "notifier.log"), DateTime.Now.ToString("HH:mm:ss") + " " + line + "\r\n");
        }
        catch { }
    }

    void Poll()
    {
        try
        {
            if (Front())
            {
                primed = false;
                if (current != null)
                {
                    current.Close();
                    current = null;
                }
                return;
            }

            var threads = Items(Json(Fetch("http://127.0.0.1:5274/api/human/threads")), "threads");
            var groups = Items(Json(Fetch("http://127.0.0.1:5274/api/federation/groups")), "groups");

            string title = null;
            string body = null;
            string hash = null;
            long newest = 0;

            foreach (var thread in threads)
            {
                var nodeId = Str(thread, "nodeId");
                if (nodeId.Length == 0) continue;
                var at = Num(thread, "lastAt");
                // 只看"最后一条是不是对方发的"：窗口隐藏时页面仍可能把消息标成已读，
                // 以前用 unread>0 判断，被标已读后就永远不弹小窗了。
                var incoming = !Bool(thread, "lastFromSelf");
                long previous;
                seen.TryGetValue(nodeId, out previous);
                if (primed && incoming && at > previous && at >= newest)
                {
                    newest = at;
                    title = Str(thread, "name");
                    if (title.Length == 0) title = nodeId.Length > 12 ? nodeId.Substring(9, 8) : nodeId;
                    body = Str(thread, "lastText");
                    hash = "#/remote/" + Uri.EscapeDataString(nodeId) + "/human";
                }
                seen[nodeId] = at;
            }

            foreach (var group in groups)
            {
                var id = Str(group, "id");
                if (id.Length == 0) continue;
                var messages = Items(group, "messages");
                if (messages.Count == 0) continue;
                var last = messages[messages.Count - 1];
                var key = "g:" + id;
                var at = Num(last, "at");
                long previous;
                seen.TryGetValue(key, out previous);
                if (primed && at > previous && at >= newest)
                {
                    var from = Str(last, "fromName");
                    if (from.Length == 0) from = "群成员";
                    newest = at;
                    title = Str(group, "name");
                    body = from + "：" + Str(last, "text");
                    hash = "#/group/" + Uri.EscapeDataString(id);
                }
                seen[key] = at;
            }

            if (!primed)
            {
                primed = true;
                return;
            }
            if (title == null || body == null || body.Length == 0) return;

            if (current != null)
            {
                current.Close();
                current = null;
            }
            var toast = new ToastForm(title, body, () =>
            {
                main.Show();
                if (main.WindowState == FormWindowState.Minimized) main.WindowState = FormWindowState.Normal;
                main.Activate();
                try
                {
                    if (web.CoreWebView2 != null && hash != null)
                    {
                        web.CoreWebView2.Navigate("http://127.0.0.1:5274/" + hash);
                    }
                }
                catch { }
            });
            current = toast;
            toast.ShowToast();
        }
        catch (Exception ex)
        {
            Log("poll error: " + ex.GetType().Name + " " + ex.Message);
        }
    }
}

/// <summary>
/// 自绘的无声提示小窗：右下角浮出，4.5 秒自动消失，点击打开对应会话。
/// 不用系统通知，所以不会触发 Windows 的通知音。
/// </summary>
class ToastForm : Form
{
    readonly Action onClick;
    readonly System.Windows.Forms.Timer life;

    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE：不抢焦点
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW：不出现在 Alt+Tab
            return cp;
        }
    }

    public ToastForm(string title, string body, Action onClick)
    {
        this.onClick = onClick;
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.FromArgb(26, 26, 26);
        Size = new Size(380, 100);
        Padding = new Padding(18, 14, 18, 14);
        Cursor = Cursors.Hand;

        var heading = new Label
        {
            Text = title,
            ForeColor = Color.FromArgb(237, 237, 237),
            Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
            Dock = DockStyle.Top,
            Height = 26,
            AutoEllipsis = true,
            BackColor = Color.Transparent,
        };
        var text = new Label
        {
            Text = body,
            ForeColor = Color.FromArgb(163, 163, 163),
            Font = new Font("Segoe UI", 9f),
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
            BackColor = Color.Transparent,
        };
        Controls.Add(text);
        Controls.Add(heading);

        EventHandler click = (s, e) =>
        {
            life.Stop();
            Close();
            if (this.onClick != null) this.onClick();
        };
        Click += click;
        heading.Click += click;
        text.Click += click;

        Paint += (s, e) =>
        {
            using (var pen = new Pen(Color.FromArgb(48, 48, 48)))
            {
                e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            }
            using (var accent = new SolidBrush(Color.FromArgb(74, 222, 128)))
            {
                e.Graphics.FillRectangle(accent, 0, 0, 4, Height);
            }
        };

        life = new System.Windows.Forms.Timer { Interval = 4500 };
        life.Tick += (s, e) =>
        {
            life.Stop();
            Close();
        };
        life.Start();

        var area = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(area.Right - Width - 18, area.Bottom - Height - 18);
    }

    public void ShowToast()
    {
        Show();
        TopMost = true;
    }
}
