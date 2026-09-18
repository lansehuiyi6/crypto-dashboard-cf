/**
 * 币安 U 本位永续合约交易对（用于自有信号只展示可开合约的币）
 */
const FAPI_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const FAPI_TICKER_PRICE = 'https://fapi.binance.com/fapi/v1/ticker/price';
const FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; CryptoDashboard/1.0)',
};

function addBaseAliases(set, rawBase) {
  const b = String(rawBase || '').toUpperCase();
  if (!b) return;
  set.add(b);
  let rest = b;
  if (rest.startsWith('1000000')) rest = rest.slice(7);
  else if (rest.startsWith('100000')) rest = rest.slice(6);
  else if (rest.startsWith('10000')) rest = rest.slice(5);
  else if (rest.startsWith('1000')) rest = rest.slice(4);
  else if (rest.startsWith('1M')) rest = rest.slice(2);
  if (rest && rest !== b) set.add(rest);
}

function basesFromExchangeInfo(info) {
  const set = new Set();
  for (const s of info?.symbols || []) {
    if (s.status !== 'TRADING') continue;
    if (s.quoteAsset !== 'USDT') continue;
    if (s.contractType && s.contractType !== 'PERPETUAL') continue;
    addBaseAliases(set, s.baseAsset);
  }
  return set;
}

function basesFromTickers(list) {
  const set = new Set();
  for (const row of list || []) {
    const sym = String(row.symbol || '').toUpperCase();
    if (!sym.endsWith('USDT')) continue;
    if (sym.includes('_')) continue;
    addBaseAliases(set, sym.slice(0, -4));
  }
  return set;
}

export async function fetchUsdtMFuturesBases() {
  try {
    const res = await fetch(FAPI_EXCHANGE_INFO, { headers: FETCH_HEADERS });
    if (res.ok) {
      const info = await res.json();
      const set = basesFromExchangeInfo(info);
      if (set.size > 20) return [...set];
    }
  } catch { /* ticker fallback */ }
  const res = await fetch(FAPI_TICKER_PRICE, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error('binance futures ' + res.status);
  const list = await res.json();
  const set = basesFromTickers(list);
  if (set.size < 20) throw new Error('binance futures empty');
  return [...set];
}

export function hasUsdtMFutures(symbol, bases) {
  if (!bases || !bases.size) return false;
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return false;
  if (bases.has(s)) return true;
  if (bases.has('1000' + s) || bases.has('10000' + s) || bases.has('1000000' + s)) return true;
  if (bases.has('1M' + s)) return true;
  return false;
}

export function toBaseSet(list) {
  return new Set((list || []).map((x) => String(x).toUpperCase()));
}
