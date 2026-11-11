/**
 * Hyperliquid 聪明钱观测。只给独立栏用，不写进 EMA / 共振 / 开仓资格 / 通知。
 *
 * 天平：官方 30 天利润榜前 300 个有成交地址，按利润加权看净仓多空。
 * 异动：30 天赚 50 万以上的地址出手、100 万以上仓位变化、50 万以上爆仓；每小时最多 3 条。
 *
 * 排行榜约 40MB，只能在 GitHub Actions / 本机扫描里拉；Worker 只读压缩快照。
 */

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const EXPLORER = 'https://app.hyperliquid.xyz/explorer/address/';
const UA = 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)';

export const TOP_N = 300;
export const WHALE_PNL = 500_000;
export const LARGE_ORDER = 1_000_000;
export const LARGE_LIQ = 500_000;
export const WHALE_ACTION = 250_000;
export const MAX_PER_HOUR = 3;
export const EVENT_KEEP_MS = 36 * 3600 * 1000;
export const FILL_LOOKBACK_MS = 4 * 3600 * 1000;
export const FILL_ADDR_CAP = 48;
const POOL = 10;
const POS_MIN = 1_000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function windowOf(row, name) {
  const pairs = row?.windowPerformances;
  if (!Array.isArray(pairs)) return { pnl: 0, roi: 0, vlm: 0 };
  const hit = pairs.find((p) => Array.isArray(p) && p[0] === name);
  const stats = hit && hit[1] && typeof hit[1] === 'object' ? hit[1] : {};
  return { pnl: num(stats.pnl), roi: num(stats.roi), vlm: num(stats.vlm) };
}

function shortAddr(addr) {
  const a = String(addr || '');
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function coinLabel(coin) {
  const s = String(coin || '');
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function hlPost(body, tries = 3) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        lastErr = new Error('hl 429');
        await sleep(1500 * (t + 1));
        continue;
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        throw new Error(`hl non-json ${res.status}`);
      }
      if (!res.ok) throw new Error(`hl ${res.status} ${body.type}`);
      return data;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (t + 1));
    }
  }
  throw lastErr || new Error('hl post failed');
}

export function pickLeaderboardTop(data, n = TOP_N) {
  const rows = Array.isArray(data) ? data : (data?.leaderboardRows || []);
  const scored = [];
  for (const row of rows) {
    const addr = String(row?.ethAddress || '').toLowerCase();
    if (!addr.startsWith('0x') || addr.length !== 42) continue;
    const month = windowOf(row, 'month');
    if (!(month.pnl > 0) || !(month.vlm > 0)) continue;
    scored.push({
      addr,
      name: row.displayName ? String(row.displayName) : '',
      accountValue: num(row.accountValue),
      pnl30: month.pnl,
      roi30: month.roi,
      vlm30: month.vlm,
    });
  }
  scored.sort((a, b) => b.pnl30 - a.pnl30);
  return scored.slice(0, n).map((w, i) => ({ ...w, rank: i + 1 }));
}

export async function fetchLeaderboardTop(n = TOP_N) {
  const res = await fetch(LEADERBOARD_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const data = await res.json();
  const top = pickLeaderboardTop(data, n);
  if (!top.length) throw new Error('leaderboard empty after filter');
  return top;
}

function parsePositions(state) {
  const out = [];
  const list = state?.assetPositions;
  if (!Array.isArray(list)) return out;
  for (const ap of list) {
    const p = ap?.position || {};
    const coin = String(p.coin || '');
    const szi = num(p.szi);
    const usd = Math.abs(num(p.positionValue));
    if (!coin || !(usd >= POS_MIN) || szi === 0) continue;
    const side = szi > 0 ? 'long' : 'short';
    out.push({
      coin,
      side,
      usd,
      signed: side === 'long' ? usd : -usd,
      szi,
      entry: num(p.entryPx) || null,
      uPnl: num(p.unrealizedPnl),
      lev: num(p.leverage?.value) || null,
    });
  }
  return out;
}

async function fetchState(whale) {
  try {
    const state = await hlPost({ type: 'clearinghouseState', user: whale.addr });
    const positions = parsePositions(state);
    let longUsd = 0;
    let shortUsd = 0;
    const pos = {};
    for (const p of positions) {
      pos[p.coin] = p.signed;
      if (p.side === 'long') longUsd += p.usd;
      else shortUsd += p.usd;
    }
    const net = longUsd - shortUsd;
    let side = 'flat';
    if (net > POS_MIN) side = 'long';
    else if (net < -POS_MIN) side = 'short';
    return {
      ...whale,
      longUsd,
      shortUsd,
      netUsd: net,
      side,
      positions,
      pos,
      accountValue: num(state?.marginSummary?.accountValue) || whale.accountValue,
      ok: true,
    };
  } catch (e) {
    return { ...whale, longUsd: 0, shortUsd: 0, netUsd: 0, side: 'flat', positions: [], pos: {}, ok: false, err: e.message };
  }
}

function mainCoins(positions, max = 3) {
  return [...positions]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, max)
    .map((p) => `${coinLabel(p.coin)}${p.side === 'long' ? '多' : '空'}`);
}

