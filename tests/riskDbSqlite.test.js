import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('migrates JSON to SQLite and keeps indexed reads and incremental writes consistent', async () => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'risk-db-sqlite-'));
  try {
    process.chdir(tempDir);
    await fs.mkdir('data');
    await fs.writeFile('data/risk-db.json', JSON.stringify({
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      addresses: {
        A: { address: 'A', isBlacklisted: false, sources: ['seed'], firstSeen: '2026-01-01T00:00:00.000Z' },
        B: { address: 'B', isBlacklisted: true, sources: ['tether'], firstSeen: '2026-01-01T00:00:00.000Z' },
      },
      edges: {
        edge1: { txid: 'edge1', from: 'A', to: 'B', blacklistedAddress: 'B', amount: 10, timestamp: 1 },
      },
      queue: [{ address: 'B', priority: 1, depth: 0, reason: 'seed', status: 'pending', attempts: 0, createdAt: '2026-01-01T00:00:00.000Z', nextRunAt: '2026-01-01T00:00:00.000Z' }],
      stats: { scannedBlacklisted: 0, discoveredBlacklisted: 1, edges: 1 },
    }));

    const moduleUrl = new URL('../src/crawler/riskDb.js', import.meta.url);
    moduleUrl.searchParams.set('test', String(Date.now()));
    const riskDb = await import(moduleUrl.href);
    const migrated = riskDb.migrateLegacyRiskDb({ backup: true });
    assert.equal(migrated.migrated, true);
    assert.equal((await riskDb.queryLocalRiskForAddress('A')).blacklistedEdges.length, 1);
    assert.deepEqual([...await riskDb.getBlacklistedAddressSet(['A', 'B'])], ['B']);

    const snapshot = await riskDb.loadRiskDb();
    riskDb.upsertAddress(snapshot, 'C', { isBlacklisted: true, sources: ['test'] });
    riskDb.enqueueAddress(snapshot, 'C', { priority: 2, reason: 'test' });
    riskDb.recordEdge(snapshot, { txid: 'edge2', from: 'C', to: 'A', blacklistedAddress: 'C', amount: 5, timestamp: 2 });
    await riskDb.saveRiskDb(snapshot);

    const firstWriter = await riskDb.loadRiskDb();
    const secondWriter = await riskDb.loadRiskDb();
    riskDb.upsertAddress(firstWriter, 'F', { isBlacklisted: false, sources: ['first'] });
    riskDb.upsertAddress(secondWriter, 'G', { isBlacklisted: true, sources: ['second'] });
    await riskDb.saveRiskDb(firstWriter);
    const concurrentSave = await riskDb.saveRiskDb(secondWriter);
    assert.equal(concurrentSave.concurrentUpdate, true);
    assert.equal((await riskDb.getRiskAddressInfo('F')).isBlacklisted, false);
    assert.equal((await riskDb.getRiskAddressInfo('G')).isBlacklisted, true);

    await riskDb.persistRiskFindingsToStore({
      address: 'D',
      isBanned: true,
      interactions: [{ txid: 'edge3', counterparty: 'E', direction: 'received', amount: 7, token: 'USDT', timestamp: 3 }],
    });
    const claimed = await riskDb.claimNextRiskQueueItem();
    assert.equal(claimed.status, 'running');
    await riskDb.failRiskQueueItem(claimed, 'temporary', { retryDelayMs: 0 });
    const retried = await riskDb.claimNextRiskQueueItem();
    await riskDb.completeRiskQueueItem({
      item: retried,
      edges: [],
      counterpartyChecks: [],
      transferCount: 0,
      counterpartyCount: 0,
    });
    assert.equal((await riskDb.getRiskAddressInfo(retried.address)).lastScanned !== null, true);
    const health = riskDb.inspectRiskDb();
    assert.equal(health.integrity, 'ok');
    assert.equal(health.addresses, 7);
    assert.equal(health.edges, 3);
    assert.equal((await riskDb.queryLocalRiskForAddress('A')).directEdges.length, 2);
    assert.equal((await riskDb.queryLocalRiskForAddress('D')).addressInfo.isBlacklisted, true);
    assert.equal(await fileExists('data/risk-db.pre-sqlite.json'), true);
    riskDb.closeRiskDb();

    const storageUrl = new URL('../src/storage.js', import.meta.url);
    storageUrl.searchParams.set('test', String(Date.now()));
    const storage = await import(storageUrl.href);
    await Promise.all(Array.from({ length: 12 }, (_, id) => storage.writeJson('atomic.json', { id })));
    const atomic = await storage.readJson('atomic.json', null);
    assert.equal(Number.isInteger(atomic.id), true);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
