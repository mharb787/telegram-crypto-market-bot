import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = path.resolve('data');
const SQLITE_FILE = path.join(DATA_DIR, 'risk-db.sqlite');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'risk-db.json');
const LEGACY_BACKUP_FILE = path.join(DATA_DIR, 'risk-db.pre-sqlite.json');
const TRACKER = Symbol('riskDbTracker');
const EDGE_INDEX = Symbol('riskDbEdgeIndex');

let database = null;

export async function loadRiskDb() {
  const db = getDatabase();
  const addresses = {};
  const edges = {};
  const queue = [];

  for (const row of db.prepare('SELECT address, json FROM addresses').iterate()) {
    addresses[row.address] = JSON.parse(row.json);
  }
  for (const row of db.prepare('SELECT edge_key, json FROM edges').iterate()) {
    edges[row.edge_key] = JSON.parse(row.json);
  }
  for (const row of db.prepare('SELECT json FROM queue ORDER BY priority, created_at').iterate()) {
    queue.push(JSON.parse(row.json));
  }

  const model = {
    version: Number(readMeta(db, 'version', '2')),
    updatedAt: readMeta(db, 'updatedAt', null),
    addresses,
    edges,
    queue,
    stats: readStats(db),
  };
  Object.defineProperty(model, TRACKER, {
    value: {
      addresses: new Set(),
      edges: new Set(),
      queue: new Set(),
      revision: Number(readMeta(db, 'revision', '0')),
      stats: { ...model.stats },
    },
    enumerable: false,
  });
  return model;
}

export async function saveRiskDb(model) {
  const db = getDatabase();
  const tracker = model?.[TRACKER];
  const updatedAt = new Date().toISOString();
  let concurrentUpdate = false;
  let revision = 0;
  let mergedStats = model.stats;
  const write = db.transaction(() => {
    const currentRevision = Number(readMeta(db, 'revision', '0'));
    concurrentUpdate = Boolean(tracker && currentRevision !== tracker.revision);
    if (!tracker) {
      replaceDatabaseContents(db, model);
      revision = Number(readMeta(db, 'revision', '0'));
      return;
    }

    for (const address of tracker.addresses) {
      const item = model.addresses?.[address];
      if (item) upsertAddressRow(db, address, item);
    }
    for (const key of tracker.edges) {
      const item = model.edges?.[key];
      if (item) upsertEdgeRow(db, key, item);
    }
    for (const key of tracker.queue) {
      const item = model.queue?.find(entry => queueKey(entry) === key);
      if (item) upsertQueueRow(db, item);
    }

    writeMeta(db, 'updatedAt', updatedAt);
    mergedStats = mergeTrackedStats(db, model.stats, tracker.stats);
    writeMeta(db, 'stats', JSON.stringify(mergedStats));
    revision = bumpRevision(db);
  });
  write.immediate();
  model.updatedAt = updatedAt;
  tracker?.addresses.clear();
  tracker?.edges.clear();
  tracker?.queue.clear();
  if (tracker) tracker.revision = revision;
  if (tracker) tracker.stats = { ...mergedStats };
  model.stats = mergedStats;
  return { revision, concurrentUpdate };
}

export function upsertAddress(model, address, patch) {
  const now = new Date().toISOString();
  const current = model.addresses[address] ?? {
    address,
    isBlacklisted: null,
    sources: [],
    firstSeen: now,
    lastChecked: null,
    lastScanned: null,
  };

  const sources = new Set([...(current.sources ?? []), ...(patch.sources ?? [])]);
  const blacklistedAt = patch.isBlacklisted === true && current.isBlacklisted !== true
    ? (current.blacklistedAt ?? now)
    : current.blacklistedAt;
  model.addresses[address] = {
    ...current,
    ...patch,
    blacklistedAt,
    sources: [...sources],
  };
  markDirty(model, 'addresses', address);
  return model.addresses[address];
}

export function enqueueAddress(model, address, { priority = 5, depth = 0, reason = 'discovered' } = {}) {
  if (model.queue.some(item => item.address === address && ['pending', 'running'].includes(item.status))) {
    return false;
  }

  const item = {
    address,
    priority,
    depth,
    reason,
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    nextRunAt: new Date().toISOString(),
  };
  model.queue.push(item);
  model.queue.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  markDirty(model, 'queue', queueKey(item));
  return true;
}

