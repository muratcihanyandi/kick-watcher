// Kick.com drops watcher — HTTP + WebSocket API helpers.
// Endpoint details verified against kick.com live (2026-11) and cross-checked
// with the open-source grubdrops miner implementation.
import crypto from 'node:crypto';

const CLIENT_TOKEN = 'e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export function parseCookieHeader(header) {
  const pairs = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) pairs[k] = v;
  }
  return pairs;
}

// Parse a Netscape cookies.txt export ("# Netscape HTTP Cookie File") into a
// Cookie header string. Skips comments and expired entries; only *.kick.com
// domains are relevant here but we keep whatever is present.
export function parseNetscapeCookies(text) {
  const now = Math.floor(Date.now() / 1000);
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = cols;
    if (!name || !value) continue;
    if (!/kick\.com$/i.test(domain.trim().replace(/^\./, ''))) continue;
    const exp = Number(expires);
    if (Number.isFinite(exp) && exp > 0 && exp < now) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

// Detect whether a pasted blob is a Netscape cookie file rather than a
// Cookie: header.
export function isNetscapeFormat(text) {
  if (/^# Netscape/i.test(text.trim())) return true;
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  return lines.length > 1 && lines.every((l) => l.split('\t').length >= 7);
}

export function normalizeCookieInput(text) {
  if (isNetscapeFormat(text)) return parseNetscapeCookies(text);
  return text.trim().split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';
}

function baseHeaders(cookieHeader, ua) {
  const pairs = parseCookieHeader(cookieHeader);
  const h = {
    'User-Agent': ua || DEFAULT_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': cookieHeader,
    'Referer': 'https://kick.com/',
    'Origin': 'https://kick.com',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  if (pairs['XSRF-TOKEN']) h['X-XSRF-TOKEN'] = decodeURIComponent(pairs['XSRF-TOKEN']);
  if (pairs['session_token']) h['Authorization'] = 'Bearer ' + decodeURIComponent(pairs['session_token']);
  return h;
}

async function getJSON(url, cookieHeader, ua) {
  const headers = baseHeaders(cookieHeader, ua);
  // Sec-Fetch-Site must match the relationship between Origin (kick.com) and
  // the target host, or Cloudflare 403s the request as suspicious metadata.
  const sameOrigin = new URL(url).host === 'kick.com';
  headers['Sec-Fetch-Site'] = sameOrigin ? 'same-origin' : 'same-site';
  const r = await fetch(url, { headers });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, body, text };
}

// --- Session / identity -------------------------------------------------

export async function getUser(cookieHeader, ua) {
  const { status, body } = await getJSON('https://kick.com/api/v1/user', cookieHeader, ua);
  if (status !== 200 || !body || !body.id) return null;
  return { id: body.id, username: body.username, avatar: body.profile_pic || null };
}

// --- Campaigns / progress / claim ----------------------------------------

function pickArray(obj, keys) {
  for (const k of keys) if (Array.isArray(obj?.[k])) return obj[k];
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getCampaigns(cookieHeader, ua) {
  const { status, body } = await getJSON('https://web.kick.com/api/v1/drops/campaigns', cookieHeader, ua);
  if (status !== 200) return { error: `campaigns: ${status}` };
  const list = pickArray(body, ['data', 'campaigns', 'drops']) || (Array.isArray(body) ? body : []);
  const campaigns = list.map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    category: c.category ? { name: c.category.name, slug: c.category.slug, id: c.category.id } : null,
    status: String(c.status ?? ''),
    endsAt: c.ends_at ?? null,
    connectUrl: c.connect_url || null,
    channels: (Array.isArray(c.channels) ? c.channels : []).map((ch) => ({ slug: String(ch.slug ?? ''), id: String(ch.id ?? '') })),
    rewards: pickArray(c, ['rewards', 'benefits', 'drops', 'tiers'])?.map((rw) => ({
      id: String(rw.id ?? ''),
      name: String(rw.name ?? ''),
      requiredMinutes: num(rw.required_units ?? rw.required_minutes ?? 0),
    })) || [],
  }));
  return { campaigns };
}

