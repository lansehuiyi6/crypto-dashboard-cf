/**
 * K 线拉取（扫描脚本 / Worker 兜底）
 */
import {
  STRATEGY_SYMBOLS,
  evaluateEmaTrendStrategy,
  evaluateMacdKdjSignal,
  annotateMacdKdjContext,
  attachAlphaTrend,
  resampleLast,
  toDominanceKlines,
  INTERVAL_MS,
  EXEC_INTERVALS,
  HTF_INTERVALS,
} from '../public/ema-core.js';

export { STRATEGY_SYMBOLS, evaluateEmaTrendStrategy, evaluateMacdKdjSignal };

const CG_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  SOL: 'solana',
  XRP: 'ripple',
  XAU: 'pax-gold',
};
const CG = 'https://api.coingecko.com/api/v3';
const KLINE_LIMIT = 160;
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
        if (Array.isArray(data) && data.length >= 100) return data;
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

function enrichBoardMacdKdj(board) {
  for (const tf of EXEC_INTERVALS) {
    for (const coin of Object.keys(STRATEGY_SYMBOLS)) {
      const row = board[tf] && board[tf][coin];
      if (!row || !row.macdKdj) continue;
      row.macdKdjView = annotateMacdKdjContext(row.macdKdj, board['4h']?.[coin], board['1d']?.[coin]);
    }
  }
  return board;
}

export function normalizeBoard(raw) {
  const empty = {
    '15m': {},
    '1h': {},
    '4h': {},
    '1d': {},
    usdtD: { '15m': null, '1h': null },
  };
  if (!raw || typeof raw !== 'object') return empty;
  if (raw['15m'] || raw['1h'] || raw['4h'] || raw['1d'] || raw.usdtD) {
    const out = {
      '15m': raw['15m'] && typeof raw['15m'] === 'object' ? raw['15m'] : {},
      '1h': raw['1h'] && typeof raw['1h'] === 'object' ? raw['1h'] : {},
      '4h': raw['4h'] && typeof raw['4h'] === 'object' ? raw['4h'] : {},
      '1d': raw['1d'] && typeof raw['1d'] === 'object' ? raw['1d'] : {},
      usdtD: raw.usdtD && typeof raw.usdtD === 'object' ? raw.usdtD : empty.usdtD,
      errors: raw.errors || [],
    };
    return enrichBoardMacdKdj(out);
  }
  const h1 = {};
  for (const coin of Object.keys(STRATEGY_SYMBOLS)) {
    if (raw[coin] && raw[coin].lastSignal) h1[coin] = raw[coin];
  }
  return { ...empty, '1h': h1, errors: [] };
}

export function boardHasRows(board) {
  const b = normalizeBoard(board);
  for (const tf of EXEC_INTERVALS) {
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
  const out = {
    '15m': { ...b['15m'] },
    '1h': { ...b['1h'] },
    '4h': { ...b['4h'] },
    '1d': { ...b['1d'] },
    usdtD: { ...b.usdtD },
    errors: a.errors || [],
  };
  for (const tf of EXEC_INTERVALS) {
    for (const [coin, row] of Object.entries(a[tf] || {})) {
      if (row && row.lastSignal) out[tf][coin] = row;
    }
  }
  for (const tf of HTF_INTERVALS) {
    for (const [coin, row] of Object.entries(a[tf] || {})) {
      if (row && row.ready) out[tf][coin] = row;
    }
  }
  if (a.usdtD?.['1h']?.lastSignal) out.usdtD['1h'] = a.usdtD['1h'];
  if (a.usdtD?.['15m']?.lastSignal) out.usdtD['15m'] = a.usdtD['15m'];
  return enrichBoardMacdKdj(out);
}

async function fetchCgChart(id, days) {
  const url = `${CG}/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`coingecko ${id} ${res.status}`);
  return res.json();
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
  const intervals = opts.intervals || [...EXEC_INTERVALS, ...HTF_INTERVALS];
  const board = {
    '15m': {},
    '1h': {},
    '4h': {},
    '1d': {},
    usdtD: { '15m': null, '1h': null },
    errors: [],
  };
  const jobs = [];
  for (const interval of intervals) {
    const isHtf = HTF_INTERVALS.includes(interval);
    for (const [coin, symbol] of Object.entries(STRATEGY_SYMBOLS)) {
      jobs.push((async () => {
        try {
          let klines;
          try {
            klines = await fetchKlines(symbol, interval, KLINE_LIMIT);
          } catch {
            if (isHtf) throw new Error('htf needs binance klines');
            klines = await fetchCgKlines(coin, interval);
          }
          if (isHtf) {
            board[interval][coin] = evaluateMacdKdjSignal(klines, coin, { interval });
            if (!board[interval][coin]) board.errors.push(`${coin} ${interval}: MACD+KDJ 不足`);
          } else {
            const row = evaluateEmaTrendStrategy(klines, coin, { interval });
            board[interval][coin] = row ? attachAlphaTrend(row, klines, { interval }) : null;
            if (!board[interval][coin]) board.errors.push(`${coin} ${interval}: 指标不足`);
          }
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
  return enrichBoardMacdKdj(board);
}

export { mergeBoards };
