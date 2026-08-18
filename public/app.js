'use strict';

const COINGECKO_IDS = {
  bitcoin:     { el: 'btc',  name: 'BTC' },
  ethereum:    { el: 'eth',  name: 'ETH' },
  binancecoin: { el: 'bnb',  name: 'BNB' },
  solana:      { el: 'sol',  name: 'SOL' },
  ripple:      { el: 'xrp',  name: 'XRP' },
  dogecoin:    { el: 'doge', name: 'DOGE' },
};

function fmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(8);
}

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '-';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function setPriceNote(text) {
  const bar = document.getElementById('priceBar');
  if (!bar) return;
  let note = document.getElementById('priceNote');
  if (!text) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.id = 'priceNote';
    note.style.cssText = 'grid-column:1/-1;text-align:center;color:var(--text-secondary);font-size:13px;padding:8px;';
    bar.appendChild(note);
  }
  note.textContent = text;
}

async function fetchCoinGeckoPrices() {
  try {
    const ids = Object.keys(COINGECKO_IDS).join(',');
    const url = `/api/coingecko/prices?ids=${ids}`;
    const data = await fetchJSON(url);
    if (data.status?.error_code || data.error || !data.bitcoin) {
      throw new Error(data.status?.error_message || data.error || '价格数据为空');
    }
    for (const [id, info] of Object.entries(COINGECKO_IDS)) {
      const item = data[id];
      if (!item) continue;
      const priceEl = document.getElementById(info.el + 'Price');
      const changeEl = document.getElementById(info.el + 'Change');
      if (priceEl) priceEl.textContent = fmtPrice(item.usd);
      if (changeEl) {
        const ch = item.usd_24h_change || 0;
        changeEl.textContent = fmtPct(ch);
        changeEl.className = 'coin-change ' + (ch >= 0 ? 'up' : 'down');
      }
    }
    setPriceNote('');
  } catch (e) {
    console.warn('CoinGecko fetch failed:', e.message);
    setPriceNote('实时价格暂不可用（CoinGecko 限流），稍后会自动重试');
  }
}

async function fetchGoldPrice() {
  try {
    const data = await fetchJSON('/api/gold/spot');
    const priceEl = document.getElementById('xauPrice');
    const changeEl = document.getElementById('xauChange');

    if (priceEl && data.spot_usd_oz) {
      priceEl.textContent = '$' + Number(data.spot_usd_oz).toLocaleString('en-US', { maximumFractionDigits: 1 });
    }
    // Calculate 24h change from open (xaus doesn't provide change directly, use prev close approximation)
    if (changeEl) {
      changeEl.textContent = '黄金现货';
      changeEl.className = 'coin-change up';
    }

    // Render gold detail bar
    const bar = document.getElementById('goldBar');
    if (bar && data.spot_usd_oz) {
      const items = [
        { label: 'XAU/USD', value: '$' + Number(data.spot_usd_oz).toLocaleString('en-US', { maximumFractionDigits: 1 }) },
        { label: 'Silver', value: '$' + Number(data.silver_usd_oz).toFixed(2) },
        { label: 'Gold/Silver', value: Number(data.gold_silver_ratio).toFixed(2) },
        { label: 'BTC/Gold', value: Number(data.btc_gold_oz).toFixed(2) + ' oz' },
        { label: 'PAXG', value: '$' + Number(data.paxg_usd).toLocaleString('en-US', { maximumFractionDigits: 1 }) },
        { label: 'BTC mcap/Gold mcap', value: Number(data.btc_vs_gold_mcap_pct).toFixed(2) + '%' },
      ];
      bar.innerHTML = items.map(i => `<div class="gold-stat"><span class="gold-stat-label">${i.label}</span><span class="gold-stat-value">${i.value}</span></div>`).join('');
    }
  } catch (e) {
    console.warn('Gold price fetch failed:', e.message);
  }
}

async function fetchValuescan(type) {
  try {
    const data = await fetchJSON(`/api/valuescan/${type}`);
    if (data.code !== 200 || !data.data) return [];
    return data.data.list || [];
  } catch (e) {
    console.warn(`ValueScan ${type} fetch failed:`, e.message);
    return null;
  }
}

