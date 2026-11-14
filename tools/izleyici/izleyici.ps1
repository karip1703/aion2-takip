# Karip Traker — Ekran izleyici
# Odyle Energy Cube (ödül kutusu) penceresini ekrandan okur:
#   * Pencere açılınca: enerjiyi (ör. 0(+845)/840) ve zindanın garanti sayacını siteyle EŞİTLER.
#   * Pencere kapanınca: Open sayılır → enerjiden maliyet düşülür, garanti sayacı kutu sayısı kadar ilerler.
#     (Cancel'a basıldıysa bir sonraki açılışta ekrandan okunan değerlerle kendiliğinden düzelir.)
# Oyuna, oyun dosyalarına ya da ağ trafiğine dokunmaz; klavye/fare dinlemez. Sadece ekran görüntüsü alır.
#
# Kayıtlar data/inbox/ klasörüne küçük dosyalar olarak gönderilir; GitHub Actions bunları data.json'a uygular.
#
# Arayüz: uygulama siteyi http://127.0.0.1:47321 adresinden sunar ve kendi penceresinde açar (Edge uygulama modu);
# izleyicinin durumu ve komutları sitenin "Uygulama" bölümündedir. Saat yanındaki simgeden de yönetilir.
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
    [System.Windows.Forms.MessageBox]::Show($msg, 'Karip Traker — Ekran izleyici', 'OK', 'Error') | Out-Null
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
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // Ön plandaki pencerenin işlem adı (ör. "Aion2"). Discord yayınını vb. ayırt etmek için.
  public static string ForegroundProcess() {
    try { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }
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

  // Enerji yazısının yatay sınırları. HUD grubu sayıların uzunluğuna göre kayar; bölgede soldaki ikon ve sağdaki "+"
  // butonu da olabilir. Sütunlar "gap" kadar boşlukla kümelere ayrılır; turkuaz "(+…)" içeren küme (yoksa en geniş)
  // yazıdır → { sol, sağ, turkuazSol, turkuazSağ } (turkuaz yoksa -1). Yazı yoksa null.
  public static int[] TextSpan(Bitmap b, int thr, int gap) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height]; Marshal.Copy(d.Scan0, px, 0, px.Length); b.UnlockBits(d);
    int[] best = null; int bestCyan = -1, bestW = -1;
    int start = -1, last = -1, cyan = 0, cl = -1, cr = -1;
    for (int x = 0; x <= b.Width; x++) {
      bool ink = false, cy = false;
      if (x < b.Width) for (int y = 0; y < b.Height; y++) {
        int i = y * d.Stride + x * 4; int b0 = px[i], g0 = px[i + 1], r0 = px[i + 2];
        int mx = Math.Max(b0, Math.Max(g0, r0)), mn = Math.Min(b0, Math.Min(g0, r0));
        if (b0 > thr && g0 > thr - 30 && r0 < b0 - 50) { ink = true; cy = true; break; }
        if (mn > thr && (mx - mn) < 60) ink = true;
      }
      if (ink) { if (start < 0) { start = x; cyan = 0; cl = -1; cr = -1; } last = x; if (cy) { cyan++; if (cl < 0) cl = x; cr = x; } }
      if (start >= 0 && (x == b.Width || (!ink && x - last >= gap))) {   // küme bitti
        int w = last - start + 1;
        if (cyan > bestCyan || (cyan == bestCyan && w > bestW)) { best = new[] { start, last, cl, cr }; bestCyan = cyan; bestW = w; }
        start = -1;
      }
    }
    return best;
  }

  // OCR için hazırla: büyüt, renge göre ayıkla (siyah yazı / beyaz zemin), kenar boşluğu, isteğe bağlı sol etiket.
  // mode: all = en parlak kanal > eşik; white = gri/beyaz yazı; light = tüm kanallar parlak (açık mavi dahil); cyan = turkuaz yazı
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
      else if (mode == "light") hit = mn > thr;                 // açık renkli yazı (beyaz, açık mavi); doygun çubukları dışarıda bırakır
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
  # Enerji yazısı sağa yaslı (bitişi ~0.448H); ek enerji büyüdükçe sola uzar ("0(+1,565)/840") → solda pay bırakıldı.
  energy    = @{ r1 = 0.575; r2 = 0.400; y1 = 0.018; y2 = 0.052 }
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

# Rakam düzeltmeleri: O→0, l/I/|→1, boşluklar ve binlik ayracı ("1,565" / "1.565" → "1565")
function Norm-Digits([string]$s) { ($s -replace '[Oo]', '0' -replace '[Il|]', '1' -replace '\s', '' -replace '(?<=\d)[.,](?=\d{3}(\D|$))', '') }

