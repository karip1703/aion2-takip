# AION 2 Takip — Ekran izleyici
# Odyle Energy Cube (ödül kutusu) penceresini ekrandan okur:
#   * Pencere açılınca: enerjiyi (ör. 0(+845)/840) ve zindanın garanti sayacını siteyle EŞİTLER.
#   * Pencere kapanınca: Open sayılır → enerjiden maliyet düşülür, garanti sayacı kutu sayısı kadar ilerler.
#     (Cancel'a basıldıysa bir sonraki açılışta ekrandan okunan değerlerle kendiliğinden düzelir.)
# Oyuna, oyun dosyalarına ya da ağ trafiğine dokunmaz; klavye/fare dinlemez. Sadece ekran görüntüsü alır.
#
# Kayıtlar data/inbox/ klasörüne küçük dosyalar olarak gönderilir; GitHub Actions bunları data.json'a uygular.
#
# Test modu:  powershell -ExecutionPolicy Bypass -File izleyici.ps1 -TestImage ekran.png

param([string]$TestImage)

$ErrorActionPreference = 'Stop'
$Repo = @{ owner = 'karip1703'; repo = 'aion2-takip'; branch = 'main' }
$AppDir = Join-Path $env:APPDATA 'aion2-izleyici'
New-Item -ItemType Directory -Force $AppDir | Out-Null

Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime

# Pencere gizli başlatıldığı için beklenmedik bir hata sessizce kaybolmasın: mesaj göster + günlüğe yaz.
if (-not $TestImage) {
  trap {
    $msg = "Ekran izleyici bir hatayla karşılaştı:`n`n$($_.Exception.Message)`n`nAyrıntı: $AppDirhata.log"
    try { Add-Content (Join-Path $AppDir 'hata.log') ("{0:yyyy-MM-dd HH:mm:ss}  {1}`n{2}" -f (Get-Date), $_.Exception, $_.ScriptStackTrace) -Encoding UTF8 } catch {}
    [System.Windows.Forms.MessageBox]::Show($msg, 'AION 2 Takip — Ekran izleyici', 'OK', 'Error') | Out-Null
    exit 1
  }
}

# ---------------------------------------------------------------- Görüntü yardımcıları (C#, hızlı)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;

public static class A2Img {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  // Ekran ölçeği (%125, %150…) varken gerçek piksel koordinatlarıyla çalışmak için.
  public static void MakeDpiAware() { try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { } SetProcessDPIAware(); }
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public static int ScreenW() { return GetSystemMetrics(0); }
  public static int ScreenH() { return GetSystemMetrics(1); }

  public static Bitmap Capture(int x, int y, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
    return b;
  }

  public static Bitmap Crop(Bitmap src, int x, int y, int w, int h) {
    x = Math.Max(0, x); y = Math.Max(0, y);
    w = Math.Min(w, src.Width - x); h = Math.Min(h, src.Height - y);
    return src.Clone(new Rectangle(x, y, w, h), PixelFormat.Format32bppArgb);
  }

  // Altın rengi "Open" butonu: piksellerin ne kadarı altın/sarı tonda?
  public static double GoldRatio(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height]; Marshal.Copy(d.Scan0, px, 0, px.Length); b.UnlockBits(d);
    int hit = 0, n = b.Width * b.Height;
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) {
      int i = y * d.Stride + x * 4; int bb = px[i], gg = px[i + 1], rr = px[i + 2];
      if (rr > 170 && gg > 110 && bb < 120 && rr >= gg && (rr - bb) > 90) hit++;
    }
    return n == 0 ? 0 : (double)hit / n;
  }

  // OCR için hazırla: büyüt, renge göre ayıkla (siyah yazı / beyaz zemin), kenar boşluğu, isteğe bağlı sol etiket.
  // mode: all = en parlak kanal > eşik; white = gri/beyaz yazı; cyan = turkuaz yazı
  public static Bitmap Prep(Bitmap crop, int scale, int thr, string mode, string label) {
    int w = crop.Width * scale, h = crop.Height * scale, pad = 24;
    var up = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(up)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(crop, 0, 0, w, h); }
    var d = up.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * h]; Marshal.Copy(d.Scan0, px, 0, px.Length); up.UnlockBits(d); up.Dispose();

    int ow = w + 2 * pad, oh = h + 2 * pad;
    var bin = new Bitmap(ow, oh, PixelFormat.Format32bppArgb);
    var od = bin.LockBits(new Rectangle(0, 0, ow, oh), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    var ob = new byte[od.Stride * oh];
    for (int i = 0; i < ob.Length; i++) ob[i] = 255;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int i = y * d.Stride + x * 4; int b0 = px[i], g0 = px[i + 1], r0 = px[i + 2];
      int mx = Math.Max(b0, Math.Max(g0, r0)), mn = Math.Min(b0, Math.Min(g0, r0));
      bool hit;
      if (mode == "white") hit = mn > thr && (mx - mn) < 60;
      else if (mode == "cyan") hit = b0 > thr && g0 > thr - 30 && r0 < b0 - 50;
      else hit = mx > thr;
      if (hit) { int o = (y + pad) * od.Stride + (x + pad) * 4; ob[o] = 0; ob[o + 1] = 0; ob[o + 2] = 0; }
    }
    Marshal.Copy(ob, 0, od.Scan0, ob.Length); bin.UnlockBits(od);
    if (string.IsNullOrEmpty(label)) return bin;

    // Windows OCR tek karakterlik / kısa sayıları atlayabiliyor → sola bilinen bir kelime ekle.
    var font = new Font("Arial", Math.Max(10f, oh * 0.30f), FontStyle.Bold, GraphicsUnit.Pixel);
    SizeF sz; using (var t = new Bitmap(1, 1)) using (var gt = Graphics.FromImage(t)) sz = gt.MeasureString(label + " ", font);
    int lw = (int)sz.Width + 10;
    var outb = new Bitmap(lw + ow, oh, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(outb)) {
      g.Clear(Color.White); g.TextRenderingHint = TextRenderingHint.AntiAlias;
      g.DrawString(label + " ", font, Brushes.Black, 4, (oh - sz.Height) / 2);
      g.DrawImage(bin, lw, 0);
    }
    bin.Dispose(); font.Dispose();
    return outb;
  }
}
'@
[A2Img]::MakeDpiAware()

