# AION 2 Takip

AION 2 (Global EU, Siel) karakterleri için iki kişilik takip sitesi. GitHub Pages üzerinde çalışır, sunucu tarafı yoktur.

- **Giriş:** site kullanıcı adı ve şifreyle açılır. Giriş yapan iki hesap da tam yetkilidir. Arkadaşının GitHub hesabına gerek yoktur.
- **Kartlar:** sınıf, seviye, item level, combat power ve Odyle Energy paneli. Karta tıklayınca Gear / Arcana / Skill penceresi açılır.
- **Karşılaştırma:** item level, combat power, seviye ya da enerjiye göre sıralama ve slot slot gear karşılaştırması
- **Enerji:** elle girilir, site "şu an ~X" ve "full'e Y saat" değerlerini canlı hesaplar. Full olan kart kırmızı, full'e yakın olan turuncu görünür.
- **Gear verisi:** GitHub Actions günde 3 kez resmi siteden çeker. İstenirse sitedeki "Şimdi güncelle" butonuyla elle de tetiklenir.

```
index.html                     Sayfa (giriş ekranı + uygulama)
assets/css/style.css           Koyu tema
assets/js/app.js               Yükleme, giriş, kaydetme, hesap kurulumu, workflow tetikleme
assets/js/auth.js              Şifreli token, giriş ve oturum
assets/js/render.js            Kartlar, pencereler, tablolar
assets/js/energy.js            Enerji hesabı
assets/js/github.js            GitHub API
assets/js/merge.js             Kaydetme çakışmasında birleştirme
data/data.json                 Tüm veri + şifreli hesaplar (auth)
scripts/fetch-characters.mjs   Gear çeken script (Node 20+, bağımlılık yok)
.github/workflows/update.yml   Zamanlanmış gear güncellemesi
```

---

## Güvenlik nasıl çalışır?

Site statik olduğu için şifreler bir sunucuda kontrol edilemez. Bunun yerine:

1. Site sahibi bu repoya yazabilen **tek bir GitHub token'ı** oluşturur.
2. **Hesap kurulumu** ekranında token, her hesabın şifresiyle tarayıcıda **ayrı ayrı şifrelenir** (PBKDF2-SHA256 600.000 tur + AES-GCM 256).
3. `data.json` dosyasına sadece şifreli haller yazılır. Gerçek token ve şifreler hiçbir yerde saklanmaz.
4. Giriş yapan kişinin şifresi doğruysa token tarayıcıda çözülür ve kayıtlar bu token'la yapılır. Yanlışsa çözülemez, kimse yazamaz.

Bilmen gerekenler:

- **Şifreler güçlü olmalı:** en az 12 karakter ve rastgele. Şifreli kayıt herkese açık durduğu için zayıf bir şifre deneme yanılmayla kırılabilir. Güçlü bir şifreyle bu pratikte mümkün değil.
- **Giriş ekranı görüntülemeyi gizler ama veri teknik olarak okunabilir.** Repo public olduğu için `data.json` doğrudan açılabilir. İçindeki oyun verisi resmi sitede zaten herkese açık. Enerji değerleri de görülebilir ama **değiştirilemez**.
- **Kayıt geçmişi:** commit'ler GitHub'da senin hesabınla görünür. Kimin kaydettiği commit mesajında site kullanıcı adıyla yazar, ör. `Enerji: Kyrakia 0+1710 (ali)`.
- **"Beni bu cihazda hatırla":** işaretlenirse çözülmüş token o tarayıcıda kalır. İşaretlenmezse sekme kapanınca silinir. Ortak bilgisayarda işaretleme ve işin bitince ⚙ → **Çıkış yap**.

---

## 1. Repoyu oluşturma

1. GitHub'da sağ üstteki **+** → **New repository**:
   - Ad: örn. `aion2-takip`
   - **Public** (ücretsiz planda Pages için gerekli)
   - README ekleme (bu klasörde zaten var).
2. Dosyaları yükle. Bu klasörde terminal açıp:

   ```bash
   git init -b main
   git add .
   git commit -m "İlk sürüm"
   git remote add origin https://github.com/KULLANICI_ADIN/aion2-takip.git
   git push -u origin main
   ```

   Git kullanmak istemiyorsan GitHub'da **Add file → Upload files** ile tüm klasörü sürükleyip bırakabilirsin. `.github` klasörünün de yüklendiğinden emin ol.

## 2. GitHub Pages'i açma

1. Repo → **Settings → Pages**.
2. **Source:** "Deploy from a branch". **Branch:** `main`, klasör: `/ (root)` → **Save**.
3. 1-2 dakika sonra adres görünür: `https://KULLANICI_ADIN.github.io/aion2-takip/`

## 3. Token oluşturma (sadece site sahibi)

1. GitHub → sağ üst profil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Ayarlar:
   - **Token name:** `aion2-takip`
   - **Expiration:** en fazla 1 yıl. Süresi dolunca 4. adımı yeni token'la tekrarlarsın.
   - **Repository access:** *Only select repositories* → `aion2-takip`
   - **Permissions → Repository permissions:**
     - **Contents:** Read and write
     - **Actions:** Read and write
     - (Metadata: Read-only otomatik eklenir)
