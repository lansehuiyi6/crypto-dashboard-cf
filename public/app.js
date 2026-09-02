import {
  STRATEGY_SYMBOLS,
  evaluateEmaTrendStrategy,
  evaluateMacdKdjSignal,
  evaluateAdx,
  annotateMacdKdjContext,
  annotateKeltnerWithHtfAdx,
  attachAlphaTrend,
  toDominanceKlines,
  INTERVAL_MS,
  EXEC_INTERVALS,
  HTF_INTERVALS,
} from './ema-core.js';

const KLINE_LIMIT = 160;


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
  if (v == null || !Number.isFinite(n)) return '--';
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

function setPriceStamp(meta, extra = '') {
  const el = document.getElementById('priceStamp');
  if (!el) return;
  const srcMap = { binance: '币安实时', coingecko: 'CoinGecko', live: '实时', snapshot: '快照' };
  const src = srcMap[meta?.source] || meta?.source || '';
  const when = meta?.fetchedAt ? fmtTime(meta.fetchedAt) : '';
  const cls = meta?.source === 'snapshot' ? 'src-snap' : 'src-live';
  const bits = [];
  if (src && when) bits.push(`<span class="${cls}">${src} ${when}</span>`);
  else if (when) bits.push(when);
  if (extra) bits.push(extra);
  el.innerHTML = bits.join(' · ') || '';
}

let lastBtcChange = null;

async function fetchBinancePricesClient() {
  const spot = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const map = {
    BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', BNBUSDT: 'binancecoin',
    SOLUSDT: 'solana', XRPUSDT: 'ripple', DOGEUSDT: 'dogecoin',
  };
  const [list, xau] = await Promise.all([
    fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(spot))).then((r) => {
      if (!r.ok) throw new Error('ticker ' + r.status);
      return r.json();
    }),
    fetch('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=XAUUSDT').then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  const out = {};
  for (const row of list || []) {
    const id = map[row.symbol];
    if (id) out[id] = { usd: Number(row.lastPrice), usd_24h_change: Number(row.priceChangePercent) };
  }
  if (xau && xau.lastPrice) {
    out.xau = { usd: Number(xau.lastPrice), usd_24h_change: Number(xau.priceChangePercent) };
  }
  if (!out.bitcoin) throw new Error('binance ticker empty');
  out.meta = { source: 'binance', fetchedAt: Date.now() };
  return out;
}

const LS_KLINE = 'cd:kl:';
const LS_USDTD = 'cd:usdtd';
const USDTD_TTL_MS = 15 * 60 * 1000;
const KLINE_STALE_MAX_MS = 30 * 60 * 1000;

function lsGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.ts !== 'number' || o.data == null) return null;
    if (Date.now() - o.ts > maxAgeMs) return null;
    return o.data;
  } catch {
    return null;
  }
}

function lsSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota / private mode */ }
}

const LS_NOTIFY_PREF = 'cd:notify:pref';
const LS_NOTIFY_STATE = 'cd:notify:state';
const LS_NOTIFY_SENT = 'cd:notify:sent';
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const NOTIFY_SENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function defaultNotifyPref() {
  return {
    enabled: false,
    // 默认只推真正可执行/了结边沿；武装可选
    kinds: {
      combined: true,   // 共振开仓
      mid: false,       // 中轴默认关，减少噪音
      mk: true,         // MK 入场/离场边沿
      keltner: true,    // KC 入场/止盈/止损（武装另控）
      keltnerArm: false,
    },
  };
}

function readNotifyPref() {
  try {
    const raw = localStorage.getItem(LS_NOTIFY_PREF);
    if (!raw) return defaultNotifyPref();
    const o = JSON.parse(raw);
    return { ...defaultNotifyPref(), ...(o && typeof o === 'object' ? o : {}) };
  } catch {
    return defaultNotifyPref();
  }
}

function writeNotifyPref(pref) {
  try {
    localStorage.setItem(LS_NOTIFY_PREF, JSON.stringify(pref));
  } catch { /* ignore */ }
}

function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function notifyPermission() {
  if (!notifySupported()) return 'unsupported';
  return Notification.permission; // granted | denied | default
}

function canNotify() {
  const pref = readNotifyPref();
  return !!(pref.enabled && notifySupported() && Notification.permission === 'granted');
}

function readNotifyMap(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function writeNotifyMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch { /* ignore */ }
}

function pruneNotifySent(sent) {
  const now = Date.now();
  const out = {};
  for (const [k, ts] of Object.entries(sent || {})) {
    if (Number.isFinite(ts) && now - ts < NOTIFY_SENT_MAX_AGE_MS) out[k] = ts;
  }
  return out;
}

function isActionCombined(label, dir) {
  if (dir !== 'long' && dir !== 'short') return false;
  const s = String(label || '');
  // 只认明确开仓类标签，避免「做多」字样误触
  return /(开口)?共振做多|(开口)?共振做空|中轴共振做多|中轴共振做空|震荡环境做多|震荡环境做空/.test(s)
    || (/共振/.test(s) && /做多|做空/.test(s) && !/暂缓|分歧|等EMA|未过滤/.test(s));
}

function notifyKindsEnabled() {
  const pref = readNotifyPref();
  return { ...defaultNotifyPref().kinds, ...(pref.kinds || {}) };
}

function alertAllowedByPref(evKind, edge) {
  const kinds = notifyKindsEnabled();
  if (evKind === 'combined') return !!kinds.combined;
  if (evKind === 'mid') return !!kinds.mid;
  if (evKind === 'mk') return !!kinds.mk;
  if (evKind === 'keltner') {
    if (edge === 'arm') return !!kinds.keltnerArm;
    return !!kinds.keltner;
  }
  return true;
}

function snapshotEmaAlerts(board) {
  const out = {};
  if (!board) return out;
  for (const tf of EXEC_INTERVALS) {
    for (const coin of Object.keys(STRATEGY_SYMBOLS)) {
      const row = board[tf] && board[tf][coin];
      if (!row) continue;
      const c = row.combined || {};
      const mk = row.macdKdjView || row.macdKdj || {};
      const bm = row.bollMid || {};
      const kc = row.keltner || {};
      out[`${coin}|${tf}|combined`] = {
        kind: 'combined',
        coin,
        tf,
        dir: c.dir || 'watch',
        label: c.label || '观望',
        reason: c.reason || '',
        active: isActionCombined(c.label, c.dir),
      };
      out[`${coin}|${tf}|mk`] = {
        kind: 'mk',
        coin,
        tf,
        dir: mk.action === 'exit' || mk.action === 'overbought' ? 'short'
          : mk.action === 'entry' || (mk.action === 'hold' && mk.bias === 'with') ? 'long'
            : 'watch',
        label: mk.actionLabel || mk.stateLabel || '观望',
        reason: mk.reason || '',
        // 只认真正边沿，避免「动能区」被当成持仓结束噪音
        active: !!(mk.buyEdge || mk.sellEdge),
        edge: mk.buyEdge ? 'entry' : mk.sellEdge ? 'exit' : '',
      };
      out[`${coin}|${tf}|mid`] = {
        kind: 'mid',
        coin,
        tf,
        dir: bm.setup === 'long' || bm.setup === 'short' ? bm.setup : 'watch',
        label: bm.setupLabel || '中轴观望',
        reason: bm.hint || '',
        active: bm.setup === 'long' || bm.setup === 'short',
      };
      out[`${coin}|${tf}|keltner`] = {
        kind: 'keltner',
        coin,
        tf,
        dir: kc.dir || 'watch',
        label: kc.stateLabel || 'Keltner观望',
        reason: kc.advice || kc.hint || kc.regimeNote || '',
        // 通知聚焦事件边沿：武装/入场/止盈/止损；「入场后未平」不刷通知
        active: !!(kc.armLongEdge || kc.armShortEdge
          || kc.longEntry || kc.shortEntry
          || kc.longTp || kc.longSl || kc.shortTp || kc.shortSl),
        edge: kc.edge || '',
      };
    }
  }
  return out;
}

