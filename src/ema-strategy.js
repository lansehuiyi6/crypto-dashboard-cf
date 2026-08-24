/**
 * K 线拉取（扫描脚本 / Worker 兜底）
 */
import { STRATEGY_SYMBOLS, evaluateEmaTrendStrategy } from '../public/ema-core.js';

export { STRATEGY_SYMBOLS, evaluateEmaTrendStrategy };

const CG_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  SOL: 'solana',
  XAU: 'pax-gold',
};
const CG = 'https://api.coingecko.com/api/v3';
const KLINE_LIMIT = 120;
const SYMBOL_ALIASES = {
  XAUUSDT: ['XAUUSDT', 'PAXGUSDT'],
};
const KLINE_URLS = [
  (s, i, n) => `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${i}&limit=${n}`,
  (s, i, n) => `https://data-api.binance.vision/api/v3/klines?symbol=${s}&interval=${i}&limit=${n}`,
  (s, i, n) => `https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${i}&limit=${n}`,
];
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)',
  Accept: 'application/json',
};
const INTERVAL_MS = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000 };

export async function fetchKlines(symbol, interval = '1h', limit = KLINE_LIMIT) {
  const symbols = SYMBOL_ALIASES[symbol] || [symbol];
  let lastErr = null;
  for (const sym of symbols) {
    for (const makeUrl of KLINE_URLS) {
      const url = makeUrl(sym, interval, limit);
      try {
        const res = await fetch(url, { headers: FETCH_HEADERS });
        if (!res.ok) {
          lastErr = new Error(`klines ${sym} ${res.status}`);
          continue;
        }
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 80) return data;
        lastErr = new Error(`klines ${sym} short ${Array.isArray(data) ? data.length : 0}`);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error(`klines ${symbol} failed`);
}

async function fetchCgKlines(coin, interval) {
  const id = CG_IDS[coin];
  if (!id) throw new Error(`no cg id for ${coin}`);
  const days = interval === '15m' ? 1 : 7;
  const data = await fetchCgChart(id, days);
  const sampled = resampleLast(data.prices || [], INTERVAL_MS[interval] || INTERVAL_MS['1h']);
  if (sampled.length < 80) throw new Error(`cg ${coin} ${interval} short ${sampled.length}`);
  return sampled.map(([t, p]) => [t, p, p, p, p, 0]);
}

export function normalizeBoard(raw) {
  const empty = { '15m': {}, '1h': {}, usdtD: { '15m': null, '1h': null } };
  if (!raw || typeof raw !== 'object') return empty;
  if (raw['15m'] || raw['1h'] || raw.usdtD) {
    return {
      '15m': raw['15m'] && typeof raw['15m'] === 'object' ? raw['15m'] : {},
      '1h': raw['1h'] && typeof raw['1h'] === 'object' ? raw['1h'] : {},
      usdtD: raw.usdtD && typeof raw.usdtD === 'object' ? raw.usdtD : empty.usdtD,
      errors: raw.errors || [],
    };
  }
  const h1 = {};
  for (const coin of Object.keys(STRATEGY_SYMBOLS)) {
    if (raw[coin] && raw[coin].lastSignal) h1[coin] = raw[coin];
  }
  return { '15m': {}, '1h': h1, usdtD: empty.usdtD, errors: [] };
}

export function boardHasRows(board) {
  const b = normalizeBoard(board);
  for (const tf of ['15m', '1h']) {
    for (const row of Object.values(b[tf] || {})) {
      if (row && row.lastSignal) return true;
    }
  }
  if (b.usdtD?.['1h']?.lastSignal || b.usdtD?.['15m']?.lastSignal) return true;
  return false;
}

function mergeBoards(live, cached) {
  const a = normalizeBoard(live);
  const b = normalizeBoard(cached);
  const out = { '15m': { ...b['15m'] }, '1h': { ...b['1h'] }, usdtD: { ...b.usdtD }, errors: a.errors || [] };
  for (const tf of ['15m', '1h']) {
    for (const [coin, row] of Object.entries(a[tf] || {})) {
      if (row && row.lastSignal) out[tf][coin] = row;
    }
  }
  if (a.usdtD?.['1h']?.lastSignal) out.usdtD['1h'] = a.usdtD['1h'];
  if (a.usdtD?.['15m']?.lastSignal) out.usdtD['15m'] = a.usdtD['15m'];
  return out;
}

async function fetchCgChart(id, days) {
  const url = `${CG}/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`coingecko ${id} ${res.status}`);
  return res.json();
}

function resampleLast(points, bucketMs) {
  const buckets = new Map();
  for (const [t, v] of points || []) {
    if (!Number.isFinite(v)) continue;
    const b = Math.floor(Number(t) / bucketMs) * bucketMs;
    buckets.set(b, v);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

function toDominanceKlines(tetherMc, btcMc, ethMc, bucketMs, scaleTo) {
  const tR = resampleLast(tetherMc, bucketMs);
  const bMap = Object.fromEntries(resampleLast(btcMc, bucketMs));
  const eMap = Object.fromEntries(resampleLast(ethMc, bucketMs));
  const rows = [];
  for (const [t, usdt] of tR) {
    const btc = bMap[t];
    const eth = eMap[t];
    if (!btc || !eth) continue;
    const proxy = (100 * usdt) / (usdt + btc + eth);
    rows.push([t, proxy]);
  }
  if (!rows.length) return [];
  const last = rows[rows.length - 1][1];
  const scale = Number.isFinite(scaleTo) && last > 0 ? scaleTo / last : 1;
  return rows.map(([t, p]) => {
    const c = p * scale;
    return [t, c, c, c, c, 0];
  });
}

export async function fetchUsdtDStrategies(liveUsdtD = null) {
  const out = { '15m': null, '1h': null };
  try {
    const [t14, b14, e14] = await Promise.all([
      fetchCgChart('tether', 14),
      fetchCgChart('bitcoin', 14),
      fetchCgChart('ethereum', 14),
    ]);
    const k1h = toDominanceKlines(t14.market_caps, b14.market_caps, e14.market_caps, INTERVAL_MS['1h'], liveUsdtD);
    out['1h'] = evaluateEmaTrendStrategy(k1h, 'USDT.D', {
      interval: '1h',
      valueKind: 'pct',
      inverse: true,
      approx: true,
    });
  } catch { /* keep null */ }

  try {
    const [t1, b1, e1] = await Promise.all([
      fetchCgChart('tether', 1),
      fetchCgChart('bitcoin', 1),
      fetchCgChart('ethereum', 1),
    ]);
    const k15 = toDominanceKlines(t1.market_caps, b1.market_caps, e1.market_caps, INTERVAL_MS['15m'], liveUsdtD);
    out['15m'] = evaluateEmaTrendStrategy(k15, 'USDT.D', {
      interval: '15m',
      valueKind: 'pct',
      inverse: true,
      approx: true,
    });
  } catch { /* 15m optional */ }

  return out;
}

export async function fetchStrategyBoard(liveUsdtD = null, opts = {}) {
  const includeUsdtD = opts.includeUsdtD !== false;
  const intervals = opts.intervals || ['15m', '1h'];
  const board = { '15m': {}, '1h': {}, usdtD: { '15m': null, '1h': null }, errors: [] };
  const jobs = [];
  for (const interval of intervals) {
    for (const [coin, symbol] of Object.entries(STRATEGY_SYMBOLS)) {
      jobs.push((async () => {
        try {
          let klines;
          try {
            klines = await fetchKlines(symbol, interval, KLINE_LIMIT);
          } catch {
            klines = await fetchCgKlines(coin, interval);
          }
          const row = evaluateEmaTrendStrategy(klines, coin, { interval });
          board[interval][coin] = row;
          if (!row) board.errors.push(`${coin} ${interval}: 指标不足`);
        } catch (e) {
          board[interval][coin] = null;
          board.errors.push(`${coin} ${interval}: ${e.message || e}`);
        }
      })());
    }
  }
  if (includeUsdtD) {
    jobs.push((async () => {
      board.usdtD = await fetchUsdtDStrategies(liveUsdtD);
    })());
  }
  await Promise.all(jobs);
  return board;
}

export { mergeBoards };