# Bir bölgeyi birkaç ayarla okuyup ilk eşleşeni döndür
function Read-Field([System.Drawing.Bitmap]$crop, [string]$mode, [string]$label, [int[]]$scales, [string]$pattern) {
  foreach ($sc in $scales) {
    $p = [A2Img]::Prep($crop, $sc, 140, $mode, $label)
    $t = Read-Text $p; $p.Dispose()
    if ($label) { $t = ($t -replace "^.*?$label", '').Trim() }
    if ($env:A2_DEBUG) { Write-Host ("    [{0} x{1}] ham='{2}' → '{3}'" -f $mode, $sc, $t, (Norm-Digits $t)) }
    $m = [regex]::Match((Norm-Digits $t), $pattern)
    if ($m.Success) { return $m }
  }
  return $null
}

# Tüm ölçeklerde oku, her gruptaki değer için çoğunluk oyu (eşitlikte daha uzun sayı) → [string[]] ya da $null.
# Enerji gibi kritik alanlarda tek bir hatalı okumanın kaydedilmesini önler.
function Read-Vote([System.Drawing.Bitmap]$crop, [string]$mode, [string]$label, [int[]]$scales, [string]$pattern, [int]$groups) {
  $votes = @{}
  foreach ($sc in $scales) {
    $p = [A2Img]::Prep($crop, $sc, 140, $mode, $label)
    $t = Read-Text $p; $p.Dispose()
    if ($label) { $t = ($t -replace "^.*?$label", '').Trim() }
    if ($env:A2_DEBUG) { Write-Host ("    [{0} x{1} oy] ham='{2}' → '{3}'" -f $mode, $sc, $t, (Norm-Digits $t)) }
    $m = [regex]::Match((Norm-Digits $t), $pattern)
    if ($m.Success) { $k = (1..$groups | ForEach-Object { $m.Groups[$_].Value }) -join '|'; $votes[$k] = 1 + [int]$votes[$k] }
  }
  if ($votes.Count -eq 0) { return $null }
  $win = $votes.GetEnumerator() | Sort-Object @{ e = { $_.Value }; Descending = $true }, @{ e = { $_.Key.Length }; Descending = $true } | Select-Object -First 1
  return ,($win.Key -split '\|')
}

# Bilinen zindan adları: sitedeki tüm karakterlerin sayaçlarından (girişte doldurulur) + sık görülenler.
$script:KnownDungeons = New-Object System.Collections.Generic.List[string]
foreach ($d in @('Fire Temple')) { $script:KnownDungeons.Add($d) }
function Edit-Distance([string]$a, [string]$b) {
  $d = New-Object 'int[,]' ($a.Length + 1), ($b.Length + 1)
  for ($i = 0; $i -le $a.Length; $i++) { $d[$i, 0] = $i }
  for ($j = 0; $j -le $b.Length; $j++) { $d[0, $j] = $j }
  for ($i = 1; $i -le $a.Length; $i++) {
    for ($j = 1; $j -le $b.Length; $j++) {
      $cost = if ($a[$i - 1] -eq $b[$j - 1]) { 0 } else { 1 }
      $del = $d[($i - 1), $j] + 1; $ins = $d[$i, ($j - 1)] + 1; $sub = $d[($i - 1), ($j - 1)] + $cost
      $m = $del; if ($ins -lt $m) { $m = $ins }; if ($sub -lt $m) { $m = $sub }
      $d[$i, $j] = $m
    }
  }
  return $d[$a.Length, $b.Length]
}
function Match-Dungeon([string]$ocr) {
  $o = $ocr.Trim().ToLowerInvariant()
  foreach ($k in $script:KnownDungeons) { if ($k.ToLowerInvariant() -eq $o) { return $k } }
  if ($o.Length -ge 4) {
    # Kısmi okuma: okunan, bilinen bir adın başı ya da bilinen ad okunanın içinde ("Fire" → "Fire Temple")
    foreach ($k in $script:KnownDungeons) { $kl = $k.ToLowerInvariant(); if ($kl.StartsWith($o) -or $o.Contains($kl)) { return $k } }
    # Harf hatası ("Fire Tempte" → "Fire Temple"): uzunluğun ~%20'si kadar farka izin ver
    $bestK = $null; $bestD = 99
    foreach ($k in $script:KnownDungeons) { $dd = Edit-Distance $o $k.ToLowerInvariant(); if ($dd -lt $bestD) { $bestD = $dd; $bestK = $k } }
    if ($bestK -and $bestD -le [Math]::Max(1, [Math]::Floor($bestK.Length * 0.2))) { return $bestK }
  }
  return $ocr.Trim()
}

