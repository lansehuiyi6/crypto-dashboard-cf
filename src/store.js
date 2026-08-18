import {
  fetchTopCoinsPage,
  fetchCoinHistory,
  generateCoinSignal,
  generateTrendingSignals,
} from './signal-engine.js';
import { emptyHistory, enrichWithLifecycle, EXPIRE_HOURS } from './signal-tracker.js';
import { applyFilter, SIGNAL_TYPE_RANGES } from './filters.js';

const VS_PAGE_URL = 'https://www.valuescan.io';

// 免费档：单次 10ms CPU / 50 子请求。每次 tick 只做一小段。
const SIGNALS_TTL_MS = 10 * 60 * 1000;
const TRENDING_TTL_MS = 10 * 60 * 1000;
const JOB_STALE_MS = 8 * 60 * 1000;
const ALARM_GAP_MS = 2000;
const RETRY_GAP_MS = 5000;
const MARKET_PAGES = 5;
const COINS_PER_PAGE = 50;
const SCORE_BATCH = 25;
const HISTORY_BATCH = 4;
const HISTORY_LIMIT = 50;
const PERSIST_BATCH = 25;
const STAGE_BATCH = 25;
const MAX_CHUNK_FAILURES = 3;
const MAX_HISTORY_POINTS = 50;

const WORKER_SCAN_PHASES = new Set([
  'markets', 'valuescan', 'score', 'history', 'persist', 'stages', 'trending', 'publish',
]);

