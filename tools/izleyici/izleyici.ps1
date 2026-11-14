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
$Version = '2.1'
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

# ---------------------------------------------------------------- Oyun içi panel (overlay)
# overlay.html, Edge'in uygulama penceresinde açılır; bu pencere başlığından bulunur ve Windows API ile
# her zaman üstte tutulur. Oyun modunda yarı saydam yapılır ve tıklamalar içinden geçer (WS_EX_TRANSPARENT);
# düzenleme modunda tam görünür ve tıklanabilir. Oyuna hiçbir şey enjekte edilmez, oyunun belleği okunmaz:
# sadece ayrı bir pencere üstte durur.
# Kısayollar (her yerde çalışır): Alt+Shift+O aç / gizle · Alt+Shift+T oyun modu ↔ düzenleme.
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class A2Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  struct RECT { public int L, T, R, B; }
  const int GWL_EXSTYLE = -20, WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20;
  static readonly IntPtr TOPMOST = new IntPtr(-1);

  // Başlığı `prefix` ile başlayan görünür Edge/Chromium penceresi
  public static IntPtr Find(string prefix) {
    IntPtr found = IntPtr.Zero;
    var sb = new StringBuilder(512); var cb = new StringBuilder(256);
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      sb.Length = 0; GetWindowText(h, sb, 512);
      if (!sb.ToString().StartsWith(prefix)) return true;
      cb.Length = 0; GetClassName(h, cb, 256);
      if (cb.ToString() != "Chrome_WidgetWin_1") return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  // Üstte tut + saydamlık + tıklama geçirgenliği
  public static void Apply(IntPtr h, byte alpha, bool clickThrough) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    int n = ex | WS_EX_LAYERED;
    if (clickThrough) n |= WS_EX_TRANSPARENT; else n &= ~WS_EX_TRANSPARENT;
    if (n != ex) SetWindowLong(h, GWL_EXSTYLE, n);
    SetLayeredWindowAttributes(h, 0, alpha, 2);
    SetWindowPos(h, TOPMOST, 0, 0, 0, 0, 0x1 | 0x2 | 0x10);   // NOSIZE | NOMOVE | NOACTIVATE
  }
  public static int[] Rect(IntPtr h) {
    RECT r;
    if (IsIconic(h) || !GetWindowRect(h, out r)) return null;
    return new int[] { r.L, r.T, r.R - r.L, r.B - r.T };
  }
  public static void Place(IntPtr h, int x, int y, int w, int hh) { SetWindowPos(h, TOPMOST, x, y, w, hh, 0x10); }
  public static void Hide(IntPtr h) { ShowWindow(h, 0); }
  public static void Show(IntPtr h) { ShowWindow(h, 4); }          // SW_SHOWNOACTIVATE
  public static void Front(IntPtr h) { SetForegroundWindow(h); }
  public static void Close(IntPtr h) { PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero); }
}

// Genel kısayol tuşları: basılanlar kuyruğa girer, zamanlayıcı okur.
public class A2Hot : NativeWindow {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  static readonly Queue<int> pressed = new Queue<int>();
  public A2Hot() { CreateHandle(new CreateParams()); }
  public bool Add(int id, uint mod, uint vk) { return RegisterHotKey(Handle, id, mod | 0x4000, vk); }   // 0x4000: basılı tutunca tekrarlama
  public void Clear() { for (int i = 1; i <= 8; i++) UnregisterHotKey(Handle, i); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x312) lock (pressed) pressed.Enqueue(m.WParam.ToInt32());
    base.WndProc(ref m);
  }
  public static int Next() { lock (pressed) return pressed.Count > 0 ? pressed.Dequeue() : 0; }
}
'@

$OvTitle = 'Karip Traker · Oyun içi'      # overlay.html <title> ile aynı olmalı
$OvUrl = "${AppUrl}overlay.html"
$script:Ov = @{ h = [IntPtr]::Zero; seekUntil = [datetime]::MinValue; placeAt = [datetime]::MinValue; target = $null; ghost = $false; hidden = $false; applyAt = [datetime]::MinValue; rect = ''; hotkeys = $null }