3. **Generate token** → `github_pat_…` ile başlayan değeri kopyala. Bu değer bir daha gösterilmez, ama saklamana da gerek yok. 4. adımda şifrelenip repoya yazılacak.

## 4. Hesapları kurma

1. Pages adresini aç. Henüz hesap olmadığı için site salt okunur açılır.
2. ⚙ → **Hesap kurulumu**:
   - Token'ı yapıştır. Repo sahibi ve adı Pages adresinden otomatik dolar.
   - Hesap satırlarına kullanıcı adı ve şifre yaz: biri senin, biri arkadaşının. Büyük/küçük harf fark etmez.
   - **Şifrele ve kaydet** → "✔ 2 hesap kaydedildi" yazısını görmelisin.
3. Artık site giriş ekranıyla açılır.
4. **Arkadaşına sadece site linkini, kullanıcı adını ve şifresini ver.** GitHub hesabı gerekmez.

**Hesap eklemek, şifre değiştirmek ya da token yenilemek:** girişten sonra ⚙ → **Hesap kurulumu** ya da giriş ekranındaki "Hesap kurulumu" bağlantısı. Kaydedince tüm hesaplar bu listeyle değiştirilir. Bu yüzden tüm hesapların şifrelerini yeniden girmen gerekir. Token gerektiği için bunu sadece site sahibi yapabilir.

## 5. Kullanım

- **Enerji girme:** Odyle Energy iki ayrı satırda tutulur:
  - **Zamanla:** kendiliğinden dolan kısım (max 840). "Full'e kalan süre" ve kırmızı/turuncu vurgular sadece bu kısma göre hesaplanır.
  - **Ek (+):** sizin eklediğiniz kısım. Zamanla değişmez, max'a sayılmaz.

  Kutuya oyundaki değeri yaz ve Enter'a bas, ya da −/+ butonlarını kullan. Harcadığında oyunda hangi kısım düştüyse o satırdan düş. Altta **Toplam** görünür. Değişen kartta "● kaydedilmedi" yazar.
- **Kaydet (N):** bekleyen tüm değişiklikleri tek commit olarak `data.json`'a yazar. O sırada arkadaşın ya da Actions dosyayı değiştirmişse site güncel dosyayı çeker, sadece senin değiştirdiğin enerji değerlerini üstüne uygular ve tekrar dener. Aynı karakteri arkadaşın senden *sonra* düzenlediyse onun değeri kalır.
- Kaydetmeden sayfayı kapatırsan değişiklikler o tarayıcıda saklı kalır. Tarayıcı ayrıca uyarı da verir.
- **Şimdi güncelle:** gear çekme işini (workflow) tetikler ve durumunu gösterir (Sırada → Çalışıyor → bitti). Bitince veriyi kendiliğinden yeniden yükler.
- **Karakter penceresi:** kartın üst kısmına ya da **Detay ›** butonuna tıkla. Üç sekme var:
  - **Gear:** silah ve zırh, rün, aksesuar, kanat ve pet
  - **Arcana:** 5 arcana, statları ve ek skilleri
  - **Skill:** aktif, pasif ve DP skilleri. Takılı olanlar yeşil kenarlı, öğrenilmemişler soluk.

  Bağlantı: `…/#char/kyrakia/skills`
- **Eşya detayı:** penceredeki ya da karşılaştırma tablosundaki bir parçaya tıkla (klavyede Enter). Ana statlar, ek statlar ve skiller, set bonusu, büyü taşları ve tanrı taşı görünür. ‹ › butonları ya da ok tuşlarıyla parçalar arasında gezebilirsin. Bağlantı: `…/#item/kyrakia/0`.
- **Ayarlar dosyası:** `data/data.json` içindeki `config` bölümü:
  ```json
  "energy": { "name": "Odyle Energy", "max": 840, "regenAmount": 15, "regenMinutes": 180, "tickAnchorUtc": null, "steps": [10, 40], "bonusSteps": [10, 40] },
  "nearFullHours": 3
  ```
  - `max`, `regenAmount`, `regenMinutes`: doğal enerji sınırı ve dolum hızı. Topluluk kaynaklarına göre dolum 3 saatte 15, sınır aboneliksiz 560, abonelikle 840 (ek enerji dahil toplam en fazla 2000).
  - `tickAnchorUtc`: oyunda enerji sabit saatlerde geliyorsa bir tik anı yaz, örn. `"2026-01-01T00:00:00Z"`. Böylece "sonraki +15" süresi tam doğru olur. Boş bırakılırsa tikler değerin girildiği andan itibaren sayılır.
  - `steps` / `bonusSteps`: "Zamanla" ve "Ek (+)" satırlarındaki +/− butonlarının miktarları.
  - `nearFullHours`: kaç saat kala turuncu vurgunun başlayacağı.
