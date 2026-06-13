import 'dotenv/config';
import crypto from 'node:crypto';
import { getContractEvents, USDT_CONTRACT } from '../api/trongrid.js';
import { readJson, writeJson } from '../storage.js';
import { enqueueAddress, loadRiskDb, saveRiskDb, upsertAddress } from './riskDb.js';
import { logger } from '../utils/logger.js';

const STATE_FILE = 'tether-blacklist-backfill.json';
const EVENT_LIMIT = Math.min(200, Math.max(20, Number(process.env.TETHER_BACKFILL_EVENT_LIMIT) || 200));
const REQUEST_DELAY_MS = Math.max(250, Number(process.env.TETHER_BACKFILL_REQUEST_DELAY_MS) || 1200);
const DEFAULT_DAYS = Math.max(1, Number(process.env.TETHER_BACKFILL_DAYS) || 3650);
const DEFAULT_MAX_PAGES = Math.max(1, Number(process.env.TETHER_BACKFILL_MAX_PAGES) || 5000);
const args = parseArgs(process.argv.slice(2));

async function main() {
  const state = await loadState();
  const startedAt = Date.now();
  const fromTimestamp = Number(args.fromMs ?? state.fromTimestamp ?? (Date.now() - DEFAULT_DAYS * 86_400_000));
  const maxPages = Number(args.maxPages ?? DEFAULT_MAX_PAGES);
  let pages = 0;
  let added = 0;
  let removed = 0;
  let changed = false;
  const db = await loadRiskDb();
  const phases = ['AddedBlackList', 'RemovedBlackList'];
  let phaseIndex = Math.max(0, phases.indexOf(state.phase ?? 'AddedBlackList'));
  let fingerprint = state.fingerprint ?? null;

  logger.info(`Tether blacklist backfill started. from:${new Date(fromTimestamp).toISOString()} maxPages:${maxPages}`);

  while (phaseIndex < phases.length && pages < maxPages) {
    const eventName = phases[phaseIndex];
    const page = await getContractEventsWithRetry(USDT_CONTRACT, {
      eventName,
      minTimestamp: fromTimestamp,
      onlyConfirmed: true,
      orderBy: 'block_timestamp,asc',
      limit: EVENT_LIMIT,
      fingerprint,
    });
    pages += 1;

    for (const event of page.data ?? []) {
      const address = extractAddress(event);
      if (!address) continue;
      const timestamp = Number(event.block_timestamp ?? event.blockTimestamp ?? Date.now());
      const iso = new Date(timestamp).toISOString();

      if (eventName === 'AddedBlackList') {
        upsertAddress(db, address, {
          isBlacklisted: true,
          sources: ['tether_event_history'],
          lastChecked: iso,
          tetherBlacklistedAt: iso,
        });
        enqueueAddress(db, address, {
          priority: 2,
          depth: 0,
          reason: 'tether_blacklist_history',
        });
        added += 1;
      } else {
        upsertAddress(db, address, {
          isBlacklisted: false,
          wasBlacklisted: true,
          sources: ['tether_event_history_removed'],
          lastChecked: iso,
          unblacklistedAt: iso,
        });
        removed += 1;
      }
      changed = true;
    }

    fingerprint = page.meta?.fingerprint ?? null;
    await saveState({
      phase: eventName,
      fingerprint,
      fromTimestamp,
      completed: false,
      totals: {
        added: Number(state.totals?.added ?? 0) + added,
        removed: Number(state.totals?.removed ?? 0) + removed,
      },
      lastPageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    logger.info(`Tether backfill page done. phase:${eventName} page:${pages} batch:${page.data?.length ?? 0} added:${added} removed:${removed}`);

    if (!fingerprint) {
      phaseIndex += 1;
      fingerprint = null;
    }
    if (phaseIndex < phases.length && pages < maxPages) await delay(REQUEST_DELAY_MS);
  }

  if (changed) await saveRiskDb(db);
  const completed = phaseIndex >= phases.length;
  await saveState({
    phase: phases[phaseIndex] ?? 'done',
    fingerprint,
    fromTimestamp,
    completed,
    totals: {
      added: Number(state.totals?.added ?? 0) + added,
      removed: Number(state.totals?.removed ?? 0) + removed,
    },
    lastRunMs: Date.now() - startedAt,
    updatedAt: new Date().toISOString(),
  });

  logger.info(`Tether blacklist backfill finished. completed:${completed} pages:${pages} added:${added} removed:${removed}`);
}

async function getContractEventsWithRetry(address, options) {
  const delays = [0, 3000, 8000, 15000, 30000];
  let lastError = null;
  for (const waitMs of delays) {
    if (waitMs > 0) await delay(waitMs);
    try {
      return await getContractEvents(address, options);
    } catch (err) {
      lastError = err;
      if (!/HTTP 429/.test(err.message)) throw err;
      logger.warn(`Tether backfill rate limited; retrying: ${err.message}`);
    }
  }
  throw lastError;
}

function extractAddress(event) {
  const result = event.result ?? {};
  const value = result.user ?? result._user ?? result.account ?? result.addr ?? result[0];
  if (!value) return null;
  return normalizeTronAddress(value);
}

function normalizeTronAddress(value) {
  const text = String(value).trim();
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) return text;
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{40}$/.test(hex)) return base58Check(Buffer.from(`41${hex}`, 'hex'));
  if (/^41[0-9a-fA-F]{40}$/.test(hex)) return base58Check(Buffer.from(hex, 'hex'));
  return null;
}

function base58Check(payload) {
  const checksum = crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function base58Encode(buffer) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${buffer.toString('hex')}`);
  let output = '';
  while (value > 0n) {
    const mod = value % 58n;
    output = alphabet[Number(mod)] + output;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    output = alphabet[0] + output;
  }
  return output || alphabet[0];
}

async function loadState() {
  return readJson(STATE_FILE, {
    phase: 'AddedBlackList',
    fingerprint: null,
    fromTimestamp: null,
    completed: false,
    totals: { added: 0, removed: 0 },
    updatedAt: null,
  });
}

async function saveState(state) {
  await writeJson(STATE_FILE, state);
}

function parseArgs(items) {
  const parsed = {};
  for (const item of items) {
    const [key, value] = item.replace(/^--/, '').split('=');
    if (key === 'days') parsed.fromMs = Date.now() - Number(value) * 86_400_000;
    if (key === 'from-ms') parsed.fromMs = Number(value);
    if (key === 'max-pages') parsed.maxPages = Number(value);
  }
  return parsed;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error('Tether blacklist backfill fatal:', err);
  process.exit(1);
});