function renderLongShortItem(item, isLong) {
  const ranking = item.percentChangeRanking || {};
  const ch24 = ranking.percentChange24h && Number(ranking.percentChange24h.change);
  const ch7d = ranking.percentChange7d && Number(ranking.percentChange7d.change);
  const ch1h = ranking.percentChange1h && Number(ranking.percentChange1h.change);

  const badges = [];
  if (item.score !== undefined && item.score !== '') {
    badges.push(`<span class="badge badge-score">评分 ${item.score}</span>`);
  }
  if (item.fomo) badges.push(`<span class="badge badge-fomo">FOMO</span>`);
  if (item.observe) badges.push(`<span class="badge badge-observe">观察</span>`);
  if (item.bullishRatio !== undefined && item.bullishRatio !== null) {
    const bull = (Number(item.bullishRatio) * 100).toFixed(0);
    const bear = (Number(item.bearishRatio || 0) * 100).toFixed(0);
    if (Number(item.bullishRatio) > 0) {
      badges.push(`<span class="badge badge-bull">看涨 ${bull}%</span>`);
    }
    if (Number(item.bearishRatio || 0) > 0) {
      badges.push(`<span class="badge badge-bear">看跌 ${bear}%</span>`);
    }
  }

  const changeClass = ch24 >= 0 ? 'up' : 'down';
  const changeText = fmtPct(ch24);

  const subInfo = [];
  if (item.marketCapRanking) subInfo.push(`市值排名 #${item.marketCapRanking}`);
  if (ch1h !== undefined && Number.isFinite(ch1h)) subInfo.push(`1h ${fmtPct(ch1h)}`);
  if (ch7d !== undefined && Number.isFinite(ch7d)) subInfo.push(`7d ${fmtPct(ch7d)}`);
  if (item.gains) subInfo.push(`涨幅 ${fmtPct(item.gains)}`);
  if (item.decline) subInfo.push(`回撤 ${fmtPct(item.decline)}`);

  const latestMsg = item.latestMessage;
  if (latestMsg && latestMsg.predictType) {
    const predictions = { 16: '趋势看涨', 17: '趋势看跌', 1: '短线看涨', 2: '短线看跌' };
    const pred = predictions[latestMsg.predictType];
    if (pred) subInfo.push(pred);
  }

  const href = `https://www.valuescan.io/token?keyword=${item.keyword}`;

  return `
    <a href="${href}" target="_blank" class="token-item">
      <img class="token-icon" src="${item.icon || ''}" alt="" onerror="this.style.display='none'">
      <div class="token-info">
        <div class="token-symbol">${item.symbol || '?'}</div>
        <div class="token-price">${fmtPrice(item.price)} ${subInfo.length ? '· ' + subInfo.join(' · ') : ''}</div>
      </div>
      <div class="token-meta">
        <div class="token-change ${changeClass}">${changeText}</div>
        <div class="token-badges">${badges.join('')}</div>
      </div>
    </a>`;
}

function renderAlertItem(item) {
  const ch24 = Number(item.percentChange24h);
  const badges = [];
  if (item.alpha) badges.push(`<span class="badge badge-alpha">Alpha</span>`);
  if (item.fomo) badges.push(`<span class="badge badge-fomo">FOMO</span>`);
  if (item.fomoEscalation) badges.push(`<span class="badge badge-fomo">FOMO升级</span>`);
  if (item.observe) badges.push(`<span class="badge badge-observe">观察</span>`);
  if (item.bullishRatio !== undefined && item.bullishRatio !== null) {
    const bull = (Number(item.bullishRatio) * 100).toFixed(0);
    badges.push(`<span class="badge badge-bull">看涨 ${bull}%</span>`);
  }

  const changeClass = ch24 >= 0 ? 'up' : 'down';

  const subInfo = [];
  if (item.number24h !== undefined && item.number24h !== null) {
    subInfo.push(`24h异动 ${item.number24h}次`);
  }
  if (item.numberNot24h !== undefined && item.numberNot24h !== null) {
    subInfo.push(`非24h ${item.numberNot24h}次`);
  }
  subInfo.push(`市值 ${fmtUsd(item.marketCap)}`);

  const latest = item.latestMessage;
  if (latest && latest.extField) {
    const ext = latest.extField;
    if (ext.fiveTradeAmountChange) {
      subInfo.push(`5min额变 ${fmtUsd(ext.fiveTradeAmountChange)}`);
    }
    if (ext.tradeAmount24H) {
      subInfo.push(`24h额 ${fmtUsd(ext.tradeAmount24H)}`);
    }
  }

  const gainsText = item.gains ? `自 ${fmtPrice(item.beginPrice)} 涨 ${fmtPct(item.gains)}` : '';

  const href = `https://www.valuescan.io/token?keyword=${item.keyword}`;

  return `
    <a href="${href}" target="_blank" class="token-item">
      <img class="token-icon" src="${item.icon || ''}" alt="" onerror="this.style.display='none'">
      <div class="token-info">
        <div class="token-symbol">${item.symbol || '?'}</div>
        <div class="token-price">${fmtPrice(item.price)} ${gainsText ? '· ' + gainsText : ''}</div>
        <div class="token-price" style="margin-top:2px;">${subInfo.join(' · ')}</div>
      </div>
      <div class="token-meta">
        <div class="token-change ${changeClass}">${fmtPct(ch24)}</div>
        <div class="token-badges">${badges.join('')}</div>
      </div>
    </a>`;
}

function renderTokenList(containerId, items, type) {
  const container = document.getElementById(containerId);
  if (items === null) {
    container.innerHTML = '<div class="empty">获取失败,请稍后刷新</div>';
    return;
  }
  if (!items.length) {
    container.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }
  const renderer = type === 'alert' ? renderAlertItem : (item) => renderLongShortItem(item, type === 'long');
  container.innerHTML = items.map(renderer).join('');
}

