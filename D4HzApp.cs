using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace D4HzDesktop
{
    public class MainForm : Form
    {
        private const int RelayPort = 7432;
        private static readonly string AppUrl = "http://127.0.0.1:" + RelayPort;
        private Process _relayProcess;
        private TextBox _logBox;
        private Label _statusLbl;
        private Button _launchBtn;
        private Button _openBrowserBtn;
        private Button _stopBtn;
        private NotifyIcon _trayIcon;
        private bool _isClosing = false;

        public MainForm()
        {
            InitializeComponent();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            this.Text = "D4Hz WEB — Discord Voice Amplifier & Multi-Account VC Suite";
        }

        private void InitializeComponent()
        {
            this.Text = "D4Hz WEB — Discord Voice Amplifier & Multi-Account VC Suite";
            this.Size = new Size(760, 560);
            this.MinimumSize = new Size(680, 480);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(8, 2, 4);
            this.ForeColor = Color.White;
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            // Try load icon
            string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
            if (File.Exists(iconPath))
            {
                try { this.Icon = new Icon(iconPath); } catch { }
            }

            // Header Panel
            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 84,
                BackColor = Color.FromArgb(14, 4, 8),
                Padding = new Padding(16, 12, 16, 12)
            };

            Label titleLbl = new Label
            {
                Text = "⚡ D4Hz VOICE AMPLIFIER",
                Font = new Font("Segoe UI", 14F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(255, 26, 46),
                AutoSize = true,
                Location = new Point(14, 12)
            };

            _statusLbl = new Label
            {
                Text = "Initializing Discord Voice Engine & Multi-Account System...",
                Font = new Font("Segoe UI", 8.5F, FontStyle.Regular, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(180, 180, 180),
                AutoSize = true,
                Location = new Point(16, 42)
            };

            header.Controls.Add(titleLbl);
            header.Controls.Add(_statusLbl);
            this.Controls.Add(header);

            // Action Buttons Panel
            Panel actionsPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 62,
                BackColor = Color.FromArgb(10, 3, 6),
                Padding = new Padding(16, 10, 16, 10)
            };

            _launchBtn = CreateButton("🚀 LAUNCH APP WINDOW", Color.FromArgb(255, 26, 46), 180, 12);
            _launchBtn.Click += (s, e) => LaunchAppWindow();

            _openBrowserBtn = CreateButton("🌐 OPEN IN BROWSER", Color.FromArgb(25, 40, 70), 160, 202);
            _openBrowserBtn.Click += (s, e) => OpenDefaultBrowser();

            Button copyUrlBtn = CreateButton("📋 COPY LOCAL URL", Color.FromArgb(30, 30, 35), 140, 372);
            copyUrlBtn.Click += (s, e) =>
            {
                Clipboard.SetText(AppUrl);
                MessageBox.Show("Copied URL to clipboard:\n" + AppUrl, "D4Hz", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            _stopBtn = CreateButton("⏹ STOP & EXIT", Color.FromArgb(70, 15, 20), 120, 522);
            _stopBtn.Click += (s, e) => this.Close();

            actionsPanel.Controls.Add(_launchBtn);
            actionsPanel.Controls.Add(_openBrowserBtn);
            actionsPanel.Controls.Add(copyUrlBtn);
            actionsPanel.Controls.Add(_stopBtn);
            this.Controls.Add(actionsPanel);

            // Log Console Section
            Panel logPanel = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(16, 10, 16, 16),
                BackColor = Color.FromArgb(8, 2, 4)
            };

            Label logTitle = new Label
            {
                Text = "📡 LIVE ENGINE & MULTI-ACCOUNT CHAT LOGS:",
                Font = new Font("Segoe UI", 8F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(140, 140, 140),
                Dock = DockStyle.Top,
                Height = 22
            };

            _logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(4, 1, 2),
                ForeColor = Color.FromArgb(220, 220, 220),
                Font = new Font("Consolas", 8.5F, FontStyle.Regular, GraphicsUnit.Point),
                BorderStyle = BorderStyle.FixedSingle
            };

            logPanel.Controls.Add(_logBox);
            logPanel.Controls.Add(logTitle);
            this.Controls.Add(logPanel);

            // System Tray Icon
            _trayIcon = new NotifyIcon
            {
                Text = "D4Hz Voice Amplifier",
                Visible = true
            };
            if (this.Icon != null) _trayIcon.Icon = this.Icon;

            ContextMenu trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("Show D4Hz Window", (s, e) => ShowAndRestore());
            trayMenu.MenuItems.Add("Launch App Window", (s, e) => LaunchAppWindow());
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("Stop & Exit", (s, e) => this.Close());
            _trayIcon.ContextMenu = trayMenu;
            _trayIcon.DoubleClick += (s, e) => ShowAndRestore();

            this.FormClosing += OnFormClosing;
            this.Shown += OnFormShown;
        }

        private Button CreateButton(string text, Color backColor, int width, int left)
        {
            Button btn = new Button
            {
                Text = text,
                Width = width,
                Height = 38,
                Location = new Point(left, 12),
                BackColor = backColor,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
                Font = new Font("Segoe UI", 8F, FontStyle.Bold, GraphicsUnit.Point)
            };
            btn.FlatAppearance.BorderSize = 1;
            btn.FlatAppearance.BorderColor = Color.FromArgb(100, 255, 26, 46);
            return btn;
        }

        private void AppendLog(string message)
        {
            if (string.IsNullOrEmpty(message) || _isClosing) return;
            try
            {
                string line = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine;
                try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "d4hz.log"), line); } catch { }
                if (this.InvokeRequired)
                {
                    this.BeginInvoke((MethodInvoker)(() => {
                        try { _logBox.AppendText(line); } catch { }
                    }));
                    return;
                }
                _logBox.AppendText(line);
            }
            catch { }
        }

        private void OnFormShown(object sender, EventArgs e)
        {
            AppendLog("Starting D4Hz Voice Amplifier Desktop Edition...");
            new Thread(StartEngineAsync) { IsBackground = true }.Start();
        }

        private void StartEngineAsync()
        {
            try
            {
                bool portInUse = IsPortInUse(RelayPort);
                if (portInUse)
                {
                    AppendLog("Port 7432 is already active with an existing instance.");
                }
                else
                {
                    string nodePath = FindOrGetNode();
                    if (string.IsNullOrEmpty(nodePath))
                    {
                        AppendLog("ERROR: Node.js runtime not found!");
                        this.Invoke((MethodInvoker)(() =>
                        {
                            _statusLbl.Text = "❌ Node.js runtime not found. Please install Node.js from https://nodejs.org";
                            _statusLbl.ForeColor = Color.FromArgb(255, 100, 100);
                        }));
                        return;
                    }

                    AppendLog("Found Node runtime: " + nodePath);

                    string relayScript = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "relay.js");
                    if (!File.Exists(relayScript))
                    {
                        relayScript = Path.Combine(Directory.GetCurrentDirectory(), "relay.js");
                    }

                    if (!File.Exists(relayScript))
                    {
                        AppendLog("ERROR: relay.js not found in " + relayScript);
                        this.Invoke((MethodInvoker)(() =>
                        {
                            _statusLbl.Text = "❌ relay.js file is missing from application folder.";
                            _statusLbl.ForeColor = Color.FromArgb(255, 100, 100);
                        }));
                        return;
                    }

                    AppendLog("Starting Voice Relay Backend from " + relayScript + "...");

                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = nodePath,
                        Arguments = "\"" + relayScript + "\"",
                        WorkingDirectory = Path.GetDirectoryName(relayScript),
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };

                    _relayProcess = new Process { StartInfo = psi };
                    _relayProcess.OutputDataReceived += (s, args) =>
                    {
                        if (!string.IsNullOrEmpty(args.Data)) AppendLog(args.Data);
                    };
                    _relayProcess.ErrorDataReceived += (s, args) =>
                    {
                        if (!string.IsNullOrEmpty(args.Data)) AppendLog("[RELAY ERR] " + args.Data);
                    };

                    _relayProcess.Start();
                    _relayProcess.BeginOutputReadLine();
                    _relayProcess.BeginErrorReadLine();
                }

                // Wait for port ready
                Stopwatch sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < 5000)
                {
                    if (IsPortInUse(RelayPort)) break;
                    Thread.Sleep(200);
                }

                if (IsPortInUse(RelayPort))
                {
                    this.Invoke((MethodInvoker)(() =>
                    {
                        _statusLbl.Text = "🟢 ONLINE — Voice Relay & VC Chat Active (" + AppUrl + ")";
                        _statusLbl.ForeColor = Color.FromArgb(0, 230, 118);
                    }));

                    AppendLog("✅ Voice Relay Backend online on " + AppUrl);
                    AppendLog("🚀 Automatically launching application interface...");

                    // Auto launch app window
                    LaunchAppWindow();
                }
                else
                {
                    this.Invoke((MethodInvoker)(() =>
                    {
                        _statusLbl.Text = "⚠️ Relay startup timeout. Click LAUNCH to retry.";
                        _statusLbl.ForeColor = Color.FromArgb(255, 170, 0);
                    }));
                }
            }
            catch (Exception ex)
            {
                AppendLog("EXCEPTION during startup: " + ex.Message);
            }
        }

        private void LaunchAppWindow()
        {
            try
            {
                // Attempt Chromium App Mode (Edge, Chrome, Brave)
                string browserPath = FindBrowser();
                if (!string.IsNullOrEmpty(browserPath))
                {
                    string args = "--new-window --app=\"" + AppUrl + "\"";
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = browserPath,
                        Arguments = args,
                        UseShellExecute = true
                    };
                    Process.Start(psi);
                    AppendLog("Opened app window via " + Path.GetFileName(browserPath) + " in standalone app mode.");
                    return;
                }

                OpenDefaultBrowser();
            }
            catch (Exception ex)
            {
                AppendLog("Launch error: " + ex.Message);
                OpenDefaultBrowser();
            }
        }

        private void OpenDefaultBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = AppUrl,
                    UseShellExecute = true
                });
                AppendLog("Opened " + AppUrl + " in default web browser.");
            }
            catch (Exception ex)
            {
                AppendLog("Browser open error: " + ex.Message);
            }
        }

        private void ShowAndRestore()
        {
            this.Show();
            this.WindowState = FormWindowState.Normal;
            this.BringToFront();
            this.Activate();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            _isClosing = true;
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
            }

            AppendLog("Shutting down D4Hz and stopping all VC connections...");

            try
            {
                using (WebClient client = new WebClient())
                {
                    client.Headers[HttpRequestHeader.ContentType] = "application/json";
                    client.UploadString(AppUrl + "/stop", "POST", "");
                }
            }
            catch { }

            if (_relayProcess != null && !_relayProcess.HasExited)
            {
                try
                {
                    _relayProcess.Kill();
                }
                catch { }
            }
        }

        private static bool IsPortInUse(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(300);
                    if (success)
                    {
                        client.EndConnect(result);
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        private static string FindOrGetNode()
        {
            string localNode = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node.exe");
            if (File.Exists(localNode)) return localNode;

            string cwdNode = Path.Combine(Directory.GetCurrentDirectory(), "node.exe");
            if (File.Exists(cwdNode)) return cwdNode;

            string userLocal = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string codexDir = Path.Combine(userLocal, @"OpenAI\Codex\runtimes");
            if (Directory.Exists(codexDir))
            {
                try
                {
                    string[] found = Directory.GetFiles(codexDir, "node.exe", SearchOption.AllDirectories);
                    if (found.Length > 0 && File.Exists(found[0])) return found[0];
                }
                catch { }
            }

            string[] standardPaths = new string[]
            {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"npm\node.exe"),
                Path.Combine(userLocal, @"Programs\node\node.exe"),
                @"C:\nvm\node.exe"
            };

            foreach (string p in standardPaths)
            {
                if (File.Exists(p)) return p;
            }

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathEnv.Split(';'))
            {
                string clean = part.Trim('\"', ' ');
                if (!string.IsNullOrEmpty(clean) && Directory.Exists(clean))
                {
                    string candidate = Path.Combine(clean, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
            }

            return null;
        }

        private static string FindBrowser()
        {
            string[] candidates = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string path in candidates)
            {
                if (File.Exists(path)) return path;
            }

            return null;
        }

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
