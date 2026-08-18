import { SignalStore, getStore } from './store.js';
import { getMarketSignals } from './market-signals.js';

export { SignalStore };

const VS_PAGE_URL = 'https://www.valuescan.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors,
    },
  });
}

async function proxyValuescan(endpoint) {
  const body = JSON.stringify({ page: 1, pageSize: 50 });
  try {
    const res = await fetch(`https://api.valuescan.io/api${endpoint}`, {
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
    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...cors,
      },
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

function isUpstreamRateLimit(res, parsed) {
  if (!res.ok) return true;
  if (!parsed || typeof parsed !== 'object') return false;
  return parsed.status?.error_code === 429
    || /rate limit/i.test(String(parsed.status?.error_message || parsed.error || ''));
}

async function proxyGet(url, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)',
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }

    if (isUpstreamRateLimit(res, parsed)) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set('X-Cache', 'HIT-STALE');
        return new Response(cached.body, { status: 200, headers });
      }
      return json({ error: parsed?.status?.error_message || parsed?.error || 'rate limited' }, 429);
    }

    const out = new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        ...cors,
      },
    });
    if (ctx) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch (e) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    return json({ error: e.message }, 502);
  }
}

async function authorize(request, env) {
  const expected = env.CRON_SECRET;
  if (!expected) return false;
  const hdr = request.headers.get('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const enc = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(token)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(expected)));
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function readSnapshot(env) {
  const stub = getStore(env);
  const res = await stub.fetch('https://do/snapshot');
  return res.json();
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (pathname === '/api/ingest' && request.method === 'POST') {
    if (!(await authorize(request, env))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const stub = getStore(env);
    return stub.fetch('https://do/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await request.text(),
    });
  }

  if (pathname === '/api/valuescan/long') {
    const snap = await readSnapshot(env);
    if (snap.valuescan?.data?.long) return json(snap.valuescan.data.long);
    return proxyValuescan('/chance/getChangeCoinPage');
  }
  if (pathname === '/api/valuescan/short') {
    const snap = await readSnapshot(env);
    if (snap.valuescan?.data?.short) return json(snap.valuescan.data.short);
    return proxyValuescan('/chance/getChangeCoinRiskPage');
  }
  if (pathname === '/api/valuescan/alert') {
    const snap = await readSnapshot(env);
    if (snap.valuescan?.data?.alert) return json(snap.valuescan.data.alert);
    return proxyValuescan('/chance/getFundsMovementPage');
  }

  if (pathname === '/api/coingecko/prices') {
    const snap = await readSnapshot(env);
    if (snap.prices?.data && !snap.prices.data.error && !snap.prices.data.status) {
      return json(snap.prices.data);
    }
    const ids = url.searchParams.get('ids') || 'bitcoin,ethereum,binancecoin,solana,ripple,dogecoin';
    return proxyGet(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
      ctx,
    );
  }

  if (pathname === '/api/gold/spot') {
    const snap = await readSnapshot(env);
    if (snap.gold?.data?.spot_usd_oz) return json(snap.gold.data);
    return proxyGet('https://xaus.com/api/v1/spot', ctx);
  }

  if (pathname === '/api/signals') {
    const stub = getStore(env);
    const qs = url.searchParams.toString();
    const res = await stub.fetch(`https://do/signals?${qs}`);
    const data = await res.json();
    return json(data, res.status);
  }

  if (pathname === '/api/signals/history') {
    const stub = getStore(env);
    return stub.fetch('https://do/history');
  }

  if (pathname === '/api/signals/trending') {
    const stub = getStore(env);
    return stub.fetch('https://do/trending');
  }

  if (pathname === '/api/market-signals') {
    return json(getMarketSignals());
  }

  return json({ error: 'Not Found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const stub = getStore(env);
    ctx.waitUntil(stub.fetch('https://do/tick', { method: 'POST' }));
  },
};