export function nextQueueItem(model) {
  const now = Date.now();
  return model.queue
    .filter(item => item.status === 'pending' && Date.parse(item.nextRunAt) <= now)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

export function markQueueItem(model, item, patch) {
  const current = model.queue.find(entry => entry.address === item.address && entry.createdAt === item.createdAt);
  if (!current) return;
  Object.assign(current, patch);
  markDirty(model, 'queue', queueKey(current));
}

export function recordEdge(model, edge) {
  const key = edge.txid || `${edge.from}:${edge.to}:${edge.timestamp}:${edge.amount}`;
  if (model.edges[key]) return false;
  model.edges[key] = { ...edge, createdAt: new Date().toISOString() };
  model.stats ??= {};
  const current = Number(model.stats.edges);
  model.stats.edges = Number.isSafeInteger(current) && current >= 0 ? current + 1 : Object.keys(model.edges).length;
  markDirty(model, 'edges', key);
  const index = model[EDGE_INDEX];
  if (index) addEdgeToIndex(index, model.edges[key]);
  return true;
}

export function getLocalRiskForAddress(model, address) {
  const addressInfo = model.addresses[address] ?? null;
  const directEdges = [...(getEdgeIndex(model).get(address) ?? [])];
  const blacklistedEdges = directEdges.filter(edge => edge.blacklistedAddress);
  return { addressInfo, directEdges, blacklistedEdges };
}

export async function queryLocalRiskForAddress(address) {
  const db = getDatabase();
  const addressRow = db.prepare('SELECT json FROM addresses WHERE address = ?').get(address);
  const directEdges = db.prepare(`
    SELECT json FROM edges WHERE from_address = ?
    UNION ALL
    SELECT json FROM edges WHERE to_address = ? AND from_address <> ?
  `).all(address, address, address).map(row => JSON.parse(row.json));
  return {
    addressInfo: addressRow ? JSON.parse(addressRow.json) : null,
    directEdges,
    blacklistedEdges: directEdges.filter(edge => edge.blacklistedAddress),
  };
}

export async function getBlacklistedAddressSet(addresses) {
  const db = getDatabase();
  const statement = db.prepare('SELECT is_blacklisted FROM addresses WHERE address = ?');
  const result = new Set();
  for (const address of new Set(addresses)) {
    if (statement.get(address)?.is_blacklisted === 1) result.add(address);
  }
  return result;
}

export async function getRiskDbRevision() {
  return Number(readMeta(getDatabase(), 'revision', '0'));
}

export async function getRiskAddressInfo(address) {
  const row = getDatabase().prepare('SELECT json FROM addresses WHERE address = ?').get(address);
  return row ? JSON.parse(row.json) : null;
}

export async function updateRiskAddress(address, patch, { enqueue = null } = {}) {
  const db = getDatabase();
  const write = db.transaction(() => {
    const previousRow = db.prepare('SELECT json FROM addresses WHERE address = ?').get(address);
    const previous = previousRow ? JSON.parse(previousRow.json) : null;
    const current = upsertAddressDirect(db, address, patch);
    const queued = enqueue ? enqueueDirect(db, address, enqueue) : false;
    touchDatabase(db);
    return { previous, current, queued };
  });
  return write.immediate();
}

export async function listRiskCandidateAddresses() {
  const rows = getDatabase().prepare(`
    SELECT address AS value FROM addresses
    UNION
    SELECT from_address AS value FROM edges WHERE from_address IS NOT NULL
    UNION
    SELECT to_address AS value FROM edges WHERE to_address IS NOT NULL
    UNION
    SELECT blacklisted_address AS value FROM edges WHERE blacklisted_address IS NOT NULL
  `).all();
  return rows.map(row => row.value).filter(Boolean);
}

export async function seedRiskQueue(seeds) {
  const db = getDatabase();
  const write = db.transaction(() => {
    let changed = false;
    const now = new Date().toISOString();
    for (const address of seeds) {
      const current = upsertAddressDirect(db, address, {
        isBlacklisted: true,
        sources: ['seed'],
        lastChecked: now,
      });
      if (!current.lastScanned) changed = enqueueDirect(db, address, { priority: 1, depth: 0, reason: 'seed' }) || changed;
      changed = true;
    }
    for (const row of db.prepare('SELECT address, json FROM addresses WHERE is_blacklisted = 1 AND (last_scanned IS NULL OR last_scanned = ?)').iterate('')) {
      const item = JSON.parse(row.json);
      if (item.lastScanned) continue;
      changed = enqueueDirect(db, row.address, { priority: 2, depth: 0, reason: 'known_blacklisted_unscanned' }) || changed;
    }
    if (changed) touchDatabase(db);
    return db.prepare("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'").get().count;
  });
  return write.immediate();
}

export async function claimNextRiskQueueItem() {
  const db = getDatabase();
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT json FROM queue
      WHERE status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY priority, created_at
      LIMIT 1
    `).get(new Date().toISOString());
    if (!row) return null;
    const item = JSON.parse(row.json);
    Object.assign(item, {
      status: 'running',
      attempts: Number(item.attempts ?? 0) + 1,
      startedAt: new Date().toISOString(),
    });
    upsertQueueRow(db, item);
    touchDatabase(db);
    return item;
  });
  return claim.immediate();
}

export async function completeRiskQueueItem({ item, edges, counterpartyChecks, transferCount, counterpartyCount }) {
  const db = getDatabase();
  const complete = db.transaction(() => {
    const now = new Date().toISOString();
    for (const edge of edges) {
      const key = edge.txid || `${edge.from}:${edge.to}:${edge.timestamp}:${edge.amount}`;
      insertEdgeRow(db, key, { ...edge, createdAt: edge.createdAt ?? now });
    }

    let discovered = 0;
    for (const result of counterpartyChecks) {
      const previous = db.prepare('SELECT is_blacklisted FROM addresses WHERE address = ?').get(result.address);
      upsertAddressDirect(db, result.address, {
        isBlacklisted: result.blacklisted,
        sources: ['crawler_check'],
        lastChecked: now,
      });
      if (result.blacklisted === true && previous?.is_blacklisted !== 1) {
        discovered += 1;
        enqueueDirect(db, result.address, {
          priority: Number(item.priority ?? 1) + 1,
          depth: Number(item.depth ?? 0) + 1,
          reason: `counterparty_of:${item.address}`,
        });
      }
    }

    upsertAddressDirect(db, item.address, {
      isBlacklisted: true,
      sources: ['crawler'],
      lastScanned: now,
      scannedTransfers: transferCount,
      scannedCounterparties: counterpartyCount,
    });
    Object.assign(item, {
      status: 'done',
      finishedAt: now,
      transfers: transferCount,
      counterparties: counterpartyCount,
    });
    upsertQueueRow(db, item);

    const stats = readStats(db);
    stats.scannedBlacklisted = Number(stats.scannedBlacklisted ?? 0) + 1;
    stats.discoveredBlacklisted = Number(stats.discoveredBlacklisted ?? 0) + discovered;
    stats.edges = db.prepare('SELECT COUNT(*) AS count FROM edges').get().count;
    writeMeta(db, 'stats', JSON.stringify(stats));
    touchDatabase(db, now);
    return { discovered };
  });
  return complete.immediate();
}

export async function failRiskQueueItem(item, errorMessage, { maxAttempts = 3, retryDelayMs = 30_000 } = {}) {
  const db = getDatabase();
  const fail = db.transaction(() => {
    Object.assign(item, {
      status: Number(item.attempts ?? 0) >= maxAttempts ? 'failed' : 'pending',
      error: errorMessage,
      nextRunAt: new Date(Date.now() + retryDelayMs).toISOString(),
    });
    upsertQueueRow(db, item);
    touchDatabase(db);
  });
  fail.immediate();
}

export async function pendingRiskQueueCount() {
  return getDatabase().prepare("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'").get().count;
}

export async function persistRiskFindingsToStore({ address, isBanned, interactions }) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    let changed = false;

    if (isBanned === true) {
      upsertAddressDirect(db, address, { isBlacklisted: true, sources: ['user_check'], lastChecked: now });
      enqueueDirect(db, address, { priority: 1, depth: 0, reason: 'user_checked_blacklisted' });
      changed = true;
    }

    for (const item of interactions) {
      upsertAddressDirect(db, item.counterparty, {
        isBlacklisted: true,
        sources: ['user_check_counterparty'],
        lastChecked: now,
      });
      enqueueDirect(db, item.counterparty, {
        priority: 2,
        depth: 0,
        reason: `counterparty_of_user_check:${address}`,
      });
      const isSent = item.direction === 'sent';
      const edge = {
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
        createdAt: now,
      };
      const key = edge.txid || `${edge.from}:${edge.to}:${edge.timestamp}:${edge.amount}`;
      insertEdgeRow(db, key, edge);
      changed = true;
    }

    if (changed) {
      const stats = readStats(db);
      stats.edges = db.prepare('SELECT COUNT(*) AS count FROM edges').get().count;
      writeMeta(db, 'stats', JSON.stringify(stats));
      writeMeta(db, 'updatedAt', now);
      bumpRevision(db);
    }
    return changed;
  });
  return write.immediate();
}

export function migrateLegacyRiskDb({ backup = true } = {}) {
  const db = getDatabase({ autoMigrate: false });
  const addressCount = db.prepare('SELECT COUNT(*) AS count FROM addresses').get().count;
  const edgeCount = db.prepare('SELECT COUNT(*) AS count FROM edges').get().count;
  if (addressCount > 0 || edgeCount > 0) {
    return { migrated: false, reason: 'database-not-empty', addressCount, edgeCount };
  }
  if (!fs.existsSync(LEGACY_JSON_FILE)) {
    return { migrated: false, reason: 'legacy-json-missing', addressCount: 0, edgeCount: 0 };
  }

  if (backup && !fs.existsSync(LEGACY_BACKUP_FILE)) {
    fs.copyFileSync(LEGACY_JSON_FILE, LEGACY_BACKUP_FILE, fs.constants.COPYFILE_EXCL);
  }
  const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf8'));
  const importData = db.transaction(() => replaceDatabaseContents(db, legacy));
  importData.immediate();
  return {
    migrated: true,
    addressCount: Object.keys(legacy.addresses ?? {}).length,
    edgeCount: Object.keys(legacy.edges ?? {}).length,
    queueCount: (legacy.queue ?? []).length,
    sqliteFile: SQLITE_FILE,
    backupFile: backup ? LEGACY_BACKUP_FILE : null,
  };
}

export function riskDbPaths() {
  return { sqliteFile: SQLITE_FILE, legacyJsonFile: LEGACY_JSON_FILE, legacyBackupFile: LEGACY_BACKUP_FILE };
}

export function inspectRiskDb() {
  const db = getDatabase();
  return {
    integrity: db.pragma('integrity_check', { simple: true }),
    addresses: db.prepare('SELECT COUNT(*) AS count FROM addresses').get().count,
    edges: db.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
    queue: db.prepare('SELECT COUNT(*) AS count FROM queue').get().count,
    sampleAddress: db.prepare('SELECT address FROM addresses LIMIT 1').get()?.address ?? null,
    updatedAt: readMeta(db, 'updatedAt', null),
  };
}

export function closeRiskDb() {
  if (!database) return;
  database.close();
  database = null;
}

function getDatabase({ autoMigrate = true } = {}) {
  if (database) return database;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  database = new Database(SQLITE_FILE, { timeout: 30_000 });
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 30000');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  initializeSchema(database);

  if (autoMigrate) {
    const count = database.prepare('SELECT COUNT(*) AS count FROM addresses').get().count;
    if (count === 0 && fs.existsSync(LEGACY_JSON_FILE)) migrateLegacyRiskDb({ backup: true });
  }
  return database;
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS addresses (
      address TEXT PRIMARY KEY,
      is_blacklisted INTEGER,
      last_scanned TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_addresses_blacklisted ON addresses(is_blacklisted);
    CREATE TABLE IF NOT EXISTS edges (
      edge_key TEXT PRIMARY KEY,
      from_address TEXT,
      to_address TEXT,
      blacklisted_address TEXT,
      timestamp TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_address);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_address);
    CREATE INDEX IF NOT EXISTS idx_edges_blacklisted ON edges(blacklisted_address);
    CREATE TABLE IF NOT EXISTS queue (
      queue_key TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      next_run_at TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_next ON queue(status, next_run_at, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_queue_address_status ON queue(address, status);
  `);
  writeMeta(db, 'version', readMeta(db, 'version', '2'));
  writeMeta(db, 'stats', readMeta(db, 'stats', JSON.stringify(defaultStats())));
  writeMeta(db, 'revision', readMeta(db, 'revision', '0'));
}