export function buildScale(whales) {
  let longW = 0;
  let shortW = 0;
  let longN = 0;
  let shortN = 0;
  let flatN = 0;
  let longUsd = 0;
  let shortUsd = 0;
  const coinMap = new Map();

  for (const w of whales) {
    if (w.side === 'long') {
      longW += w.pnl30;
      longN += 1;
    } else if (w.side === 'short') {
      shortW += w.pnl30;
      shortN += 1;
    } else {
      flatN += 1;
    }
    longUsd += w.longUsd || 0;
    shortUsd += w.shortUsd || 0;

    const absTot = (w.longUsd || 0) + (w.shortUsd || 0);
    if (!(absTot > 0) || !(w.pnl30 > 0)) continue;
    for (const p of w.positions || []) {
      const share = w.pnl30 * (p.usd / absTot);
      let row = coinMap.get(p.coin);
      if (!row) {
        row = { coin: p.coin, longW: 0, shortW: 0, longUsd: 0, shortUsd: 0, nLong: 0, nShort: 0 };
        coinMap.set(p.coin, row);
      }
      if (p.side === 'long') {
        row.longW += share;
        row.longUsd += p.usd;
        row.nLong += 1;
      } else {
        row.shortW += share;
        row.shortUsd += p.usd;
        row.nShort += 1;
      }
    }
  }

  const coins = [...coinMap.values()]
    .sort((a, b) => (b.longW + b.shortW) - (a.longW + a.shortW))
    .slice(0, 8)
    .map((c) => {
      const tw = c.longW + c.shortW;
      const bias = tw > 0 ? (c.longW - c.shortW) / tw : 0;
      return {
        coin: c.coin,
        label: coinLabel(c.coin),
        longW: Math.round(c.longW),
        shortW: Math.round(c.shortW),
        longUsd: Math.round(c.longUsd),
        shortUsd: Math.round(c.shortUsd),
        nLong: c.nLong,
        nShort: c.nShort,
        longPct: tw > 0 ? c.longW / tw : 0.5,
        bias,
        lean: bias > 0.08 ? 'long' : bias < -0.08 ? 'short' : 'flat',
      };
    });

  const tw = longW + shortW;
  const bias = tw > 0 ? (longW - shortW) / tw : 0;
  const lean = bias > 0.08 ? 'long' : bias < -0.08 ? 'short' : 'flat';

  const top = whales
    .filter((w) => w.side !== 'flat')
    .slice(0, 10)
    .map((w) => ({
      rank: w.rank,
      addr: w.addr,
      short: shortAddr(w.addr),
      name: w.name,
      pnl30: Math.round(w.pnl30),
      side: w.side,
      longUsd: Math.round(w.longUsd),
      shortUsd: Math.round(w.shortUsd),
      coins: mainCoins(w.positions),
      href: EXPLORER + w.addr,
    }));

  return {
    n: whales.length,
    withPos: longN + shortN,
    longN,
    shortN,
    flatN,
    longW: Math.round(longW),
    shortW: Math.round(shortW),
    longPct: tw > 0 ? longW / tw : 0.5,
    bias,
    lean,
    longUsd: Math.round(longUsd),
    shortUsd: Math.round(shortUsd),
    coins,
    top,
  };
}

function hourKey(t) {
  return Math.floor(Number(t) / 3600000);
}

