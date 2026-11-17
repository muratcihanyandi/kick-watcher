# kick-watcher.

**kick-watcher.** is a self-hosted, multi-account Kick.com drop watcher and auto-claimer with a lightweight web dashboard. It keeps viewer websocket sessions alive per account, tracks watch minutes, and automatically claims completed drops — no video playback, no headless Chrome farming, minimal CPU.

> ⚠️ **Disclaimer** — This tool uses Kick's internal/unofficial endpoints. Using it may violate Kick's Terms of Service. Use at your own risk. This project is for educational purposes.

## Features

- **Unlimited accounts** — add one per row via cookie paste, a Netscape `cookies.txt` export, or the one-click **isolated Brave login**
- **Random live-stream watching** — each account connects to Kick's viewer websocket (`websockets.kick.com`) and emits watch-tracking events; channels are picked randomly from the live directory, with automatic re-picking when a stream ends
- **Force channel** — paste a streamer link to point **every account at the same channel** at once
- **Follow-all** — one button makes every account follow the globally targeted channel
- **Isolated Brave login** — each click spawns a brand-new throwaway Brave profile with the account's cookies injected; the window opens already logged in and the session is captured back via CDP automatically
- **Auto-claim drops** — progress is polled every 5 minutes (`web.kick.com/api/v1/drops/progress`) and completed rewards are claimed via `POST /drops/claim` — including timed campaign rewards like the 180-minute boxes
- **Live dashboard** — Turkish UI: per-account watch minutes, reward progress bars, claim feed, event log

## How it works

1. `POST https://websockets.kick.com/viewer/v1/token` with the session cookies → viewer WS token
2. Connect to `wss://websockets.kick.com/viewer/v1/connect?token=…` and send `channel_handshake` / `ping` alternating every 12 s, plus a `tracking.user.watch.livestream` user event every 60 s (IDs must be JSON **numbers**)
3. Poll `GET https://web.kick.com/api/v1/drops/progress` every 5 min; for every reward with `progress ≥ 1` and `claimed = false`, `POST https://web.kick.com/api/v1/drops/claim` with `{reward_id, campaign_id}`

Kick's Cloudflare setup fingerprints requests: the `Sec-Fetch-Site` header must match the origin/host relationship (`same-origin` for `kick.com`, `same-site` for `web.kick.com`), otherwise requests get 403'd. This is handled automatically.

## Setup

```bash
npm install
node server.js
```

Then open **http://localhost:5178**

Brave is used for the login flow (it is located at the standard Windows install paths); any account you add via **Giriş Yap** opens in its own isolated profile.

## Detailed usage guide (Türkçe rehber aşağıda)

### Step-by-step

1. **Install & run**

   ```bash
   npm install
   node server.js
   ```

   Open **http://localhost:5178** — the dashboard is ready.

2. **Install the cookie-export extension** in the browser you use for Kick:
   👉 [Get cookies.txt LOCALLY (Chrome Web Store)](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)

3. **Log in to kick.com** in that same browser with the Kick account you want to farm.

4. **Export the cookies:** click the extension's icon in the toolbar → its panel opens → click **Copy**. This copies a Netscape-format `cookies.txt` of the current session to your clipboard.

5. **Paste into kick-watcher:** in the dashboard, drop the copied text into the **"Hesap ekle"** textarea (Netscape format is auto-detected) → click **Ekle & İzlemeye Başla**. The account authenticates and starts watching immediately.

6. **Point everyone at one streamer (optional):** paste a streamer link (`https://kick.com/<name>`) or just the username into **"Tüm hesapları bir kanala yönlendir"** → click **Hepsini Oraya Gönder**. **All accounts automatically start watching that channel** — no per-account action needed. Click **Takip Et** if you also want every account to *follow* that channel on Kick; click **Kaldır** to release them back to random live streams.

7. Repeat steps 3–5 for every account (one browser/private window per account).

### Important notes

- **Never log out** of a session whose cookies you copied/exported — logging out kills the cookies instantly. Close the window instead.
- If Kick refreshes the session while you keep using that browser, the copy can die. The one-click **Giriş Yap** flow (isolated Brave profile, cookies injected via CDP) avoids this entirely.
- An account that shows **"oturum ölü"** can be fixed without losing its watch minutes: paste a fresh cookie into the top box and click **Cookie Güncelle** on that card, or use its **Giriş Yap** button.

---

## Türkçe çalıştırma rehberi

### Kurulum

```bash
npm install
node server.js
```

Tarayıcıdan **http://localhost:5178** adresini aç. Karşına hesap panosu çıkacak.

### Cookie ile hesap ekleme

1. Kick'e girdiğin tarayıcıya şu eklentiyi kur:
   👉 [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
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

### Önemli uyarılar

- Cookie'sini kopyaladığın/export ettiğin oturumda **asla çıkış yapma** — çıkış anında cookie ölür. Pencereyi kapatmak yeterli.
- Kullandığın tarayıcı oturumu yenilerse (kick.com'da gezinmeye devam edersen) kopya cookie ölebilir. Bunun için panolardaki **Giriş Yap** butonu en sağlam yol: her tıklamada **yeni ve izole bir Brave profili** açılır, hesap cookie'si içine enjekte edilir, pencere zaten giriş yapılmış şekilde açılır ve oturum otomatik yakalanır.
- Kartta **"oturum ölü"** görünen hesabı dakikası kaybolmadan düzeltmek için: üstteki kutuya taze cookie'yi yapıştır → o kartın **Cookie Güncelle** butonuna bas (ya da **Giriş Yap**).

## Configuration

| Setting | Where | Default |
|---|---|---|
| Port | `PORT` env or `server.js` | `5178` |
| Accounts store | `data/accounts.json` (contains session cookies — never commit) | auto-created |
| Global force channel | dashboard → "Tüm hesapları bir kanala yönlendir" | off |

## Project layout

```
server.js         Express app: REST API + dashboard, per-account workers
worker.js         Watch loop: channel picking, WS keepalive, progress polling, claims
kick.js           Kick API helpers (auth, campaigns, progress, claim, follow, viewer token)
login-session.js  Isolated Brave login sessions with CDP cookie capture/injection
public/           Dashboard UI
data/             Local state (gitignored — contains cookies)
```

## Privacy

All session cookies, tokens and watched minutes stay in `data/` on your machine. The repository never includes them; `data/` is gitignored by default.

## License

[MIT](LICENSE)
