// Isolated Brave login session: launches a fresh Brave profile per click,
// exposes CDP, polls kick.com cookies until the user logs in, then feeds the
// captured cookie header (+ browser UA) back to the account.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { getUser } from './kick.js';

const BRAVE_CANDIDATES = [
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  String(process.env.LOCALAPPDATA ?? '') + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];

export function findBrave() {
  for (const p of BRAVE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

export class LoginSession {
  /**
   * @param accountId  account the captured login belongs to
   * @param profilesDir base dir for throwaway profiles
   * @param store persistent store
   * @param log logger fn
   * @param onAuthed (cookieHeader, ua, user) => void — called on every capture
   */
  /**
   * @param initialCookies [{name,value}] auth cookies to inject so the
   *        isolated Brave window opens already logged in (if still valid).
   */
  constructor(accountId, profilesDir, store, log, onAuthed, initialCookies = []) {
    this.accountId = accountId;
    this.profilesDir = profilesDir;
    this.store = store;
    this.log = log;
    this.onAuthed = onAuthed;
    this.initialCookies = initialCookies;
    this.stopped = false;
    this.child = null;
    this.port = 9400 + Math.floor(Math.random() * 400);
    this.hadCdp = false;
    this.injected = false;
    this.giveUpTimer = setTimeout(() => this.stop('zaman aşımı (30 dk)'), 30 * 60_000);
  }

  start() {
    const brave = findBrave();
    if (!brave) {
      this.log(`[${this.accountId}] Brave bulunamadı — giriş penceresi açılamadı`);
      return false;
    }
    const profileDir = path.join(this.profilesDir, `${this.accountId}-${Date.now()}`);
    fs.mkdirSync(profileDir, { recursive: true });
    this.child = spawn(brave, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      'about:blank', // navigated to kick.com after cookie injection
    ], { stdio: 'ignore', detached: false });
    this.child.unref();
    const hasCookie = this.initialCookies.some((c) => c.name === 'kick_session');
    this.log(`[${this.accountId}] izole Brave açıldı (profil: ${path.basename(profileDir)}) — ${hasCookie ? 'mevcut cookie ile otomatik giriş deneniyor' : 'kick.com giriş bekleniyor'}`);
    this.pollLoop();
    return true;
  }

  reason() { return 'kullanıcı kapatmıştır'; }

  async pollLoop() {
    let failures = 0;
    while (!this.stopped) {
      await this.sleep(4000);
      if (this.stopped) break;
      try {
        const info = await this.cdpVersion();
        this.hadCdp = true;
        failures = 0;
        if (!this.injected) {
          await this.injectCookies(info.webSocketDebuggerUrl);
          this.injected = true;
        }
        const cookies = await this.cdpCookies(info.webSocketDebuggerUrl);
        const pairs = [];
        let kickSession = null;
        for (const c of cookies) {
          if (!/kick\.com$/i.test(String(c.domain).replace(/^\./, ''))) continue;
          pairs.push(`${c.name}=${c.value}`);
          if (c.name === 'kick_session') kickSession = c.value;
        }
        if (!kickSession || !pairs.length) continue;
        const cookieHeader = pairs.join('; ');
        const user = await getUser(cookieHeader, info.userAgent).catch(() => null);
        if (user) {
          this.onAuthed(cookieHeader, info.userAgent, user);
        }
      } catch (e) {
        failures++;
        // 3 consecutive CDP failures after a working session = window closed
        if (this.hadCdp && failures >= 3) {
          this.log(`[${this.accountId}] giriş penceresi kapatıldı`);
          this.stop();
          return;
        }
        // if CDP never came up in ~3 minutes, launch likely failed
        if (!this.hadCdp && failures >= 45) {
          this.log(`[${this.accountId}] Brave CDP bağlantısı kurulamadı`);
          this.stop();
          return;
        }
      }
    }
  }

  async cdpVersion() {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
    if (!r.ok) throw new Error(`cdp ${r.status}`);
    return r.json();
  }

  // Inject the account's auth cookies into the fresh profile, then open
  // kick.com. Only auth-relevant cookies are injected: cf_clearance/__cf_bm
  // are bound to a different browser's UA and would just trigger a 403;
  // Brave negotiates its own Cloudflare clearance on first load.
  injectCookies(wsUrl) {
    const authCookies = this.initialCookies
      .filter((c) => ['kick_session', 'session_token', 'XSRF-TOKEN'].includes(c.name))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: '.kick.com',
        path: '/',
        secure: true,
        httpOnly: c.name === 'kick_session' || c.name === 'session_token',
        sameSite: 'Lax',
      }));
    return this.cdpCommand(wsUrl, { id: 1, method: 'Storage.setCookies', params: { cookies: authCookies } })
      .then(() => this.cdpCommand(wsUrl, { id: 2, method: 'Target.createTarget', params: { url: 'https://kick.com/' } }));
  }

  cdpCommand(wsUrl, cmd) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } reject(new Error('cdp timeout')); }, 6000);
      ws.on('open', () => ws.send(JSON.stringify(cmd)));
      ws.on('message', (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.id === cmd.id) {
          clearTimeout(t);
          try { ws.close(); } catch { /* ignore */ }
          if (msg.error) reject(new Error(msg.error.message ?? 'cdp error'));
          else resolve(msg.result);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  cdpCookies(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } reject(new Error('cdp timeout')); }, 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
      });
      ws.on('message', (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.id === 1) {
          clearTimeout(t);
          try { ws.close(); } catch { /* ignore */ }
          resolve(msg.result?.cookies ?? []);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.giveUpTimer);
    if (this.child?.pid) {
      try { spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    if (reason) this.log(`[${this.accountId}] giriş oturumu bitti: ${reason}`);
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
