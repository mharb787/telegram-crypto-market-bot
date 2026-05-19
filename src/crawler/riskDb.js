import { readJson, writeJson } from '../storage.js';

const DB_FILE = 'risk-db.json';

export async function loadRiskDb() {
  return readJson(DB_FILE, {
    version: 1,
    updatedAt: null,
    addresses: {},
    edges: {},
    queue: [],
    stats: {
      scannedBlacklisted: 0,
      discoveredBlacklisted: 0,
      edges: 0,
    },
  });
}

export async function saveRiskDb(db) {
  db.updatedAt = new Date().toISOString();
  await writeJson(DB_FILE, db);
}

export function upsertAddress(db, address, patch) {
  const current = db.addresses[address] ?? {
    address,
    isBlacklisted: null,
    sources: [],
    firstSeen: new Date().toISOString(),
    lastChecked: null,
    lastScanned: null,
  };

  const sources = new Set([...(current.sources ?? []), ...(patch.sources ?? [])]);
  db.addresses[address] = {
    ...current,
    ...patch,
    sources: [...sources],
  };

  return db.addresses[address];
}

export function enqueueAddress(db, address, { priority = 5, depth = 0, reason = 'discovered' } = {}) {
  if (db.queue.some(item => item.address === address && ['pending', 'running'].includes(item.status))) {
    return false;
  }

  db.queue.push({
    address,
    priority,
    depth,
    reason,
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    nextRunAt: new Date().toISOString(),
  });

  db.queue.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  return true;
}

export function nextQueueItem(db) {
  const now = Date.now();
  return db.queue
    .filter(item => item.status === 'pending' && Date.parse(item.nextRunAt) <= now)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

export function markQueueItem(db, item, patch) {
  const current = db.queue.find(entry => entry.address === item.address && entry.createdAt === item.createdAt);
  if (!current) return;
  Object.assign(current, patch);
}

export function recordEdge(db, edge) {
  const key = edge.txid || `${edge.from}:${edge.to}:${edge.timestamp}:${edge.amount}`;
  if (db.edges[key]) return false;
  db.edges[key] = {
    ...edge,
    createdAt: new Date().toISOString(),
  };
  db.stats.edges = Object.keys(db.edges).length;
  return true;
}

export function getLocalRiskForAddress(db, address) {
  const addressInfo = db.addresses[address] ?? null;
  const directEdges = Object.values(db.edges).filter(edge => edge.from === address || edge.to === address);
  const blacklistedEdges = directEdges.filter(edge => edge.blacklistedAddress);

  return {
    addressInfo,
    directEdges,
    blacklistedEdges,
  };
}
