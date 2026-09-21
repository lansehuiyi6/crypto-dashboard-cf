/**
 * 超短线方向单（浏览器计算）
 * 价 + OI + 资金费 + 1m 针/量/CVD。清算带是近似，不是 Coinglass 热力图。
 */

export const SCALP_SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  BNB: 'BNBUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  XAU: 'XAUUSDT',
};

export function parseKline(k) {
  if (!k) return null;
  if (Array.isArray(k)) {
    const o = Number(k[1]);
    const h = Number(k[2]);
    const l = Number(k[3]);
    const c = Number(k[4]);
    const v = Number(k[5]);
    const takerBuy = Number(k[9]);
    if (![o, h, l, c, v].every(Number.isFinite)) return null;
    return {
      t: Number(k[0]) || 0,
      o, h, l, c, v,
      qv: Number(k[7]) || 0,
      n: Number(k[8]) || 0,
      takerBuy: Number.isFinite(takerBuy) ? takerBuy : 0,
    };
  }
  const o = Number(k.o ?? k.open);
  const h = Number(k.h ?? k.high);
  const l = Number(k.l ?? k.low);
  const c = Number(k.c ?? k.close);
  const v = Number(k.v ?? k.volume);
  if (![o, h, l, c, v].every(Number.isFinite)) return null;
  return {
    t: Number(k.t || k.time || 0),
    o, h, l, c, v,
    qv: Number(k.qv || 0),
    n: Number(k.n || 0),
    takerBuy: Number(k.takerBuy || 0),
  };
}

export function parseKlines(raw) {
  return (raw || []).map(parseKline).filter(Boolean);
}

export function barDelta(bar) {
  if (!bar) return 0;
  const buy = Number(bar.takerBuy) || 0;
  const sell = Math.max(0, (Number(bar.v) || 0) - buy);
  return buy - sell;
}

export function cumulativeCvd(bars) {
  let s = 0;
  return (bars || []).map((b) => {
    s += barDelta(b);
    return s;
  });
}