export async function getProgress(cookieHeader, ua) {
  const { status, body } = await getJSON('https://web.kick.com/api/v1/drops/progress', cookieHeader, ua);
  if (status === 403) return { forbidden: true };
  if (status !== 200) return { error: `progress: ${status}` };
  const list = pickArray(body, ['data']) || [];
  const campaigns = list.map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    category: c.category ? { name: c.category.name, slug: c.category.slug, id: c.category.id } : null,
    progressUnits: num(c.progress_units),
    userAppConnected: !!c.user_app_connected,
    rewards: (Array.isArray(c.rewards) ? c.rewards : []).map((rw) => ({
      id: String(rw.id ?? ''),
      name: String(rw.name ?? rw.external_id ?? ''),
      progress: num(rw.progress),
      requiredUnits: num(rw.required_units),
      claimed: !!rw.claimed,
    })),
  }));
  return { campaigns };
}

export async function claimReward(cookieHeader, ua, rewardId, campaignId) {
  const h = {
    ...baseHeaders(cookieHeader, ua),
    'Content-Type': 'application/json',
  };
  const r = await fetch('https://web.kick.com/api/v1/drops/claim', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ reward_id: String(rewardId), campaign_id: String(campaignId) }),
  });
  const text = await r.text();
  return { status: r.status, ok: r.status === 200 || r.status === 201, text: text.slice(0, 300) };
}

// Follow a channel with the session's account. Endpoint verified live:
// POST https://kick.com/api/v2/channels/{slug}/follow → 200 {status:true}
export async function followChannel(cookieHeader, ua, slug) {
  const h = {
    ...baseHeaders(cookieHeader, ua),
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
    'Referer': `https://kick.com/${encodeURIComponent(slug)}`,
  };
  const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/follow`, {
    method: 'POST',
    headers: h,
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  const ok = r.status === 200 && body?.status === true;
  return { status: r.status, ok, alreadyFollowed: r.status === 200 && !ok, text: JSON.stringify(body).slice(0, 200) };
}

// --- Channels / livestreams ----------------------------------------------

export async function getChannel(cookieHeader, ua, slug) {
  const { status, body } = await getJSON(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, cookieHeader, ua);
  if (status !== 200 || !body) return null;
  // response shape: {id, slug, livestream: {...}} — no data wrapper (2026-11)
  const d = body.data ?? body;
  return {
    slug: d.slug,
    channelId: num(d.id),
    livestreamId: num(d.livestream?.id ?? 0),
    isLive: !!d.livestream,
    category: d.recent_categories?.[0]?.slug ?? d.livestream?.categories?.[0]?.slug ?? null,
    viewers: num(d.livestream?.viewer_count),
    title: d.livestream?.session_title ?? '',
  };
}

export async function getCategoryLivestreams(cookieHeader, ua, categoryId, limit = 24) {
  const url = `https://web.kick.com/api/v1/livestreams?limit=${limit}&sort=viewer_count_desc` + (categoryId ? `&category_id=${categoryId}` : '');
  const { status, body } = await getJSON(url, cookieHeader, ua);
  if (status !== 200) return [];
  // observed shape: {data: {livestreams: [...]}} (2026-11)
  let list = null;
  if (Array.isArray(body?.data?.livestreams)) list = body.data.livestreams;
  else list = pickArray(body, ['data', 'livestreams']) || [];
  const out = [];
  for (const item of list) {
    const ch = item.channel ?? item;
    const slug = ch.slug ?? ch.username;
    if (!slug) continue;
    out.push({ slug, channelId: num(ch.id ?? item.channel_id), livestreamId: num(item.id ?? item.livestream_id), viewers: num(item.viewer_count) });
  }
  return out;
}

export async function getHomepageLivestreams(cookieHeader, ua, limit = 30) {
  return getCategoryLivestreams(cookieHeader, ua, null, limit);
}

// --- Watch (viewer websocket) ---------------------------------------------

export async function getViewerToken(cookieHeader, ua) {
  const h = { ...baseHeaders(cookieHeader, ua), 'X-Client-Token': CLIENT_TOKEN };
  const r = await fetch('https://websockets.kick.com/viewer/v1/token', { headers: h });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || !body?.data?.token) {
    throw new Error(`viewer token: ${r.status} ${JSON.stringify(body).slice(0, 120)}`);
  }
  return body.data.token;
}

export function randomUA() {
  const majors = [138, 139, 140, 141, 142];
  const m = majors[crypto.randomInt(majors.length)];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36`;
}
