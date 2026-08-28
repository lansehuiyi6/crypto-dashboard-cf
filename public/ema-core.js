/**
 * EMA 纯计算（浏览器 / Worker 共用）
 */
export const STRATEGY_SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  BNB: 'BNBUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  XAU: 'XAUUSDT',
};

const RSI_PERIOD = 6;
const RSI_MAX = 65;
const RSI_MIN = 30;
const STOP_PCT = 2;
const TAKE_PCT = 4;
export const INTERVAL_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};
const SETUP_LOOKBACK = { '15m': 16, '1h': 12 };
export const EXEC_INTERVALS = ['15m', '1h'];
export const HTF_INTERVALS = ['4h', '1d'];

export function resampleLast(points, bucketMs) {
  const buckets = new Map();
  for (const [t, v] of points || []) {
    if (!Number.isFinite(v)) continue;
    const b = Math.floor(Number(t) / bucketMs) * bucketMs;
    buckets.set(b, v);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

export function toDominanceKlines(tetherMc, btcMc, ethMc, bucketMs, scaleTo) {
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

function barMinutes(interval) {
  if (interval === '15m') return 15;
  if (interval === '1h') return 60;
  if (interval === '4h') return 240;
  if (interval === '1d') return 1440;
  return 60;
}

function formatAgo(barsAgo, interval) {
  if (barsAgo == null) return '--';
  if (barsAgo === 0) return '当前K线';
  const minutes = barsAgo * barMinutes(interval);
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

/** pandas ewm(alpha=…, adjust=False).mean() — first finite value is the seed */
function calcEwmAlpha(values, alpha) {
  if (!values || !values.length) return null;
  const a = Math.min(Math.max(Number(alpha) || 0, 0), 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (prev == null) prev = v;
    else prev = a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/** pandas ewm(span=…, adjust=False).mean() */
function calcEwmSpan(values, span) {
  const s = Math.max(Number(span) || 1, 1);
  return calcEwmAlpha(values, 2 / (s + 1));
}

function rollingExtremum(values, period, mode) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const p = Math.max(Number(period) || 1, 1);
  for (let i = p - 1; i < n; i++) {
    let ext = mode === 'max' ? -Infinity : Infinity;
    let ok = true;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      ext = mode === 'max' ? Math.max(ext, v) : Math.min(ext, v);
    }
    out[i] = ok ? ext : null;
  }
  return out;
}

function findLastTrue(flags, from) {
  for (let i = from; i >= 0; i--) {
    if (flags[i]) return i;
  }
  return null;
}

/**
 * MACD + KDJ Signal
 * Buy when MACD hist > 0 and DIF > DEA; exit when K, D, J are all above overbought.
 * EWM 对齐 pandas ewm(..., adjust=False)，与看板 EMA 过滤里的 SMA 种子 MACD 不同。
 */
export function evaluateMacdKdjSignal(klines, coin = '', opts = {}) {
  const interval = opts.interval || '1h';
  const macdFast = Math.max(intParam(opts.macd_fast, 12), 1);
  const macdSlow = Math.max(intParam(opts.macd_slow, 26), 1);
  const macdSignal = Math.max(intParam(opts.macd_signal, 9), 1);
  const kdjN = Math.max(intParam(opts.kdj_n, 9), 1);
  const kdjKSmooth = Math.max(intParam(opts.kdj_k_smooth, 3), 1);
  const kdjDSmooth = Math.max(intParam(opts.kdj_d_smooth, 3), 1);
  const overbought = Number.isFinite(Number(opts.overbought)) ? Number(opts.overbought) : 80;

  if (!klines || klines.length < Math.max(macdSlow + macdSignal, kdjN) + 5) return null;

  const n = klines.length;
  const closes = new Array(n);
  const highs = new Array(n);
  const lows = new Array(n);
  const times = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    times[i] = Array.isArray(k) ? Number(k[0]) : Number(k.t || 0);
    highs[i] = Array.isArray(k) ? Number(k[2]) : Number(k.h);
    lows[i] = Array.isArray(k) ? Number(k[3]) : Number(k.l);
    closes[i] = Array.isArray(k) ? Number(k[4]) : Number(k.c ?? k.close);
  }

  const emaFast = calcEwmSpan(closes, macdFast);
  const emaSlow = calcEwmSpan(closes, macdSlow);
  if (!emaFast || !emaSlow) return null;

  const dif = emaFast.map((v, i) => (v == null || emaSlow[i] == null ? null : v - emaSlow[i]));
  // Seed DEA only after DIF is available: compact then align (matches typical MACD pipeline)
  const firstDif = dif.findIndex((v) => v != null);
  if (firstDif < 0) return null;
  const difCompact = dif.slice(firstDif);
  const deaCompact = calcEwmSpan(difCompact, macdSignal);
  const dea = new Array(n).fill(null);
  if (deaCompact) {
    for (let j = 0; j < deaCompact.length; j++) dea[firstDif + j] = deaCompact[j];
  }
  const hist = dif.map((v, i) => (v == null || dea[i] == null ? null : (v - dea[i]) * 2));

  const lowest = rollingExtremum(lows, kdjN, 'min');
  const highest = rollingExtremum(highs, kdjN, 'max');
  const rsv = new Array(n);
  for (let i = 0; i < n; i++) {
    if (lowest[i] == null || highest[i] == null || !Number.isFinite(closes[i])) {
      rsv[i] = 50; // pandas: NaN.fillna(50) including warmup bars
      continue;
    }
    const range = highest[i] - lowest[i];
    rsv[i] = range === 0 ? 50 : ((closes[i] - lowest[i]) / range) * 100;
  }
  const rsvSeries = rsv;
  const kArr = calcEwmAlpha(rsvSeries, 1 / kdjKSmooth);
  const kForD = (kArr || []).map((v) => (v == null ? NaN : v));
  const dArr = calcEwmAlpha(kForD, 1 / kdjDSmooth);
  const jArr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (kArr?.[i] == null || dArr?.[i] == null) continue;
    jArr[i] = 3 * kArr[i] - 2 * dArr[i];
  }

  const buyZone = new Array(n).fill(false);
  const sellZone = new Array(n).fill(false);
  const buyEdge = new Array(n).fill(false);
  const sellEdge = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const bz = hist[i] != null && dif[i] != null && dea[i] != null
      && hist[i] > 0 && dif[i] > dea[i];
    const sz = kArr?.[i] != null && dArr?.[i] != null && jArr[i] != null
      && kArr[i] > overbought && dArr[i] > overbought && jArr[i] > overbought;
    buyZone[i] = !!bz;
    sellZone[i] = !!sz;
    const prevBuy = i > 0 ? buyZone[i - 1] : false;
    const prevSell = i > 0 ? sellZone[i - 1] : false;
    buyEdge[i] = buyZone[i] && !prevBuy;
    sellEdge[i] = sellZone[i] && !prevSell;
  }

  const i = n - 1;
  if (hist[i] == null || dif[i] == null || dea[i] == null || kArr?.[i] == null || dArr?.[i] == null || jArr[i] == null) {
    return null;
  }

  const macdBull = buyZone[i];
  const overboughtNow = sellZone[i];
  let state = 'watch';
  let stateLabel = '观望';
  if (buyEdge[i]) {
    state = 'entry';
    stateLabel = '入场边沿';
  } else if (sellEdge[i]) {
    state = 'exit';
    stateLabel = '离场边沿';
  } else if (overboughtNow) {
    // 超买离场条件优先于 MACD 多头持有（可同时成立）
    state = 'overbought';
    stateLabel = '超买区';
  } else if (macdBull) {
    state = 'hold';
    stateLabel = '持有区';
  }

  const lastBuyIdx = findLastTrue(buyEdge, i);
  const lastSellIdx = findLastTrue(sellEdge, i);
  const lastBuy = lastBuyIdx == null ? null : {
    barsAgo: i - lastBuyIdx,
    timeAgoText: formatAgo(i - lastBuyIdx, interval),
    time: times[lastBuyIdx] || null,
    price: lows[lastBuyIdx] * 0.995,
  };
  const lastSell = lastSellIdx == null ? null : {
    barsAgo: i - lastSellIdx,
    timeAgoText: formatAgo(i - lastSellIdx, interval),
    time: times[lastSellIdx] || null,
    price: highs[lastSellIdx] * 1.005,
  };

  return {
    coin,
    interval,
    name: 'MACD + KDJ Signal',
    ready: true,
    macdBull,
    overbought: overboughtNow,
    buyZone: macdBull,
    sellZone: overboughtNow,
    buyEdge: buyEdge[i],
    sellEdge: sellEdge[i],
    state,
    stateLabel,
    dif: dif[i],
    dea: dea[i],
    hist: hist[i],
    k: kArr[i],
    d: dArr[i],
    j: jArr[i],
    overboughtLevel: overbought,
    lastBuy,
    lastSell,
    params: {
      macd_fast: macdFast,
      macd_slow: macdSlow,
      macd_signal: macdSignal,
      kdj_n: kdjN,
      kdj_k_smooth: kdjKSmooth,
      kdj_d_smooth: kdjDSmooth,
      overbought,
    },
  };
}

function intParam(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * 执行周期 MACD+KDJ + 4h/1d 背景：顺势入场 / 逆势试多 / 离场；1d 只作文案环境。
 */
export function annotateMacdKdjContext(mk, htf4h, htf1d) {
  if (!mk) return null;
  const h4 = htf4h && htf4h.ready ? htf4h : null;
  const d1 = htf1d && htf1d.ready ? htf1d : null;
  const htfBull = !!(h4 && h4.macdBull);
  const htfBear = !!(h4 && !h4.macdBull);
  const htfOb = !!(h4 && h4.overbought);
  const dBull = !!(d1 && d1.macdBull);
  const dOb = !!(d1 && d1.overbought);

  let action = mk.state;
  let actionLabel = mk.stateLabel;
  let bias = 'neutral';
  let reason = '仅看本周期 MACD+KDJ';

  if (mk.buyEdge) {
    if (htfBull) {
      action = 'entry';
      actionLabel = '顺势入场';
      bias = 'with';
      reason = '本周期入场边沿，且 4h MACD 多头（hist>0 且 DIF>DEA）';
    } else if (htfBear) {
      action = 'counter';
      actionLabel = '逆势试多';
      bias = 'against';
      reason = '本周期入场边沿，但 4h MACD 非多头，降权/轻仓';
    } else {
      action = 'entry';
      actionLabel = '入场边沿';
      reason = '本周期入场边沿；4h 背景未就绪';
    }
  } else if (mk.sellEdge) {
    action = 'exit';
    actionLabel = '离场边沿';
    bias = htfOb ? 'with' : 'neutral';
    reason = htfOb
      ? '本周期 KDJ 三线突破超买，4h 亦超买，优先减仓/了结'
      : '本周期 KDJ 三线突破超买（Long Exit），非反手做空';
  } else if (mk.overbought) {
    action = 'overbought';
    actionLabel = '超买区';
    reason = 'KDJ 三线仍在超买，等待离场边沿或回落（优先于 MACD 持有）';
  } else if (mk.buyZone) {
    action = 'hold';
    if (htfBull) {
      actionLabel = '持有区·顺势';
      bias = 'with';
      reason = '本周期仍在 MACD 多头区，4h 同向';
    } else if (htfBear) {
      actionLabel = '持有区·逆势';
      bias = 'against';
      reason = '本周期仍在 MACD 多头区，但 4h 非多头，留意离场';
    } else {
      actionLabel = '持有区';
    }
  }

  const bg4Label = !h4 ? '4h--' : htfOb ? '4h超买' : htfBull ? '4h多头' : '4h空头';
  const bg1Label = !d1 ? '1d--' : dOb ? '1d超买' : dBull ? '1d多头' : '1d空头';
  const envNote = d1
    ? (dOb && dBull ? '日线多头但KDJ超买' : dBull ? '日线多头环境' : '日线非多头环境')
    : '日线背景未就绪';

  return {
    ...mk,
    action,
    actionLabel,
    bias,
    reason,
    bg4Label,
    bg1Label,
    envNote,
    htf4h: h4,
    htf1d: d1,
  };
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
    crossCandidate: !!(recentUp || recentDown),
    crossCandidateLabel: recentUp ? '上穿56候选' : recentDown ? '下穿56候选' : '',
  };
}

function rollingSma(values, period, i) {
  if (i < period - 1) return null;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    if (!Number.isFinite(values[j])) return null;
    s += values[j];
  }
  return s / period;
}

