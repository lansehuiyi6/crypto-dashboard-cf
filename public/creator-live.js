/**
 * 博主读盘模拟。规则来自两位频道标题。
 * 日线定结构，4 小时定反应；两层不一致就从试多/试空退回等收盘。
 * 试多 / 试空才是开单；等收盘是条件没齐；不开就是今天没有单。
 *
 * 学习水位按视频 id，不按会随新片前移的播放列表序号。
 * 上次：zxhy 9月30日 Hy1tvue1g8Y，Ronnie 10月1日 fPvJBFrXBZk（目录停在 2026-10-01 的 300 期）。
 * 这次补到：zxhy 10月23日 _04sPZaxZ2o，Ronnie 10月22日 FVBYGJeNM2U。
 * 明细在 data/creator-study/studied.json。
 */

export const STUDY = {
  zxhy: {
    throughId: '_04sPZaxZ2o',
    throughDate: '10月23日',
    previousId: 'Hy1tvue1g8Y',
    previousDate: '9月30日',
    gap: 12,
  },
  ronnie: {
    throughId: 'FVBYGJeNM2U',
    throughDate: '10月22日',
    previousId: 'fPvJBFrXBZk',
    previousDate: '10月1日',
    gap: 14,
  },
};

const BAR_MS = { '1d': 86400000, '4h': 4 * 60 * 60 * 1000 };

const COINS = [
  { sym: 'BTC', pair: 'BTCUSDT', futures: false },
  { sym: 'ETH', pair: 'ETHUSDT', futures: false },
  { sym: 'BNB', pair: 'BNBUSDT', futures: false },
  { sym: 'SOL', pair: 'SOLUSDT', futures: false },
  { sym: 'XRP', pair: 'XRPUSDT', futures: false },
  { sym: 'DOGE', pair: 'DOGEUSDT', futures: false },
  { sym: 'XAU', pair: 'XAUUSDT', futures: true },
];

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function fmtPx(n) {
  if (!Number.isFinite(n)) return '--';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function bandWidth(closes, end) {
  const w = closes.slice(end - 20, end);
  const mid = mean(w);
  const sd = Math.sqrt(mean(w.map((c) => (c - mid) ** 2)));
  return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd, bw: mid ? (4 * sd) / mid * 100 : 0 };
}

/** 把币安 K 线收成读盘用的结构。interval 为 1d 或 4h，最后一根未收完时 candleOpen 为 true。 */
export function structureFromKlines(sym, rows, now = Date.now(), interval = '1d') {
  const opens = rows.map((r) => +r[1]);
  const highs = rows.map((r) => +r[2]);
  const lows = rows.map((r) => +r[3]);
  const closes = rows.map((r) => +r[4]);
  const vols = rows.map((r) => +r[5]);
  const n = closes.length;
  const last = closes[n - 1];
  const prev = closes[n - 2];
  const hi20 = Math.max(...highs.slice(-20));
  const lo20 = Math.min(...lows.slice(-20));
  const span = hi20 - lo20 || last * 0.01;
  const todayRange = Math.max(highs[n - 1] - lows[n - 1], last * 1e-8);
  const closePos = (last - lows[n - 1]) / todayRange;
  const bb = bandWidth(closes, n);
  const bbPrev = bandWidth(closes, n - 5);
  const lowBand = lo20 * 1.012;
  const highBand = hi20 * 0.988;
  const mid20 = (hi20 + lo20) / 2;
  let lowTests = 0;
  let highTests = 0;
  let midTests = 0;
  for (let i = n - 8; i < n; i++) {
    if (lows[i] <= lowBand) lowTests += 1;
    if (highs[i] >= highBand) highTests += 1;
    if (lows[i] <= mid20 * 1.008 && highs[i] >= mid20 * 0.992) midTests += 1;
  }
  const prevOpen = opens[n - 2];
  const prevHigh = highs[n - 2];
  const prevLow = lows[n - 2];
  const priorLo = Math.min(...lows.slice(-21, -1));
  const priorHi = Math.max(...highs.slice(-21, -1));
  const body = Math.abs(last - opens[n - 1]);
  const lowerWick = Math.min(opens[n - 1], last) - lows[n - 1];
  const upperWick = highs[n - 1] - Math.max(opens[n - 1], last);
  const openMs = +rows[n - 1][0];
  const weekSpan = Math.max(...highs.slice(-7)) - Math.min(...lows.slice(-7)) || last * 0.01;
  const weekClosePos = (last - Math.min(...lows.slice(-7))) / weekSpan;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const recentW = sum(vols.slice(-7));
  const priorW = sum(vols.slice(-14, -7));
  let flips = 0;
  for (let i = Math.max(2, n - 6); i < n; i++) {
    const a = closes[i] - closes[i - 1];
    const b = closes[i - 1] - closes[i - 2];
    if (a * b < 0 && Math.abs(a) > last * 0.0015) flips += 1;
  }
  return {
    sym,
    last,
    prev,
    open: opens[n - 1],
    high: highs[n - 1],
    low: lows[n - 1],
    hi20,
    lo20,
    pos20: (last - lo20) / span,
    ema7: ema(closes, 7),
    ema21: ema(closes, 21),
    ema56: ema(closes, 56),
    bw: bb.bw,
    bwPrev: bbPrev.bw,
    lower: bb.lower,
    dayChg: prev ? (last - prev) / prev : 0,
    closePos,
    bullish: last >= opens[n - 1],
    volRatio: mean(vols.slice(-20)) ? vols[n - 1] / mean(vols.slice(-20)) : 1,
    lowTests,
    highTests,
    midTests,
    hi7: Math.max(...highs.slice(-7)),
    lo7: Math.min(...lows.slice(-7)),
    prevOpen,
    prevHigh,
    prevLow,
    priorLo,
    priorHi,
    brokeDown: last < priorLo && closePos <= 0.35,
    brokeUp: last > priorHi && closePos >= 0.65,
    engulfBull: prev < prevOpen
      && last > opens[n - 1]
      && opens[n - 1] <= prev
      && last >= prevOpen,
    engulfBear: prev > prevOpen
      && last < opens[n - 1]
      && opens[n - 1] >= prev
      && last <= prevOpen,
    inside: highs[n - 1] < prevHigh && lows[n - 1] > prevLow,
    hammer: lowerWick > Math.max(body, last * 0.001) * 2 && upperWick <= body && closePos >= 0.6,
    star: upperWick > Math.max(body, last * 0.001) * 2 && lowerWick <= body && closePos <= 0.4,
    weekHeld: weekClosePos >= 0.62,
    weekVolRatio: priorW ? recentW / priorW : 1,
    flips,
    interval,
    ext21: 0,
    candleOpen: now < openMs + (BAR_MS[interval] || BAR_MS['1d']),
  };
}

