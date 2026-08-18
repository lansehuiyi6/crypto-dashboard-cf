/**
 * Signal Engine - 自有加密货币信号引擎
 *
 * 灵感来源: ValueScan 的机会看涨 + 资金异动方法论
 * 数据源: CoinGecko 免费 API (无需 API Key)
 *
 * 核心逻辑:
 * 1. 多时间框架动量分析 (1h/24h/7d/30d)
 * 2. 成交量异常检测 (当前 vs 历史均值)
 * 3. 趋势一致性评分
 * 4. 综合AI评分 (0-100)
 * 5. 信号分类: Strong Buy / Watch / Risk Alert / Neutral
 * 6. FOMO 检测 (短期加速 + 成交量飙升)
 */

const CG_BASE = 'https://api.coingecko.com/api/v3';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)',
  Accept: 'application/json',
};

async function fetchJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (res.status === 429) {
      lastErr = new Error(`HTTP 429 for ${url}`);
      await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new Error('JSON parse failed: ' + e.message);
    }
  }
  throw lastErr || new Error(`HTTP 429 for ${url}`);
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * 获取 Top N 代币的市场数据（含多时间框架涨跌幅）
 */
async function fetchTopCoinsPage(page = 1, perPage = 50) {
  const url = `${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false&price_change_percentage=1h,24h,7d,30d`;
  const data = await fetchJSON(url);
  return Array.isArray(data) ? data : [];
}

async function fetchTopCoins(limit = 250) {
  const perPage = Math.min(250, limit);
  const pages = Math.ceil(limit / perPage);
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const data = await fetchTopCoinsPage(p, perPage);
    all.push(...data);
  }
  return all.slice(0, limit);
}

/**
 * 获取单个代币的历史价格和成交量（用于成交量异常检测 + EMA反转检测）
 */
