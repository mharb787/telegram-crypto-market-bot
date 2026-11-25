import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('direct checks, historical trust, monitoring and background discovery enforce verified labels and Tether priority', async () => {
  const cwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exchange-integration-'));
  process.chdir(dir);
  process.env.TRONSCAN_API_KEY = 'test-only';
  process.env.OKLINK_API_KEY = 'test-only';
  process.env.PLATFORM_CRAWLER_DELAY_MS = '250';
  const realFetch = globalThis.fetch;
  let scenario;
  let tagCalls = 0, blacklistCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const response = data => ({ ok: true, json: async () => data });
    if (u.pathname === '/api/account/tag') {
      tagCalls++;
      assert.equal(init.headers['TRON-PRO-API-KEY'], 'test-only');
      if (scenario.fail) throw new Error('test API failure');
      return response({ blueTag: scenario.tag ?? '' });
    }
    if (u.pathname === '/wallet/triggerconstantcontract') {
      blacklistCalls++;
      return response({ constant_result: scenario.banned === null ? [] : [scenario.banned ? '01' : '00'] });
    }
    if (u.pathname === '/jsonrpc') return response({ result: null });
    if (u.pathname.includes('address-risk-screening')) return response({ code: '0', data: [{ associateBlackAddresses: scenario.high ? 1 : 0 }] });
    if (u.pathname.endsWith('/transactions/trc20')) return response({ data: [] });
    if (u.pathname.endsWith('/transactions')) return response({ data: [] });
    if (u.pathname.startsWith('/v1/accounts/')) return response({ data: [{ create_time: 1600000000000, trc20: [{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: String((scenario.balance ?? 1) * 1000000) }] }] });
    throw new Error(`Unexpected test URL ${u.pathname}`);
  };
  try {
    const { checkOnChain } = await import('../src/validator/onchain.js');
    const { upsertTrustedEntity, getTrustedEntity } = await import('../src/trustedEntities.js');
    const { scanSingleWatchedWallet } = await import('../src/subscriptionTasks.js');
    const { onChainReport } = await import('../src/utils/formatter.js');
    const base = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jw';
    let n = 0;
    async function check(input) {
      scenario = input; tagCalls = 0;
      const addr = base + '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[n++];
      const result = await checkOnChain(addr);
      return { addr, result };
    }
    let row = await check({ balance: 300000, tag: 'Binance' });
    assert.equal(tagCalls, 0); assert.equal(row.result.trustedEntity, null);
    row = await check({ balance: 300000.000001, tag: 'Binance' });
    assert.equal(tagCalls, 1); assert.equal(row.result.trustedEntity.name, 'Binance');
    assert.ok(row.result.trustedEntity.verifiedAt); assert.equal(row.result.trustedEntity.source, 'tronscan_blue_tag');
    scenario = { banned: true, tag: 'Binance' };
    assert.equal(await getTrustedEntity(row.addr), null, 'fresh Tether ban overrides cached official label');
    row = await check({ balance: 1, high: true, tag: 'OKX' });
    assert.equal(tagCalls, 1); assert.equal(row.result.risk, 'safe');
    row = await check({ balance: 1, high: true, tag: '' });
    assert.equal(row.result.risk, 'high'); assert.equal(row.result.trustedEntity, null);
    row = await check({ balance: 400000, high: true, fail: true });
    assert.equal(row.result.risk, 'high'); assert.equal(row.result.trustedEntity, null);
    row = await check({ balance: 400000, banned: true, tag: 'Binance' });
    assert.equal(row.result.risk, 'blacklisted'); assert.equal(row.result.trustedEntity, null);
    row = await check({ balance: 400000, banned: null, tag: 'Binance' });
    assert.equal(row.result.risk, 'unknown'); assert.equal(row.result.apiError, true);
    assert.equal(row.result.trustedEntity, null);
    assert.ok(!onChainReport(row.addr, String, row.result).includes('✅ غير محظور'));
    const legacy = base + 'Z';
    await upsertTrustedEntity(legacy, { name: 'old', auto: true, source: 'auto_large_usdt_balance' });
    scenario = { tag: '' }; tagCalls = 0;
    assert.equal(await getTrustedEntity(legacy), null); assert.equal(tagCalls, 1);
    const manual = base + 'Y';
    await upsertTrustedEntity(manual, { name: 'Manual', auto: false, source: 'admin' });
    assert.equal((await getTrustedEntity(manual)).name, 'Manual');
    scenario = { banned: true, tag: 'Binance' };
    assert.equal(await getTrustedEntity(manual), null);
    const watch = { id: 'test', address: manual, lastRisk: 'safe', scanProgress: {
      dayKey: new Date().toISOString().slice(0, 10), completedAt: new Date().toISOString() } };
    const before = blacklistCalls;
    const scan = await scanSingleWatchedWallet({ alerts: {} }, { userId: '1', chatId: '1' }, watch, { initialScan: true, periodic: true });
    assert.equal(scan.onchain.risk, 'blacklisted'); assert.ok(!scan.skippedTrusted);
    assert.ok(blacklistCalls > before);
    // Legacy entries must also be rediscovered by the background job.
    scenario = { tag: '', balance: 1 };
    const { runOnce } = await import('../src/crawler/platformCrawler.js');
    await runOnce();
    const state = JSON.parse(await fs.readFile('data/platform-crawler-state.json', 'utf8'));
    assert.ok(state.lastCandidates >= 2);
    assert.equal(await getTrustedEntity(legacy), null);
  } finally {
    globalThis.fetch = realFetch;
    process.chdir(cwd);
    // SQLite connections may remain open until the test process exits.
  }
});
