/**
 * 博主读盘模拟。规则来自两位频道标题，数字每次用币安日 K 重算。
 * 试多 / 试空才是开单；等收盘是条件没齐；不开就是今天没有单。
 */

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

/** 把币安 K 线收成读盘用的结构。最后一根是未收盘日 K 时 candleOpen 为 true。 */
export function structureFromKlines(sym, rows, now = Date.now()) {
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
    engulfBull: last >= opens[n - 1]
      && opens[n - 1] <= Math.min(prevOpen, prev)
      && last >= Math.max(prevOpen, prev),
    engulfBear: last < opens[n - 1]
      && opens[n - 1] >= Math.max(prevOpen, prev)
      && last <= Math.min(prevOpen, prev),
    inside: highs[n - 1] < prevHigh && lows[n - 1] > prevLow,
    hammer: lowerWick > Math.max(body, last * 0.001) * 2 && upperWick <= body && closePos >= 0.6,
    star: upperWick > Math.max(body, last * 0.001) * 2 && lowerWick <= body && closePos <= 0.4,
    weekHeld: weekClosePos >= 0.62,
    ext21: 0,
    candleOpen: now < openMs + 86400000,
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
export function zxhyRead(raw, ctx = {}) {
  const m = withExt({ ...raw });
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
    if (!weakerThanBtc(m, ctx)) return ord;
    return order(
      'skip',
      '不开',
      `${px} 今天比 BTC 弱。他让山寨跟着饼走，弱的不单开。`,
      '等它重新强过 BTC 当日',
      '继续明显弱于 BTC',
    );
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
      `${px} 刚收到前高 ${fmtPx(m.priorHi)} 外面。他问过周线吞没能不能直接追，答案是等杯柄、等回踩，不追这根。`,
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
  if (highZone && (rejected || m.engulfBear || m.star)) {
    return order(
      'short',
      '试空',
      `${px} 贴着 20 日高点 ${hi}（位置 ${m.pos20.toFixed(2)}），${m.engulfBear ? '看跌吞没' : m.star ? '上针' : '收在今日下半部'}。高位他不多，收弱才空，不提前摸。`,
      `收盘站不回 ${hi}`,
      `收盘突破 ${hi}`,
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

/** Ronnie：第二脚确认才做，第一次碰不当单，跌破后的延伸段不追。 */
export function ronnieRead(raw) {
  const m = withExt({ ...raw });
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

  if (m.brokeDown) {
    return order(
      'skip',
      '不开',
      `${px} 跌破前低 ${fmtPx(m.priorLo)} 还没收回去。他这里不猜底，跌破了也不把延伸段追成空。`,
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

  if (nearLow && m.lowTests >= 2 && held && speedOk && forceOk) {
    return order(
      'long',
      '试多',
      `${px} 是近 8 根里第 ${m.lowTests} 次碰到 20 日低点 ${lo}，而且收住了。位置、收盘、跌速都在他要的范围里，第一脚他是不做的。`,
      `收盘守住 ${lo}`,
      `收盘跌破 ${lo}`,
    );
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
    return order(
      'wait',
      '等收盘',
      `${px} 位置到了 ${lo} 附近，收盘没接住，或者这根跌得太快（${(m.dayChg * 100).toFixed(1)}%，量能 ${m.volRatio.toFixed(2)} 倍）。三个条件没齐。`,
      '收盘回到今日上半部，跌速别超过大约 4.5%',
      `收盘跌破 ${lo}`,
    );
  }
  if (halfHold && m.midTests >= 2) {
    return order(
      'long',
      '试多',
      `${px} 第二次回到半分 ${fmtPx(midPx)} 并收住。他做的是这个位置的确认，不是看到阳线就追。`,
      `收盘守在 ${fmtPx(midPx)} 上方`,
      `收盘跌回 ${fmtPx(midPx)} 下方`,
    );
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

async function fetchKlines(coin) {
  const root = coin.futures
    ? 'https://fapi.binance.com/fapi/v1/klines'
    : 'https://api.binance.com/api/v3/klines';
  const res = await fetch(`${root}?symbol=${coin.pair}&interval=1d&limit=90`);
  if (!res.ok) throw new Error(`${coin.sym} ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 60) throw new Error(`${coin.sym} K 线不够`);
  return structureFromKlines(coin.sym, rows);
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
  if (badge) badge.textContent = '正在重算…';
  try {
    const settled = await Promise.all(COINS.map(async (coin) => {
      try {
        return { ok: true, m: await fetchKlines(coin) };
      } catch (err) {
        return { ok: false, sym: coin.sym, err };
      }
    }));
    const good = settled.filter((r) => r.ok).map((r) => r.m);
    const failed = settled.filter((r) => !r.ok);
    const btc = good.find((m) => m.sym === 'BTC');
    const zxhy = good.map((m) => ({ m, read: zxhyRead(m, { btc }) }));
    const ronnie = good.map((m) => ({ m, read: ronnieRead(m, { btc }) }));
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
    const open = good.some((m) => m.candleOpen);
    if (badge) badge.textContent = `实时重算 · ${stamp}${open ? ' · 日K未收盘' : ''}`;
    const nOrder = [...zxhy, ...ronnie].filter((r) => r.read.signal === 'long' || r.read.signal === 'short').length;
    const foot = document.getElementById('csFoot');
    if (foot) {
      foot.textContent = `刚才这轮两边合计 ${nOrder} 个试多/试空。日 K 来自币安现货，黄金用 U 本位。未收盘的日 K 下一分钟可能从「等收盘」变成「试多」或退回「不开」。不构成下单指令。`;
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
