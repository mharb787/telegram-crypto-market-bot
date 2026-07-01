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
import { investigateAddress } from '../adminInvestigation.js';
import { loadSubscriptions } from '../subscriptions.js';
import { loadUsageLog } from '../usageLog.js';
import { logger } from '../utils/logger.js';

const STATE_FILE = 'tether-blacklist-watcher.json';
const POLL_MS = Math.max(15_000, Number(process.env.TETHER_WATCHER_POLL_MS) || 60_000);
const INITIAL_LOOKBACK_MS = Math.max(60_000, Number(process.env.TETHER_WATCHER_INITIAL_LOOKBACK_MS) || 10 * 60_000);
const OVERLAP_MS = Math.max(0, Number(process.env.TETHER_WATCHER_OVERLAP_MS) || 60_000);
const EVENT_LIMIT = Math.min(200, Math.max(20, Number(process.env.TETHER_WATCHER_EVENT_LIMIT) || 200));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.TETHER_WATCHER_REQUEST_DELAY_MS) || 1000);
const ONCE = process.argv.includes('--once') || process.env.TETHER_WATCHER_ONCE === 'true';
const adminChatIds = parseIdList(process.env.ADMIN_CHAT_IDS);
const blacklistAlertChatIds = parseIdList(process.env.BLACKLIST_ALERT_CHAT_IDS);
const bot = process.env.ADMIN_BOT_TOKEN ? new TelegramBot(process.env.ADMIN_BOT_TOKEN, { polling: false }) : null;

async function main() {
  if (!bot) logger.warn('ADMIN_BOT_TOKEN is not set; Tether watcher notifications are disabled.');
  if (adminChatIds.size === 0) logger.warn('ADMIN_CHAT_IDS is empty; Tether watcher notifications are disabled.');

  logger.info(`Tether blacklist watcher started. poll:${POLL_MS} once:${ONCE}`);
  do {
    try {
      const result = await runOnce();
      if (result.added.length > 0) {
        await notifyAdmins(await formatAddedReport(result.added));
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
  if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);
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
    const page = await getContractEventsWithRetry(USDT_CONTRACT, {
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
    if (fingerprint && REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);
  } while (fingerprint && events.length < 2000);
  return events;
}

async function getContractEventsWithRetry(address, options) {
  const delays = [0, 3000, 8000, 15000];
  let lastError = null;
  for (const waitMs of delays) {
    if (waitMs > 0) await delay(waitMs);
    try {
      return await getContractEvents(address, options);
    } catch (err) {
      lastError = err;
      const isRateLimited = /HTTP 429/.test(err.message);
      if (!isRateLimited) throw err;
      logger.warn(`Tether event request rate limited; retrying after backoff: ${err.message}`);
    }
  }
  throw lastError;
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
  const recipients = new Set([...adminChatIds, ...blacklistAlertChatIds]);
  if (!bot || recipients.size === 0) return;
  for (const chatId of recipients) {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch((err) => logger.warn(`Tether watcher notify failed for ${chatId}: ${err.message}`));
  }
}

async function formatAddedReport(items) {
  const [riskDb, usage, subs] = await Promise.all([
    loadRiskDb(),
    loadUsageLog(),
    loadSubscriptions(),
  ]);

  const lines = [
    '<b>🚨 عناوين جديدة دخلت قائمة Tether السوداء</b>',
    '',
    `العدد: <b>${items.length}</b>`,
    '',
    ...items.slice(0, 10).map((item, index) => {
      const investigation = investigateAddress(item.address, { riskDb, usage, subs, limit: 20 });
      return formatAddedItem(item, index, investigation);
    }),
  ];
  if (items.length > 10) lines.push('', `... و ${items.length - 10} عنوان آخر`);
  return lines.join('\n');
}

function formatAddedItem(item, index, investigation) {
  return [
    `${index + 1}. ${addressLink(item.address)}`,
    `وقت الحظر: <code>${shortDate(item.timestamp)}</code>`,
    item.txid ? `العملية: <a href="https://tronscan.org/#/transaction/${encodeURIComponent(item.txid)}">TronScan</a>` : null,
    item.block ? `البلوك: <code>${escapeHtml(item.block)}</code>` : null,
    `تحقق مباشر: <code>${verificationLabel(item.verified)}</code>`,
    '',
    ...formatCommunityImpact(investigation),
  ].filter(Boolean).join('\n');
}

function formatCommunityImpact(result) {
  const impacted =
    result.summary.directUserMatches +
    result.summary.directWatchMatches +
    result.summary.directRelatedUserMatches +
    result.summary.indirectRelatedUserMatches;

  const lines = [
    '<b>أثره داخل مجتمع البوت</b>',
    `• بحث مباشر عن العنوان: <b>${result.summary.directUserMatches}</b> مستخدم`,
    `• متابعة مباشرة للعنوان: <b>${result.summary.directWatchMatches}</b> مستخدم`,
    `• مستخدمون بحثوا/تابعوا عناوين مرتبطة مباشرة: <b>${result.summary.directRelatedUserMatches}</b>`,
    `• مستخدمون ضمن ارتباط غير مباشر: <b>${result.summary.indirectRelatedUserMatches}</b>`,
    `• علاقات مباشرة في قاعدة البوت: <b>${result.summary.directRelations}</b>`,
  ];

  if (impacted === 0) {
    lines.push('لا يوجد أثر ظاهر داخل مجتمع البوت حاليا.');
    return lines;
  }

  const directHits = formatImpactHits(result.directHits, 'أهم ارتباط مباشر');
  const indirectHits = formatImpactHits(result.indirectHits, 'أهم ارتباط غير مباشر');
  return [...lines, ...directHits, ...indirectHits];
}

function formatImpactHits(items, label) {
  if (!items?.length) return [];
  return items.slice(0, 3).map((item) => {
    const users = [...(item.users ?? []), ...(item.watchers ?? [])]
      .slice(0, 3)
      .map(formatUser)
      .join('، ');
    return `• ${label}: ${addressLink(item.address)} | المستخدمون: ${users || '-'} | علاقات: <b>${item.edgeCount}</b>`;
  });
}

function verificationLabel(value) {
  if (value === true) return 'محظور';
  if (value === false) return 'غير مؤكد';
  return 'تعذر التحقق';
}

function addressLink(address) {
  const safe = escapeHtml(address);
  return `<a href="https://tronscan.org/#/address/${encodeURIComponent(address)}">${safe}</a>`;
}

function formatUser(user) {
  return escapeHtml(user.username || user.name || user.userId || '-');
}

function shortDate(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${pad(date.getUTCMonth() + 1)}-${String(date.getUTCFullYear()).slice(-2)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