# ---------------------------------------------------------------- Windows OCR (WinRT)
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $script:AsTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait() | Out-Null; $task.Result }
$script:Ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $script:Ocr) { throw 'Windows yazı tanıma (OCR) bu bilgisayarda kullanılamıyor.' }

function Read-Text([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $w = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
  $w.WriteBytes($ms.ToArray()); Await ($w.StoreAsync()) ([uint32]) | Out-Null; $ms.Dispose()
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($script:Ocr.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $sb.Dispose(); $ras.Dispose()
  (($res.Lines | ForEach-Object { $_.Text }) -join ' ').Trim()
}

# ---------------------------------------------------------------- Ekran bölgeleri
# UI sağa yaslı ve yükseklikle ölçekleniyor: x = sağ kenardan uzaklık (r, yükseklik oranı), y = üstten (yükseklik oranı).
# 2560x1440 ekran görüntüsüne göre ayarlandı.
$Regions = @{
  panel     = @{ r1 = 0.560; r2 = 0.020; y1 = 0.010; y2 = 0.975 }  # tek seferde yakalanan büyük alan
  open      = @{ r1 = 0.170; r2 = 0.060; y1 = 0.935; y2 = 0.965 }  # altın "Open" butonu (ucuz kontrol)
  energy    = @{ r1 = 0.522; r2 = 0.441; y1 = 0.018; y2 = 0.052 }
  dungeon   = @{ r1 = 0.360; r2 = 0.040; y1 = 0.080; y2 = 0.130 }
  cost      = @{ r1 = 0.204; r2 = 0.150; y1 = 0.728; y2 = 0.768 }
  boxes     = @{ r1 = 0.240; r2 = 0.150; y1 = 0.778; y2 = 0.815 }
  guarantee = @{ r1 = 0.150; r2 = 0.075; y1 = 0.850; y2 = 0.882 }
}
$TitleRegion = @{ x1 = 0.000; x2 = 0.300; y1 = 0.008; y2 = 0.065 }      # sol üst "Odyle Energy Cube"

function Rect-Of($g, [int]$W, [int]$H) {
  $x1 = [int]($W - $g.r1 * $H); $x2 = [int]($W - $g.r2 * $H)
  @{ x = $x1; y = [int]($g.y1 * $H); w = ($x2 - $x1); h = ([int]($g.y2 * $H) - [int]($g.y1 * $H)) }
}

# Panel görüntüsünden bir alt bölge (panel koordinatına göre)
function Sub-Crop([System.Drawing.Bitmap]$panel, $panelRect, $g, [int]$W, [int]$H) {
  $r = Rect-Of $g $W $H
  [A2Img]::Crop($panel, ($r.x - $panelRect.x), ($r.y - $panelRect.y), $r.w, $r.h)
}

function Norm-Digits([string]$s) { ($s -replace '[Oo]', '0' -replace '[Il|]', '1' -replace '\s', '') }

# Bir bölgeyi birkaç ayarla okuyup ilk eşleşeni döndür
function Read-Field([System.Drawing.Bitmap]$crop, [string]$mode, [string]$label, [int[]]$scales, [string]$pattern) {
  foreach ($sc in $scales) {
    $p = [A2Img]::Prep($crop, $sc, 140, $mode, $label)
    $t = Read-Text $p; $p.Dispose()
    if ($label) { $t = ($t -replace "^.*?$label", '').Trim() }
    $m = [regex]::Match((Norm-Digits $t), $pattern)
    if ($m.Success) { return $m }
  }
  return $null
}

# Bilinen zindan adları: sitedeki tüm karakterlerin sayaçlarından (girişte doldurulur) + sık görülenler.
$script:KnownDungeons = New-Object System.Collections.Generic.List[string]
foreach ($d in @('Fire Temple')) { $script:KnownDungeons.Add($d) }
function Match-Dungeon([string]$ocr) {
  $o = $ocr.Trim().ToLowerInvariant()
  foreach ($k in $script:KnownDungeons) { if ($k.ToLowerInvariant() -eq $o) { return $k } }
  # Kısmi okuma: okunan, bilinen bir adın başı ya da bilinen ad okunanın içinde (en az 4 harf)
  if ($o.Length -ge 4) {
    foreach ($k in $script:KnownDungeons) { $kl = $k.ToLowerInvariant(); if ($kl.StartsWith($o) -or $o.Contains($kl)) { return $k } }
  }
  return $ocr.Trim()
}

# Odyle Energy Cube penceresini oku. $full = ekranın tamamı ya da test görüntüsü.
function Read-Cube([System.Drawing.Bitmap]$full) {
  $W = $full.Width; $H = $full.Height
  $res = [ordered]@{}

  $c = Sub-Crop $full @{ x = 0; y = 0 } $Regions.dungeon $W $H
  foreach ($sc in 3, 4, 2) { $p = [A2Img]::Prep($c, $sc, 140, 'all', $null); $t = Read-Text $p; $p.Dispose(); if ($t -match '\w{3,}') { $res.dungeon = ($t -replace '\s+', ' ').Trim(); break } }
  $c.Dispose()

  $c = Sub-Crop $full @{ x = 0; y = 0 } $Regions.cost $W $H
  $m = Read-Field $c 'all' 'ENERGY' @(3, 4, 2) '^(\d{1,4})'; $c.Dispose()
  if ($m) { $res.cost = [int]$m.Groups[1].Value }

  $c = Sub-Crop $full @{ x = 0; y = 0 } $Regions.boxes $W $H
  $m = Read-Field $c 'all' 'ENERGY' @(3, 4, 2) '(\d{1,3})/(\d{1,3})'; $c.Dispose()
  if ($m) { $res.boxes = [int]$m.Groups[1].Value; $res.boxesMax = [int]$m.Groups[2].Value }

  $c = Sub-Crop $full @{ x = 0; y = 0 } $Regions.guarantee $W $H
  $m = Read-Field $c 'all' $null @(3, 2, 4) '(\d{1,3})/(\d{1,3})'; $c.Dispose()
  if ($m) { $res.seen = [int]$m.Groups[1].Value; $res.max = [int]$m.Groups[2].Value }

  # Enerji: beyaz kısım "0 … /840", turkuaz kısım "(+845)"
  $c = Sub-Crop $full @{ x = 0; y = 0 } $Regions.energy $W $H
  $mw = Read-Field $c 'white' 'ENERGY' @(3, 2, 4) '^(\d{1,4}).*?/(\d{2,4})'
  $mc = Read-Field $c 'cyan' 'ENERGY' @(3, 2, 4) '\+?(\d{1,5})'
  $c.Dispose()
  if ($mw) { $res.natural = [int]$mw.Groups[1].Value; $res.energyMax = [int]$mw.Groups[2].Value; $res.bonus = if ($mc) { [int]$mc.Groups[1].Value } else { 0 } }

  # Doğrulama
  $res.valid = [bool]($res.dungeon -and $res.cost -gt 0 -and $res.cost -le 2000 -and $res.boxes -ge 1 -and $res.boxes -le $res.boxesMax -and
    $res.max -ge 1 -and $res.max -le 500 -and $res.seen -ge 0 -and $res.seen -le $res.max)
  return $res
}

function Title-Visible([System.Drawing.Bitmap]$full) {
  $W = $full.Width; $H = $full.Height
  $c = [A2Img]::Crop($full, [int]($TitleRegion.x1 * $H), [int]($TitleRegion.y1 * $H), [int](($TitleRegion.x2 - $TitleRegion.x1) * $H), [int](($TitleRegion.y2 - $TitleRegion.y1) * $H))
  $p = [A2Img]::Prep($c, 2, 140, 'all', $null); $t = Read-Text $p; $p.Dispose(); $c.Dispose()
  return ($t -match 'Energy\s*Cube|Odyle')
}

# ---------------------------------------------------------------- Test modu (ekran görüntüsünden oku)
if ($TestImage) {
  $img = [System.Drawing.Bitmap]::FromFile((Resolve-Path $TestImage))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $title = Title-Visible $img
  $W = $img.Width; $H = $img.Height
  $o = Rect-Of $Regions.open $W $H
  $oc = [A2Img]::Crop($img, $o.x, $o.y, $o.w, $o.h); $gold = [A2Img]::GoldRatio($oc); $oc.Dispose()
  $r = Read-Cube $img
  $img.Dispose()
  "Başlık görünüyor: $title | Open butonu altın oranı: {0:N2} | süre: {1} ms" -f $gold, $sw.ElapsedMilliseconds
  $r | ConvertTo-Json
  return
}

# ---------------------------------------------------------------- Giriş (sitedeki şifreli token'ı çöz)
# Site, token'ı PBKDF2-SHA256 (600.000 tur) + AES-256-GCM ile şifreliyor (assets/js/auth.js).
# Aynısı burada .NET (Rfc2898DeriveBytes) + Windows bcrypt.dll ile çözülür; ek kurulum gerekmez.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

public static class A2Crypto {
  public static byte[] Pbkdf2Sha256(string password, byte[] salt, int iterations) {
    using (var k = new Rfc2898DeriveBytes(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256)) return k.GetBytes(32);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct AuthInfo {
    public int cbSize; public int dwInfoVersion;
    public IntPtr pbNonce; public int cbNonce;
    public IntPtr pbAuthData; public int cbAuthData;
    public IntPtr pbTag; public int cbTag;
    public IntPtr pbMacContext; public int cbMacContext;
    public int cbAAD; public long cbData; public int dwFlags;
  }
  [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern uint BCryptOpenAlgorithmProvider(out IntPtr h, string alg, string impl, uint flags);
  [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern uint BCryptSetProperty(IntPtr h, string prop, byte[] input, int len, uint flags);
  [DllImport("bcrypt.dll")] static extern uint BCryptGenerateSymmetricKey(IntPtr hAlg, out IntPtr hKey, IntPtr obj, int objLen, byte[] secret, int secretLen, uint flags);
  [DllImport("bcrypt.dll")] static extern uint BCryptDecrypt(IntPtr hKey, byte[] input, int inLen, ref AuthInfo info, byte[] iv, int ivLen, byte[] output, int outLen, out int result, uint flags);
  [DllImport("bcrypt.dll")] static extern uint BCryptDestroyKey(IntPtr h);
  [DllImport("bcrypt.dll")] static extern uint BCryptCloseAlgorithmProvider(IntPtr h, uint f);

  // AES-256-GCM çözme. ctWithTag = WebCrypto çıktısı (şifreli metin + 16 bayt etiket). Başarısızsa null.
  public static byte[] AesGcmDecrypt(byte[] key, byte[] iv, byte[] ctWithTag, byte[] aad) {
    if (ctWithTag.Length < 16) return null;
    int n = ctWithTag.Length - 16;
    byte[] ct = new byte[n], tag = new byte[16];
    Array.Copy(ctWithTag, 0, ct, 0, n); Array.Copy(ctWithTag, n, tag, 0, 16);
    IntPtr alg = IntPtr.Zero, hKey = IntPtr.Zero;
    GCHandle hIv = GCHandle.Alloc(iv, GCHandleType.Pinned), hAad = GCHandle.Alloc(aad, GCHandleType.Pinned), hTag = GCHandle.Alloc(tag, GCHandleType.Pinned);
    try {
      if (BCryptOpenAlgorithmProvider(out alg, "AES", null, 0) != 0) return null;
      byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
      if (BCryptSetProperty(alg, "ChainingMode", mode, mode.Length, 0) != 0) return null;
      if (BCryptGenerateSymmetricKey(alg, out hKey, IntPtr.Zero, 0, key, key.Length, 0) != 0) return null;
      var info = new AuthInfo();
      info.cbSize = Marshal.SizeOf(typeof(AuthInfo)); info.dwInfoVersion = 1;
      info.pbNonce = hIv.AddrOfPinnedObject(); info.cbNonce = iv.Length;
      info.pbAuthData = hAad.AddrOfPinnedObject(); info.cbAuthData = aad.Length;
      info.pbTag = hTag.AddrOfPinnedObject(); info.cbTag = 16;
      byte[] plain = new byte[n]; int got;
      uint st = BCryptDecrypt(hKey, ct, n, ref info, null, 0, plain, n, out got, 0);
      return st == 0 ? plain : null;   // 0xC000A002 = etiket uyuşmadı (yanlış şifre)
    } finally {
      if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
      if (alg != IntPtr.Zero) BCryptCloseAlgorithmProvider(alg, 0);
      hIv.Free(); hAad.Free(); hTag.Free();
    }
  }
}
'@

function Unlock-Account($auth, [string]$user, [string]$password) {
  $u = $user.Trim().ToLowerInvariant()   # Türkçe kültürde "I".ToLower() = "ı" olur; site JS ile aynı sonuç için Invariant
  $acc = $auth.accounts | Where-Object { $_.user -eq $u } | Select-Object -First 1
  if (-not $acc) { throw 'Kullanıcı adı ya da şifre hatalı' }
  $iter = if ($auth.iterations) { [int]$auth.iterations } else { 600000 }
  $key = [A2Crypto]::Pbkdf2Sha256($password, [Convert]::FromBase64String($acc.salt), $iter)
  $plain = [A2Crypto]::AesGcmDecrypt($key, [Convert]::FromBase64String($acc.iv), [Convert]::FromBase64String($acc.ct), [Text.Encoding]::UTF8.GetBytes($u))
  if (-not $plain) { throw 'Kullanıcı adı ya da şifre hatalı' }
  $payload = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
  if (-not $payload.token) { throw 'Kullanıcı adı ya da şifre hatalı' }
  return @{ user = $u; token = $payload.token; owner = $payload.owner; repo = $payload.repo; branch = $(if ($payload.branch) { $payload.branch } else { 'main' }) }
}

if ($env:A2_UNLOCK_TEST) {   # geliştirici testi: JSON dosyasındaki auth ile çözmeyi dene
  $t = Get-Content $env:A2_UNLOCK_TEST -Raw -Encoding UTF8 | ConvertFrom-Json
  $s = Unlock-Account $t.auth $env:A2_USER $env:A2_PASS
  "OK user=$($s.user) token=$($s.token) repo=$($s.owner)/$($s.repo)"
  return
}

# Oturum: Windows'un kullanıcıya özel şifrelemesiyle (DPAPI) saklanır.
$SessionFile = Join-Path $AppDir 'oturum.dat'
$SettingsFile = Join-Path $AppDir 'ayarlar.json'
function Save-Session($s) { ConvertTo-SecureString ($s | ConvertTo-Json -Compress) -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $SessionFile }
function Load-Session {
  if (-not (Test-Path $SessionFile)) { return $null }
  try {
    $sec = Get-Content $SessionFile -Raw | ConvertTo-SecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $o = $plain | ConvertFrom-Json
    return @{ user = $o.user; token = $o.token; owner = $o.owner; repo = $o.repo; branch = $o.branch }
  } catch { return $null }
}
function Load-Settings { if (Test-Path $SettingsFile) { try { return Get-Content $SettingsFile -Raw | ConvertFrom-Json } catch {} }; return [pscustomobject]@{ charId = $null } }
function Save-Settings($o) { $o | ConvertTo-Json | Set-Content $SettingsFile -Encoding UTF8 }

# ---------------------------------------------------------------- GitHub
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ApiBase = if ($env:A2_API) { $env:A2_API } else { 'https://api.github.com' }   # test için değiştirilebilir
function GH([string]$method, [string]$path, $body, [string]$token) {
  $h = @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'aion2-izleyici' }
  if ($token) { $h.Authorization = "Bearer $token" }
  $p = @{ Method = $method; Uri = "$ApiBase$path"; Headers = $h }
  if ($body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 10 -Compress)); $p.ContentType = 'application/json; charset=utf-8' }
  Invoke-RestMethod @p
}
function Get-Data([string]$token) {
  $j = GH 'GET' "/repos/$($Repo.owner)/$($Repo.repo)/contents/data/data.json?ref=$($Repo.branch)" $null $token
  $bytes = [Convert]::FromBase64String(($j.content -replace '\s', ''))
  [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}

# Gönderilemeyen kayıtlar kuyrukta bekler ve tekrar denenir.
$script:Queue = New-Object System.Collections.ArrayList
function Send-Ops([object[]]$ops, [string]$summary) {
  $stamp = (Get-Date).ToUniversalTime()
  foreach ($op in $ops) { if (-not $op.at) { $op.at = $stamp.ToString('o') }; $op.by = $script:Session.user; $op.auto = $true }
  $name = '{0}-{1}.json' -f $stamp.ToString('yyyyMMddTHHmmssfff'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
  [void]$script:Queue.Add(@{ name = $name; ops = $ops; summary = $summary })
  Flush-Queue
}
function Flush-Queue {
  while ($script:Queue.Count -gt 0) {
    $item = $script:Queue[0]
    $json = @{ by = $script:Session.user; source = 'izleyici'; ops = $item.ops } | ConvertTo-Json -Depth 10 -Compress
    $body = @{ message = "Izleyici: $($item.summary)"; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)); branch = $script:Session.branch }
    try {
      GH 'PUT' "/repos/$($script:Session.owner)/$($script:Session.repo)/contents/data/inbox/$($item.name)" $body $script:Session.token | Out-Null
      $script:Queue.RemoveAt(0)
      Log "✔ Gönderildi: $($item.summary)"
    } catch {
      $code = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
      if ($code -eq 401) { Log '✖ GitHub token geçersiz — site sahibi Hesap kurulumu ile yenilemeli, sonra tekrar giriş yap.' }
      else { Log "… Gönderilemedi, tekrar denenecek ($($script:Queue.Count) bekliyor): $($_.Exception.Message)" }
      return
    }
  }
}

if ($env:A2_SEND_TEST) {
  function Log([string]$m) { Write-Output $m }
  $script:Session = @{ user = 'karip'; token = 'good-token'; owner = 'o'; repo = 'r'; branch = 'main' }
  Send-Ops @(@{ type = 'energySync'; charId = 'kyrakia'; natural = 0; bonus = 845; max = 840 }, @{ type = 'dungeonSet'; charId = 'kyrakia'; name = 'Fire Temple'; count = 20; max = 28 }) 'Kyrakia: Fire Temple 20/28, enerji 0(+845)'
  Send-Ops @(@{ type = 'dungeonOpen'; charId = 'kyrakia'; name = 'Fire Temple'; boxes = 2; cost = 80; max = 28; seen = 20 }) 'Kyrakia: Fire Temple 2 kutu, -80 enerji'
  "kuyrukta kalan: $($script:Queue.Count)"
  return
}

# ---------------------------------------------------------------- Arayüz
$form = New-Object Windows.Forms.Form
$form.Text = 'AION 2 Takip — Ekran izleyici'; $form.Width = 520; $form.Height = 560
$form.StartPosition = 'CenterScreen'; $form.TopMost = $false
$form.Font = New-Object Drawing.Font('Segoe UI', 9.5)
$form.BackColor = [Drawing.Color]::FromArgb(22, 27, 34); $form.ForeColor = [Drawing.Color]::FromArgb(230, 237, 243)

function New-Ctl($type, $x, $y, $w, $h, $text) { $c = New-Object $type; $c.Left = $x; $c.Top = $y; $c.Width = $w; if ($h) { $c.Height = $h }; if ($text) { $c.Text = $text }; $form.Controls.Add($c); $c }

$lblUser = New-Ctl Windows.Forms.Label 14 16 90 22 'Kullanıcı adı'
$txtUser = New-Ctl Windows.Forms.TextBox 110 13 140 24
$lblPass = New-Ctl Windows.Forms.Label 260 16 40 22 'Şifre'
$txtPass = New-Ctl Windows.Forms.TextBox 300 13 110 24; $txtPass.UseSystemPasswordChar = $true
$btnLogin = New-Ctl Windows.Forms.Button 418 11 80 28 'Giriş'
$chkRemember = New-Ctl Windows.Forms.CheckBox 110 40 300 22 'Beni bu bilgisayarda hatırla'; $chkRemember.Checked = $true

$lblChar = New-Ctl Windows.Forms.Label 14 78 90 22 'Aktif karakter'
$cmbChar = New-Ctl Windows.Forms.ComboBox 110 75 200 24; $cmbChar.DropDownStyle = 'DropDownList'
$btnPause = New-Ctl Windows.Forms.Button 318 73 85 28 'Duraklat'
$btnUndo = New-Ctl Windows.Forms.Button 408 73 90 28 'Geri al'

$lblStatus = New-Ctl Windows.Forms.Label 14 112 484 44 'Giriş yap ve aktif karakteri seç.'
$lblStatus.ForeColor = [Drawing.Color]::FromArgb(139, 150, 163)

$lstLog = New-Ctl Windows.Forms.ListBox 14 160 484 300
$lstLog.BackColor = [Drawing.Color]::FromArgb(14, 17, 22); $lstLog.ForeColor = $form.ForeColor; $lstLog.BorderStyle = 'FixedSingle'
$btnTest = New-Ctl Windows.Forms.Button 14 470 160 30 'Ekranı şimdi oku (test)'
$lblHint = New-Ctl Windows.Forms.Label 182 474 316 40 'Oyun çerçevesiz pencere modunda, ana ekranda olmalı.'
$lblHint.ForeColor = [Drawing.Color]::FromArgb(139, 150, 163)
foreach ($b in $btnLogin, $btnPause, $btnUndo, $btnTest) { $b.FlatStyle = 'Flat'; $b.BackColor = [Drawing.Color]::FromArgb(29, 36, 46) }
$cmbChar.Enabled = $false; $btnPause.Enabled = $false; $btnUndo.Enabled = $false

function Log([string]$msg) {
  $lstLog.Items.Insert(0, ('{0:HH:mm:ss}  {1}' -f (Get-Date), $msg))
  while ($lstLog.Items.Count -gt 200) { $lstLog.Items.RemoveAt($lstLog.Items.Count - 1) }
  Add-Content (Join-Path $AppDir 'kayit.log') ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg) -Encoding UTF8
}

$script:Session = $null
$script:Chars = @()
$script:Settings = Load-Settings

function After-Login {
  $data = Get-Data $script:Session.token
  $script:Chars = @($data.characters | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name } })
  foreach ($ch in $data.characters) { foreach ($d in @($ch.dungeons)) { if ($d.name -and $d.name.Length -ge 6 -and -not $script:KnownDungeons.Contains($d.name)) { $script:KnownDungeons.Add($d.name) } } }
  $cmbChar.Items.Clear(); foreach ($c in $script:Chars) { [void]$cmbChar.Items.Add($c.name) }
  $idx = [Array]::IndexOf(@($script:Chars.id), $script:Settings.charId); $cmbChar.SelectedIndex = [Math]::Max(0, $idx)
  foreach ($c in $txtUser, $txtPass, $btnLogin) { $c.Enabled = $false }
  $btnLogin.Text = 'Bağlı'
  $cmbChar.Enabled = $true; $btnPause.Enabled = $true
  Log "Giriş yapıldı: $($script:Session.user). İzleme başladı."
  $script:Paused = $false
}