function barsSinceTrue(flags, i) {
  for (let j = i; j >= 0; j--) {
    if (flags[j]) return i - j;
  }
  return null;
}

/**
 * AlphaTrend：ATR 通道 + MFI 体制过滤。
 * 用作方向开关，不单独当开仓理由。默认 multiplier=1.5（加密比 1.0 少抖）。
 */
export function evaluateAlphaTrend(klines, coin = '', opts = {}) {
  const period = opts.period || 14;
  const multiplier = opts.multiplier == null ? 1.5 : Number(opts.multiplier);
  const interval = opts.interval || '1h';
  if (!klines || klines.length < period + 5) return null;

  const n = klines.length;
  const high = new Array(n);
  const low = new Array(n);
  const close = new Array(n);
  const vol = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    high[i] = Array.isArray(k) ? Number(k[2]) : Number(k.h);
    low[i] = Array.isArray(k) ? Number(k[3]) : Number(k.l);
    close[i] = Array.isArray(k) ? Number(k[4]) : Number(k.c);
    vol[i] = Array.isArray(k) ? Number(k[5]) : Number(k.v || 0);
  }

  const tr = new Array(n).fill(null);
  const gain = new Array(n).fill(0);
  const loss = new Array(n).fill(0);
  const typical = new Array(n);
  for (let i = 0; i < n; i++) {
    typical[i] = (high[i] + low[i] + close[i]) / 3;
    if (i === 0) {
      tr[i] = high[i] - low[i];
      continue;
    }
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    const d = close[i] - close[i - 1];
    gain[i] = Math.max(d, 0);
    loss[i] = Math.max(-d, 0);
  }

  const alpha = new Array(n).fill(null);
  let prevAlpha = null;
  const buyCross = new Array(n).fill(false);
  const sellCross = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    const atr = rollingSma(tr, period, i);
    if (atr == null) continue;
    const avgG = rollingSma(gain, period, i);
    const avgL = rollingSma(loss, period, i);
    const rsi = avgL === 0 ? 100 : (avgG == null || avgL == null ? null : 100 - 100 / (1 + avgG / avgL));

    let posMf = 0;
    let negMf = 0;
    let mfiReady = i >= period;
    if (mfiReady) {
      for (let j = i - period + 1; j <= i; j++) {
        if (j === 0) continue;
        const flow = typical[j] * (vol[j] || 0);
        if (typical[j] > typical[j - 1]) posMf += flow;
        else if (typical[j] < typical[j - 1]) negMf += flow;
      }
    }
    const mfi = !mfiReady ? null : (negMf === 0 ? 100 : 100 - 100 / (1 + posMf / negMf));
    const regime = mfi != null ? mfi >= 50 : (rsi != null ? rsi >= 50 : false);

    const upT = low[i] - atr * multiplier;
    const downT = high[i] + atr * multiplier;
    let a;
    if (prevAlpha == null) {
      a = regime ? upT : downT;
    } else if (regime) {
      a = upT < prevAlpha ? prevAlpha : upT;
    } else {
      a = downT > prevAlpha ? prevAlpha : downT;
    }
    alpha[i] = a;
    prevAlpha = a;

    if (i >= 3 && alpha[i - 1] != null && alpha[i - 2] != null && alpha[i - 3] != null) {
      buyCross[i] = alpha[i] > alpha[i - 2] && alpha[i - 1] <= alpha[i - 3];
      sellCross[i] = alpha[i] < alpha[i - 2] && alpha[i - 1] >= alpha[i - 3];
    }
  }

  const i = n - 1;
  if (alpha[i] == null || alpha[i - 2] == null) return null;
  const bull = alpha[i] > alpha[i - 2];
  const bear = alpha[i] < alpha[i - 2];

  const k1 = barsSinceTrue(buyCross, i);
  const k2 = barsSinceTrue(sellCross, i);
  const o1 = i > 0 ? barsSinceTrue(buyCross, i - 1) : null;
  const o2 = i > 0 ? barsSinceTrue(sellCross, i - 1) : null;
  const buyEvent = buyCross[i] && (k2 == null || o1 == null || o1 > k2);
  const sellEvent = sellCross[i] && (k1 == null || o2 == null || o2 > k1);

  let lastBuy = null;
  let lastSell = null;
  for (let j = i; j >= period; j--) {
    if (lastBuy == null && buyCross[j]) lastBuy = i - j;
    if (lastSell == null && sellCross[j]) lastSell = i - j;
    if (lastBuy != null && lastSell != null) break;
  }

  return {
    coin,
    interval,
    multiplier,
    alpha: alpha[i],
    alpha2: alpha[i - 2],
    bull,
    bear,
    color: bull ? 'green' : 'red',
    stateLabel: bull ? 'AT多（绿）' : bear ? 'AT空（红）' : 'AT中性',
    buyEvent,
    sellEvent,
    lastBuyAgo: lastBuy,
    lastSellAgo: lastSell,
    lastEventLabel: buyEvent
      ? 'Potential BUY'
      : sellEvent
        ? 'Potential SELL'
        : (lastBuy != null && (lastSell == null || lastBuy < lastSell)
          ? `上次BUY ${formatAgo(lastBuy, interval)}`
          : lastSell != null
            ? `上次SELL ${formatAgo(lastSell, interval)}`
            : '无交叉'),
  };
}

