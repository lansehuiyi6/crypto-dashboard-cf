/**
 * 短线操作面板
 *
 * 支撑/阻力/策略随现价生成，不再手写点位。
 * 数据优先级: 扫描写入的 majors（含 24h 高低 + 7d 小时线）
 *            → 价格快照（CoinGecko simple/price + 黄金现货）
 */

const MAJOR_IDS = {
  bitcoin: { key: 'BTC', coin: 'BTC' },
  ethereum: { key: 'ETH', coin: 'ETH' },
  binancecoin: { key: 'BNB', coin: 'BNB' },
  solana: { key: 'SOL', coin: 'SOL' },
  ripple: { key: 'XRP', coin: 'XRP' },
};

const CARD_ORDER = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'XAU'];

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stepFor(price) {
  if (price >= 10000) return 50;
  if (price >= 1000) return 5;
  if (price >= 200) return 1;
  if (price >= 50) return 0.5;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  return 0.001;
}

function psychStep(price) {
  if (price >= 50000) return 1000;
  if (price >= 10000) return 500;
  if (price >= 2000) return 50;
  if (price >= 500) return 25;
  if (price >= 100) return 5;
  if (price >= 20) return 1;
  return 0.5;
}

function roundPx(n, price) {
  const s = stepFor(price);
  return Math.round(n / s) * s;
}

function fmtPx(n, price) {
  if (!Number.isFinite(n)) return '--';
  const r = roundPx(n, price);
  if (price >= 1000) return '$' + Math.round(r).toLocaleString('en-US');
  if (price >= 50) return '$' + r.toFixed(r >= 100 && stepFor(price) >= 1 ? 0 : 2);
  return '$' + r.toFixed(2);
}

function fmtSpot(n) {
  if (!Number.isFinite(n)) return '--';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}

function fmtCh(ch) {
  if (!Number.isFinite(ch)) return '';
  const sign = ch > 0 ? '+' : '';
  return sign + ch.toFixed(2) + '%';
}

function joinLevels(levels, price) {
  return levels.map((v) => fmtPx(v, price)).join(' -> ');
}

function findSwings(closes, order = 4) {
  const lows = [];
  const highs = [];
  if (!closes || closes.length < order * 2 + 1) return { lows, highs };
  for (let i = order; i < closes.length - order; i++) {
    const window = closes.slice(i - order, i + order + 1);
    const v = closes[i];
    if (v === Math.min(...window)) lows.push(v);
    if (v === Math.max(...window)) highs.push(v);
  }
  return { lows, highs };
}

function estimateRange(major) {
  const price = major.price;
  const high24 = num(major.high24);
  const low24 = num(major.low24);
  if (high24 && low24 && high24 > low24) return high24 - low24;
  const ch = Math.abs(num(major.change24h) || 0) / 100;
  return price * Math.max(0.012, ch);
}

function pickNearest(values, price, n, below) {
  const tol = price * 0.003;
  const filtered = values.filter((v) => Number.isFinite(v) && v > 0 && (below ? v < price * 0.999 : v > price * 1.001));
  const sorted = filtered.sort((a, b) => (below ? b - a : a - b));
  const out = [];
  for (const raw of sorted) {
    const v = roundPx(raw, price);
    if (out.some((x) => Math.abs(x - v) < tol)) continue;
    if (below && v >= price) continue;
    if (!below && v <= price) continue;
    out.push(v);
    if (out.length >= n) break;
  }
  const step = psychStep(price);
  let cursor = roundPx(price, price);
  while (out.length < n) {
    cursor += below ? -step : step;
    if (cursor <= 0) break;
    const v = roundPx(cursor, price);
    if (out.some((x) => Math.abs(x - v) < price * 0.002)) continue;
    if (below && v >= price) continue;
    if (!below && v <= price) continue;
    out.push(v);
  }
  return out;
}