function tightBox(m) {
  if (!m.hi7 || !m.lo7) return null;
  if ((m.hi7 - m.lo7) / m.last >= 0.09) return null;
  return {
    extra: `近 7 日还在 ${fmtPx(m.lo7)}–${fmtPx(m.hi7)} 里磨。`,
    trigger: `收盘站上 ${fmtPx(m.hi7)} 或跌破 ${fmtPx(m.lo7)} 再看`,
    invalid: '还在这 7 日盒子里就继续不开',
  };
}

function withExt(m) {
  m.ext21 = m.ema21 ? (m.last - m.ema21) / m.ema21 : 0;
  return m;
}

function dailyFactorLine(m, who) {
  const bits = [];
  if (m.engulfBear) bits.push('看跌吞没');
  if (m.engulfBull) bits.push('看涨吞没');
  if (who === 'zxhy' && m.inside && m.pos20 > 0.28 && m.pos20 < 0.78) bits.push('母子抱');
  const mid = (m.hi20 + m.lo20) / 2;
  if (m.pos20 >= 0.38 && m.pos20 <= 0.68) bits.push(`半分 ${fmtPx(mid)}`);
  else if (m.pos20 <= 0.35) bits.push('下沿');
  else if (m.pos20 >= 0.82) bits.push('前高压力');
  if (m.last >= m.ema21) bits.push(`21线上 ${fmtPx(m.ema21)}`);
  else bits.push(`21线下 ${fmtPx(m.ema21)}`);
  if (Number.isFinite(m.ema7) && Math.abs(m.ema7 - m.ema21) / m.last < 0.01) bits.push('7线21线粘住');
  if (Number.isFinite(m.ema56) && Math.abs(m.ema21 - m.ema56) / m.last < 0.012) bits.push('均线收拢');
  if (Number.isFinite(m.weekVolRatio) && m.weekVolRatio < 0.8) bits.push(`近一周量 ${m.weekVolRatio.toFixed(2)} 倍`);
  bits.push(`量能 ${Number(m.volRatio).toFixed(2)} 倍`);
  bits.push(m.bullish ? '阳线' : '阴线');
  return bits.join(' · ');
}

function h4FactorLine(h4) {
  if (!h4 || !Number.isFinite(h4.last) || !Number.isFinite(h4.ema21)) return '这轮没有4小时K线';
  const bits = [];
  if (h4.engulfBear) bits.push('看跌吞没');
  else if (h4.engulfBull) bits.push('看涨吞没');
  if (h4.low < h4.ema21 && h4.last >= h4.ema21) bits.push('回踩后站回均线');
  else if (h4.last >= h4.ema21) bits.push(`站在均线 ${fmtPx(h4.ema21)} 上`);
  else bits.push(`在均线 ${fmtPx(h4.ema21)} 下`);
  if (Number.isFinite(h4.highTests) && h4.highTests >= 2 && !h4.bullish && h4.closePos <= 0.45) bits.push('冲高回落');
  if (Number.isFinite(h4.priorLo) && h4.low < h4.priorLo && h4.last >= h4.priorLo) bits.push('扫低收回');
  if (Number.isFinite(h4.ema56) && Math.abs(h4.ema21 - h4.ema56) / h4.last < 0.01) bits.push('均线收拢');
  if (Number.isFinite(h4.pos20)) bits.push(`位置 ${h4.pos20.toFixed(2)}`);
  bits.push(h4.bullish ? '阳线' : '阴线');
  if (h4.candleOpen) bits.push('未收盘');
  return bits.join(' · ');
}

function h4Holding(h4) {
  if (!h4 || !Number.isFinite(h4.ema21) || !Number.isFinite(h4.last)) return false;
  return h4.last > h4.ema21 * 1.002 && h4.bullish && h4.closePos >= 0.58 && !h4.engulfBear;
}

function h4Lost(h4) {
  if (!h4 || !Number.isFinite(h4.ema21) || !Number.isFinite(h4.last)) return false;
  return h4.last < h4.ema21 * 0.995 && !h4.bullish && h4.closePos <= 0.4 && !h4.engulfBull;
}

/** 日线结论先算完。4小时还撑着就先不空，4小时还在均线下就先不多。 */
function applyFrames(read, m, h4, who) {
  let next = read;
  if (read.signal === 'short' && h4Holding(h4)) {
    next = order(
      'wait',
      '等收盘',
      `${read.why} 4小时仍站在均线 ${fmtPx(h4.ema21)} 上并收住。日线只给定位置，4小时没收出空的反应，这单先等。`,
      `4小时收盘落到 ${fmtPx(h4.ema21)} 下方`,
      read.invalid,
    );
  } else if (read.signal === 'long' && h4Lost(h4)) {
    next = order(
      'wait',
      '等收盘',
      `${read.why} 4小时还在均线 ${fmtPx(h4.ema21)} 下方。他要看到4小时站上，才把日线的多做出去，这单先等。`,
      `4小时收盘站上 ${fmtPx(h4.ema21)}`,
      read.invalid,
    );
  }
  return { ...next, daily: dailyFactorLine(m, who), h4: h4FactorLine(h4) };
}