function applyBollWidth(base, at, bb) {
  if (!bb) return base;

  const squeeze = bb.width === 'squeeze';
  const expand = bb.width === 'expand';
  const alignedLong = base.dir === 'long';
  const alignedShort = base.dir === 'short';
  const atLongWait = at && at.bull && base.dir === 'watch';
  const atShortWait = at && at.bear && base.dir === 'watch';

  if (squeeze && (alignedLong || alignedShort)) {
    return {
      dir: 'watch',
      label: '闭口暂缓',
      reason: `${bb.widthLabel}，新趋势多半还没开始，即使 EMA/AT 同向也不追。等突然开口再顺着 ${alignedLong ? '多' : '空'}`,
    };
  }
  if (expand && alignedLong) {
    const walk = bb.walkUpper || bb.zone === 'upper' || bb.zone === 'above';
    return {
      dir: 'long',
      label: '开口共振做多',
      reason: `${bb.widthLabel}像新趋势启动，AT+EMA 同向多${walk ? '，且价格沿上轨' : ''}。顺势不摸头`,
    };
  }
  if (expand && alignedShort) {
    const walk = bb.walkLower || bb.zone === 'lower' || bb.zone === 'below';
    return {
      dir: 'short',
      label: '开口共振做空',
      reason: `${bb.widthLabel}像新趋势启动，AT+EMA 同向空${walk ? '，且价格沿下轨' : ''}。顺势不抄底`,
    };
  }
  if (expand && atLongWait) {
    return {
      dir: 'watch',
      label: '开口·等EMA多',
      reason: `${bb.widthLabel}有利开多，AT 已允许多，还差 EMA 过滤做多`,
    };
  }
  if (expand && atShortWait) {
    return {
      dir: 'watch',
      label: '开口·等EMA空',
      reason: `${bb.widthLabel}有利开空，AT 已允许空，还差 EMA 过滤做空`,
    };
  }
  if (bb.width === 'stable' && (alignedLong || alignedShort)) {
    return {
      ...base,
      label: alignedLong ? '震荡环境做多' : '震荡环境做空',
      reason: `${base.reason}。但${bb.widthLabel}，更像摆动不是新趋势，仓位宜轻，按中轨思路`,
    };
  }
  return base;
}

