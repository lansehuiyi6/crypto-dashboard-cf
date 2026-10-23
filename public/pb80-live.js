/**
 * 回踩 80 的实时读数。只读币安 U 本位永续，不写进 EMA / 短线 / 共振 / 开仓资格。
 * 成交额前 24 个有合约的币放在独立栏；关注列表里的币共用同一份缓存。
 */

import {
  D1,
  H1,
  H4,
  M15,
  dropForming,
  prepareD1,
  prepareH1,
  prepareH4,
  prepareM15,
  readLatest,
} from './pb80-core.js';

const FAPI = 'https://fapi.binance.com';
const TOP_N = 24;
const CACHE_MS = 3 * 60 * 1000;
const STABLES = new Set(['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'USD1USDT', 'EURUSDT', 'AEURUSDT', 'BUSDUSDT']);

const LIMITS = [
  ['15m', 300, M15],
  ['1h', 250, H1],
  ['4h', 150, H4],
  ['1d', 120, D1],
];

const cache = new Map();
let lastTop = [];
let rankedAt = 0;
let cryptoSet = null;
let cryptoAt = 0;
let busy = false;
let queued = null;
let repaint = null;

export function setPb80Repaint(fn) {
  repaint = fn;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function coinOf(symbol) {
  return String(symbol || '').replace(/USDT$/, '') || symbol;
}

function fmtNum(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '--';
}

function fmtVol(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  return String(Math.round(n));
}

function tagClass(read) {
  if (!read) return 'watch';
  if (read.state === 'entry' && read.dir === 1) return 'long';
  if (read.state === 'entry' && read.dir === -1) return 'short';
  if (read.state === 'wait') return 'cs-wait';
  return 'watch';
}

function meter(read) {
  if (!read) return '';
  const bw = Number.isFinite(read.bw) ? `带宽 ${fmtNum(read.bw * 100, 2)}%` : '';
  const adx = Number.isFinite(read.adx) ? `ADX ${fmtNum(read.adx, 1)}` : '';
  return [bw, adx].filter(Boolean).join(' · ');
}

function chips(read) {
  return (read && read.checks || []).map((c) => {
    const st = c.pass ? 'is-pass' : 'is-fail';
    return `<span class="pb80-chip ${st}">${esc(c.name)}</span>`;
  }).join('');
}

export function pb80StripHtml(symbol) {
  if (!symbol) return '';
  const hit = cache.get(symbol);
  if (!hit) {
    return `<div class="pb80-strip" aria-label="回踩 80">
      <div class="pb80-strip-head">
        <span class="pb80-kicker">回踩 80</span>
        <span class="strategy-tag watch">读取中</span>
        <span class="pb80-focus">1 小时定方向 · 15 分钟回踩才进</span>
      </div>
      <p class="pb80-ratios">止损 1.8% · 80% 仓止盈 +0.6% · 余仓止损不低于开仓价，峰值回撤 1.2%</p>
    </div>`;
  }
  if (hit.err || !hit.read) {
    return `<div class="pb80-strip" aria-label="回踩 80">
      <div class="pb80-strip-head">
        <span class="pb80-kicker">回踩 80</span>
        <span class="strategy-tag watch">无合约</span>
        <span class="pb80-focus">1 小时定方向 · 15 分钟回踩才进</span>
      </div>
      <p class="pb80-why">币安 U 本位这只合约的 K 线暂时没拿到。</p>
      <p class="pb80-ratios">止损 1.8% · 80% 仓止盈 +0.6% · 余仓止损不低于开仓价，峰值回撤 1.2%</p>
    </div>`;
  }
  const read = hit.read;
  return `<div class="pb80-strip is-${esc(read.state)}" aria-label="回踩 80">
    <div class="pb80-strip-head">
      <span class="pb80-kicker">回踩 80</span>
      <span class="strategy-tag ${tagClass(read)}">${esc(read.label)}</span>
      <span class="pb80-focus">1 小时定方向 · 15 分钟回踩才进</span>
      <span class="pb80-meter">${esc(meter(read))}</span>
    </div>
    <p class="pb80-why">${esc(read.why)}</p>
    <p class="pb80-ratios">${esc(read.ratios)}</p>
    <div class="pb80-chips">${chips(read)}</div>
  </div>`;
}

function rowHtml(symbol) {
  const hit = cache.get(symbol) || {};
  const read = hit.read;
  const name = coinOf(symbol);
  const vol = fmtVol(hit.quoteVolume);
  const chg = Number.isFinite(hit.chg) ? `${hit.chg > 0 ? '+' : ''}${hit.chg.toFixed(1)}%` : '';
  const chgCls = hit.chg > 0 ? 'up' : hit.chg < 0 ? 'down' : '';
  if (!read) {
    return `<div class="pb80-row">
      <div class="pb80-row-h">
        <span class="pb80-rank">${hit.rank || ''}</span>
        <span class="pb80-sym">${esc(name)}</span>
        <span class="strategy-tag watch">无合约</span>
      </div>
      <p>K 线暂时没拿到。</p>
    </div>`;
  }
  return `<div class="pb80-row is-${esc(read.state)}">
    <div class="pb80-row-h">
      <span class="pb80-rank">${hit.rank || ''}</span>
      <span class="pb80-sym">${esc(name)}</span>
      <span class="strategy-tag ${tagClass(read)}">${esc(read.label)}</span>
      ${chg ? `<span class="pb80-chg ${chgCls}">${esc(chg)}</span>` : ''}
    </div>
    <p>${esc(read.why)}</p>
    <p class="pb80-meter">${esc([meter(read), vol ? `24h ${vol}` : ''].filter(Boolean).join(' · '))}</p>
  </div>`;
}

function paint(top) {
  const badge = document.getElementById('pb80Badge');
  const longBox = document.getElementById('pb80Long');
  const shortBox = document.getElementById('pb80Short');
  const waitBox = document.getElementById('pb80Wait');
  const flatBox = document.getElementById('pb80Flat');
  if (!longBox || !shortBox || !waitBox || !flatBox) return;
  const longs = [];
  const shorts = [];
  const waits = [];
  const flats = [];
  for (const t of top) {
    const read = cache.get(t.symbol)?.read;
    if (!read || read.label === '数据不够' || read.label === '不开') flats.push(t.symbol);
    else if (read.state === 'entry' && read.dir === 1) longs.push(t.symbol);
    else if (read.state === 'entry' && read.dir === -1) shorts.push(t.symbol);
    else waits.push(t.symbol);
  }
  const byAdx = (a, b) => (cache.get(b)?.read?.adx || 0) - (cache.get(a)?.read?.adx || 0);
  longs.sort(byAdx);
  shorts.sort(byAdx);
  waits.sort(byAdx);
  const fill = (box, list, empty) => {
    box.innerHTML = list.length ? list.map(rowHtml).join('') : `<div class="pb80-empty">${empty}</div>`;
  };
  fill(longBox, longs, '这 24 个里现在没有试多。');
  fill(shortBox, shorts, '这 24 个里现在没有试空。');
  fill(waitBox, waits, '没有已经对齐、还在等回踩的币。');
  const names = flats.map((s) => coinOf(s));
  flatBox.textContent = names.length
    ? `不开 ${names.length} 个：${names.join('、')}。方向、带宽、ADX 或回踩没同时满足。`
    : '这 24 个都有方向或在等回踩。';
  if (badge) badge.textContent = `前 ${top.length} · 已收盘`;
  const counts = {
    pb80LongCount: longs.length,
    pb80ShortCount: shorts.length,
    pb80WaitCount: waits.length,
  };
  for (const [id, n] of Object.entries(counts)) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  }
}

function tradable(symbol) {
  if (!symbol.endsWith('USDT')) return false;
  if (symbol.includes('_')) return false;
  if (STABLES.has(symbol)) return false;
  if (/(UP|DOWN|BULL|BEAR)USDT$/.test(symbol)) return false;
  return true;
}

async function loadCryptoPerps() {
  if (cryptoSet && Date.now() - cryptoAt < 30 * 60 * 1000) return cryptoSet;
  const res = await fetch(`${FAPI}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('exchangeInfo ' + res.status);
  const data = await res.json();
  const set = new Set();
  for (const s of data.symbols || []) {
    if (s.status !== 'TRADING' || s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue;
    const sub = s.underlyingSubType || [];
    if (sub.includes('TradFi')) continue;
    if (s.underlyingType && s.underlyingType !== 'COIN' && s.underlyingType !== 'INDEX') continue;
    set.add(s.symbol);
  }
  cryptoSet = set;
  cryptoAt = Date.now();
  return set;
}

async function fetchTop() {
  const [rows, coins] = await Promise.all([
    fetch(`${FAPI}/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(12000) }).then((res) => {
      if (!res.ok) throw new Error('ticker ' + res.status);
      return res.json();
    }),
    loadCryptoPerps(),
  ]);
  return rows
    .filter((t) => t && tradable(t.symbol) && coins.has(t.symbol))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, TOP_N)
    .map((t) => ({
      symbol: t.symbol,
      quoteVolume: +t.quoteVolume,
      chg: +t.priceChangePercent,
    }));
}

