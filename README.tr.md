# kick-watcher.

**kick-watcher.**, çok hesaplı, kendi sunucunda çalışan bir Kick.com drop izleyici ve otomatik ödül toplayıcıdır; hafif bir web panosuyla gelir. Her hesap için viewer websocket oturumunu canlı tutar, izlenen dakikaları sayar ve tamamlanan dropları otomatik açar — video oynatma yok, headless Chrome tarımı yok, minimum CPU.

> 🇬🇧 English docs: [README.md](README.md)

> ⚠️ **Uyarı** — Bu araç Kick'in resmi olmayan/internal uç noktalarını kullanır. Kick'in Hizmet Şartları'nı ihlal edebilir. Tüm risk kullanıcıdadır. Proje eğitim amaçlıdır.

## Özellikler

- **Sınırsız hesap** — cookie yapıştırma, Netscape `cookies.txt` aktarımı veya tek tıkla **izole Brave girişi** ile ekleme
- **Rastgele canlı yayın izleme** — her hesap Kick'in viewer websocket'ine (`websockets.kick.com`) bağlanır ve izleme eventi gönderir; kanallar canlı yayın listesinden rastgele seçilir, yayın bitince otomatik yeni kanala geçilir
- **Kanal zorlama** — bir yayıncı linki yapıştır, **tüm hesaplar aynı anda o kanalı izlesin**
- **Toplu takip** — tek butonla tüm hesaplar global hedef kanalı Kick'te takip eder
- **İzole Brave girişi** — her tıklamada sıfırdan atılabilir bir Brave profili açılır, hesabın cookie'leri içine enjekte edilir; pencere zaten giriş yapılmış şekilde açılır ve oturum CDP ile otomatik yakalanır
- **Otomatik drop açma** — ilerleme 5 dakikada bir sorgulanır (`web.kick.com/api/v1/drops/progress`) ve tamamlanan ödüller `POST /drops/claim` ile açılır — 180 dakikalık zamanlı kampanya kutuları dahil
- **Canlı pano** — hesap başına izlenen dakika, ödül ilerleme çubukları, ödül akışı, olay logları

## Kurulum

```bash
npm install
node server.js
```

Ardından **http://localhost:5178** adresini aç.

Giriş akışı Brave kullanır (standart Windows kurulum yollarından bulunur); **Giriş Yap** ile eklenen her hesap kendi izole profilinde açılır.

## Detaylı çalıştırma rehberi

### Kurulum

```bash
npm install
node server.js
```

Tarayıcıdan **http://localhost:5178** adresini aç. Karşına hesap panosu çıkacak.

### Cookie ile hesap ekleme

1. Kick'e girdiğin tarayıcıya şu eklentiyi kur:
   👉 [Get cookies.txt LOCALLY (Chrome Web Store)](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
2. Aynı tarayıcıda **kick.com'a giriş yap** (farm edeceğin hesapla).
3. Tarayıcının sağ üstündeki **eklenti simgesine** tıkla → açılan panelde **Copy** butonuna bas. Bu, o oturumun `cookies.txt` dosyasını (Netscape formatı) panoya kopyalar.
4. kick-watcher panosunda **"Hesap ekle"** kutusuna bu içeriği olduğu gibi yapıştır (Netscape formatı otomatik algılanır, dönüştürmene gerek yok) → **Ekle & İzlemeye Başla**'ya bas. Hesap doğrulanır ve hemen izlemeye başlar.
5. Her hesap için bu adımları tekrarla (her hesap için ayrı bir gizli pencere/farklı tarayıcı profili kullanman önerilir).

### Tüm hesapları bir yayıncıya yönlendirme

1. Panodaki **"Tüm hesapları bir kanala yönlendir"** kutusuna yayıncı linkini yapıştır (`https://kick.com/yayinci-adı`) veya sadece kullanıcı adını yaz.
2. **Hepsini Oraya Gönder**'e bas → **tüm hesaplar otomatik olarak o yayıncıyı izlemeye başlar**. Tek tek ayarlama gerekmez; izleme websocket bağlantısı saniyeler içinde kurulur.
3. İstersen **Takip Et**'e bas: tüm hesaplar o yayıncıyı Kick üzerinde takip eder de.
4. **Kaldır**'a basarsan hesaplar rastgele canlı yayınlara geri döner.
5. Yayıncı yayını kapatırsa hesaplar 60–90 saniye içinde otomatik tekrar bağlanmayı dener.

### Giriş Yap ile hesap ekleme (alternatif, en sağlam yol)

1. Herhangi bir hesap kartındaki **Giriş Yap** butonuna bas.
2. **Yeni ve izole bir Brave profili** açılır: hesabın mevcut cookie'si içine enjekte edilir, kick.com zaten giriş yapılmış şekilde açılır.
3. Cookie geçerliyse hiçbir şey yapmana gerek yok; pencereyi kapatabilirsin. Cookie ölmüşse pencerede elle giriş yap — oturum otomatik yakalanır.
4. Aynı hesaba tekrar tıklarsan eski pencere kapatılıp **yepyeni bir izole oturum** açılır; farklı hesaplar asla çakışmaz.

### Önemli uyarılar

- Cookie'sini kopyaladığın/export ettiğin oturumda **asla çıkış yapma** — çıkış anında cookie ölür. Pencereyi kapatmak yeterli.
- Kullandığın tarayıcı oturumu yenilerse (kick.com'da gezinmeye devam edersen) kopya cookie ölebilir. **Giriş Yap** akışı bu sorunu tamamen ortadan kaldırır.
- Kartta **"oturum ölü"** görünen hesabı dakikası kaybolmadan düzeltmek için: üstteki kutuya taze cookie'yi yapıştır → o kartın **Cookie Güncelle** butonuna bas (ya da **Giriş Yap**).

## Nasıl çalışır?

1. Cookie'lerle `POST https://websockets.kick.com/viewer/v1/token` → viewer WS token'ı alınır
2. `wss://websockets.kick.com/viewer/v1/connect?token=…` bağlantısı kurulur; 12 saniyede bir dönüşümlü `channel_handshake` / `ping`, 60 saniyede bir `tracking.user.watch.livestream` eventi gönderilir (ID'ler JSON **sayı** olmalı)
3. 5 dakikada bir `GET https://web.kick.com/api/v1/drops/progress` sorgulanır; `progress ≥ 1` ve `claimed = false` olan her ödül için `POST https://web.kick.com/api/v1/drops/claim` ile `{reward_id, campaign_id}` gönderilir

Kick'in Cloudflare yapısı isteklerin parmak izini alır: `Sec-Fetch-Site` başlığı origin/host ilişkisiyle uyuşmalı (`kick.com` için `same-origin`, `web.kick.com` için `same-site`), yoksa istekler 403 alır. Bu uygulama tarafından otomatik halledilir.

## Gizlilik

Tüm oturum cookie'leri, token'lar ve izlenen dakikalar senin makinende `data/` klasöründe kalır. Depo asla bunları içermez; `data/` varsayılan olarak gitignore'dadır.

## Lisans

[MIT](LICENSE)