async function fetchCoinHistory(coinId, days = 7) {
  const url = `${CG_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
  const data = await fetchJSON(url);
  return {
    prices: data.prices || [],
    volumes: data.total_volumes || [],
  };
}

/**
 * 计算 EMA (指数移动平均线)
 * @param {Array<number>} closes - 收盘价数组（按时间正序）
 * @param {number} period - 周期
 * @returns {Array<number>|null} EMA 数组（前期为null预热）
 */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);

  // 用前 period 个数据的 SMA 作为种子
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema = ema / period;

  const emas = new Array(period - 1).fill(null);
  emas.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emas.push(ema);
  }
  return emas;
}

/**
 * 涨势反转检测 (Trend Reversal Detection)
 *
 * 逻辑:
 * - 1h 级别长期上涨趋势: EMA5 > EMA21 > EMA56 多头排列
 * - 涨势突然逆转: EMA5 死叉 EMA21 (EMA5 下穿 EMA21)
 * - 通常意味着阶段性顶部，是做空机会
 *
 * 判定条件:
 * 1. 24-48h 前是上升趋势 (EMA5 > EMA21 > EMA56)
 * 2. 当前 EMA5 已下穿 EMA21 (死叉)
 * 3. 最近 12h 内 EMA5 还在 EMA21 上方 (刚发生)
 * 4. EMA21 仍在 EMA56 上方 (大趋势未完全破坏)
 * 5. 48h 涨幅 ≥ 5% (确认之前确实涨过, 放宽避免错过死叉后刚开始回落的代币)
 *
 * @param {Array<number>} closes - 1h 收盘价数组
 * @returns {Object|null} 反转信号详情
 */
function detectTrendReversal(closes) {
  if (!closes || closes.length < 60) return null;

  const ema5 = calcEMA(closes, 5);
  const ema21 = calcEMA(closes, 21);
  const ema56 = calcEMA(closes, 56);

  if (!ema5 || !ema21 || !ema56) return null;

  const len = closes.length;
  const now = len - 1;
  const h6 = now - 6;
  const h12 = now - 12;
  const h24 = now - 24;
  const h48 = now - 48;

  // 条件 1: 之前是上升趋势
  const wasUptrend24h = ema5[h24] > ema21[h24] && ema21[h24] > ema56[h24];
  const wasUptrend48h = ema5[h48] > ema21[h48] && ema21[h48] > ema56[h48];
  const wasUptrend = wasUptrend24h || wasUptrend48h;

  // 条件 2: 当前 EMA5 已下穿 EMA21
  const isDeathCross = ema5[now] < ema21[now];

  // 条件 3: 最近 12h 内 EMA5 还在 EMA21 上方 (刚发生)
  const recentlyCrossed = ema5[h12] >= ema21[h12] || ema5[h6] >= ema21[h6];

  // 条件 4: EMA21 仍在 EMA56 上方
  const trendStillStrong = ema21[now] > ema56[now];

  // 条件 5: 48h 涨幅 ≥ 5% (确认之前确实涨过)
  const priceChange48h = closes[h48] > 0 ? ((closes[now] - closes[h48]) / closes[h48]) * 100 : 0;
  const hadGain = priceChange48h >= 5;

  if (!wasUptrend || !isDeathCross || !recentlyCrossed || !trendStillStrong || !hadGain) {
    return null;
  }

  // 计算强度指标
  const crossGap = ((ema21[now] - ema5[now]) / ema21[now]) * 100; // 死叉幅度 (%)
  const priceChange6h = ((closes[now] - closes[h6]) / closes[h6]) * 100; // 6h 价格变化
  const priceChange24h = ((closes[now] - closes[h24]) / closes[h24]) * 100; // 24h 价格变化

  // 7日内峰值 (用于计算回落幅度)
  const lookback = Math.min(168, len); // 7天
  const recentCloses = closes.slice(len - lookback);
  const peakPrice = Math.max(...recentCloses);
  const drawdownFromPeak = peakPrice > 0 ? ((peakPrice - closes[now]) / peakPrice) * 100 : 0;

  // 综合强度评分 (0-100)
  const strength = Math.min(100, Math.round(
    30 + // 基础分
    Math.abs(crossGap) * 5 + // 死叉幅度
    Math.abs(Math.min(0, priceChange6h)) * 2 + // 6h 回落幅度
    Math.max(0, drawdownFromPeak) * 1.5 // 距峰值回落
  ));

  return {
    type: 'trendReversal',
    labelCn: '涨势反转',
    labelEn: 'TREND REVERSAL',
    color: '#ff5252',
    icon: '📉',
    desc: '长期上涨后 EMA5 死叉 EMA21，阶段性顶部信号',

    // 指标
    crossGap: Math.round(crossGap * 100) / 100,
    priceChange24h: Math.round(priceChange24h * 100) / 100,
    priceChange6h: Math.round(priceChange6h * 100) / 100,
    peakPrice,
    drawdownFromPeak: Math.round(drawdownFromPeak * 100) / 100,

    // EMA 当前值
    ema5: ema5[now],
    ema21: ema21[now],
    ema56: ema56[now],

    // 死叉发生时间 (估算)
    crossedAgoHours: estimateCrossTimeAgo(closes, ema5, ema21, 12),

    // 综合强度
    strength,
  };
}

/**
 * 估算 EMA 死叉发生在多少小时前
 */
function estimateCrossTimeAgo(closes, ema5, ema21, maxLookback = 12) {
  const now = closes.length - 1;
  for (let i = 0; i < maxLookback; i++) {
    const idx = now - i;
    if (idx < 21) break; // 数据不够
    if (ema5[idx] >= ema21[idx]) {
      return i; // i 小时前还在 EMA21 上方
    }
  }
  return maxLookback; // 至少 12h 前
}

/**
 * 估算 EMA 金叉发生在多少小时前
 */
function estimateGoldenCrossTimeAgo(closes, ema5, ema21, maxLookback = 12) {
  const now = closes.length - 1;
  for (let i = 0; i < maxLookback; i++) {
    const idx = now - i;
    if (idx < 21) break;
    if (ema5[idx] <= ema21[idx]) {
      return i; // i 小时前还在 EMA21 下方
    }
  }
  return maxLookback;
}

/**
 * 跌势反转检测 (Bottom Reversal Detection)
 *
 * 逻辑:
 * - 1h 级别长期下跌趋势: EMA5 < EMA21 < EMA56 空头排列
 * - 跌势突然逆转: EMA5 金叉 EMA21 (EMA5 上穿 EMA21)
 * - 通常意味着阶段性底部，是做多机会
 *
 * 判定条件:
 * 1. 24-48h 前是下跌趋势 (EMA5 < EMA21 < EMA56)
 * 2. 当前 EMA5 已上穿 EMA21 (金叉)
 * 3. 最近 12h 内 EMA5 还在 EMA21 下方 (刚发生)
 * 4. EMA21 仍在 EMA56 下方 (大趋势未完全修复)
 * 5. 48h 跌幅 ≥ 5% (确认之前确实跌过)
 *
 * @param {Array<number>} closes - 1h 收盘价数组
 * @returns {Object|null} 底部反转信号详情
 */
function detectBottomReversal(closes) {
  if (!closes || closes.length < 60) return null;

  const ema5 = calcEMA(closes, 5);
  const ema21 = calcEMA(closes, 21);
  const ema56 = calcEMA(closes, 56);

  if (!ema5 || !ema21 || !ema56) return null;

  const len = closes.length;
  const now = len - 1;
  const h6 = now - 6;
  const h12 = now - 12;
  const h24 = now - 24;
  const h48 = now - 48;

  // 条件 1: 之前是下跌趋势 (空头排列)
  const wasDowntrend24h = ema5[h24] < ema21[h24] && ema21[h24] < ema56[h24];
  const wasDowntrend48h = ema5[h48] < ema21[h48] && ema21[h48] < ema56[h48];
  const wasDowntrend = wasDowntrend24h || wasDowntrend48h;

  // 条件 2: 当前 EMA5 已上穿 EMA21 (金叉)
  const isGoldenCross = ema5[now] > ema21[now];

  // 条件 3: 最近 12h 内 EMA5 还在 EMA21 下方 (刚发生)
  const recentlyCrossed = ema5[h12] <= ema21[h12] || ema5[h6] <= ema21[h6];

  // 条件 4: EMA21 仍在 EMA56 下方 (大趋势未完全修复)
  const trendStillBearish = ema21[now] < ema56[now];

  // 条件 5: 48h 跌幅 ≥ 5% (确认之前确实跌过)
  const priceChange48h = closes[h48] > 0 ? ((closes[now] - closes[h48]) / closes[h48]) * 100 : 0;
  const hadLoss = priceChange48h <= -5;

  if (!wasDowntrend || !isGoldenCross || !recentlyCrossed || !trendStillBearish || !hadLoss) {
    return null;
  }

  // 计算强度指标
  const crossGap = ((ema5[now] - ema21[now]) / ema21[now]) * 100; // 金叉幅度 (%)
  const priceChange6h = ((closes[now] - closes[h6]) / closes[h6]) * 100; // 6h 价格变化
  const priceChange24h = ((closes[now] - closes[h24]) / closes[h24]) * 100; // 24h 价格变化

  // 7日内谷底 (用于计算反弹幅度)
  const lookback = Math.min(168, len); // 7天
  const recentCloses = closes.slice(len - lookback);
  const troughPrice = Math.min(...recentCloses);
  const bounceFromTrough = troughPrice > 0 ? ((closes[now] - troughPrice) / troughPrice) * 100 : 0;

  // 综合强度评分 (0-100)
  const strength = Math.min(100, Math.round(
    30 + // 基础分
    Math.abs(crossGap) * 5 + // 金叉幅度
    Math.abs(Math.max(0, priceChange6h)) * 2 + // 6h 反弹幅度
    Math.max(0, bounceFromTrough) * 1.5 // 距谷底反弹
  ));

  return {
    type: 'bottomReversal',
    labelCn: '跌势反转',
    labelEn: 'BOTTOM REVERSAL',
    color: '#00e676',
    icon: '📈',
    desc: '长期下跌后 EMA5 金叉 EMA21，阶段性底部信号',

    // 指标
    crossGap: Math.round(crossGap * 100) / 100,
    priceChange24h: Math.round(priceChange24h * 100) / 100,
    priceChange6h: Math.round(priceChange6h * 100) / 100,
    troughPrice,
    bounceFromTrough: Math.round(bounceFromTrough * 100) / 100,

    // EMA 当前值
    ema5: ema5[now],
    ema21: ema21[now],
    ema56: ema56[now],

    // 金叉发生时间 (估算)
    crossedAgoHours: estimateGoldenCrossTimeAgo(closes, ema5, ema21, 12),

    // 综合强度
    strength,
  };
}

/**
 * 获取 Trending 代币列表
 */
async function fetchTrending() {
  const data = await fetchJSON(`${CG_BASE}/search/trending`);
  return (data.coins || []).map(c => ({
    id: c.item?.id,
    symbol: c.item?.symbol,
    name: c.item?.name,
    rank: c.item?.market_cap_rank,
  }));
}

// ============================================================
//  评分算法
// ============================================================

/**
 * 动量评分 (0-100)
 * 基于 1h/24h/7d/30d 四个时间框架的加权涨跌幅
 *
 * 权重设计:
 * - 1h: 15% (短期动量，捕捉即时方向)
 * - 24h: 35% (日内动量，最重要时间框架)
 * - 7d: 30% (周线趋势，中期方向)
 * - 30d: 20% (月线趋势，长期背景)
 */
function calcMomentumScore(changes) {
  const { h1, h24, d7, d30 } = changes;

  // 各时间框架得分映射 (涨跌幅 -> 0-100分)
  // 使用 tanh 函数将涨跌幅映射到 0-100，避免极端值影响
  function scoreChange(pct) {
    if (pct == null || isNaN(pct)) return 50; // 无数据视为中性
    // tanh 映射: 0% -> 50, +10% -> ~70, +30% -> ~88, -10% -> ~30, -30% -> ~12
    return Math.round(50 + 38 * Math.tanh(pct / 15));
  }

  const s1h = scoreChange(h1);
  const s24h = scoreChange(h24);
  const s7d = scoreChange(d7);
  const s30d = scoreChange(d30);

  const weighted = s1h * 0.15 + s24h * 0.35 + s7d * 0.30 + s30d * 0.20;
  return Math.round(weighted);
}

/**
 * 趋势一致性评分 (0-100)
 * 检查各时间框架是否方向一致
 * - 全部上涨: 高分
 * - 方向不一致: 低分
 * - 全部下跌: 低分但可能做空机会
 */
function calcTrendConsistency(changes) {
  const { h1, h24, d7, d30 } = changes;
  const dirs = [h1, h24, d7, d30].filter(v => v != null && !isNaN(v)).map(v => v > 0 ? 1 : -1);
  if (dirs.length === 0) return 50;

  const sum = dirs.reduce((a, b) => a + b, 0);
  const consistency = Math.abs(sum) / dirs.length; // 0 = 完全不一致, 1 = 完全一致
  const direction = sum > 0 ? 1 : -1; // 1 = 看涨一致, -1 = 看跌一致

  // 一致性 * 方向 -> 看涨一致高分, 看跌一致低分
  return Math.round(50 + direction * consistency * 45);
}

/**
 * 成交量评分 (0-100)
 * 基于成交量比率 (当前24h成交量 / 市值)
 * 高比率 = 活跃交易，可能有大资金进出
 */
function calcVolumeScore(coin) {
  const volume = coin.total_volume || 0;
  const mcap = coin.market_cap || 1;
  const volRatio = volume / mcap; // 成交量/市值 比率

  // 比率映射:
  // < 2%: 极低活跃度 -> 20
  // 2-5%: 低 -> 35
  // 5-15%: 正常 -> 55
  // 15-30%: 活跃 -> 70
  // 30-50%: 高度活跃 -> 82
  // > 50%: 极度活跃(可能FOMO) -> 90
  let score;
  if (volRatio < 0.02) score = 20;
  else if (volRatio < 0.05) score = 35;
  else if (volRatio < 0.15) score = 55;
  else if (volRatio < 0.30) score = 70;
  else if (volRatio < 0.50) score = 82;
  else score = 90;

  return score;
}

/**
 * 市值位置评分 (0-100)
 * 小市值代币弹性更大但也更危险
 * 大市值代币更稳定但涨幅有限
 */
function calcMarketPositionScore(coin) {
  const rank = coin.market_cap_rank || 999;
  const mcap = coin.market_cap || 0;

  // 排名映射:
  // Top 10: 60 (稳定但弹性小)
  // 11-50: 65 (蓝筹+一定弹性)
  // 51-100: 72 (中等市值，平衡点)
  // 101-200: 78 (中小市值，高弹性)
  // 201-500: 82 (小市值，极高弹性)
  // 500+: 70 (太小，流动性风险)

  let score;
  if (rank <= 10) score = 60;
  else if (rank <= 50) score = 65;
  else if (rank <= 100) score = 72;
  else if (rank <= 200) score = 78;
  else if (rank <= 500) score = 82;
  else score = 70;

  return score;
}

/**
 * FOMO 检测
 * 当短期(1h)涨幅和成交量同时飙升时触发
 */
function detectFOMO(coin, changes) {
  const h1 = changes.h1 || 0;
  const h24 = changes.h24 || 0;
  const volRatio = (coin.total_volume || 0) / (coin.market_cap || 1);

  // FOMO 条件:
  // 1. 1h 涨幅 > 5% 且 24h 涨幅 > 15%
  // 2. 成交量/市值 > 30%
  const rapidPrice = h1 > 5 && h24 > 15;
  const highVolume = volRatio > 0.30;
  const extremePrice = h1 > 10 || h24 > 30;

  if (rapidPrice && highVolume) {
    return {
      fomo: true,
      escalation: extremePrice, // 极端涨幅标记为 escalation
      level: extremePrice ? 'extreme' : 'high',
    };
  }

  // 轻度 FOMO
  if (h1 > 3 && h24 > 8 && volRatio > 0.15) {
    return { fomo: true, escalation: false, level: 'moderate' };
  }

  return { fomo: false, escalation: false, level: 'none' };
}

/**
 * 资金异动检测
 * 类似 ValueScan 的 alert 逻辑
 * 基于成交量异常 + 价格变动
 */
function detectFundMovement(coin, changes, volHistory) {
  const h24 = changes.h24 || 0;
  const currentVol = coin.total_volume || 0;

  // 如果有历史成交量数据，计算异常度
  let volAnomaly = 0;
  let avgVol = 0;
  if (volHistory && volHistory.length > 5) {
    const recentVols = volHistory.slice(-24).map(v => v[1]);
    avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    if (avgVol > 0) {
      volAnomaly = (currentVol - avgVol) / avgVol; // 正数 = 放量, 负数 = 缩量
    }
  }

  // 异动判定:
  // - 成交量放大 > 2倍均值 + 涨幅 > 5% -> 强异动(看涨)
  // - 成交量放大 > 1.5倍均值 + 涨幅 > 3% -> 中等异动
  // - 成交量放大 > 2倍均值 + 跌幅 > 5% -> 强异动(看跌)
  let movementType = 'none';
  let strength = 0;

  if (volAnomaly > 1.0 && h24 > 5) {
    movementType = 'bullish';
    strength = Math.min(100, Math.round(50 + volAnomaly * 15 + h24 * 1.5));
  } else if (volAnomaly > 0.5 && h24 > 3) {
    movementType = 'bullish';
    strength = Math.min(80, Math.round(35 + volAnomaly * 20 + h24));
  } else if (volAnomaly > 1.0 && h24 < -5) {
    movementType = 'bearish';
    strength = Math.min(100, Math.round(50 + volAnomaly * 15 + Math.abs(h24) * 1.5));
  } else if (volAnomaly > 0.5 && h24 < -3) {
    movementType = 'bearish';
    strength = Math.min(80, Math.round(35 + volAnomaly * 20 + Math.abs(h24)));
  }

  return {
    type: movementType,
    strength,
    volAnomaly: Math.round(volAnomaly * 100) / 100,
    avgVol,
    currentVol,
    ratio: avgVol > 0 ? Math.round((currentVol / avgVol) * 100) / 100 : 0,
  };
}

/**
 * 综合信号评分 (0-100)
 * 组合所有维度
 *
 * 权重:
 * - 动量: 35%
 * - 趋势一致性: 20%
 * - 成交量: 20%
 * - 市值位置: 10%
 * - 资金异动: 15%
 */
function calcCompositeScore(momentum, consistency, volume, marketPos, fundMovement) {
  // 资金异动分数转换
  let fmScore = 50;
  if (fundMovement.type === 'bullish') fmScore = 50 + fundMovement.strength * 0.4;
  else if (fundMovement.type === 'bearish') fmScore = 50 - fundMovement.strength * 0.4;

  const score =
    momentum * 0.35 +
    consistency * 0.20 +
    volume * 0.20 +
    marketPos * 0.10 +
    fmScore * 0.15;

  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * 信号分类
 */
function classifySignal(score, fomo, fundMovement) {
  if (score >= 75) {
    return {
      label: 'STRONG BUY',
      labelCn: '强烈买入',
      color: '#00e676',
      icon: '🟢',
      desc: '多维度信号共振, 动量+成交量+趋势一致',
    };
  } else if (score >= 62) {
    return {
      label: 'BUY',
      labelCn: '建议买入',
      color: '#76ff03',
      icon: '🟩',
      desc: '偏多信号, 可轻仓试多',
    };
  } else if (score >= 55) {
    return {
      label: 'WATCH',
      labelCn: '值得关注',
      color: '#ffd54f',
      icon: '🟡',
      desc: '信号偏多但不够强, 持续观察',
    };
  } else if (score >= 45) {
    return {
      label: 'NEUTRAL',
      labelCn: '中性观望',
      color: '#b0bec5',
      icon: '⚪',
      desc: '多空不明, 建议观望',
    };
  } else if (score >= 35) {
    return {
      label: 'CAUTION',
      labelCn: '谨慎',
      color: '#ff9800',
      icon: '🟠',
      desc: '偏空信号, 注意下行风险',
    };
  } else {
    return {
      label: 'RISK ALERT',
      labelCn: '风险预警',
      color: '#ff5252',
      icon: '🔴',
      desc: '多维度看空, 建议减仓或回避',
    };
  }
}

/**
 * 计算看涨/看跌比率
 * 类似 ValueScan 的 bullishRatio
 */
function calcBullBearRatio(changes) {
  const { h1, h24, d7, d30 } = changes;
  const timeframes = [h1, h24, d7, d30].filter(v => v != null && !isNaN(v));
  if (timeframes.length === 0) return { bullish: 0.5, bearish: 0.5 };

  const bullish = timeframes.filter(v => v > 0).length;
  const bearish = timeframes.filter(v => v < 0).length;
  return {
    bullish: Math.round((bullish / timeframes.length) * 100) / 100,
    bearish: Math.round((bearish / timeframes.length) * 100) / 100,
  };
}

/**
 * 生成单个代币的完整信号
 */
function generateCoinSignal(coin, volHistory, priceHistory) {
  const changes = {
    h1: coin.price_change_percentage_1h_in_currency,
    h24: coin.price_change_percentage_24h_in_currency,
    d7: coin.price_change_percentage_7d_in_currency,
    d30: coin.price_change_percentage_30d_in_currency,
  };

  const momentum = calcMomentumScore(changes);
  const consistency = calcTrendConsistency(changes);
  const volume = calcVolumeScore(coin);
  const marketPos = calcMarketPositionScore(coin);
  const fundMovement = detectFundMovement(coin, changes, volHistory);
  const fomo = detectFOMO(coin, changes);
  const bullBear = calcBullBearRatio(changes);
  const score = calcCompositeScore(momentum, consistency, volume, marketPos, fundMovement);
  const classification = classifySignal(score, fomo, fundMovement);

  // 涨势反转检测 (需要 1h 收盘价数据)
  let reversal = null;
  let bottomReversal = null;
  if (priceHistory && priceHistory.length > 60) {
    const closes = priceHistory.map(p => p[1]); // [timestamp, price] -> price
    reversal = detectTrendReversal(closes);
    bottomReversal = detectBottomReversal(closes);
  }

  // 计算 "gains" 和 "decline" (类似 ValueScan)
  const allChanges = Object.values(changes).filter(v => v != null && !isNaN(v));
  const gains = allChanges.length > 0 ? Math.max(...allChanges) : 0;
  const decline = allChanges.length > 0 ? Math.abs(Math.min(...allChanges)) : 0;

  return {
    // 基本信息
    id: coin.id,
    symbol: coin.symbol?.toUpperCase(),
    name: coin.name,
    image: coin.image,
    price: coin.current_price,
    marketCap: coin.market_cap,
    marketCapRank: coin.market_cap_rank,
    volume24h: coin.total_volume,

    // 涨跌幅
    changes: {
      h1: changes.h1 != null ? Math.round(changes.h1 * 100) / 100 : null,
      h24: changes.h24 != null ? Math.round(changes.h24 * 100) / 100 : null,
      d7: changes.d7 != null ? Math.round(changes.d7 * 100) / 100 : null,
      d30: changes.d30 != null ? Math.round(changes.d30 * 100) / 100 : null,
    },

    // 评分系统
    scores: {
      composite: score,
      momentum,
      consistency,
      volume,
      marketPosition: marketPos,
    },

    // 信号标签
    signal: classification,

    // 资金异动
    fundMovement,

    // FOMO
    fomo,

    // 看涨/看跌比率
    bullBearRatio: bullBear,

    // 涨跌极值
    gains: Math.round(gains * 100) / 100,
    decline: Math.round(decline * 100) / 100,

    // 涨势反转信号 (如果有)
    reversal,

    // 跌势反转信号 (如果有)
    bottomReversal,
  };
}

/**
 * 主函数: 生成全市场信号
 */
async function generateMarketSignals(options = {}) {
  const {
    limit = 250,
    includeVolHistory = true,
    volHistoryDays = 7,
    minScore = 0,
    signalFilter = 'all', // 'all' | 'bullish' | 'bearish' | 'fomo' | 'fundMovement'
  } = options;

  // 1. 获取 Top N 代币
  const coins = await fetchTopCoins(limit);

  // 2. Top 50 拉历史（成交量异常 + EMA 反转）。Cloudflare 上用有限并发代替串行 200ms
  const historyById = {};
  if (includeVolHistory) {
    const historyCoins = coins.slice(0, 50);
    await mapPool(historyCoins, 4, async (coin) => {
      try {
        historyById[coin.id] = await fetchCoinHistory(coin.id, volHistoryDays);
      } catch {
        // 忽略单个代币历史错误
      }
    });
  }

  const signals = [];
  for (const coin of coins) {
    try {
      const history = historyById[coin.id];
      signals.push(generateCoinSignal(coin, history?.volumes || null, history?.prices || null));
    } catch {
      // 忽略单个代币的错误
    }
  }

  // 3. 按综合评分排序
  signals.sort((a, b) => b.scores.composite - a.scores.composite);

  // 4. 过滤
  let filtered = signals;
  if (signalFilter === 'bullish') {
    filtered = signals.filter(s => s.scores.composite >= 55);
  } else if (signalFilter === 'bearish') {
    filtered = signals.filter(s => s.scores.composite <= 45);
  } else if (signalFilter === 'fomo') {
    filtered = signals.filter(s => s.fomo.fomo);
  } else if (signalFilter === 'fundMovement') {
    filtered = signals.filter(s => s.fundMovement.type !== 'none');
  }

  if (minScore > 0) {
    filtered = filtered.filter(s => s.scores.composite >= minScore);
  }

  // 5. 生成统计摘要
  const summary = {
    totalScanned: coins.length,
    totalSignals: filtered.length,
    strongBuy: signals.filter(s => s.scores.composite >= 75).length,
    buy: signals.filter(s => s.scores.composite >= 62 && s.scores.composite < 75).length,
    watch: signals.filter(s => s.scores.composite >= 55 && s.scores.composite < 62).length,
    neutral: signals.filter(s => s.scores.composite >= 45 && s.scores.composite < 55).length,
    caution: signals.filter(s => s.scores.composite >= 35 && s.scores.composite < 45).length,
    riskAlert: signals.filter(s => s.scores.composite < 35).length,
    fomoCount: signals.filter(s => s.fomo.fomo).length,
    fundMovementBullish: signals.filter(s => s.fundMovement.type === 'bullish').length,
    fundMovementBearish: signals.filter(s => s.fundMovement.type === 'bearish').length,
    reversalCount: signals.filter(s => s.reversal).length,
    bottomReversalCount: signals.filter(s => s.bottomReversal).length,
    generatedAt: new Date().toISOString(),
  };

  return {
    summary,
    signals: filtered, // 返回全部 (服务端负责再次过滤和截断)
  };
}

/**
 * 获取 Trending 代币并生成信号
 */
async function generateTrendingSignals() {
  const trending = await fetchTrending();
  const trendingIds = trending.map(t => t.id).filter(Boolean);

  if (trendingIds.length === 0) return { trending: [], signals: [] };

  // 获取这些代币的详细市场数据
  const url = `${CG_BASE}/coins/markets?vs_currency=usd&ids=${trendingIds.join(',')}&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=1h,24h,7d,30d`;
  const coins = await fetchJSON(url);

  const signals = coins.map(coin => {
    try {
      return generateCoinSignal(coin, null);
    } catch {
      return null;
    }
  }).filter(Boolean);

  signals.sort((a, b) => b.scores.composite - a.scores.composite);

  return {
    trending: trending.map(t => ({ symbol: t.symbol?.toUpperCase(), name: t.name, rank: t.rank })),
    signals,
  };
}

export {
  fetchTopCoins,
  fetchTopCoinsPage,
  fetchCoinHistory,
  fetchTrending,
  generateCoinSignal,
  generateMarketSignals,
  generateTrendingSignals,
  calcMomentumScore,
  calcTrendConsistency,
  calcVolumeScore,
  calcMarketPositionScore,
  detectFOMO,
  detectFundMovement,
  calcCompositeScore,
  classifySignal,
  calcBullBearRatio,
};
