#!/usr/bin/env node
/**
 * GitHub Actions / 本地定时扫描：在 Runner 上拉行情、算分，再推到 Cloudflare Worker。
 *
 * 环境变量:
 *   WORKER_URL   例如 https://crypto-dashboard.lansehuiyi6.workers.dev
 *   CRON_SECRET  与 wrangler secret CRON_SECRET 相同
 */
import { generateMarketSignals, generateTrendingSignals } from '../src/signal-engine.js';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';
const CHUNK = 30;
const PRICE_IDS = 'bitcoin,ethereum,binancecoin,solana,ripple,dogecoin';
const VS_PAGE = 'https://www.valuescan.io';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        lastErr = new Error(`429 ${url}`);
        await sleep(10000 * (i + 1));
        continue;
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        throw new Error(`non-json ${res.status} ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return data;
    } catch (e) {
      lastErr = e;
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
}

async function ingest(type, payload = {}) {
  const res = await fetch(`${WORKER_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify({ type, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ingest ${type} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function fetchValuescan(path) {
  return fetchJson(`https://api.valuescan.io/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: VS_PAGE,
      Referer: VS_PAGE + '/',
      'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboardScan/1.0)',
      Accept: 'application/json',
    },
    body: JSON.stringify({ page: 1, pageSize: 50 }),
  });
}

function alertMapFrom(raw) {
  const list = (raw.data && raw.data.list) || [];
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
}

async function main() {
  if (!WORKER_URL || !CRON_SECRET) {
    throw new Error('WORKER_URL and CRON_SECRET are required');
  }

  console.log('[scan] start', new Date().toISOString(), '->', WORKER_URL);

  const [prices, gold, vsLong, vsShort, vsAlert] = await Promise.all([
    fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${PRICE_IDS}&vs_currencies=usd&include_24hr_change=true`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboardScan/1.0)', Accept: 'application/json' },
    }).catch((e) => {
      console.warn('[scan] prices failed', e.message);
      return null;
    }),
    fetchJson('https://xaus.com/api/v1/spot', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboardScan/1.0)', Accept: 'application/json' },
    }).catch((e) => {
      console.warn('[scan] gold failed', e.message);
      return null;
    }),
    fetchValuescan('/chance/getChangeCoinPage').catch((e) => {
      console.warn('[scan] valuescan long failed', e.message);
      return null;
    }),
    fetchValuescan('/chance/getChangeCoinRiskPage').catch((e) => {
      console.warn('[scan] valuescan short failed', e.message);
      return null;
    }),
    fetchValuescan('/chance/getFundsMovementPage').catch((e) => {
      console.warn('[scan] valuescan alert failed', e.message);
      return null;
    }),
  ]);

  await ingest('begin');
  await ingest('snapshot', {
    prices: prices && !prices.status ? prices : undefined,
    gold: gold || undefined,
    valuescan: {
      long: vsLong,
      short: vsShort,
      alert: vsAlert,
    },
    vsAlertMap: vsAlert ? alertMapFrom(vsAlert) : {},
  });
  console.log('[scan] snapshot pushed', {
    prices: !!prices,
    gold: !!gold,
    vsLong: !!vsLong,
    vsShort: !!vsShort,
    vsAlert: !!vsAlert,
  });

  console.log('[scan] generating market signals...');
  const result = await generateMarketSignals({ limit: 250, includeVolHistory: true });
  console.log('[scan] signals', result.signals.length, 'scanned', result.summary.totalScanned);

  for (let i = 0; i < result.signals.length; i += CHUNK) {
    const slice = result.signals.slice(i, i + CHUNK);
    const out = await ingest('signals', { signals: slice });
    console.log('[scan] ingest signals', i, '-', i + slice.length, 'n=', out.n);
    await sleep(200);
  }

  try {
    const trending = await generateTrendingSignals();
    await ingest('snapshot', { trending });
    console.log('[scan] trending', trending.signals?.length || 0);
  } catch (e) {
    console.warn('[scan] trending failed', e.message);
  }

  const commit = await ingest('commit', { summary: result.summary });
  console.log('[scan] committed', commit.published, commit.summary?.generatedAt);
}

main().catch((e) => {
  console.error('[scan] failed', e);
  process.exit(1);
});
