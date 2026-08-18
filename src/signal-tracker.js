/**
 * Signal Tracker - 信号持久化追踪器
 *
 * 功能:
 * 1. 每次扫描后更新历史对象（由 Durable Object 持久化）
 * 2. 追踪每个代币信号的首次出现时间、评分历史、价格变化
 * 3. 计算信号年龄、评分趋势、生命周期阶段
 * 4. 自动清理 24h 未更新的过期信号
 *
 * 类似 ValueScan 的 beginTime/endTime/scoreChange 机制
 */

const MAX_HISTORY_POINTS = 50;    // 每个信号最多保留 50 个历史评分点
const EXPIRE_HOURS = 24;          // 24h 未更新自动过期
const SIGNAL_THRESHOLD = 55;      // 评分 >= 55 才视为有效信号（看涨侧）
const BEARISH_THRESHOLD = 45;     // 评分 <= 45 才视为有效信号（看跌侧）

function emptyHistory() {
  return { signals: {}, lastUpdated: null, scanCount: 0 };
}

/**
 * 追踪一批新信号
 * @param {Array} signals - 当前扫描生成的信号列表
 * @param {Object} history - 已有历史（由 Durable Object 读出）
 * @returns {Object} 更新后的历史数据
 */
function trackSignals(signals, history) {
  if (!history || !history.signals) history = emptyHistory();
  const now = Date.now();
  history.scanCount = (history.scanCount || 0) + 1;

  // 标记所有旧信号为 "not seen this scan"
  for (const sym of Object.keys(history.signals)) {
    history.signals[sym]._seenThisScan = false;
  }

  // 更新/创建信号记录
  for (const sig of signals) {
    const sym = sig.symbol;
    const existing = history.signals[sym];

    if (existing) {
      // 已有信号 — 更新
      existing._seenThisScan = true;
      existing.lastSeenAt = now;
      existing.lastScore = sig.scores.composite;
      existing.lastPrice = sig.price;
      existing.lastSignal = sig.signal.labelCn;

      // 追加评分历史 (限制长度)
      if (!existing.scoreHistory) existing.scoreHistory = [];
      existing.scoreHistory.push({
        t: now,
        score: sig.scores.composite,
        price: sig.price,
      });
      if (existing.scoreHistory.length > MAX_HISTORY_POINTS) {
        existing.scoreHistory = existing.scoreHistory.slice(-MAX_HISTORY_POINTS);
      }

      // 更新峰值/谷值
      if (sig.scores.composite > (existing.peakScore || 0)) {
        existing.peakScore = sig.scores.composite;
        existing.peakTime = now;
        existing.peakPrice = sig.price;
      }
      if (sig.scores.composite < (existing.troughScore || 100)) {
        existing.troughScore = sig.scores.composite;
        existing.troughTime = now;
      }
    } else {
      // 新信号 — 创建
      history.signals[sym] = {
        symbol: sym,
        name: sig.name,
        firstSeenAt: now,
        lastSeenAt: now,
        firstScore: sig.scores.composite,
        lastScore: sig.scores.composite,
        firstPrice: sig.price,
        lastPrice: sig.price,
        firstSignal: sig.signal.labelCn,
        lastSignal: sig.signal.labelCn,
        peakScore: sig.scores.composite,
        peakTime: now,
        peakPrice: sig.price,
        troughScore: sig.scores.composite,
        troughTime: now,
        scoreHistory: [{ t: now, score: sig.scores.composite, price: sig.price }],
        _seenThisScan: true,
      };
    }
  }

  // 清理过期信号 (24h 未更新)
  const expireMs = EXPIRE_HOURS * 60 * 60 * 1000;
  let expiredCount = 0;
  for (const sym of Object.keys(history.signals)) {
    const s = history.signals[sym];
    if (now - s.lastSeenAt > expireMs) {
      delete history.signals[sym];
      expiredCount++;
    }
  }

  history.lastUpdated = new Date().toISOString();
  return history;
}

/**
 * 获取某个代币信号的生命周期信息
 * @param {string} symbol
 * @returns {Object|null} 生命周期信息
 */
