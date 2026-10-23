/**
 * 回踩 80。1 小时定方向和强度，15 分钟等回踩才进。
 * 4 小时只看 EMA20/50，日线只看 MACD 柱。参数按 80% 那一套，不随页面改。
 *
 * EMA 从第一根收盘价起步。ADX 是 Wilder 14：先把第 2 根起的前 14 个 TR/+DM/−DM 求和，
 * DX 攒满 14 个再平均，之后继续 Wilder。高周期只取收盘时间不晚于这根 15 分钟收盘的那根。
 */

export const M15 = 15 * 60 * 1000;
export const H1 = 60 * 60 * 1000;
export const H4 = 4 * H1;
export const D1 = 24 * H1;

export const PB80_RULES = {
  slPct: 0.018,
  tpPct: 0.006,
  partial: 0.8,
  trailPct: 0.012,
  fee: 0.0008,
  maxHold: 768,
  adxMin: 25,
  bwMin: 0.03,
};

export function emaSeries(values, period) {
  const out = new Array(values.length);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  const one = 1 - k;
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * one;
    out[i] = e;
  }
  return out;
}

export function macdHist(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => ema12[i] - ema26[i]);
  const dea = emaSeries(dif, 9);
  return dif.map((d, i) => d - dea[i]);
}

/** 布林(20, 2) 的 (上轨−下轨)/中轨。总体标准差，除以 20。 */
export function bbWidthAt(closes, i, period = 20) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += closes[j];
  const mean = sum / period;
  if (!mean) return null;
  let acc = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const d = closes[j] - mean;
    acc += d * d;
  }
  return (4 * Math.sqrt(acc / period)) / mean;
}

export function bbWidthSeries(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 19; i < closes.length; i++) out[i] = bbWidthAt(closes, i);
  return out;
}

/**
 * Wilder ADX(14)。TR/+DM/−DM 从第二根开始。
 * 第一段平滑是下标 1..14 的和，落在下标 14。第一个 ADX 是随后 14 个 DX 的平均，落在下标 27。
 */
export function wilderAdx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const adx = new Array(n).fill(null);
  if (n <= period) return adx;
  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  let str = 0;
  let sp = 0;
  let sm = 0;
  const end = Math.min(period, n - 1);
  for (let i = 1; i <= end; i++) {
    str += tr[i];
    sp += pdm[i];
    sm += mdm[i];
  }
  const dx = new Array(n).fill(null);
  const dxOf = (sTr, sP, sM) => {
    if (!(sTr > 0)) return 0;
    const pdi = (100 * sP) / sTr;
    const mdi = (100 * sM) / sTr;
    const den = pdi + mdi;
    if (!(den > 0)) return 0;
    return (100 * Math.abs(pdi - mdi)) / den;
  };
  if (end < period) return adx;
  dx[period] = dxOf(str, sp, sm);
  for (let i = period + 1; i < n; i++) {
    str = str - str / period + tr[i];
    sp = sp - sp / period + pdm[i];
    sm = sm - sm / period + mdm[i];
    dx[i] = dxOf(str, sp, sm);
  }
  const first = period + period - 1;
  if (first >= n || dx[first] == null) return adx;
  let sum = 0;
  for (let i = period; i <= first; i++) sum += dx[i];
  let a = sum / period;
  adx[first] = a;
  for (let i = first + 1; i < n; i++) {
    a = (a * (period - 1) + dx[i]) / period;
    adx[i] = a;
  }
  return adx;
}

export function barsFromKlines(rows) {
  const openTime = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  for (const r of rows) {
    const t = +r[0];
    const o = +r[1];
    const h = +r[2];
    const l = +r[3];
    const c = +r[4];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    openTime.push(t);
    open.push(o);
    high.push(h);
    low.push(l);
    close.push(c);
  }
  return { openTime, open, high, low, close, n: close.length };
}