$btnLogin.Add_Click({
  try {
    $btnLogin.Enabled = $false; $btnLogin.Text = '…'
    $data = Get-Data $null
    $s = Unlock-Account $data.auth $txtUser.Text $txtPass.Text
    $script:Session = $s; $txtPass.Text = ''
    if ($chkRemember.Checked) { Save-Session $s } elseif (Test-Path $SessionFile) { Remove-Item $SessionFile }
    After-Login
  } catch { $btnLogin.Enabled = $true; $btnLogin.Text = 'Giriş'; Log "✖ $($_.Exception.Message)" }
})

$cmbChar.Add_SelectedIndexChanged({
  if ($cmbChar.SelectedIndex -ge 0) { $script:Settings.charId = $script:Chars[$cmbChar.SelectedIndex].id; Save-Settings $script:Settings; Log "Aktif karakter: $($cmbChar.SelectedItem)" }
})
$btnPause.Add_Click({ $script:Paused = -not $script:Paused; $btnPause.Text = $(if ($script:Paused) { 'Devam' } else { 'Duraklat' }); Log $(if ($script:Paused) { 'Duraklatıldı.' } else { 'İzleme devam ediyor.' }) })

# ---------------------------------------------------------------- İzleme döngüsü
# Her 150 ms'de sadece altın "Open" butonu bölgesine bakılır (çok ucuz: küçük bir alanın rengi).
# Buton görününce TÜM EKRAN o an yakalanır ve okuma bu görüntü üzerinden yapılır → pencere okuma
# sırasında kapansa bile değerler kaybolmaz. Pencerenin ~0,15 sn görünmesi yeterli.
# idle  : buton görününce ekran yakalanır → başlık "Odyle Energy Cube" mı? → değerler okunur, siteyle eşitlenir.
# open  : buton görünür kaldıkça son ekran görüntüsü güncellenir (kutu sayısı değişirse doğru sayı kaydedilsin).
# kapanış: buton ~0,9 sn görünmezse "Open" sayılır; son görüntü okunur; 4 sn beklenir
#          (pencere aynı zindan + aynı sayaçla geri açılırsa kapanış sayılmaz).
$script:State = 'idle'; $script:Paused = $true
$script:Last = $null; $script:Synced = $null; $script:Miss = 0; $script:Tick = 0
$script:Snap = $null; $script:SnapFresh = $false   # son ekran görüntüsü; okunmamış yeni görüntü mü?
$script:RetryAt = [datetime]::MinValue              # başka bir altın buton (başka menü) görülürse kısa bekleme
$script:Pending = $null      # @{ due; read }
$script:LastSent = $null     # geri alma için: @{ before = read; charId }