function collectLevels(major) {
  const price = major.price;
  const high24 = num(major.high24);
  const low24 = num(major.low24);
  const range = estimateRange(major);
  const supports = [];
  const resistances = [];

  if (low24) supports.push(low24);
  if (high24) resistances.push(high24);

  const closes = Array.isArray(major.closes) ? major.closes.filter((v) => Number.isFinite(v)) : [];
  if (closes.length >= 24) {
    const swings = findSwings(closes, 4);
    supports.push(...swings.lows);
    resistances.push(...swings.highs);
    supports.push(Math.min(...closes));
    resistances.push(Math.max(...closes));
  }

  supports.push(price - range, price - range * 1.6, price - range * 2.2);
  resistances.push(price + range * 0.5, price + range * 1.2, price + range * 2);

  const ps = psychStep(price);
  let s = Math.floor(price / ps) * ps;
  for (let i = 0; i < 5; i++) {
    s -= ps;
    if (s > 0) supports.push(s);
  }
  let r = Math.ceil(price / ps) * ps;
  if (r <= price) r += ps;
  for (let i = 0; i < 5; i++) {
    resistances.push(r);
    r += ps;
  }

  return {
    supports: pickNearest(supports, price, 3, true),
    resistances: pickNearest(resistances, price, 3, false),
  };
}

function classifyBias(major) {
  const price = major.price;
  const change1h = num(major.change1h);
  const change24h = num(major.change24h) || 0;
  const change7d = num(major.change7d);
  const high24 = num(major.high24);
  const low24 = num(major.low24);
  const pos = high24 && low24 && high24 > low24
    ? (price - low24) / (high24 - low24)
    : 0.5;

  const weak = change24h < -1.5 || (change7d != null && change7d < -5 && change24h < 0);
  const hot = change24h > 2 && pos > 0.85;
  const pullback = change1h != null && change1h < -0.8 && change24h > 0;
  const strong = (change7d != null && change7d > 8 && change24h > 0.5) || change24h > 1.2;
  const wash = Math.abs(change24h) < 0.6 && pos > 0.35 && pos < 0.65;

  if (weak) return { bias: '偏弱, 谨慎', color: 'gray', kind: 'weak' };
  if (hot) return { bias: '强势上攻, 短线注意回撤', color: 'amber', kind: 'hot' };
  if (pullback) return { bias: '冲高回落, 看支撑', color: 'blue', kind: 'pullback' };
  if (strong) return { bias: '多头占优', color: 'amber', kind: 'bull' };
  if (wash) return { bias: '震荡整理', color: 'blue', kind: 'range' };
  if (change24h >= 0) return { bias: '偏多', color: 'blue', kind: 'bull' };
  return { bias: '偏空观望', color: 'gray', kind: 'weak' };
}

function rsiPhrase(rsi) {
  if (!Number.isFinite(rsi)) return 'RSI 数据不足';
  if (rsi >= 70) return `RSI6 在 ${rsi.toFixed(0)}，短线超买，不宜追多`;
  if (rsi >= 65) return `RSI6 在 ${rsi.toFixed(0)}，接近超买，多单要等回踩`;
  if (rsi <= 30) return `RSI6 在 ${rsi.toFixed(0)}，短线超卖，不宜追空`;
  if (rsi <= 35) return `RSI6 在 ${rsi.toFixed(0)}，动能偏低，空单需谨慎`;
  return `RSI6 在 ${rsi.toFixed(0)}，未到极端区`;
}

function buildTfAnalysis(tfLabel, ema, s1, r1) {
  if (!ema) {
    return `${tfLabel}K 线还没到位。先按现价观察，支撑看 ${s1}，阻力看 ${r1}，不要追单。`;
  }
  const ls = ema.lastSignal;
  let cross = '未见有效的 EMA7 穿越 EMA56。';
  if (ls) {
    cross = ls.held
      ? `EMA7 相对 EMA56 处于「${ls.label}」状态（${ls.timeAgoText}），价格仍在分界线${ls.dir === 'up' ? '上方' : '下方'}。`
      : `最近一次信号是 ${ls.label}，发生在${ls.timeAgoText}，当时价 ${ls.priceText}。`;
  }
  const macd = ema.macdAboveZero
    ? 'MACD 在 0 轴上方，多头动能还在。'
    : 'MACD 在 0 轴下方，空头动能占优。';
  const align = ema.trendLabel || '均线纠缠';
  let action;
  if (ema.setup === 'long') {
    action = `开仓过滤已满足，可在 ${s1} 一带轻仓试多，止损参考 ${ema.stopText}，第一目标 ${r1}，延伸目标 ${ema.tpText}。`;
  } else if (ema.setup === 'short') {
    action = `开仓过滤已满足，反弹 ${r1} 遇阻可轻仓试空，止损参考 ${ema.stopText}，目标看 ${s1} / ${ema.tpText}。`;
  } else {
    action = `穿越、MACD 同向、RSI 不极端尚未同时成立，这个周期先观望：多等回踩 ${s1}，空等反抽 ${r1}。`;
  }
  return `${tfLabel}目前是${align}。${cross}${macd}${rsiPhrase(ema.rsi6)}。${action}`;
}