function applyBollMid(base, at, bb, bm) {
  if (!bm) return base;
  const midLong = bm.setup === 'long';
  const midShort = bm.setup === 'short';
  if (!midLong && !midShort) return base;

  const squeeze = bb && bb.width === 'squeeze';
  const volTxt = Number.isFinite(bm.volRatio) ? `量能 ${bm.volRatio.toFixed(2)}x` : '放量';
  const midNote = `${bm.setupLabel}（${volTxt}），回中轨平、止损 1.5%`;

  if (squeeze) {
    return {
      dir: 'watch',
      label: '闭口暂缓',
      reason: base.label === '闭口暂缓'
        ? `${base.reason}。中轴已触发（${bm.setupLabel}），闭口阶段仍不追`
        : `${bb.widthLabel}，中轴虽给出${bm.setupLabel}，新趋势未开口，不追`,
    };
  }

  const withMid = (dir, label, reason) => ({
    dir,
    label: label.includes('中轴') ? label : `${label}·中轴`,
    reason: `${reason}。${midNote}`,
  });

  if (midLong && base.dir === 'long') {
    return withMid('long', base.label, base.reason);
  }
  if (midShort && base.dir === 'short') {
    return withMid('short', base.label, base.reason);
  }
  if (base.dir === 'long' || base.dir === 'short') {
    return base;
  }

  if (midLong && at && at.bear) {
    return { dir: 'watch', label: '中轴分歧', reason: `中轴做多，但 AlphaTrend ${at.stateLabel}，方向不一致先观望` };
  }
  if (midShort && at && at.bull) {
    return { dir: 'watch', label: '中轴分歧', reason: `中轴做空，但 AlphaTrend ${at.stateLabel}，方向不一致先观望` };
  }

  const emaWait = /等EMA|未过滤/.test(base.label || '');
  if (midLong && at && at.bull && (base.dir === 'watch') && emaWait) {
    return {
      dir: 'long',
      label: '中轴共振做多',
      reason: `中轴开仓触发且 AlphaTrend 允许多。EMA 过滤尚未齐，短线轻仓。${midNote}`,
    };
  }
  if (midShort && at && at.bear && (base.dir === 'watch') && emaWait) {
    return {
      dir: 'short',
      label: '中轴共振做空',
      reason: `中轴开仓触发且 AlphaTrend 允许空。EMA 过滤尚未齐，短线轻仓。${midNote}`,
    };
  }
  if (midLong && at && at.bull && base.dir === 'watch') {
    return {
      dir: 'long',
      label: '中轴共振做多',
      reason: `中轴开仓触发且 AlphaTrend 允许多。${midNote}`,
    };
  }
  if (midShort && at && at.bear && base.dir === 'watch') {
    return {
      dir: 'short',
      label: '中轴共振做空',
      reason: `中轴开仓触发且 AlphaTrend 允许空。${midNote}`,
    };
  }
  if ((midLong || midShort) && !at) {
    return {
      dir: 'watch',
      label: bm.setupLabel,
      reason: `中轴已触发，但 AlphaTrend 未就绪，不当共振开仓。${midNote}`,
    };
  }
  return base;
}