async function loadValuescanData() {
  const [longItems, shortItems, alertItems] = await Promise.all([
    fetchValuescan('long'),
    fetchValuescan('short'),
    fetchValuescan('alert'),
  ]);

  renderTokenList('longList', longItems, 'long');
  renderTokenList('shortList', shortItems, 'short');
  renderTokenList('alertList', alertItems, 'alert');

  document.getElementById('longCount').textContent = longItems ? longItems.length : '--';
  document.getElementById('shortCount').textContent = shortItems ? shortItems.length : '--';
  document.getElementById('alertCount').textContent = alertItems ? alertItems.length : '--';
}

async function loadMarketSignals() {
  try {
    const data = await fetchJSON('/api/market-signals');

    const ov = data.overview;
    document.getElementById('marketStats').innerHTML = `
      <span class="stat">总市值 ${ov.totalMcap}</span>
      <span class="stat">BTC Dominance ${ov.btcDominance}</span>
      <span class="stat">恐惧贪婪指数 ${ov.fearGreed}</span>
    `;

    const sigColors = { amber: 'sig-amber', blue: 'sig-blue', gray: 'sig-gray' };
    document.getElementById('signalList').innerHTML = data.tradingSignals.map(s => `
      <div class="signal-card ${sigColors[s.color] || ''}">
        <div class="signal-coin">${s.coin} <span style="font-size:12px;font-weight:400;color:var(--text-secondary);">· ${s.bias}</span></div>
        <div class="signal-levels"><span class="level-label">支撑:</span> ${s.support}</div>
        <div class="signal-levels"><span class="level-label">阻力:</span> ${s.resistance}</div>
        <div class="signal-strategy">${s.strategy}</div>
      </div>
    `).join('');

    document.getElementById('unlockBody').innerHTML = data.tokenUnlocks.map(u => `
      <tr>
        <td>${u.token}</td>
        <td>${u.date}</td>
        <td>${u.amount}</td>
        <td>${u.pct}</td>
        <td><span class="risk-tag risk-${u.risk}">${u.risk === 'extreme' ? '极高' : u.risk === 'high' ? '高' : u.risk === 'medium' ? '中' : '低'}</span></td>
      </tr>
    `).join('');

    document.getElementById('trendingBody').innerHTML = data.trendingTokens.map(t => `
      <tr>
        <td>${t.token}</td>
        <td style="color:${t.change.startsWith('+') ? 'var(--up)' : 'var(--text-secondary)'};font-weight:600;">${t.change}</td>
        <td><span class="tag-label tag-${t.tag === 'DeFi' ? 'defi' : t.tag === 'AI' ? 'ai' : t.tag === 'meme' ? 'meme' : 'other'}">${t.tag}</span></td>
        <td style="font-size:12px;color:var(--text-secondary);">${t.note}</td>
      </tr>
    `).join('');

    document.getElementById('listingBody').innerHTML = data.newListings.map(l => `
      <tr>
        <td>${l.token}</td>
        <td>${l.exchange}</td>
        <td><span class="risk-tag risk-low">${l.status}</span></td>
      </tr>
    `).join('');

    document.getElementById('narrativeList').innerHTML = data.narratives.map(n => `
      <div class="narrative-item">
        <div class="narrative-name">${n.name}</div>
        <div class="narrative-tokens">${n.tokens}</div>
        <div class="narrative-desc">${n.desc}</div>
      </div>
    `).join('');

    document.getElementById('eventList').innerHTML = data.keyEvents.map(e => `
      <div class="event-item">
        <span class="event-name">${e.event}</span>
        <span class="event-time">${e.time}</span>
        <span class="event-impact">${e.impact}</span>
      </div>
    `).join('');

  } catch (e) {
    console.warn('Market signals fetch failed:', e.message);
  }
}

// ============================================================
//  自有信号引擎
// ============================================================

let currentSignalFilter = 'all';
let currentStageFilter = '';
let currentSignalType = ''; // 强烈买入/建议买入/值得关注等点击筛选
let lastSignalData = null;

// 信号类型 -> 评分范围映射
const SIGNAL_TYPE_RANGES = {
  strongBuy: { min: 75, max: 100 },
  buy:       { min: 62, max: 74 },
  watch:     { min: 55, max: 61 },
  neutral:   { min: 45, max: 54 },
  caution:   { min: 35, max: 44 },
  riskAlert: { min: 0,  max: 34 },
};

// 折叠按钮
document.getElementById('collapseBtn').addEventListener('click', () => {
  const section = document.getElementById('signalEngineSection');
  section.classList.toggle('collapsed');
});

function scheduleRetry(fn, key) {
  if (scheduleRetry._pending?.[key]) return;
  scheduleRetry._pending = scheduleRetry._pending || {};
  scheduleRetry._pending[key] = setTimeout(() => {
    scheduleRetry._pending[key] = null;
    fn();
  }, 4000);
}