# Odyle Energy Cube penceresini oku. $full = ekranın tamamı ya da test görüntüsü.
function Read-Cube([System.Drawing.Bitmap]$full) {
  $W = $full.Width; $H = $full.Height
  $res = [ordered]@{}

  $c = Sub-Crop $full @{ x = 0; y = 0 } $Regions.dungeon $W $H
  # Küçük ekranlarda bazı ölçekler kelime kaçırabiliyor ("Fire Temple" → "Fire") ya da harf karıştırabiliyor
  # ("Fire Tempte"). Tüm ölçekler denenir, en çok harf içeren sonuç alınır, sonra bilinen zindan adlarına eşlenir.
  $best = ''
  foreach ($sc in 3, 4, 2, 5) {
    $p = [A2Img]::Prep($c, $sc, 140, 'all', $null); $t = ((Read-Text $p) -replace '\s+', ' ').Trim(); $p.Dispose()
    if ($env:A2_DEBUG) { Write-Host ("    [zindan x{0}] ham='{1}'" -f $sc, $t) }
    if (($t -replace '[^\p{L}]', '').Length -gt ($best -replace '[^\p{L}]', '').Length) { $best = $t }
  }
  if (($best -replace '[^\p{L}]', '').Length -ge 3) { $res.dungeon = Match-Dungeon $best }
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

  # Enerji: beyaz kısım "0 … /840", turkuaz kısım "(+845)". Yazı sağa yaslı ve ek enerji büyüdükçe sola uzar;
  # dar bölge kısa sayılarda, geniş bölge uzun sayılarda iyi okur → üç genişlik denenir, tutarlı sonuç seçilir.
  # Sabit sol kenar bazen ilk rakamın ortasına denk geliyor (4 → 1, 0 → 1) → yazının başlangıcı pikselden bulunur,
  # bölge onun biraz solundan başlatılır. Bulunamazsa eski sabit genişliklere dönülür.
  $evotes = @{}
  $wide = Sub-Crop $full @{ x = 0; y = 0 } $Regions.energy $W $H
  $span = [A2Img]::TextSpan($wide, 140, [Math]::Max(5, [int](0.007 * $H))); $wide.Dispose()
  $x0 = [int]($W - $Regions.energy.r1 * $H)
  $r2 = 0.441
  $r1s = if ($span) {
    $r2 = ($W - ($x0 + $span[1] + 0.006 * $H)) / $H                       # yazının sağı + küçük pay
    @(0.004, 0.008, 0.013) | ForEach-Object { ($W - ($x0 + $span[0] - $_ * $H)) / $H }
  } else { @(0.522, 0.545, 0.575) }
  if ($env:A2_DEBUG) { Write-Host ("    [enerji yazı] span={0} r1={1} r2={2:N3}" -f ($span -join '-'), (($r1s | ForEach-Object { '{0:N3}' -f $_ }) -join ','), $r2) }

  # Turkuaz "(+…)" bulunduysa üç parça ayrı okunur: [doğal] [(+ek)] [/sınır]. Birlikte okununca turkuaz parantezin
  # kenar pikselleri beyaz modda "I"/"1" gibi görünüp doğal enerjiyi bozuyordu ("0I/840" → 1).
  if ($span -and $span[2] -ge 0) {
    $ey = [int]($Regions.energy.y1 * $H); $eh = [int]($Regions.energy.y2 * $H) - $ey
    $pad = [Math]::Max(3, [int](0.006 * $H))
    $cut = { param($l, $r) [A2Img]::Crop($full, [int]$l, $ey, [int]([Math]::Max(1, $r - $l + 1)), $eh) }
    $c = & $cut ($x0 + $span[0] - $pad) ($x0 + $span[2] - 2)
    $mn = Read-Vote $c 'white' 'ENERGY' @(2, 3, 4) '(\d{1,4})(?!.*\d)' 1; $c.Dispose()
    $c = & $cut ($x0 + $span[2] - 1) ($x0 + $span[3] + 1)
    $mb = Read-Vote $c 'cyan' 'ENERGY' @(2, 3, 4) '\+?(\d{1,5})' 1; $c.Dispose()
    $c = & $cut ($x0 + $span[3] + 2) ($x0 + $span[1] + $pad)
    $mx = Read-Vote $c 'white' 'ENERGY' @(2, 3, 4) '(\d{3,4})(?!.*\d)' 1; $c.Dispose()
    if ($mn -and $mx) {
      $nat = [int]$mn[0]; $emax = [int]$mx[0]; $bon = if ($mb) { [int]$mb[0] } else { 0 }
      if ($mx[0].Length -eq 4) { $emax = [int]$mx[0].Substring(1) }   # sınır 3 hanelidir (560/840); "/" bazen "1" okunur → "1840"
      if ($env:A2_DEBUG) { Write-Host ("    [enerji parçalı] {0}|{1}|{2}" -f $nat, $emax, $bon) }
      if ($nat -le $emax -and $emax -ge 100 -and $emax -le 2000 -and $bon -le 5000) { $evotes["$nat|$emax|$bon"] = 10 }
    }
  }
  if ($evotes.Count -gt 0) { $r1s = @() }   # parçalı okuma başarılı → bütün okuma gerekmez

  foreach ($r1 in $r1s) {
    $g = @{ r1 = $r1; r2 = $r2; y1 = $Regions.energy.y1; y2 = $Regions.energy.y2 }
    $c = Sub-Crop $full @{ x = 0; y = 0 } $g $W $H
    # Soldaki ikon kırıntısı başa çöp karakter ekleyebilir → başa sabitlenmeden, "/" öncesindeki son sayı
    $mw = Read-Vote $c 'white' 'ENERGY' @(2, 3, 4) '(\d{1,4})\D{0,4}/(\d{3,4})(?!.*/)' 2
    $mc = Read-Vote $c 'cyan' 'ENERGY' @(2, 3, 4) '\+?(\d{1,5})' 1
    $c.Dispose()
    if (-not $mw) { continue }
    $nat = [int]$mw[0]; $emax = [int]$mw[1]; $bon = if ($mc) { [int]$mc[0] } else { 0 }
    # Mantık kontrolü: doğal enerji sınırı aşamaz, sınır makul aralıkta, ek enerji makul
    if ($nat -gt $emax -or $emax -lt 100 -or $emax -gt 2000 -or $bon -gt 5000) { continue }
    $k = "$nat|$emax|$bon"; $evotes[$k] = 1 + [int]$evotes[$k]
    if ($env:A2_DEBUG) { Write-Host ("    [enerji r1={0}] {1}" -f $r1, $k) }
  }
  if ($evotes.Count -gt 0) {
    # En çok tekrar eden; eşitlikte ek enerjisi daha uzun olan (kesilmemiş okuma)
    $win = $evotes.GetEnumerator() | Sort-Object @{ e = { $_.Value }; Descending = $true }, @{ e = { ($_.Key -split '\|')[2].Length }; Descending = $true } | Select-Object -First 1
    $p3 = $win.Key -split '\|'
    $res.natural = [int]$p3[0]; $res.energyMax = [int]$p3[1]; $res.bonus = [int]$p3[2]
  }

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
    $sec = (Get-Content $SessionFile -Raw).Trim() | ConvertTo-SecureString   # Set-Content sona satır sonu ekler
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $o = $plain | ConvertFrom-Json
    return @{ user = $o.user; token = $o.token; owner = $o.owner; repo = $o.repo; branch = $o.branch }
  } catch { $script:SessionError = $_.Exception.Message; return $null }
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