export function combineEmaAlpha(ema, at, bb, bollMid) {
  if (!ema) return null;

  let base;
  if (!at) {
    base = {
      dir: ema.setup === 'long' ? 'long' : ema.setup === 'short' ? 'short' : 'watch',
      label: ema.setupLabel || '观望',
      reason: 'AlphaTrend 未就绪，仅看 EMA 过滤开仓',
    };
  } else if (at.bull && ema.setup === 'long') {
    base = { dir: 'long', label: '共振做多', reason: 'AlphaTrend 允许多 + EMA 过滤做多' };
  } else if (at.bear && ema.setup === 'short') {
    base = { dir: 'short', label: '共振做空', reason: 'AlphaTrend 允许空 + EMA 过滤做空' };
  } else if (at.bull && ema.setup === 'short') {
    base = { dir: 'watch', label: '分歧观望', reason: 'AT 只允许多，但 EMA 过滤给出做空' };
  } else if (at.bear && ema.setup === 'long') {
    base = { dir: 'watch', label: '分歧观望', reason: 'AT 只允许空，但 EMA 过滤给出做多' };
  } else if (at.bull && ema.crossCandidate && ema.lastSignal?.dir === 'up') {
    base = { dir: 'watch', label: 'AT多·上穿未过滤', reason: '有上穿56，但 MACD/RSI 未过，不能当开仓' };
  } else if (at.bear && ema.crossCandidate && ema.lastSignal?.dir === 'down') {
    base = { dir: 'watch', label: 'AT空·下穿未过滤', reason: '有下穿56，但 MACD/RSI 未过，不能当开仓' };
  } else if (at.bull) {
    base = { dir: 'watch', label: 'AT多·等EMA', reason: '只允许做多，等 EMA 过滤做多' };
  } else if (at.bear) {
    base = { dir: 'watch', label: 'AT空·等EMA', reason: '只允许做空，等 EMA 过滤做空' };
  } else {
    base = { dir: 'watch', label: '观望', reason: 'AlphaTrend 未给出方向' };
  }

  const gated = applyBollWidth(base, at, bb);
  return applyBollMid(gated, at, bb, bollMid || ema.bollMid);
}