function getLifecycle(symbol, currentScore, history) {
  const tracked = history?.signals?.[symbol];

  if (!tracked) {
    // 没有历史记录 — 全新信号
    return {
      hasHistory: false,
      ageMinutes: 0,
      ageLabel: '新信号',
      stage: 'emerging',
      stageLabel: '初始阶段',
      stageColor: '#00e676',
      scoreTrend: 'new',
      scoreTrendArrow: '🆕',
      scoreChange: 0,
      priceChangeSinceStart: 0,
      firstSeenAt: null,
      scanCount: 0,
    };
  }

  const now = Date.now();
  const ageMs = now - tracked.firstSeenAt;
  const ageMinutes = Math.floor(ageMs / 60000);
  const ageHours = Math.floor(ageMinutes / 60);

  // 信号年龄标签
  let ageLabel;
  if (ageMinutes < 5) ageLabel = '刚刚';
  else if (ageMinutes < 30) ageLabel = `${ageMinutes}分钟`;
  else if (ageMinutes < 60) ageLabel = `${ageMinutes}分钟`;
  else if (ageHours < 24) ageLabel = `${ageHours}小时${ageMinutes % 60}分`;
  else ageLabel = `${Math.floor(ageHours / 24)}天${ageHours % 24}小时`;

  // 评分趋势 (对比最近 N 个评分点)
  let scoreTrend = 'stable';
  let scoreTrendArrow = '→';
  let scoreChange = 0;

  if (tracked.scoreHistory && tracked.scoreHistory.length >= 2) {
    const recent = tracked.scoreHistory.slice(-5);
    const firstRecent = recent[0].score;
    const lastRecent = recent[recent.length - 1].score;
    scoreChange = lastRecent - firstRecent;

    if (scoreChange > 5) {
      scoreTrend = 'rising';
      scoreTrendArrow = '↑';
    } else if (scoreChange < -5) {
      scoreTrend = 'falling';
      scoreTrendArrow = '↓';
    }
  }

  // 从信号开始的价格变化
  const priceChangeSinceStart = tracked.firstPrice > 0
    ? Math.round(((currentScore !== undefined ? tracked.lastPrice : tracked.lastPrice) - tracked.firstPrice) / tracked.firstPrice * 10000) / 100
    : 0;

  // 从峰值的变化
  const scoreFromPeak = (currentScore || tracked.lastScore) - tracked.peakScore;

  // === 生命周期阶段判定 ===
  // 综合考虑: 信号年龄 + 评分趋势 + 距峰值距离 + 技术面加速/衰减
  let stage = 'active';
  let stageLabel = '活跃阶段';
  let stageColor = '#76ff03';

  const currentSc = currentScore || tracked.lastScore;

  if (ageMinutes < 15) {
    // 0-15分钟: 初始阶段
    stage = 'emerging';
    stageLabel = '初始阶段';
    stageColor = '#00e676';
  } else if (ageMinutes < 60) {
    // 15-60分钟: 根据趋势判断
    if (scoreTrend === 'rising' && scoreFromPeak >= -2) {
      stage = 'accelerating';
      stageLabel = '加速阶段';
      stageColor = '#00e676';
    } else if (scoreTrend === 'falling' && scoreFromPeak < -5) {
      stage = 'peaking';
      stageLabel = '见顶阶段';
      stageColor = '#ffd54f';
    } else {
      stage = 'active';
      stageLabel = '活跃阶段';
      stageColor = '#76ff03';
    }
  } else if (ageHours < 4) {
    // 1-4小时: 根据趋势判断是否还在活跃
    if (scoreTrend === 'rising') {
      stage = 'active';
      stageLabel = '持续走强';
      stageColor = '#76ff03';
    } else if (scoreTrend === 'falling' && scoreFromPeak < -8) {
      stage = 'fading';
      stageLabel = '动能衰减';
      stageColor = '#ff9800';
    } else if (scoreFromPeak < -3) {
      stage = 'peaking';
      stageLabel = '高位震荡';
      stageColor = '#ffd54f';
    } else {
      stage = 'active';
      stageLabel = '活跃阶段';
      stageColor = '#76ff03';
    }
  } else if (ageHours < 12) {
    // 4-12小时: 大多数信号在这个阶段开始衰减
    if (scoreTrend === 'rising' && currentSc >= 60) {
      stage = 'active';
      stageLabel = '二次加速';
      stageColor = '#76ff03';
    } else if (scoreFromPeak < -10 || scoreTrend === 'falling') {
      stage = 'fading';
      stageLabel = '动能衰减';
      stageColor = '#ff9800';
    } else {
      stage = 'mature';
      stageLabel = '成熟阶段';
      stageColor = '#ffd54f';
    }
  } else {
    // 12小时+: 长期信号
    if (scoreTrend === 'rising' && currentSc >= 60) {
      stage = 'active';
      stageLabel = '持续活跃';
      stageColor = '#76ff03';
    } else {
      stage = 'mature';
      stageLabel = '成熟/衰减';
      stageColor = '#ff9800';
    }
  }

  return {
    hasHistory: true,
    ageMinutes,
    ageHours,
    ageLabel,
    stage,
    stageLabel,
    stageColor,
    scoreTrend,
    scoreTrendArrow,
    scoreChange,
    priceChangeSinceStart,
    firstSeenAt: new Date(tracked.firstSeenAt).toISOString(),
    peakScore: tracked.peakScore,
    peakTime: new Date(tracked.peakTime).toISOString(),
    scoreFromPeak,
    scanCount: tracked.scoreHistory?.length || 1,
    firstScore: tracked.firstScore,
    firstPrice: tracked.firstPrice,
  };
}

