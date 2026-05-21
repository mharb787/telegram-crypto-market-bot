import { readJson, writeJson } from './storage.js';
import { getAccount, USDT_CONTRACT } from './api/trongrid.js';

const TRUSTED_FILE = 'trusted-entities.json';
const MU = 1_000_000;
const PLATFORM_AUTO_USDT_BALANCE = Math.max(100000, Number(process.env.PLATFORM_AUTO_USDT_BALANCE) || 5000000);
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

export async function getTrustedEntity(address) {
  const db = await loadTrustedEntities();
  return db.addresses?.[address] ?? null;
}

export async function ensureTrustedLargeUsdtHolder(address, knownUsdtBalance = null) {
  if (await getTrustedEntity(address)) return null;

  const usdtBalance = knownUsdtBalance ?? await fetchUsdtBalance(address);
  if (usdtBalance < PLATFORM_AUTO_USDT_BALANCE) return null;

  return upsertTrustedEntity(address, {
    name: 'منصة مركزية',
    type: 'platform',
    source: 'auto_large_usdt_balance',
    reason: `usdt_balance:${Math.floor(usdtBalance)}`,
    auto: true,
  });
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