function dirFromDelta(prev, curr) {
  const p = num(prev);
  const c = num(curr);
  const d = c - p;
  if (Math.abs(d) < POS_MIN) return null;
  const near0 = (v) => Math.abs(v) < POS_MIN * 5;
  let action = '加仓';
  let side = d > 0 ? 'long' : 'short';
  if (near0(p) && c > 0) { action = '开多'; side = 'long'; }
  else if (near0(p) && c < 0) { action = '开空'; side = 'short'; }
  else if (p > 0 && near0(c)) { action = '平多'; side = 'long'; }
  else if (p < 0 && near0(c)) { action = '平空'; side = 'short'; }
  else if (p > 0 && c > p) { action = '加多'; side = 'long'; }
  else if (p > 0 && c < p && c > 0) { action = '减多'; side = 'long'; }
  else if (p < 0 && c < p) { action = '加空'; side = 'short'; }
  else if (p < 0 && c > p && c < 0) { action = '减空'; side = 'short'; }
  else if (p > 0 && c < 0) { action = '翻空'; side = 'short'; }
  else if (p < 0 && c > 0) { action = '翻多'; side = 'long'; }
  return { action, side, delta: d, abs: Math.abs(d) };
}

function eventBase(w, coin, t, extra) {
  return {
    t,
    addr: w.addr,
    short: shortAddr(w.addr),
    name: w.name || '',
    href: EXPLORER + w.addr,
    coin,
    label: coinLabel(coin),
    pnl30: Math.round(w.pnl30 || 0),
    whale: (w.pnl30 || 0) >= WHALE_PNL,
    ...extra,
  };
}

export function diffEvents(prevMap, whales, now = Date.now()) {
  const events = [];
  const prev = prevMap && typeof prevMap === 'object' ? prevMap : {};
  for (const w of whales) {
    const before = prev[w.addr] || {};
    const coins = new Set([...Object.keys(before), ...Object.keys(w.pos || {})]);
    for (const coin of coins) {
      const info = dirFromDelta(before[coin], (w.pos || {})[coin]);
      if (!info) continue;
      const whaleOk = w.pnl30 >= WHALE_PNL && info.abs >= WHALE_ACTION;
      const orderOk = info.abs >= LARGE_ORDER;
      if (!whaleOk && !orderOk) continue;
      const kind = orderOk ? 'order' : 'whale';
      const kindLabel = orderOk ? '大单' : '大佬出手';
      events.push(eventBase(w, coin, now, {
        id: `${kind}:${w.addr}:${coin}:${hourKey(now)}:${info.action}`,
        kind,
        kindLabel,
        action: info.action,
        side: info.side,
        notional: Math.round(info.abs),
      }));
    }
  }
  return events;
}

function isLiqDir(dir) {
  const s = String(dir || '');
  return /liquidat/i.test(s) || /auto-?deleverag/i.test(s) || /\bADL\b/i.test(s);
}

function fillSide(dir, side) {
  const d = String(dir || '');
  if (/long/i.test(d)) return 'long';
  if (/short/i.test(d)) return 'short';
  if (side === 'B') return 'long';
  if (side === 'A') return 'short';
  return 'long';
}

function fillAction(dir, liq) {
  const d = String(dir || '');
  if (liq) return /short/i.test(d) ? '爆仓空' : '爆仓多';
  if (/open long/i.test(d)) return '开多';
  if (/open short/i.test(d)) return '开空';
  if (/close long/i.test(d)) return '平多';
  if (/close short/i.test(d)) return '平空';
  if (/long > short/i.test(d)) return '翻空';
  if (/short > long/i.test(d)) return '翻多';
  return d || '成交';
}

function collectFromFills(w, fills, now, wantAgg) {
  const events = [];
  const agg = new Map();
  const start = now - FILL_LOOKBACK_MS;
  for (const f of Array.isArray(fills) ? fills : []) {
    const t = num(f.time);
    if (t && t < start) continue;
    const coin = String(f.coin || '');
    const notional = Math.abs(num(f.px) * num(f.sz));
    if (!coin || !(notional > 0)) continue;
    const dir = f.dir;
    const liq = isLiqDir(dir);
    if (liq && notional >= LARGE_LIQ) {
      const side = fillSide(dir, f.side);
      events.push(eventBase(w, coin, t || now, {
        id: `liq:${f.hash || f.tid || `${w.addr}:${coin}:${t}`}`,
        kind: 'liq',
        kindLabel: '爆仓',
        action: fillAction(dir, true),
        side,
        notional: Math.round(notional),
      }));
      continue;
    }
    if (!wantAgg) continue;
    const side = fillSide(dir, f.side);
    const action = fillAction(dir, false);
    const hour = hourKey(t || now);
    const key = `${coin}|${action}|${hour}`;
    const cur = agg.get(key) || { coin, action, side, hour, t: t || now, notional: 0 };
    cur.notional += notional;
    if (t > cur.t) cur.t = t;
    agg.set(key, cur);
  }
  if (wantAgg) {
    for (const row of agg.values()) {
      const whaleOk = w.pnl30 >= WHALE_PNL && row.notional >= WHALE_ACTION;
      const orderOk = row.notional >= LARGE_ORDER;
      if (!whaleOk && !orderOk) continue;
      const kind = orderOk ? 'order' : 'whale';
      events.push(eventBase(w, row.coin, row.t, {
        id: `${kind}:${w.addr}:${row.coin}:${row.hour}:${row.action}`,
        kind,
        kindLabel: orderOk ? '大单' : '大佬出手',
        action: row.action,
        side: row.side,
        notional: Math.round(row.notional),
      }));
    }
  }
  return events;
}

