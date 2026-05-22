import 'dotenv/config';
import { isBlacklistedByTether } from '../api/trongrid.js';
import { loadRiskDb } from './riskDb.js';
import { loadSubscriptions } from '../subscriptions.js';
import { ensureTrustedLargeUsdtHolder, getTrustedEntity } from '../trustedEntities.js';
import { logger } from '../utils/logger.js';

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
  let checked = 0;
  let added = 0;
  let skippedTrusted = 0;
  let skippedBlacklisted = 0;
  let unknown = 0;

  logger.info(`Platform crawler started. candidates:${candidates.length} max:${MAX_PER_RUN}`);

  for (const address of candidates.slice(0, MAX_PER_RUN)) {
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