function order(signal, label, why, trigger, invalid) {
  return { signal, label, why, trigger, invalid };
}

function failedRetest(m) {
  const tagged = m.high >= m.ema21 * 0.996 && m.high <= m.ema21 * 1.012;
  const backBelow = m.last < m.ema21 * 0.998 && m.last < m.open;
  return m.prev < m.ema21 && tagged && backBelow && m.pos20 >= 0.22 && m.pos20 <= 0.7;
}

function weakerThanBtc(m, ctx) {
  const btc = ctx && ctx.btc;
  if (!btc || m.sym === 'BTC' || m.sym === 'XAU') return false;
  return m.dayChg < btc.dayChg - 0.012;
}

/** zxhy：低位急杀或半分位守住才接，前高收弱才空，缩量上涨和破位不接。 */
function zxhyDaily(m, ctx = {}) {
  const lowZone = m.pos20 <= 0.35;
  const highZone = m.pos20 >= 0.82;
  const held = m.bullish && m.closePos >= 0.62 && m.last > m.lo20;
  const rejected = !m.bullish && m.closePos <= 0.38 && m.last < m.hi20;
  const taggedLow = m.low <= m.lo20 * 1.012;
  const washed = m.dayChg <= -0.015 || taggedLow;
  const px = fmtPx(m.last);
  const lo = fmtPx(m.lo20);
  const hi = fmtPx(m.hi20);
  const midPx = (m.hi20 + m.lo20) / 2;
  const taggedMid = m.low <= midPx * 1.006 && m.last >= midPx * 0.997;
  const halfHold = taggedMid && m.pos20 >= 0.4 && m.pos20 <= 0.62
    && held && m.last > m.ema56 && m.ext21 > -0.015 && m.ext21 < 0.03 && !m.inside;
  const lineHold = !m.bullish && m.last > m.ema21 && m.low <= m.ema21 * 1.012
    && m.closePos >= 0.45 && m.ext21 < 0.02 && m.ext21 > -0.012
    && m.pos20 >= 0.35 && m.pos20 <= 0.72 && m.volRatio >= 0.6 && !m.inside;

  const altLong = (ord) => {
    if (weakerThanBtc(m, ctx)) {
      return order(
        'skip',
        '不开',
        `${px} 今天比 BTC 弱。他让山寨跟着饼走，弱的不单开。`,
        '等它重新强过 BTC 当日',
        '继续明显弱于 BTC',
      );
    }
    if (m.sym === 'XAU' && ord.signal === 'long' && m.pos20 <= 0.4 && !(m.engulfBull && m.volRatio >= 1)) {
      return order(
        'wait',
        '等收盘',
        `${ord.why} 黄金低位他要再看几天，第一根止跌不当多。`,
        `再守住 ${lo}，或出现放量看涨吞没`,
        ord.invalid,
      );
    }
    return ord;
  };

  if (m.brokeDown && !m.hammer) {
    return order(
      'skip',
      '不开',
      `${px} 收在前低 ${fmtPx(m.priorLo)} 下面，而且没收住。这是他分的 SOW、死猫，不是急杀后的 SC。`,
      `收回 ${fmtPx(m.priorLo)} 再谈坑`,
      `继续收在 ${fmtPx(m.priorLo)} 下方`,
    );
  }
  if (m.brokeUp && m.ext21 > 0.015) {
    return order(
      'skip',
      '不开',
      `${px} 刚收到前高 ${fmtPx(m.priorHi)} 外面。洗盘结束去挑战前高，他也不追这根，等杯柄、等回踩。`,
      `回踩 ${fmtPx(m.priorHi)} 守住再看`,
      `收回 ${fmtPx(m.priorHi)} 下方，假突破`,
    );
  }
  if (m.volRatio < 0.72 && m.ext21 > 0.02 && m.pos20 > 0.62) {
    return order(
      'skip',
      '不开',
      `${px} 离 21 日均线还有 ${(m.ext21 * 100).toFixed(1)}%，量能只有 ${m.volRatio.toFixed(2)} 倍。缩量往上他会怕，不追。`,
      '等放量，或缩量回踩后再看',
      `量能还低，并且远离 ${fmtPx(m.ema21)}`,
    );
  }
  if (m.inside && m.pos20 > 0.28 && m.pos20 < 0.78) {
    return order(
      'skip',
      '不开',
      `${px} 包在前一根里面，是他讲的母子抱。方向没选出来，里面不开。`,
      `收盘站上 ${fmtPx(m.prevHigh)} 或跌破 ${fmtPx(m.prevLow)}`,
      '还包在母线里',
    );
  }

  const half = m.pos20 >= 0.38 && m.pos20 <= 0.68;
  const engulfNeck = fmtPx(Math.max(m.open, m.prev));
  const bullTrap = m.high > m.priorHi && m.last < m.priorHi && !m.bullish && m.pos20 >= 0.45;
  if (bullTrap && m.volRatio >= 0.75) {
    return order(
      'short',
      '试空',
      `${px} 冲过前高 ${fmtPx(m.priorHi)} 又收回来。他最近把这种走法叫诱多陷阱，不追多，收不回去就空。`,
      `收盘留在 ${fmtPx(m.priorHi)} 下方`,
      `收盘重新站上 ${fmtPx(m.priorHi)}`,
    );
  }
  if (m.engulfBear && !lowZone) {
    const thin = m.volRatio < 0.85;
    const upper = m.pos20 > 0.68;
    if (thin && !upper) {
      return order(
        'wait',
        '等收盘',
        `${px} 是看跌吞没，量能只有 ${m.volRatio.toFixed(2)} 倍。他写过空方缩量、不反弹不空，这根不追。`,
        `反抽靠近 ${engulfNeck} 再空`,
        `收盘站回 ${engulfNeck} 上方，吞没失效`,
      );
    }
    if (half || upper) {
      const where = half
        ? `收在 20 日半分 ${fmtPx(midPx)} 附近。他 10 月 23 日的题目就是看跌吞没、半分位空，不把这根当洗盘去接`
        : `在 20 日上半区（位置 ${m.pos20.toFixed(2)}）。高位看跌吞没他空这根，不追已经跌远的延伸段`;
      return order(
        'short',
        '试空',
        `${px} 看跌吞没，量能 ${m.volRatio.toFixed(2)} 倍，${where}。`,
        `收盘留在 ${fmtPx(m.open)} 下方`,
        `收盘站回 ${engulfNeck} 上方`,
      );
    }
  }
  if (m.engulfBull && ((m.ext21 > 0.02 && m.pos20 > 0.62) || (m.volRatio < 0.85 && m.pos20 >= 0.55))) {
    return order(
      'skip',
      '不开',
      `${px} 是看涨吞没，位置 ${m.pos20.toFixed(2)}，量能 ${m.volRatio.toFixed(2)} 倍。他问过能不能直接追，供给区量能跟不上就是诱多，等杯柄、等回踩。`,
      `回踩 ${fmtPx(m.ema21)} 守住再看`,
      `收回 ${fmtPx(m.ema56)} 下方`,
    );
  }
  if (m.engulfBull && m.pos20 <= 0.38 && m.last >= m.priorLo && m.volRatio >= 0.75) {
    if (m.sym === 'XAU') {
      return order(
        'wait',
        '等收盘',
        `${px} 低位看涨吞没，量能 ${m.volRatio.toFixed(2)} 倍。黄金他要再观察几天，第一根止跌不当多，也要防破前低。`,
        `再收一根守住 ${lo}，或第二次测试仍收回`,
        `收盘跌破 ${fmtPx(m.priorLo)}`,
      );
    }
    return altLong(order(
      'long',
      '试多',
      `${px} 低位看涨吞没，量能 ${m.volRatio.toFixed(2)} 倍，还在前低 ${fmtPx(m.priorLo)} 上方。这是他的承接，不是去追已经涨远的阳线。`,
      `收盘守在 ${lo} 上方`,
      `收盘跌破 ${lo}`,
    ));
  }
  if (m.engulfBull && m.pos20 > 0.38) {
    return order(
      'wait',
      '等收盘',
      `${px} 看涨吞没已经离开低位（位置 ${m.pos20.toFixed(2)}）。他要的是回踩半分止跌，不是追这根阳线。`,
      `回踩半分 ${fmtPx(midPx)} 并守住再看`,
      `收回 ${fmtPx(m.ema56)} 下方`,
    );
  }

  if (lowZone && held && washed && m.volRatio >= 0.8) {
    return altLong(order(
      'long',
      '试多',
      `${px} 落在 20 日区间下沿（位置 ${m.pos20.toFixed(2)}），这根收到了上半部，量能 ${m.volRatio.toFixed(2)} 倍。急杀后有承接，才是他的坑。`,
      `收盘守在 ${lo} 上方`,
      `收盘跌破 ${lo}`,
    ));
  }
  if (m.hammer && (lowZone || m.low <= m.priorLo * 1.01) && m.last >= m.priorLo && m.volRatio >= 0.65) {
    return altLong(order(
      'long',
      '试多',
      `${px} 下针收回上半部。他用针的强弱当入场，不是用针尖去抄没收回的破位。`,
      `收盘留在 ${fmtPx(m.priorLo)} 上方`,
      `收盘跌破 ${lo}`,
    ));
  }
  if (lowZone && held && taggedLow && m.volRatio < 0.85 && m.dayChg >= -0.004 && m.last > m.priorLo) {
    return altLong(order(
      'long',
      '试多',
      `${px} 靠近下沿，缩着量还不跌。他会把这个当成短周期反弹，只博守住，不追已经涨上去的。`,
      `收盘仍守 ${lo}`,
      `放量跌破 ${lo}`,
    ));
  }
  if (m.volRatio >= 1.4 && m.closePos > 0.38 && m.closePos < 0.62 && m.pos20 > 0.32 && m.pos20 < 0.78) {
    return order(
      'wait',
      '等收盘',
      `${px} 关键位置量能 ${m.volRatio.toFixed(2)} 倍，收盘还在今日中间。他问这是不是带量 PB、会不会反转，收盘没选出方向之前不当已经反转。`,
      '收盘走到今日上半部或下半部',
      '还收在今日中间',
    );
  }
  if ((m.flips || 0) >= 4 && m.hi7 && (m.hi7 - m.lo7) / m.last < 0.07 && m.pos20 > 0.3 && m.pos20 < 0.75) {
    return order(
      'skip',
      '不开',
      `${px} 近几根来回翻了 ${m.flips} 次，7 日还挤在 ${fmtPx(m.lo7)}–${fmtPx(m.hi7)}。他把这种叫锯齿洗盘，用震荡策略，不开趋势单。`,
      `收盘走出 ${fmtPx(m.lo7)}–${fmtPx(m.hi7)}`,
      '还在这段来回里',
    );
  }
  if (Number.isFinite(m.ema7) && Math.abs(m.ema7 - m.ema21) / m.last < 0.01 && Math.abs(m.last - m.ema21) / m.last < 0.012 && m.pos20 > 0.35 && m.pos20 < 0.78) {
    return order(
      'wait',
      '等收盘',
      `${px} 贴着 7 线 ${fmtPx(m.ema7)} 和 21 线 ${fmtPx(m.ema21)}，两线还粘在一起。他 10 月 13 日的题目是该死不死、等东风，没收出站上或跌破之前不定先上还是先下。`,
      `收盘离开 ${fmtPx(m.ema21)} 一侧`,
      '还粘着这两根线',
    );
  }
  if (Number.isFinite(m.ema56) && Math.abs(m.ema21 - m.ema56) / m.last < 0.012 && m.pos20 > 0.3 && m.pos20 < 0.72 && m.hi7 && (m.hi7 - m.lo7) / m.last < 0.08 && m.last <= Math.max(m.ema21, m.ema56) * 1.01 && m.last >= Math.min(m.ema21, m.ema56) * 0.99) {
    return order(
      'skip',
      '不开',
      `${px} 夹在 21 线 ${fmtPx(m.ema21)} 和 56 线 ${fmtPx(m.ema56)} 中间，两线已经收拢。他 10 月 20 日写积累订单、不断揉搓，剧本没走出来就不开。`,
      `收盘离开 ${fmtPx(Math.max(m.ema21, m.ema56))}`,
      `还夹在 ${fmtPx(m.ema21)} 和 ${fmtPx(m.ema56)} 中间`,
    );
  }
  if (halfHold) {
    return altLong(order(
      'long',
      '试多',
      `${px} 回到 20 日半分 ${fmtPx(midPx)} 并收住，还在 56 日均线 ${fmtPx(m.ema56)} 上方。这是他的半分位，不是去追前高。`,
      `收盘守在 ${fmtPx(midPx)} 上方`,
      `收盘跌回 ${fmtPx(midPx)} 下方`,
    ));
  }
  if (lineHold) {
    return altLong(order(
      'long',
      '试多',
      `${px} 是阴 K，但还收在 21 日均线 ${fmtPx(m.ema21)} 上。他的「线上阴 K」是接，不是逃。`,
      `收盘仍在 ${fmtPx(m.ema21)} 上方`,
      `收盘落到 ${fmtPx(m.ema21)} 下方`,
    ));
  }
  if (lowZone && !held) {
    return order(
      'wait',
      '等收盘',
      `${px} 已经靠近 20 日低点 ${lo}（位置 ${m.pos20.toFixed(2)}），但今天没收住。他低位不空，加速段也不追空，所以这根还不能当坑。`,
      `收盘回到今日区间上半部，并守住 ${lo}`,
      `收盘跌破 ${lo}，坑就变成破位`,
    );
  }
  if (m.pos20 >= 0.25 && m.pos20 <= 0.62 && failedRetest(m)) {
    return order(
      'short',
      '试空',
      `${px} 在 21 日均线 ${fmtPx(m.ema21)} 下方，今天冲到均线又收回去。这是他标题里的破位后反抽失败，不是去摸底。`,
      `收盘仍在 ${fmtPx(m.ema21)} 下方`,
      `收盘站上 ${fmtPx(m.ema21)}`,
    );
  }
  const prevBody = m.prev ? Math.abs(m.prev - m.prevOpen) / m.prev : 0;
  const tower = m.pos20 >= 0.6 && m.pos20 < 0.9 && !m.bullish && m.closePos <= 0.4
    && prevBody >= 0.02 && m.prev > m.prevOpen && m.last < m.prevOpen;
  if (tower) {
    return order(
      m.volRatio >= 0.9 ? 'short' : 'skip',
      m.volRatio >= 0.9 ? '试空' : '不开',
      `${px} 前一根大阳之后收回去了，还在上半区（位置 ${m.pos20.toFixed(2)}）。他 10 月 7 日把这种叫塔型顶、会画门，趋势走完先不抄底。`,
      m.volRatio >= 0.9 ? `收盘留在 ${fmtPx(m.prevOpen)} 下方` : '等反抽失败再谈空，现在不抄',
      `收盘重新站上 ${fmtPx(m.prevOpen)}`,
    );
  }
  if (highZone && (rejected || m.engulfBear || m.star)) {
    return order(
      'short',
      '试空',
      `${px} 贴着 20 日高点 ${hi}（位置 ${m.pos20.toFixed(2)}），${m.engulfBear ? '看跌吞没' : m.star ? '上针' : '收在今日下半部'}。高位他不多，收弱才空，不提前摸。`,
      `收盘站不回 ${hi}`,
      `收盘突破 ${hi}`,
    );
  }
  if (Number.isFinite(m.weekVolRatio) && m.weekVolRatio < 0.8 && m.pos20 >= 0.72 && !rejected) {
    return order(
      'skip',
      '不开',
      `${px} 贴着前高，近一周量能只有前一周的 ${m.weekVolRatio.toFixed(2)} 倍。他 10 月 5 日写关键位置加上月周缩量，小心回调，要看前高压力和收盘价，不追。`,
      `放量收盘站上 ${hi} 再看`,
      `缩量跌回 ${fmtPx(m.ema21)}`,
    );
  }
  if (m.ext21 >= 0.04 || (highZone && !rejected)) {
    return order(
      'skip',
      '不开',
      `${px} 离 21 日均线 ${(m.ext21 * 100).toFixed(1)}%，20 日位置 ${m.pos20.toFixed(2)}。强者或贴着前高时他不追，要等回踩后的收盘。`,
      `回踩靠近 ${fmtPx(m.ema21)} 再看`,
      `直接掉回 ${fmtPx(m.ema56)} 下方，强势不成立`,
    );
  }
  if (m.bw < m.bwPrev * 0.85 && m.pos20 > 0.35 && m.pos20 < 0.7) {
    return order(
      'skip',
      '不开',
      `${px} 带宽从 ${m.bwPrev.toFixed(1)}% 收到 ${m.bw.toFixed(1)}%，还在区间里面。更早的标题里他把这种窄角、楔形当成等变盘，不在里面开。`,
      '等收盘走出区间',
      `上沿 ${hi} / 下沿 ${lo}`,
    );
  }
  if (lowZone) {
    return order(
      'skip',
      '不开',
      `${px} 靠近 20 日下沿 ${lo}（位置 ${m.pos20.toFixed(2)}），但今天没有急杀，低点也没扎到 ${lo}。靠近不等于坑，不开。`,
      `低点扎到 ${lo} 附近，并且收盘收回上半部`,
      `收盘跌破 ${lo}`,
    );
  }
  if (m.bullish && m.dayChg > 0.004 && m.last < m.ema21 * 0.995 && m.pos20 < 0.6) {
    return order(
      'skip',
      '不开',
      `${px} 在反弹，还没收回 21 日均线 ${fmtPx(m.ema21)}。他 10 月 12 日问会不会是 ABC 调整，这种反弹不接。`,
      `收盘站上 ${fmtPx(m.ema21)} 再看`,
      `反弹失败跌破 ${lo}`,
    );
  }
  const place = m.pos20 >= 0.65 ? '偏上' : '中部';
  const box = tightBox(m);
  return order(
    'skip',
    '不开',
    `${px} 在 20 日区间${place}（${lo}–${hi}，位置 ${m.pos20.toFixed(2)}），今天 ${(m.dayChg * 100).toFixed(1)}%。${box ? box.extra : ''}没有挖坑承接，也没有前高收弱。`,
    box ? box.trigger : '不下单',
    box ? box.invalid : `下沿 ${lo} / 上沿 ${hi}`,
  );
}

