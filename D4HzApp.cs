using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace D4HzDesktop
{
    static class Program
    {
        private static Process _relayProcess;
        private static Process _browserProcess;
        private static readonly string AppDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D4Hz_App");
        private static readonly string ProfileDir = Path.Combine(AppDataDir, "Profile");
        private const int RelayPort = 7432;
        private static readonly string AppUrl = "http://127.0.0.1:" + RelayPort;

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                if (!Directory.Exists(ProfileDir))
                {
                    Directory.CreateDirectory(ProfileDir);
                }

                // 1. Ensure relay is running or start it
                bool relayAlreadyRunning = IsPortInUse(RelayPort);
                if (!relayAlreadyRunning)
                {
                    string nodePath = FindOrGetNode();
                    if (string.IsNullOrEmpty(nodePath))
                    {
                        MessageBox.Show(
                            "D4Hz requires the Node.js runtime to execute the high-frequency Discord voice relay.\n\nPlease install Node.js from https://nodejs.org or place node.exe in the same folder as D4Hz.exe.",
                            "D4Hz Voice Amplifier - Node.js Required",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                        return;
                    }

                    string relayScript = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "relay.js");
                    if (!File.Exists(relayScript))
                    {
                        // Check parent or working directory
                        string fallback = Path.Combine(Directory.GetCurrentDirectory(), "relay.js");
                        if (File.Exists(fallback))
                        {
                            relayScript = fallback;
                        }
                        else
                        {
                            MessageBox.Show(
                                "Could not find 'relay.js' in the application directory:\n" + relayScript,
                                "D4Hz - File Missing",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Error);
                            return;
                        }
                    }

                    StartRelay(nodePath, relayScript);
                }

                // Wait briefly for relay to initialize
                WaitForRelayReady(RelayPort, 4000);

                // 2. Locate Chromium browser (Edge, Chrome, Brave)
                string browserPath = FindBrowser();
                if (string.IsNullOrEmpty(browserPath))
                {
                    // Fallback to default browser
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = AppUrl,
                        UseShellExecute = true
                    });
                    return;
                }

                // 3. Launch dedicated standalone App Mode
                string arguments = string.Format(
                    "--app=\"{0}\" --window-size=1380,880 --user-data-dir=\"{1}\" --enable-features=WebAssembly,WebRTC --autoplay-policy=no-user-gesture-required",
                    AppUrl,
                    ProfileDir);

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = browserPath,
                    Arguments = arguments,
                    UseShellExecute = false
                };

                _browserProcess = Process.Start(psi);

                if (_browserProcess != null)
                {
                    _browserProcess.WaitForExit();
                }

                CleanupAndExit();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "An error occurred while running D4Hz:\n\n" + ex.Message,
                    "D4Hz Voice Amplifier",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static bool IsPortInUse(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(400);
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

        private static void WaitForRelayReady(int port, int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (IsPortInUse(port)) return;
                Thread.Sleep(150);
            }
        }

        private static void StartRelay(string nodePath, string scriptPath)
        {
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "\"" + scriptPath + "\"",
                WorkingDirectory = Path.GetDirectoryName(scriptPath),
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            _relayProcess = new Process { StartInfo = psi };
            _relayProcess.Start();

            // Auto-clean relay if app domain unloads
            AppDomain.CurrentDomain.ProcessExit += (s, e) => CleanupAndExit();
        }

        private static string FindOrGetNode()
        {
            // 1. Same folder as exe
            string localNode = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node.exe");
            if (File.Exists(localNode)) return localNode;

            // 2. Current working directory
            string cwdNode = Path.Combine(Directory.GetCurrentDirectory(), "node.exe");
            if (File.Exists(cwdNode)) return cwdNode;

            // 3. Check specific OpenAI Codex / CUA runtime path
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

            // 4. Standard Program Files
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

            // 5. Check PATH
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

            // 6. Automatically prompt to download portable node.exe
            DialogResult dr = MessageBox.Show(
                "D4Hz requires the Node.js runtime to execute the high-frequency Discord voice amplifier.\n\nWould you like D4Hz to automatically download the official portable node.exe runtime now (~35MB)?",
                "D4Hz - Download Runtime",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);

            if (dr == DialogResult.Yes)
            {
                try
                {
                    string target = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node.exe");
                    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // Tls12
                    using (WebClient client = new WebClient())
                    {
                        client.DownloadFile("https://nodejs.org/dist/v20.18.0/win-x64/node.exe", target);
                    }
                    if (File.Exists(target)) return target;
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Failed to download runtime: " + ex.Message, "D4Hz Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
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

        private static void CleanupAndExit()
        {
            try
            {
                // Disconnect accounts gracefully via stop endpoint
                using (WebClient wc = new WebClient())
                {
                    wc.UploadString(AppUrl + "/stop", "POST", "");
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
    }
}