/**
 * 布林带 BB(20, 2)：带宽看开口/闭口/震荡，%B 看上轨/中轨/下轨。
 * 成熟用法：闭口蓄势等方向；开口顺势不摸头；宽度稳定时上轨高抛、下轨低吸。
 */
export function evaluateBollinger(klines, coin = '', opts = {}) {
  const period = opts.bbPeriod || 20;
  const k = opts.bbK == null ? 2 : Number(opts.bbK);
  const interval = opts.interval || '1h';
  if (!klines || klines.length < period + 8) return null;

  const closes = klines.map((row) => (Array.isArray(row) ? Number(row[4]) : Number(row.c)));
  const n = closes.length;
  const mid = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const bw = new Array(n).fill(null);
  const pctB = new Array(n).fill(null);

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const m = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    const u = m + k * sd;
    const l = m - k * sd;
    mid[i] = m;
    upper[i] = u;
    lower[i] = l;
    bw[i] = m > 0 ? (u - l) / m : null;
    pctB[i] = u !== l ? (closes[i] - l) / (u - l) : 0.5;
  }

  const i = n - 1;
  if (bw[i] == null || pctB[i] == null) return null;

  const look = Math.min(20, n - period);
  const hist = [];
  for (let j = i - look + 1; j <= i; j++) {
    if (bw[j] != null) hist.push(bw[j]);
  }
  const sorted = hist.slice().sort((a, b) => a - b);
  const q20 = sorted[Math.max(0, Math.floor(sorted.length * 0.2) - 1)] ?? bw[i];
  const q80 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))] ?? bw[i];
  const bw3 = bw[i - 3];
  const bw5 = bw[i - 5];
  const ch3 = bw3 ? bw[i] / bw3 - 1 : 0;
  const ch5 = bw5 ? bw[i] / bw5 - 1 : 0;

  let width = 'stable';
  let widthLabel = '宽度稳定（震荡）';
  if (bw[i] <= q20 && ch3 <= -0.08) {
    width = 'squeeze';
    widthLabel = '突然闭口';
  } else if (bw[i] <= q20) {
    width = 'squeeze';
    widthLabel = '闭口收窄';
  } else if (ch3 >= 0.18 && bw3 != null && bw3 <= q80) {
    width = 'expand';
    widthLabel = '突然开口';
  } else if (ch5 >= 0.12) {
    width = 'expand';
    widthLabel = '开口扩大';
  } else if (ch5 <= -0.12) {
    width = 'squeeze';
    widthLabel = '持续收口';
  } else if (Math.abs(ch5) < 0.08) {
    width = 'stable';
    widthLabel = '宽度稳定（震荡）';
  } else {
    width = 'stable';
    widthLabel = '带宽温和变化';
  }

  const p = pctB[i];
  let zone = 'mid';
  let zoneLabel = '中轨';
  if (p > 1.05) { zone = 'above'; zoneLabel = '上轨外'; }
  else if (p >= 0.85) { zone = 'upper'; zoneLabel = '贴上轨'; }
  else if (p >= 0.6) { zone = 'upperMid'; zoneLabel = '中上'; }
  else if (p > 0.4) { zone = 'mid'; zoneLabel = '中轨'; }
  else if (p > 0.15) { zone = 'lowerMid'; zoneLabel = '中下'; }
  else if (p >= 0) { zone = 'lower'; zoneLabel = '贴下轨'; }
  else { zone = 'below'; zoneLabel = '下轨外'; }

  const walkN = 3;
  let walkUpper = true;
  let walkLower = true;
  for (let j = i - walkN + 1; j <= i; j++) {
    if (pctB[j] == null || pctB[j] < 0.8) walkUpper = false;
    if (pctB[j] == null || pctB[j] > 0.2) walkLower = false;
  }

  let hint = '';
  if (width === 'squeeze' && (zone === 'mid' || zone === 'upperMid' || zone === 'lowerMid')) {
    hint = '闭口蓄势，等开口方向，先不追';
  } else if (width === 'squeeze' && (zone === 'upper' || zone === 'above')) {
    hint = '闭口摸上轨，假突破风险大';
  } else if (width === 'squeeze' && (zone === 'lower' || zone === 'below')) {
    hint = '闭口探下轨，假跌破风险大';
  } else if (width === 'expand' && walkUpper) {
    hint = '开口沿上轨，顺势不摸头';
  } else if (width === 'expand' && walkLower) {
    hint = '开口沿下轨，顺势不抄底';
  } else if (width === 'expand' && (zone === 'upper' || zone === 'above')) {
    hint = '开口偏上，趋势跟随，回中轨再考虑多';
  } else if (width === 'expand' && (zone === 'lower' || zone === 'below')) {
    hint = '开口偏下，趋势跟随，反抽中轨再考虑空';
  } else if (width === 'stable' && (zone === 'upper' || zone === 'above')) {
    hint = '震荡上轨，可高抛等回中轨';
  } else if (width === 'stable' && (zone === 'lower' || zone === 'below')) {
    hint = '震荡下轨，可低吸等回中轨';
  } else if (width === 'stable') {
    hint = '带宽稳定，按中轨摆动高抛低吸';
  } else {
    hint = '观察开口方向';
  }

  return {
    coin,
    interval,
    period,
    k,
    mid: mid[i],
    upper: upper[i],
    lower: lower[i],
    bandwidth: bw[i],
    bandwidthPct: bw[i] * 100,
    pctB: p,
    width,
    widthLabel,
    zone,
    zoneLabel,
    walkUpper,
    walkLower,
    hint,
    label: `${widthLabel} · ${zoneLabel}`,
  };
}