function Edge-Path {
  @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
function Ov-IsOpen { $script:Ov.h -ne [IntPtr]::Zero -and [A2Win]::IsWindow($script:Ov.h) }
function Ov-Alpha {
  $a = 0.7; if ($script:Settings.overlayAlpha) { $a = [double]$script:Settings.overlayAlpha }
  [byte][Math]::Round(255 * [Math]::Min(1.0, [Math]::Max(0.2, $a)))
}
function Ov-Rect {
  # Not: PowerShell değişken adları büyük/küçük harfe duyarsız ($W ile $w aynı) → ayrı adlar.
  $scrW = [A2Img]::ScreenW(); $scrH = [A2Img]::ScreenH()
  $r = @($script:Settings.overlayRect)
  if ($r.Count -eq 4 -and $r[2] -ge 200 -and $r[3] -ge 150 -and $r[0] -ge -50 -and $r[1] -ge -50 -and ($r[0] + 80) -le $scrW -and ($r[1] + 60) -le $scrH) { return [int[]]$r }
  $winW = [int]([Math]::Max(330, $scrW * 0.19)); $winH = [int]([Math]::Max(480, $scrH * 0.55))
  return [int[]]@(($scrW - $winW - 24), [int]($scrH * 0.30), $winW, $winH)   # sağda, mini haritanın altında
}
function Ov-Apply {
  if (-not (Ov-IsOpen) -or $script:Ov.hidden) { return }
  if ($script:Ov.ghost) { [A2Win]::Apply($script:Ov.h, (Ov-Alpha), $true) } else { [A2Win]::Apply($script:Ov.h, [byte]255, $false) }
  $script:Ov.applyAt = Get-Date
}
function Open-Overlay {
  if (Ov-IsOpen) { if ($script:Ov.hidden) { $script:Ov.hidden = $false; [A2Win]::Show($script:Ov.h); Ov-Apply }; return }
  $edge = Edge-Path
  if (-not $edge) { Log '✖ Oyun içi panel için Microsoft Edge bulunamadı.'; return }
  $r = Ov-Rect
  Start-Process $edge -ArgumentList "--app=$OvUrl", "--window-size=$($r[2]),$($r[3])", "--window-position=$($r[0]),$($r[1])"
  $script:Ov.seekUntil = (Get-Date).AddSeconds(20); $script:Ov.ghost = $false; $script:Ov.hidden = $false
}
function Toggle-Overlay {
  if (-not (Ov-IsOpen)) { Open-Overlay; return }
  if ($script:Ov.hidden) { $script:Ov.hidden = $false; [A2Win]::Show($script:Ov.h); Ov-Apply }
  else { $script:Ov.hidden = $true; [A2Win]::Hide($script:Ov.h) }
  Update-Tray
}
function Set-Ghost([bool]$on) {
  if (-not (Ov-IsOpen)) { Open-Overlay; return }
  $script:Ov.ghost = $on
  if ($script:Ov.hidden) { $script:Ov.hidden = $false; [A2Win]::Show($script:Ov.h) }
  Ov-Apply
  if (-not $on) { [A2Win]::Front($script:Ov.h) }
  Update-Tray
}
function Overlay-Object {
  [ordered]@{ open = [bool](Ov-IsOpen); ghost = [bool]$script:Ov.ghost; hidden = [bool]$script:Ov.hidden
    alpha = [double]((Ov-Alpha) / 255); hotkeys = $script:Ov.hotkeys }
}
function Overlay-Tick {
  for ($k = [A2Hot]::Next(); $k -ne 0; $k = [A2Hot]::Next()) {
    try { if ($k -eq 1) { Toggle-Overlay } elseif ($k -eq 2) { Set-Ghost (-not $script:Ov.ghost) } } catch { Log "✖ Oyun içi panel: $($_.Exception.Message)" }
  }
  if ($script:Ov.h -eq [IntPtr]::Zero) {
    if ((Get-Date) -lt $script:Ov.seekUntil) {
      $h = [A2Win]::Find($OvTitle)
      if ($h -ne [IntPtr]::Zero) {
        $script:Ov.h = $h; $script:Ov.seekUntil = [datetime]::MinValue
        $r = Ov-Rect; [A2Win]::Place($h, $r[0], $r[1], $r[2], $r[3]); $script:Ov.rect = ($r -join ',')
        $script:Ov.placeAt = (Get-Date).AddSeconds(6); $script:Ov.target = $r
        Ov-Apply; Update-Tray
        Log 'Oyun içi panel açıldı (Alt+Shift+T: oyun modu ↔ düzenleme, Alt+Shift+O: gizle/göster).'
      }
    }
    return
  }
  if (-not [A2Win]::IsWindow($script:Ov.h)) {
    $script:Ov.h = [IntPtr]::Zero; $script:Ov.ghost = $false; $script:Ov.hidden = $false
    Update-Tray; return
  }
  # Edge açılıştan birkaç saniye sonra pencereyi kendi hatırladığı yere taşıyabiliyor → bu sürede konumu koru.
  if ($script:Ov.placeAt -ne [datetime]::MinValue) {
    $t = $script:Ov.target; $r = [A2Win]::Rect($script:Ov.h)
    if ($r -and ($r[0] -ne $t[0] -or $r[1] -ne $t[1] -or $r[2] -ne $t[2])) { [A2Win]::Place($script:Ov.h, $t[0], $t[1], $t[2], $r[3]) }
    if ((Get-Date) -lt $script:Ov.placeAt) { return }
    $script:Ov.placeAt = [datetime]::MinValue
    $r = [A2Win]::Rect($script:Ov.h); if ($r) { $script:Ov.rect = ($r -join ',') }
  }
  if ($script:Ov.hidden -or ((Get-Date) - $script:Ov.applyAt).TotalSeconds -lt 2) { return }
  Ov-Apply   # Edge stilleri sıfırlarsa geri getir; tam ekran pencerelerin üstünde kalsın
  if (-not $script:Ov.ghost) {
    $r = [A2Win]::Rect($script:Ov.h)
    if ($r -and $r[0] -gt -10000 -and ($r -join ',') -ne $script:Ov.rect) {
      $script:Ov.rect = ($r -join ',')
      $script:Settings | Add-Member -NotePropertyName overlayRect -NotePropertyValue @($r) -Force
      Save-Settings $script:Settings
    }
  }
}

# ---------------------------------------------------------------- Uygulama penceresi
function Open-Panel {
  $edge = Edge-Path
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
    overlay = (Overlay-Object)
    log = @($script:LogLines | Select-Object -First 60)
  }
}

