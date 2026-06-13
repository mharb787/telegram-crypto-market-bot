import 'dotenv/config';
import crypto from 'node:crypto';
import TelegramBot from 'node-telegram-bot-api';
import {
  getContractEvents,
  isBlacklistedByTether,
  USDT_CONTRACT,
} from '../api/trongrid.js';
import { readJson, writeJson } from '../storage.js';
import {
  enqueueAddress,
  loadRiskDb,
  saveRiskDb,
  upsertAddress,
} from './riskDb.js';
import { logger } from '../utils/logger.js';

const STATE_FILE = 'tether-blacklist-watcher.json';
const POLL_MS = Math.max(15_000, Number(process.env.TETHER_WATCHER_POLL_MS) || 60_000);
const INITIAL_LOOKBACK_MS = Math.max(60_000, Number(process.env.TETHER_WATCHER_INITIAL_LOOKBACK_MS) || 10 * 60_000);
const OVERLAP_MS = Math.max(0, Number(process.env.TETHER_WATCHER_OVERLAP_MS) || 60_000);
const EVENT_LIMIT = Math.min(200, Math.max(20, Number(process.env.TETHER_WATCHER_EVENT_LIMIT) || 200));
const ONCE = process.argv.includes('--once') || process.env.TETHER_WATCHER_ONCE === 'true';
const adminChatIds = parseIdList(process.env.ADMIN_CHAT_IDS);
const bot = process.env.ADMIN_BOT_TOKEN ? new TelegramBot(process.env.ADMIN_BOT_TOKEN, { polling: false }) : null;

async function main() {
  if (!bot) logger.warn('ADMIN_BOT_TOKEN is not set; Tether watcher notifications are disabled.');
  if (adminChatIds.size === 0) logger.warn('ADMIN_CHAT_IDS is empty; Tether watcher notifications are disabled.');

  logger.info(`Tether blacklist watcher started. poll:${POLL_MS} once:${ONCE}`);
  do {
    try {
      const result = await runOnce();
      if (result.added.length > 0) {
        await notifyAdmins(formatAddedReport(result.added));
      }
      if (result.removed.length > 0) {
        logger.info(`Tether watcher observed removed blacklist addresses: ${result.removed.length}`);
      }
      logger.info(`Tether watcher cycle done. added:${result.added.length} removed:${result.removed.length}`);
    } catch (err) {
      logger.warn(`Tether blacklist watcher cycle failed: ${err.message}`);
    }

    if (ONCE) break;
    await delay(POLL_MS);
  } while (true);
}

async function runOnce() {
  const state = await loadState();
  const from = Math.max(0, Number(state.lastTimestamp ?? (Date.now() - INITIAL_LOOKBACK_MS)) - OVERLAP_MS);
  const seen = new Set(state.seenEventIds ?? []);
  const addedEvents = await fetchEvents('AddedBlackList', from);
  const removedEvents = await fetchEvents('RemovedBlackList', from);
  const allEvents = [...addedEvents, ...removedEvents]
    .sort((a, b) => Number(a.block_timestamp ?? 0) - Number(b.block_timestamp ?? 0));
  const db = await loadRiskDb();
  const added = [];
  const removed = [];
  let changed = false;
  let lastTimestamp = Number(state.lastTimestamp ?? 0);

  for (const event of allEvents) {
    const eventId = eventIdFor(event);
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const address = extractAddress(event);
    if (!address) {
      logger.warn(`Could not extract blacklist address from event: ${JSON.stringify(event).slice(0, 300)}`);
      continue;
    }

    const eventName = event.event_name ?? event.eventName;
    const timestamp = Number(event.block_timestamp ?? event.blockTimestamp ?? Date.now());
    lastTimestamp = Math.max(lastTimestamp, timestamp);

    if (eventName === 'AddedBlackList') {
      const current = db.addresses?.[address];
      const wasKnownBlacklisted = current?.isBlacklisted === true;
      const verified = await verifyBlacklisted(address);
      upsertAddress(db, address, {
        isBlacklisted: true,
        sources: ['tether_event'],
        lastChecked: new Date(timestamp).toISOString(),
        tetherBlacklistedAt: new Date(timestamp).toISOString(),
      });
      enqueueAddress(db, address, {
        priority: 1,
        depth: 0,
        reason: 'tether_added_blacklist_event',
      });
      changed = true;
      if (!wasKnownBlacklisted) {
        added.push({
          address,
          timestamp,
          txid: event.transaction_id ?? event.transactionId ?? null,
          block: event.block_number ?? event.blockNumber ?? null,
          verified,
        });
      }
    } else if (eventName === 'RemovedBlackList') {
      upsertAddress(db, address, {
        isBlacklisted: false,
        wasBlacklisted: true,
        sources: ['tether_event_removed'],
        lastChecked: new Date(timestamp).toISOString(),
        unblacklistedAt: new Date(timestamp).toISOString(),
      });
      changed = true;
      removed.push({
        address,
        timestamp,
        txid: event.transaction_id ?? event.transactionId ?? null,
        block: event.block_number ?? event.blockNumber ?? null,
      });
    }
  }

  if (changed) await saveRiskDb(db);
  await saveState({
    lastTimestamp: Math.max(lastTimestamp, Date.now() - OVERLAP_MS),
    seenEventIds: [...seen].slice(-1000),
    updatedAt: new Date().toISOString(),
  });

  return { added, removed };
}