# ---------------------------------------------------------------- Uygulama durumu
# Arayüz artık sitenin kendisi: uygulama siteyi http://127.0.0.1:47321 adresinden sunar ve Edge'in uygulama
# penceresinde açar. Site "Uygulama" bölümünde bu durumu /api/status ile okur; komutlar /api/* ile gelir.
# Saat yanındaki simge: paneli aç, duraklat, ekranı oku, çıkış.
$Version = '2.0'
$Port = 47321
$AppUrl = "http://127.0.0.1:$Port/"
$AppOrigin = "http://127.0.0.1:$Port"

$script:Session = $null
$script:Chars = @()
$script:Settings = Load-Settings
$script:CharId = $script:Settings.charId
$script:StatusText = 'Giriş bekleniyor — panelde giriş yap.'
$script:LogLines = New-Object System.Collections.ArrayList
$script:LastRead = $null
$script:LoginRetryAt = [datetime]::MaxValue

function Log([string]$msg) {
  $script:LogLines.Insert(0, [ordered]@{ t = (Get-Date).ToString('o'); m = $msg })
  while ($script:LogLines.Count -gt 200) { $script:LogLines.RemoveAt($script:LogLines.Count - 1) }
  try { Add-Content (Join-Path $AppDir 'kayit.log') ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg) -Encoding UTF8 } catch {}
}
function Set-Status([string]$t) { $script:StatusText = $t }
function Update-Tray {}   # simge oluşturulunca gerçeği tanımlanır

function Char-Ids { @($script:Chars | ForEach-Object { $_.id }) }
function Char-Id { if ($script:CharId -and ((Char-Ids) -contains $script:CharId)) { $script:CharId } else { $null } }
function Char-Name { $id = Char-Id; $c = $script:Chars | Where-Object { $_.id -eq $id } | Select-Object -First 1; if ($c) { $c.name } else { '?' } }
function Set-Char([string]$id) {
  if (-not ((Char-Ids) -contains $id)) { throw 'Bilinmeyen karakter' }
  if ($script:CharId -eq $id) { return }
  $script:CharId = $id
  $script:Settings | Add-Member -NotePropertyName charId -NotePropertyValue $id -Force
  Save-Settings $script:Settings
  $script:Synced = $null   # yeni karakter → bir sonraki açılışta mutlaka eşitle
  Log "Aktif karakter: $(Char-Name)"
  Update-Tray
}

