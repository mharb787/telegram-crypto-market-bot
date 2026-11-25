import { readJson, writeJson } from './storage.js';
import { getAccount, USDT_CONTRACT, isBlacklistedByTether } from './api/trongrid.js';
import { lookupExchangeTag } from './api/tronscan.js';

const TRUSTED_FILE = 'trusted-entities.json';
const MU = 1_000_000;
const PLATFORM_AUTO_USDT_BALANCE = 300000;
const DEFAULT_DB = {
  version: 1,
  updatedAt: null,
  addresses: {},
};

export async function loadTrustedEntities() {
  const db = await readJson(TRUSTED_FILE, DEFAULT_DB);
  db.version ??= 1;
  db.addresses ??= {};
  return db;
}

export async function saveTrustedEntities(db) {
  db.updatedAt = new Date().toISOString();
  await writeJson(TRUSTED_FILE, db);
}

export async function getTrustedEntity(address, options = {}) {
  const db = await loadTrustedEntities();
  const entity = db.addresses?.[address];
  if (!entity) return null;
  const blacklisted = Object.hasOwn(options, 'blacklisted') ? options.blacklisted : await isBlacklistedByTether(address).catch(() => null);
  if (blacklisted !== false) return null;
  if (!entity.auto && !['auto_large_usdt_balance', 'tronscan_blue_tag'].includes(entity.source)) return entity;
  // Historical balance-only entries and expired labels must be verified again.
  const verified = await lookupExchangeTag(address);
  if (!verified) return null;
  if (entity.verifiedAt === verified.verifiedAt && entity.source === verified.source) return entity;
  return upsertTrustedEntity(address, verified);
}

export async function ensureTrustedLargeUsdtHolder(address, knownUsdtBalance = null, options = {}) {
  const existing = await getTrustedEntity(address, options);
  if (existing) return existing;

  const usdtBalance = knownUsdtBalance ?? await fetchUsdtBalance(address);
  if (!options.highRisk && !(usdtBalance > PLATFORM_AUTO_USDT_BALANCE)) return null;
  const verified = await lookupExchangeTag(address);
  const blacklisted = Object.hasOwn(options, 'blacklisted') ? options.blacklisted : await isBlacklistedByTether(address).catch(() => null);
  if (blacklisted !== false) return null;
  if (!verified) return null;

  return upsertTrustedEntity(address, verified);
}

export async function upsertTrustedEntity(address, input = {}) {
  const db = await loadTrustedEntities();
  const now = new Date().toISOString();
  const previous = db.addresses[address] ?? {};
  const entity = {
    address,
    name: input.name ?? previous.name ?? 'Platform',
    type: input.type ?? previous.type ?? 'platform',
    source: input.source ?? previous.source ?? 'admin',
    reason: input.reason ?? previous.reason ?? null,
    auto: Boolean(input.auto ?? previous.auto ?? false),
    blueTag: input.blueTag ?? previous.blueTag ?? null,
    sourceUrl: input.sourceUrl ?? previous.sourceUrl ?? null,
    verifiedAt: input.verifiedAt ?? previous.verifiedAt ?? null,
    firstSeen: previous.firstSeen ?? now,
    lastSeen: now,
  };
  db.addresses[address] = entity;
  await saveTrustedEntities(db);
  return entity;
}

export async function removeTrustedEntity(address) {
  const db = await loadTrustedEntities();
  const existed = Boolean(db.addresses?.[address]);
  if (existed) {
    delete db.addresses[address];
    await saveTrustedEntities(db);
  }
  return existed;
}

export async function listTrustedEntities() {
  const db = await loadTrustedEntities();
  return Object.values(db.addresses ?? {})
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
}

async function fetchUsdtBalance(address) {
  try {
    const account = await getAccount(address);
    const usdtEntry = account?.trc20?.find(t => t[USDT_CONTRACT]);
    return usdtEntry ? Number(usdtEntry[USDT_CONTRACT]) / MU : 0;
  } catch {
    return 0;
  }
}
