// Karip Traker — ağ okuma motoru (AION 2 oyun trafiği, sadece okuma).
//
// Npcap ile, yalnızca AION2.exe'nin kendi TCP bağlantılarına gelen trafiğin bir kopyasını okur. Oyuna, oyun
// dosyalarına ya da belleğine dokunmaz; hiçbir paket göndermez ya da değiştirmez.
//
// Protokol bilgisi (çerçeve yapısı, işlem kodları, kayıt düzenleri) topluluğun açık kaynak sayaçlarından öğrenildi:
//   A2Tools DPS Meter (github.com/taengu/A2Tools-DPS-Meter) ve Aion2-Dps-Meter (github.com/TK-open-public, MIT).
// Kod bu proje için baştan yazıldı.
//
// Akış:  yakalama → TCP birleştirme (sıra, kayıp, yeniden hizalama) → çerçeveler (varint uzunluk, FF FF + LZ4 demet,
//        araya karışan TLS kayıtları atlanır) → ayrıştırıcılar → durum (hasar, boss, enerji) + olay kuyruğu.
//
// PowerShell 5.1'in derleyicisi C# 5'tir: $"..", ?., out var, => gövdeleri kullanılmaz.

using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class A2Net {
  // ------------------------------------------------------------------ Npcap (wpcap.dll)
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryEx(string path, IntPtr h, uint flags);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern int pcap_findalldevs(out IntPtr all, StringBuilder err);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern void pcap_freealldevs(IntPtr all);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] static extern IntPtr pcap_open_live(string dev, int snaplen, int promisc, int toMs, StringBuilder err);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] static extern int pcap_compile(IntPtr p, IntPtr prog, string str, int optimize, uint netmask);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern int pcap_setfilter(IntPtr p, IntPtr prog);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern void pcap_freecode(IntPtr prog);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern int pcap_next_ex(IntPtr p, out IntPtr hdr, out IntPtr data);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern int pcap_datalink(IntPtr p);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern void pcap_close(IntPtr p);
  [DllImport("wpcap.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr pcap_geterr(IntPtr p);

  // ------------------------------------------------------------------ AION2.exe'nin TCP bağlantıları
  [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr tbl, ref int size, bool order, int af, int cls, uint reserved);

  public class Conn { public uint LocalIp; public int LocalPort; public uint RemoteIp; public int RemotePort; }

  static List<Conn> GameConnections(out int pid) {
    pid = 0;
    var list = new List<Conn>();
    Process[] ps = Process.GetProcessesByName("AION2");
    if (ps.Length == 0) return list;
    var pids = new HashSet<int>();
    foreach (var p in ps) { pids.Add(p.Id); if (pid == 0) pid = p.Id; p.Dispose(); }
    int size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
    IntPtr buf = Marshal.AllocHGlobal(size + 4096);
    try {
      size += 4096;
      if (GetExtendedTcpTable(buf, ref size, false, 2, 5, 0) != 0) return list;
      int n = Marshal.ReadInt32(buf);
      for (int i = 0; i < n; i++) {
        IntPtr row = IntPtr.Add(buf, 4 + i * 24);
        int state = Marshal.ReadInt32(row);
        int owner = Marshal.ReadInt32(row, 20);
        if (state != 5 || !pids.Contains(owner)) continue;            // 5: ESTABLISHED
        var c = new Conn();
        c.LocalIp = (uint)Marshal.ReadInt32(row, 4);
        c.LocalPort = PortOf(Marshal.ReadInt32(row, 8));
        c.RemoteIp = (uint)Marshal.ReadInt32(row, 12);
        c.RemotePort = PortOf(Marshal.ReadInt32(row, 16));
        if (c.RemotePort == 443 || c.RemotePort == 80 || c.RemoteIp == 0) continue;   // web (giriş/başlatıcı): şifreli, oyun verisi yok
        list.Add(c);
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return list;
  }
  static int PortOf(int raw) { return ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF); }
  static string Ip(uint a) { return string.Format("{0}.{1}.{2}.{3}", a & 0xFF, (a >> 8) & 0xFF, (a >> 16) & 0xFF, a >> 24); }

  // ------------------------------------------------------------------ Durum
  public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();   // PowerShell'e olaylar
  static readonly object Lock = new object();
  static Thread worker;
  static volatile bool running;
  public static string Status = "başlatılmadı";
  public static string Error = "";
  public static bool NpcapOk;
  public static int GamePid;
  public static string ConnText = "";
  public static long Packets, Bytes, Frames, Bundles, Resyncs, Gaps;
  public static long LastDataMs;
  public static string RecordPath;          // boş değilse gelen veri (birleştirilmiş akış) dosyaya yazılır (geliştirme için)

  static long NowMs() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

  public static void Start() {
    if (running) return;
    running = true;
    worker = new Thread(Run);
    worker.IsBackground = true;
    worker.Name = "A2Net";
    worker.Start();
  }
  public static void Stop() { running = false; }

  static bool LoadNpcap() {
    string sys = Environment.GetFolderPath(Environment.SpecialFolder.System);
    foreach (var p in new[] { Path.Combine(sys, "Npcap\\wpcap.dll"), Path.Combine(sys, "wpcap.dll") }) {
      if (File.Exists(p) && LoadLibraryEx(p, IntPtr.Zero, 0x8) != IntPtr.Zero) return true;   // 0x8: Packet.dll'i aynı klasörden yükle
    }
    return false;
  }

  // Yerel adrese göre ağ aygıtı (oyun bağlantısının geldiği kart). 127.0.0.1 ise Npcap'in loopback aygıtı (ping düşürücü/VPN).
  static string DeviceFor(uint localIp) {
    IntPtr all; var err = new StringBuilder(512);
    if (pcap_findalldevs(out all, err) != 0) { Error = "Npcap aygıtları alınamadı: " + err; return null; }
    string found = null, loop = null;
    try {
      for (IntPtr d = all; d != IntPtr.Zero; d = Marshal.ReadIntPtr(d)) {
        string name = Marshal.PtrToStringAnsi(Marshal.ReadIntPtr(d, IntPtr.Size));
        if (name != null && name.IndexOf("Loopback", StringComparison.OrdinalIgnoreCase) >= 0) loop = name;
        for (IntPtr a = Marshal.ReadIntPtr(d, IntPtr.Size * 3); a != IntPtr.Zero; a = Marshal.ReadIntPtr(a)) {
          IntPtr sa = Marshal.ReadIntPtr(a, IntPtr.Size);
          if (sa == IntPtr.Zero || Marshal.ReadInt16(sa) != 2) continue;          // AF_INET
          if ((uint)Marshal.ReadInt32(sa, 4) == localIp) { found = name; break; }
        }
        if (found != null) break;
      }
    } finally { pcap_freealldevs(all); }
    if (found == null && (localIp & 0xFF) == 127) found = loop;
    return found;
  }

  static void Run() {
    try {
      NpcapOk = LoadNpcap();
      if (!NpcapOk) { Status = "Npcap bulunamadı"; Error = "Npcap kurulu değil (npcap.com)."; running = false; return; }
      IntPtr handle = IntPtr.Zero; string openKey = ""; int link = 1;
      List<Conn> conns = new List<Conn>();
      long nextScan = 0;
      while (running) {
        long now = NowMs();
        if (now >= nextScan) {
          nextScan = now + 2000;
          int pid; var cs = GameConnections(out pid);
          GamePid = pid;
          var keyB = new StringBuilder();
          foreach (var c in cs) keyB.Append(c.LocalIp).Append(':').Append(c.LocalPort).Append('>').Append(c.RemoteIp).Append(':').Append(c.RemotePort).Append(';');
          string key = keyB.ToString();
          if (key != openKey) {
            if (handle != IntPtr.Zero) { pcap_close(handle); handle = IntPtr.Zero; }
            openKey = key; conns = cs;
            lock (Lock) { streams.Clear(); }
            if (cs.Count == 0) {
              Status = pid == 0 ? "oyun kapalı" : "oyun açık, sunucu bağlantısı bekleniyor";
              ConnText = "";
            } else {
              string dev = DeviceFor(cs[0].LocalIp);
              if (dev == null) { Status = "ağ aygıtı bulunamadı"; }
              else {
                var err = new StringBuilder(512);
                handle = pcap_open_live(dev, 262144, 0, 200, err);
                if (handle == IntPtr.Zero) { Status = "yakalama açılamadı"; Error = err.ToString(); }
                else {
                  var ports = new List<string>();
                  foreach (var c in cs) ports.Add("port " + c.LocalPort);
                  string filter = "tcp and (" + string.Join(" or ", ports) + ")";
                  IntPtr prog = Marshal.AllocHGlobal(16);
                  if (pcap_compile(handle, prog, filter, 1, 0xFFFFFFFF) == 0) { pcap_setfilter(handle, prog); pcap_freecode(prog); }
                  else Error = "filtre: " + Marshal.PtrToStringAnsi(pcap_geterr(handle));
                  Marshal.FreeHGlobal(prog);
                  link = pcap_datalink(handle);
                  var t = new List<string>();
                  foreach (var c in cs) t.Add(Ip(c.RemoteIp) + ":" + c.RemotePort);
                  ConnText = string.Join(", ", t);
                  Status = "dinleniyor";
                }
              }
            }
          }
        }
        if (handle == IntPtr.Zero) { Thread.Sleep(300); continue; }
        // Bir seferde birikmiş paketleri oku (zaman aşımı 200 ms)
        for (int k = 0; k < 2000 && running; k++) {
          IntPtr hdr, data;
          int r = pcap_next_ex(handle, out hdr, out data);
          if (r == 0) break;                      // zaman aşımı
          if (r < 0) { pcap_close(handle); handle = IntPtr.Zero; openKey = ""; Status = "yakalama kesildi, yeniden deneniyor"; break; }
          int caplen = Marshal.ReadInt32(hdr, 8);
          var pkt = new byte[caplen];
          Marshal.Copy(data, pkt, 0, caplen);
          try { OnFrame(pkt, link, conns); } catch (Exception ex) { Error = "işleme: " + ex.Message; }
        }
        FlushStale();
      }
      if (handle != IntPtr.Zero) pcap_close(handle);
    } catch (Exception ex) { Status = "durdu"; Error = ex.ToString(); }
  }

  // ------------------------------------------------------------------ Ethernet / IPv4 / TCP
  static void OnFrame(byte[] f, int link, List<Conn> conns) {
    int o;
    if (link == 1) {                                   // Ethernet (+ VLAN)
      o = 12; int et = (f[o] << 8) | f[o + 1];
      while (et == 0x8100 || et == 0x88A8) { o += 4; if (o + 2 > f.Length) return; et = (f[o] << 8) | f[o + 1]; }
      if (et != 0x0800) return; o += 2;
    } else if (link == 0 || link == 108) { o = 4; }    // Npcap loopback (DLT_NULL)
    else if (link == 12 || link == 101) { o = 0; }    // ham IP
    else return;
    if (o + 20 > f.Length || (f[o] >> 4) != 4 || f[o + 9] != 6) return;
    int ihl = (f[o] & 0x0F) * 4;
    int total = (f[o + 2] << 8) | f[o + 3];
    int ipEnd = Math.Min(f.Length, o + total);
    uint src = BitConverter.ToUInt32(f, o + 12);
    int t = o + ihl;
    if (t + 20 > ipEnd) return;
    int sport = (f[t] << 8) | f[t + 1], dport = (f[t + 2] << 8) | f[t + 3];
    uint seq = (uint)((f[t + 4] << 24) | (f[t + 5] << 16) | (f[t + 6] << 8) | f[t + 7]);
    int thl = (f[t + 12] >> 4) * 4;
    int flags = f[t + 13];
    int p = t + thl;
    // Sadece sunucudan oyuna gelen yön
    bool inbound = false;
    foreach (var c in conns) if (c.RemoteIp == src && c.RemotePort == sport && c.LocalPort == dport) { inbound = true; break; }
    if (!inbound) return;
    Interlocked.Increment(ref Packets);
    string key = src + ":" + sport + ">" + dport;
    if ((flags & 0x02) != 0) { lock (Lock) streams.Remove(key); return; }   // SYN: yeni bağlantı
    int len = ipEnd - p;
    if (len <= 0) return;
    var payload = new byte[len];
    Buffer.BlockCopy(f, p, payload, 0, len);
    Interlocked.Add(ref Bytes, len);
    lock (Lock) { Segment(key, seq, payload); }
  }

  // ------------------------------------------------------------------ TCP birleştirme
  // Sıra numarasına göre birleştirilir. Önden gelen parçalar (araya kayıp girmiş) bekletilir; kayıp 1,5 sn içinde
  // gelmezse boşluk atlanır ve akış ilk tam çerçeveden yeniden hizalanır.
  class Stream {
    public bool Init; public uint Next; public bool Resync = true;
    public List<KeyValuePair<uint, byte[]>> Pending = new List<KeyValuePair<uint, byte[]>>();
    public long PendingBytes; public long GapSince;
    public byte[] Buf = new byte[0];
    public int Id = ++streamSeq;
  }
  static int streamSeq;
  static readonly Dictionary<string, Stream> streams = new Dictionary<string, Stream>();

  static void Segment(string key, uint seq, byte[] data) {
    Stream s;
    if (!streams.TryGetValue(key, out s)) { s = new Stream(); streams[key] = s; }
    if (!s.Init) { s.Init = true; s.Next = seq; s.Resync = true; }   // ortadan başlandı → ilk tam çerçeveyi ara
    int rel = (int)(seq - s.Next);
    if (rel > 0) {                                            // önden geldi: beklet
      if (s.Pending.Count < 4096) {
        s.Pending.Add(new KeyValuePair<uint, byte[]>(seq, data)); s.PendingBytes += data.Length;
        if (s.GapSince == 0) s.GapSince = NowMs();
      }
      if (s.PendingBytes > 2 * 1024 * 1024) SkipGap(s);
      return;
    }
    Take(s, seq, data);
    Drain(s);
  }
  // Sıradaki (ya da kısmen tekrar gönderilmiş) parçayı akışa ekle
  static void Take(Stream s, uint seq, byte[] data) {
    int rel = (int)(seq - s.Next);
    if (rel + data.Length <= 0) return;                       // tamamen tekrar gönderim
    if (rel < 0) { var t = new byte[rel + data.Length]; Buffer.BlockCopy(data, -rel, t, 0, t.Length); data = t; }
    s.Next += (uint)data.Length;
    var nb = new byte[s.Buf.Length + data.Length];
    Buffer.BlockCopy(s.Buf, 0, nb, 0, s.Buf.Length);
    Buffer.BlockCopy(data, 0, nb, s.Buf.Length, data.Length);
    s.Buf = nb;
    if (RecordPath != null) Record(s.Id, data);
    Consume(s);
  }
  // Bekleyenlerden sırası gelenleri ekle
  static void Drain(Stream s) {
    bool moved = true;
    while (moved && s.Pending.Count > 0) {
      moved = false;
      for (int i = 0; i < s.Pending.Count; i++) {
        var kv = s.Pending[i];
        if ((int)(kv.Key - s.Next) <= 0) {
          s.Pending.RemoveAt(i); s.PendingBytes -= kv.Value.Length;
          Take(s, kv.Key, kv.Value); moved = true; break;
        }
      }
    }
    s.GapSince = s.Pending.Count > 0 ? (s.GapSince == 0 ? NowMs() : s.GapSince) : 0;
  }
  // Kayıp parça gelmedi: boşluğu atla, en yakın bekleyen parçadan yeniden hizalan
  static void SkipGap(Stream s) {
    if (s.Pending.Count == 0) return;
    Interlocked.Increment(ref Gaps);
    int best = int.MaxValue; uint seq = 0;
    foreach (var kv in s.Pending) { int r = (int)(kv.Key - s.Next); if (r < best) { best = r; seq = kv.Key; } }
    s.Next = seq; s.Buf = new byte[0]; s.Resync = true; s.GapSince = 0;
    Drain(s);
  }
  static void FlushStale() {
    lock (Lock) {
      long now = NowMs();
      foreach (var s in streams.Values) if (s.GapSince > 0 && now - s.GapSince > 1500) SkipGap(s);
    }
  }

  static FileStream rec;
  // Kayıt biçimi: [u64 ms][u32 uzunluk][u32 akış no][veri] …
  static void Record(int sid, byte[] d) {
    try {
      if (rec == null) rec = new FileStream(RecordPath, FileMode.Append, FileAccess.Write, FileShare.Read);
      var h = new byte[16];
      BitConverter.GetBytes(NowMs()).CopyTo(h, 0); BitConverter.GetBytes(d.Length).CopyTo(h, 8); BitConverter.GetBytes(sid).CopyTo(h, 12);
      rec.Write(h, 0, 16); rec.Write(d, 0, d.Length); rec.Flush();
    } catch { }
  }
  public static void StopRecording() { RecordPath = null; try { if (rec != null) rec.Dispose(); } catch { } rec = null; }

  // ------------------------------------------------------------------ Çerçeveler
  public struct VarInt { public int Value; public int Length; }
  public static VarInt ReadVarint(byte[] b, int at, int end) {
    VarInt r; r.Value = 0; r.Length = -1;
    int value = 0, shift = 0, count = 0;
    while (true) {
      if (at + count >= end) return r;
      int bv = b[at + count]; count++;
      value |= (bv & 0x7F) << shift;
      if ((bv & 0x80) == 0) { r.Value = value; r.Length = count; return r; }
      shift += 7;
      if (shift >= 32) return r;
    }
  }
  static bool TryVarint(byte[] b, ref int at, int end, out int v) {
    var r = ReadVarint(b, at, end); v = 0;
    if (r.Length <= 0 || r.Value < 0) return false;
    at += r.Length; v = r.Value; return true;
  }
  static int FrameSize(int value, int vlen) { long s = (long)value - 4 + vlen; return (s >= vlen && s > 0 && s <= 65535) ? (int)s : -1; }
  static bool BundleHeaderAt(byte[] b, int at, int end) {
    if (at + 6 > end) return false;
    uint size = BitConverter.ToUInt32(b, at + 2);
    return b[at] == 0xFF && b[at + 1] == 0xFF && size > 0 && size <= 1000000;
  }
  static int TlsRecordSize(byte[] b, int at, int end) {
    if (at + 5 > end || b[at] < 0x14 || b[at] > 0x17 || b[at + 1] != 0x03 || b[at + 2] < 1 || b[at + 2] > 4) return -1;
    int len = (b[at + 3] << 8) | b[at + 4];
    return len <= 16640 ? 5 + len : -1;
  }
  static readonly byte[] CommonHigh = { 0x36, 0x37, 0x38, 0x8D, 0xFF };

  // Akıştan tamamlanmış çerçeveleri çıkar ve işle; yarım kalanı sakla.
  static void Consume(Stream s) {
    byte[] b = s.Buf; int end = b.Length; int off = 0;
    if (s.Resync) {
      int st = ResyncStart(b, end);
      if (st < 0) { if (end > 65536) s.Buf = Tail(b, end - 8192); return; }
      if (st > 0) Interlocked.Increment(ref Resyncs);
      off = st; s.Resync = false;
    }
    while (off < end) {
      if (b[off] == 0) { off++; continue; }
      int tls = TlsRecordSize(b, off, end);
      if (tls > 0) { if (off + tls > end) break; off += tls; continue; }
      var li = ReadVarint(b, off, end);
      if (li.Length <= 0 || li.Value <= 0) { if (off + 5 > end) break; off++; continue; }
      int size = FrameSize(li.Value, li.Length);
      if (size < 0) { off++; continue; }
      if (off + size > end) {
        int limit = BundleHeaderAt(b, off + li.Length, end) ? 65535 : 16384;
        if (size > limit) { off++; continue; }
        break;                                                          // parça bekleniyor
      }
      Interlocked.Increment(ref Frames);
      LastDataMs = NowMs();
      int ps = off + li.Length;
      if (ps + 1 < off + size && b[ps] == 0xFF && b[ps + 1] == 0xFF) Bundle(b, ps, off + size, 1);
      else Packet(b, off, off + size);
      off += size;
    }
    s.Buf = off >= end ? new byte[0] : Tail(b, off);
  }
  static byte[] Tail(byte[] b, int from) { var t = new byte[b.Length - from]; Buffer.BlockCopy(b, from, t, 0, t.Length); return t; }

  // Kopukluktan sonra ilk tam çerçevenin yeri: art arda 3 çerçeve (ya da 2 + sonu) tutarlı okunmalı.
  static int ResyncStart(byte[] b, int end) {
    int lim = Math.Min(end, 8192);
    for (int from = 0; from < lim; from++) {
      if (b[from] == 0) continue;
      int at = from, whole = 0; bool firstBundle = false, ok = false, decided = false;
      while (!decided) {
        while (at < end && b[at] == 0) at++;
        if (at >= end) { ok = whole >= 2 || (whole == 1 && firstBundle); break; }
        var li = ReadVarint(b, at, end);
        if (li.Length <= 0 || li.Value <= 0) break;
        int size = FrameSize(li.Value, li.Length);
        if (size < 0) break;
        int pl = at + li.Length;
        bool opens = pl + 1 < end && Array.IndexOf(CommonHigh, b[pl + 1]) >= 0;
        if (whole < 2 && !opens) break;
        bool bundle = BundleHeaderAt(b, pl, end);
        if (at + size > end) { ok = size <= (bundle ? 65535 : 16384) && (whole >= 2 || (whole == 1 && bundle)); break; }
        if (whole == 0) firstBundle = bundle;
        whole++;
        if (whole >= 3) { ok = true; break; }
        at += size;
      }
      if (ok) return from;
    }
    return -1;
  }

  static void Bundle(byte[] b, int ffAt, int end, int depth) {
    if (end - ffAt < 7 || depth > 4) return;
    int size = (int)BitConverter.ToUInt32(b, ffAt + 2);
    if (size <= 0 || size > 1000000) return;
    byte[] d = Lz4(b, ffAt + 6, end - ffAt - 6, size);
    if (d == null) return;
    Interlocked.Increment(ref Bundles);
    int off = 0, n = d.Length;
    while (off < n) {
      if (d[off] == 0) { off++; continue; }
      var li = ReadVarint(d, off, n);
      if (li.Length <= 0 || li.Value <= 0) break;
      int fs = FrameSize(li.Value, li.Length);
      if (fs < 0 || off + fs > n) break;
      int ps = off + li.Length;
      if (ps + 1 < off + fs && d[ps] == 0xFF && d[ps + 1] == 0xFF) Bundle(d, ps, off + fs, depth + 1);
      else Packet(d, off, off + fs);
      off += fs;
    }
  }

  // LZ4 blok çözücü
  public static byte[] Lz4(byte[] src, int off, int len, int outSize) {
    var dst = new byte[outSize]; int s = off, end = off + len, d = 0;
    while (s < end) {
      int token = src[s++]; int lit = token >> 4;
      if (lit == 15) { int x; do { if (s >= end) return null; x = src[s++]; lit += x; } while (x == 255); }
      if (s + lit > end || d + lit > outSize) return null;
      Buffer.BlockCopy(src, s, dst, d, lit); s += lit; d += lit;
      if (s >= end) break;
      if (s + 2 > end) return null;
      int moff = src[s] | (src[s + 1] << 8); s += 2;
      if (moff == 0 || moff > d) return null;
      int ml = token & 15;
      if (ml == 15) { int x; do { if (s >= end) return null; x = src[s++]; ml += x; } while (x == 255); }
      ml += 4;
      if (d + ml > outSize) return null;
      int m = d - moff;
      for (int i = 0; i < ml; i++) dst[d++] = dst[m++];
    }
    if (d == outSize) return dst;
    var t = new byte[d]; Buffer.BlockCopy(dst, 0, t, 0, d); return t;
  }

  // ------------------------------------------------------------------ Paketler
  // [start, end): uzunluk varint'i dahil tek bir paket.
  public static bool Analyze;                                   // tekrar oynatmada işlem kodu sayımı
  public static readonly Dictionary<int, int> OpCounts = new Dictionary<int, int>();
  public static string OpStats(int top) {
    var l = new List<KeyValuePair<int, int>>(OpCounts); l.Sort((a, c) => c.Value.CompareTo(a.Value));
    var sb = new StringBuilder();
    for (int i = 0; i < l.Count && i < top; i++) sb.Append(((l[i].Key >> 8) & 0xFF).ToString("X2")).Append(' ').Append((l[i].Key & 0xFF).ToString("X2")).Append('=').Append(l[i].Value).Append("  ");
    return sb.ToString();
  }
  public static void Packet(byte[] b, int start, int end) {
    var li = ReadVarint(b, start, end);
    if (li.Length <= 0) return;
    int op = start + li.Length;
    if (Analyze && op + 1 < end) { int k = (b[op] << 8) | b[op + 1]; int c; OpCounts.TryGetValue(k, out c); OpCounts[k] = c + 1; }
    if (op + 1 < end) {
      byte o0 = b[op], o1 = b[op + 1];
      if (o0 == 0x04 && o1 == 0x38) Damage(b, op + 2, end);
      else if (o0 == 0x05 && o1 == 0x38) Dot(b, op + 2, end);
      else if (o0 == 0x06 && o1 == 0x38) PartyScope(b, op + 2, end);
      else if ((o0 == 0x0B || o0 == 0x0C) && o1 == 0x61) Energy(b, op + 2, end, o0 == 0x0B);
      else if (o0 == 0x42 && o1 == 0x36) Death(b, op + 2, end, o0);   // (eski 41 36 artık doğuş: kabul edilmez)
      else if (o0 == 0x1B && o1 == 0x92) HpUpdate(b, op + 2, end);
    }
    ScanSpawns(b, start, end);
    ScanIdentity(b, start, end);
    ScanEntityHp(b, start, end);
  }

  // ---- Odyle enerjisi: kimlik 60000001; ilk değer doğal (basic), ikinci ek (charged) ----
  const uint OdyleId = 60000001;
  public static int EnergyNatural = -1, EnergyBonus = -1; public static long EnergyAt;

  // Bir içerik kaydı: <tür> <id u32> <değerler>. Dönüş: sonraki kaydın yeri, -1: kayıt değil.
  static int ContentEntry(byte[] b, int at, int end, out uint id, out int v0, out int v1, out bool isCount) {
    id = 0; v0 = 0; v1 = 0; isCount = false;
    if (at + 5 > end) return -1;
    int kind = b[at]; id = BitConverter.ToUInt32(b, at + 1);
    if (id == 0 || id > 99999999) return -1;
    int o = at + 5;
    switch (kind) {
      case 0x00: isCount = true; return o;
      case 0x01: return o + 8 <= end ? o + 8 : -1;
      case 0x03: return o + 16 <= end ? o + 16 : -1;
      case 0x04: if (!TryVarint(b, ref o, end, out v0) || v0 > 1000000) return -1; isCount = true; return o;
      case 0x08: if (!TryVarint(b, ref o, end, out v1) || v1 > 1000000) return -1; isCount = true; return o;
      case 0x0C:
        if (!TryVarint(b, ref o, end, out v0) || v0 > 1000000) return -1;
        if (!TryVarint(b, ref o, end, out v1) || v1 > 1000000) return -1;
        isCount = true; return o;
    }
    return -1;
  }
  static void Energy(byte[] b, int body, int end, bool wholeList) {
    int nat = -1, bon = -1;
    if (wholeList) {
      // <sayı varint> <kayıtlar>, kayıtlar kaydın sonuna kadar; başta başka alanlar olabilir → başlangıç aranır
      for (int st = body; st < end && nat < 0; st++) {
        int o = st, count;
        if (!TryVarint(b, ref o, end, out count) || count == 0 || count > 1000) continue;
        int fn = -1, fb = -1; bool good = true;
        for (int i = 0; i < count; i++) {
          uint id; int v0, v1; bool isc;
          int nx = ContentEntry(b, o, end, out id, out v0, out v1, out isc);
          if (nx < 0) { good = false; break; }
          if (isc && id == OdyleId) { fn = v0; fb = v1; }
          o = nx;
        }
        if (good && o == end && fn >= 0) { nat = fn; bon = fb; }
      }
      if (nat < 0) {                                    // liste bütün okunamadı: kaydı kimliğinden bul
        for (int i = body; i + 5 <= end && nat < 0; i++) {
          if ((b[i] == 0x04 || b[i] == 0x08 || b[i] == 0x0C) && BitConverter.ToUInt32(b, i + 1) == OdyleId) {
            uint id; int v0, v1; bool isc;
            if (ContentEntry(b, i, end, out id, out v0, out v1, out isc) > 0 && isc) { nat = v0; bon = v1; }
          }
        }
      }
    } else {
      // <sayı u8> <kayıtlar> <kuyruk ≤ 5 bayt>
      if (body >= end) return;
      int count = Math.Max(1, (int)b[body]); int o = body + 1;
      int fn = -1, fb = -1;
      for (int i = 0; i < count; i++) {
        uint id; int v0, v1; bool isc;
        int nx = ContentEntry(b, o, end, out id, out v0, out v1, out isc);
        if (nx < 0) return;
        if (isc && id == OdyleId) { fn = v0; fb = v1; }
        o = nx;
      }
      if (end - o > 5) return;
      nat = fn; bon = fb;
    }
    if (nat < 0 || nat > 100000 || bon > 100000) return;
    if (bon < 0) bon = 0;
    bool changed = nat != EnergyNatural || bon != EnergyBonus;
    EnergyNatural = nat; EnergyBonus = bon; EnergyAt = NowMs();
    if (changed) Events.Enqueue("energy|" + nat + "|" + bon);
  }

  // ---- Varlıklar: isimler, NPC kodları, HP ----
  public static int SelfId; public static string SelfName = "";
  static readonly Dictionary<int, string> names = new Dictionary<int, string>();
  static readonly Dictionary<int, int> mobCode = new Dictionary<int, int>();
  static readonly Dictionary<int, long> hpCur = new Dictionary<int, long>(), hpMax = new Dictionary<int, long>();

  // Oyuncu adı: 1-12 harf/rakam, en az bir harf
  static string ExactName(byte[] b, int at, int len) {
    string s;
    try { s = new UTF8Encoding(false, true).GetString(b, at, len); } catch { return null; }
    var si = new StringInfo(s);
    if (si.LengthInTextElements < 1 || si.LengthInTextElements > 12) return null;
    bool letter = false;
    foreach (char ch in s) { if (!char.IsLetterOrDigit(ch)) return null; if (char.IsLetter(ch)) letter = true; }
    return letter ? s : null;
  }

  // 33 36 (kendi karakterin), 44/45 36 (diğer oyuncular): <op> <id varint> <mask1 u32> <mask2 u8> [mask2&1 → <len u8><utf8 ad>]
  static void ScanIdentity(byte[] b, int start, int end) {
    for (int i = start; i + 8 < end; i++) {
      if (b[i + 1] != 0x36) continue;
      bool self = b[i] == 0x33;
      if (!self && b[i] != 0x44 && b[i] != 0x45) continue;
      var id = ReadVarint(b, i + 2, end);
      if (id.Length <= 0 || id.Value < 1 || id.Value > 9999999) continue;
      int m2 = i + 2 + id.Length + 4;
      if (m2 + 1 >= end || (b[m2] & 1) == 0) continue;
      int nl = b[m2 + 1];
      if (nl < 1 || nl > 48 || m2 + 2 + nl > end) continue;
      string name = ExactName(b, m2 + 2, nl);
      if (name == null) continue;
      bool isNew;
      lock (Lock) { string old; isNew = !names.TryGetValue(id.Value, out old) || old != name; names[id.Value] = name; }
      if (self && (SelfId != id.Value || SelfName != name)) { SelfId = id.Value; SelfName = name; Events.Enqueue("self|" + id.Value + "|" + name); }
      i = m2 + 1 + nl;
    }
  }

  // 40/41 36: NPC/çağrı doğuşu. NPC kodu: 00 (40|00) 02 çapasından önceki 3 bayt (kimlikten sonraki 60 bayt içinde).
  static void ScanSpawns(byte[] b, int start, int end) {
    for (int i = start; i + 5 < end; ) {
      if (b[i + 1] == 0x36 && (b[i] == 0x40 || b[i] == 0x41)) {
        if (i > start && b[i - 1] == 0x00) { i += 2; continue; }
        var id = ReadVarint(b, i + 2, end);
        if (id.Length > 0 && id.Value >= 100 && id.Value <= 9999999) {
          int realId = id.Value > 1000000 ? ((id.Value & 0x3FFF) | 0x4000) : id.Value;
          int from = i + 2 + id.Length, max = Math.Min(end - 2, from + 60);
          for (int s = from; s < max; s++) {
            if (b[s] == 0x00 && (b[s + 1] == 0x40 || b[s + 1] == 0x00) && b[s + 2] == 0x02) {
              if (s >= from + 3) {
                int code = b[s - 3] | (b[s - 2] << 8) | (b[s - 1] << 16);
                int old; bool known;
                lock (Lock) { known = mobCode.TryGetValue(realId, out old) && old == code; mobCode[realId] = code; hpCur.Remove(realId); }
                if (!known && BossIds.ContainsKey(code)) Events.Enqueue("bossSpawn|" + code + "|" + BossIds[code] + "|" + realId);
              }
              break;
            }
          }
        }
        i += 2 + Math.Max(0, id.Length);
      } else i++;
    }
  }

  // 42 36 <id> <0> <bayrak>: 3 = savaşta öldü
  static readonly Dictionary<int, long> lastBossKill = new Dictionary<int, long>();
  static void Death(byte[] b, int at, int end, byte op) {
    int id, skip, flag;
    if (!TryVarint(b, ref at, end, out id) || !TryVarint(b, ref at, end, out skip) || !TryVarint(b, ref at, end, out flag)) return;
    if (flag != 3) return;
    int code;
    lock (Lock) {
      // Savaşın büyük hedefi (boss) öldü → savaş biter, geçmişe geçer (her boss dövüşü ayrı görünsün)
      if (fight != null && fight.BossTarget == id) ResetFight();
      if (!mobCode.TryGetValue(id, out code)) return;
      hpCur[id] = 0;
    }
    string boss;
    if (!BossIds.TryGetValue(code, out boss)) return;
    long now = NowMs(), last;
    lock (Lock) { if (lastBossKill.TryGetValue(code, out last) && now - last < 120000) return; lastBossKill[code] = now; }
    Events.Enqueue("bossKill|" + code + "|" + boss + "|" + now);
  }

  // 1B 92 <id> <hp> <hpmax>
  static void HpUpdate(byte[] b, int at, int end) {
    int id, hp, max;
    if (!TryVarint(b, ref at, end, out id) || id < 100 || id > 9999999) return;
    if (!TryVarint(b, ref at, end, out hp) || !TryVarint(b, ref at, end, out max) || max <= 0 || max > 50000000) return;
    lock (Lock) { hpCur[id] = hp; long m; if (!hpMax.TryGetValue(id, out m) || m < max) hpMax[id] = max; }
  }
  // 8D <id> 02 01 00 <u32 HP> 00 00 00 00: NPC'nin güncel HP'si (savaş paketlerinin içinde)
  static void ScanEntityHp(byte[] b, int start, int end) {
    for (int i = start; i + 1 < end; i++) {
      if (b[i] != 0x8D) continue;
      var id = ReadVarint(b, i + 1, end);
      if (id.Length <= 0 || id.Value < 100 || id.Value > 9999999) continue;
      int d = i + 1 + id.Length;
      if (d + 11 > end) continue;
      if (b[d] == 2 && b[d + 1] == 1 && b[d + 2] == 0 && b[d + 7] == 0 && b[d + 8] == 0 && b[d + 9] == 0 && b[d + 10] == 0) {
        long cur = BitConverter.ToUInt32(b, d + 3);
        if (cur <= 1000000000L) lock (Lock) { hpCur[id.Value] = cur; long m; if (!hpMax.TryGetValue(id.Value, out m) || m < cur) hpMax[id.Value] = cur; }
        i = d + 10;
      }
    }
  }

  // ---- Hasar: 04 38 <hedef> <anahtar> <bayrak> <saldıran> <yetenek u32> <uid u8> <tür> <atla> <değer1> <değer2> <kuyruk> [01 00 <sonraki kayıt>…] ----
  // Değer2 vuruşun toplam hasarıdır (çoklu vuruşlar dahil); değer1 saldıranın güç çarpanı (2026-06 sonrası başta bir 0 dolgu olabilir).
  class SkillStat { public long Dmg; public int Hits, Crits; public long Max; }
  class ActorStat {
    public long Dmg, Dot, Taken, Max; public int Hits, Crits;
    public Dictionary<int, SkillStat> Skills = new Dictionary<int, SkillStat>();
  }
  class Fight {
    public long Start, Last, Total; public int No;
    public Dictionary<int, ActorStat> Actors = new Dictionary<int, ActorStat>();
    public Dictionary<int, long> Taken = new Dictionary<int, long>();   // hedef → aldığı hasar
    public int BossTarget;                                              // savaşta vurulan saha bossu (varsa)
  }
  static Fight fight;
  static readonly List<Fight> history = new List<Fight>();            // biten savaşlar, yeniden eskiye (en çok 6)
  static int fightNo;
  const long FightIdleMs = 15000;
  static readonly Dictionary<int, int> scalar = new Dictionary<int, int>();       // saldıran → güç çarpanı (çağrılanlar sahibininkini taşır)
  static readonly Dictionary<int, int> playerClass = new Dictionary<int, int>();  // oyuncu → sınıf öneki (11 Gladiator … 19)
  static readonly Dictionary<int, long> party = new Dictionary<int, long>();      // parti üyeleri (06 38) → son görülme

  static void Damage(byte[] b, int at, int end) {
    int o = at; int idx = 0;
    while (o < end) {
      if (idx > 0) { if (o + 1 < end && b[o] == 0x01 && b[o + 1] == 0x00) o += 2; else break; }   // zincirli kayıt işareti
      else if (o + 1 < end && b[o] == 0x01 && b[o + 1] == 0x00) o += 2;
      int target, sw, unused, actor;
      if (!TryVarint(b, ref o, end, out target) || target < 100) break;
      if (!TryVarint(b, ref o, end, out sw)) break;
      int and = sw & 0x0F;
      bool noValue = and == 0 || and == 2;
      if ((and < 4 || and > 7) && !noValue) break;
      if (!TryVarint(b, ref o, end, out unused)) break;
      if (!TryVarint(b, ref o, end, out actor) || actor < 100) break;
      if (o + 4 > end) break;
      long skill = BitConverter.ToUInt32(b, o); o += 4;
      if (skill >= 3000000 && skill <= 3099999) skill = skill * 10 + 1;
      if (skill < 1 || skill > 299999999) break;
      bool npcSkill = skill >= 1000000 && skill <= 9999999;     // canavarın vuruşu
      if (o < end) o++;                                         // uid
      int type; if (!TryVarint(b, ref o, end, out type)) break;
      idx++;
      if (noValue) break;                                       // ıska / direnç: kuyruğu bilinmiyor, kaydı burada bitir
      int tempV = and == 5 ? 12 : and == 6 ? 10 : and == 7 ? 14 : 8;
      int extra = 0;
      if ((and & 0x02) != 0) { int p = o + 1, hpv; if (!TryVarint(b, ref p, end, out hpv)) break; extra = (p - o - 1) - 1; }
      o += tempV + extra;
      if (o >= end) break;
      int v1, v2;
      if (!TryVarint(b, ref o, end, out v1) || !TryVarint(b, ref o, end, out v2)) break;
      if (v1 == 0) { int v3, save = o; if (TryVarint(b, ref o, end, out v3)) { v1 = v2; v2 = v3; } else o = save; }
      if (v2 < 0 || v2 > 99999999) break;
      o = SkipTail(b, o, end, and, sw, v2);
      if (o + 1 < end && b[o] == 0x03 && b[o + 1] == 0x00) { o += 2; int heal; TryVarint(b, ref o, end, out heal); }   // can çalma eki
      if (actor == target) continue;                             // kendine (iyileştirme vb.)
      if (npcSkill) { AddTaken(actor, target, v2); continue; }
      if (v1 >= 1000 && v1 <= 200000) lock (Lock) { scalar[actor] = v1; }
      int cls = (int)(skill / 1000000);
      if (cls >= 11 && cls <= 19) lock (Lock) { playerClass[actor] = cls; }
      AddDamage(actor, target, v2, (int)skill, type == 3, false);
    }
  }
  // Değerlerden sonraki kuyruk: çoklu vuruş sayısı/değerleri, kalkan emilimi. Sonraki kaydın başına götürür.
  static int SkipTail(byte[] b, int o, int end, int and, int sw, int value) {
    if (and == 4 || and == 6) {                                 // katı düzen
      int p = o; bool ok = true; int v;
      if (and == 4) { ok = TryVarint(b, ref p, end, out v) && v >= 1 && v <= 25; }
      if (ok && (sw & 0x20) != 0) {
        int cnt; ok = TryVarint(b, ref p, end, out cnt) && cnt >= 1 && cnt <= 25;
        long sum = 0;
        for (int i = 0; ok && i < cnt; i++) { ok = TryVarint(b, ref p, end, out v); sum += v; }
        if (ok && sum >= value) ok = false;
      }
      if (ok && (sw & 0x40) != 0) { int ab; ok = TryVarint(b, ref p, end, out ab) && ab >= 1 && ab <= 8; if (ok) { p += 4 * ab; ok = p <= end; } }
      if (ok && (p >= end || (p + 1 < end && b[p + 1] == 0x00 && b[p] >= 1 && b[p] <= 7) || (p + 1 < end && b[p] == 0x04 && b[p + 1] == 0x38))) return p;
    }
    // esnek düzen: (anahtar & 0x30 == 0x30 ise bir alan) + vuruş sayısı + o kadar değer
    if ((sw & 0x30) == 0x30 && o < end) { int x; TryVarint(b, ref o, end, out x); }
    bool marker = o + 1 < end && b[o + 1] == 0x00 && b[o] >= 1 && b[o] <= 7;
    if (!marker && o < end) {
      int save = o, n;
      if (TryVarint(b, ref o, end, out n)) {
        if (n < 0 || n > 25) {
          bool marker2 = o + 1 < end && b[o + 1] == 0x00 && b[o] >= 1 && b[o] <= 7;
          if (marker2 || !TryVarint(b, ref o, end, out n) || n < 0 || n > 25) { o = save; n = 0; }
        }
        long cap = Math.Max(value, 500000);
        for (int i = 0; i < n && o < end; i++) {
          bool mk = o + 1 < end && b[o + 1] == 0x00 && b[o] >= 1 && b[o] <= 7;
          bool nextRec = o + 1 < end && b[o] == 0x04 && b[o + 1] == 0x38;
          if (mk || nextRec) break;
          int s2 = o, hv;
          if (!TryVarint(b, ref o, end, out hv) || hv > cap || hv < 50) { o = s2; break; }
        }
      }
    }
    return o;
  }

  // 05 38 <hedef> <etki u8> <saldıran> <?> <yetenek u32 (/100)> <miktar>: DoT tikleri (yalnızca bilinen DoT yetenekleri)
  static readonly List<int[]> dotRanges = new List<int[]>();
  // DoT yetenek kimlikleri (topluluk verisi: A2Tools dot_skill_ids.json), aralık olarak
  static readonly string DotData = string.Concat(
    "20-29,50-59,90-109,300-309,950-969,1000-1009,9171-9173,9186,9239-9240,9308,9350,9569-9572,",
    "9588-9591,9747-9748,9809,9887,9900,9933,9935,9940-9942,20000-20009,100500-100509,100530-100539,100900-100909,",
    "100920-100929,120900-120929,131600-131609,137300-137309,140500-140539,140600-140609,150200-150209,150600-150629,152000-152009,153900-153909,157100-157109,161400-161439,",
    "161500-161509,162200-162209,167800-167809,170700-170739,170800-170839,173000-173009,174000-174009,180460-180469,1001280-1001289,1200010-1200029,1200040-1200059,1200500,",
    "1214480,1215600,1215680,1215700-1215709,1215836,1215990,1216330-1216339,1216355,1216980,1217330,1217670,1217910,",
    "1218330,1218705,1218900,1218970,1219590,1220040,1220290,1220440-1220449,1220480,1221570,1221610,1221690,",
    "1222320,1222370,1222490-1222499,1222640,1223050,1223240,1224180,1224220,1224320,1224330,1224340,1224590,",
    "1224900,1225080,1225180,1225660,1225730-1225739,1225810-1225819,1225890,1225990,1226170,1226212,1226220,1226560,",
    "1226760,1226780,1226820,1226900,1227310,1227500,1227700,1227930,1228000-1228009,1228680,1230125,1230130,",
    "1230230,1230250,1230700,1230720,1230741,1231380,1231400,1231560,1231910,1231940,1232020,1232410,",
    "1232630,1232830,1233060,1233120,1233190,1233210,1233310,1234120,1235390,1236130,1236640,1236650,",
    "1236695,1236755,1237080,1237200,1237340,1237430,1237470,1237490,1237570,1237572,1237580,1237670,",
    "1237690,1237800,1237950,1238147,1238350,1238375,1238515,1238580,1239080,1239800,1239850,1239860,",
    "1239880,1239997,1240057,1240110,1240390,1240400,1240410,1240420,1240430,1240440,1240450,1240600,",
    "1240720,1241430,1241560,1241990,1242060,1242680,1243070-1243079,1500320-1500329,1500790-1500799,1500950,1501040,1501150,",
    "1501580,1501690,1502330,1502390,1502510,1502760,1502950,1503020,1503180,1503500,1504330,1504350,",
    "1504360,1504370,1504385,1504535-1504536,1504551,1504576,1504690-1504699,1504800-1504809,1600686,1600690,1600710,1600740,",
    "1600745,1600750,1600790,1600850,1600870-1600879,1601240,1601250,1601720,1601730,1601900,1601905,1601910,",
    "1601915,1601920,1601925,1601930,1601940,1601950,1602120-1602129,1602200,1602205,1602220,1602560,1602570,",
    "1604100,1604110,1604190,1604200,1604210,1604260,1604370-1604379,1604390,1604393,1604480-1604489,1604970-1604979,1605050-1605059,",
    "1605140-1605159,1605250,1605275,1605370-1605379,1605440,1605466,1605470,1605490,1605540,1605566,1605570,1605590,",
    "1605920,1606155,1606170,1606431,1606450-1606459,1606541,1606560-1606569,1606890,1607165,1607170-1607179,1607730,1607740,",
    "1607810,1607930-1607939,1608140-1608149,1608970-1608979,1609440-1609449,1800070,1800160,1801117,1801120-1801121,1801125-1801127,1801182-1801184,1801189,",
    "1801598-1801599,1801640-1801649,1801680-1801689,1801780-1801789,1801860,1801870,1802000-1802009,1802040,1802060-1802061,1802070-1802071,1802090-1802091,1802100,",
    "1802110,1802200-1802209,1802430-1802433,1802435,1802440,1802445,1802460,1802480,1802710-1802719,1802985,1803050,1803060,",
    "1803070,1803080,1803130,1803140,1803150,1803200-1803209,1803220,1803225,1803250,1803310,1803385,1803400-1803409,",
    "1803450-1803459,1803470,1803520,1803530,1803550,1803555,1803560,1803565,1803620-1803629,1803649-1803650,1803660-1803669,1803940,",
    "1803966,1803970,1803990,1804220,1804340,1804344,1804510-1804519,1804550-1804559,1804630-1804639,1804700-1804709,1804795,1804970,",
    "1805125-1805126,1805370-1805379,1806080-1806089,1806490-1806499,1806740-1806749,1807200-1807209,1808500-1808509,1808800-1808809,1809970-1809979,1810040-1810049,1810110-1810119,1900000-1900009,",
    "1900420-1900429,1900700-1900709,1910030,1910100-1910119,1910251,1910256,1910290-1910299,1910301,1910410-1910419,1980040-1980049,1980060,1980070-1980079,",
    "1980165,1980280,1980470,1999110-1999119,1999210-1999219,1999260-1999269,3000010-3000019,3000110-3000119,3000210-3000219,3001010-3001019,3001110-3001119,3001210-3001219,",
    "4900550,4900590-4900599,11410000-11410059,12090020-12090029,12090120-12090123,12090230-12090233,12090240-12090243,12090250-12090253,12091230-12091233,12091240-12091243,12091250-12091253,12092340-12092343,",
    "12092350-12092353,12092450-12092453,13160000-13160009,13370050-13370059,13730000-13730009,14050000-14050010,14050020-14050030,14050040,14050050,14050120,14050130,14050140,",
    "14050150,14050230,14050240,14050250,14050340,14050350,14050450,14051230,14051240,14051250,14051340,14051350,",
    "14051450,14052340,14052350,14052450,14053450,14060000-14060010,14060020-14060030,14060040-14060049,14080040,14080140,14080240,14080340,",
    "14080450,14081240,14081340,14081450,14082340,14082450,14083450,14350030-14350049,14720000-14720009,15020000-15020009,15060020-15060029,15200000-15200019,",
    "15200022,15200032,15200040-15200059,15390000-15390019,15390022,15390032,15390040-15390059,15710000-15710009,16001100-16001112,16090000,16140000-16140010,16140020,",
    "16140030,16140040,16140050,16140120,16140130,16140140,16140150,16140230,16140240,16140250,16140340,16140350,",
    "16140450,16141230,16141240,16141250,16141340,16141350,16141450,16142340,16142350,16142450,16143450,16150000-16150010,",
    "16150020,16150030,16150040,16220000-16220010,16220020,16220030,16220040,16740000-16740009,16780001,16800000-16800009,17070000-17070059,17070120-17070159,",
    "17070230-17070259,17070340-17070359,17070450-17070459,17071230-17071259,17071340-17071359,17071450-17071459,17072340-17072359,17072450-17072459,17073450-17073459,17080000-17080059,17080120-17080159,17080230-17080259,",
    "17080340-17080359,17080450-17080459,17081230-17081259,17081340-17081359,17081450-17081459,17082340-17082359,17082450-17082459,17083450-17083459,17150005-17150006,17300000-17300059,17400000-17400020,17400030,",
    "17400040-17400049,21000000-21000009"
  );
  static A2Net() { SetDotRanges(DotData); }
  public static void SetDotRanges(string text) {        // "a-b,c,d-e" biçimi
    dotRanges.Clear();
    foreach (var part in text.Split(',')) {
      var t = part.Trim(); if (t.Length == 0) continue;
      int dash = t.IndexOf('-');
      int a = int.Parse(dash < 0 ? t : t.Substring(0, dash)), z = dash < 0 ? a : int.Parse(t.Substring(dash + 1));
      dotRanges.Add(new[] { a, z });
    }
  }
  static bool IsDot(int skill) {
    int lo = 0, hi = dotRanges.Count - 1;
    while (lo <= hi) { int m = (lo + hi) / 2; var r = dotRanges[m]; if (skill < r[0]) hi = m - 1; else if (skill > r[1]) lo = m + 1; else return true; }
    return false;
  }
  static void Dot(byte[] b, int at, int end) {
    int o = at, target, actor, unk, amount;
    if (!TryVarint(b, ref o, end, out target) || o >= end) return;
    int et = b[o++];
    if (et != 0x02 && et != 0x0A && et != 0x06 && et != 0x0E) return;
    if (!TryVarint(b, ref o, end, out actor) || actor == target || actor < 100) return;
    if (!TryVarint(b, ref o, end, out unk) || o + 4 > end) return;
    int skill = (int)(BitConverter.ToUInt32(b, o) / 100); o += 4;
    if (!TryVarint(b, ref o, end, out amount) || amount <= 0 || amount > 99999999) return;
    if (!IsDot(skill)) return;
    AddDamage(actor, target, amount, skill, false, true);
  }

  // 06 38 <kimlik>: sunucunun yalnızca sana ve partine gönderdiği kayıt → parti üyesi
  static void PartyScope(byte[] b, int at, int end) {
    var id = ReadVarint(b, at, end);
    if (id.Length > 0 && id.Value >= 100) lock (Lock) { party[id.Value] = NowMs(); }
  }

  static Fight CurrentFight(long now) {
    if (fight == null || now - fight.Last > FightIdleMs) {
      if (fight != null && fight.Total > 0) { history.Insert(0, fight); if (history.Count > 6) history.RemoveAt(6); }
      fight = new Fight(); fight.Start = now; fight.No = ++fightNo;
    }
    return fight;
  }
  static void AddDamage(int actor, int target, long dmg, int skill, bool crit, bool dot) {
    if (dmg <= 0) return;
    long now = NowMs();
    lock (Lock) {
      if (mobCode.ContainsKey(actor) && !names.ContainsKey(actor) && !scalar.ContainsKey(actor)) return;   // NPC'nin NPC'ye vuruşu
      var f = CurrentFight(now);
      f.Last = now; f.Total += dmg;
      ActorStat a; if (!f.Actors.TryGetValue(actor, out a)) { a = new ActorStat(); f.Actors[actor] = a; }
      a.Dmg += dmg; if (dot) a.Dot += dmg; else { a.Hits++; if (crit) a.Crits++; if (dmg > a.Max) a.Max = dmg; }
      int fam = skill >= 10000000 ? skill - skill % 10000 : skill;   // yetenek ailesi (12090243 → 12090000)
      SkillStat s; if (!a.Skills.TryGetValue(fam, out s)) { s = new SkillStat(); a.Skills[fam] = s; }
      s.Dmg += dmg; s.Hits++; if (crit) s.Crits++; if (dmg > s.Max) s.Max = dmg;
      long v; f.Taken.TryGetValue(target, out v); f.Taken[target] = v + dmg;
      // Büyük hedef: saha bossu ya da canı 1 milyonun üstünde olan (zindan bossları vb.)
      if (f.BossTarget == 0) {
        int code; long hm;
        if ((mobCode.TryGetValue(target, out code) && BossNames.ContainsKey(code)) || (hpMax.TryGetValue(target, out hm) && hm >= 1000000)) f.BossTarget = target;
      }
    }
  }
  static void AddTaken(int mob, int player, long dmg) {
    long now = NowMs();
    lock (Lock) {
      if (!names.ContainsKey(player) || fight == null || now - fight.Last > FightIdleMs) return;
      ActorStat a; if (!fight.Actors.TryGetValue(player, out a)) { a = new ActorStat(); fight.Actors[player] = a; }
      a.Taken += dmg;
    }
  }
  public static void ResetFight() { lock (Lock) { if (fight != null && fight.Total > 0) { history.Insert(0, fight); if (history.Count > 6) history.RemoveAt(6); } fight = null; } }

  // ------------------------------------------------------------------ Saha bossları: NPC kodu → sitedeki boss kimliği
  public static readonly Dictionary<int, string> BossIds = new Dictionary<int, string>();
  public static readonly Dictionary<int, string> BossNames = new Dictionary<int, string>();
  public static void AddBoss(int code, string id, string name) { BossIds[code] = id; BossNames[code] = name; }

  // ------------------------------------------------------------------ Durum (JSON) — /api/net
  static string J(string s) {
    if (s == null) return "null";
    var sb = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }
  static string FightJson(Fight f, long now) {
    if (f == null || f.Total <= 0) return "null";
    var sb = new StringBuilder();
    long dur = Math.Max(1000, f.Last - f.Start);
    // Hedef: savaşta vurulan saha bossu, yoksa en çok hasar alan
    int tgt = f.BossTarget; long best = -1;
    if (tgt == 0) foreach (var kv in f.Taken) if (kv.Value > best) { best = kv.Value; tgt = kv.Key; }
    int code; mobCode.TryGetValue(tgt, out code);
    string bn = null; if (code != 0) BossNames.TryGetValue(code, out bn);
    long hc, hm; bool hasHc = hpCur.TryGetValue(tgt, out hc); hpMax.TryGetValue(tgt, out hm);
    long tTaken; f.Taken.TryGetValue(tgt, out tTaken);

    // Çağrılan yaratıklar: adı olmayan saldıranın güç çarpanı tek bir oyuncununkiyle aynıysa o oyuncuya yazılır
    var owner = new Dictionary<int, int>();
    foreach (var id in f.Actors.Keys) {
      if (names.ContainsKey(id)) continue;
      int sc; if (!scalar.TryGetValue(id, out sc)) continue;
      int match = 0, count = 0;
      foreach (var pid in f.Actors.Keys) { int ps; if (pid != id && names.ContainsKey(pid) && scalar.TryGetValue(pid, out ps) && ps == sc) { match = pid; count++; } }
      if (count == 1) owner[id] = match;
    }
    var merged = new Dictionary<int, ActorStat>();
    var pets = new Dictionary<int, int>();
    foreach (var kv in f.Actors) {
      int to; if (!owner.TryGetValue(kv.Key, out to)) to = kv.Key; else { int n; pets.TryGetValue(to, out n); pets[to] = n + 1; }
      ActorStat m; if (!merged.TryGetValue(to, out m)) { m = new ActorStat(); merged[to] = m; }
      var a = kv.Value;
      m.Dmg += a.Dmg; m.Dot += a.Dot; m.Taken += a.Taken; m.Hits += a.Hits; m.Crits += a.Crits; if (a.Max > m.Max) m.Max = a.Max;
      foreach (var s in a.Skills) {
        SkillStat t; if (!m.Skills.TryGetValue(s.Key, out t)) { t = new SkillStat(); m.Skills[s.Key] = t; }
        t.Dmg += s.Value.Dmg; t.Hits += s.Value.Hits; t.Crits += s.Value.Crits; if (s.Value.Max > t.Max) t.Max = s.Value.Max;
      }
    }

    sb.Append("{\"no\":").Append(f.No).Append(",\"start\":").Append(f.Start).Append(",\"last\":").Append(f.Last).Append(",\"dur\":").Append(dur)
      .Append(",\"total\":").Append(f.Total).Append(",\"active\":").Append(now - f.Last <= FightIdleMs ? "true" : "false")
      .Append(",\"target\":{\"id\":").Append(tgt).Append(",\"code\":").Append(code).Append(",\"boss\":").Append(J(bn))
      .Append(",\"taken\":").Append(tTaken)
      .Append(",\"hp\":").Append(hasHc ? hc.ToString() : "null").Append(",\"hpMax\":").Append(hm > 0 ? hm.ToString() : "null").Append("}");
    var rows = new List<KeyValuePair<int, ActorStat>>(merged);
    rows.Sort((x, y) => y.Value.Dmg.CompareTo(x.Value.Dmg));
    sb.Append(",\"rows\":[");
    int shown = 0;
    foreach (var r in rows) {
      if (r.Value.Dmg <= 0 || shown >= 40) continue;
      string nm; names.TryGetValue(r.Key, out nm);
      int cls; playerClass.TryGetValue(r.Key, out cls);
      int np; pets.TryGetValue(r.Key, out np);
      if (shown++ > 0) sb.Append(',');
      var a = r.Value;
      sb.Append("{\"id\":").Append(r.Key).Append(",\"name\":").Append(J(nm)).Append(",\"cls\":").Append(cls)
        .Append(",\"self\":").Append(r.Key == SelfId ? "true" : "false").Append(",\"party\":").Append(r.Key == SelfId || party.ContainsKey(r.Key) ? "true" : "false")
        .Append(",\"dmg\":").Append(a.Dmg).Append(",\"dps\":").Append(a.Dmg * 1000 / dur).Append(",\"dot\":").Append(a.Dot)
        .Append(",\"hits\":").Append(a.Hits).Append(",\"crits\":").Append(a.Crits).Append(",\"max\":").Append(a.Max)
        .Append(",\"taken\":").Append(a.Taken).Append(",\"pets\":").Append(np).Append(",\"skills\":[");
      var sk = new List<KeyValuePair<int, SkillStat>>(a.Skills);
      sk.Sort((x, y) => y.Value.Dmg.CompareTo(x.Value.Dmg));
      for (int i = 0; i < sk.Count && i < 16; i++) {
        if (i > 0) sb.Append(',');
        var s = sk[i].Value;
        sb.Append("{\"code\":").Append(sk[i].Key).Append(",\"dmg\":").Append(s.Dmg).Append(",\"hits\":").Append(s.Hits)
          .Append(",\"crits\":").Append(s.Crits).Append(",\"max\":").Append(s.Max).Append('}');
      }
      sb.Append("]}");
    }
    sb.Append("]}");
    return sb.ToString();
  }
  public static string StateJson() {
    long now = NowMs();
    lock (Lock) {
      var sb = new StringBuilder("{");
      sb.Append("\"npcap\":").Append(NpcapOk ? "true" : "false")
        .Append(",\"status\":").Append(J(Status)).Append(",\"error\":").Append(J(Error))
        .Append(",\"pid\":").Append(GamePid).Append(",\"conns\":").Append(J(ConnText))
        .Append(",\"packets\":").Append(Packets).Append(",\"bytes\":").Append(Bytes).Append(",\"frames\":").Append(Frames)
        .Append(",\"bundles\":").Append(Bundles).Append(",\"resyncs\":").Append(Resyncs).Append(",\"gaps\":").Append(Gaps)
        .Append(",\"lastDataAgo\":").Append(LastDataMs > 0 ? (now - LastDataMs).ToString() : "null")
        .Append(",\"recording\":").Append(RecordPath != null ? "true" : "false")
        .Append(",\"self\":{\"id\":").Append(SelfId).Append(",\"name\":").Append(J(SelfName)).Append("}")
        .Append(",\"known\":{\"players\":").Append(names.Count).Append(",\"npcs\":").Append(mobCode.Count).Append("}")
        .Append(",\"energy\":").Append(EnergyNatural >= 0 ? "{\"natural\":" + EnergyNatural + ",\"bonus\":" + EnergyBonus + ",\"at\":" + EnergyAt + "}" : "null")
        .Append(",\"party\":").Append(party.Count)
        .Append(",\"fight\":").Append(FightJson(fight, now))
        .Append(",\"history\":[");
      bool first = true;
      foreach (var h in history) { var hj = FightJson(h, now); if (hj == "null") continue; if (!first) sb.Append(','); sb.Append(hj); first = false; }
      sb.Append("]")
        .Append('}');
      return sb.ToString();
    }
  }

  // ------------------------------------------------------------------ Test / tekrar oynatma
  // Kaydedilmiş akışı (Record biçimi) ayrıştırıcıdan geçir.
  public static void Replay(string path) {
    var all = File.ReadAllBytes(path);
    var ss = new Dictionary<int, Stream>();
    int o = 0;
    while (o + 16 <= all.Length) {
      int len = BitConverter.ToInt32(all, o + 8), sid = BitConverter.ToInt32(all, o + 12);
      var d = new byte[len]; Buffer.BlockCopy(all, o + 16, d, 0, len); o += 16 + len;
      Stream s; if (!ss.TryGetValue(sid, out s)) { s = new Stream(); s.Init = true; s.Resync = true; ss[sid] = s; }
      lock (Lock) { var nb = new byte[s.Buf.Length + d.Length]; Buffer.BlockCopy(s.Buf, 0, nb, 0, s.Buf.Length); Buffer.BlockCopy(d, 0, nb, s.Buf.Length, d.Length); s.Buf = nb; Consume(s); }
    }
  }
  // Ham bir akış parçasını doğrudan ver (birim testleri için)
  public static void Feed(byte[] chunk) {
    lock (Lock) {
      Stream s; if (!streams.TryGetValue("test", out s)) { s = new Stream(); s.Init = true; s.Resync = false; streams["test"] = s; }
      var nb = new byte[s.Buf.Length + chunk.Length]; Buffer.BlockCopy(s.Buf, 0, nb, 0, s.Buf.Length); Buffer.BlockCopy(chunk, 0, nb, s.Buf.Length, chunk.Length); s.Buf = nb;
      Consume(s);
    }
  }
  // TCP birleştirme testi: bir parçayı sıra numarasıyla ver; Stale: bekleyen boşlukları hemen atla
  public static void TestSegment(uint seq, byte[] d) { lock (Lock) { Segment("seg", seq, d); } }
  public static void TestSkipGaps() { lock (Lock) { foreach (var s in streams.Values) SkipGap(s); } }
  public static void ResetAll() {
    lock (Lock) { streams.Clear(); names.Clear(); mobCode.Clear(); hpCur.Clear(); hpMax.Clear(); lastBossKill.Clear(); fight = null; history.Clear(); scalar.Clear(); playerClass.Clear(); party.Clear(); }
    SelfId = 0; SelfName = ""; EnergyNatural = -1; EnergyBonus = -1; string e; while (Events.TryDequeue(out e)) { }
    Packets = Bytes = Frames = Bundles = Resyncs = Gaps = 0;
  }
}