function After-Login {
  $data = Get-Data $script:Session.token
  $script:Chars = @($data.characters | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name } })
  foreach ($ch in $data.characters) { foreach ($d in @($ch.dungeons)) { if ($d.name -and $d.name.Length -ge 6 -and -not $script:KnownDungeons.Contains($d.name)) { $script:KnownDungeons.Add($d.name) } } }
  if (-not (Char-Id) -and $script:Chars.Count) { $script:CharId = $script:Chars[0].id }
  $script:LoginRetryAt = [datetime]::MaxValue
  $script:Paused = $false
  Set-Status 'İzleniyor — ödül kutusu penceresi bekleniyor.'
  Log "Giriş yapıldı: $($script:Session.user). İzleme başladı. Aktif karakter: $(Char-Name)"
  Update-Tray
}
# strict: token/bağlantı doğrulanamazsa oturumu kabul etme (panelden giriş). Değilse (kayıtlı oturum) sonra tekrar dene.
function Set-Session($s, [bool]$save, [bool]$strict) {
  $prev = $script:Session
  $script:Session = $s
  try { After-Login }
  catch {
    if ($strict) { $script:Session = $prev; throw }
    $script:Paused = $true; $script:LoginRetryAt = (Get-Date).AddSeconds(30)
    Set-Status "Bağlanılamadı, tekrar denenecek: $($_.Exception.Message)"
    Log "… GitHub'a bağlanılamadı, 30 sn sonra tekrar denenecek: $($_.Exception.Message)"
  }
  if ($save) { Save-Session $s }
}
function Clear-Session {
  $script:Session = $null; $script:Chars = @(); $script:Paused = $true
  if (Test-Path $SessionFile) { Remove-Item $SessionFile -Force }
  Set-Status 'Giriş bekleniyor — panelde giriş yap.'
  Log 'Oturum kapatıldı.'
  Update-Tray
}

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
  $script:LastSent = @{ before = $r; charId = $cid; charName = $p.charName }
  $script:Synced = $null   # harcama sonrası değerler değişti → bir sonraki açılışta mutlaka yeniden eşitle (Cancel düzeltmesi)
  Set-Status ("Kaydedildi: {0} {1} kutu, -{2} enerji" -f $r.dungeon, $r.boxes, $r.cost)
  Send-Ops @($op) ("{0}: {1} {2} kutu, -{3} enerji" -f $p.charName, $r.dungeon, $r.boxes, $r.cost)
}

function On-Read($r) {
  Set-Status ("Pencere açık: $($r.dungeon) · maliyet $($r.cost) · kutu $($r.boxes)/$($r.boxesMax) · garanti $($r.seen)/$($r.max)" +
    $(if ($null -ne $r.natural) { " · enerji $($r.natural)(+$($r.bonus))/$($r.energyMax)" } else { '' }))
  $script:LastRead = [ordered]@{ at = (Get-Date).ToString('o'); dungeon = $r.dungeon; seen = $r.seen; max = $r.max; boxes = $r.boxes; cost = $r.cost
    natural = $r.natural; bonus = $r.bonus; energyMax = $r.energyMax; char = (Char-Name) }
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
    if ($script:Session -and -not $script:Chars.Count -and (Get-Date) -ge $script:LoginRetryAt) { Set-Session $script:Session $false $false }
    if ($script:Paused -or -not $script:Session -or -not (Char-Id)) { return }
    if ($script:Pending -and (Get-Date) -ge $script:Pending.due) { Commit-Pending }

    # Not: ön plan kontrolü yok — ekran, hangi pencere üstte olursa olsun sürekli okunur.
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
      Set-Status "Pencere kapandı: $($r.dungeon) $($r.boxes) kutu, -$($r.cost) enerji kaydediliyor…"
    } else { Set-Status 'İzleniyor — ödül kutusu penceresi bekleniyor.' }
  } catch { Log "✖ Hata: $($_.Exception.Message)" }
}

function Do-Undo {
  $u = $script:LastSent
  if (-not $u) { throw 'Geri alınacak kayıt yok' }
  $r = $u.before
  $ops = @(@{ type = 'dungeonSet'; charId = $u.charId; name = $r.dungeon; count = $r.seen; max = $r.max })
  if ($null -ne $r.natural) { $ops += @{ type = 'energySync'; charId = $u.charId; natural = $r.natural; bonus = $r.bonus; max = $r.energyMax } }
  Send-Ops $ops ("GERİ AL: {0}: {1} {2}/{3}" -f $u.charName, $r.dungeon, $r.seen, $r.max)
  $script:LastSent = $null
  $script:Synced = $null
}

function Do-Test {
  $full = Capture-Screen
  try {
    $path = Join-Path $AppDir ('ekran-{0:yyyyMMdd-HHmmss}.png' -f (Get-Date)); $full.Save($path)
    $r = Read-Cube $full; $t = Title-Visible $full
    Log ("Test: başlık={0} geçerli={1} zindan={2} maliyet={3} kutu={4}/{5} garanti={6}/{7} enerji={8}(+{9})/{10}" -f $t, $r.valid, $r.dungeon, $r.cost, $r.boxes, $r.boxesMax, $r.seen, $r.max, $r.natural, $r.bonus, $r.energyMax)
    Log "Ekran görüntüsü kaydedildi: $path"
    return [ordered]@{ title = $t; valid = $r.valid; dungeon = $r.dungeon; seen = $r.seen; max = $r.max; natural = $r.natural; bonus = $r.bonus; energyMax = $r.energyMax; file = $path }
  } finally { $full.Dispose() }
}

