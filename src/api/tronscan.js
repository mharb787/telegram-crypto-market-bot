const ENDPOINT = 'https://apilist.tronscanapi.com/api/account/tag';
const EXCHANGES = ['Binance', 'OKX', 'OKEx', 'HTX', 'Huobi', 'Kraken', 'Coinbase', 'KuCoin', 'Bybit', 'Bitfinex', 'Bitget', 'Gate.io', 'Gate', 'MEXC', 'Poloniex', 'Crypto.com', 'Bitstamp', 'Bithumb', 'Upbit', 'CoinEx'];

export function parseExchangeTag(address, data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.address != null && data.address !== address) return null;
  if (data.code != null && !['0', '200'].includes(String(data.code))) return null;
  if (typeof data.blueTag !== 'string') return null;
  const tag = data.blueTag.trim();
  // An exact platform name or a narrowly defined wallet designation, never a substring.
  const name = EXCHANGES.find(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}(?:[ :_-]+(?:(?:hot|cold|deposit|withdrawal)(?:[ _-]+wallet)?|wallet|exchange))?(?:[ #:_-]*\\d+)?$`, 'i').test(tag);
  });
  return name ? { address, name, type: 'platform', auto: true, blueTag: tag,
    source: 'tronscan_blue_tag', verifiedAt: new Date(now).toISOString(),
    sourceUrl: `${ENDPOINT}?address=${encodeURIComponent(address)}` } : null;
}

export function createExchangeTagLookup({ fetcher = (...args) => fetch(...args), now = Date.now,
  key = () => process.env.TRONSCAN_API_KEY, ttlMs = 15 * 60_000, failureTtlMs = 30_000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  return async function lookup(address) {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
    const hit = cache.get(address);
    if (hit && hit.expires > now()) return hit.value;
    if (pending.has(address)) return pending.get(address);
    const request = (async () => {
      let value = null;
      let lifetime = failureTtlMs;
      try {
        if (!key()) return null;
        const response = await fetcher(`${ENDPOINT}?address=${encodeURIComponent(address)}`, {
          headers: { 'TRON-PRO-API-KEY': key() }, signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (response.ok) {
          value = parseExchangeTag(address, await response.json(), now());
          lifetime = ttlMs;
        }
      } catch { /* No request headers or credentials in logs. Keep normal risk classification. */ }
      if (cache.size >= 5000) cache.delete(cache.keys().next().value);
      cache.set(address, { value, expires: now() + lifetime });
      return value;
    })();
    pending.set(address, request);
    try { return await request; } finally { pending.delete(address); }
  };
}

export const lookupExchangeTag = createExchangeTagLookup();