function replaceDatabaseContents(db, model = {}) {
  db.exec('DELETE FROM queue; DELETE FROM edges; DELETE FROM addresses;');
  const insertAddress = db.prepare('INSERT INTO addresses(address, is_blacklisted, last_scanned, json) VALUES (?, ?, ?, ?)');
  const insertEdge = db.prepare('INSERT INTO edges(edge_key, from_address, to_address, blacklisted_address, timestamp, json) VALUES (?, ?, ?, ?, ?, ?)');
  const insertQueue = db.prepare('INSERT INTO queue(queue_key, address, status, priority, depth, attempts, created_at, next_run_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  for (const [address, item] of Object.entries(model.addresses ?? {})) {
    insertAddress.run(address, boolToSql(item.isBlacklisted), item.lastScanned ?? null, JSON.stringify(item));
  }
  for (const [key, item] of Object.entries(model.edges ?? {})) {
    insertEdge.run(key, item.from ?? null, item.to ?? null, item.blacklistedAddress ?? null, String(item.timestamp ?? item.date ?? ''), JSON.stringify(item));
  }
  for (const item of model.queue ?? []) {
    insertQueue.run(queueKey(item), item.address, item.status ?? 'pending', Number(item.priority ?? 5), Number(item.depth ?? 0), Number(item.attempts ?? 0), item.createdAt, item.nextRunAt ?? null, JSON.stringify(item));
  }
  const stats = normalizeStats(model.stats, db);
  stats.edges = Object.keys(model.edges ?? {}).length;
  writeMeta(db, 'version', String(model.version ?? 2));
  writeMeta(db, 'updatedAt', model.updatedAt ?? new Date().toISOString());
  writeMeta(db, 'stats', JSON.stringify(stats));
  bumpRevision(db);
}

