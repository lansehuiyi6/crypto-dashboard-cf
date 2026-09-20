const SIGNAL_TYPE_RANGES = {
  strongBuy: { min: 75, max: 100 },
  buy: { min: 62, max: 74 },
  watch: { min: 55, max: 61 },
  neutral: { min: 45, max: 54 },
  caution: { min: 35, max: 44 },
  riskAlert: { min: 0, max: 34 },
};

export function applyFilter(allSignals, filter, minScore, stageFilter, sigType) {
  let filtered = [...allSignals];
  if (filter === 'bullish') {
    filtered = filtered.filter(s => s.scores.composite >= 55);
  } else if (filter === 'bearish') {
    filtered = filtered.filter(s => s.scores.composite <= 45);
    filtered.sort((a, b) => a.scores.composite - b.scores.composite);
  } else if (filter === 'fomo') {
    filtered = filtered.filter(s => s.fomo?.fomo);
  } else if (filter === 'fundMovement') {
    filtered = filtered.filter(s => s.fundMovement?.type && s.fundMovement.type !== 'none');
  } else if (filter === 'fundInflow') {
    filtered = filtered.filter(s => s.fundMovement?.type === 'bullish');
  } else if (filter === 'fundOutflow') {
    filtered = filtered.filter(s => s.fundMovement?.type === 'bearish');
  } else if (filter === 'reversal') {
    filtered = filtered.filter(s => s.reversal != null);
    filtered.sort((a, b) => (b.reversal?.strength || 0) - (a.reversal?.strength || 0));
  } else if (filter === 'bottomReversal') {
    filtered = filtered.filter(s => s.bottomReversal != null);
    filtered.sort((a, b) => (b.bottomReversal?.strength || 0) - (a.bottomReversal?.strength || 0));
  }
  if (minScore > 0) filtered = filtered.filter(s => s.scores.composite >= minScore);

  if (sigType && SIGNAL_TYPE_RANGES[sigType]) {
    const range = SIGNAL_TYPE_RANGES[sigType];
    filtered = filtered.filter(s => s.scores.composite >= range.min && s.scores.composite <= range.max);
  }

  if (stageFilter) {
    filtered = filtered.filter((s) => matchesStage(s.lifecycle, stageFilter));
  }

  return filtered.slice(0, 50);
}

export function matchesStage(lc, stageFilter) {
  if (!lc || !stageFilter) return false;
  if (stageFilter === 'initial') {
    return lc.combinedStage === 'emerging' || lc.stage === 'emerging';
  }
  if (stageFilter === 'active') {
    return lc.combinedStage === 'active' || lc.stage === 'active';
  }
  if (stageFilter === 'emerging') {
    return lc.combinedStage === 'emerging' || lc.combinedStage === 'reaccelerating'
      || lc.techStage === 'accelerating';
  }
  if (stageFilter === 'fading') {
    return lc.combinedStage === 'fading' || lc.combinedStage === 'mature'
      || lc.techStage === 'fading' || lc.techStage === 'decelerating';
  }
  if (stageFilter === 'reversing') {
    return lc.combinedStage === 'reversing'
      || lc.techStage === 'reversing' || lc.techStage === 'reversing_up';
  }
  if (stageFilter === 'extended') {
    return lc.combinedStage === 'extended' || lc.magnitudeStage === 'extended';
  }
  if (stageFilter === 'exhaustion') {
    return lc.combinedStage === 'exhaustion' || lc.magnitudeStage === 'exhaustion';
  }
  return lc.combinedStage === stageFilter;
}

export function summarizeSignals(signals) {
  const list = Array.isArray(signals) ? signals : [];
  return {
    totalScanned: list.length,
    totalSignals: list.length,
    strongBuy: list.filter((s) => s.scores?.composite >= 75).length,
    buy: list.filter((s) => s.scores?.composite >= 62 && s.scores?.composite < 75).length,
    watch: list.filter((s) => s.scores?.composite >= 55 && s.scores?.composite < 62).length,
    neutral: list.filter((s) => s.scores?.composite >= 45 && s.scores?.composite < 55).length,
    caution: list.filter((s) => s.scores?.composite >= 35 && s.scores?.composite < 45).length,
    riskAlert: list.filter((s) => (s.scores?.composite ?? 0) < 35).length,
    fomoCount: list.filter((s) => s.fomo?.fomo).length,
    fundMovementBullish: list.filter((s) => s.fundMovement?.type === 'bullish').length,
    fundMovementBearish: list.filter((s) => s.fundMovement?.type === 'bearish').length,
    reversalCount: list.filter((s) => s.reversal).length,
    bottomReversalCount: list.filter((s) => s.bottomReversal).length,
    generatedAt: new Date().toISOString(),
  };
}

export function stageStatsFromSignals(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const count = (key) => list.filter((s) => matchesStage(s.lifecycle, key)).length;
  const stats = {
    emerging: 0, accelerating: 0, active: 0, peaking: 0,
    fading: 0, mature: 0, extended: 0, exhaustion: 0,
  };
  for (const s of list) {
    const st = s.lifecycle?.combinedStage;
    if (st && stats[st] !== undefined) stats[st] += 1;
  }
  // 摘要可点数字与 Tab 筛选同口径（衰减含 mature 等）
  stats.emerging = count('initial');
  stats.active = count('active');
  stats.fading = count('fading');
  stats.extended = count('extended');
  stats.exhaustion = count('exhaustion');
  return stats;
}

export { SIGNAL_TYPE_RANGES };