async function loadOwnSignals(filter, stage) {
  if (filter) currentSignalFilter = filter;
  if (stage !== undefined) currentStageFilter = stage;
  const summaryEl = document.getElementById('signalSummary');
  const cardsEl = document.getElementById('signalCards');

  if (!lastSignalData) {
    summaryEl.innerHTML = '<div class="loading">等待定时扫描结果... (GitHub Actions 约每 15 分钟更新)</div>';
    cardsEl.innerHTML = '';
  }

  try {
    let url = `/api/signals?filter=${currentSignalFilter}`;
    if (currentStageFilter) url += `&stage=${currentStageFilter}`;
    if (currentSignalType) url += `&signalType=${currentSignalType}`;
    const data = await fetchJSON(url);

    if (data.scanning && !data.summary) {
      const label = data.progress?.label || '等待定时扫描结果';
      summaryEl.innerHTML = `<div class="loading">${label}</div>`;
      cardsEl.innerHTML = '';
      scheduleRetry(() => loadOwnSignals(), 'own');
      return;
    }

    lastSignalData = data;
    if (data.scanning) scheduleRetry(() => loadOwnSignals(), 'own');

    if (data.error) {
      summaryEl.innerHTML = `<div class="empty">信号引擎错误: ${data.error}</div>`;
      return;
    }

    if (!data.summary) {
      summaryEl.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }

    // 渲染统计摘要
    const s = data.summary;
    const cacheTag = data.cached ? '<span class="cache-tag">缓存</span>' : '<span class="cache-tag live">实时</span>';

    // 可点击的统计项 (data-type 属性用于筛选)
    function clickableStat(num, label, typeKey, color) {
      const active = currentSignalType === typeKey ? 'active' : '';
      return `<div class="signal-stat-item clickable ${active}" data-type="${typeKey}" title="点击筛选${label}">
        <span class="signal-stat-num" style="color:${color};">${num}</span>
        <span class="signal-stat-label">${label}</span>
      </div>`;
    }

    // 生命周期统计
    let lifecycleStats = '';
    if (data.historyStats) {
      const hs = data.historyStats;
      const ss = hs.stageStats || {};
      lifecycleStats = `
        <div class="signal-stat-divider"></div>
        <div class="signal-stat-item">
          <span class="signal-stat-num" style="color:#00e676;">${hs.totalTracked}</span>
          <span class="signal-stat-label">追踪中</span>
        </div>
        <div class="signal-stat-item">
          <span class="signal-stat-num" style="color:#00e676;">${ss.emerging || 0}</span>
          <span class="signal-stat-label">初始阶段</span>
        </div>
        <div class="signal-stat-item">
          <span class="signal-stat-num" style="color:#76ff03;">${ss.active || 0}</span>
          <span class="signal-stat-label">活跃阶段</span>
        </div>
        <div class="signal-stat-item">
          <span class="signal-stat-num" style="color:#ff9800;">${ss.fading || 0}</span>
          <span class="signal-stat-label">衰减中</span>
        </div>
        <div class="signal-stat-item">
          <span class="signal-stat-num" style="color:#ff5252;">${ss.extended || 0}</span>
          <span class="signal-stat-label">行情扩展</span>
        </div>
        <div class="signal-stat-item">
          <span class="signal-stat-num" style="color:#d500f9;">${hs.scanCount}</span>
          <span class="signal-stat-label">扫描次数</span>
        </div>
      `;
    }

    summaryEl.innerHTML = `
      ${clickableStat(s.strongBuy, '强烈买入', 'strongBuy', '#00e676')}
      ${clickableStat(s.buy, '建议买入', 'buy', '#76ff03')}
      ${clickableStat(s.watch, '值得关注', 'watch', '#ffd54f')}
      ${clickableStat(s.neutral, '中性', 'neutral', '#b0bec5')}
      ${clickableStat(s.caution, '谨慎', 'caution', '#ff9800')}
      ${clickableStat(s.riskAlert, '风险预警', 'riskAlert', '#ff5252')}
      <div class="signal-stat-divider"></div>
      <div class="signal-stat-item">
        <span class="signal-stat-num" style="color:#e040fb;">${s.fomoCount}</span>
        <span class="signal-stat-label">FOMO</span>
      </div>
      <div class="signal-stat-item">
        <span class="signal-stat-num" style="color:#00e676;">${s.fundMovementBullish}</span>
        <span class="signal-stat-label">资金流入</span>
      </div>
      <div class="signal-stat-item">
        <span class="signal-stat-num" style="color:#ff5252;">${s.fundMovementBearish}</span>
        <span class="signal-stat-label">资金流出</span>
      </div>
      ${lifecycleStats}
      <div class="signal-stat-divider"></div>
      <div class="signal-stat-item">
        <span class="signal-stat-num">${s.totalScanned}</span>
        <span class="signal-stat-label">扫描总数</span>
      </div>
      <div class="signal-stat-item">
        <span class="signal-stat-num">${data.signals.length}</span>
        <span class="signal-stat-label">当前显示</span>
      </div>
      ${cacheTag}
    `;

    // 绑定可点击统计项事件
    summaryEl.querySelectorAll('.signal-stat-item.clickable').forEach(el => {
      el.addEventListener('click', () => {
        const typeKey = el.dataset.type;
        if (currentSignalType === typeKey) {
          // 再次点击取消筛选
          currentSignalType = '';
        } else {
          currentSignalType = typeKey;
        }
        // 更新 active 状态
        summaryEl.querySelectorAll('.signal-stat-item.clickable').forEach(e => e.classList.remove('active'));
        if (currentSignalType) {
          const activeEl = summaryEl.querySelector(`[data-type="${currentSignalType}"]`);
          if (activeEl) activeEl.classList.add('active');
        }
        loadOwnSignals();
      });
    });

    // 渲染信号卡片
    if (!data.signals.length) {
      cardsEl.innerHTML = '<div class="empty">该筛选条件下暂无信号</div>';
      return;
    }

    cardsEl.innerHTML = data.signals.map(sig => renderSignalCard(sig)).join('');
  } catch (e) {
    console.warn('Signal engine fetch failed:', e.message);
    summaryEl.innerHTML = `<div class="empty">信号引擎加载失败: ${e.message}</div>`;
  }
}