- **Karakter ayarları** (`characters` içinde, karakter başına):
  - `"owner": "Ali"` → kartta isim etiketi görünür.
  - `"energyMax": 560` → aboneliği olmayan karakter için doğal enerji sınırı.
  - `"fetch": false` → bu karakter otomatik çekilmez.
- Enerji resmi sitede herkese açık değil. Bu yüzden otomatik çekilemez, oyundan bakıp elle girilir.

## 6. Gear otomatik güncelleme ve yeni karakter ekleme

`scripts/fetch-characters.mjs` resmi karakter sayfasının kullandığı uç noktalarla çalışır:

| Amaç | Adres |
|---|---|
| Sunucu listesi | `aion2.plaync.com/api/gameinfo/servers?region=eu` |
| Karakter arama | `api-search.plaync.com/aion2global/search/v2/character?keyword=…&serverId=1301&region=eu` |
| Profil, item level, combat power | `aion2.plaync.com/api/character/info?characterId=…&serverId=…` |
| Ekipman, skill, pet ve kanat | `aion2.plaync.com/api/character/equipment?characterId=…&serverId=…` |
| Parça detayı (stat, skill, set, taşlar) | `aion2.plaync.com/api/character/equipment/item?id=…&enchantLevel=…` |

- Karakter **adıyla, ayarlardaki sunucuda (Siel = 1301)** aranır. Bulunan kimlik `ref` alanına kaydedilir, sonraki çalıştırmalarda arama yapılmaz.
- Parça detayları her çalıştırmada yeniden çekilir, çünkü ek statlar ve taşlar aynı eşyada da değişebilir. İstekler dörder dörder paralel atılır, bir karakter yaklaşık 7 saniye sürer.
- Script `energy` ve `auth` alanlarına dokunmaz. Değişiklik yoksa commit atılmaz.
- Başarıyla çekilen karakterin "örnek veri" etiketi kendiliğinden kalkar.

**Yeni karakter eklemek ya da beklemedekini açmak:** `data/data.json` içinde karakterin `name` alanı oyundakiyle birebir aynı olmalı. `"fetch": false` satırını sil. Ya da kendi bilgisayarında hemen dene (Node 20+):

```bash
node scripts/fetch-characters.mjs --only Kyrakia            # çek ve data.json dosyasına yaz
node scripts/fetch-characters.mjs --dry-run --only Kyrakia  # sadece göster, dosyaya yazma
node scripts/fetch-characters.mjs                           # "fetch": false olmayan herkesi güncelle
```

## 7. İlk çalıştırma kontrol listesi

1. Pages adresini aç. Kyrakia gerçek veriyle, diğerleri "örnek veri" etiketiyle salt okunur görünmeli.
2. ⚙ → **Hesap kurulumu** → token ve iki hesap → kaydet. Repoda "Hesaplar güncellendi (2 hesap)" commit'i görünmeli.
3. Giriş yap. Sağ üstte "Giriş: kullanıcıadın" yazmalı.
4. Bir karta enerji gir → **Kaydet** → repoda "Enerji: … (kullanıcıadın)" commit'i görünmeli.
5. **Şimdi güncelle** butonuna bas. Repo → **Actions** sekmesinde iş çalışmalı ve yeşil bitmeli.
6. Arkadaşın kendi kullanıcı adı ve şifresiyle giriş yapabilmeli.

## Lokal test

`index.html` dosyasına çift tıklayarak açarsan tarayıcı `data.json`'u okumaz (`file://` kısıtı). Klasörde basit bir sunucu başlat:

```bash
npx serve .            # ya da
python -m http.server 8000
```

Sonra `http://localhost:8000` adresini aç. Giriş ve şifreleme localhost'ta da çalışır.

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Kullanıcı adı ya da şifre hatalı" | Kullanıcı adını ve şifreyi kontrol et. Hesap yeni kurulduysa Pages kopyası birkaç dakika eski olabilir, biraz bekleyip sayfayı yenile. |
| "Oturum geçersiz: GitHub token'ının süresi dolmuş…" | Token'ın süresi dolmuş ya da silinmiş. Site sahibi yeni token oluşturup **Hesap kurulumu**'nu tekrarlamalı. |
| Hesap kurulumunda "yazma yetkisi yok" | Token'da *Contents: Read and write* yok, ya da token başka bir repo için oluşturulmuş. |
| "Şimdi güncelle" 403/404 | Token'da *Actions: Read and write* yok, ya da `.github/workflows/update.yml` repoda değil. |
| "Tarayıcı şifrelemeyi desteklemiyor" | Site `https://` (GitHub Pages) ya da `localhost` üzerinden açılmalı. |
| Değişiklik birkaç dakika görünmüyor | Girişten önce veri Pages önbelleğinden gelir (≈10 dk). Giriş yapınca veri doğrudan GitHub API'den gelir. |
| Actions'ta "JSON yerine HTML döndü" | Resmi site GitHub sunucularından gelen isteği engelliyor olabilir. Bana haber ver, başka bir yol bakarız. |
| Zamanlanmış iş çalışmıyor | GitHub, 60 gün commit olmayan repolarda cron'u durdurur. Actions sekmesinden tekrar etkinleştir. |