if ($env:A2_LOOP_TEST) {   # geliştirici testi: kare dizisiyle döngüyü sına (gerçek ekran/gönderim yok)
  $cube = [System.Drawing.Bitmap]::FromFile($env:A2_CUBE); $none = [System.Drawing.Bitmap]::FromFile($env:A2_NONE)
  $other = [System.Drawing.Bitmap]::FromFile($env:A2_OTHER)
  $script:Frame = $none
  function Open-Button-Visible { $o = Rect-Of $Regions.open $script:Frame.Width $script:Frame.Height; $b = [A2Img]::Crop($script:Frame, $o.x, $o.y, $o.w, $o.h); $r = [A2Img]::GoldRatio($b); $b.Dispose(); $r -gt 0.30 }
  function Capture-Screen { $script:Frame.Clone() }
  function Send-Ops([object[]]$ops, [string]$summary) { Write-Host ("  → GÖNDER: {0}   [{1}]" -f $summary, (($ops | ForEach-Object { $_.type }) -join ', ')) }
  function Log([string]$m) { Write-Host "  · $m" }
  $script:Session = @{ user = 'karip' }; $script:Chars = @([pscustomobject]@{ id = 'kyrakia'; name = 'Kyrakia' }); $script:CharId = 'kyrakia'
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

# ---------------------------------------------------------------- Uygulama penceresi
function Open-Panel {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($edge) { Start-Process $edge -ArgumentList "--app=$AppUrl", '--window-size=1280,860' } else { Start-Process $AppUrl }
}

# ---------------------------------------------------------------- Yerel sunucu (site + /api)
# Sadece 127.0.0.1'i dinler (dışarıdan erişilemez). Komutlar (POST) yalnızca bu adresten açılmış sayfadan kabul edilir;
# başka bir site tarayıcı üzerinden komut gönderemez, durumu ya da oturumu okuyamaz.
$Http = New-Object System.Net.HttpListener
$Http.Prefixes.Add($AppUrl)
try { $Http.Start() }
catch {
  # Port dolu → uygulama zaten açık: sadece paneli göster.
  Open-Panel
  exit 0
}

# Site dosyaları: depo klasöründen çalışıyorsa yerel kopya, değilse GitHub Pages'ten (kısa önbellekle).
$SiteDir = $null
$cand = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (Test-Path (Join-Path $cand 'assets\js\app.js')) { $SiteDir = $cand }
$PagesBase = "https://$($Repo.owner.ToLowerInvariant()).github.io/$($Repo.repo)/"
$script:ProxyCache = @{}
$Mime = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.webp' = 'image/webp' }

function Send-Bytes($ctx, [int]$code, [byte[]]$bytes, [string]$type) {
  $r = $ctx.Response
  $r.StatusCode = $code; $r.ContentType = $type
  $r.Headers['Cache-Control'] = 'no-store'; $r.Headers['X-Content-Type-Options'] = 'nosniff'
  $r.ContentLength64 = $bytes.Length
  $r.OutputStream.Write($bytes, 0, $bytes.Length); $r.Close()
}
function Send-Json($ctx, [int]$code, $obj) { Send-Bytes $ctx $code ([Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6 -Compress))) 'application/json; charset=utf-8' }
function Read-Body($ctx) {
  $sr = New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
  $t = $sr.ReadToEnd(); $sr.Close()
  if ($t) { $t | ConvertFrom-Json } else { [pscustomobject]@{} }
}

function Status-Object {
  [ordered]@{
    app = 'aion2-izleyici'; version = $Version
    loggedIn = [bool]$script:Session; user = $(if ($script:Session) { $script:Session.user } else { $null })
    paused = [bool]$script:Paused; charId = (Char-Id)
    chars = @($script:Chars | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name } })
    status = $script:StatusText; state = $script:State; canUndo = [bool]$script:LastSent; queue = $script:Queue.Count
    screen = ('{0}x{1}' -f [A2Img]::ScreenW(), [A2Img]::ScreenH())
    lastRead = $script:LastRead
    log = @($script:LogLines | Select-Object -First 60)
  }
}

