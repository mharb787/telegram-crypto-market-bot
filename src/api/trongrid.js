import { base58Decode } from '../validator/checksum.js';
import { logger } from '../utils/logger.js';

const BASE_URL      = process.env.TRON_API_URL ?? 'https://api.trongrid.io';
const TRONSCAN_URL  = 'https://apilist.tronscanapi.com';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_EVM      = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';

// isBlacklisted(address) → keccak256 selector = 0xfe575a87
const IS_BLACKLISTED_SELECTOR = 'fe575a87';

// Convert Base58Check TRC20 address → 20-byte hex (no prefix/checksum)
function addressToEvmHex(address) {
  const buf = base58Decode(address);
  if (!buf || buf.length !== 25) return null;
  return buf.subarray(1, 21).toString('hex');
}

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (process.env.TRON_API_KEY) h['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
  return h;
}

async function fetchJSON(url, init = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);
  return res.json();
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getAccount(address) {
  const data = await fetchJSON(`${BASE_URL}/v1/accounts/${address}`, {
    headers: headers(),
  });
  return data.data?.[0] ?? null;
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function getFirstTransaction(address) {
  const data = await fetchJSON(
    `${BASE_URL}/v1/accounts/${address}/transactions?limit=1&order_by=block_timestamp,asc&only_confirmed=true`,
    { headers: headers() }
  );
  return data.data?.[0] ?? null;
}

export async function getTRC20Transfers(address, limit = 20) {
  const data = await fetchJSON(
    `${BASE_URL}/v1/accounts/${address}/transactions/trc20?limit=${limit}&only_confirmed=true`,
    { headers: headers() }
  );
  return data.data ?? [];
}

// ── Tether Blacklist via JSON-RPC eth_call (no API key needed) ────────────────

/**
 * Calls isBlacklisted(address) via JSON-RPC eth_call.
 * Returns true | false | null (null = could not determine).
 */
async function checkBlacklistRPC(address) {
  const evmHex = addressToEvmHex(address);
  if (!evmHex) return null;

  const callData = '0x' + IS_BLACKLISTED_SELECTOR + evmHex.padStart(64, '0');

  const data = await fetchJSON(`${BASE_URL}/jsonrpc`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'eth_call',
      params:  [{ to: USDT_EVM, data: callData }, 'latest'],
      id:      1,
    }),
  });

  logger.debug(`RPC isBlacklisted response: ${JSON.stringify(data)}`);

  if (data.error) {
    logger.warn(`RPC isBlacklisted error: ${JSON.stringify(data.error)}`);
    return null;
  }

  const result = data.result;
  if (!result || result === '0x') return null;

  try {
    return BigInt(result) !== 0n;
  } catch {
    logger.warn(`Could not parse RPC result: ${result}`);
    return null;
  }
}

/**
 * Fallback: check blacklist via TronScan account API.
 * TronScan returns `accountType` and other flags.
 */
async function checkBlacklistTronScan(address) {
  try {
    const data = await fetchJSON(
      `${TRONSCAN_URL}/api/account?address=${address}&includeToken=false`
    );
    logger.debug(`TronScan account: ${JSON.stringify(data).slice(0, 200)}`);
    // TronScan marks frozen/blacklisted accounts
    if (typeof data.isBlacklisted === 'boolean') return data.isBlacklisted;
    if (data.accountType === 1 && data.frozen) return true;
    return false;
  } catch (err) {
    logger.warn(`TronScan fallback failed: ${err.message}`);
    return null;
  }
}

/**
 * Main export: tries RPC first, falls back to TronScan.
 * Returns true | false | null.
 */
export async function isBlacklistedByTether(address) {
  // Primary: JSON-RPC eth_call (no auth needed)
  try {
    const rpc = await checkBlacklistRPC(address);
    if (rpc !== null) return rpc;
  } catch (err) {
    logger.warn(`RPC blacklist check failed: ${err.message}`);
  }

  // Fallback: TronScan API
  return checkBlacklistTronScan(address);
}

/**
 * Checks multiple addresses in parallel, returns those confirmed blacklisted.
 */
export async function filterBlacklisted(addresses) {
  const results = await Promise.allSettled(
    addresses.map(async (addr) => ({ addr, bad: await isBlacklistedByTether(addr) }))
  );
  return results
    .filter(r => r.status === 'fulfilled' && r.value.bad === true)
    .map(r => r.value.addr);
}

export { USDT_CONTRACT };