function median(nums) {
  const a = (nums || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

export function fundingAnnualizedPct(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  return r * 3 * 365 * 100;
}

export function classifyFunding(ann) {
  const a = Math.abs(Number(ann) || 0);
  if (a >= 150) return 'extreme';
  if (a >= 80) return 'high';
  if (a >= 30) return 'warm';
  return 'mild';
}

export function oiChangePct(hist, fromIdx = 0) {
  const rows = Array.isArray(hist) ? hist : [];
  if (rows.length < 3) return null;
  const i0 = Math.max(0, fromIdx);
  const first = Number(rows[i0]?.sumOpenInterest);
  const last = Number(rows[rows.length - 1]?.sumOpenInterest);
  return pct(first, last);
}

export function priceChangePct(bars) {
  const list = bars || [];
  if (list.length < 2) return null;
  return pct(list[0].c, list[list.length - 1].c);
}

export function sessionVwap(bars) {
  let pv = 0;
  let vv = 0;
  for (const b of bars || []) {
    const typ = (b.h + b.l + b.c) / 3;
    const vol = Number(b.v) || 0;
    if (!Number.isFinite(typ) || vol <= 0) continue;
    pv += typ * vol;
    vv += vol;
  }
  if (vv <= 0) return null;
  return pv / vv;
}

export function depthView(depth, lastPrice, coin = '') {
  const bids = (depth && depth.bids) || [];
  const asks = (depth && depth.asks) || [];
  const px = Number(lastPrice);
  const sumSide = (levels) => {
    let qty = 0;
    let notional = 0;
    for (const row of levels.slice(0, 5)) {
      const p = Number(Array.isArray(row) ? row[0] : row.price);
      const q = Number(Array.isArray(row) ? row[1] : row.qty);
      if (!Number.isFinite(p) || !Number.isFinite(q)) continue;
      qty += q;
      notional += p * q;
    }
    return { qty, notional };
  };
  const bid = sumSide(bids);
  const ask = sumSide(asks);
  const bestBid = Number(Array.isArray(bids[0]) ? bids[0][0] : NaN);
  const bestAsk = Number(Array.isArray(asks[0]) ? asks[0][0] : NaN);
  const spread = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? bestAsk - bestBid : null;
  const spreadBps = spread != null && Number.isFinite(px) && px > 0 ? (spread / px) * 10000 : null;
  const major = coin === 'BTC' || coin === 'ETH';
  const maxSpread = major ? 2.5 : 10;
  const minNotional = major ? 40000 : 6000;
  const thin = (spreadBps != null && spreadBps > maxSpread)
    || bid.notional < minNotional
    || ask.notional < minNotional;
  return {
    bidNotional: bid.notional,
    askNotional: ask.notional,
    spread,
    spreadBps,
    thin,
    ok: bids.length > 0 && asks.length > 0,
  };
}

/**
 * 四象限 + 常见补充。窗口约 1h（价用 1m，OI 用 5m 序列）。
 */
export function classifyQuadrant({ pricePct, oiPct, fundingAnn }) {
  const p = Number(pricePct);
  const o = Number(oiPct);
  const f = Number(fundingAnn);
  if (![p, o].every(Number.isFinite)) {
    return { id: 'unknown', tag: '数据不足', cls: 'watch', hint: 'OI 或价格序列不够，先不判方向健康度。' };
  }
  const priceUp = p > 0.18;
  const priceDn = p < -0.18;
  const priceFlat = !priceUp && !priceDn;
  const oiUp = o > 0.35;
  const oiDn = o < -0.35;
  const fundLvl = classifyFunding(f);
  const fundHighPos = Number.isFinite(f) && f >= 80;
  const fundHighNeg = Number.isFinite(f) && f <= -80;
  const fundMild = !Number.isFinite(f) || fundLvl === 'mild';

  if (priceUp && oiUp && fundHighPos) {
    return {
      id: 'crowded_long',
      tag: '多头拥挤',
      cls: 'short',
      hint: '价涨 + OI 升 + 资金费极正：多头拥挤，减仓或准备反抽，不要再加杠杆追。',
    };
  }
  if (priceUp && oiUp && fundMild) {
    return {
      id: 'healthy_long',
      tag: '趋势健康',
      cls: 'long',
      hint: '价涨 + OI 升 + 资金费温和：趋势健康，顺势、杠杆低。',
    };
  }
  if (priceDn && oiDn) {
    return {
      id: 'long_wash',
      tag: '多头被洗',
      cls: 'watch',
      hint: '价跌 + OI 降：多头被洗，不一定立刻抄底，等 OI 降完、费率回归。',
    };
  }
  if (priceFlat && fundHighPos) {
    return {
      id: 'air_long',
      tag: '猎杀风险',
      cls: 'short',
      hint: '价滞 + 高正费率：多头在给空气付费，下方若有清算堆更容易被猎杀。',
    };
  }
  if (priceDn && oiUp && fundHighNeg) {
    return {
      id: 'crowded_short',
      tag: '空头拥挤',
      cls: 'long',
      hint: '价跌 + OI 升 + 资金费极负：空头拥挤，反抽风险大于继续加空。',
    };
  }
  if (priceDn && oiUp && fundMild) {
    return {
      id: 'healthy_short',
      tag: '空头趋势',
      cls: 'short',
      hint: '价跌 + OI 升 + 费率温和：空头在加仓，顺势做空比抄底更合适。',
    };
  }
  if (priceUp && oiDn) {
    return {
      id: 'short_cover',
      tag: '空头回补',
      cls: 'watch',
      hint: '价涨但 OI 降：更像空头回补，不是新多进场，追高谨慎。',
    };
  }
  return {
    id: 'mixed',
    tag: '结构含糊',
    cls: 'watch',
    hint: '价 / OI / 费率没有形成清晰四象限，超短线宁可空仓。',
  };
}

function closedBars(bars) {
  const list = bars || [];
  if (list.length < 3) return list.slice();
  return list.slice(0, -1);
}

function findSweep(bars) {
  const list = closedBars(bars);
  if (list.length < 20) return null;
  const look = list.slice(-36);
  const ranges = look.map((b) => b.h - b.l);
  const vols = look.map((b) => b.v);
  const medR = median(ranges);
  const medV = median(vols);
  if (!medR || !medV) return null;

  for (let i = look.length - 1; i >= Math.max(0, look.length - 10); i--) {
    const b = look[i];
    const range = b.h - b.l;
    if (range <= 0) continue;
    const lower = Math.min(b.o, b.c) - b.l;
    const upper = b.h - Math.max(b.o, b.c);
    const spike = range >= 1.45 * medR && b.v >= 1.6 * medV;
    if (!spike) continue;
    const lowerPct = lower / range;
    const upperPct = upper / range;
    let side = null;
    if (lowerPct >= 0.52 && lowerPct >= upperPct) side = 'long_liq';
    else if (upperPct >= 0.52 && upperPct >= lowerPct) side = 'short_liq';
    if (!side) continue;
    const absIdx = list.length - look.length + i;
    return {
      side,
      bar: b,
      index: absIdx,
      range,
      lowerPct,
      upperPct,
      volRatio: medV ? b.v / medV : null,
      bounceDir: side === 'long_liq' ? 'long' : 'short',
    };
  }
  return null;
}

function oiAfterSweep(oiHist, sweepTime) {
  const rows = Array.isArray(oiHist) ? oiHist : [];
  if (!rows.length || !sweepTime) return null;
  const after = rows.filter((r) => Number(r.timestamp) >= sweepTime);
  const before = rows.filter((r) => Number(r.timestamp) < sweepTime);
  const a0 = Number((before[before.length - 1] || after[0])?.sumOpenInterest);
  const a1 = Number(rows[rows.length - 1]?.sumOpenInterest);
  if (!Number.isFinite(a0) || !Number.isFinite(a1) || a0 === 0) return null;
  return ((a1 - a0) / a0) * 100;
}

export function detectSweepBounce(bars1m, oiHist) {
  const sweep = findSweep(bars1m);
  if (!sweep) return { kind: 'none' };
  const list = closedBars(bars1m);
  const after = list.slice(sweep.index + 1);
  const cvdAll = cumulativeCvd(list);
  const cvdSweep = cvdAll[sweep.index];
  const cvdLast = cvdAll[cvdAll.length - 1];
  const last = list[list.length - 1];
  const oiDelta = oiAfterSweep(oiHist, sweep.bar.t);
  const reclaim = sweep.bounceDir === 'long'
    ? last.c >= sweep.bar.l + sweep.range * 0.28
    : last.c <= sweep.bar.h - sweep.range * 0.28;
  const cvdFlatten = sweep.bounceDir === 'long'
    ? Number.isFinite(cvdLast) && Number.isFinite(cvdSweep) && cvdLast >= cvdSweep - Math.abs(cvdSweep) * 0.08
    : Number.isFinite(cvdLast) && Number.isFinite(cvdSweep) && cvdLast <= cvdSweep + Math.abs(cvdSweep) * 0.08;
  const continued = sweep.bounceDir === 'long'
    ? last.c < sweep.bar.l
    : last.c > sweep.bar.h;
  const cascade = continued && (oiDelta == null || oiDelta > 0.15);
  const oiDropped = oiDelta != null && oiDelta < -0.25;

  if (cascade) {
    return {
      kind: 'cascade',
      play: 'A',
      dir: sweep.bounceDir,
      sweep,
      oiDelta,
      reason: '扫完 OI 没降、价格继续顺着针方向走，更像级联，别抄。',
    };
  }
  if (!after.length) {
    return {
      kind: 'wait',
      play: 'A',
      dir: sweep.bounceDir,
      sweep,
      oiDelta,
      reason: '刚出现长针放量，等下一根确认 CVD 走平、价格收回。',
    };
  }
  if (reclaim && cvdFlatten && (oiDropped || oiDelta == null)) {
    const stop = sweep.bounceDir === 'long' ? sweep.bar.l * 0.9992 : sweep.bar.h * 1.0008;
    const pre = list.slice(Math.max(0, sweep.index - 12), sweep.index);
    const balance = pre.length ? (Math.max(...pre.map((b) => b.h)) + Math.min(...pre.map((b) => b.l))) / 2 : last.c;
    return {
      kind: 'entry',
      play: 'A',
      dir: sweep.bounceDir,
      sweep,
      oiDelta,
      entry: last.c,
      stop,
      target: balance,
      reason: oiDropped
        ? '长针+放量后价格收回，CVD 不再创新极端，OI 回落，更像扫完耗竭。'
        : '长针+放量后价格收回且 CVD 走平。OI 序列不够时只当近似，仓要更小。',
    };
  }
  return {
    kind: 'watch',
    play: 'A',
    dir: sweep.bounceDir,
    sweep,
    oiDelta,
    reason: '有扫簇近似，但收回/CVD/OI 还没齐，先不进。',
  };
}

export function detectPullback(bias15, bars1m) {
  if (bias15 !== 'long' && bias15 !== 'short') {
    return { kind: 'none', reason: '15m 没有明确方向，不在 1m 上硬做趋势。' };
  }
  const list = closedBars(bars1m);
  if (list.length < 30) return { kind: 'none', reason: '1m 根数不足。' };
  const window = list.slice(-45);
  const vwap = sessionVwap(window);
  if (!vwap) return { kind: 'none' };
  const last5 = window.slice(-5);
  const last3 = window.slice(-3);
  const last = window[window.length - 1];
  const touched = last5.some((b) => b.l <= vwap * 1.0006 && b.h >= vwap * 0.9994);
  const deltas = last3.map(barDelta);
  const prev = window.slice(-8, -3).map(barDelta);
  const d3 = deltas.reduce((a, b) => a + b, 0);
  const dPrev = prev.reduce((a, b) => a + b, 0) / Math.max(prev.length, 1);

  if (bias15 === 'long') {
    const recovered = last.c >= vwap * 0.9997;
    const sellFade = d3 > dPrev;
    if (touched && recovered && sellFade) {
      return {
        kind: 'entry',
        play: 'B',
        dir: 'long',
        vwap,
        entry: last.c,
        stop: Math.min(...last5.map((b) => b.l)) * 0.999,
        target: last.c + (last.c - Math.min(...last5.map((b) => b.l))),
        reason: '15m 偏多，1m 回踩 VWAP 后主动卖盘减弱。',
      };
    }
    return { kind: 'watch', play: 'B', dir: 'long', vwap, reason: '15m 偏多，但 1m 尚未回踩收回或卖盘仍强。' };
  }

  const recovered = last.c <= vwap * 1.0003;
  const buyFade = d3 < dPrev;
  if (touched && recovered && buyFade) {
    return {
      kind: 'entry',
      play: 'B',
      dir: 'short',
      vwap,
      entry: last.c,
      stop: Math.max(...last5.map((b) => b.h)) * 1.001,
      target: last.c - (Math.max(...last5.map((b) => b.h)) - last.c),
      reason: '15m 偏空，1m 反抽 VWAP 后主动买盘减弱。',
    };
  }
  return { kind: 'watch', play: 'B', dir: 'short', vwap, reason: '15m 偏空，但 1m 尚未反抽收回或买盘仍强。' };
}

function pickPlay(quad, sweep, pull, depth) {
  if (depth && depth.thin) {
    return {
      id: 'skip_thin',
      label: '盘口偏薄',
      cls: 'watch',
      hint: '买卖各边厚度不够，超短线优势容易被滑点吃掉。',
    };
  }
  if (sweep.kind === 'cascade') {
    return { id: 'skip_cascade', label: '级联勿抄', cls: 'watch', hint: sweep.reason, play: sweep };
  }
  if (quad.id === 'crowded_long' || quad.id === 'air_long') {
    if (sweep.kind === 'entry' && sweep.dir === 'short') {
      return { id: 'A_short', label: '扫簇反抽·空', cls: 'short', hint: sweep.reason, play: sweep };
    }
    return {
      id: 'reduce_long',
      label: '先减多仓',
      cls: 'watch',
      hint: quad.hint + ' 资金费只当拥挤背景，不当进场信号。',
    };
  }
  if (sweep.kind === 'entry') {
    const lab = sweep.dir === 'long' ? '扫簇反抽·多' : '扫簇反抽·空';
    return { id: 'A_' + sweep.dir, label: lab, cls: sweep.dir, hint: sweep.reason, play: sweep };
  }
  if (pull.kind === 'entry') {
    const lab = pull.dir === 'long' ? '15m多·1m回踩' : '15m空·1m反抽';
    return { id: 'B_' + pull.dir, label: lab, cls: pull.dir, hint: pull.reason, play: pull };
  }
  if (sweep.kind === 'wait' || sweep.kind === 'watch') {
    return { id: 'A_wait', label: '扫簇观察', cls: 'watch', hint: sweep.reason, play: sweep };
  }
  if (pull.kind === 'watch') {
    return { id: 'B_wait', label: '回踩观察', cls: 'watch', hint: pull.reason, play: pull };
  }
  if (quad.id === 'healthy_long' || quad.id === 'healthy_short') {
    return { id: 'bias_only', label: '结构健康·等进场', cls: quad.cls, hint: '价/OI 结构健康，但 1m 没有扫簇确认或回踩，先等。' };
  }
  return { id: 'flat', label: '观望', cls: 'watch', hint: '没有可重复的 A/B 结构。每次只做一种，不追突破兼抄反转。' };
}

function distPct(entry, stop) {
  const a = Number(entry);
  const b = Number(stop);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return Math.abs(a - b) / Math.abs(a) * 100;
}

function normalizeBracket(dir, entry, stop, coin) {
  const px = Number(entry);
  let sl = Number(stop);
  if (!Number.isFinite(px) || !Number.isFinite(sl)) return null;
  if (dir === 'long' && sl >= px) sl = px * 0.998;
  if (dir === 'short' && sl <= px) sl = px * 1.002;
  const major = coin === 'BTC' || coin === 'ETH';
  const minD = major ? 0.15 : 0.22;
  const maxD = major ? 0.40 : 0.70;
  let d = distPct(px, sl);
  if (d != null && d < minD) {
    sl = dir === 'long' ? px * (1 - minD / 100) : px * (1 + minD / 100);
    d = minD;
  }
  const risk = dir === 'long' ? px - sl : sl - px;
  const tp1 = dir === 'long' ? px + risk : px - risk;
  const tp15 = dir === 'long' ? px + risk * 1.5 : px - risk * 1.5;
  return { entry: px, stop: sl, tp1, tp15, stopPct: d, wide: d != null && d > maxD };
}

function levNote(coin) {
  if (coin === 'BTC' || coin === 'ETH') return { leverage: '5–10x 封顶', risk: '账户 0.3%–0.5%' };
  return { leverage: '2–5x 起步', risk: '账户 0.3%，止损略宽' };
}

function fmtWaitPx(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

/**
 * 始终给出开单建议：能开则给方向/限价/止损/止盈；不能开则写清等什么、为什么不开。
 */
export function buildAdvice(view = {}) {
  const coin = view.coin || '';
  const px = Number(view.price);
  const { leverage, risk } = levNote(coin);
  const action = view.action || {};
  const play = action.play || {};
  const quad = view.quad || {};
  const vwap = Number(view.vwap);
  const style = action.id && action.id.startsWith('A') ? 'A 扫簇反抽' : action.id && action.id.startsWith('B') ? 'B 1m 回踩' : '';

  const wait = (title, why, waitFor = '') => ({
    stance: 'wait',
    canOpen: false,
    cls: 'watch',
    title,
    why,
    waitFor,
    style: '',
    leverage,
    risk,
    order: '现在不挂单',
    hold: '—',
  });

  const open = (dir, entry, stop, why, styleLabel) => {
    const br = normalizeBracket(dir, entry, stop, coin);
    if (!br) return wait('现在不开', '点位算不全，先不写开仓。');
    return {
      stance: dir === 'long' ? 'open_long' : 'open_short',
      canOpen: true,
      cls: dir,
      title: dir === 'long' ? '建议轻仓试多' : '建议轻仓试空',
      style: styleLabel,
      why,
      waitFor: '',
      entry: br.entry,
      stop: br.stop,
      tp1: br.tp1,
      tp15: br.tp15,
      stopPct: br.stopPct,
      rr: '先 1:1，稳住再 1:1.5',
      leverage: br.wide ? leverage + '（止损偏宽，仓再小）' : leverage,
      risk,
      order: '优先限价，不要市价来回打',
      hold: '几秒到半小时，不隔夜',
    };
  };

  if (action.id === 'skip_thin') {
    return wait('不开：盘口偏薄', action.hint || '滑点会把超短线优势吃掉。');
  }
  if (action.id === 'skip_cascade') {
    return wait('不开：级联勿抄', action.hint || play.reason || '');
  }
  if (action.id === 'reduce_long') {
    return {
      ...wait('减多、不开新多', quad.hint || action.hint || ''),
      stance: 'reduce',
      title: '减多、不开新多',
    };
  }
  if ((action.id === 'A_long' || action.id === 'A_short' || action.id === 'B_long' || action.id === 'B_short') && play.kind === 'entry') {
    const dir = play.dir;
    const entry = Number.isFinite(play.entry) ? play.entry : px;
    const stop = play.stop;
    const why = play.reason || action.hint || '';
    return open(dir, entry, stop, why, style);
  }
  if (action.id === 'A_wait') {
    const sw = play.sweep || view.sweep && view.sweep.sweep;
    const bar = sw && sw.bar;
    const reclaim = bar && Number.isFinite(bar.l) && Number.isFinite(sw.range)
      ? (play.dir === 'short' ? bar.h - sw.range * 0.28 : bar.l + sw.range * 0.28)
      : null;
    const waitFor = reclaim
      ? `等 1m 收回至 ${fmtWaitPx(reclaim)} 附近，且 CVD 不再创新极端、OI 回落后再按反方向开。`
      : '等长针后的收回 + CVD 走平 + OI 回落，三件事齐了再开。';
    return wait('先观察，不开', play.reason || action.hint || '', waitFor);
  }
  if (action.id === 'B_wait') {
    const dirWord = play.dir === 'short' ? '反抽' : '回踩';
    const waitFor = Number.isFinite(vwap)
      ? `等 1m ${dirWord} VWAP ${fmtWaitPx(vwap)}，主动单减弱后再顺 15m 方向。`
      : '等 1m 回到 VWAP 且主动单减弱。';
    return wait('等回踩，先不开', play.reason || action.hint || '', waitFor);
  }
  if (action.id === 'bias_only') {
    const dirWord = quad.id === 'healthy_short' ? '空' : '多';
    const waitFor = Number.isFinite(vwap)
      ? `方向偏好${dirWord}，但不要追。等 1m 回 VWAP ${fmtWaitPx(vwap)} 或出现扫簇确认。`
      : `方向偏好${dirWord}，不要追现价，等 1m 回踩或扫簇。`;
    return wait('有方向，现在不开', quad.hint || action.hint || '', waitFor);
  }
  return wait('观望，不开', action.hint || quad.hint || '没有可重复的 A/B 结构。');
}

export function evaluateScalp(input = {}) {
  const bars1m = parseKlines(input.klines1m);
  const hourBars = bars1m.slice(-60);
  const pricePct = priceChangePct(hourBars.length >= 8 ? hourBars : bars1m);
  const oiPct = oiChangePct(input.oiHist, 0);
  const fundingRate = Number(input.fundingRate);
  const fundingAnn = fundingAnnualizedPct(fundingRate);
  const fundLvl = classifyFunding(fundingAnn);
  const last = bars1m[bars1m.length - 1];
  const depth = depthView(input.depth, last && last.c, input.coin);
  const quad = classifyQuadrant({ pricePct, oiPct, fundingAnn });
  const bias15 = input.bias15 === 'long' || input.bias15 === 'short' ? input.bias15 : 'watch';
  const sweep = detectSweepBounce(bars1m, input.oiHist);
  const pull = detectPullback(bias15, bars1m);
  const action = pickPlay(quad, sweep, pull, depth);
  const cvd = cumulativeCvd(closedBars(bars1m).slice(-30));
  const vwap = sessionVwap(closedBars(bars1m).slice(-45));
  const base = {
    coin: input.coin || '',
    symbol: input.symbol || '',
    price: last ? last.c : null,
    bias15,
    pricePct,
    oiPct,
    oiNow: input.oiNow != null ? Number(input.oiNow) : null,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
    fundingAnn,
    fundLvl,
    nextFundingTime: Number(input.nextFundingTime) || null,
    takerRatio: input.takerRatio != null ? Number(input.takerRatio) : null,
    quad,
    action,
    sweep,
    pull,
    depth,
    vwap,
    cvdSpark: cvd,
    ready: bars1m.length >= 40,
    ts: Date.now(),
  };
  base.advice = buildAdvice(base);
  return base;
}