function Serve-Static($ctx, [string]$path) {
  $rel = [Uri]::UnescapeDataString($path.TrimStart('/'))
  if (-not $rel) { $rel = 'index.html' }
  if ($rel -match '\.\.' -or $rel -match '[:\\]') { return Send-Json $ctx 400 @{ error = 'Geçersiz yol' } }
  if (-not ($rel -eq 'index.html' -or $rel -like 'assets/*' -or $rel -eq 'data/data.json')) { return Send-Json $ctx 404 @{ error = 'Bulunamadı' } }
  $type = $Mime[[IO.Path]::GetExtension($rel).ToLowerInvariant()]
  if (-not $type) { return Send-Json $ctx 404 @{ error = 'Bulunamadı' } }
  if ($SiteDir) {
    $f = Join-Path $SiteDir ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $f -PathType Leaf) { return Send-Bytes $ctx 200 ([IO.File]::ReadAllBytes($f)) $type }
    return Send-Json $ctx 404 @{ error = 'Bulunamadı' }
  }
  $c = $script:ProxyCache[$rel]
  if ($c -and $rel -ne 'data/data.json' -and ((Get-Date) - $c.at).TotalSeconds -lt 300) { return Send-Bytes $ctx 200 $c.bytes $type }
  try {
    $wc = New-Object Net.WebClient; $wc.Headers['User-Agent'] = 'aion2-izleyici'
    $bytes = $wc.DownloadData($PagesBase + $rel + $(if ($rel -eq 'data/data.json') { "?t=$([DateTime]::UtcNow.Ticks)" } else { '' }))
    $script:ProxyCache[$rel] = @{ at = Get-Date; bytes = $bytes }
    Send-Bytes $ctx 200 $bytes $type
  } catch {
    if ($c) { Send-Bytes $ctx 200 $c.bytes $type } else { Send-Json $ctx 502 @{ error = "Site indirilemedi: $($_.Exception.Message)" } }
  }
}

function Handle-Request($ctx) {
  $req = $ctx.Request; $path = $req.Url.AbsolutePath; $m = $req.HttpMethod
  # DNS rebinding'e karşı: başka bir alan adı 127.0.0.1'e yönlendirilse bile Host başlığı tutmaz → reddet.
  if (@("127.0.0.1:$Port", "localhost:$Port") -notcontains "$($req.Headers['Host'])".ToLowerInvariant()) {
    return Send-Json $ctx 403 @{ error = 'İzin yok' }
  }
  if (-not $path.StartsWith('/api/')) {
    if ($m -ne 'GET') { return Send-Json $ctx 405 @{ error = 'İzin verilmeyen yöntem' } }
    return Serve-Static $ctx $path
  }
  if ($m -eq 'POST' -and ($req.Headers['Origin'] -ne $AppOrigin -or -not ("$($req.ContentType)" -like 'application/json*'))) {
    return Send-Json $ctx 403 @{ error = 'İzin yok' }
  }
  switch ("$m $path") {
    'GET /api/status' { return Send-Json $ctx 200 (Status-Object) }
    'GET /api/session' {
      # Oturum yalnızca bu adresten açılmış sayfaya verilir (tarayıcı başka sitelerden gelen isteği "cross-site" diye işaretler).
      if ($req.Headers['Sec-Fetch-Site'] -ne 'same-origin') { return Send-Json $ctx 403 @{ error = 'İzin yok' } }
      if (-not $script:Session) { return Send-Json $ctx 404 @{ error = 'Oturum yok' } }
      return Send-Json $ctx 200 $script:Session
    }
    'POST /api/session' {
      $b = Read-Body $ctx
      if (-not $b.token -or -not $b.user) { return Send-Json $ctx 400 @{ error = 'Eksik oturum bilgisi' } }
      $s = @{ user = [string]$b.user; token = [string]$b.token; owner = [string]$b.owner; repo = [string]$b.repo; branch = $(if ($b.branch) { [string]$b.branch } else { 'main' }) }
      if ($script:Session -and $script:Session.token -eq $s.token -and $script:Session.user -eq $s.user) { return Send-Json $ctx 200 @{ ok = $true } }
      Set-Session $s $true $true
      return Send-Json $ctx 200 @{ ok = $true }
    }
    'POST /api/logout' { Clear-Session; return Send-Json $ctx 200 @{ ok = $true } }
    'POST /api/char' { $b = Read-Body $ctx; Set-Char ([string]$b.id); return Send-Json $ctx 200 @{ ok = $true } }
    'POST /api/pause' {
      if (-not $script:Session) { return Send-Json $ctx 409 @{ error = 'Önce giriş yap' } }
      $b = Read-Body $ctx; $p = [bool]$b.paused
      if ($p -ne [bool]$script:Paused) {
        $script:Paused = $p
        Log $(if ($p) { 'Duraklatıldı.' } else { 'İzleme devam ediyor.' })
        Set-Status $(if ($p) { 'Duraklatıldı — kutular kaydedilmiyor.' } else { 'İzleniyor — ödül kutusu penceresi bekleniyor.' })
        Update-Tray
      }
      return Send-Json $ctx 200 @{ ok = $true }
    }
    'POST /api/undo' { Do-Undo; return Send-Json $ctx 200 @{ ok = $true } }
    'POST /api/test' { return Send-Json $ctx 200 (Do-Test) }
  }
  return Send-Json $ctx 404 @{ error = 'Bulunamadı' }
}

$script:HttpTask = $Http.GetContextAsync()
function Pump-Http {
  for ($i = 0; $i -lt 10 -and $Http.IsListening -and $script:HttpTask.IsCompleted; $i++) {
    $t = $script:HttpTask
    $ctx = $null; try { $ctx = $t.Result } catch {}
    $script:HttpTask = $Http.GetContextAsync()
    if ($ctx) { try { Handle-Request $ctx } catch { try { Send-Json $ctx 500 @{ error = $_.Exception.Message } } catch {} } }
  }
}