async function fetchEvents(eventName, minTimestamp) {
  const events = [];
  let fingerprint = null;
  do {
    const page = await getContractEvents(USDT_CONTRACT, {
      eventName,
      minTimestamp,
      onlyConfirmed: true,
      orderBy: 'block_timestamp,asc',
      limit: EVENT_LIMIT,
      fingerprint,
    });
    const batch = page.data ?? [];
    events.push(...batch);
    fingerprint = page.meta?.fingerprint ?? null;
  } while (fingerprint && events.length < 2000);
  return events;
}

async function verifyBlacklisted(address) {
  try {
    return await isBlacklistedByTether(address);
  } catch (err) {
    logger.warn(`Blacklist event verification failed for ${address}: ${err.message}`);
    return null;
  }
}

function extractAddress(event) {
  const result = event.result ?? {};
  const value = result.user ?? result._user ?? result.account ?? result.addr ?? result[0];
  if (!value) return null;
  return normalizeTronAddress(value);
}

function normalizeTronAddress(value) {
  const text = String(value).trim();
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) return text;
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{40}$/.test(hex)) return base58Check(Buffer.from(`41${hex}`, 'hex'));
  if (/^41[0-9a-fA-F]{40}$/.test(hex)) return base58Check(Buffer.from(hex, 'hex'));
  return null;
}

function base58Check(payload) {
  const checksum = crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function base58Encode(buffer) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${buffer.toString('hex')}`);
  let output = '';
  while (value > 0n) {
    const mod = value % 58n;
    output = alphabet[Number(mod)] + output;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    output = alphabet[0] + output;
  }
  return output || alphabet[0];
}

function eventIdFor(event) {
  return [
    event.event_name ?? event.eventName ?? 'event',
    event.transaction_id ?? event.transactionId ?? 'tx',
    event.log_index ?? event.logIndex ?? '0',
    event.block_timestamp ?? event.blockTimestamp ?? '0',
  ].join(':');
}

async function loadState() {
  return readJson(STATE_FILE, {
    lastTimestamp: null,
    seenEventIds: [],
    updatedAt: null,
  });
}

async function saveState(state) {
  await writeJson(STATE_FILE, state);
}

async function notifyAdmins(message) {
  if (!bot || adminChatIds.size === 0) return;
  for (const chatId of adminChatIds) {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch((err) => logger.warn(`Tether watcher notify failed for ${chatId}: ${err.message}`));
  }
}

function formatAddedReport(items) {
  const lines = [
    '<b>🚨 عناوين جديدة دخلت قائمة Tether السوداء</b>',
    '',
    `العدد: <b>${items.length}</b>`,
    '',
    ...items.slice(0, 20).map((item, index) => [
      `${index + 1}. <code>${item.address}</code>`,
      `الوقت: <code>${shortDate(item.timestamp)}</code>`,
      item.txid ? `العملية: <a href="https://tronscan.org/#/transaction/${item.txid}">TronScan</a>` : null,
      item.block ? `البلوك: <code>${item.block}</code>` : null,
      `تحقق مباشر: <code>${item.verified === true ? 'محظور' : item.verified === false ? 'غير مؤكد' : 'تعذر التحقق'}</code>`,
    ].filter(Boolean).join('\n')),
  ];
  if (items.length > 20) lines.push('', `... و ${items.length - 20} عنوان آخر`);
  return lines.join('\n');
}

function shortDate(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${pad(date.getUTCMonth() + 1)}-${String(date.getUTCFullYear()).slice(-2)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function parseIdList(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error('Tether blacklist watcher fatal:', err);
  process.exit(1);
});
