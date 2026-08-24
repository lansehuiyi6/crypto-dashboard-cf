/**
 * EMA7/21 × EMA56 趋势跟随（对应用户 Pine 策略）
 * 1h K 线：EMA56 为多空分界，EMA7 穿越 56 为信号，MACD 0 轴 + RSI6 过滤
 */

export const STRATEGY_SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  BNB: 'BNBUSDT',
  SOL: 'SOLUSDT',
  XAU: 'XAUUSDT',
};

const RSI_PERIOD = 6;
const RSI_MAX = 65;
const RSI_MIN = 30;
const STOP_PCT = 2;
const TAKE_PCT = 4;
const LOOKBACK = 8;
const FAPI_KLINES = 'https://fapi.binance.com/fapi/v1/klines';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)',
  Accept: 'application/json',
};

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  const out = new Array(period - 1).fill(null);
  out.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcRMA(values, period) {
  if (!values || values.length < period) return null;
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let rma = sum / period;
  out[period - 1] = rma;
  for (let i = period; i < values.length; i++) {
    rma = (rma * (period - 1) + values[i]) / period;
    out[i] = rma;
  }
  return out;
}

function calcRSI(closes, period = RSI_PERIOD) {
  if (!closes || closes.length < period + 2) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const avgG = calcRMA(gains, period);
  const avgL = calcRMA(losses, period);
  if (!avgG || !avgL) return null;
  const rsi = new Array(closes.length).fill(null);
  for (let i = 0; i < avgG.length; i++) {
    const g = avgG[i];
    const l = avgL[i];
    if (g == null || l == null) continue;
    const rs = l === 0 ? 100 : g / l;
    rsi[i + 1] = 100 - 100 / (1 + rs);
  }
  return rsi;
}

function lastNum(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null && Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

function crossedUp(a, b, i) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null
    && a[i - 1] <= b[i - 1] && a[i] > b[i];
}

function crossedDown(a, b, i) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null
    && a[i - 1] >= b[i - 1] && a[i] < b[i];
}

function barsAgo(pred, from, lookback) {
  for (let i = 0; i <= lookback; i++) {
    const idx = from - i;
    if (idx < 1) break;
    if (pred(idx)) return i;
  }
  return null;
}

