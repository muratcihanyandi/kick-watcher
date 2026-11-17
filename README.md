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

### Adding accounts

- **Giriş Yap (recommended):** click the button on an account card → a fresh, isolated Brave window opens → log in → cookies are captured automatically. Logging out of the injected session inside that window lets you switch to another account; the capture follows whichever account ends up logged in.
- **Cookie paste:** in a private window, log in on kick.com, then either copy the whole `Cookie` request header, or export a `cookies.txt` (Netscape format) and paste its content.
- Never log out of the session you copied/exported — that invalidates the cookies immediately.

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