function buildStrategy(kind, price, supports, resistances) {
  const s1 = fmtPx(supports[0], price);
  const s2 = fmtPx(supports[1] ?? supports[0] * 0.985, price);
  const r1 = fmtPx(resistances[0], price);
  const r2 = fmtPx(resistances[1] ?? resistances[0] * 1.015, price);
  const bandLo = supports[0];
  const gap = Math.max(price - bandLo, stepFor(price));
  const bandHi = roundPx(price - gap * 0.25, price);
  const band = bandHi > bandLo
    ? `${fmtPx(bandLo, price)}-${fmtPx(bandHi, price)}`
    : s1;

  if (kind === 'weak') {
    return `不做追多, 等方向选择. 跌破${s1}可右侧跟空, 目标${s2}. 反弹${r1}遇阻减仓.`;
  }
  if (kind === 'hot') {
    return `靠近24h高点, 不宜追多. 回踩${band}不破可试多, 目标${r1}; 突破站稳${r1}可看${r2}. 跌破${s1}减仓.`;
  }
  if (kind === 'range') {
    return `区间${s1}-${r1}高抛低吸. 突破站稳${r1}可看${r2}; 跌破${s1}看${s2}.`;
  }
  if (kind === 'pullback') {
    return `短线回落, 回踩${band}不破可试多, 目标${r1}. 跌破${s1}减仓, 下一支撑${s2}.`;
  }
  return `回踩${band}不破可试多, 目标${r1}; 突破站稳${r1}可看${r2}. 跌破${s1}减仓.`;
}

function buildCard(major) {
  const price = num(major.price);
  if (!price || price <= 0) return null;
  const { supports, resistances } = collectLevels(major);
  if (!supports.length || !resistances.length) return null;
  const { bias, color, kind } = classifyBias(major);
  const change24h = num(major.change24h);
  const s1 = fmtPx(supports[0], price);
  const r1 = fmtPx(resistances[0], price);
  return {
    coin: major.coin,
    bias,
    color,
    support: joinLevels(supports, price),
    resistance: joinLevels(resistances, price),
    strategy: buildStrategy(kind, price, supports, resistances),
    analysis15m: buildTfAnalysis('15 分钟', major.ema15, s1, r1),
    analysis1h: buildTfAnalysis('1 小时', major.ema1h, s1, r1),
    price,
    change24h,
    priceText: fmtSpot(price),
    changeText: fmtCh(change24h),
    ema15: major.ema15 || null,
    ema1h: major.ema1h || major.emaStrategy || null,
  };
}

function inferHighLow(price, change24h) {
  if (!Number.isFinite(change24h)) return { high24: null, low24: null };
  const open = price / (1 + change24h / 100);
  if (change24h >= 0) {
    return {
      high24: price,
      low24: Math.min(open, price) * (1 - Math.abs(change24h) / 100 * 0.2),
    };
  }
  return {
    low24: price,
    high24: Math.max(open, price) * (1 + Math.abs(change24h) / 100 * 0.2),
  };
}

function fromSimpleQuote(coin, quote) {
  const price = num(quote?.usd);
  if (!price) return null;
  const change24h = num(quote.usd_24h_change);
  const hl = inferHighLow(price, change24h);
  return {
    coin,
    price,
    change24h,
    change1h: null,
    change7d: null,
    high24: hl.high24,
    low24: hl.low24,
  };
}

function fromCoin(coin, history) {
  const meta = MAJOR_IDS[coin.id];
  if (!meta) return null;
  const price = num(coin.current_price);
  if (!price) return null;
  const closes = (history?.prices || [])
    .map((p) => (Array.isArray(p) ? num(p[1]) : num(p)))
    .filter((v) => v != null)
    .slice(-168);
  return {
    coin: meta.coin,
    price,
    change1h: num(coin.price_change_percentage_1h_in_currency),
    change24h: num(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h),
    change7d: num(coin.price_change_percentage_7d_in_currency),
    high24: num(coin.high_24h),
    low24: num(coin.low_24h),
    closes: closes.length ? closes : undefined,
  };
}

