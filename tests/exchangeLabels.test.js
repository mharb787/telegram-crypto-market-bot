import test from 'node:test';
import assert from 'node:assert/strict';
import { createExchangeTagLookup, parseExchangeTag } from '../src/api/tronscan.js';
const address = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';

test('only an official blueTag identifying the exact platform qualifies', () => {
  assert.equal(parseExchangeTag(address, { blueTag: 'Binance-Cold 2' }).name, 'Binance');
  for (const data of [{}, { blueTag: '' }, { publicTag: 'Binance-Cold 2' },
    { blueTag: 'Not Binance' }, { blueTag: 'Binance scam' }, { blueTag: 'Binance Charity' },
    { blueTag: { name: 'Binance' } }, { blueTag: 'Binance', address: 'another' },
    { blueTag: 'Binance', code: '1000' }]) assert.equal(parseExchangeTag(address, data), null);
});

test('headers, temporary cache, concurrent requests, expiry and API failures', async () => {
  let now = 0, calls = 0, failed = false;
  const lookup = createExchangeTagLookup({ now: () => now, key: () => 'test-only', ttlMs: 100,
    failureTtlMs: 10, fetcher: async (url, init) => {
      calls++;
      assert.equal(new URL(url).searchParams.get('address'), address);
      assert.equal(init.headers['TRON-PRO-API-KEY'], 'test-only');
      if (failed) throw new Error('network unavailable');
      return { ok: true, json: async () => ({ blueTag: 'Binance 1' }) };
    } });
  await Promise.all([lookup(address), lookup(address)]);
  assert.equal(calls, 1);
  assert.ok(await lookup(address));
  now = 101; failed = true;
  assert.equal(await lookup(address), null);
  assert.equal(await lookup(address), null);
  assert.equal(calls, 2);
  now = 112; failed = false;
  assert.ok(await lookup(address));
  assert.equal(calls, 3);
});