function Char-Id { if ($cmbChar.SelectedIndex -ge 0) { $script:Chars[$cmbChar.SelectedIndex].id } else { $null } }
function Char-Name { if ($cmbChar.SelectedIndex -ge 0) { $script:Chars[$cmbChar.SelectedIndex].name } else { '?' } }

function Capture-Screen { [A2Img]::Capture(0, 0, [A2Img]::ScreenW(), [A2Img]::ScreenH()) }
function Open-Button-Visible {
  $W = [A2Img]::ScreenW(); $H = [A2Img]::ScreenH(); $o = Rect-Of $Regions.open $W $H
  $b = [A2Img]::Capture($o.x, $o.y, $o.w, $o.h); $r = [A2Img]::GoldRatio($b); $b.Dispose()
  return ($r -gt 0.30)
}

function Commit-Pending {
  $p = $script:Pending; $script:Pending = $null
  if (-not $p) { return }
  $r = $p.read; $cid = $p.charId
  $op = @{ type = 'dungeonOpen'; charId = $cid; name = $r.dungeon; boxes = $r.boxes; cost = $r.cost; max = $r.max; seen = $r.seen }
  $script:LastSent = @{ before = $r; charId = $cid }
  $script:Synced = $null   # harcama sonrası değerler değişti → bir sonraki açılışta mutlaka yeniden eşitle (Cancel düzeltmesi)
  $btnUndo.Enabled = $true
  Send-Ops @($op) ("{0}: {1} {2} kutu, -{3} enerji" -f $p.charName, $r.dungeon, $r.boxes, $r.cost)
}