async function fetchKlines(symbol, interval, limit) {
  const res = await fetch(
    `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    { signal: AbortSignal.timeout(12000) },
  );
  if (!res.ok) throw new Error(res.status);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 40) throw new Error('short');
  return rows;
}

async function readSymbol(symbol) {
  const got = {};
  for (const [tf, limit, ms] of LIMITS) {
    got[tf] = dropForming(await fetchKlines(symbol, tf, limit), ms);
  }
  const pack = {
    m15: prepareM15(got['15m']),
    h1: prepareH1(got['1h']),
    h4: prepareH4(got['4h']),
    d1: prepareD1(got['1d']),
  };
  return readLatest(pack);
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await fn(items[i], i);
    }
  }
  const width = Math.min(Math.max(1, n), Math.max(1, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}

export async function loadPb80({ force = false, symbols = [] } = {}) {
  if (busy) {
    queued = { force: !!(queued && queued.force) || force, symbols };
    return;
  }
  const badge = document.getElementById('pb80Badge');
  busy = true;
  if (badge && !lastTop.length) badge.textContent = '正在读已收盘 K 线…';
  try {
    const now = Date.now();
    let top = lastTop;
    try {
      if (force || !top.length || now - rankedAt > CACHE_MS) {
        top = await fetchTop();
        lastTop = top;
        rankedAt = now;
      }
    } catch {
      if (badge) badge.textContent = '名单没拉到';
      const flat = document.getElementById('pb80Flat');
      if (flat && !top.length) flat.textContent = '币安 24 小时成交额暂时没拉到，关注币的卡片仍会单独读。';
    }
    top.forEach((t, i) => {
      const hit = cache.get(t.symbol) || {};
      hit.rank = i + 1;
      hit.quoteVolume = t.quoteVolume;
      hit.chg = t.chg;
      cache.set(t.symbol, hit);
    });
    const want = new Set([...top.map((t) => t.symbol), ...symbols.filter(Boolean)]);
    const todo = [...want].filter((sym) => {
      const hit = cache.get(sym);
      return force || !hit || !hit.at || now - hit.at > CACHE_MS || hit.err;
    });
    await mapPool(todo, 4, async (sym) => {
      const prev = cache.get(sym) || {};
      try {
        const read = await readSymbol(sym);
        cache.set(sym, { ...prev, at: Date.now(), read, err: null });
      } catch (err) {
        cache.set(sym, { ...prev, at: Date.now(), read: null, err: err && err.message ? err.message : 'fail' });
      }
    });
    paint(top);
    if (typeof repaint === 'function') repaint();
  } catch {
    if (badge) badge.textContent = '这轮没算完';
  } finally {
    busy = false;
    if (queued) {
      const job = queued;
      queued = null;
      loadPb80(job).catch(() => {});
    }
  }
}
