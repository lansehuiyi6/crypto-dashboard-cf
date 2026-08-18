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
    filtered = filtered.filter(s => s.fomo.fomo);
  } else if (filter === 'fundMovement') {
    filtered = filtered.filter(s => s.fundMovement.type !== 'none');
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
    filtered = filtered.filter(s => {
      const lc = s.lifecycle;
      if (!lc) return false;
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
    });
  }

  return filtered.slice(0, 50);
}

export { SIGNAL_TYPE_RANGES };