function On-Read($r) {
  $lblStatus.Text = "Pencere açık: $($r.dungeon) · maliyet $($r.cost) · kutu $($r.boxes)/$($r.boxesMax) · garanti $($r.seen)/$($r.max)" +
    $(if ($null -ne $r.natural) { " · enerji $($r.natural)(+$($r.bonus))/$($r.energyMax)" } else { '' })
  # Bekleyen kapanış varsa ve pencere AYNI zindan + AYNI sayaçla geri açıldıysa → kapanış değildi (ör. kısa süre gizlendi)
  if ($script:Pending -and $script:Pending.read.dungeon -eq $r.dungeon -and $script:Pending.read.seen -eq $r.seen) {
    $script:Pending = $null; Log "Pencere tekrar açıldı (sayaç değişmemiş) — önceki kapanış sayılmadı."
  } elseif ($script:Pending) { Commit-Pending }

  # İlk geçerli okumada ya da değerler değiştiyse eşitle
  $key = "$(Char-Id)|$($r.dungeon)|$($r.seen)/$($r.max)|$($r.natural)|$($r.bonus)"
  if ($script:Synced -ne $key) {
    $ops = @(@{ type = 'dungeonSet'; charId = (Char-Id); name = $r.dungeon; count = $r.seen; max = $r.max })
    if ($null -ne $r.natural) { $ops += @{ type = 'energySync'; charId = (Char-Id); natural = $r.natural; bonus = $r.bonus; max = $r.energyMax } }
    Send-Ops $ops ("{0}: {1} {2}/{3}{4}" -f (Char-Name), $r.dungeon, $r.seen, $r.max, $(if ($null -ne $r.natural) { ", enerji $($r.natural)(+$($r.bonus))" } else { '' }))
    $script:Synced = $key
  }
  $script:Last = $r
}