function mergeMajor(base, liveQuote, coinName) {
  const live = fromSimpleQuote(coinName || base?.coin, liveQuote);
  if (!base) return live;
  if (!live) return base;
  return {
    ...base,
    coin: base.coin || coinName,
    price: live.price,
    change24h: live.change24h ?? base.change24h,
    high24: base.high24 ?? live.high24,
    low24: base.low24 ?? live.low24,
  };
}

export function buildMajors(coins = [], historyById = {}, gold = null) {
  const out = {};
  for (const coin of coins) {
    const major = fromCoin(coin, historyById[coin.id]);
    if (!major) continue;
    const key = MAJOR_IDS[coin.id].key;
    out[key] = major;
  }
  const xau = num(gold?.spot_usd_oz) ?? num(gold?.xau?.price);
  if (xau) {
    out.XAU = {
      coin: 'XAU/USD',
      price: xau,
      change1h: null,
      change24h: null,
      change7d: null,
      high24: null,
      low24: null,
    };
  }
  return out;
}

export function patchMajorsFromCoin(prev, coin, history) {
  if (!coin || !MAJOR_IDS[coin.id]) return null;
  const piece = buildMajors([coin], history ? { [coin.id]: history } : {}, null);
  return { ...(prev || {}), ...piece };
}

export function assembleMarketSignals({ majors = {}, prices = {}, gold = null, strategies = {} } = {}) {
  const editorial = getEditorial();
  const xauLive = prices.xau || null;
  const merged = {
    BTC: mergeMajor(majors.BTC, prices.bitcoin, 'BTC')
      || (gold?.btc_usd ? { coin: 'BTC', price: num(gold.btc_usd) } : null),
    ETH: mergeMajor(majors.ETH, prices.ethereum, 'ETH'),
    BNB: mergeMajor(majors.BNB, prices.binancecoin, 'BNB'),
    SOL: mergeMajor(majors.SOL, prices.solana, 'SOL'),
    XRP: mergeMajor(majors.XRP, prices.ripple, 'XRP'),
    XAU: mergeMajor(
      majors.XAU || (num(gold?.spot_usd_oz) || num(gold?.xau?.price)
        ? { coin: 'XAU/USD', price: num(gold.spot_usd_oz) ?? num(gold.xau?.price) }
        : null),
      xauLive,
      'XAU/USD',
    ),
  };
  const board15 = strategies['15m'] && typeof strategies['15m'] === 'object' ? strategies['15m'] : {};
  const board1h = strategies['1h'] && typeof strategies['1h'] === 'object'
    ? strategies['1h']
    : strategies;
  for (const key of CARD_ORDER) {
    if (!merged[key]) continue;
    merged[key].ema15 = board15[key] || null;
    merged[key].ema1h = board1h[key] || null;
  }

  const tradingSignals = CARD_ORDER
    .map((key) => merged[key] && buildCard(merged[key]))
    .filter(Boolean);

  return {
    updated: new Date().toISOString(),
    overview: editorial.overview,
    tradingSignals,
    tokenUnlocks: editorial.tokenUnlocks,
    newListings: editorial.newListings,
    trendingTokens: editorial.trendingTokens,
    keyEvents: editorial.keyEvents,
    narratives: editorial.narratives,
  };
}

export function getMarketSignals() {
  return assembleMarketSignals();
}