function fmt(n, price) {
  if (!Number.isFinite(n)) return '--';
  if (price >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (price >= 100) return '$' + n.toFixed(0);
  if (price >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}

/**
 * Pine 里 macd_strong_threshold=0.5 是绝对价格差，多币种不可比。
 * 按 0.5 / 10000 换成相对阈值，BTC 约 4、SOL 约 0.005。
 */
function macdStrongThreshold(close) {
  return Math.max(close * 0.00005, 1e-8);
}

export function evaluateEmaTrendStrategy(klines, coin = '') {
  const closes = (klines || []).map((k) => (Array.isArray(k) ? Number(k[4]) : Number(k.c ?? k.close)));
  if (closes.length < 80) return null;

  const ema7 = calcEMA(closes, 7);
  const ema21 = calcEMA(closes, 21);
  const ema56 = calcEMA(closes, 56);
  const rsi = calcRSI(closes, RSI_PERIOD);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema7 || !ema21 || !ema56 || !ema12 || !ema26 || !rsi) return null;

  const dif = ema12.map((v, i) => (v == null || ema26[i] == null ? null : v - ema26[i]));
  const firstDif = dif.findIndex((v) => v != null);
  const difCompact = firstDif >= 0 ? dif.slice(firstDif) : [];
  const deaCompact = calcEMA(difCompact, 9);
  const deaAligned = new Array(dif.length).fill(null);
  if (deaCompact && firstDif >= 0) {
    for (let j = 0; j < deaCompact.length; j++) deaAligned[firstDif + j] = deaCompact[j];
  }

  const i = closes.length - 1;
  const close = closes[i];
  const d7 = ema7[i];
  const d21 = ema21[i];
  const d56 = ema56[i];
  const difNow = dif[i];
  const deaNow = deaAligned[i];
  const rsiNow = rsi[i];
  if ([close, d7, d21, d56, difNow, rsiNow].some((v) => v == null)) return null;

  const macdDiff = Math.abs(difNow - (deaNow ?? 0));
  const macdAboveZero = difNow > 0;
  const macdBelowZero = difNow < 0;
  const strongLong = macdDiff > macdStrongThreshold(close) && difNow > (deaNow ?? 0);
  const strongShort = macdDiff > macdStrongThreshold(close) && difNow < (deaNow ?? 0);

  const emaAllAbove = d7 > d56 && d21 > d56;
  const emaAllBelow = d7 < d56 && d21 < d56;

  const up56Ago = barsAgo((idx) => crossedUp(ema7, ema56, idx), i, LOOKBACK);
  const down56Ago = barsAgo((idx) => crossedDown(ema7, ema56, idx), i, LOOKBACK);
  const goldenAgo = barsAgo((idx) => crossedUp(ema7, ema21, idx), i, LOOKBACK);
  const deadAgo = barsAgo((idx) => crossedDown(ema7, ema21, idx), i, LOOKBACK);

  const longSetup = up56Ago != null && close > d56 && macdAboveZero && (strongLong || rsiNow < RSI_MAX);
  const shortSetup = down56Ago != null && close < d56 && macdBelowZero && (strongShort || rsiNow > RSI_MIN);

  let setup = 'watch';
  let setupLabel = '观望';
  if (longSetup && !shortSetup) {
    setup = 'long';
    setupLabel = up56Ago === 0 ? '做多' : `做多 · ${up56Ago}h前上穿56`;
  } else if (shortSetup && !longSetup) {
    setup = 'short';
    setupLabel = down56Ago === 0 ? '做空' : `做空 · ${down56Ago}h前下穿56`;
  }

  let trend = 'mixed';
  let trendLabel = '均线纠缠';
  if (emaAllAbove) {
    trend = 'long';
    trendLabel = '多头排列 (7/21 > 56)';
  } else if (emaAllBelow) {
    trend = 'short';
    trendLabel = '空头排列 (7/21 < 56)';
  }

  const stopLoss = setup === 'short' ? close * (1 + STOP_PCT / 100) : close * (1 - STOP_PCT / 100);
  const takeProfit = setup === 'short' ? close * (1 - TAKE_PCT / 100) : close * (1 + TAKE_PCT / 100);

  const bits = [];
  if (up56Ago === 0) bits.push('EMA7上穿56');
  if (down56Ago === 0) bits.push('EMA7下穿56');
  if (goldenAgo === 0) bits.push('7/21金叉');
  if (deadAgo === 0) bits.push('7/21死叉');
  bits.push(macdAboveZero ? 'MACD>0' : 'MACD<0');
  bits.push(`RSI6 ${rsiNow.toFixed(0)}`);
  if (strongLong || strongShort) bits.push('MACD强势跳过RSI');

  return {
    coin,
    interval: '1h',
    price: close,
    ema7: d7,
    ema21: d21,
    ema56: d56,
    rsi6: rsiNow,
    macdDif: difNow,
    macdDea: deaNow,
    trend,
    trendLabel,
    setup,
    setupLabel,
    crossedAgo: { up56: up56Ago, down56: down56Ago, golden: goldenAgo, dead: deadAgo },
    filters: {
      macdZero: setup === 'short' ? macdBelowZero : macdAboveZero,
      rsiOk: setup === 'short' ? rsiNow > RSI_MIN : rsiNow < RSI_MAX,
      macdStrong: setup === 'short' ? strongShort : strongLong,
    },
    stopLoss,
    takeProfit,
    stopText: fmt(stopLoss, close),
    tpText: fmt(takeProfit, close),
    note: bits.join(' · '),
  };
}

export async function fetchKlines(symbol, interval = '1h', limit = 200) {
  const url = `${FAPI_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`klines ${symbol} ${res.status}`);
  return res.json();
}

export async function fetchAllStrategies(interval = '1h') {
  const out = {};
  await Promise.all(Object.entries(STRATEGY_SYMBOLS).map(async ([coin, symbol]) => {
    try {
      const klines = await fetchKlines(symbol, interval, 200);
      out[coin] = evaluateEmaTrendStrategy(klines, coin);
    } catch {
      out[coin] = null;
    }
  }));
  return out;
}