/**
 * BOLL 中轴短线：中轨分界 + EMA6/12 + 快线斜率 + 放量阳/阴线。
 * 斜率按价格归一：(ema6-ema6[5])/5/close 对比 0.0009，多币种可比较。
 * 平仓脚本：跌回中轨下平多 / 升回中轨上平空；止损 1.5%。
 */
export function evaluateBollMidStrategy(klines, coin = '', opts = {}) {
  const interval = opts.interval || '1h';
  const slopeLen = 5;
  const slopeTh = opts.slopeThreshold == null ? 0.0009 : Number(opts.slopeThreshold);
  const volMult = opts.volMultiplier == null ? 1.4 : Number(opts.volMultiplier);
  const volMaLen = 15;
  if (!klines || klines.length < 40) return null;

  const n = klines.length;
  const open = klines.map((k) => (Array.isArray(k) ? Number(k[1]) : Number(k.o)));
  const high = klines.map((k) => (Array.isArray(k) ? Number(k[2]) : Number(k.h)));
  const low = klines.map((k) => (Array.isArray(k) ? Number(k[3]) : Number(k.l)));
  const close = klines.map((k) => (Array.isArray(k) ? Number(k[4]) : Number(k.c)));
  const vol = klines.map((k) => (Array.isArray(k) ? Number(k[5]) : Number(k.v || 0)));

  const emaF = calcEMA(close, 6);
  const emaS = calcEMA(close, 12);
  if (!emaF || !emaS) return null;

  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === 0) tr[i] = high[i] - low[i];
    else tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }

  const longFlags = new Array(n).fill(false);
  const shortFlags = new Array(n).fill(false);

  for (let i = 20; i < n; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += close[j];
    const mid = sum / 20;
    if (emaF[i] == null || emaS[i] == null || emaF[i - slopeLen] == null) continue;
    const slopeAbs = (emaF[i] - emaF[i - slopeLen]) / slopeLen;
    const slopeRel = close[i] > 0 ? slopeAbs / close[i] : 0;
    let volMa = 0;
    for (let j = i - volMaLen + 1; j <= i; j++) volMa += vol[j];
    volMa /= volMaLen;
    const volBreak = volMa > 0 && vol[i] > volMa * volMult;
    const bullBar = close[i] > open[i];
    const bearBar = close[i] < open[i];
    longFlags[i] = close[i] > mid && emaF[i] > emaS[i] && slopeRel > slopeTh && volBreak && bullBar;
    shortFlags[i] = close[i] < mid && emaF[i] < emaS[i] && slopeRel < -slopeTh && volBreak && bearBar;
  }

  const i = n - 1;
  let mid = null;
  {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += close[j];
    mid = sum / 20;
  }
  const above = close[i] > mid;
  const slopeAbs = (emaF[i] - emaF[i - slopeLen]) / slopeLen;
  const slopeRel = close[i] > 0 ? slopeAbs / close[i] : 0;
  let volMa = 0;
  for (let j = i - volMaLen + 1; j <= i; j++) volMa += vol[j];
  volMa /= volMaLen;
  const volRatio = volMa > 0 ? vol[i] / volMa : 0;

  let atrNow = null;
  let atrMax = null;
  if (i >= 14) {
    let s = 0;
    for (let j = i - 13; j <= i; j++) s += tr[j];
    atrNow = s / 14;
    atrMax = atrNow;
    for (let j = i - 14; j <= i; j++) {
      if (j < 13) continue;
      let a = 0;
      for (let t = j - 13; t <= j; t++) a += tr[t];
      a /= 14;
      if (a > atrMax) atrMax = a;
    }
  }
  const squeezeRatio = atrNow && atrMax ? atrNow / atrMax : null;

  let lastLong = null;
  let lastShort = null;
  for (let j = i; j >= 20; j--) {
    if (lastLong == null && longFlags[j]) lastLong = i - j;
    if (lastShort == null && shortFlags[j]) lastShort = i - j;
    if (lastLong != null && lastShort != null) break;
  }

  const longNow = longFlags[i];
  const shortNow = shortFlags[i];
  let setup = 'watch';
  let setupLabel = '中轴观望';
  if (longNow) { setup = 'long'; setupLabel = '中轴做多'; }
  else if (shortNow) { setup = 'short'; setupLabel = '中轴做空'; }

  const missing = [];
  if (above) {
    if (!(emaF[i] > emaS[i])) missing.push('EMA6未在12上');
    if (!(slopeRel > slopeTh)) missing.push('快线斜率不够');
    if (!(volRatio > volMult)) missing.push(`量能 ${volRatio.toFixed(2)}x < ${volMult}x`);
    if (!(close[i] > open[i])) missing.push('非阳线');
  } else {
    if (!(emaF[i] < emaS[i])) missing.push('EMA6未在12下');
    if (!(slopeRel < -slopeTh)) missing.push('快线斜率不够');
    if (!(volRatio > volMult)) missing.push(`量能 ${volRatio.toFixed(2)}x < ${volMult}x`);
    if (!(close[i] < open[i])) missing.push('非阴线');
  }

  const lastLabel = lastLong != null && (lastShort == null || lastLong <= lastShort)
    ? `上次做多 ${formatAgo(lastLong, interval)}`
    : lastShort != null
      ? `上次做空 ${formatAgo(lastShort, interval)}`
      : '尚无中轴开仓';

  const exitHint = above ? '多单：跌回中轨下考虑平' : '空单：升回中轨上考虑平';

  return {
    coin,
    interval,
    setup,
    setupLabel,
    aboveMid: above,
    mid,
    ema6: emaF[i],
    ema12: emaS[i],
    slopeRel,
    volRatio,
    volBreak: volRatio > volMult,
    squeezeRatio,
    longNow,
    shortNow,
    lastLongAgo: lastLong,
    lastShortAgo: lastShort,
    lastLabel,
    missing: setup === 'watch' ? missing : [],
    exitHint,
    stopPct: 1.5,
    hint: longNow
      ? `中轨上+EMA6/12多头+放量阳线，中轴做多。止损 1.5%，${exitHint}`
      : shortNow
        ? `中轨下+EMA6/12空头+放量阴线，中轴做空。止损 1.5%，${exitHint}`
        : `中轴未开仓（${missing.slice(0, 2).join('，') || '条件未齐'}）。${exitHint}`,
  };
}

export function attachAlphaTrend(ema, klines, opts = {}) {
  if (!ema) return null;
  const at = evaluateAlphaTrend(klines, ema.coin, opts);
  ema.alpha = at;
  ema.bb = evaluateBollinger(klines, ema.coin, opts);
  ema.bollMid = evaluateBollMidStrategy(klines, ema.coin, opts);
  ema.macdKdj = evaluateMacdKdjSignal(klines, ema.coin, opts);
  ema.combined = combineEmaAlpha(ema, at, ema.bb, ema.bollMid);
  return ema;
}

