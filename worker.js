// Per-account watching worker: viewer websocket loop with 12s handshake/ping
// alternation and 60s watch-tracking events, plus periodic progress checks
// with automatic reward claiming (the "box opening").
import WebSocket from 'ws';
import {
  getUser, getCampaigns, getProgress, claimReward,
  getChannel, getHomepageLivestreams, getViewerToken, randomUA,
} from './kick.js';

const HANDSHAKE_EVERY_MS = 12_000;
const WATCH_EVENT_EVERY_MS = 60_000;
const PROGRESS_EVERY_MS = 5 * 60_000;
const CAMPAIGNS_EVERY_MS = 15 * 60_000;
const MAX_RECONNECT = 6;
const UA_CANDIDATES = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
];

const GTA_PATTERNS = ['gta', 'grand theft auto', 'sunset'];

function isGtaCampaign(c) {
  const hay = `${c.name} ${c.category?.name ?? ''} ${c.category?.slug ?? ''}`.toLowerCase();
  return GTA_PATTERNS.some((p) => hay.includes(p));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class AccountWorker {
  constructor(acc, store, log) {
    this.acc = acc; // mutable account record {id, cookieHeader, ...}
    this.store = store;
    this.log = log;
    this.stopped = false;
    this.ua = randomUA();
    this.ws = null;
    this.timers = new Set();
    this.channel = null;      // {slug, channelId, livestreamId, title}
    this.ticker = null;
    this.progressTimer = null;
    this.campaignTimer = null;
    this.reconnects = 0;
    this.watchSeconds = 0;    // counted locally while WS is healthy
  }

  save() { this.store.save(); }

  set(patch) {
    Object.assign(this.acc, patch);
    this.save();
  }

  start() {
    this.stopped = false;
    this.main().catch((e) => this.log(`[init] ${e.message}`));
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.set({ status: 'stopped', wsStatus: 'kapalı' });
  }

  clearTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
  }

  async main() {
    // 1. validate session — probe candidate UAs because cf_clearance is
    //    issued for a specific User-Agent; persist whichever one authenticates.
    let user = null;
    const candidates = [this.acc.ua, ...UA_CANDIDATES].filter(Boolean);
    for (const ua of [...new Set(candidates)]) {
      user = await getUser(this.acc.cookieHeader, ua).catch(() => null);
      if (user) { this.ua = ua; this.set({ ua }); break; }
    }
    if (!user) {
      this.set({ status: 'auth_error', wsStatus: '—', error: 'Oturum geçersiz (kick_session ölmüş olabilir). Yeni cookie ekle.' });
      return;
    }
    this.set({ status: 'active', username: user.username, userId: user.id, avatar: user.avatar, error: null });

    await this.refreshCampaigns();
    if (this.stopped) return;

    // 2. periodic loops (started BEFORE watching: pickAndWatch blocks until
    //    the watch session ends, so timers must exist first)
    this.progressTimer = setInterval(() => this.checkProgress().catch(() => {}), PROGRESS_EVERY_MS);
    this.campaignTimer = setInterval(() => this.refreshCampaigns().catch(() => {}), CAMPAIGNS_EVERY_MS);
    this.timers.add(this.progressTimer);
    this.timers.add(this.campaignTimer);

    // local minute ticker (1 min granularity for UI)
    this.ticker = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.watchSeconds += 60;
        this.set({ minutesWatched: this.acc.minutesWatched + 1 });
      }
    }, 60_000);
    this.timers.add(this.ticker);

    await this.checkProgress().catch(() => {});

    // 3. pick a random live channel and start watching (blocks until session ends)
    await this.pickAndWatch();
  }

  async refreshCampaigns() {
    const res = await getCampaigns(this.acc.cookieHeader, this.ua);
    if (res.error) { this.set({ campaignsError: res.error }); return; }
    const campaigns = res.campaigns.filter((c) => !c.connectUrl);
    const gta = campaigns.find(isGtaCampaign) || null;
    this.set({
      campaigns: campaigns.map((c) => ({
        id: c.id, name: c.name, category: c.category?.name ?? null, slug: c.category?.slug ?? null,
        rewards: c.rewards, isGta: isGtaCampaign(c), channels: c.channels,
      })),
      gtaCampaignId: gta?.id ?? null,
      campaignsError: null,
    });
  }

  // Choose the campaign to farm: GTA/sunset first, else any active one.
  targetCampaign() {
    const campaigns = this.acc.campaigns ?? [];
    return campaigns.find((c) => c.isGta) || campaigns[0] || null;
  }

  // Abort the current watch session so the close handler re-runs
  // pickAndWatch with fresh settings (e.g. a newly forced channel).
  reselect() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  async pickAndWatch() {
    this.reconnects++;
    if (this.reconnects > MAX_RECONNECT) {
      this.set({ status: 'error', wsStatus: 'kapalı', error: 'Tekrar bağlanma sınırı aşıldı (6). Bir süre sonra tekrar denenecek.' });
      setTimeout(() => { if (!this.stopped) { this.reconnects = 0; this.main(); } }, 10 * 60_000);
      return;
    }

    const forced = this.store.data.forceChannel || null;
    if (forced) {
      const ch = await getChannel(this.acc.cookieHeader, this.ua, forced).catch((e) => {
        this.log(`[${this.acc.username ?? this.acc.id}] kanal sorgu hatası ${forced}: ${e.message}`);
        return null;
      });
      if (ch?.isLive && ch.channelId && ch.livestreamId) {
        this.channel = ch;
        this.set({ channel: forced, channelTitle: ch.title, livestreamId: ch.livestreamId, watchSource: 'zorlanan kanal', status: 'watching', wsStatus: 'bağlanıyor' });
        await this.watchLoop(ch);
        if (this.stopped) return;
        return;
      }
      // forced channel offline (or rate-limited) — keep waiting, don't burn
      // reconnect budget
      this.set({ wsStatus: 'kanal offline', channel: forced, error: null });
      await this.sleep(90_000);
      if (!this.stopped) await this.pickAndWatch();
      return;
    }

    // Random active streamer from the popular live directory. Probe only a
    // handful of candidates per cycle — hammering /api/v2/channels triggers
    // Cloudflare rate limiting.
    const home = await getHomepageLivestreams(this.acc.cookieHeader, this.ua, 30).catch((e) => {
      this.log(`[${this.acc.username ?? this.acc.id}] liste hatası: ${e.message}`);
      return [];
    });
    const slugs = shuffle(home.map((s) => s.slug)).slice(0, 5);
    for (const slug of slugs) {
      if (this.stopped) return;
      const ch = await getChannel(this.acc.cookieHeader, this.ua, slug).catch((e) => {
        this.log(`[${this.acc.username ?? this.acc.id}] kanal sorgu hatası ${slug}: ${e.message}`);
        return null;
      });
      if (ch?.isLive && ch.channelId && ch.livestreamId) {
        this.channel = ch;
        this.set({ channel: slug, channelTitle: ch.title, livestreamId: ch.livestreamId, watchSource: 'rastgele canlı yayın', status: 'watching', wsStatus: 'bağlanıyor' });
        await this.watchLoop(ch);
        if (this.stopped) return;
        return;
      }
      await this.sleep(2500); // gentle pacing between probes
    }

    // nothing live right now — retry shortly
    this.log(`[${this.acc.username ?? this.acc.id}] canlı kanal bulunamadı (aday: ${home.length}), 60 sn sonra tekrar`);
    this.set({ wsStatus: 'kanal aranıyor', error: null });
    await this.sleep(60_000);
    if (!this.stopped) await this.pickAndWatch();
  }

  async resolveCategoryId(slug) {
    const { getJSON } = await import('./kick.js');
    const { status, body } = await getJSON(`https://kick.com/api/v1/subcategories/${encodeURIComponent(slug)}?withTags=false`, this.acc.cookieHeader, this.ua);
    if (status === 200 && Number.isFinite(Number(body?.id))) return body.id;
    if (status === 200 && Number.isFinite(Number(body?.data?.id))) return body.data.id;
    return null;
  }

  async watchLoop(ch) {
    try {
      const token = await getViewerToken(this.acc.cookieHeader, this.ua);
      await this.runWS(token, ch.channelId, ch.livestreamId);
    } catch (e) {
      this.set({ wsStatus: 'hata', error: e.message });
      await this.sleep(5000);
      await this.pickAndWatch();
    }
  }

  async runWS(token, channelId, livestreamId) {
    return new Promise((resolve) => {
      const url = `wss://websockets.kick.com/viewer/v1/connect?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url, { headers: { 'User-Agent': this.ua, 'Origin': 'https://kick.com' } });
      this.ws = ws;
      let alternate = 0;
      let settled = false;

      const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ } };
      const handshake = () => send({ type: 'channel_handshake', data: { message: { channelId: Number(channelId) } } });
      const ping = () => send({ type: 'ping' });
      const watchEvent = () => send({
        type: 'user_event',
        data: { message: { name: 'tracking.user.watch.livestream', channel_id: Number(channelId), livestream_id: Number(livestreamId) } },
      });

      ws.on('open', () => {
        this.reconnects = 0;
        handshake();
        watchEvent();
        this.set({ wsStatus: 'izliyor', error: null });
        const hs = setInterval(() => {
          alternate++;
          if (alternate % 2 === 0) ping(); else handshake();
        }, HANDSHAKE_EVERY_MS);
        const we = setInterval(watchEvent, WATCH_EVENT_EVERY_MS);
        for (const t of [hs, we]) this.timers.add(t);
        ws.once('close', () => {
          for (const t of [hs, we]) { clearInterval(t); this.timers.delete(t); }
        });
      });

      ws.on('message', () => { /* pong / acks drained */ });
      ws.on('error', () => { /* handled on close */ });

      ws.on('close', async () => {
        this.timers.delete(ws);
        if (this.stopped) { resolve(); return; }
        if (!settled) { settled = true; resolve(); }
        this.set({ wsStatus: 'kopuk', error: 'WebSocket kapandı, yeni kanal aranıyor…' });
        await this.sleep(3000);
        if (!this.stopped) await this.pickAndWatch();
      });
    });
  }

  async checkProgress() {
    const res = await getProgress(this.acc.cookieHeader, this.ua);
    if (res.forbidden) {
      this.set({ error: 'drops/progress 403 — oturum geçersiz olabilir.' });
      return;
    }
    if (res.error) return;

    const rewards = [];
    const claims = [];
    for (const c of res.campaigns) {
      for (const r of c.rewards) {
        const minutes = Math.round(r.progress * r.requiredUnits);
        rewards.push({
          campaignId: c.id, campaign: c.name, id: r.id, name: r.name,
          progress: r.progress, requiredMinutes: r.requiredUnits, minutes,
          claimed: r.claimed, pct: r.requiredUnits > 0 ? Math.min(100, Math.round(r.progress * 100)) : 0,
          isGta: GTA_PATTERNS.some((p) => `${c.name}`.toLowerCase().includes(p)),
        });
        if (!r.claimed && r.progress >= 1 && r.requiredUnits > 0) {
          claims.push({ campaignId: c.id, rewardId: r.id, name: r.name, campaign: c.name });
        }
      }
    }
    this.set({ rewards, rewardsError: null });

    for (const c of claims) {
      const res2 = await claimReward(this.acc.cookieHeader, this.ua, c.rewardId, c.campaignId);
      const entry = {
        at: new Date().toISOString(),
        name: c.name,
        campaign: c.campaign,
        ok: res2.ok,
        detail: res2.ok ? 'kutu açıldı 🎁' : `claim ${res2.status}: ${res2.text}`,
      };
      this.log(`[${this.acc.username}] ${entry.detail} — ${c.name} (${c.campaign})`);
      this.set({ claims: [entry, ...(this.acc.claims ?? [])].slice(0, 50) });
    }
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