function notifyKindTitle(kind) {
  if (kind === 'combined') return '共振/合成';
  if (kind === 'mk') return 'MACD+KDJ';
  if (kind === 'mid') return '中轴';
  if (kind === 'keltner') return 'Keltner回归';
  return '策略';
}

function shouldEmitAlert(prev, next) {
  // 新 key（首屏增量加载）只建基线，不弹窗
  if (!prev || !next) return null;
  // 不再推「结束」类噪音；只推 active 边沿出现/切换
  if (!next.active) return null;
  if (!alertAllowedByPref(next.kind, next.edge)) return null;
  const changed = !prev.active
    || prev.label !== next.label
    || prev.dir !== next.dir
    || prev.edge !== next.edge;
  if (!changed) return null;
  const edgeTxt = next.edge === 'arm'
    ? '武装'
    : next.edge === 'entry'
      ? '入场'
      : next.edge === 'exit'
        ? '离场'
        : next.edge === 'tp'
          ? '止盈'
          : next.edge === 'sl'
            ? '止损'
            : next.kind === 'combined'
              ? '开仓'
              : '';
  return {
    title: `${next.coin} ${next.tf} · ${notifyKindTitle(next.kind)}${edgeTxt ? ' ' + edgeTxt : ''}`,
    body: `${next.label}${next.reason ? ' — ' + next.reason : ''}`,
    tag: `${next.coin}-${next.tf}-${next.kind}`,
    fingerprint: `${next.coin}|${next.tf}|${next.kind}|${next.label}|${next.edge || ''}`,
  };
}

function showBrowserNotification(title, body, tag) {
  if (!canNotify()) return false;
  try {
    const n = new Notification(title, {
      body: body || '',
      tag: tag || undefined,
      renotify: true,
      silent: false,
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      n.close();
    };
    return true;
  } catch (e) {
    console.warn('Notification failed', e.message || e);
    return false;
  }
}

function processEmaNotifications(board, { bootstrap = false } = {}) {
  const nextMap = snapshotEmaAlerts(board);
  const prevMap = readNotifyMap(LS_NOTIFY_STATE);
  const hasPrev = Object.keys(prevMap).length > 0;

  if (bootstrap || !hasPrev) {
    writeNotifyMap(LS_NOTIFY_STATE, nextMap);
    return;
  }
  if (!canNotify()) {
    writeNotifyMap(LS_NOTIFY_STATE, nextMap);
    return;
  }

  let sent = pruneNotifySent(readNotifyMap(LS_NOTIFY_SENT));
  const now = Date.now();
  const events = [];
  for (const [key, next] of Object.entries(nextMap)) {
    const prev = prevMap[key];
    const ev = shouldEmitAlert(prev, next);
    if (!ev) continue;
    const last = sent[ev.fingerprint];
    if (Number.isFinite(last) && now - last < NOTIFY_COOLDOWN_MS) continue;
    events.push(ev);
  }

  // 同一次刷新最多弹 3 条，避免刷屏
  for (const ev of events.slice(0, 3)) {
    if (showBrowserNotification(ev.title, ev.body, ev.tag)) {
      sent[ev.fingerprint] = now;
    }
  }
  writeNotifyMap(LS_NOTIFY_SENT, sent);
  writeNotifyMap(LS_NOTIFY_STATE, nextMap);
}

function updateNotifyUi() {
  const btn = document.getElementById('emaNotifyToggle');
  const testBtn = document.getElementById('emaNotifyTest');
  const status = document.getElementById('emaNotifyStatus');
  if (!btn || !status) return;
  const pref = readNotifyPref();
  const perm = notifyPermission();

  if (perm === 'unsupported') {
    btn.disabled = true;
    btn.textContent = '通知不可用';
    btn.classList.remove('on');
    if (testBtn) testBtn.hidden = true;
    status.textContent = '当前浏览器不支持 Notification';
    return;
  }

  btn.disabled = false;
  if (perm === 'denied') {
    btn.classList.remove('on');
    btn.textContent = '通知已被禁用';
    if (testBtn) testBtn.hidden = true;
    status.textContent = '请在浏览器站点设置里允许通知';
    return;
  }

  const armWrap = document.getElementById('emaNotifyArmWrap');
  const armChk = document.getElementById('emaNotifyArm');
  const kinds = notifyKindsEnabled();
  if (armChk) armChk.checked = !!kinds.keltnerArm;

  if (pref.enabled && perm === 'granted') {
    btn.classList.add('on');
    btn.textContent = '通知已开启';
    if (testBtn) testBtn.hidden = false;
    if (armWrap) armWrap.hidden = false;
    status.textContent = `默认：共振开仓 / MK出入 / KC入场止盈止损${kinds.keltnerArm ? ' / 武装' : ''} · 需保持页面开启`;
  } else {
    btn.classList.remove('on');
    btn.textContent = '开启浏览器通知';
    if (testBtn) testBtn.hidden = true;
    if (armWrap) armWrap.hidden = true;
    status.textContent = perm === 'default' ? '点击授权后，重要信号变化会弹窗提醒' : '已授权，点击开启提醒';
  }
}

async function toggleEmaNotify() {
  if (!notifySupported()) {
    updateNotifyUi();
    return;
  }
  const pref = readNotifyPref();
  if (Notification.permission === 'denied') {
    updateNotifyUi();
    return;
  }
  if (Notification.permission !== 'granted') {
    const res = await Notification.requestPermission();
    if (res !== 'granted') {
      writeNotifyPref({ ...pref, enabled: false });
      updateNotifyUi();
      return;
    }
    writeNotifyPref({ ...pref, enabled: true, kinds: { ...defaultNotifyPref().kinds, ...(pref.kinds || {}) } });
    if (lastEmaBoard) processEmaNotifications(lastEmaBoard, { bootstrap: true });
    showBrowserNotification('短线策略通知已开启', '默认提醒：共振开仓、MK 出入、KC 入场/止盈/止损（武装需另开）', 'ema-notify-on');
    updateNotifyUi();
    return;
  }
  const enabled = !pref.enabled;
  writeNotifyPref({ ...pref, enabled, kinds: { ...defaultNotifyPref().kinds, ...(pref.kinds || {}) } });
  if (enabled) {
    if (lastEmaBoard) processEmaNotifications(lastEmaBoard, { bootstrap: true });
    showBrowserNotification('短线策略通知已开启', '默认提醒：共振开仓、MK 出入、KC 入场/止盈/止损（武装需另开）', 'ema-notify-on');
  }
  updateNotifyUi();
}

function toggleNotifyArm() {
  const pref = readNotifyPref();
  const armChk = document.getElementById('emaNotifyArm');
  const kinds = { ...defaultNotifyPref().kinds, ...(pref.kinds || {}) };
  kinds.keltnerArm = !!(armChk && armChk.checked);
  writeNotifyPref({ ...pref, kinds });
  updateNotifyUi();
}

function testEmaNotify() {
  if (!canNotify()) {
    updateNotifyUi();
    return;
  }
  showBrowserNotification('测试通知', '浏览器通知工作正常。策略变化时会用同样方式提醒。', 'ema-notify-test');
}

function initEmaNotifyUi() {
  const btn = document.getElementById('emaNotifyToggle');
  const testBtn = document.getElementById('emaNotifyTest');
  const armChk = document.getElementById('emaNotifyArm');
  if (btn) btn.addEventListener('click', () => { toggleEmaNotify().catch(() => updateNotifyUi()); });
  if (testBtn) testBtn.addEventListener('click', testEmaNotify);
  if (armChk) armChk.addEventListener('change', toggleNotifyArm);
  updateNotifyUi();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateNotifyUi();
  });
}