async function collectFillEvents(whales, now, wantAgg) {
  const candidates = whales
    .filter((w) => w.ok && w.pnl30 >= WHALE_PNL)
    .sort((a, b) => b.pnl30 - a.pnl30)
    .slice(0, FILL_ADDR_CAP);
  const startTime = now - FILL_LOOKBACK_MS;
  const batches = await mapPool(candidates, 6, async (w) => {
    try {
      const fills = await hlPost({
        type: 'userFillsByTime',
        user: w.addr,
        startTime,
        aggregateByTime: true,
      });
      return collectFromFills(w, fills, now, wantAgg);
    } catch {
      return [];
    }
  });
  return batches.flat();
}

const KIND_RANK = { liq: 3, order: 2, whale: 1 };

export function capHourly(events, maxPerHour = MAX_PER_HOUR, keepMs = EVENT_KEEP_MS, now = Date.now()) {
  const cutoff = now - keepMs;
  const fresh = (events || []).filter((e) => num(e.t) >= cutoff);
  const byHour = new Map();
  for (const e of fresh) {
    const h = hourKey(e.t);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(e);
  }
  const kept = [];
  for (const list of byHour.values()) {
    const seen = new Set();
    const uniq = [];
    for (const e of list) {
      const id = e.id || `${e.kind}:${e.addr}:${e.coin}:${e.t}`;
      if (seen.has(id)) continue;
      seen.add(id);
      uniq.push(e);
    }
    uniq.sort((a, b) => {
      const kr = (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0);
      if (kr) return kr;
      return (b.notional || 0) - (a.notional || 0) || (b.t || 0) - (a.t || 0);
    });
    kept.push(...uniq.slice(0, maxPerHour));
  }
  kept.sort((a, b) => (b.t || 0) - (a.t || 0));
  return kept.slice(0, 24);
}

function compactPosMap(whales) {
  const map = {};
  for (const w of whales) {
    const pos = w.pos || {};
    const slim = {};
    let n = 0;
    for (const [coin, usd] of Object.entries(pos)) {
      const v = Math.round(num(usd));
      if (Math.abs(v) < POS_MIN) continue;
      slim[coin] = v;
      n += 1;
    }
    if (n) map[w.addr] = slim;
  }
  return map;
}

function publicEvents(events) {
  return (events || []).map((e) => ({
    id: e.id,
    t: e.t,
    kind: e.kind,
    kindLabel: e.kindLabel,
    action: e.action,
    side: e.side,
    coin: e.coin,
    label: e.label || coinLabel(e.coin),
    notional: e.notional,
    addr: e.addr,
    short: e.short,
    name: e.name,
    href: e.href,
    whale: !!e.whale,
    pnl30: e.pnl30,
  }));
}

export function emptyHlSmartMoney(error = '') {
  return {
    ok: !error,
    asOf: Date.now(),
    scale: null,
    events: [],
    posMap: {},
    error: error || '',
  };
}

export async function buildHlSmartMoney({ previous = null } = {}) {
  const now = Date.now();
  const top = await fetchLeaderboardTop(TOP_N);
  const whales = await mapPool(top, POOL, fetchState);
  const ok = whales.filter((w) => w.ok).length;
  if (!ok) throw new Error('no whale positions');
  const scale = buildScale(whales);
  const havePrev = previous && previous.posMap && Object.keys(previous.posMap).length > 0;
  const deltaEvents = havePrev ? diffEvents(previous.posMap, whales, now) : [];
  const fillEvents = await collectFillEvents(whales, now, !havePrev);
  const merged = capHourly(
    [...(previous?.events || []), ...deltaEvents, ...fillEvents],
    MAX_PER_HOUR,
    EVENT_KEEP_MS,
    now,
  );
  return {
    ok: true,
    asOf: now,
    universe: top.length,
    fetched: ok,
    scale,
    events: publicEvents(merged),
    posMap: compactPosMap(whales),
    error: '',
  };
}