function getEditorial() {
  return {
    overview: {
      btc: { price: '$64,700', change: '+0.9%', note: '突破下降趋势线' },
      eth: { price: '$1,910', change: '+1.8%', note: '站上$1,900, EIP-8361催化' },
      bnb: { price: '$606', change: '+1.2%', note: '延续强势' },
      sol: { price: '$74.5', change: '+0.5%', note: '弱势跟涨, ETF零流入' },
      xau: { price: '$4,265', change: '+4.14%', note: '单日暴涨200美金, 突破震荡区间' },
      totalMcap: '~$2.29T (+1.2%)',
      btcDominance: '56.5%',
      fearGreed: '17 (极度恐惧->谨慎乐观)',
    },
    tokenUnlocks: [
      { token: 'GoldFinger (GF)', date: '8/6 (今日)', amount: '$11.52M', pct: '5.05%', risk: 'high' },
      { token: 'INFINIT (IN)', date: '8/7', amount: '$2.31M', pct: '20.30%', risk: 'high' },
      { token: 'STABLE', date: '8/8', amount: '$28.75M', pct: '3.55%', risk: 'medium' },
      { token: 'NAME', date: '8/9', amount: '$48.47M', pct: '74.54%', risk: 'extreme' },
      { token: 'MOVE', date: '8/9', amount: '$1.22M', pct: '3.90%', risk: 'medium' },
      { token: 'LAYER', date: '8/12', amount: '-', pct: '12.89%', risk: 'high' },
      { token: 'BB (BounceBit)', date: '8/12', amount: '-', pct: '9.04%', risk: 'high' },
      { token: 'APT (Aptos)', date: '8/12', amount: '-', pct: '-', risk: 'medium' },
    ],
    newListings: [
      { token: '2U2/USDT', exchange: 'MEXC', status: '已上线' },
      { token: 'PALCOIN/USDT', exchange: 'MEXC', status: '已上线' },
      { token: 'GIGADEV 永续', exchange: 'Binance', status: '已上线' },
      { token: 'OFFICIAL / JORDAN', exchange: 'Gate Alpha', status: '已上线' },
    ],
    trendingTokens: [
      { token: 'HOOD (Robinhood)', change: '+445%', tag: 'meme', note: '纯炒作, 极高风险' },
      { token: 'CASHCAT', change: '+25.54%', tag: 'meme', note: '月涨幅+1896%' },
      { token: 'HOME', change: '+30%', tag: '上币传闻', note: '传Upbit将上线' },
      { token: 'ZEC (Zcash)', change: '+26.67%', tag: '隐私币', note: '隐私叙事回暖' },
      { token: 'ZRO (LayerZero)', change: '+19.30%', tag: '跨链', note: '跨链协议热度上升' },
      { token: 'UNI (Uniswap)', change: '+8.68%', tag: 'DeFi', note: '手续费新规落地' },
      { token: 'HYPE (Hyperliquid)', change: '+4.2%', tag: 'DeFi', note: '永续合约DEX龙头' },
      { token: 'TAO (Bittensor)', change: '-', tag: 'AI', note: 'AI赛道龙头, ETF预期' },
      { token: 'PUMP (Pump.fun)', change: '+8.18%', tag: 'meme', note: 'meme平台代币' },
    ],
    keyEvents: [
      { event: '黄金单日暴涨4.14%, 突破震荡区间', time: '8/5', impact: '宏观' },
      { event: 'BTC站稳$64,500下降趋势线', time: '今日确认', impact: '趋势' },
      { event: 'ETH $1,920突破 (100日均线)', time: '今日', impact: '趋势' },
      { event: '美国初请失业金人数', time: '8/6 (今晚)', impact: '宏观' },
      { event: '美国CPI数据公布', time: '8/12', impact: '宏观' },
      { event: 'Jackson Hole央行年会', time: '8月下旬', impact: '宏观' },
      { event: 'Ethereum Glamsterdam升级', time: 'Q3-Q4', impact: '生态' },
    ],
    narratives: [
      { name: '黄金避险', tokens: 'XAU, PAXG', desc: '金价突破$4,200, 单日暴涨4%. 美联储9月降息预期升温, 美元走弱. BTC/黄金比率15.12oz, 历史低位区间' },
      { name: 'AI赛道', tokens: 'TAO, Bittensor', desc: '去中心化AI网络, 2026年可能有ETF相关预期' },
      { name: 'DeFi', tokens: 'HYPE, UNI', desc: 'Hyperliquid回购销毁机制; Uniswap手续费新规' },
      { name: 'Meme', tokens: 'HOOD, CASHCAT, PUMP', desc: '纯情绪驱动, 快进快出' },
      { name: 'ETH生态', tokens: 'ETH, EIP-8361', desc: '质押销毁提案 + Glamsterdam升级预期' },
      { name: 'Layer 1', tokens: 'SOL, SUI', desc: 'SOL Alpenglow共识升级; SUI生态扩张' },
    ],
  };
}