$DebugDir = Join-Path $AppDir 'yakalanan'
New-Item -ItemType Directory -Force $DebugDir | Out-Null
function Save-Debug([System.Drawing.Bitmap]$bmp, [string]$tag, $r) {
  try {
    $name = '{0:yyyyMMdd-HHmmss-fff}-{1}.png' -f (Get-Date), $tag
    $bmp.Save((Join-Path $DebugDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    Add-Content (Join-Path $DebugDir 'okunanlar.txt') ('{0}  zindan={1} maliyet={2} kutu={3}/{4} garanti={5}/{6} enerji={7}(+{8})/{9}' -f $name, $r.dungeon, $r.cost, $r.boxes, $r.boxesMax, $r.seen, $r.max, $r.natural, $r.bonus, $r.energyMax) -Encoding UTF8
    Get-ChildItem $DebugDir -Filter *.png | Sort-Object Name -Descending | Select-Object -Skip 40 | Remove-Item -Force
  } catch {}
}
function Drop-Snap { if ($script:Snap) { $script:Snap.Dispose(); $script:Snap = $null }; $script:SnapFresh = $false }

function Invoke-Tick {
  try {
    if ($script:Queue.Count -gt 0 -and ($script:Tick % 20) -eq 0) { Flush-Queue }   # ~3 sn'de bir tekrar dene
    $script:Tick++
    if ($script:Paused -or -not $script:Session -or -not (Char-Id)) { return }
    if ($script:Pending -and (Get-Date) -ge $script:Pending.due) { Commit-Pending }

    $visible = Open-Button-Visible

    if ($visible) {
      if ($script:State -eq 'idle' -and (Get-Date) -lt $script:RetryAt) { return }
      $full = Capture-Screen                                   # önce yakala (pencere birazdan kapanabilir)
      Drop-Snap; $script:Snap = $full; $script:SnapFresh = $true; $script:Miss = 0
      if ($script:State -eq 'open') { return }                 # açıkken sadece son görüntüyü tut

      # Yeni açılış: başlığı ve değerleri yakalanan görüntüden oku
      if (-not (Title-Visible $full)) { Drop-Snap; $script:RetryAt = (Get-Date).AddMilliseconds(500); return }
      $r = Read-Cube $full
      if (-not $r.valid) { Drop-Snap; return }                 # açılış animasyonu vb. → sonraki turda tekrar
      $script:State = 'open'; $script:SnapFresh = $false
      Save-Debug $full 'acilis' $r
      On-Read $r
      return
    }

    if ($script:State -ne 'open') { return }
    $script:Miss++
    if ($script:Miss -lt 6) { return }                         # ~0,9 sn boyunca görünmedi → kapandı

    $script:State = 'idle'
    $r = $script:Last
    if ($script:Snap -and $script:SnapFresh) {                  # açıkken değer değiştiyse (ör. kutu 2/2 → 1/2) son hali
      $r2 = Read-Cube $script:Snap
      if ($r2.valid -and $r2.dungeon -eq $script:Last.dungeon) { $r = $r2; Save-Debug $script:Snap 'kapanis' $r2 }
    }
    Drop-Snap
    if ($r) {
      $script:Pending = @{ due = (Get-Date).AddSeconds(4); read = $r; charId = (Char-Id); charName = (Char-Name) }
      $lblStatus.Text = "Pencere kapandı: $($r.dungeon) $($r.boxes) kutu, -$($r.cost) enerji kaydediliyor…"
    } else { $lblStatus.Text = 'İzleniyor…' }
  } catch { Log "✖ Hata: $($_.Exception.Message)" }
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({ Invoke-Tick })

$btnUndo.Add_Click({
  $u = $script:LastSent; if (-not $u) { return }
  $r = $u.before
  $ops = @(@{ type = 'dungeonSet'; charId = $u.charId; name = $r.dungeon; count = $r.seen; max = $r.max })
  if ($null -ne $r.natural) { $ops += @{ type = 'energySync'; charId = $u.charId; natural = $r.natural; bonus = $r.bonus; max = $r.energyMax } }
  Send-Ops $ops ("GERİ AL: {0} {1}/{2}" -f $r.dungeon, $r.seen, $r.max)
  $script:LastSent = $null; $btnUndo.Enabled = $false
})

$btnTest.Add_Click({
  $full = Capture-Screen
  try {
    $path = Join-Path $AppDir ('ekran-{0:yyyyMMdd-HHmmss}.png' -f (Get-Date)); $full.Save($path)
    $r = Read-Cube $full; $t = Title-Visible $full
    Log ("Test: başlık={0} geçerli={1} zindan={2} maliyet={3} kutu={4}/{5} garanti={6}/{7} enerji={8}(+{9})/{10}" -f $t, $r.valid, $r.dungeon, $r.cost, $r.boxes, $r.boxesMax, $r.seen, $r.max, $r.natural, $r.bonus, $r.energyMax)
    Log "Ekran görüntüsü kaydedildi: $path"
  } finally { $full.Dispose() }
})

if ($env:A2_LOOP_TEST) {   # geliştirici testi: kare dizisiyle döngüyü sına (gerçek ekran/gönderim yok)
  $cube = [System.Drawing.Bitmap]::FromFile($env:A2_CUBE); $none = [System.Drawing.Bitmap]::FromFile($env:A2_NONE)
  $other = [System.Drawing.Bitmap]::FromFile($env:A2_OTHER)
  $script:Frame = $none
  function Open-Button-Visible { $o = Rect-Of $Regions.open $script:Frame.Width $script:Frame.Height; $b = [A2Img]::Crop($script:Frame, $o.x, $o.y, $o.w, $o.h); $r = [A2Img]::GoldRatio($b); $b.Dispose(); $r -gt 0.30 }
  function Capture-Screen { $script:Frame.Clone() }
  function Send-Ops([object[]]$ops, [string]$summary) { Write-Host ("  → GÖNDER: {0}   [{1}]" -f $summary, (($ops | ForEach-Object { $_.type }) -join ', ')) }
  function Log([string]$m) { Write-Host "  · $m" }
  $script:Session = @{ user = 'karip' }; $script:Chars = @([pscustomobject]@{ id = 'kyrakia'; name = 'Kyrakia' }); [void]$cmbChar.Items.Add('Kyrakia'); $cmbChar.SelectedIndex = 0
  $script:Paused = $false
  function Run([string]$title, [object[]]$frames) {
    Write-Host "=== $title"
    foreach ($fr in $frames) { if ($fr -is [string]) { Write-Host '  (4 sn geçti)'; Commit-Pending; continue }; $script:Frame = $fr; Invoke-Tick }
    if ($script:Pending) { Write-Host '  (4 sn bekleme bitti)'; Commit-Pending }
    $script:State = 'idle'; $script:Synced = $null; $script:Last = $null; $script:RetryAt = [datetime]::MinValue
  }
  $n = { param($c, $k) @(1..$k | ForEach-Object { $c }) }
  Run '1) Hızlı açış: pencere sadece 2 tur (0,3 sn) göründü' ((& $n $none 2) + (& $n $cube 2) + (& $n $none 8))
  Run '2) Kapanıp aynı değerlerle hemen geri açıldı, sonra gerçekten kapandı' ((& $n $cube 3) + (& $n $none 7) + (& $n $cube 3) + (& $n $none 8))
  Run '3) Başka bir altın buton (başlık farklı)' ((& $n $other 6) + (& $n $none 4))
  Run '4) Cancel: harcama kaydedildi, sonra pencere AYNI değerlerle açıldı → yeniden eşitlemeli' ((& $n $cube 2) + (& $n $none 7) + @('COMMIT') + (& $n $cube 2) + (& $n $none 7))
  $cube.Dispose(); $none.Dispose(); $other.Dispose()
  return
}

$form.Add_Shown({
  Log "Ekran: $([A2Img]::ScreenW())x$([A2Img]::ScreenH())"
  if ($env:A2_GUI_TEST) {   # geliştirici testi: pencerenin görüntüsünü kaydet ve kapan
    $cmbChar.Items.AddRange(@('Kyrakia', 'Karip')); $cmbChar.SelectedIndex = 0; Log 'Test: arayüz oluşturuldu.'
    $bmp = New-Object Drawing.Bitmap($form.Width, $form.Height); $form.DrawToBitmap($bmp, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bmp.Save($env:A2_GUI_TEST); $bmp.Dispose(); $form.Close(); return
  }
  $s = Load-Session
  if ($s) { try { $script:Session = $s; $txtUser.Text = $s.user; After-Login } catch { $script:Session = $null; Log "Kayıtlı oturum açılamadı: $($_.Exception.Message)" } }
  $timer.Start()
})
$form.Add_FormClosing({ $timer.Stop(); if ($script:Pending) { Commit-Pending } })
[void]$form.ShowDialog()
