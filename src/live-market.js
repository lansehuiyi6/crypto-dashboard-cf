/**
 * 实时行情：币安最新价 + CoinGecko 市值占比（含 USDT.D）
 */

const SPOT_TICKER = 'https://api.binance.com/api/v3/ticker/24hr';
const FAPI_TICKER = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const CG_GLOBAL = 'https://api.coingecko.com/api/v3/global';

const SPOT_MAP = [
  { symbol: 'BTCUSDT', id: 'bitcoin' },
  { symbol: 'ETHUSDT', id: 'ethereum' },
  { symbol: 'BNBUSDT', id: 'binancecoin' },
  { symbol: 'SOLUSDT', id: 'solana' },
  { symbol: 'XRPUSDT', id: 'ripple' },
  { symbol: 'DOGEUSDT', id: 'dogecoin' },
];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)',
  Accept: 'application/json',
};

async function fetchJSON(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function toQuote(row) {
  const usd = Number(row.lastPrice);
  const ch = Number(row.priceChangePercent);
  if (!Number.isFinite(usd)) return null;
  return {
    usd,
    usd_24h_change: Number.isFinite(ch) ? ch : null,
  };
}

export async function fetchBinancePrices() {
  const symbols = JSON.stringify(SPOT_MAP.map((s) => s.symbol));
  const [spot, xau] = await Promise.all([
    fetchJSON(`${SPOT_TICKER}?symbols=${encodeURIComponent(symbols)}`),
    fetchJSON(`${FAPI_TICKER}?symbol=XAUUSDT`).catch(() => null),
  ]);
  const out = {};
  const list = Array.isArray(spot) ? spot : [];
  const bySym = Object.fromEntries(list.map((r) => [r.symbol, r]));
  for (const { symbol, id } of SPOT_MAP) {
    const q = toQuote(bySym[symbol] || {});
    if (q) out[id] = q;
  }
  const xauQ = xau ? toQuote(xau) : null;
  if (xauQ) out.xau = xauQ;
  if (!out.bitcoin) throw new Error('binance ticker empty');
  return out;
}

export function parseGlobal(raw, prev = null) {
  const data = raw?.data || raw || {};
  const pct = data.market_cap_percentage || {};
  const total = Number(data.total_market_cap?.usd);
  const usdtD = Number(pct.usdt);
  const btcD = Number(pct.btc);
  const ethD = Number(pct.eth);
  const prevUsdt = Number(prev?.usdtDominance);
  const usdtDelta = Number.isFinite(usdtD) && Number.isFinite(prevUsdt)
    ? usdtD - prevUsdt
    : null;

  return {
    totalMcap: Number.isFinite(total) ? total : null,
    btcDominance: Number.isFinite(btcD) ? btcD : null,
    ethDominance: Number.isFinite(ethD) ? ethD : null,
    usdtDominance: Number.isFinite(usdtD) ? usdtD : null,
    usdtDelta,
    mcapChange24h: Number(data.market_cap_change_percentage_24h_usd),
    updatedAt: data.updated_at ? data.updated_at * 1000 : Date.now(),
  };
}

export function inverseHint(overview, btcChange24h) {
  const d = overview?.usdtDelta;
  const usdtD = overview?.usdtDominance;
  if (!Number.isFinite(usdtD)) {
    return { bias: 'none', text: 'USDT.D 暂不可用' };
  }
  const btcCh = Number(btcChange24h);
  if (d == null || Math.abs(d) < 0.03) {
    return {
      bias: 'neutral',
      text: 'USDT.D 与 BTC/ETH 多为反向：占比升=避险，占比降=风险偏好',
    };
  }
  if (d > 0 && (!Number.isFinite(btcCh) || btcCh <= 0)) {
    return { bias: 'risk-off', text: 'USDT.D 上升，资金转稳定币，偏压制 BTC/ETH' };
  }
  if (d < 0 && (!Number.isFinite(btcCh) || btcCh >= 0)) {
    return { bias: 'risk-on', text: 'USDT.D 下降，稳定币占比回落，利于 BTC/ETH' };
  }
  if (d > 0 && btcCh > 0) {
    return { bias: 'diverge', text: 'USDT.D 升但 BTC 仍涨，反向信号尚未确认' };
  }
  return { bias: 'diverge', text: 'USDT.D 降但 BTC 仍跌，反向信号尚未确认' };
}

export async function fetchGlobalOverview(prev = null) {
  const raw = await fetchJSON(CG_GLOBAL);
  return parseGlobal(raw, prev);
}
