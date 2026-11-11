/**
 * Hyperliquid 聪明钱观测栏。只读 /api/hl-smart-money，不写进 EMA / 短线 / 共振 / 开仓资格 / 通知。
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtUsd(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${Math.round(a)}`;
}

function fmtPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  return `${Math.round(v * 100)}%`;
}

function shanghai(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function leanText(lean) {
  if (lean === 'long') return '偏多';
  if (lean === 'short') return '偏空';
  return '均衡';
}

function scaleHtml(scale) {
  if (!scale) return '<div class="hl-empty">还没有天平快照。等定时扫描拉完官方 30 天榜和持仓再写进来。</div>';
  const longPct = Math.max(0, Math.min(100, (scale.longPct || 0) * 100));
  const shortPct = Math.max(0, 100 - longPct);
  const leanCls = scale.lean === 'long' ? 'long' : scale.lean === 'short' ? 'short' : 'watch';
  const coins = (scale.coins || []).map((c) => {
    const lp = Math.max(0, Math.min(100, (c.longPct || 0) * 100));
    const coinLean = c.lean === 'long' ? 'long' : c.lean === 'short' ? 'short' : 'watch';
    return `<div class="hl-coin">
      <div class="hl-coin-h">
        <span class="hl-coin-name">${esc(c.label)}</span>
        <span class="strategy-tag ${coinLean}">${esc(leanText(c.lean))}</span>
        <span class="hl-coin-split">多 ${esc(fmtUsd(c.longUsd))} · 空 ${esc(fmtUsd(c.shortUsd))}</span>
      </div>
      <div class="hl-mini-bar" title="利润加权 多 ${fmtPct(c.longPct)}">
        <i class="is-long" style="width:${lp.toFixed(1)}%"></i>
        <i class="is-short" style="width:${(100 - lp).toFixed(1)}%"></i>
      </div>
    </div>`;
  }).join('');

  const whales = (scale.top || []).map((w) => {
    const sideCls = w.side === 'long' ? 'long' : 'short';
    const sideLabel = w.side === 'long' ? '押多' : '押空';
    const who = w.name ? `${esc(w.name)} · ${esc(w.short)}` : esc(w.short);
    return `<div class="hl-whale">
      <span class="hl-rank">${w.rank}</span>
      <a class="hl-addr" href="${esc(w.href)}" target="_blank" rel="noopener">${who}</a>
      <span class="strategy-tag ${sideCls}">${sideLabel}</span>
      <span class="hl-pnl">30天 ${esc(fmtUsd(w.pnl30))}</span>
      <span class="hl-whale-coins">${esc((w.coins || []).join(' · '))}</span>
    </div>`;
  }).join('');

  return `
    <div class="hl-scale-card">
      <div class="hl-scale-head">
        <span class="strategy-tag ${leanCls}">${esc(leanText(scale.lean))}</span>
        <span class="hl-scale-meta">${scale.withPos || 0} / ${scale.n || 0} 个地址有仓 · 空仓 ${scale.flatN || 0}</span>
      </div>
      <div class="hl-scale-bar" role="img" aria-label="聪明钱天平 押多 ${fmtPct(scale.longPct)} 押空 ${fmtPct(1 - (scale.longPct || 0))}">
        <span class="is-long" style="width:${longPct.toFixed(1)}%"></span>
        <span class="is-short" style="width:${shortPct.toFixed(1)}%"></span>
      </div>
      <div class="hl-scale-labels">
        <span>押多 ${esc(fmtPct(scale.longPct))} · 利润 ${esc(fmtUsd(scale.longW))} · ${scale.longN || 0} 人</span>
        <span>押空 ${esc(fmtPct(1 - (scale.longPct || 0)))} · 利润 ${esc(fmtUsd(scale.shortW))} · ${scale.shortN || 0} 人</span>
      </div>
      <p class="hl-scale-notional">名义仓位 多 ${esc(fmtUsd(scale.longUsd))} / 空 ${esc(fmtUsd(scale.shortUsd))}。天平按 30 天利润加权，不按名义金额。</p>
    </div>
    <div class="hl-coins">${coins || '<div class="hl-empty">这 300 个地址现在没有足够大的仓位可拆。</div>'}</div>
    <div class="hl-whales">${whales}</div>`;
}

function eventsHtml(events) {
  if (!events || !events.length) {
    return '<div class="hl-empty">这一轮没有达到门槛的异动。门槛：大佬出手 30 天利润 ≥ $50 万且变动 ≥ $25 万；大单 ≥ $100 万；爆仓 ≥ $50 万。每小时最多 3 条。</div>';
  }
  return events.map((e) => {
    const sideCls = e.side === 'short' ? 'short' : 'long';
    const kindCls = e.kind === 'liq' ? 'is-liq' : e.kind === 'order' ? 'is-order' : 'is-whale';
    const who = e.name ? `${esc(e.name)} · ${esc(e.short)}` : esc(e.short);
    const whale = e.whale ? ` · 30天 ${esc(fmtUsd(e.pnl30))}` : '';
    return `<div class="hl-event ${kindCls}">
      <div class="hl-event-h">
        <span class="hl-kind">${esc(e.kindLabel || e.kind)}</span>
        <span class="strategy-tag ${sideCls}">${esc(e.action || '')}</span>
        <span class="hl-event-coin">${esc(e.label || e.coin)}</span>
        <span class="hl-event-usd">${esc(fmtUsd(e.notional))}</span>
        <span class="hl-event-time">${esc(shanghai(e.t))}</span>
      </div>
      <p><a class="hl-addr" href="${esc(e.href)}" target="_blank" rel="noopener">${who}</a>${whale}</p>
    </div>`;
  }).join('');
}

function paint(data) {
  const badge = document.getElementById('hlBadge');
  const scaleBox = document.getElementById('hlScale');
  const eventBox = document.getElementById('hlEvents');
  const stamp = document.getElementById('hlStamp');
  if (!scaleBox || !eventBox) return;
  const asOf = data.fetchedAt || data.asOf;
  if (badge) {
    if (data.source === 'empty') badge.textContent = '等待扫描写入';
    else badge.textContent = `快照 · ${shanghai(asOf)}`;
  }
  if (stamp) {
    if (data.source === 'empty') {
      stamp.textContent = data.hint || '等待 GitHub Actions 约 15 分钟扫一次，把官方榜和持仓写成快照。';
    } else {
      const scale = data.scale;
      stamp.textContent = `官方 30 天利润榜前 ${scale?.n || 0} 个有成交地址。天平按利润加权。异动每小时最多 3 条。观测不等于下单。`;
    }
  }
  scaleBox.innerHTML = scaleHtml(data.scale);
  eventBox.innerHTML = eventsHtml(data.events);
}

let busy = false;
let again = false;

export async function loadHlSmartMoney() {
  if (busy) {
    again = true;
    return;
  }
  const scaleBox = document.getElementById('hlScale');
  const eventBox = document.getElementById('hlEvents');
  if (!scaleBox || !eventBox) return;
  busy = true;
  const badge = document.getElementById('hlBadge');
  if (badge && !badge.textContent.includes('快照')) badge.textContent = '正在读取…';
  try {
    const res = await fetch('/api/hl-smart-money', { cache: 'no-store' });
    const data = await res.json();
    paint(data || {});
  } catch (err) {
    if (badge) badge.textContent = '这次没读到';
    scaleBox.innerHTML = `<div class="hl-empty">${esc(err.message || err)}</div>`;
  } finally {
    busy = false;
    if (again) {
      again = false;
      loadHlSmartMoney().catch(() => {});
    }
  }
}


