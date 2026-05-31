import {
  getAccount,
  getFirstTransaction,
  getRecentUSDTTransfers,
  isBlacklistedByTether,
  USDT_CONTRACT,
} from '../api/trongrid.js';
import { screenTronAddressRisk } from '../api/oklink.js';
import {
  enqueueAddress,
  getLocalRiskForAddress,
  loadRiskDb,
  recordEdge,
  saveRiskDb,
  upsertAddress,
} from '../crawler/riskDb.js';
import { ensureTrustedLargeUsdtHolder, getTrustedEntity } from '../trustedEntities.js';
import { logger } from '../utils/logger.js';

const SUN = 1_000_000;   // 1 TRX  = 1,000,000 sun
const MU  = 1_000_000;   // 1 USDT = 1,000,000 micro-USDT
const MAX_REVIEWED_USDT_TRANSFERS = Math.max(50, Number(process.env.USDT_REVIEW_LIMIT) || 200);
const BLACKLIST_CHECK_CONCURRENCY = Math.max(1, Number(process.env.BLACKLIST_CHECK_CONCURRENCY) || 1);
const VERIFY_COUNTERPARTIES_WITH_TETHER = process.env.VERIFY_COUNTERPARTIES_WITH_TETHER === 'true';
const MIN_USER_AUDIT_USDT = Math.max(0, Number(process.env.MIN_USER_AUDIT_USDT) || 2000);

/**
 * Runs all on-chain checks for a TRC20 address.
 * Returns a structured result object.
 */