const PHASE_LABELS = {
  markets: '拉取行情',
  valuescan: '拉取资金异动',
  score: '计算评分',
  history: '拉取 K 线',
  persist: '写入历史',
  stages: '计算生命周期',
  trending: '热门代币',
  publish: '发布结果',
  done: '完成',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function emptySummary() {
  return {
    totalScanned: 0,
    totalSignals: 0,
    strongBuy: 0,
    buy: 0,
    watch: 0,
    neutral: 0,
    caution: 0,
    riskAlert: 0,
    fomoCount: 0,
    fundMovementBullish: 0,
    fundMovementBearish: 0,
    reversalCount: 0,
    bottomReversalCount: 0,
    generatedAt: null,
  };
}

function emptyJob() {
  return {
    phase: 'markets',
    page: 1,
    scoreIndex: 0,
    historyIndex: 0,
    persistIndex: 0,
    stageIndex: 0,
    scanCounted: false,
    failCount: 0,
    startedAt: Date.now(),
    summary: emptySummary(),
  };
}

function emptyHistMeta() {
  return { scanCount: 0, lastUpdated: null, symbols: {} };
}

function trackOne(existing, sig, now) {
  if (existing) {
    existing.lastSeenAt = now;
    existing.lastScore = sig.scores.composite;
    existing.lastPrice = sig.price;
    existing.lastSignal = sig.signal.labelCn;
    if (!existing.scoreHistory) existing.scoreHistory = [];
    existing.scoreHistory.push({ t: now, score: sig.scores.composite, price: sig.price });
    if (existing.scoreHistory.length > MAX_HISTORY_POINTS) {
      existing.scoreHistory = existing.scoreHistory.slice(-MAX_HISTORY_POINTS);
    }
    if (sig.scores.composite > (existing.peakScore || 0)) {
      existing.peakScore = sig.scores.composite;
      existing.peakTime = now;
      existing.peakPrice = sig.price;
    }
    if (sig.scores.composite < (existing.troughScore || 100)) {
      existing.troughScore = sig.scores.composite;
      existing.troughTime = now;
    }
    return existing;
  }
  return {
    symbol: sig.symbol,
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
  };
}

export class SignalStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      const job = this.getValue('job');
      if (job && WORKER_SCAN_PHASES.has(job.phase)) {
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm == null) await this.ctx.storage.setAlarm(Date.now() + ALARM_GAP_MS);
      }
    });
  }

  ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS raw_coins (
        idx INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scan_sig (
        symbol TEXT PRIMARY KEY,
        score INTEGER,
        fomo INTEGER,
        fund_type TEXT,
        has_reversal INTEGER,
        has_bottom INTEGER,
        combined_stage TEXT,
        tech_stage TEXT,
        magnitude_stage TEXT,
        payload TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scan_sig_next (
        symbol TEXT PRIMARY KEY,
        score INTEGER,
        fomo INTEGER,
        fund_type TEXT,
        has_reversal INTEGER,
        has_bottom INTEGER,
        combined_stage TEXT,
        tech_stage TEXT,
        magnitude_stage TEXT,
        payload TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sig_hist (
        symbol TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
  }

  getValue(key) {
    const row = this.ctx.storage.sql.exec(
      'SELECT value FROM kv WHERE key = ?',
      key,
    ).toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  putValue(key, value) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
      key,
      JSON.stringify(value),
    );
  }

  countTable(table) {
    const row = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0];
    return row ? Number(row.n) : 0;
  }

  upsertScanNext(sig) {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO scan_sig_next
        (symbol, score, fomo, fund_type, has_reversal, has_bottom, combined_stage, tech_stage, magnitude_stage, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sig.symbol,
      sig.scores.composite,
      sig.fomo?.fomo ? 1 : 0,
      sig.fundMovement?.type || 'none',
      sig.reversal ? 1 : 0,
      sig.bottomReversal ? 1 : 0,
      sig.lifecycle?.combinedStage || '',
      sig.lifecycle?.techStage || '',
      sig.lifecycle?.magnitudeStage || '',
      JSON.stringify(sig),
    );
  }

  progressOf(job) {
    const total =
      MARKET_PAGES + 1 +
      Math.ceil((MARKET_PAGES * COINS_PER_PAGE) / SCORE_BATCH) +
      Math.ceil(HISTORY_LIMIT / HISTORY_BATCH) +
      Math.ceil((MARKET_PAGES * COINS_PER_PAGE) / PERSIST_BATCH) +
      Math.ceil((MARKET_PAGES * COINS_PER_PAGE) / STAGE_BATCH) +
      2;
    let done = 0;
    if (job.phase === 'markets') done = job.page - 1;
    else if (job.phase === 'valuescan') done = MARKET_PAGES;
    else if (job.phase === 'score') done = MARKET_PAGES + 1 + Math.floor(job.scoreIndex / SCORE_BATCH);
    else if (job.phase === 'history') done = MARKET_PAGES + 1 + Math.ceil((MARKET_PAGES * COINS_PER_PAGE) / SCORE_BATCH) + Math.floor(job.historyIndex / HISTORY_BATCH);
    else if (job.phase === 'persist') done = total - 4;
    else if (job.phase === 'stages') done = total - 3;
    else if (job.phase === 'trending') done = total - 2;
    else if (job.phase === 'publish') done = total - 1;
    else done = total;
    return {
      phase: job.phase,
      label: `${PHASE_LABELS[job.phase] || job.phase} (${Math.min(done, total)}/${total})`,
      done,
      total,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/signals') return this.handleSignals(url);
    if (path === '/history') return json(this.getCachedStats());
    if (path === '/trending') return this.handleTrending();
    if (path === '/tick') return this.handleTick();
    if (path === '/snapshot') return this.handleSnapshot();
    if (path === '/ingest') return this.handleIngest(request);
    return json({ error: 'not found' }, 404);
  }

  nextAlarmDelay(result) {
    if (!result.continue) return 0;
    return result.ok === false ? RETRY_GAP_MS : ALARM_GAP_MS;
  }

  async alarm() {
    const result = await this.runTick();
    const delay = this.nextAlarmDelay(result);
    if (delay) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async handleTick() {
    const result = await this.runTick();
    const delay = this.nextAlarmDelay(result);
    if (delay) await this.ctx.storage.setAlarm(Date.now() + delay);
    return json(result);
  }

  handleSignals(url) {
    const filter = url.searchParams.get('filter') || 'all';
    const minScore = parseInt(url.searchParams.get('minScore') || '0', 10);
    const stage = url.searchParams.get('stage') || '';
    const signalType = url.searchParams.get('signalType') || '';

    const job = this.getValue('job');
    const scanning = !!(job && job.phase !== 'done');
    const meta = this.getValue('scan_meta');
    const published = this.countTable('scan_sig');

    if (!published) {
      const jobRunning = !!(job && job.phase !== 'done');
      return json({
        scanning: true,
        progress: jobRunning
          ? this.progressOf(job)
          : { phase: 'idle', label: '等待 GitHub Actions 定时扫描（约每 15 分钟）', done: 0, total: 1 },
        cached: false,
        signals: [],
        summary: null,
        historyStats: this.getCachedStats(),
      });
    }

    const rows = this.queryPublished(filter, minScore, stage, signalType);
    const signals = rows.map((r) => JSON.parse(r.payload));
    const hist = this.loadHistSlice(signals.map((s) => s.symbol));
    const vsAlertMap = this.getValue('vs_alert') || {};
    const enriched = enrichWithLifecycle(signals, vsAlertMap, hist);
    const filtered = applyFilter(enriched, filter, minScore, stage, signalType);

    return json({
      summary: meta?.summary || null,
      signals: filtered,
      historyStats: this.getCachedStats(),
      cached: !scanning,
      cachedAt: meta?.timestamp ? new Date(meta.timestamp).toISOString() : null,
      scanning,
      progress: scanning && job ? this.progressOf(job) : null,
    });
  }

  queryPublished(filter, minScore, stage, signalType) {
    let where = '1=1';
    if (filter === 'bullish') where += ' AND score >= 55';
    else if (filter === 'bearish') where += ' AND score <= 45';
    else if (filter === 'fomo') where += ' AND fomo = 1';
    else if (filter === 'fundMovement') where += " AND fund_type != 'none'";
    else if (filter === 'reversal') where += ' AND has_reversal = 1';
    else if (filter === 'bottomReversal') where += ' AND has_bottom = 1';

    if (minScore > 0) where += ` AND score >= ${Number(minScore) || 0}`;

    if (signalType && SIGNAL_TYPE_RANGES[signalType]) {
      const range = SIGNAL_TYPE_RANGES[signalType];
      where += ` AND score >= ${range.min} AND score <= ${range.max}`;
    }

    if (stage === 'emerging') {
      where += " AND (combined_stage IN ('emerging','reaccelerating') OR tech_stage = 'accelerating')";
    } else if (stage === 'fading') {
      where += " AND (combined_stage IN ('fading','mature') OR tech_stage IN ('fading','decelerating'))";
    } else if (stage === 'reversing') {
      where += " AND (combined_stage = 'reversing' OR tech_stage IN ('reversing','reversing_up'))";
    } else if (stage === 'extended') {
      where += " AND (combined_stage = 'extended' OR magnitude_stage = 'extended')";
    } else if (stage === 'exhaustion') {
      where += " AND (combined_stage = 'exhaustion' OR magnitude_stage = 'exhaustion')";
    } else if (stage) {
      where += ` AND combined_stage = '${stage.replace(/[^a-zA-Z0-9_]/g, '')}'`;
    }

    const order = (filter === 'bearish')
      ? 'score ASC'
      : (filter === 'reversal' || filter === 'bottomReversal')
        ? 'score DESC'
        : 'score DESC';

    return this.ctx.storage.sql.exec(
      `SELECT payload FROM scan_sig WHERE ${where} ORDER BY ${order} LIMIT 50`,
    ).toArray();
  }

  loadHistSlice(symbols) {
    const history = emptyHistory();
    for (const symbol of symbols) {
      if (!symbol) continue;
      const row = this.ctx.storage.sql.exec(
        'SELECT payload FROM sig_hist WHERE symbol = ?',
        symbol,
      ).toArray()[0];
      if (row) {
        try {
          history.signals[symbol] = JSON.parse(row.payload);
        } catch { /* skip */ }
      }
    }
    return history;
  }

  getCachedStats() {
    return this.getValue('history_stats') || {
      totalTracked: 0,
      scanCount: 0,
      lastUpdated: null,
      stageStats: {
        emerging: 0, accelerating: 0, active: 0, peaking: 0,
        fading: 0, mature: 0, extended: 0, exhaustion: 0,
      },
      newestSignals: [],
    };
  }

  handleTrending() {
    const cache = this.getValue('trending');
    if (cache?.data) {
      return json({ ...cache.data, cached: true, cachedAt: cache.timestamp });
    }
    return json({ trending: [], signals: [], cached: false });
  }

  handleSnapshot() {
    return json({
      prices: this.getValue('snapshot_prices'),
      gold: this.getValue('snapshot_gold'),
      valuescan: this.getValue('snapshot_valuescan'),
    });
  }

  persistSignalBatch(signals, now) {
    const meta = this.getValue('hist_meta') || emptyHistMeta();
    const vsAlertMap = this.getValue('vs_alert') || {};
    const symbols = signals.map((s) => s.symbol).filter(Boolean);
    const hist = this.loadHistSlice(symbols);
    const enriched = enrichWithLifecycle(signals, vsAlertMap, hist);

    for (const sig of enriched) {
      if (!sig?.symbol) continue;
      this.upsertScanNext(sig);
      const prevRow = this.ctx.storage.sql.exec(
        'SELECT payload FROM sig_hist WHERE symbol = ?',
        sig.symbol,
      ).toArray()[0];
      const prev = prevRow ? JSON.parse(prevRow.payload) : null;
      const tracked = trackOne(prev, sig, now);
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO sig_hist (symbol, payload) VALUES (?, ?)',
        sig.symbol,
        JSON.stringify(tracked),
      );
      meta.symbols[sig.symbol] = {
        lastSeenAt: tracked.lastSeenAt,
        firstSeenAt: tracked.firstSeenAt,
        firstScore: tracked.firstScore,
        lastScore: tracked.lastScore,
      };
    }

    meta.lastUpdated = new Date().toISOString();
    this.putValue('hist_meta', meta);
    return enriched.length;
  }

  async handleIngest(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }

    const type = body.type;
    if (type === 'begin') {
      this.ctx.storage.sql.exec('DELETE FROM scan_sig_next');
      const meta = this.getValue('hist_meta') || emptyHistMeta();
      meta.scanCount = (meta.scanCount || 0) + 1;
      this.putValue('hist_meta', meta);
      this.putValue('job', { phase: 'ingest', startedAt: Date.now() });
      return json({ ok: true });
    }

    if (type === 'signals') {
      const signals = Array.isArray(body.signals) ? body.signals : [];
      const n = this.persistSignalBatch(signals, Date.now());
      return json({ ok: true, n });
    }

    if (type === 'snapshot') {
      if (body.prices) this.putValue('snapshot_prices', { data: body.prices, timestamp: Date.now() });
      if (body.gold) this.putValue('snapshot_gold', { data: body.gold, timestamp: Date.now() });
      if (body.valuescan) this.putValue('snapshot_valuescan', { data: body.valuescan, timestamp: Date.now() });
      if (body.vsAlertMap) this.putValue('vs_alert', body.vsAlertMap);
      if (body.trending) this.putValue('trending', { data: body.trending, timestamp: Date.now() });
      return json({ ok: true });
    }

    if (type === 'commit') {
      const n = this.countTable('scan_sig_next');
      if (n === 0) return json({ ok: false, error: 'no signals to publish' }, 400);
      this.ctx.storage.sql.exec('DELETE FROM scan_sig');
      this.ctx.storage.sql.exec('INSERT INTO scan_sig SELECT * FROM scan_sig_next');
      this.ctx.storage.sql.exec('DELETE FROM scan_sig_next');
      this.expireOldHistory();
      const summary = body.summary || this.summarizePublished();
      this.putValue('scan_meta', {
        timestamp: Date.now(),
        summary,
        source: 'github-actions',
      });
      this.putValue('history_stats', this.buildHistoryStats());
      this.putValue('job', { phase: 'done', startedAt: Date.now() });
      return json({ ok: true, published: n, summary });
    }

    return json({ error: 'unknown ingest type' }, 400);
  }

  async runTick() {
    const existing = this.getValue('scan_meta');
    let job = this.getValue('job');
    const published = this.countTable('scan_sig');

    if (job && job.phase === 'ingest') {
      return { skipped: true, reason: 'ingest-in-progress', continue: false };
    }

    if (
      (!job || job.phase === 'done')
      && published > 0
      && existing?.timestamp
      && Date.now() - existing.timestamp < SIGNALS_TTL_MS
    ) {
      return { skipped: true, reason: 'fresh', continue: false };
    }

    if (job && job.phase === 'done' && published === 0) {
      job = null;
    }

    if (job && job.phase !== 'done' && Date.now() - job.startedAt > JOB_STALE_MS) {
      console.warn('[signal-store] job stale, restarting');
      job = null;
    }

    if (!job || job.phase === 'done') {
      this.startJob();
      job = this.getValue('job');
    }

    try {
      await this.runPhase(job);
      this.putValue('job', job);
      return {
        ok: true,
        phase: job.phase,
        progress: this.progressOf(job),
        continue: job.phase !== 'done',
      };
    } catch (e) {
      const emptyRetry = /produced no coins/.test(e.message || '');
      if (!emptyRetry) job.failCount = (job.failCount || 0) + 1;
      console.error('[signal-store] tick failed:', job.phase, e.message);
      if (!emptyRetry && job.failCount >= MAX_CHUNK_FAILURES) {
        this.advancePastFailure(job);
        job.failCount = 0;
      }
      this.putValue('job', job);
      return {
        ok: false,
        error: e.message,
        phase: job.phase,
        continue: job.phase !== 'done',
      };
    }
  }

  startJob() {
    this.ctx.storage.sql.exec('DELETE FROM raw_coins');
    this.ctx.storage.sql.exec('DELETE FROM scan_sig_next');
    this.putValue('job', emptyJob());
  }

  advancePastFailure(job) {
    if (job.phase === 'markets') job.page += 1;
    else if (job.phase === 'valuescan') job.phase = 'score';
    else if (job.phase === 'score') job.scoreIndex += SCORE_BATCH;
    else if (job.phase === 'history') job.historyIndex += HISTORY_BATCH;
    else if (job.phase === 'persist') job.persistIndex += PERSIST_BATCH;
    else if (job.phase === 'stages') job.stageIndex += STAGE_BATCH;
    else if (job.phase === 'trending') job.phase = 'publish';
    else job.phase = 'done';
    this.closePhase(job);
  }

  closePhase(job) {
    if (job.phase === 'markets' && job.page > MARKET_PAGES) job.phase = 'valuescan';
    if (job.phase === 'score') {
      const n = this.countTable('raw_coins');
      if (job.scoreIndex >= n) job.phase = 'history';
    }
    if (job.phase === 'history' && job.historyIndex >= HISTORY_LIMIT) job.phase = 'persist';
    if (job.phase === 'persist') {
      const n = this.countTable('scan_sig_next');
      if (job.persistIndex >= n) job.phase = 'stages';
    }
    if (job.phase === 'stages') {
      const n = this.countTable('scan_sig_next');
      if (job.stageIndex >= n) job.phase = 'trending';
    }
  }

  async runPhase(job) {
    if (job.phase === 'markets') return this.phaseMarkets(job);
    if (job.phase === 'valuescan') return this.phaseValuescan(job);
    if (job.phase === 'score') return this.phaseScore(job);
    if (job.phase === 'history') return this.phaseHistory(job);
    if (job.phase === 'persist') return this.phasePersist(job);
    if (job.phase === 'stages') return this.phaseStages(job);
    if (job.phase === 'trending') return this.phaseTrending(job);
    if (job.phase === 'publish') return this.phasePublish(job);
  }

  async phaseMarkets(job) {
    const coins = await fetchTopCoinsPage(job.page, COINS_PER_PAGE);
    const base = (job.page - 1) * COINS_PER_PAGE;
    for (let i = 0; i < coins.length; i++) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO raw_coins (idx, payload) VALUES (?, ?)',
        base + i,
        JSON.stringify(coins[i]),
      );
    }
    job.summary.totalScanned = this.countTable('raw_coins');
    job.failCount = 0;
    job.page += 1;
    if (job.page > MARKET_PAGES) job.phase = 'valuescan';
  }

  async phaseValuescan(job) {
    const map = await fetchValuescanAlertMap();
    this.putValue('vs_alert', map);
    job.failCount = 0;
    job.phase = 'score';
  }

  phaseScore(job) {
    const rows = this.ctx.storage.sql.exec(
      'SELECT idx, payload FROM raw_coins WHERE idx >= ? AND idx < ? ORDER BY idx',
      job.scoreIndex,
      job.scoreIndex + SCORE_BATCH,
    ).toArray();
    if (!rows.length) {
      job.phase = 'history';
      return;
    }
    for (const row of rows) {
      try {
        const coin = JSON.parse(row.payload);
        const sig = generateCoinSignal(coin, null, null);
        if (!sig?.symbol) continue;
        this.upsertScanNext(sig);
      } catch { /* skip one coin */ }
    }
    job.failCount = 0;
    job.scoreIndex += SCORE_BATCH;
    if (job.scoreIndex >= this.countTable('raw_coins')) job.phase = 'history';
  }

  async phaseHistory(job) {
    const rows = this.ctx.storage.sql.exec(
      'SELECT idx, payload FROM raw_coins WHERE idx >= ? AND idx < ? ORDER BY idx',
      job.historyIndex,
      Math.min(HISTORY_LIMIT, job.historyIndex + HISTORY_BATCH),
    ).toArray();
    if (!rows.length || job.historyIndex >= HISTORY_LIMIT) {
      job.phase = 'persist';
      return;
    }

    for (const row of rows) {
      const coin = JSON.parse(row.payload);
      let history = null;
      try {
        history = await fetchCoinHistory(coin.id, 7);
      } catch {
        history = null;
      }
      const sig = generateCoinSignal(coin, history?.volumes || null, history?.prices || null);
      if (!sig?.symbol) continue;
      this.upsertScanNext(sig);
    }

    job.failCount = 0;
    job.historyIndex += HISTORY_BATCH;
    if (job.historyIndex >= HISTORY_LIMIT) job.phase = 'persist';
  }

  phasePersist(job) {
    const rows = this.ctx.storage.sql.exec(
      'SELECT symbol, payload FROM scan_sig_next ORDER BY symbol LIMIT ? OFFSET ?',
      PERSIST_BATCH,
      job.persistIndex,
    ).toArray();
    if (!rows.length) {
      this.expireOldHistory();
      job.phase = 'stages';
      return;
    }

    const now = Date.now();
    const meta = this.getValue('hist_meta') || emptyHistMeta();
    if (!job.scanCounted) {
      meta.scanCount = (meta.scanCount || 0) + 1;
      job.scanCounted = true;
    }

    for (const row of rows) {
      const sig = JSON.parse(row.payload);
      const prevRow = this.ctx.storage.sql.exec(
        'SELECT payload FROM sig_hist WHERE symbol = ?',
        sig.symbol,
      ).toArray()[0];
      const prev = prevRow ? JSON.parse(prevRow.payload) : null;
      const tracked = trackOne(prev, sig, now);
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO sig_hist (symbol, payload) VALUES (?, ?)',
        sig.symbol,
        JSON.stringify(tracked),
      );
      meta.symbols[sig.symbol] = {
        lastSeenAt: tracked.lastSeenAt,
        firstSeenAt: tracked.firstSeenAt,
        firstScore: tracked.firstScore,
        lastScore: tracked.lastScore,
      };
    }

    meta.lastUpdated = new Date().toISOString();
    this.putValue('hist_meta', meta);
    job.failCount = 0;
    job.persistIndex += PERSIST_BATCH;
    if (job.persistIndex >= this.countTable('scan_sig_next')) {
      this.expireOldHistory();
      job.phase = 'stages';
    }
  }

  expireOldHistory() {
    const meta = this.getValue('hist_meta') || emptyHistMeta();
    const now = Date.now();
    const expireMs = EXPIRE_HOURS * 3600000;
    for (const [sym, info] of Object.entries(meta.symbols || {})) {
      if (now - info.lastSeenAt > expireMs) {
        delete meta.symbols[sym];
        this.ctx.storage.sql.exec('DELETE FROM sig_hist WHERE symbol = ?', sym);
      }
    }
    this.putValue('hist_meta', meta);
  }

  phaseStages(job) {
    const rows = this.ctx.storage.sql.exec(
      'SELECT symbol, payload FROM scan_sig_next ORDER BY symbol LIMIT ? OFFSET ?',
      STAGE_BATCH,
      job.stageIndex,
    ).toArray();
    if (!rows.length) {
      job.phase = 'trending';
      return;
    }

    const vsAlertMap = this.getValue('vs_alert') || {};
    const symbols = rows.map((r) => r.symbol);
    const hist = this.loadHistSlice(symbols);
    const signals = rows.map((r) => JSON.parse(r.payload));
    const enriched = enrichWithLifecycle(signals, vsAlertMap, hist);
    for (const sig of enriched) this.upsertScanNext(sig);

    job.failCount = 0;
    job.stageIndex += STAGE_BATCH;
    if (job.stageIndex >= this.countTable('scan_sig_next')) job.phase = 'trending';
  }

  async phaseTrending(job) {
    try {
      const trending = await generateTrendingSignals();
      this.putValue('trending', { data: trending, timestamp: Date.now() });
    } catch (e) {
      console.warn('[signal-store] trending failed:', e.message);
    }
    job.failCount = 0;
    job.phase = 'publish';
  }

  phasePublish(job) {
    const nextCount = this.countTable('scan_sig_next');
    if (nextCount === 0) {
      this.ctx.storage.sql.exec('DELETE FROM raw_coins');
      this.ctx.storage.sql.exec('DELETE FROM scan_sig_next');
      Object.assign(job, emptyJob());
      throw new Error('scan produced no coins, retrying');
    }

    this.ctx.storage.sql.exec('DELETE FROM scan_sig');
    this.ctx.storage.sql.exec('INSERT INTO scan_sig SELECT * FROM scan_sig_next');
    this.ctx.storage.sql.exec('DELETE FROM scan_sig_next');
    this.ctx.storage.sql.exec('DELETE FROM raw_coins');

    job.summary = this.summarizePublished();
    this.putValue('scan_meta', {
      timestamp: Date.now(),
      summary: job.summary,
    });
    this.putValue('history_stats', this.buildHistoryStats());
    job.phase = 'done';
  }

  summarizePublished() {
    const row = this.ctx.storage.sql.exec(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN score >= 75 THEN 1 ELSE 0 END) AS strongBuy,
        SUM(CASE WHEN score >= 62 AND score < 75 THEN 1 ELSE 0 END) AS buy,
        SUM(CASE WHEN score >= 55 AND score < 62 THEN 1 ELSE 0 END) AS watch,
        SUM(CASE WHEN score >= 45 AND score < 55 THEN 1 ELSE 0 END) AS neutral,
        SUM(CASE WHEN score >= 35 AND score < 45 THEN 1 ELSE 0 END) AS caution,
        SUM(CASE WHEN score < 35 THEN 1 ELSE 0 END) AS riskAlert,
        SUM(fomo) AS fomoCount,
        SUM(CASE WHEN fund_type = 'bullish' THEN 1 ELSE 0 END) AS fundMovementBullish,
        SUM(CASE WHEN fund_type = 'bearish' THEN 1 ELSE 0 END) AS fundMovementBearish,
        SUM(has_reversal) AS reversalCount,
        SUM(has_bottom) AS bottomReversalCount
      FROM scan_sig
    `).toArray()[0] || {};
    return {
      totalScanned: this.countTable('scan_sig'),
      totalSignals: Number(row.total || 0),
      strongBuy: Number(row.strongBuy || 0),
      buy: Number(row.buy || 0),
      watch: Number(row.watch || 0),
      neutral: Number(row.neutral || 0),
      caution: Number(row.caution || 0),
      riskAlert: Number(row.riskAlert || 0),
      fomoCount: Number(row.fomoCount || 0),
      fundMovementBullish: Number(row.fundMovementBullish || 0),
      fundMovementBearish: Number(row.fundMovementBearish || 0),
      reversalCount: Number(row.reversalCount || 0),
      bottomReversalCount: Number(row.bottomReversalCount || 0),
      generatedAt: new Date().toISOString(),
    };
  }

  buildHistoryStats() {
    const meta = this.getValue('hist_meta') || emptyHistMeta();
    const now = Date.now();
    const active = Object.entries(meta.symbols || {})
      .filter(([, s]) => now - s.lastSeenAt < EXPIRE_HOURS * 3600000)
      .map(([symbol, s]) => ({ symbol, ...s }));

    const sample = this.ctx.storage.sql.exec(
      'SELECT combined_stage, COUNT(*) AS n FROM scan_sig GROUP BY combined_stage',
    ).toArray();
    const stageStats = {
      emerging: 0, accelerating: 0, active: 0, peaking: 0,
      fading: 0, mature: 0, extended: 0, exhaustion: 0,
    };
    for (const row of sample) {
      if (row.combined_stage && stageStats[row.combined_stage] !== undefined) {
        stageStats[row.combined_stage] += Number(row.n);
      }
    }

    return {
      totalTracked: active.length,
      scanCount: meta.scanCount || 0,
      lastUpdated: meta.lastUpdated,
      stageStats,
      newestSignals: active
        .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
        .slice(0, 5)
        .map((s) => ({
          symbol: s.symbol,
          firstSeenAt: new Date(s.firstSeenAt).toISOString(),
          ageMinutes: Math.floor((now - s.firstSeenAt) / 60000),
          firstScore: s.firstScore,
          lastScore: s.lastScore,
        })),
    };
  }
}

export function getStore(env) {
  const id = env.SIGNAL_STORE.idFromName('global');
  return env.SIGNAL_STORE.get(id);
}

export async function fetchValuescanAlertMap() {
  try {
    const body = JSON.stringify({ page: 1, pageSize: 50 });
    const res = await fetch('https://api.valuescan.io/api/chance/getFundsMovementPage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: VS_PAGE_URL,
        Referer: VS_PAGE_URL + '/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      body,
    });
    const parsed = await res.json();
    const list = (parsed.data && parsed.data.list) || [];
    const map = {};
    for (const item of list) {
      if (item.symbol) {
        map[item.symbol.toUpperCase()] = {
          gains: item.gains,
          beginPrice: item.beginPrice,
          beginTime: item.beginTime,
          number24h: item.number24h,
          percentChange24h: item.percentChange24h,
        };
      }
    }
    return map;
  } catch {
    return {};
  }
}

export { SIGNALS_TTL_MS, TRENDING_TTL_MS };
