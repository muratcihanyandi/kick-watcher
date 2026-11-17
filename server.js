// kick-watcher: multi-account Kick drops watcher + auto-claimer.
// Run: node server.js  → http://localhost:5178
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccountWorker } from './worker.js';
import { normalizeCookieInput, followChannel } from './kick.js';
import { LoginSession } from './login-session.js';
import { parseCookieHeader } from './kick.js';

function parseCookiePairs(header) {
  try {
    return Object.entries(parseCookieHeader(header ?? '')).map(([name, value]) => ({ name, value }));
  } catch { return []; }
}

function authFingerprint(cookieHeader) {
  const pairs = parseCookieHeader(cookieHeader ?? '');
  return [pairs.kick_session ?? '', pairs.session_token ?? ''].join('|');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5178;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = {
  data: { accounts: [], logs: [], forceChannel: null },
  load() {
    if (fs.existsSync(DATA_FILE)) {
      try { this.data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* fresh */ }
    }
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    if (!Array.isArray(this.data.logs)) this.data.logs = [];
  },
  save() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 1));
  },
};
store.load();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const workers = new Map();
const loginSessions = new Map(); // accountId -> LoginSession (latest)

const LOGIN_PROFILES_DIR = path.join(DATA_DIR, 'login-profiles');

function log(msg) {
  const line = { at: new Date().toISOString(), msg };
  store.data.logs.unshift(line);
  store.data.logs = store.data.logs.slice(0, 200);
  store.save();
  console.log(msg);
}

function sanitized(acc) {
  const { cookieHeader, ...rest } = acc;
  return { ...rest, cookiePreview: cookieHeader ? cookieHeader.slice(0, 48) + '…' : null };
}

function startWorker(acc) {
  let w = workers.get(acc.id);
  if (w) w.stop();
  w = new AccountWorker(acc, store, log);
  workers.set(acc.id, w);
  w.start();
}

// restore + start persisted accounts
for (const acc of store.data.accounts) {
  if (acc.enabled !== false) startWorker(acc);
}

// --- API -------------------------------------------------------------------

app.get('/api/state', (req, res) => {
  res.json({
    accounts: store.data.accounts.map((a) => ({ ...sanitized(a), running: workers.has(a.id) })),
    logs: store.data.logs.slice(0, 60),
    forceChannel: store.data.forceChannel,
    now: new Date().toISOString(),
  });
});

// Extract a channel slug from a kick.com URL or bare username.
function extractSlug(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const m = s.match(/kick\.com\/([A-Za-z0-9_.-]+)/i);
  let slug = m ? m[1] : s.split(/[/?\s]/)[0];
  if (/^(video|clip|category|search|drops)(\/|$)/i.test(slug)) return '';
  return slug.replace(/^@/, '').toLowerCase();
}

app.post('/api/force', (req, res) => {
  const { channel } = req.body ?? {};
  const slug = extractSlug(channel);
  if (channel && channel.trim() && !slug) {
    return res.status(400).json({ error: 'Kanal bulunamadı. kick.com linki veya kullanıcı adı gir.' });
  }
  store.data.forceChannel = slug || null;
  store.save();
  log(slug ? `Tüm hesaplar ${slug} izlemeye yönlendirildi` : 'Kanal zorlaması kaldırıldı');
  for (const w of workers.values()) w.reselect();
  res.json({ ok: true, forceChannel: store.data.forceChannel });
});

app.post('/api/accounts', async (req, res) => {
  const { cookie, label } = req.body ?? {};
  if (!cookie || typeof cookie !== 'string') {
    return res.status(400).json({ error: "Geçersiz cookie. Cookie satırını veya cookies.txt içeriğini yapıştır." });
  }
  // normalize: accept Cookie header paste or Netscape cookies.txt export
  const cookieHeader = normalizeCookieInput(cookie);
  if (!cookieHeader.includes('kick_session=')) {
    return res.status(400).json({ error: "Cookie içinde 'kick_session' bulunamadı." });
  }
  const id = 'acc_' + crypto.randomBytes(9).toString('hex');
  const acc = {
    id, label: label?.trim() || null, cookieHeader,
    enabled: true, status: 'starting', username: null, minutesWatched: 0,
    channel: null, rewards: [], claims: [], addedAt: new Date().toISOString(),
  };
  store.data.accounts.push(acc);
  store.save();
  startWorker(acc);
  res.json({ ok: true, id });
});