# ---------------------------------------------------------------- Saat yanındaki simge
function New-TrayIcon {
  # Karip Traker logosu (assets/img/logo.svg) — 64 birimlik çizim 32 piksele ölçeklenir
  $bmp = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'
  $bg = New-Object Drawing.Drawing2D.GraphicsPath
  $bg.AddArc(0, 0, 10, 10, 180, 90); $bg.AddArc(21, 0, 10, 10, 270, 90); $bg.AddArc(21, 21, 10, 10, 0, 90); $bg.AddArc(0, 21, 10, 10, 90, 90); $bg.CloseFigure()
  $nb = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(8, 19, 34)); $g.FillPath($nb, $bg)
  $g.ScaleTransform(0.5, 0.5)
  $blue = [Drawing.Color]::FromArgb(42, 149, 255)
  $pen = New-Object Drawing.Pen($blue, 5); $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  function P { $pts = for ($i = 0; $i -lt $args.Count; $i += 2) { New-Object Drawing.PointF ([float]$args[$i]), ([float]$args[$i + 1]) }; ,([Drawing.PointF[]]$pts) }
  $g.DrawLines($pen, (P 12 43 12 20.5 32 9 52 20.5 52 31))
  $g.DrawLines($pen, (P 24.5 24 32 19.5 39.5 24))
  $g.DrawPolygon($pen, (P 20 35 32 28.5 44 35 44 46 32 52.5 20 46))
  $g.DrawLines($pen, (P 20 35 32 41.5 44 35)); $g.DrawLine($pen, 32, 41.5, 32, 52.5)
  $g.DrawLine($pen, 50, 37, 50, 42); $g.DrawLine($pen, 44, 45, 44, 48)
  $gb = New-Object Drawing.SolidBrush $blue; $g.FillEllipse($gb, 13, 46, 11, 11)
  $g.Dispose(); $pen.Dispose(); $nb.Dispose(); $gb.Dispose(); $bg.Dispose()
  [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = New-TrayIcon
$menu = New-Object Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Paneli aç'); $miOpen.Font = New-Object Drawing.Font($miOpen.Font, [Drawing.FontStyle]::Bold)
$miPause = $menu.Items.Add('Duraklat')
$miTest = $menu.Items.Add('Ekranı şimdi oku')
[void]$menu.Items.Add('-')
$miQuit = $menu.Items.Add('Çıkış')
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

function Update-Tray {
  $txt = if (-not $script:Session) { 'giriş bekleniyor' } elseif ($script:Paused) { "duraklatıldı · $(Char-Name)" } else { "izliyor · $(Char-Name)" }
  $t = "Karip Traker — $txt"; if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }
  $tray.Text = $t
  $miPause.Text = $(if ($script:Paused) { 'Devam et' } else { 'Duraklat' })
  $miPause.Enabled = [bool]$script:Session
}

function Quit-App {
  $timer.Stop(); $httpTimer.Stop()
  if ($script:Pending) { Commit-Pending }
  $tray.Visible = $false; $tray.Dispose()
  try { $Http.Stop() } catch {}
  [Windows.Forms.Application]::Exit()
}

$miOpen.add_Click({ Open-Panel })
$tray.add_MouseDoubleClick({ Open-Panel })
$miPause.add_Click({
  if (-not $script:Session) { return }
  $script:Paused = -not $script:Paused
  Log $(if ($script:Paused) { 'Duraklatıldı.' } else { 'İzleme devam ediyor.' })
  Set-Status $(if ($script:Paused) { 'Duraklatıldı — kutular kaydedilmiyor.' } else { 'İzleniyor — ödül kutusu penceresi bekleniyor.' })
  Update-Tray
})
$miTest.add_Click({ try { [void](Do-Test) } catch { Log "✖ Test: $($_.Exception.Message)" } })
$miQuit.add_Click({ Quit-App })

# ---------------------------------------------------------------- Başlat
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 150; $timer.Add_Tick({ Invoke-Tick })
$httpTimer = New-Object Windows.Forms.Timer; $httpTimer.Interval = 40; $httpTimer.Add_Tick({ Pump-Http })

Log "Uygulama başladı (v$Version). Ekran: $([A2Img]::ScreenW())x$([A2Img]::ScreenH()) · panel: $AppUrl$(if ($SiteDir) { ' (yerel dosyalar)' } else { '' })"
$s = Load-Session
if (-not $s -and $script:SessionError) { Log "Kayıtlı oturum okunamadı, panelde tekrar giriş yap: $($script:SessionError)" }
if ($s) { Set-Session $s $false $false }
Update-Tray
$timer.Start(); $httpTimer.Start()
if (-not $env:A2_NO_PANEL) { Open-Panel }
[Windows.Forms.Application]::Run()
