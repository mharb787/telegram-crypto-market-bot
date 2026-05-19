import { logger } from '../utils/logger.js';

const BASE_URL = process.env.OKLINK_API_URL ?? 'https://www.oklink.com';
const API_KEY = process.env.OKLINK_API_KEY;

export async function screenTronAddressRisk(address) {
  if (!API_KEY) {
    return {
      available: false,
      source: 'OKLink KYA',
      reason: 'OKLINK_API_KEY is not configured',
    };
  }

  const url = new URL('/api/v5/tracker/kya/address-risk-screening', BASE_URL);
  url.searchParams.set('network', 'TRON');
  url.searchParams.set('address', address);

  try {
    const response = await fetch(url, {
      headers: {
        'Ok-Access-Key': API_KEY,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.code !== '0') {
      throw new Error(payload.msg || `HTTP ${response.status}`);
    }

    const item = payload.data?.[0] ?? null;
    if (!item) {
      return { available: true, source: 'OKLink KYA', level: null, associatedBlackAddresses: 0 };
    }

    return {
      available: true,
      source: 'OKLink KYA',
      address: item.address ?? address,
      level: item.level ?? null,
      associatedBlackAddresses: Number(item.associateBlackAddresses ?? 0),
      interactionTime: Number(item.interactionTime ?? 0),
      amount: Number(item.amount ?? 0),
      maliciousAddressList: item.maliciousAddressList ?? [],
      raw: item,
    };
  } catch (err) {
    logger.warn(`OKLink address risk screening failed: ${err.message}`);
    return {
      available: false,
      source: 'OKLink KYA',
      reason: err.message,
    };
  }
}