export function zxhyRead(raw, ctx = {}) {
  const m = withExt({ ...raw });
  const h4 = ctx.h4 ? withExt({ ...ctx.h4 }) : null;
  return applyFrames(zxhyDaily(m, ctx), m, h4, 'zxhy');
}

/** Ronnie：第二脚确认才做，第一次碰不当单，跌破后的延伸段不追。日线没完成，4小时的上行不升成日线单。 */
function ronnieDaily(m, ctx = {}) {
  const nearLow = m.pos20 <= 0.25 && m.low <= m.lo20 * 1.012;
  const nearHigh = m.pos20 >= 0.82;
  const held = m.closePos >= 0.55 && m.last > m.lo20 && m.bullish;
  const speedOk = m.dayChg > -0.045;
  const forceOk = m.volRatio >= 0.65 && m.volRatio <= 2.5;
  const squeeze = m.bw < m.bwPrev * 0.85 && m.pos20 > 0.35 && m.pos20 < 0.65;
  const lo = fmtPx(m.lo20);
  const hi = fmtPx(m.hi20);
  const px = fmtPx(m.last);
  const midPx = (m.hi20 + m.lo20) / 2;
  const taggedMid = m.low <= midPx * 1.006 && m.last >= midPx * 0.997;
  const halfHold = taggedMid && m.pos20 >= 0.4 && m.pos20 <= 0.62
    && held && speedOk && m.last > m.ema56 && m.ext21 < 0.03 && !m.inside;
  const highFail = nearHigh && ((m.closePos <= 0.45 && !m.bullish) || m.engulfBear || m.star);
  const sweptLow = m.low < m.priorLo && m.last >= m.priorLo;
  const altLong = (ord) => {
    if (!weakerThanBtc(m, ctx) || ord.signal !== 'long') return ord;
    return order(
      'skip',
      '不开',
      `${px} 支撑在 BTC 上，这根山寨更弱。他写过支撑有效不等于山寨安全，弱的不单开。`,
      '等它重新强过 BTC 当日',
      '继续明显弱于 BTC',
    );
  };

  if (m.brokeDown) {
    return order(
      'skip',
      '不开',
      `${px} 跌破前低 ${fmtPx(m.priorLo)} 还没收回去。他这里先看反应：日线没收回就不猜底，也不把延伸段追成空。`,
      `收回 ${fmtPx(m.priorLo)} 再谈多`,
      `反抽 ${fmtPx(m.ema21)} 失败才再谈空`,
    );
  }
  if (m.brokeUp && m.ext21 > 0.015 && !highFail) {
    return order(
      'skip',
      '不开',
      `${px} 刚破前高 ${fmtPx(m.priorHi)}。他要先看到回踩，或者下一根真正的大阳守住，突破当天不追。`,
      `回踩 ${fmtPx(m.priorHi)} 守住`,
      `收回 ${fmtPx(m.priorHi)} 下方`,
    );
  }

  if (sweptLow && m.lowTests < 2) {
    return order(
      'wait',
      '等收盘',
      `${px} 扎破前低 ${fmtPx(m.priorLo)} 又收回来。他要先看这一扎算不算破，第一脚不直接当支撑做多。`,
      '再测一次并收在前低上方，才谈多',
      `收盘留在 ${fmtPx(m.priorLo)} 下方`,
    );
  }
  if (nearLow && m.lowTests >= 2 && held && speedOk && forceOk) {
    return altLong(order(
      'long',
      '试多',
      `${px} 是近 8 根里第 ${m.lowTests} 次碰到 20 日低点 ${lo}，而且收住了。位置、收盘、跌速都在他要的范围里，第一脚他是不做的。`,
      `收盘守住 ${lo}`,
      `收盘跌破 ${lo}`,
    ));
  }
  if (nearLow && m.lowTests < 2) {
    return order(
      'wait',
      '等收盘',
      `${px} 碰到了 ${lo}，但这是第一脚。他默认第一次测试不是确认，要等第二脚或收盘重新守住。`,
      '再测一次低点，并且收在低点上方',
      `收盘跌破 ${lo}`,
    );
  }
  if (nearLow && !held) {
    const swept = m.lowTests >= 2 ? `近 8 根已经反复扫过 ${m.lowTests} 次，` : '';
    const fast = m.dayChg <= -0.045 ? `这根跌了 ${(m.dayChg * 100).toFixed(1)}%，太快。` : '';
    return order(
      'wait',
      '等收盘',
      `${px} ${swept}靠近 ${lo}，收盘没接住。${fast}量能 ${m.volRatio.toFixed(2)} 倍。支撑反复扫也不等于已经破，他要看反应。`,
      '收盘回到今日上半部，跌速别超过大约 4.5%',
      `收盘跌破 ${lo}`,
    );
  }
  if (halfHold && m.midTests >= 2) {
    return altLong(order(
      'long',
      '试多',
      `${px} 第二次回到半分 ${fmtPx(midPx)} 并收住。他做的是这个位置的确认，不是看到阳线就追。`,
      `收盘守在 ${fmtPx(midPx)} 上方`,
      `收盘跌回 ${fmtPx(midPx)} 下方`,
    ));
  }
  if (halfHold) {
    return order(
      'wait',
      '等收盘',
      `${px} 碰到半分 ${fmtPx(midPx)} 了，但这是第一脚。他要再看一次收盘还在不在上面。`,
      '再测一次半分，并且收住',
      `收盘跌破 ${fmtPx(midPx)}`,
    );
  }
  if (m.pos20 >= 0.25 && m.pos20 <= 0.62 && failedRetest(m)) {
    return order(
      'short',
      '试空',
      `${px} 跌破 21 日均线 ${fmtPx(m.ema21)} 之后又抽回去、没站住。这是他写过的跌破后回踩，不是延伸段里去追空。`,
      `收盘仍在 ${fmtPx(m.ema21)} 下方`,
      `收盘站上 ${fmtPx(m.ema21)}`,
    );
  }
  if (m.highTests >= 2 && !m.bullish && m.closePos <= 0.42 && m.pos20 >= 0.55 && !nearHigh) {
    return order(
      'short',
      '试空',
      `${px} 又一次从高点收回（近 8 根碰到上沿 ${m.highTests} 次），收在今日下半部。他把这种反复冲高回落看成震荡要转向，不当蓄势去接。`,
      `收盘留在 ${hi} 下方`,
      `收盘站上 ${hi}`,
    );
  }
  if (highFail && m.highTests >= 2) {
    return order(
      'short',
      '试空',
      `${px} 不是第一次碰 ${hi}，这根从阻力收回来了。他把阻力位回落当成送出来的位置，第一脚他不做。`,
      `收盘留在 ${hi} 下方`,
      `收盘站上 ${hi}`,
    );
  }
  if (m.pos20 < 0.22 && m.last < m.ema21 * 0.98 && (m.hi20 - m.lo20) / m.last > 0.06) {
    return order(
      'skip',
      '不开',
      `${px} 已经在均线下方的延伸段（位置 ${m.pos20.toFixed(2)}）。他这里不猜底，也不把刚跌出来的一段追成空。`,
      `反抽到 ${fmtPx(m.ema21)} 失败，才再谈空`,
      '出现收盘止跌阳线，才再谈多',
    );
  }
  if (nearHigh && m.highTests < 2) {
    return order(
      'skip',
      '不开',
      `${px} 第一次靠近 20 日高点 ${hi}。他默认第一次冲阻力不是用来破的，所以不追多，也不提前空。`,
      '等第二次测试，并且收弱，才考虑',
      `收盘直接站上 ${hi} 就不是这个题目了`,
    );
  }
  if (nearHigh) {
    return order(
      'skip',
      '不开',
      `${px} 在前高 ${hi} 附近来回（近 8 根碰到 ${m.highTests} 次），今天没有收成明确的失败。他会把这当成还在横盘，而不是开单。`,
      '收出失败 K，或收盘离开这个高点',
      `收盘站上 ${hi}`,
    );
  }
  if (squeeze) {
    return order(
      'skip',
      '不开',
      `${px} 布林带宽从 ${m.bwPrev.toFixed(1)}% 收到 ${m.bw.toFixed(1)}%，人在区间中部。他讲过极度收口是震荡，不是变盘，要等开口方向。`,
      '等带宽重新张开',
      `离开 ${lo}–${hi} 的中部`,
    );
  }
  if (m.pos20 <= 0.28) {
    return order(
      'skip',
      '不开',
      `${px} 靠近下沿 ${lo}（位置 ${m.pos20.toFixed(2)}），但今天的低点没有真正测到这一档。他要的是回踩确认，不是价格刚好偏下。`,
      `低点再测到 ${lo}，并且收住`,
      `收盘跌破 ${lo}`,
    );
  }
  const place = m.pos20 >= 0.7 ? '偏上' : '中部';
  const box = tightBox(m);
  return order(
    'skip',
    '不开',
    `${px} 在 ${lo}–${hi} 的${place}（位置 ${m.pos20.toFixed(2)}）。${box ? box.extra : ''}没有第二脚支撑，也没有跌破后的回踩失败。盘整里他管住手。`,
    box ? box.trigger : '不下单',
    box ? box.invalid : `下沿 ${lo} / 上沿 ${hi}`,
  );
}

