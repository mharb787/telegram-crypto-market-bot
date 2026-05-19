import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../storage.js';
import { getRecentUSDTTransfers, isBlacklistedByTether } from '../api/trongrid.js';
import { logger } from '../utils/logger.js';
import {
  enqueueAddress,
  loadRiskDb,
  markQueueItem,
  nextQueueItem,
  recordEdge,
  saveRiskDb,
  upsertAddress,
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
  let db = await loadRiskDb();

  try {
    await seedQueue(db);
    await saveRiskDb(db);

    logger.info(`Blacklist crawler started. queue:${pendingCount(db)} once:${ONCE}`);

    do {
      const item = nextQueueItem(db);
      if (!item) {
        db = await loadRiskDb();
        const reloadedItem = nextQueueItem(db);
        if (reloadedItem) continue;

        if (ONCE) break;
        logger.info(`Blacklist crawler idle. queue:${pendingCount(db)}`);
        await delay(LOOP_DELAY_MS);
        continue;
      }

      await processQueueItem(db, item);
      await saveRiskDb(db);

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

async function seedQueue(db) {
  const seeds = await readJson(SEED_FILE, []);
  for (const address of seeds) {
    upsertAddress(db, address, {
      isBlacklisted: true,
      sources: ['seed'],
      lastChecked: new Date().toISOString(),
    });
    const current = db.addresses[address];
    if (!current?.lastScanned) {
      enqueueAddress(db, address, { priority: 1, depth: 0, reason: 'seed' });
    }
  }

  for (const item of Object.values(db.addresses)) {
    if (item.isBlacklisted !== true || item.lastScanned) continue;
    enqueueAddress(db, item.address, {
      priority: 2,
      depth: 0,
      reason: 'known_blacklisted_unscanned',
    });
  }
}

async function processQueueItem(db, item) {
  logger.info(`Scanning blacklisted address ${item.address} depth:${item.depth}`);
  markQueueItem(db, item, {
    status: 'running',
    attempts: item.attempts + 1,
    startedAt: new Date().toISOString(),
  });

  try {
    const transfers = await getRecentUSDTTransfers(item.address, { maxTransactions: USDT_LIMIT });
    if (transfers.incomplete && transfers.length === 0) {
      throw new Error(transfers.stopReason || 'USDT transfer history unavailable');
    }
    const counterparties = new Set();

    for (const tx of transfers) {
      if (tx.type !== 'Transfer') continue;
      const counterparty = tx.from === item.address ? tx.to : tx.to === item.address ? tx.from : null;
      if (!counterparty) continue;
      counterparties.add(counterparty);

      recordEdge(db, {
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

    await scanCounterparties(db, item, [...counterparties]);

    upsertAddress(db, item.address, {
      isBlacklisted: true,
      sources: ['crawler'],
      lastScanned: new Date().toISOString(),
      scannedTransfers: transfers.length,
      scannedCounterparties: counterparties.size,
    });

    db.stats.scannedBlacklisted += 1;
    markQueueItem(db, item, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      transfers: transfers.length,
      counterparties: counterparties.size,
    });

    logger.info(`Scan done ${item.address}. transfers:${transfers.length} counterparties:${counterparties.size}`);
  } catch (err) {
    logger.warn(`Scan failed ${item.address}: ${err.message}`);
    markQueueItem(db, item, {
      status: item.attempts >= 3 ? 'failed' : 'pending',
      error: err.message,
      nextRunAt: new Date(Date.now() + LOOP_DELAY_MS * 6).toISOString(),
    });
  }
}

async function scanCounterparties(db, item, counterparties) {
  if (item.depth >= MAX_DEPTH) return;

  for (const address of counterparties) {
    const known = db.addresses[address];
    if (known?.isBlacklisted === true || known?.isBlacklisted === false) continue;

    await delay(ADDRESS_CHECK_DELAY_MS);
    const blacklisted = await isBlacklistedByTether(address);

    upsertAddress(db, address, {
      isBlacklisted: blacklisted,
      sources: ['crawler_check'],
      lastChecked: new Date().toISOString(),
    });

    if (blacklisted === true) {
      db.stats.discoveredBlacklisted += 1;
      enqueueAddress(db, address, {
        priority: item.priority + 1,
        depth: item.depth + 1,
        reason: `counterparty_of:${item.address}`,
      });
      logger.info(`Discovered blacklisted counterparty ${address} from ${item.address}`);
    }
  }
}

function pendingCount(db) {
  return db.queue.filter(item => item.status === 'pending').length;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error('Blacklist crawler fatal:', err);
  process.exit(1);
});