function klineFreshMs(interval) {
  if (interval === '15m') return 90 * 1000;
  if (interval === '1h') return 4 * 60 * 1000;
  if (interval === '4h') return 20 * 60 * 1000;
  if (interval === '1d') return 2 * 60 * 60 * 1000;
  return 4 * 60 * 1000;
}

function emptyBoard() {
  return {
    '15m': {},
    '1h': {},
    '4h': {},
    '1d': {},
    adx4h: {},
    usdtD: {},
    source: 'browser',
    fetchedAt: Date.now(),
    errors: [],
    cached: false,
  };
}

function rowFromKlines(klines, coin, interval) {
  const row = evaluateEmaTrendStrategy(klines, coin, { interval });
  return row ? attachAlphaTrend(row, klines, { interval }) : null;
}

function macdKdjFromKlines(klines, coin, interval) {
  return evaluateMacdKdjSignal(klines, coin, { interval });
}

function enrichBoardMacdKdj(board) {
  for (const tf of EXEC_INTERVALS) {
    for (const coin of Object.keys(STRATEGY_SYMBOLS)) {
      const row = board[tf] && board[tf][coin];
      if (!row || !row.macdKdj) continue;
      row.macdKdjView = annotateMacdKdjContext(row.macdKdj, board['4h']?.[coin], board['1d']?.[coin]);
    }
  }
  enrichBoardKeltnerAdx(board);
}

function enrichBoardKeltnerAdx(board) {
  if (!board) return;
  for (const coin of Object.keys(STRATEGY_SYMBOLS)) {
    const row15 = board['15m'] && board['15m'][coin];
    const row1h = board['1h'] && board['1h'][coin];
    const adx1h = row1h && row1h.adx;
    const adx4h = board.adx4h && board.adx4h[coin];

    if (row15 && row15.keltner) {
      // 15m 执行：过滤看 1h，背景看 4h
      row15.keltner = annotateKeltnerWithHtfAdx(row15.keltner, {
        filterAdx: adx1h,
        filterTf: '1h',
        bgAdx: adx4h,
        bgTf: '4h',
        localAdx: row15.adx,
        localTf: '15m',
      });
    }
    if (row1h && row1h.keltner) {
      // 1h 执行：过滤看 4h；本周期 1h ADX 作对照（不再把 1h 再当背景重复显示）
      row1h.keltner = annotateKeltnerWithHtfAdx(row1h.keltner, {
        filterAdx: adx4h || adx1h,
        filterTf: adx4h ? '4h' : '1h',
        bgAdx: null,
        bgTf: null,
        localAdx: row1h.adx,
        localTf: '1h',
      });
    }
  }
}

function hydrateBoardFromCache(board) {
  let hits = 0;
  for (const [coin, symbol] of Object.entries(STRATEGY_SYMBOLS)) {
    for (const interval of EXEC_INTERVALS) {
      const cached = lsGet(LS_KLINE + symbol + ':' + interval, KLINE_STALE_MAX_MS);
      if (!cached) continue;
      try {
        const row = rowFromKlines(cached, coin, interval);
        if (row) {
          board[interval][coin] = row;
          hits += 1;
        }
      } catch { /* ignore bad cache */ }
    }
    for (const interval of HTF_INTERVALS) {
      const maxAge = interval === '1d' ? 6 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
      const cached = lsGet(LS_KLINE + symbol + ':' + interval, maxAge);
      if (!cached) continue;
      try {
        const mk = macdKdjFromKlines(cached, coin, interval);
        if (mk) {
          board[interval][coin] = mk;
          hits += 1;
        }
        if (interval === '4h') {
          const adx = evaluateAdx(cached, { interval: '4h' });
          if (adx) board.adx4h[coin] = adx;
        }
      } catch { /* ignore */ }
    }
  }
  enrichBoardMacdKdj(board);
  const usdtd = lsGet(LS_USDTD, 60 * 60 * 1000);
  if (usdtd) board.usdtD = usdtd;
  if (hits) board.cached = true;
  return hits;
}

async function fetchKlinesClient(symbol, interval, limit = KLINE_LIMIT) {
  const aliases = symbol === 'XAUUSDT' ? ['XAUUSDT', 'PAXGUSDT'] : [symbol];
  const lim = Math.max(Number(limit) || KLINE_LIMIT, 100);
  const hosts = [
    (s) => `https://data-api.binance.vision/api/v3/klines?symbol=${s}&interval=${interval}&limit=${lim}`,
    (s) => `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${interval}&limit=${lim}`,
    (s) => `https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${interval}&limit=${lim}`,
  ];
  for (const sym of aliases) {
    for (const make of hosts) {
      try {
        const res = await fetch(make(sym));
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 80) return data;
      } catch { /* next host */ }
    }
  }
  throw new Error('klines ' + symbol);
}

async function getKlinesCached(symbol, interval, force, limit = KLINE_LIMIT) {
  const key = LS_KLINE + symbol + ':' + interval;
  if (!force) {
    const hit = lsGet(key, klineFreshMs(interval));
    if (hit) return hit;
  }
  const klines = await fetchKlinesClient(symbol, interval, limit);
  lsSet(key, klines);
  return klines;
}

async function fetchCgMcaps(id, days) {
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  if (!res.ok) throw new Error('cg ' + id + ' ' + res.status);
  const data = await res.json();
  return data.market_caps || [];
}

const BTC_CIRCULATING = 19.85e6;
const ETH_CIRCULATING = 120.7e6;

