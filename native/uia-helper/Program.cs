// DesktopCatUia: geometry-only UI Automation helper for Desktop Cat.
//
// Protocol: one JSON object per line on stdin/stdout (UTF-8, '\n').
//   requests  {"id":1,"op":"ping"} | {"id":2,"op":"strip","hwnd":"<decimal>"} |
//             {"id":3,"op":"watch","hwnds":["<decimal>",...]} | {"op":"quit"}
//   responses {"id":N,"ok":true,...} | {"id":N|null,"ok":false,"error":"<code>","detail":"<type>"|null}
//   events    {"event":"selected"|"structure","hwnd":"<decimal>"}
// The helper exits when stdin closes or on "quit". It never prints names or any other text read
// from other processes: only rectangles, flags, counts and fixed protocol strings.
// Protocol 2 (ADR 0003 §7.1): strips carry "kind" ("chromium" | "tabview") and ping lists "kinds";
// the app compares the version exactly, so both ends move together.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace DesktopCat.Uia
{
    internal static class Program
    {
        internal const int ProtocolVersion = 2;
        private const int MaxLineChars = 16 * 1024;
        private const int QueueCapacity = 64;
        private const int ExitWatchdogMs = 3000;
        private const string TooLongMarker = "\u0000too-long";

        private static readonly object OutLock = new object();
        private static StreamWriter output;
        private static volatile bool outputBroken;
        private static string dpiMode = "unaware";

        [MTAThread]
        private static int Main(string[] args)
        {
            // Must be the first call: every UI Automation rectangle must come back in physical px.
            dpiMode = Native.EnableDpiAwareness();

            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 4096);
            output.NewLine = "\n";
            output.AutoFlush = false;

            if (args.Length == 1 && args[0] == "--version")
            {
                WriteLine(new JsonWriter().BeginObject().Key("version").Value((long)ProtocolVersion).Key("dpi").Value(dpiMode).EndObject().ToString());
                return 0;
            }

            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 4096);
            var queue = new BlockingCollection<string>(QueueCapacity);
            var reader = new Thread(() => ReadLoop(input, queue));
            reader.IsBackground = true;
            reader.Name = "stdin";
            reader.Start();

            using (var events = new EventSink(WriteLine))
            {
                var strips = new TabStripReader(events);
                try
                {
                    foreach (string line in queue.GetConsumingEnumerable())
                    {
                        if (!Dispatch(line, strips)) break;
                        if (outputBroken) break;
                    }
                }
                finally
                {
                    strips.Shutdown();
                }
            }
            return 0;
        }

        /// <summary>Reads bounded lines; overlong lines are replaced by a marker. Ends the queue at EOF.</summary>
        private static void ReadLoop(StreamReader input, BlockingCollection<string> queue)
        {
            var sb = new StringBuilder();
            bool tooLong = false;
            try
            {
                while (true)
                {
                    int c = input.Read();
                    if (c < 0) break;
                    if (c == '\n')
                    {
                        string line = tooLong ? TooLongMarker : sb.ToString();
                        sb.Clear();
                        tooLong = false;
                        if (!queue.TryAdd(line)) WriteLine(ErrorLine(PeekId(line), "busy", null));
                        continue;
                    }
                    if (tooLong) continue;
                    if (sb.Length >= MaxLineChars)
                    {
                        tooLong = true;
                        sb.Clear();
                        continue;
                    }
                    sb.Append((char)c);
                }
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
            finally
            {
                queue.CompleteAdding();
                // stdin closed: the main loop drains and exits; if a provider call hangs, exit anyway.
                var watchdog = new Thread(() =>
                {
                    Thread.Sleep(ExitWatchdogMs);
                    Environment.Exit(0);
                });
                watchdog.IsBackground = true;
                watchdog.Start();
            }
        }

        private static long? PeekId(string line)
        {
            try
            {
                var req = JsonReader.Parse(line) as Dictionary<string, object>;
                return req == null ? null : ReadId(req);
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private static long? ReadId(Dictionary<string, object> req)
        {
            object v;
            if (!req.TryGetValue("id", out v) || !(v is double)) return null;
            double d = (double)v;
            if (d < 1 || d > int.MaxValue || Math.Floor(d) != d) return null;
            return (long)d;
        }

        /// <summary>Handles one request line; false ends the helper.</summary>
        private static bool Dispatch(string raw, TabStripReader strips)
        {
            if (raw == TooLongMarker)
            {
                WriteLine(ErrorLine(null, "too-long", null));
                return true;
            }
            string line = raw.TrimEnd('\r');
            // Some hosts prefix the stream with a UTF-8 byte order mark.
            if (line.Length > 0 && line[0] == '﻿') line = line.Substring(1);
            if (line.Length == 0) return true;
            Dictionary<string, object> req;
            try
            {
                req = JsonReader.Parse(line) as Dictionary<string, object>;
            }
            catch (FormatException)
            {
                WriteLine(ErrorLine(null, "bad-json", null));
                return true;
            }
            if (req == null)
            {
                WriteLine(ErrorLine(null, "bad-request", null));
                return true;
            }
            object opValue;
            string op = req.TryGetValue("op", out opValue) ? opValue as string : null;
            if (op == "quit") return false;
            long? id = ReadId(req);
            if (!id.HasValue)
            {
                WriteLine(ErrorLine(null, "bad-request", null));
                return true;
            }
            try
            {
                switch (op)
                {
                    case "ping":
                        WriteLine(PongLine(id.Value, strips));
                        break;
                    case "strip":
                        object hwnd;
                        WriteLine(strips.Strip(id.Value, req.TryGetValue("hwnd", out hwnd) ? hwnd as string : null));
                        break;
                    case "watch":
                        WriteLine(strips.Watch(id.Value, ReadHwnds(req)));
                        break;
                    default:
                        WriteLine(ErrorLine(id, "bad-op", null));
                        break;
                }
            }
            catch (Exception ex)
            {
                WriteLine(ErrorLine(id, "internal", ex.GetType().Name));
            }
            return true;
        }

        private static List<string> ReadHwnds(Dictionary<string, object> req)
        {
            object v;
            if (!req.TryGetValue("hwnds", out v)) return null;
            var list = v as List<object>;
            if (list == null) return null;
            var result = new List<string>();
            foreach (object item in list)
            {
                var s = item as string;
                if (s == null) return null;
                result.Add(s);
            }
            return result;
        }

        private static string PongLine(long id, TabStripReader strips)
        {
            return new JsonWriter().BeginObject().Id(id).Key("ok").Value(true).Key("pong").Value(true)
                .Key("version").Value((long)ProtocolVersion).Key("dpi").Value(dpiMode)
                .Key("watching").Value((long)strips.WatchCount)
                .Key("prunedRender").Value((long)TabStripReader.PrunedRenderWidgets)
                .Key("prunedOther").Value((long)TabStripReader.PrunedOtherWindows)
                .Key("kinds").BeginArray().Value("chromium").Value("tabview").EndArray().EndObject().ToString();
        }

        internal static string ErrorLine(long? id, string code, string detail)
        {
            var w = new JsonWriter().BeginObject().Id(id).Key("ok").Value(false).Key("error").Value(code);
            w.Key("detail");
            if (detail == null) w.Null();
            else w.Value(detail.Length > 64 ? detail.Substring(0, 64) : detail);
            return w.EndObject().ToString();
        }

        internal static void WriteLine(string json)
        {
            lock (OutLock)
            {
                if (outputBroken) return;
                try
                {
                    output.Write(json);
                    output.Write('\n');
                    output.Flush();
                }
                catch (IOException)
                {
                    outputBroken = true;
                }
                catch (ObjectDisposedException)
                {
                    outputBroken = true;
                }
            }
        }
    }

    /// <summary>
    /// Coalesces UI Automation events into at most one line per (kind, window) per 250 ms
    /// (leading edge plus one trailing line). Notify runs on UI Automation's threads and never
    /// touches the sender element.
    /// </summary>
    internal sealed class EventSink : IDisposable
    {
        private const long WindowMs = 250;
        private readonly object gate = new object();
        private readonly Action<string> write;
        private readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
        private readonly Dictionary<string, long> lastEmit = new Dictionary<string, long>(StringComparer.Ordinal);
        private readonly HashSet<string> pending = new HashSet<string>(StringComparer.Ordinal);
        private HashSet<string> watched = new HashSet<string>(StringComparer.Ordinal);
        private readonly Timer timer;
        private bool timerArmed;
        private bool disposed;

        internal EventSink(Action<string> write)
        {
            this.write = write;
            timer = new Timer(Flush, null, Timeout.Infinite, Timeout.Infinite);
        }

        internal void SetWatched(IEnumerable<string> hwnds)
        {
            lock (gate)
            {
                watched = new HashSet<string>(hwnds, StringComparer.Ordinal);
                pending.RemoveWhere(key => !watched.Contains(HwndOf(key)));
                var stale = new List<string>();
                foreach (string key in lastEmit.Keys) if (!watched.Contains(HwndOf(key))) stale.Add(key);
                foreach (string key in stale) lastEmit.Remove(key);
            }
        }

        internal void Notify(string hwnd, string kind)
        {
            string line;
            lock (gate)
            {
                if (disposed || !watched.Contains(hwnd)) return;
                string key = kind + ":" + hwnd;
                long now = clock.ElapsedMilliseconds;
                long last;
                if (lastEmit.TryGetValue(key, out last) && now - last < WindowMs)
                {
                    pending.Add(key);
                    if (!timerArmed)
                    {
                        timerArmed = true;
                        timer.Change(WindowMs, Timeout.Infinite);
                    }
                    return;
                }
                lastEmit[key] = now;
                line = Line(kind, hwnd);
            }
            write(line);
        }

        private void Flush(object state)
        {
            var lines = new List<string>();
            lock (gate)
            {
                timerArmed = false;
                if (disposed) return;
                long now = clock.ElapsedMilliseconds;
                var due = new List<string>();
                foreach (string key in pending)
                {
                    long last;
                    if (!lastEmit.TryGetValue(key, out last) || now - last >= WindowMs) due.Add(key);
                }
                foreach (string key in due)
                {
                    pending.Remove(key);
                    lastEmit[key] = now;
                    int sep = key.IndexOf(':');
                    lines.Add(Line(key.Substring(0, sep), key.Substring(sep + 1)));
                }
                if (pending.Count > 0)
                {
                    timerArmed = true;
                    timer.Change(WindowMs, Timeout.Infinite);
                }
            }
            foreach (string line in lines) write(line);
        }

        private static string HwndOf(string key)
        {
            return key.Substring(key.IndexOf(':') + 1);
        }

        private static string Line(string kind, string hwnd)
        {
            return new JsonWriter().BeginObject().Key("event").Value(kind).Key("hwnd").Value(hwnd).EndObject().ToString();
        }

        public void Dispose()
        {
            lock (gate)
            {
                disposed = true;
                pending.Clear();
            }
            timer.Dispose();
        }
    }
}