/**
 * 批量获取多个信号的生命周期信息
 * @param {Array} signals - 当前信号列表
 * @param {Object} vsAlertMap - ValueScan 资金异动数据按 symbol 映射 (可选)
 * @returns {Array} 附加了 lifecycle 字段的信号列表
 */
function enrichWithLifecycle(signals, vsAlertMap = {}, history) {
  return signals.map(sig => {
    const lifecycle = getLifecycle(sig.symbol, sig.scores.composite, history);

    // === 技术面阶段推断 (不依赖持久化) ===
    // 通过 1h/24h 涨幅比率判断动量是加速还是衰减
    const h1 = sig.changes.h1 || 0;
    const h24 = sig.changes.h24 || 0;
    const d7 = sig.changes.d7 || 0;
    const d30 = sig.changes.d30 || 0;

    let techStage = 'stable';
    let techStageLabel = '';
    let techStageColor = '';

    // === 新增: 涨幅幅度评估 (move magnitude) ===
    // 解决"涨了107%仍显示初始加速"的问题
    // 通过多时间框架涨幅判断行情处于什么阶段
    let magnitudeStage = '';
    let magnitudeLabel = '';
    let magnitudeColor = '';
    let magnitudeScore = 0; // 0=正常, 越高越成熟

    // 计算累积涨幅得分
    // 24h涨幅越大 → 行情越成熟
    if (Math.abs(h24) > 100) magnitudeScore += 4;
    else if (Math.abs(h24) > 50) magnitudeScore += 3;
    else if (Math.abs(h24) > 30) magnitudeScore += 2;
    else if (Math.abs(h24) > 15) magnitudeScore += 1;

    // 7d涨幅
    if (Math.abs(d7) > 200) magnitudeScore += 4;
    else if (Math.abs(d7) > 100) magnitudeScore += 3;
    else if (Math.abs(d7) > 50) magnitudeScore += 2;
    else if (Math.abs(d7) > 25) magnitudeScore += 1;

    // 30d涨幅
    if (Math.abs(d30) > 300) magnitudeScore += 3;
    else if (Math.abs(d30) > 150) magnitudeScore += 2;
    else if (Math.abs(d30) > 75) magnitudeScore += 1;

    // 交叉引用 ValueScan alert 数据 (如果有的话)
    let vsGains = null;
    let vsBeginPrice = null;
    const vsData = vsAlertMap[sig.symbol?.toUpperCase()] || vsAlertMap[sig.symbol];
    if (vsData) {
      vsGains = vsData.gains != null ? Number(vsData.gains) : null;
      vsBeginPrice = vsData.beginPrice != null ? Number(vsData.beginPrice) : null;
      // ValueScan 的 gains 是从信号开始到现在的总涨幅
      if (vsGains != null && vsGains > 50) magnitudeScore += 3;
      else if (vsGains != null && vsGains > 20) magnitudeScore += 2;
      else if (vsGains != null && vsGains > 10) magnitudeScore += 1;
    }

    // 根据 magnitudeScore 判断行情成熟度
    const isBullish = h24 >= 0;
    if (magnitudeScore >= 7) {
      magnitudeStage = 'exhaustion';
      magnitudeLabel = isBullish ? '可能耗竭' : '可能见底';
      magnitudeColor = isBullish ? '#ff5252' : '#00e676';
    } else if (magnitudeScore >= 4) {
      magnitudeStage = 'extended';
      magnitudeLabel = '行情扩展';
      magnitudeColor = '#ff9800';
    } else if (magnitudeScore >= 2) {
      magnitudeStage = 'developed';
      magnitudeLabel = '行情发展';
      magnitudeColor = '#ffd54f';
    }

    // === 原有的动量加速/衰减判断 ===
    if (h24 > 0) {
      const expectedHourlyRate = h24 / 24;
      const accelerationRatio = expectedHourlyRate !== 0 ? h1 / expectedHourlyRate : 0;

      if (accelerationRatio > 3) {
        techStage = 'accelerating';
        techStageLabel = '动量加速';
        techStageColor = '#00e676';
      } else if (accelerationRatio > 1) {
        techStage = 'active';
        techStageLabel = '动量持续';
        techStageColor = '#76ff03';
      } else if (accelerationRatio > 0.3) {
        techStage = 'decelerating';
        techStageLabel = '动量放缓';
        techStageColor = '#ffd54f';
      } else if (accelerationRatio > 0) {
        techStage = 'fading';
        techStageLabel = '动量衰减';
        techStageColor = '#ff9800';
      } else if (h1 < 0 && h24 > 0) {
        techStage = 'reversing';
        techStageLabel = '可能反转';
        techStageColor = '#ff5252';
      }
    } else if (h24 < 0) {
      const expectedHourlyRate = h24 / 24;
      const accelerationRatio = expectedHourlyRate !== 0 ? h1 / expectedHourlyRate : 0;

      if (accelerationRatio > 3) {
        techStage = 'accelerating_bear';
        techStageLabel = '跌势加速';
        techStageColor = '#ff5252';
      } else if (accelerationRatio > 1) {
        techStage = 'active_bear';
        techStageLabel = '跌势持续';
        techStageColor = '#ff5252';
      } else if (accelerationRatio > 0.3) {
        techStage = 'decelerating_bear';
        techStageLabel = '跌势放缓';
        techStageColor = '#ff9800';
      } else if (h1 > 0 && h24 < 0) {
        techStage = 'reversing_up';
        techStageLabel = '可能见底';
        techStageColor = '#00e676';
      }
    }

    // === 综合阶段: 持久化阶段 + 技术面阶段 + 涨幅幅度 ===
    let combinedStage = lifecycle.stage;
    let combinedStageLabel = lifecycle.stageLabel;
    let combinedStageColor = lifecycle.stageColor;

    // 优先级: 涨幅幅度 > 技术面加速/衰减 > 持久化年龄
    // 1. 如果涨幅幅度显示耗竭 → 直接标记为耗竭 (最高优先级)
    if (magnitudeStage === 'exhaustion') {
      combinedStage = 'exhaustion';
      combinedStageLabel = isBullish ? '可能耗竭' : '可能见底';
      combinedStageColor = isBullish ? '#ff5252' : '#00e676';
    }
    // 2. 如果涨幅幅度显示扩展 → 标记为扩展 (除非技术面显示仍在加速)
    else if (magnitudeStage === 'extended') {
      if (techStage === 'accelerating') {
        combinedStage = 'extended';
        combinedStageLabel = '行情扩展(加速中)';
        combinedStageColor = '#ff9800';
      } else if (techStage === 'reversing') {
        combinedStage = 'reversing';
        combinedStageLabel = '可能反转';
        combinedStageColor = '#ff5252';
      } else {
        combinedStage = 'extended';
        combinedStageLabel = '行情扩展';
        combinedStageColor = '#ff9800';
      }
    }
    // 3. 如果涨幅幅度显示发展中的行情 + 持久化显示 emerging → 不应标记为"初始"
    else if (magnitudeStage === 'developed' && lifecycle.stage === 'emerging') {
      if (techStage === 'accelerating') {
        combinedStage = 'active';
        combinedStageLabel = '行情发展中';
        combinedStageColor = '#76ff03';
      } else if (techStage === 'decelerating' || techStage === 'fading') {
        combinedStage = 'fading';
        combinedStageLabel = '动能衰减';
        combinedStageColor = '#ff9800';
      } else {
        combinedStage = 'active';
        combinedStageLabel = '行情发展中';
        combinedStageColor = '#76ff03';
      }
    }
    // 4. 原有逻辑: 技术面覆盖持久化
    else {
      if (techStage === 'accelerating' && lifecycle.stage === 'fading') {
        combinedStage = 'reaccelerating';
        combinedStageLabel = '二次加速';
        combinedStageColor = '#00e676';
      } else if (techStage === 'reversing' && lifecycle.stage !== 'emerging') {
        combinedStage = 'reversing';
        combinedStageLabel = '可能反转';
        combinedStageColor = '#ff5252';
      } else if (techStage === 'fading' && lifecycle.stage === 'active') {
        combinedStage = 'fading';
        combinedStageLabel = '动能衰减';
        combinedStageColor = '#ff9800';
      } else if (techStage === 'accelerating' && lifecycle.stage === 'emerging') {
        // 只有在涨幅幅度正常时才保留"初始加速"标签
        if (!magnitudeStage) {
          combinedStage = 'emerging';
          combinedStageLabel = '初始加速';
          combinedStageColor = '#00e676';
        }
      }
    }

    // 计算 accelerationRatio 用于返回
    const expectedHourlyRate = h24 !== 0 ? h24 / 24 : 0;
    const accelerationRatio = expectedHourlyRate !== 0 ? Math.round((h1 / expectedHourlyRate) * 100) / 100 : null;

    return {
      ...sig,
      lifecycle: {
        ...lifecycle,
        techStage,
        techStageLabel,
        techStageColor,
        magnitudeStage,
        magnitudeLabel,
        magnitudeColor,
        magnitudeScore,
        vsGains,
        vsBeginPrice,
        combinedStage,
        combinedStageLabel,
        combinedStageColor,
        accelerationRatio,
      },
    };
  });
}