function upsertAddressDirect(db, address, patch) {
  const row = db.prepare('SELECT json FROM addresses WHERE address = ?').get(address);
  const now = new Date().toISOString();
  const current = row ? JSON.parse(row.json) : {
    address,
    isBlacklisted: null,
    sources: [],
    firstSeen: now,
    lastChecked: null,
    lastScanned: null,
  };
  const sources = new Set([...(current.sources ?? []), ...(patch.sources ?? [])]);
  const blacklistedAt = patch.isBlacklisted === true && current.isBlacklisted !== true
    ? (current.blacklistedAt ?? now)
    : current.blacklistedAt;
  const item = { ...current, ...patch, blacklistedAt, sources: [...sources] };
  upsertAddressRow(db, address, item);
  return item;
}

function enqueueDirect(db, address, { priority, depth, reason }) {
  const existing = db.prepare("SELECT 1 FROM queue WHERE address = ? AND status IN ('pending', 'running') LIMIT 1").get(address);
  if (existing) return false;
  const now = new Date().toISOString();
  upsertQueueRow(db, { address, priority, depth, reason, status: 'pending', attempts: 0, createdAt: now, nextRunAt: now });
  return true;
}

function upsertAddressRow(db, address, item) {
  db.prepare(`
    INSERT INTO addresses(address, is_blacklisted, last_scanned, json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      is_blacklisted = excluded.is_blacklisted,
      last_scanned = excluded.last_scanned,
      json = excluded.json
  `).run(address, boolToSql(item.isBlacklisted), item.lastScanned ?? null, JSON.stringify(item));
}

