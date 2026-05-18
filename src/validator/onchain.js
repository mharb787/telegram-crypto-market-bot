import {
  getAccount,
  getFirstTransaction,
  getTRC20Transfers,
  isBlacklistedByTether,
  filterBlacklisted,
  USDT_CONTRACT,
} from '../api/trongrid.js';
import { logger } from '../utils/logger.js';

const SUN = 1_000_000;   // 1 TRX  = 1,000,000 sun
const MU  = 1_000_000;   // 1 USDT = 1,000,000 micro-USDT

/**
 * Runs all on-chain checks for a TRC20 address.
 * Returns a structured result object.
 */
export async function checkOnChain(address) {
  const [account, blacklisted, firstTx, transfers] = await Promise.allSettled([
    getAccount(address),
    isBlacklistedByTether(address),
    getFirstTransaction(address),
    getTRC20Transfers(address, 40),
  ]);

  const acc       = account.status    === 'fulfilled' ? account.value    : null;
  const isBanned  = blacklisted.status === 'fulfilled' ? blacklisted.value : null;
  const first     = firstTx.status    === 'fulfilled' ? firstTx.value    : null;
  const txList    = transfers.status  === 'fulfilled' ? transfers.value  : [];

  // ── Balance ──────────────────────────────────────────────────────────────
  const trxBalance  = acc ? (acc.balance ?? 0) / SUN : 0;
  const usdtEntry   = acc?.trc20?.find(t => t[USDT_CONTRACT]);
  const usdtBalance = usdtEntry ? Number(usdtEntry[USDT_CONTRACT]) / MU : 0;

  // ── Wallet age ───────────────────────────────────────────────────────────
  const createMs = acc?.create_time ?? (first ? first.block_timestamp : null);
  const ageInfo  = buildAgeInfo(createMs);

  // ── Suspicious counterparties ─────────────────────────────────────────────
  const counterparties = uniqueCounterparties(address, txList);
  let bannedCounterparties = [];
  if (counterparties.length > 0) {
    try {
      bannedCounterparties = await filterBlacklisted(counterparties.slice(0, 15));
    } catch (err) {
      logger.warn('filterBlacklisted failed:', err.message);
    }
  }

  // ── Risk score ───────────────────────────────────────────────────────────
  const risk = computeRisk({ isBanned, ageInfo, bannedCounterparties });

  return {
    blacklisted:          isBanned,
    balance:              { trx: trxBalance, usdt: usdtBalance },
    age:                  ageInfo,
    totalTransactions:    txList.length,
    bannedCounterparties,
    risk,
    apiError:             account.status === 'rejected',
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildAgeInfo(timestampMs) {
  if (!timestampMs) return null;
  const date    = new Date(timestampMs);
  const days    = Math.floor((Date.now() - timestampMs) / 86_400_000);
  return { date: date.toISOString().slice(0, 10), days };
}

function uniqueCounterparties(address, transfers) {
  const seen = new Set();
  for (const tx of transfers) {
    const from = tx.from;
    const to   = tx.to;
    if (from && from !== address) seen.add(from);
    if (to   && to   !== address) seen.add(to);
  }
  return [...seen];
}

function computeRisk({ isBanned, ageInfo, bannedCounterparties }) {
  if (isBanned)                      return 'blacklisted';
  if (bannedCounterparties.length)   return 'high';
  if (ageInfo && ageInfo.days < 7)   return 'medium';
  return 'safe';
}
