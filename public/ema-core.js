/**
 * EMA 纯计算（浏览器 / Worker 共用）
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
const INTERVAL_MS = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000 };
const SETUP_LOOKBACK = { '15m': 16, '1h': 12 };

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

function crossedUp(a, b, i) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null
    && a[i - 1] <= b[i - 1] && a[i] > b[i];
}

function crossedDown(a, b, i) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null
    && a[i - 1] >= b[i - 1] && a[i] < b[i];
}

function findLastCross(fast, slow, from) {
  for (let i = from; i >= 1; i--) {
    if (crossedUp(fast, slow, i)) return { dir: 'up', index: i };
    if (crossedDown(fast, slow, i)) return { dir: 'down', index: i };
  }
  return null;
}

function formatAgo(barsAgo, interval) {
  if (barsAgo == null) return '--';
  if (barsAgo === 0) return '当前K线';
  const minutes = interval === '15m' ? barsAgo * 15 : barsAgo * 60;
  if (minutes < 60) return `${minutes} 分钟前（${barsAgo}根${interval}）`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) {
    return rest
      ? `${hours}小时${rest}分前（${barsAgo}根${interval}）`
      : `${hours} 小时前（${barsAgo}根${interval}）`;
  }
  const days = Math.floor(hours / 24);
  return `${days} 天前（${barsAgo}根${interval}）`;
}

function fmtUsd(n, price) {
  if (!Number.isFinite(n)) return '--';
  if (price >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (price >= 100) return '$' + n.toFixed(0);
  if (price >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}

function fmtPctVal(n) {
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(2) + '%';
}

function macdStrongThreshold(close) {
  return Math.max(Math.abs(close) * 0.00005, 1e-8);
}

export function evaluateEmaTrendStrategy(klines, coin = '', opts = {}) {
  const interval = opts.interval || '1h';
  const valueKind = opts.valueKind || 'usd';
  const inverse = !!opts.inverse;
  const fmtVal = (n, ref) => (valueKind === 'pct' ? fmtPctVal(n) : fmtUsd(n, ref));

  const closes = (klines || []).map((k) => (Array.isArray(k) ? Number(k[4]) : Number(k.c ?? k.close)));
  const times = (klines || []).map((k) => (Array.isArray(k) ? Number(k[0]) : Number(k.t || 0)));
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

  const last = findLastCross(ema7, ema56, i);
  const lastSignal = last ? {
    dir: last.dir,
    label: last.dir === 'up' ? '上穿56' : '下穿56',
    barsAgo: i - last.index,
    timeAgoText: formatAgo(i - last.index, interval),
    time: times[last.index] || null,
    price: closes[last.index],
    priceText: fmtVal(closes[last.index], close),
    held: false,
  } : {
    dir: d7 > d56 ? 'up' : 'down',
    label: d7 > d56 ? '上穿后维持' : '下穿后维持',
    barsAgo: null,
    timeAgoText: `近${closes.length}根内未再交叉`,
    time: null,
    price: close,
    priceText: fmtVal(close, close),
    held: true,
  };

  const lookback = SETUP_LOOKBACK[interval] || 12;
  const recentUp = lastSignal && lastSignal.dir === 'up' && lastSignal.barsAgo <= lookback;
  const recentDown = lastSignal && lastSignal.dir === 'down' && lastSignal.barsAgo <= lookback;
  const longSetup = recentUp && close > d56 && macdAboveZero && (strongLong || rsiNow < RSI_MAX);
  const shortSetup = recentDown && close < d56 && macdBelowZero && (strongShort || rsiNow > RSI_MIN);

  let setup = 'watch';
  let setupLabel = '观望';
  if (longSetup && !shortSetup) {
    setup = 'long';
    setupLabel = lastSignal.barsAgo === 0 ? '做多' : `做多（${lastSignal.timeAgoText}上穿）`;
  } else if (shortSetup && !longSetup) {
    setup = 'short';
    setupLabel = lastSignal.barsAgo === 0 ? '做空' : `做空（${lastSignal.timeAgoText}下穿）`;
  }

  let trend = 'mixed';
  let trendLabel = '均线纠缠';
  if (emaAllAbove) {
    trend = 'long';
    trendLabel = '多头排列 7/21>56';
  } else if (emaAllBelow) {
    trend = 'short';
    trendLabel = '空头排列 7/21<56';
  }

  const stopLoss = setup === 'short' ? close * (1 + STOP_PCT / 100) : close * (1 - STOP_PCT / 100);
  const takeProfit = setup === 'short' ? close * (1 - TAKE_PCT / 100) : close * (1 + TAKE_PCT / 100);

  let cryptoBias = null;
  let cryptoBiasLabel = null;
  if (inverse && lastSignal) {
    if (lastSignal.dir === 'up') {
      cryptoBias = 'risk-off';
      cryptoBiasLabel = 'USDT.D 上穿 · 对 BTC/ETH 偏空';
    } else {
      cryptoBias = 'risk-on';
      cryptoBiasLabel = 'USDT.D 下穿 · 对 BTC/ETH 偏多';
    }
  }

  return {
    coin,
    interval,
    price: close,
    priceText: fmtVal(close, close),
    ema7: d7,
    ema21: d21,
    ema56: d56,
    rsi6: rsiNow,
    macdDif: difNow,
    macdDea: deaNow,
    macdAboveZero,
    trend,
    trendLabel,
    setup,
    setupLabel,
    lastSignal,
    filters: {
      macdZero: macdAboveZero,
      rsi6: rsiNow,
      rsiOkLong: rsiNow < RSI_MAX,
      rsiOkShort: rsiNow > RSI_MIN,
      macdStrong: strongLong || strongShort,
    },
    stopLoss,
    takeProfit,
    stopText: fmtVal(stopLoss, close),
    tpText: fmtVal(takeProfit, close),
    inverse,
    cryptoBias,
    cryptoBiasLabel,
    approx: !!opts.approx,
  };
}