function upsertEdgeRow(db, key, item) {
  db.prepare(`
    INSERT INTO edges(edge_key, from_address, to_address, blacklisted_address, timestamp, json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(edge_key) DO UPDATE SET
      from_address = excluded.from_address,
      to_address = excluded.to_address,
      blacklisted_address = excluded.blacklisted_address,
      timestamp = excluded.timestamp,
      json = excluded.json
  `).run(key, item.from ?? null, item.to ?? null, item.blacklistedAddress ?? null, String(item.timestamp ?? item.date ?? ''), JSON.stringify(item));
}

function insertEdgeRow(db, key, item) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO edges(edge_key, from_address, to_address, blacklisted_address, timestamp, json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(key, item.from ?? null, item.to ?? null, item.blacklistedAddress ?? null, String(item.timestamp ?? item.date ?? ''), JSON.stringify(item));
  return Number(result.changes);
}

function upsertQueueRow(db, item) {
  const key = queueKey(item);
  if (['pending', 'running'].includes(item.status)) {
    const active = db.prepare("SELECT queue_key FROM queue WHERE address = ? AND status IN ('pending', 'running') LIMIT 1").get(item.address);
    if (active && active.queue_key !== key) return false;
  }
  db.prepare(`
    INSERT INTO queue(queue_key, address, status, priority, depth, attempts, created_at, next_run_at, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue_key) DO UPDATE SET
      status = excluded.status,
      priority = excluded.priority,
      depth = excluded.depth,
      attempts = excluded.attempts,
      next_run_at = excluded.next_run_at,
      json = excluded.json
  `).run(key, item.address, item.status ?? 'pending', Number(item.priority ?? 5), Number(item.depth ?? 0), Number(item.attempts ?? 0), item.createdAt, item.nextRunAt ?? null, JSON.stringify(item));
  return true;
}