function renderSignalCard(sig) {
  const sc = sig.scores;
  const signal = sig.signal;
  const ch = sig.changes;
  const fm = sig.fundMovement;
  const fomo = sig.fomo;
  const bb = sig.bullBearRatio;
  const lc = sig.lifecycle;

  // 评分条颜色
  const scoreColor = signal.color;

  // 子评分条
  function scoreBar(label, value) {
    const w = Math.max(0, Math.min(100, value));
    const c = w >= 65 ? '#00e676' : w >= 50 ? '#ffd54f' : '#ff5252';
    return `
      <div class="sub-score">
        <span class="sub-score-label">${label}</span>
        <div class="sub-score-bar"><div class="sub-score-fill" style="width:${w}%;background:${c};"></div></div>
        <span class="sub-score-val">${value}</span>
      </div>`;
  }

  // 涨跌幅标签
  function changeTag(label, val) {
    if (val == null) return '';
    const cls = val >= 0 ? 'up' : 'down';
    return `<span class="tf-change ${cls}">${label} ${fmtPct(val)}</span>`;
  }

  // FOMO 标签
  let fomoBadge = '';
  if (fomo.fomo) {
    const levelText = fomo.level === 'extreme' ? 'FOMO 极端' : fomo.level === 'high' ? 'FOMO 高' : 'FOMO';
    const levelColor = fomo.level === 'extreme' ? '#ff1744' : fomo.level === 'high' ? '#ff5722' : '#ff9800';
    fomoBadge = `<span class="signal-badge" style="background:${levelColor};color:#fff;">${levelText}</span>`;
  }

  // 资金异动标签
  let fmBadge = '';
  if (fm.type !== 'none') {
    const fmText = fm.type === 'bullish' ? '资金流入' : '资金流出';
    const fmColor = fm.type === 'bullish' ? '#00c853' : '#d50000';
    const volInfo = fm.ratio > 0 ? ` (${fm.ratio}x均量)` : '';
    fmBadge = `<span class="signal-badge" style="background:${fmColor};color:#fff;">${fmText}${volInfo}</span>`;
  }

  // 生命周期信息
  let lifecycleBar = '';
  if (lc) {
    const stageBadge = `<span class="lc-stage" style="background:${lc.combinedStageColor || lc.stageColor};color:#fff;">${lc.combinedStageLabel || lc.stageLabel}</span>`;
    const ageBadge = `<span class="lc-age" title="信号首次出现时间">⏱ ${lc.ageLabel}</span>`;
    
    let trendBadge = '';
    if (lc.scoreTrend === 'rising') trendBadge = `<span class="lc-trend lc-trend-up">↑ 评分上升 ${lc.scoreChange > 0 ? '+' + lc.scoreChange : ''}</span>`;
    else if (lc.scoreTrend === 'falling') trendBadge = `<span class="lc-trend lc-trend-down">↓ 评分下降 ${lc.scoreChange}</span>`;
    else if (lc.scoreTrend === 'new') trendBadge = `<span class="lc-trend lc-trend-new">🆕 首次发现</span>`;
    else trendBadge = `<span class="lc-trend lc-trend-stable">→ 评分稳定</span>`;

    let techBadge = '';
    if (lc.techStageLabel) {
      techBadge = `<span class="lc-tech" style="color:${lc.techStageColor};">${lc.techStageLabel}</span>`;
    }

    // 涨幅幅度标签 (新增)
    let magnitudeBadge = '';
    if (lc.magnitudeLabel) {
      magnitudeBadge = `<span class="lc-magnitude" style="color:${lc.magnitudeColor};border:1px solid ${lc.magnitudeColor}33;">${lc.magnitudeLabel}</span>`;
    }

    // ValueScan 交叉引用标签 (新增)
    let vsBadge = '';
    if (lc.vsGains != null) {
      const vsPct = lc.vsGains > 0 ? '+' : '';
      vsBadge = `<span class="lc-vs" title="ValueScan 信号以来涨幅">VS ${vsPct}${lc.vsGains.toFixed(1)}%</span>`;
    }

    let priceSinceBadge = '';
    if (lc.hasHistory && lc.priceChangeSinceStart !== 0) {
      const pcls = lc.priceChangeSinceStart > 0 ? 'up' : 'down';
      priceSinceBadge = `<span class="lc-price-since ${pcls}">信号以来 ${fmtPct(lc.priceChangeSinceStart)}</span>`;
    }

    let peakBadge = '';
    if (lc.hasHistory && lc.scoreFromPeak < -3) {
      peakBadge = `<span class="lc-peak">距峰值 ${lc.scoreFromPeak}</span>`;
    }

    lifecycleBar = `<div class="signal-card-lifecycle">${stageBadge}${ageBadge}${trendBadge}${techBadge}${magnitudeBadge}${vsBadge}${priceSinceBadge}${peakBadge}</div>`;
  }

  // 看涨/看跌比率条
  const bullPct = Math.round(bb.bullish * 100);
  const bearPct = Math.round(bb.bearish * 100);

  const href = `https://www.coingecko.com/en/coins/${sig.id}`;

  return `
    <a href="${href}" target="_blank" class="signal-card-item" style="border-left-color:${scoreColor};">
      <div class="signal-card-top">
        <div class="signal-card-id">
          ${sig.image ? `<img class="signal-token-icon" src="${sig.image}" alt="" onerror="this.style.display='none'">` : ''}
          <div>
            <div class="signal-token-symbol">${sig.symbol || '?'}</div>
            <div class="signal-token-name">${sig.name || ''}</div>
          </div>
        </div>
        <div class="signal-card-price">
          <div class="signal-price-val">${fmtPrice(sig.price)}</div>
          <div class="signal-mcap-rank">#${sig.marketCapRank || '-'} · ${fmtUsd(sig.marketCap)}</div>
        </div>
      </div>

      ${lifecycleBar}

      <div class="signal-card-score">
        <div class="score-main">
          <div class="score-circle" style="border-color:${scoreColor};">
            <span class="score-num" style="color:${scoreColor};">${sc.composite}</span>
          </div>
          <div class="score-label">
            <span class="signal-label" style="color:${scoreColor};">${signal.icon} ${signal.labelCn}</span>
            <span class="signal-desc">${signal.desc}</span>
          </div>
        </div>
        <div class="score-subs">
          ${scoreBar('动量', sc.momentum)}
          ${scoreBar('趋势一致性', sc.consistency)}
          ${scoreBar('成交量', sc.volume)}
          ${scoreBar('市值位置', sc.marketPosition)}
        </div>
      </div>

      <div class="signal-card-changes">
        ${changeTag('1h', ch.h1)}
        ${changeTag('24h', ch.h24)}
        ${changeTag('7d', ch.d7)}
        ${changeTag('30d', ch.d30)}
      </div>

      <div class="signal-card-bottom">
        <div class="signal-bb-ratio">
          <span class="bb-label">多空比</span>
          <div class="bb-bar">
            <div class="bb-bull" style="width:${bullPct}%;"></div>
            <div class="bb-bear" style="width:${bearPct}%;"></div>
          </div>
          <span class="bb-text">多 ${bullPct}% / 空 ${bearPct}%</span>
        </div>
        <div class="signal-badges">${fomoBadge}${fmBadge}</div>
        <div class="signal-vol-info">24h量 ${fmtUsd(sig.volume24h)}</div>
      </div>
    </a>`;
}

