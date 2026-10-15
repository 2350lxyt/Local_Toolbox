// 本地工具箱 · 离线单文件分发器（docs/OFFLINE-PACKAGING.md §4.C 方案 C 的 csc 变体）
// ------------------------------------------------------------------
// 由 Windows 自带的 csc.exe 编译（零外部依赖、零运行时安装），把整份静态站点
// 内嵌为一个 zip 资源，在 127.0.0.1 固定端口上做**只读静态分发**：
//   1. 单实例：启动先探测 /__healthz，已有实例在跑则直接复用并退出；
//   2. 打开：Edge/Chrome --app（无地址栏独立窗口）→ 系统默认浏览器 → 仅打印 URL；
//   3. 安全：只绑定回环地址；资源来自内嵌 zip（键值匹配，无文件系统路径拼接，
//      天然免疫目录穿越）；响应带 Cache-Control: no-store（升级后不得命中旧缓存）；
//   4. 端口：固定 5183（localStorage 按 origin 含端口分区，端口一变布局与历史就丢），
//      被其它程序占用时明确报错，**不得静默换端口**。
// 契约与决策记录：docs/OFFLINE-PACKAGING.md §4.C「C+ 推荐组合」；端口见 DESIGN.md 附录 B。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class PortableServer
{
    private const int Port = 5183;
    private const string HealthPath = "/__healthz";
    private const string HealthBody = "toolbox";
    private const string Url = "http://127.0.0.1:5183/";

    private static Dictionary<string, byte[]> files;

    private static void Main(string[] args)
    {
        bool noOpen = Array.IndexOf(args, "-no-open") >= 0;

        // 单实例探测：已有本工具实例在服务 → 直接复用（打开窗口后退出）
        try
        {
            if (Probe())
            {
                if (!noOpen) OpenApp();
                return;
            }
        }
        catch
        {
            // 探测失败按「无实例」处理，走正常启动
        }

        try
        {
            LoadFiles();
        }
        catch (Exception error)
        {
            Fatal("内嵌资源读取失败：" + error.Message);
            return;
        }

        if (!StartListener()) return; // 端口被其它程序占用：已弹窗说明

        if (!noOpen) OpenApp();
        Thread.Sleep(Timeout.Infinite); // windowsgui 程序没有消息循环，靠这里保活
    }

    /* --------------------------------------------------------- 健康探测 */

    /** 返回 true 表示「端口上已经是本工具的一个实例」；false 表示无实例或被其它程序占用 */
    private static bool Probe()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + HealthPath.TrimStart('/'));
            request.Method = "GET";
            request.Timeout = 900;
            request.ReadWriteTimeout = 900;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return response.StatusCode == HttpStatusCode.OK && reader.ReadToEnd() == HealthBody;
            }
        }
        catch
        {
            return false;
        }
    }

    /* ------------------------------------------------------- 内嵌资源装载 */

    /** 把内嵌 web.zip 全部解到内存（整站实测 763 KB，一次性装载换来零磁盘依赖） */
    private static void LoadFiles()
    {
        files = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        var assembly = Assembly.GetExecutingAssembly();
        using (var stream = assembly.GetManifestResourceStream("web.zip"))
        {
            if (stream == null) throw new InvalidOperationException("缺少内嵌资源 web.zip（构建脚本未完成？）");
            using (var archive = new ZipArchive(stream))
            {
                foreach (var entry in archive.Entries)
                {
                    var name = entry.FullName.Replace('\\', '/');
                    const string prefix = "web/";
                    if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) name = name.Substring(prefix.Length);
                    if (name.Length == 0 || name.EndsWith("/")) continue; // 目录项跳过
                    using (var entryStream = entry.Open())
                    using (var memory = new MemoryStream())
                    {
                        entryStream.CopyTo(memory);
                        files[name] = memory.ToArray();
                    }
                }
            }
        }
    }

    /* --------------------------------------------------------------- 监听 */

    /** 返回 false 表示端口被其它程序占用（已弹窗说明），程序应退出 */
    private static bool StartListener()
    {
        TcpListener listener;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Start();
        }
        catch (SocketException)
        {
            Fatal("端口 " + Port + " 已被其它程序占用。\n\n" +
                  "按设计不静默更换端口：更换端口会使浏览器存储的标签布局与历史失效。\n" +
                  "请结束占用该端口的程序后重试。");
            return false;
        }

        var acceptThread = new Thread(AcceptLoop);
        acceptThread.IsBackground = true;
        acceptThread.Start(listener);
        return true;
    }

    private static void AcceptLoop(object state)
    {
        var listener = (TcpListener)state;
        while (true)
        {
            TcpClient client;
            try
            {
                client = listener.AcceptTcpClient();
            }
            catch
            {
                return; // 监听器已关闭
            }
            ThreadPool.QueueUserWorkItem(delegate { Handle(client); });
        }
    }

    /* ----------------------------------------------------------- 请求处理 */

    private static void Handle(TcpClient client)
    {
        try
        {
            client.ReceiveTimeout = 3000;
            var stream = client.GetStream();

            var requestLine = ReadLine(stream);
            if (requestLine == null) return;
            var parts = requestLine.Split(' ');
            if (parts.Length < 2) return;
            var method = parts[0];
            var target = parts[1];

            string header;
            while ((header = ReadLine(stream)) != null && header.Length > 0) { } // 读完头部（忽略）

            if (method != "GET" && method != "HEAD")
            {
                WriteText(stream, 405, "Method Not Allowed", "text/plain", false);
                return;
            }

            var path = target;
            var query = path.IndexOf('?');
            if (query >= 0) path = path.Substring(0, query);
            if (path == HealthPath)
            {
                WriteText(stream, 200, HealthBody, "text/plain", method == "HEAD");
                return;
            }
            if (path == "/") path = "/index.html";

            // 键值匹配：键来自内嵌 zip，不含任何文件系统路径 → 「..」不可能命中任何键（天然免疫穿越）
            var key = Uri.UnescapeDataString(path).TrimStart('/').Replace('\\', '/');
            if (key.Length == 0) key = "index.html";

            byte[] body;
            if (!files.TryGetValue(key, out body))
            {
                WriteText(stream, 404, "404 not found: " + key, "text/plain", method == "HEAD");
                return;
            }
            WriteBytes(stream, 200, body, ContentType(key), method == "HEAD");
        }
        catch
        {
            // 客户端中断 / 读超时：按连接失败处理
        }
        finally
        {
            try { client.Close(); } catch { }
        }
    }

    private static string ReadLine(NetworkStream stream)
    {
        var buffer = new StringBuilder(128);
        var one = new byte[1];
        while (true)
        {
            int read;
            try
            {
                read = stream.Read(one, 0, 1);
            }
            catch
            {
                return null;
            }
            if (read <= 0) return buffer.Length > 0 ? buffer.ToString() : null;
            var ch = (char)one[0];
            if (ch == '\n') return buffer.ToString().TrimEnd('\r');
            buffer.Append(ch);
            if (buffer.Length > 16384) return null; // 异常请求防御
        }
    }

    /* ------------------------------------------------------------- 响应 */

    private static void WriteText(NetworkStream stream, int status, string text, string contentType, bool headOnly)
    {
        WriteBytes(stream, status, Encoding.UTF8.GetBytes(text), contentType, headOnly);
    }

    private static void WriteBytes(NetworkStream stream, int status, byte[] body, string contentType, bool headOnly)
    {
        var isText = contentType.StartsWith("text/") || contentType == "application/json" || contentType == "image/svg+xml";
        var header =
            "HTTP/1.1 " + status + " " + Reason(status) + "\r\n" +
            "Content-Type: " + contentType + (isText ? "; charset=utf-8" : "") + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Cache-Control: no-store\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Connection: close\r\n" +
            "\r\n";
        var head = Encoding.ASCII.GetBytes(header);
        stream.Write(head, 0, head.Length);
        if (!headOnly && body.Length > 0) stream.Write(body, 0, body.Length);
    }

    private static string Reason(int status)
    {
        if (status == 200) return "OK";
        if (status == 404) return "Not Found";
        if (status == 405) return "Method Not Allowed";
        return "OK";
    }

    private static string ContentType(string key)
    {
        var ext = Path.GetExtension(key).ToLowerInvariant();
        switch (ext)
        {
            case ".html":
            case ".htm":
                return "text/html";
            case ".css":
                return "text/css";
            case ".js":
            case ".mjs":
                return "text/javascript";
            case ".json":
            case ".map":
                return "application/json";
            case ".svg":
                return "image/svg+xml";
            case ".ico":
                return "image/x-icon";
            case ".png":
                return "image/png";
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".txt":
                return "text/plain";
            default:
                return "application/octet-stream";
        }
    }

    /* ------------------------------------------------------- 打开应用窗口 */

    /** 三级回退：Edge/Chrome --app（无地址栏独立窗口）→ 系统默认浏览器 → 弹窗给出 URL */
    private static void OpenApp()
    {
        foreach (var candidate in BrowserCandidates())
        {
            if (!File.Exists(candidate)) continue;
            try
            {
                Process.Start(candidate, "--app=" + Url + " --window-size=1280,860");
                return;
            }
            catch
            {
                // 换下一个候选
            }
        }
        try
        {
            Process.Start(Url); // 系统默认浏览器（普通标签页）
        }
        catch
        {
            Fatal("无法自动打开浏览器。请手动访问：\n" + Url);
        }
    }

    private static IEnumerable<string> BrowserCandidates()
    {
        var x86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var x64 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        yield return Path.Combine(x86, @"Microsoft\Edge\Application\msedge.exe");
        yield return Path.Combine(x64, @"Microsoft\Edge\Application\msedge.exe");
        yield return Path.Combine(local, @"Google\Chrome\Application\chrome.exe");
        yield return Path.Combine(x64, @"Google\Chrome\Application\chrome.exe");
        yield return Path.Combine(x86, @"Google\Chrome\Application\chrome.exe");
    }

    /* --------------------------------------------------------------- 错误 */

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    /** windowsgui 程序没有控制台，致命错误用消息框表达（§1.3：不出现不可读的失败） */
    private static void Fatal(string message)
    {
        try
        {
            MessageBoxW(IntPtr.Zero, message, "本地工具箱（离线版）", 0x10);
        }
        catch
        {
            // 极端环境下消息框也不可用：只能静默退出
        }
    }
}
