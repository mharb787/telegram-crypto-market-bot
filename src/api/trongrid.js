import { base58Decode } from '../validator/checksum.js';

const BASE_URL      = process.env.TRON_API_URL ?? 'https://api.trongrid.io';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// Convert Base58 TRC20 address → 32-byte hex parameter for contract calls
function addressToParam(address) {
  const buf = base58Decode(address);
  if (!buf || buf.length !== 25) return null;
  return buf.subarray(1, 21).toString('hex').padStart(64, '0');
}

async function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`TronGrid ${path} → HTTP ${res.status}`);
  return res.json();
}

async function get(path) {
  const headers = {};
  if (process.env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
  const res = await fetch(`${BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`TronGrid ${path} → HTTP ${res.status}`);
  return res.json();
}

// ── Account ──────────────────────────────────────────────────────────────────

/** Returns raw account object or null if address has no on-chain activity. */
export async function getAccount(address) {
  const data = await get(`/v1/accounts/${address}`);
  return data.data?.[0] ?? null;
}

// ── Transactions ─────────────────────────────────────────────────────────────

/** Returns the oldest transaction (used for wallet-age calculation). */
export async function getFirstTransaction(address) {
  const data = await get(
    `/v1/accounts/${address}/transactions?limit=1&order_by=block_timestamp,asc&only_confirmed=true`
  );
  return data.data?.[0] ?? null;
}

/** Returns up to `limit` recent TRC20 transfers. */
export async function getTRC20Transfers(address, limit = 40) {
  const data = await get(
    `/v1/accounts/${address}/transactions/trc20?limit=${limit}&only_confirmed=true`
  );
  return data.data ?? [];
}

// ── Tether Blacklist ──────────────────────────────────────────────────────────

/**
 * Calls isBlacklisted(address) on the USDT TRC20 contract.
 * Returns true if the address is on Tether's on-chain blacklist.
 */
export async function isBlacklistedByTether(address) {
  const param = addressToParam(address);
  if (!param) return false;

  const data = await post('/wallet/triggerconstantcontract', {
    owner_address:     'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    contract_address:  USDT_CONTRACT,
    function_selector: 'isBlacklisted(address)',
    parameter:         param,
    visible:           true,
  });

  const hex = data.constant_result?.[0];
  return hex ? BigInt(`0x${hex}`) !== 0n : false;
}

/**
 * Checks a list of addresses against the Tether blacklist in parallel.
 * Returns the subset that are blacklisted.
 */
export async function filterBlacklisted(addresses) {
  const results = await Promise.allSettled(
    addresses.map(async (addr) => ({ addr, bad: await isBlacklistedByTether(addr) }))
  );
  return results
    .filter(r => r.status === 'fulfilled' && r.value.bad)
    .map(r => r.value.addr);
}

export { USDT_CONTRACT };