// Tab 切换
document.getElementById('signalTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const filter = btn.dataset.filter || 'all';
  const stage = btn.dataset.stage || '';
  currentSignalType = ''; // 切换Tab时清除信号类型筛选
  loadOwnSignals(filter, stage);
});

function updateTimestamp() {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  document.getElementById('lastUpdate').textContent = '更新于 ' + now;
}

async function refreshAll() {
  updateTimestamp();
  await Promise.all([
    fetchCoinGeckoPrices(),
    fetchGoldPrice(),
    loadValuescanData(),
    loadMarketSignals(),
    loadOwnSignals(),
    loadReversalSignals(),
    loadBottomReversalSignals(),
  ]);
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  lastSignalData = null; // 强制刷新信号
  refreshAll();
});

refreshAll();
setInterval(fetchCoinGeckoPrices, 60000);
setInterval(fetchGoldPrice, 60000);
setInterval(loadValuescanData, 180000);
setInterval(() => loadOwnSignals(), 300000); // 信号引擎每5分钟刷新
setInterval(() => loadReversalSignals(), 300000); // 反转信号每5分钟刷新
setInterval(() => loadBottomReversalSignals(), 300000); // 跌势反转信号每5分钟刷新

// ============================================================
//  涨势反转信号
// ============================================================