export function ronnieRead(raw, ctx = {}) {
  const m = withExt({ ...raw });
  const h4 = ctx.h4 ? withExt({ ...ctx.h4 }) : null;
  return applyFrames(ronnieDaily(m, ctx), m, h4, 'ronnie');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tagClass(signal) {
  if (signal === 'long') return 'long';
  if (signal === 'short') return 'short';
  if (signal === 'wait') return 'cs-wait';
  return 'watch';
}

function cardHtml(m, read) {
  const cls = read.signal === 'skip' ? '' : ` signal-${read.signal}`;
  return `<div class="cs-card${cls}">
    <div class="cs-card-h">
      <span class="cs-sym">${esc(m.sym)}</span>
      <span class="cs-px">${fmtPx(m.last)}</span>
      <span class="strategy-tag ${tagClass(read.signal)}">${esc(read.label)}</span>
    </div>
    <p class="cs-tf"><b>日线</b> ${esc(read.daily || '')}</p>
    <p class="cs-tf"><b>4小时</b> ${esc(read.h4 || '')}</p>
    <p>${esc(read.why)}</p>
    <p class="cs-levels">触发 ${esc(read.trigger)} · 失效 ${esc(read.invalid)}</p>
  </div>`;
}

function stripHtml(reads) {
  const orders = reads.filter((r) => r.read.signal === 'long' || r.read.signal === 'short');
  const waits = reads.filter((r) => r.read.signal === 'wait');
  const chips = orders.map((r) => (
    `<span class="cs-order ${r.read.signal}">${esc(r.m.sym)} ${esc(r.read.label)}</span>`
  ));
  const waitText = waits.length
    ? `<span class="cs-order wait">等收盘 ${esc(waits.map((r) => r.m.sym).join('、'))}</span>`
    : '';
  if (!chips.length && !waitText) return '今天没有开单，也没有等到收盘的条件单。';
  if (!chips.length) return `今天没有开单。${waitText}`;
  return `今天可开 ${chips.join('')}${waitText}`;
}

async function fetchKlines(coin, interval) {
  const root = coin.futures
    ? 'https://fapi.binance.com/fapi/v1/klines'
    : 'https://api.binance.com/api/v3/klines';
  const limit = interval === '4h' ? 120 : 90;
  const res = await fetch(`${root}?symbol=${coin.pair}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`${coin.sym} ${interval} ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 60) throw new Error(`${coin.sym} ${interval} K 线不够`);
  return structureFromKlines(coin.sym, rows, Date.now(), interval);
}

function paintStudyMeta() {
  const zxhyMeta = document.getElementById('csZxhyMeta');
  const ronnieMeta = document.getElementById('csRonnieMeta');
  if (zxhyMeta) zxhyMeta.textContent = `学到 ${STUDY.zxhy.throughDate} · 上次 ${STUDY.zxhy.previousDate}`;
  if (ronnieMeta) ronnieMeta.textContent = `学到 ${STUDY.ronnie.throughDate} · 上次 ${STUDY.ronnie.previousDate}`;
}

let busy = false;
let again = false;

export async function loadCreatorStudy() {
  if (busy) {
    again = true;
    return;
  }
  const badge = document.getElementById('csLiveBadge');
  const zxhyBox = document.getElementById('csZxhyCards');
  const ronnieBox = document.getElementById('csRonnieCards');
  if (!zxhyBox || !ronnieBox) return;
  busy = true;
  paintStudyMeta();
  if (badge) badge.textContent = '正在重算…';
  try {
    const settled = await Promise.all(COINS.map(async (coin) => {
      try {
        const [m, h4] = await Promise.all([
          fetchKlines(coin, '1d'),
          fetchKlines(coin, '4h').catch(() => null),
        ]);
        return { ok: true, m, h4 };
      } catch (err) {
        return { ok: false, sym: coin.sym, err };
      }
    }));
    const good = settled.filter((r) => r.ok);
    const failed = settled.filter((r) => !r.ok);
    const btc = good.map((r) => r.m).find((m) => m.sym === 'BTC');
    const zxhy = good.map((r) => ({ m: r.m, read: zxhyRead(r.m, { btc, h4: r.h4 }) }));
    const ronnie = good.map((r) => ({ m: r.m, read: ronnieRead(r.m, { btc, h4: r.h4 }) }));
    document.getElementById('csZxhyOrders').innerHTML = stripHtml(zxhy);
    document.getElementById('csRonnieOrders').innerHTML = stripHtml(ronnie);
    zxhyBox.innerHTML = zxhy.map(({ m, read }) => cardHtml(m, read)).join('');
    ronnieBox.innerHTML = ronnie.map(({ m, read }) => cardHtml(m, read)).join('');
    if (failed.length) {
      const note = `<p class="cs-levels">${failed.map((f) => esc(f.sym)).join('、')} 这次没拿到日 K。</p>`;
      zxhyBox.insertAdjacentHTML('beforeend', note);
    }
    const stamp = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const openDay = good.some((r) => r.m.candleOpen);
    const openH4 = good.some((r) => r.h4 && r.h4.candleOpen);
    const openNote = [openDay ? '日K未收盘' : '', openH4 ? '4小时未收盘' : ''].filter(Boolean).join(' · ');
    if (badge) badge.textContent = `实时重算 · ${stamp}${openNote ? ` · ${openNote}` : ''}`;
    const nOrder = [...zxhy, ...ronnie].filter((r) => r.read.signal === 'long' || r.read.signal === 'short').length;
    const foot = document.getElementById('csFoot');
    if (foot) {
      foot.textContent = `刚才这轮两边合计 ${nOrder} 个试多/试空。日线定结构，4小时定反应，两层不一致就从开单退回等收盘。K 线来自币安现货，黄金用 U 本位。未收盘的日 K 和 4 小时都会变。不构成下单指令。`;
    }
  } catch (err) {
    if (badge) badge.textContent = '这次没算成';
    zxhyBox.innerHTML = `<p class="cs-levels">${esc(err.message || err)}</p>`;
  } finally {
    busy = false;
    if (again) {
      again = false;
      loadCreatorStudy().catch(() => {});
    }
  }
}

function boot() {
  if (typeof window === 'undefined') return;
  window.loadCreatorStudy = () => { loadCreatorStudy().catch(() => {}); };
  loadCreatorStudy().catch(() => {});
  setInterval(() => { loadCreatorStudy().catch(() => {}); }, 60000);
}

boot();