app.post('/api/accounts/:id/stop', (req, res) => {
  const w = workers.get(req.params.id);
  const acc = store.data.accounts.find((a) => a.id === req.params.id);
  if (acc) acc.enabled = false;
  if (w) w.stop();
  workers.delete(req.params.id);
  store.save();
  res.json({ ok: true });
});

app.post('/api/accounts/:id/start', (req, res) => {
  const acc = store.data.accounts.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'hesap yok' });
  acc.enabled = true;
  store.save();
  startWorker(acc);
  res.json({ ok: true });
});

// Launch a fresh isolated Brave window for this account's login. Every click
// starts a brand-new throwaway profile; once the user logs in, the session
// cookies are captured via CDP and bound to the account (and refreshed while
// the window stays open).
app.post('/api/accounts/:id/login', (req, res) => {
  const acc = store.data.accounts.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'hesap yok' });
  const prev = loginSessions.get(acc.id);
  if (prev) prev.stop();

  let lastAuthFp = authFingerprint(acc.cookieHeader);
  const session = new LoginSession(acc.id, LOGIN_PROFILES_DIR, store, log, (cookieHeader, ua, user) => {
    // capture / refresh: react only when the AUTH cookies changed — CF cookies
    // (__cf_bm etc.) churn constantly while the login window is open.
    const fp = authFingerprint(cookieHeader);
    if (fp === lastAuthFp && acc.username === user.username) return;
    lastAuthFp = fp;
    acc.cookieHeader = cookieHeader;
    acc.ua = ua;
    acc.username = user.username;
    acc.userId = user.id;
    acc.enabled = true;
    acc.status = 'active';
    acc.error = null;
    store.save();
    log(`[${user.username}] giriş yakalandı (${acc.id.slice(0, 12)}) — hesap güncellendi ve izlemeye başlıyor`);
    startWorker(acc);
  }, parseCookiePairs(acc.cookieHeader));
  if (!session.start()) {
    return res.status(500).json({ error: 'Brave bulunamadı. Brave kurulu mu?' });
  }
  loginSessions.set(acc.id, session);
  res.json({ ok: true, note: 'Brave penceresinde o hesaba giriş yap; cookie otomatik yakalanacak.' });
});

// Make every authenticated account follow the globally forced channel.
app.post('/api/follow', async (req, res) => {
  const slug = store.data.forceChannel;
  if (!slug) return res.status(400).json({ error: 'Önce bir kanal seç ("Hepsini Oraya Gönder") — takip edilecek global yayıncı yok.' });
  const results = [];
  for (const acc of store.data.accounts) {
    if (!acc.username || acc.enabled === false) { results.push({ username: acc.username ?? acc.id.slice(0, 10), ok: false, note: 'oturum yok' }); continue; }
    const r = await followChannel(acc.cookieHeader, acc.ua, slug).catch((e) => ({ ok: false, status: 0, text: e.message }));
    const already = r.text?.includes('already following');
    results.push({ username: acc.username, ok: r.ok || already, status: r.status, note: r.ok ? 'takip edildi' : (already ? 'zaten takipte' : r.text) });
    log(`[${acc.username}] ${slug} takip: ${r.ok ? '✓' : `✗ (${r.status})`}`);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // pacing between accounts
  }
  store.save();
  res.json({ ok: true, slug, results });
});

app.post('/api/accounts/:id/cookie', (req, res) => {
  const acc = store.data.accounts.find((a) => a.id === req.params.id);
  const { cookie } = req.body ?? {};
  if (!acc || !cookie) {
    return res.status(400).json({ error: 'geçersiz istek' });
  }
  const cookieHeader = normalizeCookieInput(cookie);
  if (!cookieHeader.includes('kick_session=')) {
    return res.status(400).json({ error: "Cookie içinde 'kick_session' bulunamadı." });
  }
  acc.cookieHeader = cookieHeader;
  acc.minutesWatched = acc.minutesWatched ?? 0;
  acc.enabled = true;
  store.save();
  startWorker(acc); // fresh worker revalidates and restarts watching
  res.json({ ok: true });
});

app.post('/api/accounts/:id/check', async (req, res) => {
  const w = workers.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'çalışan hesap yok' });
  await w.checkProgress().catch((e) => log(`[check] ${e.message}`));
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', (req, res) => {
  const idx = store.data.accounts.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'hesap yok' });
  const w = workers.get(req.params.id);
  if (w) w.stop();
  workers.delete(req.params.id);
  loginSessions.get(req.params.id)?.stop();
  loginSessions.delete(req.params.id);
  store.data.accounts.splice(idx, 1);
  store.save();
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  log(`kick-watcher hazır: http://localhost:${PORT}`);
});