async function fetchUsdtCircUsd() {
  const res = await fetch('https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1');
  if (!res.ok) throw new Error('llama usdt ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('llama usdt empty');
  const last = arr[arr.length - 1];
  const v = Number(last?.totalCirculatingUSD?.peggedUSD ?? last?.totalCirculating?.peggedUSD);
  if (!Number.isFinite(v) || v <= 0) throw new Error('llama usdt bad value');
  return v;
}

/** 用币安 BTC/ETH K 线 + USDT 流通市值构造 USDT.D 代理序列（不依赖 CoinGecko） */
function dominanceKlinesFromBinance(btcKlines, ethKlines, usdtMc, scaleTo) {
  const ethByT = new Map((ethKlines || []).map((k) => [Number(k[0]), Number(k[4])]));
  const rows = [];
  for (const k of btcKlines || []) {
    const t = Number(k[0]);
    const btcPx = Number(k[4]);
    const ethPx = ethByT.get(t);
    if (!Number.isFinite(btcPx) || !Number.isFinite(ethPx) || btcPx <= 0 || ethPx <= 0) continue;
    const btcMc = btcPx * BTC_CIRCULATING;
    const ethMc = ethPx * ETH_CIRCULATING;
    const proxy = (100 * usdtMc) / (usdtMc + btcMc + ethMc);
    rows.push([t, proxy, proxy, proxy, proxy, 0]);
  }
  if (!rows.length) return [];
  if (Number.isFinite(scaleTo) && scaleTo > 0) {
    const last = rows[rows.length - 1][4];
    if (last > 0) {
      const s = scaleTo / last;
      return rows.map((r) => {
        const c = r[4] * s;
        return [r[0], c, c, c, c, 0];
      });
    }
  }
  return rows;
}

function buildUsdtDRow(klines, interval) {
  const row = evaluateEmaTrendStrategy(klines, 'USDT.D', {
    interval, valueKind: 'pct', inverse: true, approx: true,
  });
  return row ? attachAlphaTrend(row, klines, { interval }) : null;
}

async function fetchUsdtDFromBinanceProxy(scaleTo) {
  const usdtMc = await fetchUsdtCircUsd();
  const [btc1h, eth1h, btc15, eth15] = await Promise.all([
    fetchKlinesClient('BTCUSDT', '1h', 160),
    fetchKlinesClient('ETHUSDT', '1h', 160),
    fetchKlinesClient('BTCUSDT', '15m', 160),
    fetchKlinesClient('ETHUSDT', '15m', 160),
  ]);
  const k1h = dominanceKlinesFromBinance(btc1h, eth1h, usdtMc, scaleTo);
  const k15 = dominanceKlinesFromBinance(btc15, eth15, usdtMc, scaleTo);
  return {
    '1h': buildUsdtDRow(k1h, '1h'),
    '15m': buildUsdtDRow(k15, '15m'),
    meta: {
      source: 'Binance BTC/ETH + Llama USDT 流通市值代理',
      scaleTo: Number.isFinite(scaleTo) ? scaleTo : null,
      bars1h: k1h.length,
      bars15: k15.length,
      usdtMc,
    },
    error: '',
  };
}

async function fetchUsdtDInBrowser() {
  const out = { '15m': null, '1h': null, meta: {}, error: '' };
  let scaleTo = null;
  try {
    const ov = await fetchJSON('/api/overview');
    scaleTo = Number(ov?.usdtDominance);
  } catch { /* ignore */ }
  if (!Number.isFinite(scaleTo)) {
    try {
      const g = await fetch('https://api.coingecko.com/api/v3/global').then((r) => r.json());
      scaleTo = Number(g?.data?.market_cap_percentage?.usdt);
    } catch { /* optional scale */ }
  }
  if (Number.isFinite(scaleTo)) out.meta.scaleTo = scaleTo;

  // 主路径：币安代理（稳定，不受 CG 429 影响）
  try {
    const proxied = await fetchUsdtDFromBinanceProxy(scaleTo);
    if (proxied['1h'] || proxied['15m']) return proxied;
    out.error = '币安代理序列不足以计算 EMA';
  } catch (err) {
    out.error = '币安/Llama 代理失败：' + (err.message || err);
  }

  // 次路径：CoinGecko 14 天市值（可能限流）
  try {
    const [t, b, e] = await Promise.all([
      fetchCgMcaps('tether', 14),
      fetchCgMcaps('bitcoin', 14),
      fetchCgMcaps('ethereum', 14),
    ]);
    const k1h = toDominanceKlines(t, b, e, INTERVAL_MS['1h'], scaleTo);
    const k15 = toDominanceKlines(t, b, e, INTERVAL_MS['15m'], scaleTo);
    out['1h'] = buildUsdtDRow(k1h, '1h');
    out['15m'] = buildUsdtDRow(k15, '15m');
    out.meta.source = 'CoinGecko market_chart 14d';
    out.meta.bars1h = k1h.length;
    out.meta.bars15 = k15.length;
    if (out['1h'] || out['15m']) out.error = '';
  } catch (err) {
    out.error = (out.error ? out.error + '；' : '') + 'CoinGecko：' + (err.message || err);
  }
  return out;
}

function boardHasClientRows(board) {
  if (!board) return false;
  return ['15m', '1h'].some((tf) => Object.values(board[tf] || {}).some((row) => row && row.lastSignal));
}

async function fetchCoinGeckoPrices() {
  try {
    let data;
    try {
      data = await fetchBinancePricesClient();
    } catch {
      const ids = Object.keys(COINGECKO_IDS).join(',');
      data = await fetchJSON(`/api/coingecko/prices?ids=${ids}`);
    }
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
    lastBtcChange = data.bitcoin?.usd_24h_change;
    if (data.xau?.usd) {
      const priceEl = document.getElementById('xauPrice');
      const changeEl = document.getElementById('xauChange');
      if (priceEl) priceEl.textContent = '$' + Number(data.xau.usd).toLocaleString('en-US', { maximumFractionDigits: 1 });
      if (changeEl && data.xau.usd_24h_change != null) {
        const ch = data.xau.usd_24h_change;
        changeEl.textContent = fmtPct(ch);
        changeEl.className = 'coin-change ' + (ch >= 0 ? 'up' : 'down');
      }
    }
    setPriceNote('');
    setPriceStamp(data.meta);
    const header = document.getElementById('lastUpdate');
    if (header && data.meta?.fetchedAt) {
      header.textContent = (data.meta.source === 'binance' ? '实时 ' : '更新于 ') + fmtTime(data.meta.fetchedAt);
    }
  } catch (e) {
    console.warn('Price fetch failed:', e.message);
    setPriceNote('实时价格暂不可用，稍后会自动重试');
  }
}

async function fetchGoldPrice() {
  try {
    const data = await fetchJSON('/api/gold/spot');
    const priceEl = document.getElementById('xauPrice');
    const changeEl = document.getElementById('xauChange');

    if (priceEl && data.spot_usd_oz && changeEl && changeEl.textContent === '') {
      priceEl.textContent = '$' + Number(data.spot_usd_oz).toLocaleString('en-US', { maximumFractionDigits: 1 });
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

function fmtMcap(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  return fmtUsd(n);
}

function emaCrossHtml(ls) {
  if (!ls) return '<span class="ema-muted">尚无穿越</span>';
  const cls = ls.dir === 'up' ? 'ema-up' : 'ema-down';
  const ago = ls.timeAgoText ? `<span class="ema-muted"> · ${ls.timeAgoText}</span>` : '';
  return `<span class="ema-cross ${cls}">${ls.label}</span>${ago}`;
}

function emaFilterText(row) {
  if (!row) return '--';
  const rsi = Number.isFinite(row.rsi6) ? row.rsi6.toFixed(0) : '--';
  const macd = row.macdAboveZero ? 'MACD>0' : 'MACD<0';
  const tagCls = row.setup === 'long' ? 'long' : row.setup === 'short' ? 'short' : 'watch';
  return `<span class="strategy-tag ${tagCls}">${row.setupLabel}</span><span class="ema-meta">${macd} · RSI6 ${rsi}</span>`;
}

function alphaHtml(at) {
  if (!at) return '<span class="strategy-tag watch">--</span>';
  const cls = at.bull ? 'long' : at.bear ? 'short' : 'watch';
  const ev = at.lastEventLabel ? `<span class="ema-meta">${at.lastEventLabel}</span>` : '';
  return `<span class="strategy-tag ${cls}">${at.stateLabel}</span>${ev}`;
}

function combinedHtml(row) {
  const c = row && row.combined;
  if (!c) return '<span class="strategy-tag watch">--</span>';
  const cls = c.dir === 'long' ? 'long' : c.dir === 'short' ? 'short' : 'watch';
  return `<span class="strategy-tag ${cls}">${c.label}</span>`;
}

function combinedDir(row) {
  const d = row && row.combined && row.combined.dir;
  return d === 'long' || d === 'short' ? d : 'watch';
}

function bbHtml(bb) {
  if (!bb) return '<span class="strategy-tag watch">--</span>';
  const cls = bb.width === 'expand'
    ? (bb.zone === 'lower' || bb.zone === 'below' ? 'short' : 'long')
    : 'watch';
  return `<span class="strategy-tag ${cls}" title="${escAttr(bb.hint || '')}">${bb.label}</span>`;
}

function bollMidHtml(bm) {
  if (!bm) return '<span class="strategy-tag watch">--</span>';
  const cls = bm.setup === 'long' ? 'long' : bm.setup === 'short' ? 'short' : 'watch';
  const last = bm.lastLabel ? `<span class="ema-meta">${bm.lastLabel}</span>` : '';
  return `<span class="strategy-tag ${cls}" title="${escAttr(bm.hint || '')}">${bm.setupLabel}</span>${last}`;
}

function macdKdjActionClass(view) {
  if (!view) return 'watch';
  if (view.action === 'entry') return 'long';
  if (view.action === 'exit' || view.action === 'overbought') return 'short';
  if (view.action === 'counter') return 'watch';
  if (view.action === 'hold' && view.bias === 'with') return 'long';
  if (view.action === 'hold' && view.bias === 'against') return 'watch';
  return 'watch';
}

function macdKdjHtml(view) {
  if (!view) return '<span class="strategy-tag watch">--</span>';
  const cls = macdKdjActionClass(view);
  const hist = Number.isFinite(view.hist) ? view.hist.toPrecision(3) : '--';
  const k = Number.isFinite(view.k) ? view.k.toFixed(0) : '--';
  const d = Number.isFinite(view.d) ? view.d.toFixed(0) : '--';
  const j = Number.isFinite(view.j) ? view.j.toFixed(0) : '--';
  const edge = view.buyEdge && view.lastBuy
    ? ` · 买 ${view.lastBuy.timeAgoText}`
    : view.sellEdge && view.lastSell
      ? ` · 卖 ${view.lastSell.timeAgoText}`
      : '';
  return `<span class="strategy-tag ${cls}" title="${escAttr(view.reason || '')}">${view.actionLabel}</span><span class="ema-meta">Hist ${hist} · KDJ ${k}/${d}/${j}${edge}</span>`;
}

function keltnerTagClass(kc) {
  if (!kc) return 'watch';
  if (kc.confidence === 'low') return 'watch';
  if (kc.dir === 'long') return 'long';
  if (kc.dir === 'short') return 'short';
  return 'watch';
}

function keltnerAdviceClass(dir) {
  if (dir === 'long') return 'long';
  if (dir === 'short') return 'short';
  if (dir === 'hold') return 'long';
  if (dir === 'exit' || dir === 'reduce' || dir === 'skip') return 'watch';
  return 'watch';
}

function keltnerSignalChips(kc) {
  if (!kc || !kc.ready) return '';
  const chips = [];
  if (kc.armLongEdge) chips.push('<span class="strategy-tag long">武装多</span>');
  if (kc.armShortEdge) chips.push('<span class="strategy-tag short">武装空</span>');
  if (kc.longEntry) chips.push('<span class="strategy-tag long">多入场</span>');
  if (kc.shortEntry) chips.push('<span class="strategy-tag short">空入场</span>');
  if (kc.longTp) chips.push('<span class="strategy-tag long">多止盈</span>');
  if (kc.shortTp) chips.push('<span class="strategy-tag short">空止盈</span>');
  if (kc.longSl) chips.push('<span class="strategy-tag watch">多止损</span>');
  if (kc.shortSl) chips.push('<span class="strategy-tag watch">空止损</span>');
  if (!chips.length && kc.signalKind === 'armed' && kc.armedLong) {
    chips.push('<span class="strategy-tag long">武装多·等入场</span>');
  }
  if (!chips.length && kc.signalKind === 'armed' && kc.armedShort) {
    chips.push('<span class="strategy-tag short">武装空·等入场</span>');
  }
  if (!chips.length && kc.signalKind === 'active' && kc.phase === 'in_long') {
    const ago = kc.lastLongEntry?.timeAgoText ? ` · ${kc.lastLongEntry.timeAgoText}` : '';
    chips.push(`<span class="strategy-tag long">多入场后未平${ago}</span>`);
  }
  if (!chips.length && kc.signalKind === 'active' && kc.phase === 'in_short') {
    const ago = kc.lastShortEntry?.timeAgoText ? ` · ${kc.lastShortEntry.timeAgoText}` : '';
    chips.push(`<span class="strategy-tag short">空入场后未平${ago}</span>`);
  }
  if (!chips.length) chips.push('<span class="strategy-tag watch">无事件</span>');
  return `<div class="kc-signals">${chips.join('')}</div>`;
}

function keltnerHtml(kc) {
  if (!kc || !kc.ready) return '<span class="strategy-tag watch">--</span>';
  const cls = keltnerTagClass(kc);
  const filter = kc.filterAdx && kc.filterTf
    ? `过滤 ${kc.filterTf} ADX${kc.filterAdx.adx.toFixed(0)} ${kc.filterAdx.regimeLabel}`
    : (kc.adx && Number.isFinite(kc.adx.adx)
      ? `ADX${kc.adx.adx.toFixed(0)} ${kc.adx.regimeLabel}`
      : 'ADX--');
  const local = kc.localAdx && kc.filterTf
    ? `本周期 ${kc.localAdx.adx.toFixed(0)} ${kc.localAdx.regimeLabel}`
    : '';
  const bg = kc.bgAdx && kc.bgTf
    ? `背景 ${kc.bgTf} ADX${kc.bgAdx.adx.toFixed(0)} ${kc.bgAdx.regimeLabel}`
    : '';
  const mid = Number.isFinite(kc.midline) ? fmtBand(kc.midline) : '--';
  const ou = Number.isFinite(kc.outerUpper) ? fmtBand(kc.outerUpper) : '--';
  const ol = Number.isFinite(kc.outerLower) ? fmtBand(kc.outerLower) : '--';
  const iu = Number.isFinite(kc.innerUpper) ? fmtBand(kc.innerUpper) : '--';
  const il = Number.isFinite(kc.innerLower) ? fmtBand(kc.innerLower) : '--';
  const adxTitle = [filter, local, bg].filter(Boolean).join(' · ');
  // 信息保留：主行看事件+状态；ADX/轨道放次行（不删）
  const advice = kc.advice
    ? `<div class="ema-hint kc-advice"><span class="strategy-tag ${keltnerAdviceClass(kc.adviceDir)}">建议</span> ${kc.advice}</div>`
    : '';
  return `${keltnerSignalChips(kc)}
    <div class="kc-main"><span class="strategy-tag ${cls}" title="${escAttr(kc.hint || '')}">${kc.stateLabel}</span></div>
    <div class="ema-meta kc-meta" title="${escAttr(adxTitle)}">${filter}${local ? ' · ' + local : ''}${bg ? ' · ' + bg : ''}</div>
    <div class="ema-meta kc-meta">中 ${mid} · 内 ${il}/${iu} · 外 ${ol}/${ou}</div>
    ${advice}`;
}

function sparklineSvg(values, tone = 'up') {
  const pts = (values || []).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return '';
  const w = 72;
  const h = 22;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const path = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 2) - 1;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const stroke = tone === 'down' ? '#f85149' : '#3fb950';
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.5" /></svg>`;
}

function macdKdjBgHtml(board, coin) {
  const h4 = board && board['4h'] && board['4h'][coin];
  const d1 = board && board['1d'] && board['1d'][coin];
  const c4 = !h4 ? 'watch' : h4.overbought ? 'short' : h4.macdBull ? 'long' : 'watch';
  const c1 = !d1 ? 'watch' : d1.overbought ? 'short' : d1.macdBull ? 'long' : 'watch';
  const label4 = !h4
    ? '4h 背景未就绪'
    : `${h4.overbought ? '4h 超买' : h4.macdBull ? '4h 多头' : '4h 空头'} · Hist ${Number.isFinite(h4.hist) ? h4.hist.toPrecision(3) : '--'} · KDJ ${Number.isFinite(h4.k) ? h4.k.toFixed(0) : '--'}/${Number.isFinite(h4.d) ? h4.d.toFixed(0) : '--'}/${Number.isFinite(h4.j) ? h4.j.toFixed(0) : '--'}`;
  const label1 = !d1
    ? '1d 背景未就绪'
    : `${d1.overbought ? '1d 超买' : d1.macdBull ? '1d 多头' : '1d 空头'} · ${d1.overbought && d1.macdBull ? '日线多头但KDJ超买' : d1.macdBull ? '日线多头环境' : '日线非多头环境'}`;
  return `<div class="ema-chip-row" aria-label="大周期背景">
    <span class="ema-chip-label">背景</span>
    <span class="ema-chip ${c4}" title="4h 作顺势/逆势过滤">${label4}</span>
    <span class="ema-chip ${c1}" title="1d 只作文案环境，不当日内出场">${label1}</span>
  </div>`;
}

function fmtBand(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function bbRailsHtml(bb) {
  if (!bb) return '';
  return `<div class="bb-rails">
    <span class="rail-up">上 ${fmtBand(bb.upper)}</span>
    <span class="rail-mid">中 ${fmtBand(bb.mid)}</span>
    <span class="rail-dn">下 ${fmtBand(bb.lower)}</span>
    <span class="rail-pb">%B ${Number.isFinite(bb.pctB) ? bb.pctB.toFixed(2) : '--'}</span>
  </div>`;
}

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function emaMetric(label, valueHtml) {
  return `<div class="ema-metric"><span class="ema-metric-k">${label}</span><span class="ema-metric-v">${valueHtml}</span></div>`;
}

function renderEmaTfCol(tf, row) {
  if (!row || !row.lastSignal) {
    return `<div class="ema-tf-col is-empty"><div class="ema-tf-head"><span class="ema-tf">${tf}</span></div><div class="ema-empty">K线未返回</div></div>`;
  }
  const ls = row.lastSignal;
  const c = row.combined;
  const mk = row.macdKdjView || row.macdKdj;
  const kc = row.keltner;
  const dir = combinedDir(row);
  const reason = c && c.reason ? `<div class="ema-hint">${c.reason}</div>` : '';
  const mkHint = mk && mk.reason ? `<div class="ema-hint">${mk.reason}</div>` : '';
  const bbHint = row.bb && row.bb.hint ? `<div class="ema-hint">${row.bb.hint}</div>` : '';
  const midHint = row.bollMid && row.bollMid.hint ? `<div class="ema-hint">${row.bollMid.hint}</div>` : '';
  // KC 建议已在 keltnerHtml 内完整展示，避免再重复贴一遍 hint
  return `<div class="ema-tf-col dir-${dir}">
    <div class="ema-tf-head">
      <span class="ema-tf">${tf}</span>
      ${combinedHtml(row)}
    </div>
    ${reason}
    <div class="ema-metrics">
      ${emaMetric('穿越', emaCrossHtml(ls))}
      ${emaMetric('过滤', emaFilterText(row))}
      ${emaMetric('AT', alphaHtml(row.alpha))}
      ${emaMetric('布林', bbHtml(row.bb))}
      ${row.bb ? emaMetric('轨道', bbRailsHtml(row.bb)) : ''}
      ${emaMetric('中轴', bollMidHtml(row.bollMid))}
      ${emaMetric('MK', macdKdjHtml(mk))}
      ${emaMetric('KC', keltnerHtml(kc))}
    </div>
    ${mkHint}${bbHint}${midHint}
  </div>`;
}

function renderEmaCards(data) {
  const box = document.getElementById('emaCards');
  if (!box) return;
  const coins = Object.keys(STRATEGY_SYMBOLS);
  box.innerHTML = coins.map((coin) => {
    const r15 = data && data['15m'] && data['15m'][coin];
    const r1h = data && data['1h'] && data['1h'][coin];
    const px = (r15 && r15.priceText) || (r1h && r1h.priceText) || '';
    const d15 = combinedDir(r15);
    const d1h = combinedDir(r1h);
    const accent = d15 === d1h && d15 !== 'watch' ? d15 : (d1h !== 'watch' ? d1h : d15);
    const spark = sparklineSvg((r1h && r1h.spark) || (r15 && r15.spark), accent === 'short' ? 'down' : 'up');
    return `<article class="ema-coin-card accent-${accent}">
      <div class="ema-coin-head">
        <div class="ema-coin-id">
          <h3>${coin}</h3>
          <div class="ema-coin-price-row">
            ${px ? `<div class="ema-coin-price">${px}</div>` : ''}
            ${spark}
          </div>
        </div>
        <div class="ema-summary">
          <div class="ema-summary-item"><span class="ema-tf">15m</span>${combinedHtml(r15)}</div>
          <div class="ema-summary-item"><span class="ema-tf">1h</span>${combinedHtml(r1h)}</div>
        </div>
      </div>
      ${macdKdjBgHtml(data, coin)}
      <div class="ema-tf-cols">
        ${renderEmaTfCol('15m', r15)}
        ${renderEmaTfCol('1h', r1h)}
      </div>
    </article>`;
  }).join('');
}

let paintBoardTimer = null;
let paintNotifyAfter = false;

function paintEmaBoard(data, opts = {}) {
  if (data) enrichBoardMacdKdj(data);
  lastEmaBoard = data;
  if (opts.notify) paintNotifyAfter = true;

  const flush = () => {
    paintBoardTimer = null;
    const board = lastEmaBoard;
    renderEmaCards(board);
    renderShortSignalCards();
    renderUsdtDBox(board && board.usdtD);
    if (opts.immediateNotify || paintNotifyAfter) {
      processEmaNotifications(board);
      paintNotifyAfter = false;
    }
  };

  if (opts.immediate) {
    if (paintBoardTimer) {
      clearTimeout(paintBoardTimer);
      paintBoardTimer = null;
    }
    flush();
    return;
  }
  if (paintBoardTimer) return;
  paintBoardTimer = setTimeout(flush, 400);
}

function renderUsdtDBox(usdtD) {
  const el = document.getElementById('usdtDBox');
  if (!el) return;
  if (!usdtD || (!usdtD['1h'] && !usdtD['15m'])) {
    el.innerHTML = `<h3>USDT.D EMA</h3>
      <div class="usdt-d-note">暂无可用序列（CoinGecko 限流、采样过短或对齐失败）。已改为优先用 14 天市值序列重采样；可点刷新重试。USDT.D 与 BTC/ETH 多为反向。</div>`;
    return;
  }
  const meta = usdtD.meta || {};
  const cards = ['1h', '15m'].map((tf) => {
    const row = usdtD[tf];
    if (!row) {
      return `<div class="usdt-d-card">
        <div class="usdt-d-tf">${tf}</div>
        <div class="usdt-d-empty">本周期暂无（通常是采样点 &lt; 80 根，稍后重试）</div>
      </div>`;
    }
    const ls = row.lastSignal;
    const comb = row.combined;
    const spark = sparklineSvg(row.spark, comb && comb.dir === 'short' ? 'down' : 'up');
    return `<div class="usdt-d-card">
      <div class="usdt-d-card-h">
        <span class="usdt-d-tf">${tf}</span>
        ${spark}
        <span class="usdt-d-px">${row.priceText || '--'}</span>
      </div>
      <div class="usdt-d-line">${row.trendLabel || '--'} · ${ls ? ls.label + ' ' + (ls.timeAgoText || '') : '尚无穿越'}</div>
      <div class="usdt-d-line">过滤 ${emaFilterText(row)}</div>
      <div class="usdt-d-line">AT ${alphaHtml(row.alpha)} · 合成 ${combinedHtml(row)}</div>
      <div class="usdt-d-line bias">${row.cryptoBiasLabel || '偏多/偏空待定（看穿越方向）'}</div>
      ${comb && comb.reason ? `<div class="usdt-d-hint">${comb.reason}</div>` : ''}
    </div>`;
  }).join('');
  el.innerHTML = `
    <h3>USDT.D（稳定币市值占比）短线分析</h3>
    <div class="usdt-d-grid">${cards}</div>
    <div class="usdt-d-note">
      币安无 USDT.D 合约：用 Tether/(BTC+ETH+USDT) 市值比代理${Number.isFinite(meta.scaleTo) ? `，并校准到全球占比 ${Number(meta.scaleTo).toFixed(2)}%` : ''}。
      上穿 EMA56 ≈ 资金进稳定币（对风险资产偏空）；下穿相反。
      ${meta.source ? `数据源：${meta.source}` : ''}
      ${meta.bars1h != null ? `· 1h ${meta.bars1h} 根` : ''}
      ${meta.bars15 != null ? `· 15m ${meta.bars15} 根` : ''}
      ${usdtD.error ? `· 备注：${usdtD.error}` : ''}
    </div>
  `;
}

function emaBoardFilled(data) {
  if (!data) return 0;
  let n = 0;
  for (const tf of ['15m', '1h']) {
    for (const row of Object.values(data[tf] || {})) {
      if (row && row.lastSignal) n += 1;
    }
  }
  return n;
}

function setEmaNote(data) {
  const note = document.getElementById('emaBoardNote');
  if (!note) return;
  const filled = emaBoardFilled(data);
  const src = data && data.cached && data.source === 'browser'
    ? '本地缓存 · 后台刷新币安'
    : data && data.source === 'browser' ? '浏览器直连币安'
    : data && data.source === 'live' ? 'Worker 拉取'
    : data && data.source === 'snapshot' ? '扫描快照'
    : '无K线';
  const when = data && data.fetchedAt ? fmtTime(data.fetchedAt) : '';
  const err = Array.isArray(data && data.errors) && data.errors.length
    ? data.errors.slice(0, 3).join('；')
    : '';
  note.textContent = filled
    ? `${src} ${when}`
    : `K线拉取失败${err ? '：' + err : '。Worker 访问币安被拦时，等 GitHub Actions 扫描写入后再刷新。'}`;
}

async function loadUsdtD(board, force) {
  if (!force) {
    const hit = lsGet(LS_USDTD, USDTD_TTL_MS);
    if (hit && (hit['1h'] || hit['15m'])) {
      board.usdtD = hit;
      renderUsdtDBox(hit);
      return;
    }
  }

  // 1) 优先 Worker（服务端拉 CG，不受浏览器 CORS/限流影响）
  try {
    const snap = await fetchJSON('/api/ema-strategy');
    if (snap && snap.usdtD && (snap.usdtD['1h'] || snap.usdtD['15m'])) {
      const data = {
        ...snap.usdtD,
        meta: { ...(snap.usdtD.meta || {}), source: snap.source ? `Worker(${snap.source})` : 'Worker' },
      };
      board.usdtD = data;
      lsSet(LS_USDTD, data);
      renderUsdtDBox(data);
      return;
    }
  } catch (e) {
    console.warn('USDT.D worker fallback miss', e.message || e);
  }

  // 2) 浏览器直连 CG（可能限流/失败）
  try {
    const data = await fetchUsdtDInBrowser();
    board.usdtD = data;
    if (data && (data['1h'] || data['15m'])) lsSet(LS_USDTD, data);
    renderUsdtDBox(data);
  } catch (e) {
    board.errors.push('USDT.D: ' + (e.message || e));
    if (!board.usdtD || (!board.usdtD['1h'] && !board.usdtD['15m'])) renderUsdtDBox(null);
  }
}

async function loadEmaStrategy(force = false) {
  const note = document.getElementById('emaBoardNote');
  const board = emptyBoard();
  const cachedHits = hydrateBoardFromCache(board);
  if (cachedHits) {
    paintEmaBoard(board, { immediate: true, notify: true });
    setEmaNote(board);
  }

  try {
    const execJobs = EXEC_INTERVALS.flatMap((interval) =>
      Object.entries(STRATEGY_SYMBOLS).map(async ([coin, symbol]) => {
        try {
          const klines = await getKlinesCached(symbol, interval, force);
          const row = rowFromKlines(klines, coin, interval);
          board[interval][coin] = row;
          if (!row) board.errors.push(coin + ' ' + interval + ': 指标不足');
          board.cached = false;
          board.fetchedAt = Date.now();
          paintEmaBoard(board); // 节流中间态，不每次推通知
        } catch (e) {
          if (!board[interval][coin]) {
            board[interval][coin] = null;
            board.errors.push(coin + ' ' + interval + ': ' + (e.message || e));
          }
        }
      }),
    );
    const htfJobs = HTF_INTERVALS.flatMap((interval) =>
      Object.entries(STRATEGY_SYMBOLS).map(async ([coin, symbol]) => {
        try {
          // 4h/1d 用不那么长的序列即可
          const klines = await getKlinesCached(symbol, interval, force, interval === '1d' ? 120 : 140);
          const mk = macdKdjFromKlines(klines, coin, interval);
          board[interval][coin] = mk;
          if (!mk) board.errors.push(coin + ' ' + interval + ': MACD+KDJ 不足');
          if (interval === '4h') {
            const adx = evaluateAdx(klines, { interval: '4h' });
            if (adx) board.adx4h[coin] = adx;
          }
          board.cached = false;
          board.fetchedAt = Date.now();
          paintEmaBoard(board);
        } catch (e) {
          if (!board[interval][coin]) {
            board[interval][coin] = null;
            board.errors.push(coin + ' ' + interval + ': ' + (e.message || e));
          }
        }
      }),
    );
    await Promise.all([...execJobs, ...htfJobs]);
    paintEmaBoard(board, { immediate: true, notify: true });

    if (!boardHasClientRows(board)) {
      try {
        const fallback = await fetchJSON('/api/ema-strategy');
        paintEmaBoard(fallback, { immediate: true, notify: true });
        setEmaNote(fallback);
      } catch (e) {
        console.warn('browser klines fallback to worker', e.message);
        setEmaNote(board);
      }
    } else {
      setEmaNote(board);
    }
  } catch (e) {
    console.warn('EMA strategy fetch failed:', e.message);
    const box = document.getElementById('emaCards');
    if (box && !cachedHits) box.innerHTML = '<div class="empty">EMA 策略接口失败，稍后重试</div>';
    if (note) note.textContent = e.message || 'fetch failed';
  }

  loadUsdtD(board, force);
}

async function fetchOverview() {
  try {
    const ov = await fetchJSON('/api/overview');
    const usdt = ov.usdtDominance;
    const delta = ov.usdtDelta;
    const pct = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) + '%' : '--');
    const deltaText = Number.isFinite(delta)
      ? `<span class="coin-change ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}</span>`
      : '';
    const hint = ov.inverse?.text || 'USDT.D 与 BTC/ETH 多为反向';
    document.getElementById('marketStats').innerHTML = `
      <span class="stat">总市值 ${fmtMcap(ov.totalMcap)}</span>
      <span class="stat">BTC.D ${pct(ov.btcDominance)}</span>
      <span class="stat">ETH.D ${pct(ov.ethDominance)}</span>
      <span class="stat stat-usdt">USDT.D ${pct(usdt)} ${deltaText}</span>
      <span class="stat stat-hint">${hint}</span>
    `;
  } catch (e) {
    console.warn('Overview fetch failed:', e.message);
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

let lastShortSignals = [];
let lastEmaBoard = null;

function stratKeyFromCoin(coin) {
  if (!coin) return '';
  if (String(coin).indexOf('XAU') === 0) return 'XAU';
  return coin;
}

function scBlock(title, body) {
  if (!body) return '';
  return `<div class="sc-block"><div class="sc-block-h">${title}</div><div class="sc-block-b">${body}</div></div>`;
}

function clientEssayHtml(tfLabel, ema, s1, r1) {
  if (!ema) {
    return scBlock('状态', `${tfLabel} K 线还没到位。先按现价观察，支撑看 ${s1 || '--'}，阻力看 ${r1 || '--'}，不要追单。`);
  }
  const ls = ema.lastSignal;
  let cross = '未见有效的 EMA7 穿越 EMA56。';
  if (ls) {
    cross = ls.held
      ? `EMA7 相对 EMA56 处于「${ls.label}」（${ls.timeAgoText}），价格仍在分界线${ls.dir === 'up' ? '上方' : '下方'}。`
      : `最近一次信号是 ${ls.label}，发生在${ls.timeAgoText}，当时价 ${ls.priceText}。`;
  }
  const macd = ema.macdAboveZero ? 'MACD 在 0 轴上方，多头动能还在。' : 'MACD 在 0 轴下方，空头动能占优。';
  let rsi = 'RSI 数据不足。';
  if (Number.isFinite(Number(ema.rsi6))) {
    const v = Number(ema.rsi6);
    if (v >= 70) rsi = `RSI6 在 ${v.toFixed(0)}，短线超买，不宜追多。`;
    else if (v >= 65) rsi = `RSI6 在 ${v.toFixed(0)}，接近超买，多单要等回踩。`;
    else if (v <= 30) rsi = `RSI6 在 ${v.toFixed(0)}，短线超卖，不宜追空。`;
    else if (v <= 35) rsi = `RSI6 在 ${v.toFixed(0)}，动能偏低，空单需谨慎。`;
    else rsi = `RSI6 在 ${v.toFixed(0)}，未到极端区。`;
  }
  const align = ema.trendLabel || '均线纠缠';
  let action;
  if (ema.setup === 'long') {
    action = `开仓过滤已满足，可在 ${s1} 一带轻仓试多，止损参考 ${ema.stopText}，第一目标 ${r1}，延伸 ${ema.tpText}。`;
  } else if (ema.setup === 'short') {
    action = `开仓过滤已满足，反弹 ${r1} 遇阻可轻仓试空，止损参考 ${ema.stopText}，目标看 ${s1} / ${ema.tpText}。`;
  } else {
    action = `穿越、MACD 同向、RSI 不极端尚未同时成立，这个周期先观望：多等回踩 ${s1}，空等反抽 ${r1}。`;
  }

  const at = ema.alpha;
  const bb = ema.bb;
  const bm = ema.bollMid;
  const mk = ema.macdKdjView || ema.macdKdj;
  const kc = ema.keltner;
  const comb = ema.combined;

  // 信息完整保留；顺序改成先看结论/事件，细节在后，减少「读完才知道怎么做」
  const parts = [];
  if (comb) {
    parts.push(scBlock('合成', `<span class="strategy-tag ${comb.dir === 'long' ? 'long' : comb.dir === 'short' ? 'short' : 'watch'}">${comb.label}</span> ${comb.reason || ''}`));
  }
  parts.push(scBlock('操作', action));
  if (mk) {
    const mkLabel = mk.actionLabel || mk.stateLabel || '观望';
    parts.push(scBlock('MK', `${mkLabel}${mk.reason ? '。' + mk.reason : ''}`));
  }
  if (kc && kc.ready) {
    const sig = kc.signalKind === 'arm' || kc.armLongEdge || kc.armShortEdge
      ? '当前事件：武装'
      : kc.signalKind === 'entry' || kc.longEntry || kc.shortEntry
        ? '当前事件：入场'
        : kc.signalKind === 'tp'
          ? '当前事件：止盈'
          : kc.signalKind === 'sl'
            ? '当前事件：止损'
            : kc.signalKind === 'active'
              ? '当前：入场后未平（非账户持仓）'
              : kc.signalKind === 'armed'
                ? '当前：武装中·等入场'
                : '当前：无事件';
    parts.push(scBlock('KC', `<div>${sig} · ${kc.stateLabel}</div><div>${kc.advice || ''}</div><div class="sc-block-meta">${kc.regimeNote || ''}</div>`));
  }
  parts.push(scBlock('趋势', `${tfLabel}目前是${align}。${cross}`));
  parts.push(scBlock('过滤', `${macd}${rsi}`));
  if (at) {
    parts.push(scBlock('AT', `AlphaTrend ${at.stateLabel}${at.lastEventLabel ? '，' + at.lastEventLabel : ''}。`));
  }
  if (bb) {
    parts.push(scBlock('布林', `${bb.widthLabel}，价格${bb.zoneLabel}（%B ${Number.isFinite(bb.pctB) ? bb.pctB.toFixed(2) : '--'}）。${bb.hint || ''}`));
  }
  if (bm) {
    parts.push(scBlock('中轴', bm.hint || bm.setupLabel || '--'));
  }
  return parts.join('');
}

function renderShortSignalCards() {
  const box = document.getElementById('signalList');
  if (!box) return;
  const signals = lastShortSignals;
  if (!signals.length) {
    box.innerHTML = '<div class="empty">等待价格快照后生成点位</div>';
    return;
  }
  const sigColors = { amber: 'sig-amber', blue: 'sig-blue', gray: 'sig-gray' };
  box.innerHTML = signals.map(s => {
    const k = stratKeyFromCoin(s.coin);
    const e15 = (lastEmaBoard && lastEmaBoard['15m'] && lastEmaBoard['15m'][k]) || s.ema15;
    const e1h = (lastEmaBoard && lastEmaBoard['1h'] && lastEmaBoard['1h'][k]) || s.ema1h;
    const s1 = (s.support || '').split(' -> ')[0];
    const r1 = (s.resistance || '').split(' -> ')[0];
    const a15 = clientEssayHtml('15 分钟', e15, s1, r1);
    const a1h = clientEssayHtml('1 小时', e1h, s1, r1);
    const chClass = Number(s.change24h) >= 0 ? 'up' : 'down';
    const ls15 = e15 && e15.lastSignal;
    const ls1h = e1h && e1h.lastSignal;
    return `
      <div class="signal-card ${sigColors[s.color] || ''}">
        <div class="sc-top">
          <div>
            <div class="sc-name">${s.coin}</div>
            <div class="sc-bias">${s.bias || ''}</div>
          </div>
          <div class="sc-px">
            <div class="sc-price">${s.priceText || '--'}</div>
            <div class="sc-chg ${chClass}">${s.changeText || ''}</div>
          </div>
        </div>
        <div class="sc-sr">
          <div class="sc-sr-item"><span>支撑</span>${s.support || '--'}</div>
          <div class="sc-sr-item"><span>阻力</span>${s.resistance || '--'}</div>
        </div>
        <div class="sc-play">
          <div class="sc-kicker">操作要点</div>
          ${s.strategy || ''}
        </div>
        <div class="sc-tf-grid">
          <div class="sc-tf">
            <div class="sc-tf-h"><span class="ema-tf">15m</span>${emaCrossHtml(ls15)}</div>
            <div class="sc-essay">${a15}</div>
          </div>
          <div class="sc-tf">
            <div class="sc-tf-h"><span class="ema-tf">1h</span>${emaCrossHtml(ls1h)}</div>
            <div class="sc-essay">${a1h}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function loadMarketSignals() {
  try {
    const data = await fetchJSON('/api/market-signals');
    lastShortSignals = data.tradingSignals || [];
    renderShortSignalCards();

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

function refreshAll(force = false) {
  fetchCoinGeckoPrices();
  loadEmaStrategy(force);
  fetchGoldPrice();
  fetchOverview();
  loadValuescanData();
  loadMarketSignals();
  loadOwnSignals();
  loadReversalSignals();
  loadBottomReversalSignals();
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  lastSignalData = null; // 强制刷新信号
  refreshAll(true);
});

initEmaNotifyUi();
refreshAll();
setInterval(fetchCoinGeckoPrices, 30000);
setInterval(fetchGoldPrice, 60000);
setInterval(fetchOverview, 60000);
setInterval(() => loadEmaStrategy(false), 60000);
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