/** 高周期开盘时间 + 周期 <= 这根 15 分钟的收盘时间。 */
export function closedIndex(openTimes, tfMs, m15Open) {
  const limit = m15Open + M15 - tfMs;
  let lo = 0;
  let hi = openTimes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (openTimes[mid] <= limit) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function prepareM15(rows) {
  const b = barsFromKlines(rows);
  b.ema7 = emaSeries(b.close, 7);
  b.ema21 = emaSeries(b.close, 21);
  return b;
}

export function prepareH1(rows) {
  const b = barsFromKlines(rows);
  b.ema7 = emaSeries(b.close, 7);
  b.ema21 = emaSeries(b.close, 21);
  b.ema55 = emaSeries(b.close, 55);
  b.bw = bbWidthSeries(b.close);
  b.adx = wilderAdx(b.high, b.low, b.close, 14);
  return b;
}

export function prepareH4(rows) {
  const b = barsFromKlines(rows);
  b.ema20 = emaSeries(b.close, 20);
  b.ema50 = emaSeries(b.close, 50);
  return b;
}

export function prepareD1(rows) {
  const b = barsFromKlines(rows);
  b.hist = macdHist(b.close);
  return b;
}

function finite(n) {
  return Number.isFinite(n);
}

function htfSide(pack, i, side) {
  const m = pack.m15;
  const h1i = closedIndex(pack.h1.openTime, H1, m.openTime[i]);
  const h4i = closedIndex(pack.h4.openTime, H4, m.openTime[i]);
  const d1i = closedIndex(pack.d1.openTime, D1, m.openTime[i]);
  const ready = h1i >= 80 && d1i >= 40 && h4i >= 60;
  const h = pack.h1;
  const up = side === 1;
  const emaStack = ready && (up
    ? h.ema7[h1i] > h.ema21[h1i] && h.ema21[h1i] > h.ema55[h1i] && h.close[h1i] > h.ema55[h1i]
    : h.ema7[h1i] < h.ema21[h1i] && h.ema21[h1i] < h.ema55[h1i] && h.close[h1i] < h.ema55[h1i]);
  const slope = ready && (up ? h.ema7[h1i] > h.ema7[h1i - 1] : h.ema7[h1i] < h.ema7[h1i - 1]);
  const hist = ready ? pack.d1.hist[d1i] : null;
  const histOk = ready && (up ? hist > 0 : hist < 0);
  const bw = ready ? h.bw[h1i] : null;
  const adx = ready ? h.adx[h1i] : null;
  const bwOk = finite(bw) && bw >= PB80_RULES.bwMin;
  const adxOk = finite(adx) && adx >= PB80_RULES.adxMin;
  const h4ok = ready && (up
    ? pack.h4.ema20[h4i] > pack.h4.ema50[h4i]
    : pack.h4.ema20[h4i] < pack.h4.ema50[h4i]);
  const pull = up
    ? m.low[i] <= m.ema21[i] && m.close[i] > m.ema7[i] && m.close[i] > m.ema21[i] && m.close[i - 1] <= m.ema21[i - 1]
    : m.high[i] >= m.ema21[i] && m.close[i] < m.ema7[i] && m.close[i] < m.ema21[i] && m.close[i - 1] >= m.ema21[i - 1];
  const checks = [
    { name: '1小时排列', pass: !!emaStack },
    { name: '1小时斜率', pass: !!slope },
    { name: '日线柱', pass: !!histOk },
    { name: '带宽', pass: bwOk },
    { name: 'ADX', pass: adxOk },
    { name: '4小时方向', pass: !!h4ok },
    { name: '15分钟回踩', pass: !!pull },
  ];
  const htfOk = emaStack && slope && histOk && bwOk && adxOk && h4ok;
  return {
    ready,
    h1i,
    h4i,
    d1i,
    htfOk,
    pull: !!pull,
    signal: htfOk && pull,
    checks,
    bw,
    adx,
    hist,
  };
}

export function readBar(pack, i) {
  const m = pack.m15;
  if (!m || i < 1 || i >= m.n) return null;
  const long = htfSide(pack, i, 1);
  const short = htfSide(pack, i, -1);
  let dir = 0;
  let state = 'flat';
  if (i >= 80 && long.signal) {
    dir = 1;
    state = 'entry';
  } else if (i >= 80 && short.signal) {
    dir = -1;
    state = 'entry';
  } else if (long.htfOk) {
    dir = 1;
    state = 'wait';
  } else if (short.htfOk) {
    dir = -1;
    state = 'wait';
  }
  const picked = dir >= 0 ? long : short;
  return { i, dir, state, long, short, picked, close: m.close[i], openTime: m.openTime[i] };
}

function tradePnl(side, partial, exitPx, entry) {
  const move = side === 1 ? (exitPx / entry - 1) : (entry - exitPx) / entry;
  if (partial) return PB80_RULES.partial * PB80_RULES.tpPct + (1 - PB80_RULES.partial) * move - PB80_RULES.fee;
  return move - PB80_RULES.fee;
}

function closeTrade(pos, exitPx, reason, exitIdx) {
  return {
    side: pos.side,
    entry: pos.entry,
    entryIdx: pos.entryIdx,
    exitPx,
    exitIdx,
    reason,
    partial: pos.partial,
    pnl: tradePnl(pos.side, pos.partial, exitPx, pos.entry),
  };
}

/** 一根里先看止损。80% 打掉的那根不再用反向影线打剩余仓。 */
function stepPosition(pos, bar, i, lastBar) {
  const E = pos.entry;
  const o = bar.open[i];
  const h = bar.high[i];
  const l = bar.low[i];
  const c = bar.close[i];
  const deadline = i >= pos.entryIdx + PB80_RULES.maxHold - 1 || i === lastBar;
  if (!pos.partial) {
    const stop = pos.side === 1 ? E * (1 - PB80_RULES.slPct) : E * (1 + PB80_RULES.slPct);
    const tp = pos.side === 1 ? E * (1 + PB80_RULES.tpPct) : E * (1 - PB80_RULES.tpPct);
    const gapStop = pos.side === 1 ? o <= stop : o >= stop;
    if (gapStop) return closeTrade(pos, o, 'stop', i);
    const hitStop = pos.side === 1 ? l <= stop : h >= stop;
    if (hitStop) return closeTrade(pos, stop, 'stop', i);
    const hitTp = pos.side === 1 ? h >= tp : l <= tp;
    if (hitTp) {
      pos.partial = true;
      pos.partialIdx = i;
      pos.peak = pos.side === 1 ? h : l;
      if (deadline) return closeTrade(pos, c, 'time', i);
      return null;
    }
    if (deadline) return closeTrade(pos, c, 'time', i);
    return null;
  }
  if (i === pos.partialIdx) return null;
  const trail = pos.side === 1 ? pos.peak * (1 - PB80_RULES.trailPct) : pos.peak * (1 + PB80_RULES.trailPct);
  const stop = pos.side === 1 ? Math.max(E, trail) : Math.min(E, trail);
  const gapStop = pos.side === 1 ? o <= stop : o >= stop;
  if (gapStop) return closeTrade(pos, o, 'trail', i);
  const hitStop = pos.side === 1 ? l <= stop : h >= stop;
  if (hitStop) return closeTrade(pos, stop, 'trail', i);
  pos.peak = pos.side === 1 ? Math.max(pos.peak, h) : Math.min(pos.peak, l);
  if (deadline) return closeTrade(pos, c, 'time', i);
  return null;
}

export function simulatePb80(pack, opts = {}) {
  const m = pack.m15;
  const start = opts.startIndex ?? 80;
  const fromTime = opts.fromTime ?? -Infinity;
  const trades = [];
  let pos = null;
  const last = m.n - 1;
  for (let i = 0; i <= last; i++) {
    if (pos && i >= pos.entryIdx) {
      const closed = stepPosition(pos, m, i, last);
      if (closed) {
        if (m.openTime[closed.entryIdx] >= fromTime) trades.push(closed);
        pos = null;
      }
    }
    if (!pos && i >= start && i < last) {
      const view = readBar(pack, i);
      if (view && view.state === 'entry') {
        pos = {
          side: view.dir,
          entryIdx: i + 1,
          entry: m.open[i + 1],
          signalTime: m.openTime[i],
          partial: false,
          partialIdx: -1,
          peak: null,
        };
      }
    }
  }
  return trades;
}

export function summarizeTrades(trades) {
  const wins = trades.filter((t) => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    n: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    pnl,
    usdt: pnl * 300,
  };
}

function fmtNum(n, d = 2) {
  if (!finite(n)) return '--';
  return n.toFixed(d);
}

function sideMeter(side) {
  if (!side) return { adx: null, bw: null };
  return { adx: side.adx, bw: side.bw };
}

export function describeRead(view) {
  const ratios = '止损 1.8% · 80% 仓止盈 +0.6% · 余仓止损不低于开仓价，峰值回撤 1.2%';
  if (!view || !view.long.ready) {
    return {
      dir: 0,
      state: 'flat',
      label: '数据不够',
      why: '1 小时、4 小时或日线还没攒到规则要求的根数。',
      ratios,
      checks: [],
      adx: null,
      bw: null,
    };
  }
  const sideName = view.dir === 1 ? '多' : view.dir === -1 ? '空' : '';
  const checks = view.dir === 0 ? view.long.checks : view.picked.checks;
  if (view.state === 'entry') {
    return {
      dir: view.dir,
      state: 'entry',
      label: view.dir === 1 ? '试多' : '试空',
      why: '这根 15 分钟收盘确认回踩。进场用下一根开盘价；若这根已经开盘，就是当前这根的开盘。持仓期间不再接新信号。',
      ratios,
      checks,
      ...sideMeter(view.picked),
    };
  }
  if (view.state === 'wait') {
    const miss = view.picked.checks.filter((c) => !c.pass).map((c) => c.name);
    return {
      dir: view.dir,
      state: 'wait',
      label: view.dir === 1 ? '等回踩多' : '等回踩空',
      why: `1 小时方向、日线柱、4 小时和 ADX 已经站在${sideName}这边。15 分钟还没走出回踩，${miss[0] || '回踩'}没齐就不进。`,
      ratios,
      checks,
      ...sideMeter(view.picked),
    };
  }
  const longPass = view.long.checks.filter((c) => c.pass).length;
  const shortPass = view.short.checks.filter((c) => c.pass).length;
  const nearer = longPass >= shortPass ? view.long : view.short;
  const fail = nearer.checks.filter((c) => !c.pass).map((c) => c.name);
  const bw = fmtNum((nearer.bw || 0) * 100, 2);
  const adx = fmtNum(nearer.adx, 1);
  return {
    dir: 0,
    state: 'flat',
    label: '不开',
    why: `这根 15 分钟没有同时满足的一边。靠近的一侧还差 ${fail.join('、') || '条件'}。1 小时带宽 ${bw}%，ADX ${adx}。`,
    ratios,
    checks: nearer.checks,
    ...sideMeter(nearer),
  };
}

/** 用已经收盘的 15 分钟。最后一根还没收完就看前一根。 */
export function readLatest(pack, now = Date.now()) {
  const m = pack.m15;
  if (!m || m.n < 2) return describeRead(null);
  let i = m.n - 1;
  if (m.openTime[i] + M15 > now) i -= 1;
  if (i < 1) return describeRead(null);
  return { ...describeRead(readBar(pack, i)), openTime: m.openTime[i], close: m.close[i] };
}

export function dropForming(rows, tfMs, now = Date.now()) {
  if (!rows.length) return rows;
  const last = rows[rows.length - 1];
  if (+last[0] + tfMs > now) return rows.slice(0, -1);
  return rows;
}