export async function checkOnChain(address, options = {}) {
  const reviewLimit = Math.max(50, Number(options.maxReviewedTransfers) || MAX_REVIEWED_USDT_TRANSFERS);
  const minAuditUsdt = Math.max(0, Number(options.minAuditUsdt ?? MIN_USER_AUDIT_USDT));
  const account = await settle(() => getAccount(address));
  await delay(400);
  const blacklisted = await settle(() => isBlacklistedByTether(address));
  await delay(400);
  const includeExternalRisk = options.includeExternalRisk !== false;
  const oklinkRisk = includeExternalRisk
    ? await settle(() => screenTronAddressRisk(address))
    : { status: 'fulfilled', value: null };
  await delay(400);
  let trustedEntity = await getTrustedEntity(address);
  await delay(100);
  let localRisk = await settle(() => loadLocalRisk(address));
  await delay(400);
  const firstTx = await settle(() => getFirstTransaction(address));
  await delay(400);
  const transfers = await settle(() => getRecentUSDTTransfers(address, {
    maxTransactions: reviewLimit,
    pageLimit: Number(options.pageLimit) || undefined,
    fingerprint: options.transferFingerprint,
  }));

  const acc       = account.status    === 'fulfilled' ? account.value    : null;
  const isBanned  = blacklisted.status === 'fulfilled' ? blacklisted.value : null;
  const first     = firstTx.status    === 'fulfilled' ? firstTx.value    : null;
  const txList    = transfers.status  === 'fulfilled' ? transfers.value  : [];

  if (transfers.status === 'rejected') {
    logger.warn('USDT transfer history failed:', transfers.reason?.message ?? transfers.reason);
  } else if (txList.incomplete) {
    logger.warn('USDT transfer history incomplete:', txList.stopReason);
  }

  // ── Balance ──────────────────────────────────────────────────────────────
  const trxBalance  = acc ? (acc.balance ?? 0) / SUN : 0;
  const usdtEntry   = acc?.trc20?.find(t => t[USDT_CONTRACT]);
  const usdtBalance = usdtEntry ? Number(usdtEntry[USDT_CONTRACT]) / MU : 0;
  if (!trustedEntity && isBanned !== true) {
    trustedEntity = await ensureTrustedLargeUsdtHolder(address, usdtBalance);
  }

  // ── Wallet age ───────────────────────────────────────────────────────────
  const createMs = acc?.create_time ?? (first ? first.block_timestamp : null);
  const ageInfo  = buildAgeInfo(createMs);

  // ── Suspicious counterparties across recent USDT transfers ───────────────
  const usdtTransfers = txList.filter(isUsdtTransfer);
  const auditTransfers = usdtTransfers.filter(tx => transferAmount(tx) >= minAuditUsdt);
  const counterparties = await filterUntrustedCounterparties(uniqueCounterparties(address, auditTransfers));
  const local = localRisk.status === 'fulfilled' ? localRisk.value : null;
  const shouldAuditCounterparties = !trustedEntity && (
    isBanned === true ||
    options.forceCounterpartyAudit ||
    VERIFY_COUNTERPARTIES_WITH_TETHER ||
    !local?.blacklistedInteractionCount
  );
  const blacklistAudit = shouldAuditCounterparties
    ? await auditBlacklistedCounterparties(address, auditTransfers, counterparties)
    : { bannedCounterparties: [], interactions: [], unknownCounterparties: [] };
  const indirectRiskInteractions = includeExternalRisk && !trustedEntity
    ? await findIndirectRiskInteractions(address, auditTransfers, blacklistAudit.bannedCounterparties)
    : [];

  if (isBanned === true || blacklistAudit.interactions.length > 0) {
    await settle(() => persistRiskFindings(address, isBanned, blacklistAudit.interactions));
    localRisk = await settle(() => loadLocalRisk(address));
  }

  // ── Risk score ───────────────────────────────────────────────────────────
  const oklink = oklinkRisk.status === 'fulfilled' ? oklinkRisk.value : null;
  const refreshedLocal = localRisk.status === 'fulfilled' ? localRisk.value : null;
  const risk = computeRisk({
    isBanned,
    ageInfo,
    bannedCounterparties: blacklistAudit.bannedCounterparties,
    indirectRiskInteractions,
    oklink,
    local: refreshedLocal,
    trustedEntity,
  });

  return {
    blacklisted:          isBanned,
    balance:              { trx: trxBalance, usdt: usdtBalance },
    age:                  ageInfo,
    totalTransactions:    usdtTransfers.length,
    reviewedTransactions: txList.length,
    reviewLimit,
    nextTransferFingerprint: txList.nextFingerprint ?? null,
    transferHistoryHasMore: Boolean(txList.hasMore),
    transferHistoryIncomplete: Boolean(txList.incomplete),
    transferHistoryStopReason: txList.stopReason ?? null,
    tetherCounterpartyVerification: shouldAuditCounterparties,
    externalCounterpartyAudit: shouldAuditCounterparties,
    checkedCounterparties: counterparties.length,
    reviewedInteractions:  auditTransfers.map(tx => buildInteraction(address, tx)).filter(Boolean),
    bannedCounterparties: blacklistAudit.bannedCounterparties,
    blacklistedInteractions: blacklistAudit.interactions,
    indirectRiskInteractions,
    unknownCounterparties: blacklistAudit.unknownCounterparties,
    oklinkRisk:           oklink,
    localRisk:            refreshedLocal,
    trustedEntity,
    risk,
    apiError:             account.status === 'rejected' || transfers.status === 'rejected' || Boolean(txList.incomplete),
    apiErrorReason:       account.status === 'rejected'
      ? (account.reason?.message ?? String(account.reason))
      : transfers.status === 'rejected'
        ? (transfers.reason?.message ?? String(transfers.reason))
        : txList.stopReason ?? null,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, fallback) {
  const timer = new Promise(resolve => setTimeout(() => resolve(fallback), ms));
  return Promise.race([promise, timer]);
}

async function settle(fn) {
  try {
    return { status: 'fulfilled', value: await fn() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildAgeInfo(timestampMs) {
  if (!timestampMs) return null;
  const date    = new Date(timestampMs);
  const days    = Math.floor((Date.now() - timestampMs) / 86_400_000);
  return { date: date.toISOString().slice(0, 10), days };
}

function isUsdtTransfer(tx) {
  return isTokenTransfer(tx) && tx.token_info?.address === USDT_CONTRACT;
}

function isTokenTransfer(tx) {
  return tx.type === 'Transfer' && tx.from && tx.to;
}

function uniqueCounterparties(address, transfers) {
  const seen = new Set();
  for (const tx of transfers) {
    const counterparty = getCounterparty(address, tx);
    if (counterparty) seen.add(counterparty);
  }
  return [...seen];
}

async function auditBlacklistedCounterparties(address, transfers, counterparties) {
  const statuses = new Map();
  const unknownCounterparties = [];

  for (let i = 0; i < counterparties.length; i += BLACKLIST_CHECK_CONCURRENCY) {
    const batch = counterparties.slice(i, i + BLACKLIST_CHECK_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (addr) => ({
        addr,
        blacklisted: await withTimeout(isBlacklistedByTether(addr), 15000, null),
      }))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        statuses.set(result.value.addr, result.value.blacklisted);
        if (result.value.blacklisted === null) unknownCounterparties.push(result.value.addr);
      } else {
        logger.warn('counterparty blacklist check failed:', result.reason?.message ?? result.reason);
      }
    }

    if (i + BLACKLIST_CHECK_CONCURRENCY < counterparties.length) {
      await delay(700);
    }
  }

  const bannedCounterparties = [...statuses.entries()]
    .filter(([, blacklisted]) => blacklisted === true)
    .map(([addr]) => addr);
  const bannedSet = new Set(bannedCounterparties);

  const interactions = transfers
    .map(tx => buildInteraction(address, tx))
    .filter(item => item && bannedSet.has(item.counterparty));

  return { bannedCounterparties, interactions, unknownCounterparties };
}

async function findIndirectRiskInteractions(address, transfers, bannedCounterparties = []) {
  const bannedSet = new Set(bannedCounterparties);
  const seen = new Set();
  const interactions = [];

  for (const tx of transfers) {
    const interaction = buildInteraction(address, tx);
    if (!interaction?.counterparty) continue;
    if (bannedSet.has(interaction.counterparty)) continue;
    if (seen.has(interaction.counterparty)) continue;
    if (await getTrustedEntity(interaction.counterparty)) continue;

    const risk = await loadLocalRisk(interaction.counterparty);
    if (risk.isBlacklisted === true) continue;
    if (risk.blacklistedInteractionCount <= 0) continue;

    seen.add(interaction.counterparty);
    interactions.push({
      ...interaction,
      indirectRiskCount: risk.blacklistedInteractionCount,
    });
  }

  return interactions;
}

async function filterUntrustedCounterparties(counterparties) {
  const filtered = [];
  for (const address of counterparties) {
    if (await getTrustedEntity(address)) continue;
    filtered.push(address);
  }
  return filtered;
}

function buildInteraction(address, tx) {
  const counterparty = getCounterparty(address, tx);
  if (!counterparty) return null;

  const amount = transferAmount(tx);
  const direction = tx.from === address ? 'sent' : 'received';
  const timestamp = tx.block_timestamp ?? null;

  return {
    counterparty,
    direction,
    amount,
    token: tx.token_info?.symbol ?? 'USDT',
    timestamp,
    date: timestamp ? `${new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16)} UTC` : null,
    txid: tx.transaction_id,
  };
}

function transferAmount(tx) {
  const decimals = tx.token_info?.decimals ?? 6;
  return Number(tx.value ?? 0) / 10 ** decimals;
}

function getCounterparty(address, tx) {
  if (tx.from === address && tx.to) return tx.to;
  if (tx.to === address && tx.from) return tx.from;
  return null;
}

async function loadLocalRisk(address) {
  const db = await loadRiskDb();
  const risk = getLocalRiskForAddress(db, address);
  const filteredEdges = [];
  for (const edge of risk.blacklistedEdges) {
    const riskyAddress = edge.blacklistedAddress ?? edge.counterparty ?? (edge.from === address ? edge.to : edge.from);
    if (await getTrustedEntity(riskyAddress)) continue;
    filteredEdges.push(edge);
  }
  return {
    known: Boolean(risk.addressInfo || filteredEdges.length),
    isBlacklisted: risk.addressInfo?.isBlacklisted ?? null,
    blacklistedInteractions: filteredEdges.slice(0, 20),
    blacklistedInteractionCount: filteredEdges.length,
  };
}

async function persistRiskFindings(address, isBanned, interactions) {
  const db = await loadRiskDb();
  const now = new Date().toISOString();
  let changed = false;

  if (isBanned === true) {
    upsertAddress(db, address, {
      isBlacklisted: true,
      sources: ['user_check'],
      lastChecked: now,
    });
    enqueueAddress(db, address, {
      priority: 1,
      depth: 0,
      reason: 'user_checked_blacklisted',
    });
    changed = true;
  }

  for (const item of interactions) {
    upsertAddress(db, item.counterparty, {
      isBlacklisted: true,
      sources: ['user_check_counterparty'],
      lastChecked: now,
    });
    enqueueAddress(db, item.counterparty, {
      priority: 2,
      depth: 0,
      reason: `counterparty_of_user_check:${address}`,
    });

    const isSent = item.direction === 'sent';
    const edgeAdded = recordEdge(db, {
      txid: item.txid,
      from: isSent ? address : item.counterparty,
      to: isSent ? item.counterparty : address,
      amount: item.amount,
      token: item.token ?? 'USDT',
      timestamp: item.timestamp ?? null,
      date: item.date ?? null,
      blacklistedAddress: item.counterparty,
      counterparty: item.counterparty,
      source: 'user_check',
    });

    changed = changed || edgeAdded;
  }

  if (changed) await saveRiskDb(db);
}

function computeRisk({ isBanned, ageInfo, bannedCounterparties, indirectRiskInteractions, oklink, local, trustedEntity }) {
  if (isBanned)                      return 'blacklisted';
  if (trustedEntity)                 return 'safe';
  if (bannedCounterparties.length)   return 'high';
  if (oklink?.available && oklink.associatedBlackAddresses > 0) return 'high';
  if (local?.blacklistedInteractionCount > 0) return 'high';
  if (indirectRiskInteractions?.length > 0) return 'low';
  if (ageInfo && ageInfo.days < 7)   return 'medium';
  return 'safe';
}