function Serve-Static($ctx, [string]$path) {
  $rel = [Uri]::UnescapeDataString($path.TrimStart('/'))
  if (-not $rel) { $rel = 'index.html' }
  if ($rel -match '\.\.' -or $rel -match '[:\\]') { return Send-Json $ctx 400 @{ error = 'Geçersiz yol' } }
  if (-not ($rel -eq 'index.html' -or $rel -eq 'overlay.html' -or $rel -like 'assets/*' -or $rel -eq 'data/data.json')) { return Send-Json $ctx 404 @{ error = 'Bulunamadı' } }
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
    'POST /api/overlay' {
      $b = Read-Body $ctx
      switch ([string]$b.action) {
        'toggle' { Toggle-Overlay }
        'open' { Open-Overlay }
        'ghost' { Set-Ghost (-not $script:Ov.ghost) }
        'close' { if (Ov-IsOpen) { [A2Win]::Close($script:Ov.h) } }
        'fit' {
          # Sayfa içeriğinin yüksekliğine otur (piksel). Konum ve genişlik aynı kalır.
          if (Ov-IsOpen) {
            $r = [A2Win]::Rect($script:Ov.h)
            if ($script:Ov.placeAt -ne [datetime]::MinValue) { $t = $script:Ov.target; $r = @($t[0], $t[1], $t[2], $(if ($r) { $r[3] } else { $t[3] })) }
            $hh = [int][Math]::Min([A2Img]::ScreenH() * 0.92, [Math]::Max(120, [double]$b.height))
            if ($r -and [Math]::Abs($r[3] - $hh) -gt 3) { [A2Win]::Place($script:Ov.h, $r[0], $r[1], $r[2], $hh) }
          }
        }
        'alpha' {
          $a = [double]$b.alpha
          if (-not ($a -ge 0.2 -and $a -le 1)) { return Send-Json $ctx 400 @{ error = 'Geçersiz saydamlık' } }
          if ([double]$script:Settings.overlayAlpha -ne $a) {
            $script:Settings | Add-Member -NotePropertyName overlayAlpha -NotePropertyValue $a -Force
            Save-Settings $script:Settings
          }
          if ($script:Ov.ghost) { Ov-Apply }
        }
        default { return Send-Json $ctx 400 @{ error = 'Bilinmeyen işlem' } }
      }
      return Send-Json $ctx 200 @{ ok = $true; overlay = (Overlay-Object) }
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
# Karip Traker logosu (assets/img/logo.png, 64 px'e küçültülmüş) — izleyici tek dosya çalışsın diye gömülü
$LogoPng = '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'
function New-TrayIcon {
  $ms = New-Object IO.MemoryStream (,[Convert]::FromBase64String($LogoPng))
  $src = New-Object Drawing.Bitmap $ms
  $bmp = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, 32, 32)
  $g.Dispose(); $src.Dispose()
  [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = New-TrayIcon
$menu = New-Object Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Paneli aç'); $miOpen.Font = New-Object Drawing.Font($miOpen.Font, [Drawing.FontStyle]::Bold)
$miPause = $menu.Items.Add('Duraklat')
$miTest = $menu.Items.Add('Ekranı şimdi oku')
[void]$menu.Items.Add('-')
$miOv = $menu.Items.Add('Oyun içi panel   (Alt+Shift+O)')
$miGhost = $menu.Items.Add('Oyun modu   (Alt+Shift+T)')
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
  $open = Ov-IsOpen
  $miOv.Text = $(if (-not $open) { 'Oyun içi paneli aç   (Alt+Shift+O)' } elseif ($script:Ov.hidden) { 'Oyun içi paneli göster   (Alt+Shift+O)' } else { 'Oyun içi paneli gizle   (Alt+Shift+O)' })
  $miGhost.Text = $(if ($script:Ov.ghost) { 'Düzenleme modu   (Alt+Shift+T)' } else { 'Oyun modu   (Alt+Shift+T)' })
  $miGhost.Enabled = $open
}

function Quit-App {
  $timer.Stop(); $httpTimer.Stop(); $ovTimer.Stop()
  try { $hot.Clear() } catch {}
  if (Ov-IsOpen) { [A2Win]::Close($script:Ov.h) }
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
$miOv.add_Click({ Toggle-Overlay })
$miGhost.add_Click({ Set-Ghost (-not $script:Ov.ghost) })

# ---------------------------------------------------------------- Başlat
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 150; $timer.Add_Tick({ Invoke-Tick })
$httpTimer = New-Object Windows.Forms.Timer; $httpTimer.Interval = 40; $httpTimer.Add_Tick({ Pump-Http })
$ovTimer = New-Object Windows.Forms.Timer; $ovTimer.Interval = 200; $ovTimer.Add_Tick({ Overlay-Tick })
$hot = New-Object A2Hot
$script:Ov.hotkeys = [bool]($hot.Add(1, 5, 0x4F) -and $hot.Add(2, 5, 0x54))   # Alt+Shift (5) + O / T
if (-not $script:Ov.hotkeys) { Log '… Alt+Shift+O / Alt+Shift+T kısayolları başka bir program tarafından kullanılıyor; oyun içi paneli simgeden aç.' }

Log "Uygulama başladı (v$Version). Ekran: $([A2Img]::ScreenW())x$([A2Img]::ScreenH()) · panel: $AppUrl$(if ($SiteDir) { ' (yerel dosyalar)' } else { '' })"
$s = Load-Session
if (-not $s -and $script:SessionError) { Log "Kayıtlı oturum okunamadı, panelde tekrar giriş yap: $($script:SessionError)" }
if ($s) { Set-Session $s $false $false }
Update-Tray
$timer.Start(); $httpTimer.Start(); $ovTimer.Start()
if (-not $env:A2_NO_PANEL) { Open-Panel }
[Windows.Forms.Application]::Run()