function getEdgeIndex(model) {
  if (model[EDGE_INDEX]) return model[EDGE_INDEX];
  const index = new Map();
  for (const edge of Object.values(model.edges ?? {})) addEdgeToIndex(index, edge);
  Object.defineProperty(model, EDGE_INDEX, { value: index, enumerable: false });
  return index;
}

function addEdgeToIndex(index, edge) {
  if (edge.from) add(index, edge.from, edge);
  if (edge.to && edge.to !== edge.from) add(index, edge.to, edge);
}

function add(index, address, edge) {
  if (!index.has(address)) index.set(address, []);
  index.get(address).push(edge);
}

function markDirty(model, type, key) {
  model?.[TRACKER]?.[type]?.add(key);
}

function queueKey(item) {
  return `${item.address}|${item.createdAt}`;
}

function boolToSql(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function defaultStats() {
  return { scannedBlacklisted: 0, discoveredBlacklisted: 0, edges: 0 };
}

function normalizeStats(stats, db) {
  const current = { ...defaultStats(), ...(stats ?? {}) };
  if (!Number.isSafeInteger(Number(current.edges))) {
    current.edges = db.prepare('SELECT COUNT(*) AS count FROM edges').get().count;
  }
  return current;
}

function mergeTrackedStats(db, current = {}, baseline = {}) {
  const stored = readStats(db);
  for (const key of ['scannedBlacklisted', 'discoveredBlacklisted']) {
    const delta = Number(current[key] ?? 0) - Number(baseline[key] ?? 0);
    stored[key] = Math.max(0, Number(stored[key] ?? 0) + delta);
  }
  stored.edges = db.prepare('SELECT COUNT(*) AS count FROM edges').get().count;
  return stored;
}

function readStats(db) {
  try {
    return { ...defaultStats(), ...JSON.parse(readMeta(db, 'stats', '{}')) };
  } catch {
    return defaultStats();
  }
}

function readMeta(db, key, fallback) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? fallback;
}

function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function touchDatabase(db, updatedAt = new Date().toISOString()) {
  writeMeta(db, 'updatedAt', updatedAt);
  return bumpRevision(db);
}

function bumpRevision(db) {
  const revision = Number(readMeta(db, 'revision', '0')) + 1;
  writeMeta(db, 'revision', String(revision));
  return revision;
}