let lastReversalData = null;

/**
 * 格式化数字为简短显示
 */
function fmtShort(n) {
  if (n == null || isNaN(n)) return '--';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

/**
 * 格式化百分比
 */
function fmtPct(v) {
  if (v == null || isNaN(v)) return '--';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

/**
 * 渲染单张反转卡片
 */
function renderReversalCard(sig) {
  const r = sig.reversal;
  if (!r) return '';

  const h1Class = sig.changes.h1 > 0 ? 'up' : (sig.changes.h1 < 0 ? 'down' : 'flat');
  const h24Class = sig.changes.h24 > 0 ? 'up' : (sig.changes.h24 < 0 ? 'down' : 'flat');
  const d7Class = sig.changes.d7 > 0 ? 'up' : (sig.changes.d7 < 0 ? 'down' : 'flat');

  // EMA 状态: 死叉后 EMA5 < EMA21, 但 EMA21 > EMA56
  const ema5Class = r.ema5 < r.ema21 ? 'reversal-ema-val-crossed' : 'reversal-ema-val-above';
  const ema21Class = r.ema21 > r.ema56 ? 'reversal-ema-val-above' : 'reversal-ema-val-crossed';

  return `
    <div class="reversal-card">
      <div class="reversal-card-head">
        <div>
          <div class="reversal-card-symbol">${sig.symbol}</div>
          <div class="reversal-card-name">${sig.name || ''}</div>
        </div>
        <div class="reversal-strength" title="反转强度 (0-100)">
          <span class="reversal-strength-num">${r.strength}</span>
          <span class="reversal-strength-label">强度</span>
        </div>
      </div>

      <div class="reversal-ema-row">
        <div class="reversal-ema-item">
          <div class="reversal-ema-name">EMA5</div>
          <div class="reversal-ema-val ${ema5Class}">$${fmtShort(r.ema5)}</div>
        </div>
        <div class="reversal-ema-item">
          <div class="reversal-ema-name">EMA21</div>
          <div class="reversal-ema-val ${ema21Class}">$${fmtShort(r.ema21)}</div>
        </div>
        <div class="reversal-ema-item">
          <div class="reversal-ema-name">EMA56</div>
          <div class="reversal-ema-val">$${fmtShort(r.ema56)}</div>
        </div>
      </div>

      <div class="reversal-row">
        <span class="reversal-label">死叉幅度</span>
        <span class="reversal-value reversal-value-down">${fmtPct(-r.crossGap)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">死叉发生</span>
        <span class="reversal-value">${r.crossedAgoHours === 0 ? '刚刚' : r.crossedAgoHours + 'h 前'}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">距峰值回落</span>
        <span class="reversal-value reversal-value-down">${fmtPct(-r.drawdownFromPeak)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">7日峰值</span>
        <span class="reversal-value">$${fmtShort(r.peakPrice)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">当前价</span>
        <span class="reversal-value">$${fmtShort(sig.price)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">市值</span>
        <span class="reversal-value">$${fmtShort(sig.marketCap)} (排名 ${sig.marketCapRank || '--'})</span>
      </div>

      <div class="reversal-footer">
        <span class="reversal-price-change ${h1Class}">1h ${fmtPct(sig.changes.h1)}</span>
        <span class="reversal-price-change ${h24Class}">24h ${fmtPct(sig.changes.h24)}</span>
        <span class="reversal-price-change ${d7Class}">7d ${fmtPct(sig.changes.d7)}</span>
      </div>
    </div>
  `;
}

/**
 * 加载涨势反转信号
 */
async function loadReversalSignals() {
  const cardsEl = document.getElementById('reversalCards');
  if (!cardsEl) return;

  try {
    const data = await fetchJSON('/api/signals?filter=reversal');
    lastReversalData = data;

    if (data.scanning && !data.summary) {
      const label = data.progress?.label || '正在扫描 1h EMA 死叉信号';
      cardsEl.innerHTML = `<div class="loading">${label}...</div>`;
      scheduleRetry(() => loadReversalSignals(), 'reversal');
      return;
    }
    if (data.scanning) scheduleRetry(() => loadReversalSignals(), 'reversal');

    if (data.error) {
      cardsEl.innerHTML = `<div class="empty">反转信号错误: ${data.error}</div>`;
      return;
    }

    if (!data.signals || !data.signals.length) {
      cardsEl.innerHTML = '<div class="empty">当前没有检测到涨势反转信号 — 市场普遍处于健康状态 ✨</div>';
      return;
    }

    cardsEl.innerHTML = data.signals.map(renderReversalCard).join('');
  } catch (e) {
    cardsEl.innerHTML = `<div class="empty">反转信号加载失败: ${e.message}</div>`;
  }
}

// ============================================================
//  跌势反转信号 (Bottom Reversal)
// ============================================================

let lastBottomReversalData = null;

/**
 * 渲染单张跌势反转卡片
 */
function renderBottomReversalCard(sig) {
  const r = sig.bottomReversal;
  if (!r) return '';

  const h1Class = sig.changes.h1 > 0 ? 'up' : (sig.changes.h1 < 0 ? 'down' : 'flat');
  const h24Class = sig.changes.h24 > 0 ? 'up' : (sig.changes.h24 < 0 ? 'down' : 'flat');
  const d7Class = sig.changes.d7 > 0 ? 'up' : (sig.changes.d7 < 0 ? 'down' : 'flat');

  // EMA 状态: 金叉后 EMA5 > EMA21, 但 EMA21 < EMA56
  // 在跌势反转 section 中: crossed = 金叉上穿 (绿色), above = 仍在下方 (红色)
  const ema5Class = r.ema5 > r.ema21 ? 'reversal-ema-val-crossed' : 'reversal-ema-val-above';
  const ema21Class = r.ema21 < r.ema56 ? 'reversal-ema-val-above' : 'reversal-ema-val-crossed';

  return `
    <div class="reversal-card">
      <div class="reversal-card-head">
        <div>
          <div class="reversal-card-symbol">${sig.symbol}</div>
          <div class="reversal-card-name">${sig.name || ''}</div>
        </div>
        <div class="reversal-strength" title="反转强度 (0-100)">
          <span class="reversal-strength-num">${r.strength}</span>
          <span class="reversal-strength-label">强度</span>
        </div>
      </div>

      <div class="reversal-ema-row">
        <div class="reversal-ema-item">
          <div class="reversal-ema-name">EMA5</div>
          <div class="reversal-ema-val ${ema5Class}">$${fmtShort(r.ema5)}</div>
        </div>
        <div class="reversal-ema-item">
          <div class="reversal-ema-name">EMA21</div>
          <div class="reversal-ema-val ${ema21Class}">$${fmtShort(r.ema21)}</div>
        </div>
        <div class="reversal-ema-item">
          <div class="reversal-ema-name">EMA56</div>
          <div class="reversal-ema-val">$${fmtShort(r.ema56)}</div>
        </div>
      </div>

      <div class="reversal-row">
        <span class="reversal-label">金叉幅度</span>
        <span class="reversal-value reversal-value-up">${fmtPct(r.crossGap)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">金叉发生</span>
        <span class="reversal-value">${r.crossedAgoHours === 0 ? '刚刚' : r.crossedAgoHours + 'h 前'}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">距谷底反弹</span>
        <span class="reversal-value reversal-value-up">${fmtPct(r.bounceFromTrough)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">7日谷底</span>
        <span class="reversal-value">$${fmtShort(r.troughPrice)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">当前价</span>
        <span class="reversal-value">$${fmtShort(sig.price)}</span>
      </div>
      <div class="reversal-row">
        <span class="reversal-label">市值</span>
        <span class="reversal-value">$${fmtShort(sig.marketCap)} (排名 ${sig.marketCapRank || '--'})</span>
      </div>

      <div class="reversal-footer">
        <span class="reversal-price-change ${h1Class}">1h ${fmtPct(sig.changes.h1)}</span>
        <span class="reversal-price-change ${h24Class}">24h ${fmtPct(sig.changes.h24)}</span>
        <span class="reversal-price-change ${d7Class}">7d ${fmtPct(sig.changes.d7)}</span>
      </div>
    </div>
  `;
}

/**
 * 加载跌势反转信号
 */
async function loadBottomReversalSignals() {
  const cardsEl = document.getElementById('bottomReversalCards');
  if (!cardsEl) return;

  try {
    const data = await fetchJSON('/api/signals?filter=bottomReversal');
    lastBottomReversalData = data;

    if (data.scanning && !data.summary) {
      const label = data.progress?.label || '正在扫描 1h EMA 金叉信号';
      cardsEl.innerHTML = `<div class="loading">${label}...</div>`;
      scheduleRetry(() => loadBottomReversalSignals(), 'bottom');
      return;
    }
    if (data.scanning) scheduleRetry(() => loadBottomReversalSignals(), 'bottom');

    if (data.error) {
      cardsEl.innerHTML = `<div class="empty">跌势反转信号错误: ${data.error}</div>`;
      return;
    }

    if (!data.signals || !data.signals.length) {
      cardsEl.innerHTML = '<div class="empty">当前没有检测到跌势反转信号 — 市场尚未出现底部金叉 📊</div>';
      return;
    }

    cardsEl.innerHTML = data.signals.map(renderBottomReversalCard).join('');
  } catch (e) {
    cardsEl.innerHTML = `<div class="empty">跌势反转信号加载失败: ${e.message}</div>`;
  }
}
