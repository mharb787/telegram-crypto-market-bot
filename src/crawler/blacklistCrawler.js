import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../storage.js';
import { getRecentUSDTTransfers, isBlacklistedByTether } from '../api/trongrid.js';
import { logger } from '../utils/logger.js';
import {
  claimNextRiskQueueItem,
  completeRiskQueueItem,
  failRiskQueueItem,
  getRiskAddressInfo,
  pendingRiskQueueCount,
  seedRiskQueue,
} from './riskDb.js';

const SEED_FILE = 'blacklist-seeds.json';
const MAX_DEPTH = Number.isFinite(Number(process.env.CRAWLER_MAX_DEPTH))
  ? Math.max(0, Number(process.env.CRAWLER_MAX_DEPTH))
  : 2;
const USDT_LIMIT = Math.max(50, Number(process.env.CRAWLER_USDT_LIMIT) || 1000);
const LOOP_DELAY_MS = Math.max(500, Number(process.env.CRAWLER_LOOP_DELAY_MS) || 5000);
const ADDRESS_CHECK_DELAY_MS = Math.max(250, Number(process.env.CRAWLER_ADDRESS_CHECK_DELAY_MS) || 1500);
const ONCE = process.argv.includes('--once') || process.env.CRAWLER_ONCE === 'true';
const LOCK_FILE = path.resolve('data', 'blacklist-crawler.lock');

async function main() {
  const releaseLock = await acquireLock();

  try {
    const seeds = await readJson(SEED_FILE, []);
    const pending = await seedRiskQueue(seeds);
    logger.info(`Blacklist crawler started. queue:${pending} once:${ONCE}`);

    do {
      const item = await claimNextRiskQueueItem();
      if (!item) {
        if (ONCE) break;
        logger.info(`Blacklist crawler idle. queue:${await pendingRiskQueueCount()}`);
        await delay(LOOP_DELAY_MS);
        continue;
      }

      await processQueueItem(item);

      if (!ONCE) await delay(LOOP_DELAY_MS);
    } while (true);

    logger.info('Blacklist crawler stopped.');
  } finally {
    await releaseLock();
  }
}

async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true });

  try {
    const handle = await fs.open(LOCK_FILE, 'wx');
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }, null, 2));
    await handle.close();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const lock = await readLockFile();
    if (lock?.pid && await isProcessRunning(lock.pid)) {
      throw new Error(`Blacklist crawler is already running. pid:${lock.pid}`);
    }
    logger.warn('Removing stale blacklist crawler lock file.');
    await fs.rm(LOCK_FILE, { force: true });
    return acquireLock();
  }

  const cleanup = async () => {
    await fs.rm(LOCK_FILE, { force: true }).catch(() => {});
  };

  process.once('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', async () => {
    await cleanup();
    process.exit(143);
  });

  return cleanup;
}

async function readLockFile() {
  try {
    return JSON.parse(await fs.readFile(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processQueueItem(item) {
  logger.info(`Scanning blacklisted address ${item.address} depth:${item.depth}`);

  try {
    const transfers = await getRecentUSDTTransfers(item.address, { maxTransactions: USDT_LIMIT });
    if (transfers.incomplete && transfers.length === 0) {
      throw new Error(transfers.stopReason || 'USDT transfer history unavailable');
    }
    const counterparties = new Set();
    const edges = [];

    for (const tx of transfers) {
      if (tx.type !== 'Transfer') continue;
      const counterparty = tx.from === item.address ? tx.to : tx.to === item.address ? tx.from : null;
      if (!counterparty) continue;
      counterparties.add(counterparty);

      edges.push({
        txid: tx.transaction_id,
        from: tx.from,
        to: tx.to,
        amount: Number(tx.value ?? 0) / 10 ** (tx.token_info?.decimals ?? 6),
        token: tx.token_info?.symbol ?? 'USDT',
        timestamp: tx.block_timestamp ?? null,
        date: tx.block_timestamp ? new Date(tx.block_timestamp).toISOString() : null,
        blacklistedAddress: item.address,
        counterparty,
        source: 'crawler',
      });
    }

    const counterpartyChecks = await scanCounterparties(item, [...counterparties]);
    await completeRiskQueueItem({
      item,
      edges,
      counterpartyChecks,
      transferCount: transfers.length,
      counterpartyCount: counterparties.size,
    });

    logger.info(`Scan done ${item.address}. transfers:${transfers.length} counterparties:${counterparties.size}`);
  } catch (err) {
    logger.warn(`Scan failed ${item.address}: ${err.message}`);
    await failRiskQueueItem(item, err.message, { retryDelayMs: LOOP_DELAY_MS * 6 });
  }
}

async function scanCounterparties(item, counterparties) {
  if (item.depth >= MAX_DEPTH) return [];
  const checks = [];

  for (const address of counterparties) {
    const known = await getRiskAddressInfo(address);
    if (known?.isBlacklisted === true || known?.isBlacklisted === false) continue;

    await delay(ADDRESS_CHECK_DELAY_MS);
    const blacklisted = await isBlacklistedByTether(address);

    checks.push({ address, blacklisted });

    if (blacklisted === true) {
      logger.info(`Discovered blacklisted counterparty ${address} from ${item.address}`);
    }
  }
  return checks;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error('Blacklist crawler fatal:', err);
  process.exit(1);
});
