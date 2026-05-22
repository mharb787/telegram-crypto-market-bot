import 'dotenv/config';
import { isBlacklistedByTether } from '../api/trongrid.js';
import { loadRiskDb } from './riskDb.js';
import { loadSubscriptions } from '../subscriptions.js';
import { readJson, writeJson } from '../storage.js';
import { ensureTrustedLargeUsdtHolder, getTrustedEntity } from '../trustedEntities.js';
import { logger } from '../utils/logger.js';

const STATE_FILE = 'platform-crawler-state.json';
const ONCE = process.argv.includes('--once');
const SCAN_INTERVAL_MS = Math.max(60_000, Number(process.env.PLATFORM_CRAWLER_INTERVAL_MS) || 60 * 60_000);
const SCAN_DELAY_MS = Math.max(250, Number(process.env.PLATFORM_CRAWLER_DELAY_MS) || 1500);
const MAX_PER_RUN = Math.max(10, Number(process.env.PLATFORM_CRAWLER_MAX_PER_RUN) || 500);

async function main() {
  do {
    await runOnce();
    if (ONCE) break;
    logger.info(`Platform crawler sleeping ${Math.round(SCAN_INTERVAL_MS / 60_000)} minutes`);
    await delay(SCAN_INTERVAL_MS);
  } while (true);
}

async function runOnce() {
  const candidates = await collectCandidateAddresses();
  const state = await loadState();
  const batch = selectBatch(candidates, state.cursor ?? 0, MAX_PER_RUN);
  let checked = 0;
  let added = 0;
  let skippedTrusted = 0;
  let skippedBlacklisted = 0;
  let unknown = 0;

  logger.info(`Platform crawler started. candidates:${candidates.length} cursor:${state.cursor ?? 0} batch:${batch.length}`);

  for (const address of batch) {
    if (await getTrustedEntity(address)) {
      skippedTrusted += 1;
      continue;
    }

    checked += 1;
    const blacklisted = await isBlacklistedByTether(address);
    if (blacklisted === true) {
      skippedBlacklisted += 1;
      await delay(SCAN_DELAY_MS);
      continue;
    }
    if (blacklisted !== false) {
      unknown += 1;
      await delay(SCAN_DELAY_MS);
      continue;
    }

    const entity = await ensureTrustedLargeUsdtHolder(address);
    if (entity) {
      added += 1;
      logger.info(`Platform crawler trusted ${address} as ${entity.name} source:${entity.source}`);
    }
    await delay(SCAN_DELAY_MS);
  }

  state.cursor = candidates.length ? ((state.cursor ?? 0) + batch.length) % candidates.length : 0;
  state.lastRunAt = new Date().toISOString();
  state.lastCandidates = candidates.length;
  await saveState(state);

  logger.info(`Platform crawler done. checked:${checked} added:${added} trusted_skipped:${skippedTrusted} blacklisted:${skippedBlacklisted} unknown:${unknown}`);
}

async function collectCandidateAddresses() {
  const seen = new Set();
  const add = address => {
    if (isTronAddress(address)) seen.add(address);
  };

  const riskDb = await loadRiskDb();
  for (const item of Object.values(riskDb.addresses ?? {})) add(item.address);
  for (const edge of Object.values(riskDb.edges ?? {})) {
    add(edge.from);
    add(edge.to);
    add(edge.counterparty);
    add(edge.blacklistedAddress);
  }

  const subs = await loadSubscriptions();
  for (const user of Object.values(subs.users ?? {})) {
    for (const watch of user.watches ?? []) add(watch.address);
  }

  return [...seen];
}

async function loadState() {
  return readJson(STATE_FILE, { cursor: 0, lastRunAt: null, lastCandidates: 0 });
}

async function saveState(state) {
  await writeJson(STATE_FILE, state);
}

function selectBatch(candidates, cursor, limit) {
  if (candidates.length === 0) return [];
  const start = Math.max(0, Math.min(Number(cursor) || 0, candidates.length - 1));
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
  return ordered.slice(0, limit);
}

function isTronAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(value ?? ''));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  logger.error('Platform crawler fatal:', err.message);
  process.exitCode = 1;
});