/**
 * 获取历史统计摘要
 */
function getHistoryStats(history) {
  if (!history || !history.signals) history = emptyHistory();
  const now = Date.now();
  const active = Object.values(history.signals).filter(s => (now - s.lastSeenAt) < EXPIRE_HOURS * 3600000);

  // 按阶段统计
  const stageStats = {
    emerging: 0,
    accelerating: 0,
    active: 0,
    peaking: 0,
    fading: 0,
    mature: 0,
    extended: 0,
    exhaustion: 0,
  };

  for (const s of active) {
    const lc = getLifecycle(s.symbol, s.lastScore, history);
    if (stageStats[lc.stage] !== undefined) stageStats[lc.stage]++;
  }

  return {
    totalTracked: active.length,
    scanCount: history.scanCount || 0,
    lastUpdated: history.lastUpdated,
    stageStats,
    newestSignals: active
      .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
      .slice(0, 5)
      .map(s => ({
        symbol: s.symbol,
        firstSeenAt: new Date(s.firstSeenAt).toISOString(),
        ageMinutes: Math.floor((now - s.firstSeenAt) / 60000),
        firstScore: s.firstScore,
        lastScore: s.lastScore,
      })),
  };
}

export {
  emptyHistory,
  trackSignals,
  getLifecycle,
  enrichWithLifecycle,
  getHistoryStats,
  EXPIRE_HOURS,
  SIGNAL_THRESHOLD,
  BEARISH_THRESHOLD,
};
