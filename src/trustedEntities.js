import { readJson, writeJson } from './storage.js';

const TRUSTED_FILE = 'trusted-entities.json';
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
