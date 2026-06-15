import 'dotenv/config';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { URL } from 'node:url';
import TelegramBot from 'node-telegram-bot-api';
import { loadRiskDb, saveRiskDb, upsertAddress, enqueueAddress } from './crawler/riskDb.js';
import { loadUsageLog } from './usageLog.js';
import { loadSubscriptions, saveSubscriptions, isSubscribed } from './subscriptions.js';
import { listTrustedEntities, upsertTrustedEntity, removeTrustedEntity } from './trustedEntities.js';
import { readJson } from './storage.js';
import { validateTRC20 } from './validator/trc20.js';
import { checkBlacklistConstantContract, isBlacklistedByTether } from './api/trongrid.js';
import { investigateAddress } from './adminInvestigation.js';
import { logger } from './utils/logger.js';

const host = process.env.ADMIN_WEB_HOST || '0.0.0.0';
const port = Number(process.env.ADMIN_WEB_PORT) || 3080;
const token = String(process.env.ADMIN_WEB_TOKEN ?? '').trim();
const userBot = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })
  : null;
const broadcastDelayMs = Math.max(50, Number(process.env.ADMIN_BROADCAST_DELAY_MS) || 120);
let unbanCheckRunning = false;
let tetherBackfillProcess = null;

if (!token || token.length < 16) {
  logger.error('ADMIN_WEB_TOKEN is missing or too short. Refusing to start admin web.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res);
    if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return sendJson(res, 200, { ok: true, data: await buildDashboardData(url.searchParams) });
    }
    if (req.method === 'GET' && url.pathname === '/api/export/blocked') {
      const db = await loadRiskDb();
      const content = Object.values(db.addresses ?? {})
        .filter(item => item.isBlacklisted === true)
        .sort((a, b) => a.address.localeCompare(b.address))
        .map(item => item.address)
        .join('\n') + '\n';
      return sendText(res, 200, content, 'blocked-addresses.txt');
    }
    if (req.method === 'GET' && url.pathname === '/api/export/users') {
      const usage = await loadUsageLog();
      return sendText(res, 200, buildUsersExport(usage), 'bot-users-usage.txt');
    }
    if (req.method === 'POST' && url.pathname === '/api/seeds') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, data: await addSeeds(body.input ?? '') });
    }
    if (req.method === 'POST' && url.pathname === '/api/grant') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, data: await grantSubscription(body.query ?? 'admin-web') });
    }
    if (req.method === 'POST' && url.pathname === '/api/trusted') {
      const body = await readBody(req);
      const address = String(body.address ?? '').trim();
      const validation = validateTRC20(address);
      if (!validation.valid) return sendJson(res, 400, { ok: false, error: 'invalid_address' });
      const entity = await upsertTrustedEntity(address, {
        name: String(body.name ?? '').trim() || 'منصة مركزية',
        type: 'platform',
        source: 'admin_web',
        reason: 'manual_admin_web',
        auto: false,
      });
      return sendJson(res, 200, { ok: true, data: entity });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/trusted/')) {
      const address = decodeURIComponent(url.pathname.slice('/api/trusted/'.length));
      return sendJson(res, 200, { ok: true, data: { removed: await removeTrustedEntity(address) } });
    }
    if (req.method === 'POST' && url.pathname === '/api/broadcast') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, data: await sendBroadcast(String(body.text ?? '')) });
    }
    if (req.method === 'POST' && url.pathname === '/api/unban-check') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, data: await checkUnbannedAddresses(Number(body.limit) || 50) });
    }
    if (req.method === 'POST' && url.pathname === '/api/tether-backfill') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, data: await startTetherBackfill(body) });
    }
    if (req.method === 'POST' && url.pathname === '/api/investigate') {
      const body = await readBody(req);
      const address = String(body.address ?? '').trim();
      const validation = validateTRC20(address);
      if (!validation.valid) return sendJson(res, 400, { ok: false, error: 'invalid_address' });
      const [riskDb, usage, subs] = await Promise.all([loadRiskDb(), loadUsageLog(), loadSubscriptions()]);
      const result = investigateAddress(address, {
        riskDb,
        usage,
        subs,
        limit: clamp(Number(body.limit) || 100, 20, 500),
      });
      return sendJson(res, 200, { ok: true, data: result });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    logger.warn(`Admin web request failed: ${err.message}`);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(port, host, () => {
  logger.info(`Admin web is running on http://${host}:${port}`);
});

async function buildDashboardData(params) {
  const [riskDb, usage, subs, trusted, tetherWatcherState, tetherBackfillState] = await Promise.all([
    loadRiskDb(),
    loadUsageLog(),
    loadSubscriptions(),
    listTrustedEntities(),
    loadTetherWatcherState(),
    loadTetherBackfillState(),
  ]);
  const limit = clamp(Number(params.get('limit')) || 100, 20, 1000);
  const query = String(params.get('q') ?? '').trim().toLowerCase();
  const addresses = Object.values(riskDb.addresses ?? {});
  const edges = Object.values(riskDb.edges ?? {});
  const queue = riskDb.queue ?? [];
  const users = Object.values(usage.users ?? {});
  const subUsers = Object.values(subs.users ?? {});
  const payments = Object.values(subs.payments ?? {});
  const alerts = Object.values(subs.alerts ?? {});
  const watches = collectWatches(subs, alerts);

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeAll({ addresses, edges, queue, users, subUsers, payments, alerts, watches, riskDb, usage, subs, trusted }),
    blocked: addresses
      .filter(item => item.isBlacklisted === true && matchesQuery(item, query))
      .sort((a, b) => dateValue(blockedAddedAt(b)) - dateValue(blockedAddedAt(a)))
      .slice(0, limit),
    queue: queue
      .filter(item => matchesQuery(item, query))
      .sort((a, b) => statusRank(a.status) - statusRank(b.status) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
      .slice(0, limit),
    users: users
      .filter(item => matchesQuery(item, query))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, limit),
    subscriptions: subUsers
      .filter(item => matchesQuery(item, query))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, limit),
    watches: watches
      .filter(item => matchesQuery(item, query))
      .slice(0, limit),
    trusted: trusted
      .filter(item => matchesQuery(item, query))
      .slice(0, limit),
    payments: payments
      .filter(item => matchesQuery(item, query))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, limit),
    alerts: alerts
      .filter(item => matchesQuery(item, query))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, limit),
    tetherWatcher: buildTetherWatcherData(riskDb, tetherWatcherState, tetherBackfillState, limit),
    events: (usage.events ?? [])
      .filter(item => matchesQuery(item, query))
      .slice(-limit)
      .reverse(),
    addressDetails: query && /^t/i.test(query) ? buildAddressDetails(query, riskDb, usage, subs, trusted) : null,
  };
}

async function loadTetherWatcherState() {
  return readJson('tether-blacklist-watcher.json', {
    lastTimestamp: null,
    seenEventIds: [],
    updatedAt: null,
  });
}

async function loadTetherBackfillState() {
  return readJson('tether-blacklist-backfill.json', {
    phase: 'AddedBlackList',
    fingerprint: null,
    fromTimestamp: null,
    completed: false,
    totals: { added: 0, removed: 0 },
    updatedAt: null,
  });
}

function buildTetherWatcherData(riskDb, state, backfill, limit) {
  const addresses = Object.values(riskDb.addresses ?? {})
    .filter(item => (item.sources ?? []).includes('tether_event') || (item.sources ?? []).includes('tether_event_history'))
    .sort((a, b) => dateValue(tetherEventAt(b)) - dateValue(tetherEventAt(a)));
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = addresses.filter(item => String(tetherEventAt(item) ?? '').startsWith(todayKey));
  const removed = Object.values(riskDb.addresses ?? {})
    .filter(item => (item.sources ?? []).includes('tether_event_removed'))
    .sort((a, b) => dateValue(b.unblacklistedAt) - dateValue(a.unblacklistedAt))
    .slice(0, limit);

  return {
    status: watcherStatus(state),
    updatedAt: state.updatedAt ?? null,
    lastEventAt: state.lastTimestamp ? new Date(Number(state.lastTimestamp)).toISOString() : null,
    trackedEvents: state.seenEventIds?.length ?? 0,
    totalAdded: addresses.length,
    addedToday: today.length,
    latestAdded: addresses.slice(0, limit),
    latestRemoved: removed,
    backfill: {
      running: Boolean(tetherBackfillProcess && !tetherBackfillProcess.killed),
      phase: backfill.phase ?? null,
      completed: Boolean(backfill.completed),
      updatedAt: backfill.updatedAt ?? null,
      fromTimestamp: backfill.fromTimestamp ? new Date(Number(backfill.fromTimestamp)).toISOString() : null,
      totals: backfill.totals ?? { added: 0, removed: 0 },
    },
  };
}

function tetherEventAt(item) {
  return item.tetherBlacklistedAt ?? item.blacklistedAt ?? item.firstSeen ?? item.lastChecked ?? null;
}

function watcherStatus(state) {
  const updatedAt = Date.parse(state.updatedAt ?? '');
  if (!Number.isFinite(updatedAt)) return 'لم يسجل دورة بعد';
  const ageMs = Date.now() - updatedAt;
  if (ageMs <= 3 * 60_000) return 'يعمل الآن';
  if (ageMs <= 15 * 60_000) return 'متأخر قليلا';
  return 'يحتاج مراجعة';
}

function summarizeAll({ addresses, edges, queue, users, subUsers, payments, alerts, watches, riskDb, usage, subs, trusted }) {
  const queueStats = countBy(queue, item => item.status ?? 'unknown');
  const now = Date.now();
  const paid = payments.filter(item => item.status === 'paid');
  return {
    risk: {
      total: addresses.length,
      blocked: addresses.filter(item => item.isBlacklisted === true).length,
      unblocked: addresses.filter(item => item.wasBlacklisted === true && item.isBlacklisted === false).length,
      edges: edges.length,
      riskyEdges: edges.filter(item => item.blacklistedAddress).length,
      updatedAt: riskDb.updatedAt,
    },
    queue: {
      pending: queueStats.pending ?? 0,
      running: queueStats.running ?? 0,
      done: queueStats.done ?? 0,
      failed: queueStats.failed ?? 0,
    },
    users: {
      total: users.length,
      searches: users.reduce((sum, user) => sum + Number(user.searches ?? 0), 0),
      uniqueAddresses: new Set(users.flatMap(user => Object.keys(user.addresses ?? {}))).size,
      lastSeen: usage.updatedAt,
    },
    subscriptions: {
      total: subUsers.length,
      active: subUsers.filter(user => isSubscribed(user, now)).length,
      expired: subUsers.filter(user => user.subscription?.expiresAt && !isSubscribed(user, now)).length,
      watches: watches.length,
      revenue: paid.reduce((sum, item) => sum + Number(item.receivedAmount ?? item.amount ?? 0), 0),
      pendingPayments: payments.filter(item => item.status === 'pending').length,
      paidPayments: paid.length,
      alerts: alerts.length,
      openAlerts: alerts.filter(item => !item.muted && Number(item.sentCount ?? 0) < 5).length,
      mutedAlerts: alerts.filter(item => item.muted).length,
      updatedAt: subs.updatedAt,
    },
    trusted: {
      total: trusted.length,
      automatic: trusted.filter(item => item.auto).length,
      manual: trusted.filter(item => !item.auto).length,
    },
  };
}

function collectWatches(subs, alerts) {
  const items = [];
  for (const user of Object.values(subs.users ?? {})) {
    for (const watch of user.watches ?? []) {
      const sentAlerts = alerts
        .filter(alert => alert.userId === user.userId && alert.watchAddress === watch.address)
        .reduce((sum, alert) => sum + Number(alert.sentCount ?? 0), 0);
      items.push({
        ...watch,
        userId: user.userId,
        username: user.username,
        name: user.name,
        chatId: user.chatId,
        subscriptionActive: isSubscribed(user),
        sentAlerts,
      });
    }
  }
  return items.sort((a, b) => (b.lastCheckedAt ?? b.createdAt ?? '').localeCompare(a.lastCheckedAt ?? a.createdAt ?? ''));
}

function buildAddressDetails(addressQuery, riskDb, usage, subs, trusted) {
  const address = Object.keys(riskDb.addresses ?? {}).find(item => item.toLowerCase() === addressQuery) ?? addressQuery;
  const info = riskDb.addresses?.[address] ?? null;
  const edges = Object.values(riskDb.edges ?? {}).filter(edge => edge.from === address || edge.to === address).slice(0, 50);
  const searchedBy = Object.values(usage.users ?? {})
    .filter(user => user.addresses?.[address])
    .map(user => ({ userId: user.userId, username: user.username, name: user.name, count: user.addresses[address].count, lastSeen: user.addresses[address].lastSeen }));
  const watches = collectWatches(subs, Object.values(subs.alerts ?? {})).filter(item => item.address === address);
  const trust = trusted.find(item => item.address === address) ?? null;
  return { address, info, edges, searchedBy, watches, trust };
}

async function addSeeds(input) {
  const candidates = extractAddresses(input);
  const unique = [...new Set(candidates)];
  const invalid = [];
  const added = [];
  const existing = [];
  const db = await loadRiskDb();

  for (const address of unique) {
    const validation = validateTRC20(address);
    if (!validation.valid) {
      invalid.push(address);
      continue;
    }
    upsertAddress(db, address, {
      isBlacklisted: true,
      sources: ['admin_web_seed'],
      lastChecked: new Date().toISOString(),
    });
    const queued = enqueueAddress(db, address, { priority: 1, depth: 0, reason: 'admin_web_seed' });
    if (queued) added.push(address);
    else existing.push(address);
  }
  if (added.length || existing.length || invalid.length) await saveRiskDb(db);
  return { added, existing, invalid };
}

async function grantSubscription(query, adminId) {
  const subs = await loadSubscriptions();
  const usage = await loadUsageLog();
  const user = findSubscriptionUser(subs, usage, query);
  if (!user) return { ok: false, reason: 'not_found' };

  const now = Date.now();
  const currentExpiry = Date.parse(user.subscription?.expiresAt ?? '');
  const base = Number.isFinite(currentExpiry) && currentExpiry > now ? currentExpiry : now;
  const startedAt = user.subscription?.startedAt ?? new Date(now).toISOString();
  const expiresAt = new Date(base + 30 * 86_400_000).toISOString();
  user.subscription = {
    status: 'active',
    startedAt,
    expiresAt,
    reminders: {},
    grantedBy: String(adminId ?? 'admin_web'),
    grantedAt: new Date(now).toISOString(),
  };
  user.pendingPaymentId = null;
  user.state = null;
  await saveSubscriptions(subs);
  const notification = await notifyGrantedSubscription(user, expiresAt);
  return { ok: true, userId: user.userId, username: user.username, expiresAt, notification };
}

async function notifyGrantedSubscription(user, expiresAt) {
  if (!userBot) return { ok: false, reason: 'user_bot_unavailable' };
  const chatId = user.chatId ?? user.userId;
  if (!chatId) return { ok: false, reason: 'missing_chat_id' };
  try {
    await userBot.sendMessage(chatId, [
      '✅ تم تفعيل اشتراكك بنجاح.',
      '',
      'تم منحك اشتراكا لمدة 30 يوم من قبل الإدارة.',
      `ينتهي الاشتراك: ${shortDate(expiresAt)}`,
      '',
      'يمكنك الآن استخدام الفحص العميق ومتابعة مخاطر المحافظ.',
    ].join('\n'));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function sendBroadcast(text) {
  if (!text.trim()) return { ok: false, reason: 'empty_text' };
  if (!userBot) return { ok: false, reason: 'user_bot_unavailable' };
  const usage = await loadUsageLog();
  const recipients = getBroadcastRecipients(usage);
  const result = { total: recipients.length, sent: 0, failed: 0, failures: [] };
  for (const recipient of recipients) {
    try {
      await userBot.sendMessage(recipient.chatId, text);
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      result.failures.push({ chatId: recipient.chatId, userId: recipient.userId, error: err.message });
    }
    await delay(broadcastDelayMs);
  }
  return result;
}

async function checkUnbannedAddresses(limit) {
  if (unbanCheckRunning) return { checked: 0, unbanned: [], errors: [], skipped: 'الفحص يعمل حاليا' };
  unbanCheckRunning = true;
  try {
    const db = await loadRiskDb();
    const blocked = Object.values(db.addresses ?? {})
      .filter(item => item.isBlacklisted === true)
      .sort((a, b) => (a.lastChecked ?? a.firstSeen ?? '').localeCompare(b.lastChecked ?? b.firstSeen ?? ''))
      .slice(0, clamp(limit, 1, 500));
    const unbanned = [];
    const errors = [];
    const now = new Date().toISOString();

    for (const item of blocked) {
      try {
        const status = await isBlacklistedByTether(item.address);
        if (status === false) {
          const confirmed = await confirmUnbanned(item.address);
          if (confirmed.ok) {
            upsertAddress(db, item.address, {
              isBlacklisted: false,
              wasBlacklisted: true,
              unblacklistedAt: now,
              lastChecked: now,
              sources: ['admin_web_unban_check'],
            });
            unbanned.push(item.address);
          } else {
            errors.push({ address: item.address, error: `unban_not_confirmed:${confirmed.results.join(',')}` });
          }
        } else if (status === true) {
          upsertAddress(db, item.address, {
            isBlacklisted: true,
            lastChecked: now,
            sources: ['admin_web_unban_check'],
          });
        } else {
          errors.push({ address: item.address, error: 'unknown_status' });
        }
      } catch (err) {
        errors.push({ address: item.address, error: err.message });
      }
      await delay(600);
    }
    await saveRiskDb(db);
    return { checked: blocked.length, unbanned, errors };
  } finally {
    unbanCheckRunning = false;
  }
}

async function startTetherBackfill(input = {}) {
  if (tetherBackfillProcess && !tetherBackfillProcess.killed && tetherBackfillProcess.exitCode == null) {
    return { started: false, running: true, pid: tetherBackfillProcess.pid };
  }

  const days = clamp(Number(input.days) || 3650, 1, 10000);
  const maxPages = clamp(Number(input.maxPages) || 5000, 1, 20000);
  const child = spawn(process.execPath, [
    'src/crawler/tetherBlacklistBackfill.js',
    `--days=${days}`,
    `--max-pages=${maxPages}`,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
    detached: false,
  });

  tetherBackfillProcess = child;
  child.on('exit', (code, signal) => {
    logger.info(`Tether backfill process exited. code:${code} signal:${signal ?? '-'}`);
    if (tetherBackfillProcess === child) tetherBackfillProcess = null;
  });
  child.on('error', (err) => {
    logger.warn(`Tether backfill process failed to start: ${err.message}`);
    if (tetherBackfillProcess === child) tetherBackfillProcess = null;
  });

  return { started: true, running: true, pid: child.pid, days, maxPages };
}

async function confirmUnbanned(address) {
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    try {
      const status = await checkBlacklistConstantContract(address);
      results.push(status);
      if (status !== false) return { ok: false, results };
    } catch {
      results.push('error');
      return { ok: false, results };
    }
    if (i < 2) await delay(1500);
  }
  return { ok: true, results };
}

function findSubscriptionUser(subs, usage, query) {
  const normalized = normalizeUserQuery(query);
  if (!normalized) return null;
  const users = subs.users ?? {};
  if (users[normalized]) return users[normalized];
  const usageUser = Object.values(usage.users ?? {}).find(user =>
    normalizeUserQuery(user.userId) === normalized ||
    normalizeUserQuery(user.username) === normalized ||
    normalizeUserQuery(user.chatId) === normalized ||
    normalizeUserQuery(user.name) === normalized
  );
  if (usageUser?.userId && users[String(usageUser.userId)]) return users[String(usageUser.userId)];
  return Object.values(users).find(user =>
    normalizeUserQuery(user.userId) === normalized ||
    normalizeUserQuery(user.username) === normalized ||
    normalizeUserQuery(user.chatId) === normalized ||
    normalizeUserQuery(user.name) === normalized
  ) ?? null;
}

function getBroadcastRecipients(usage) {
  const recipients = new Map();
  for (const user of Object.values(usage.users ?? {})) {
    const chatId = user.chatId ?? user.userId;
    if (!chatId) continue;
    recipients.set(String(chatId), {
      chatId: String(chatId),
      userId: String(user.userId ?? chatId),
    });
  }
  return [...recipients.values()];
}

function buildUsersExport(usage) {
  return Object.values(usage.users ?? {})
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
    .map(user => {
      const addresses = Object.values(user.addresses ?? {})
        .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
        .map(item => `  ${item.address} | count:${item.count} | risk:${item.lastRisk ?? '-'} | last:${item.lastSeen ?? '-'}`)
        .join('\n');
      return `USER ${user.userId} | ${displayUser(user)} | searches:${user.searches ?? 0} | last:${user.lastSeen ?? '-'}\n${addresses}`;
    })
    .join('\n\n') + '\n';
}

function matchesQuery(item, query) {
  if (!query) return true;
  return JSON.stringify(item).toLowerCase().includes(query);
}

function extractAddresses(input) {
  return String(input ?? '').match(/T[1-9A-HJ-NP-Za-km-z]{33}/g) ?? [];
}

function normalizeUserQuery(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function blockedAddedAt(item) {
  return item.blacklistedAt ?? item.tetherBlacklistedAt ?? item.firstSeen ?? item.lastChecked ?? '';
}

function statusRank(status) {
  return { running: 0, pending: 1, failed: 2, done: 3 }[status] ?? 9;
}

function dateValue(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

function shortDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function displayUser(user) {
  return user.username || user.name || user.chatId || user.userId || '-';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isAuthorized(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const headerToken = String(req.headers['x-admin-token'] ?? '').trim();
  const queryToken = String(url.searchParams.get('token') ?? '').trim();
  return bearer === token || headerToken === token || queryToken === token;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, content, filename) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(content);
}

function sendHtml(res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(HTML);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>لوحة مدير آمن</title>
<style>
:root{--bg:#f5f7fb;--panel:#fff;--ink:#132033;--muted:#6b7280;--line:#dfe5ee;--blue:#2563eb;--red:#dc2626;--amber:#d97706;--green:#059669;--shadow:0 10px 30px rgba(15,23,42,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Tahoma,Arial,sans-serif;font-size:14px}button,input,textarea,select{font:inherit}
.app{display:grid;grid-template-columns:260px 1fr;min-height:100vh}.side{background:#111827;color:#e5e7eb;padding:18px;position:sticky;top:0;height:100vh}.brand{font-size:22px;font-weight:700;margin:4px 0 20px}.nav{display:grid;gap:8px}.nav button{border:0;background:transparent;color:#cbd5e1;text-align:right;padding:11px 12px;border-radius:8px;cursor:pointer}.nav button.active,.nav button:hover{background:#1f2937;color:#fff}
.main{padding:22px;display:grid;gap:16px}.top{display:flex;gap:10px;align-items:center;justify-content:space-between}.search{display:flex;gap:8px;flex:1;max-width:760px}.search input{width:100%;border:1px solid var(--line);border-radius:8px;padding:11px 12px;background:#fff}.btn{border:0;border-radius:8px;padding:10px 13px;background:var(--blue);color:#fff;cursor:pointer}.btn.secondary{background:#e5e7eb;color:#111827}.btn.danger{background:var(--red)}.btn.green{background:var(--green)}.btn.amber{background:var(--amber)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:14px}.metric .label{color:var(--muted);font-size:12px}.metric .value{font-size:28px;font-weight:700;margin-top:5px}.metric .sub{color:var(--muted);font-size:12px;margin-top:3px}
.section{display:none}.section.active{display:grid;gap:14px}.tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.tool textarea,.tool input{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;background:#fff}.tool textarea{min-height:90px;resize:vertical}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;box-shadow:var(--shadow)}th,td{border-bottom:1px solid var(--line);padding:10px;text-align:right;vertical-align:top}th{background:#f8fafc;color:#475569;font-weight:700;font-size:12px}tr:hover td{background:#f9fbff}.mono{font-family:Consolas,monospace;direction:ltr;text-align:left}.muted{color:var(--muted)}.tag{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;background:#eef2ff;color:#3730a3}.tag.red{background:#fee2e2;color:#991b1b}.tag.green{background:#dcfce7;color:#166534}.tag.amber{background:#fef3c7;color:#92400e}.details{display:grid;gap:10px}.details pre{white-space:pre-wrap;direction:ltr;text-align:left;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:12px;overflow:auto;max-height:340px}
a{color:#2563eb;text-decoration:none}.toast{position:fixed;left:18px;bottom:18px;background:#111827;color:#fff;padding:12px 14px;border-radius:8px;box-shadow:var(--shadow);display:none;max-width:420px}.empty{padding:24px;text-align:center;color:var(--muted);background:#fff;border:1px dashed var(--line);border-radius:8px}
@media(max-width:980px){.app{grid-template-columns:1fr}.side{position:static;height:auto}.nav{grid-template-columns:repeat(2,1fr)}.grid,.tools{grid-template-columns:1fr}.top{display:grid}.search{max-width:none}table{font-size:12px}}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">آمن | لوحة المدير</div>
    <div class="nav" id="nav"></div>
  </aside>
  <main class="main">
    <div class="top">
      <div class="search">
        <input id="search" placeholder="بحث: عنوان، يوزر، ID، حالة دفع...">
        <select id="limit"><option>100</option><option>250</option><option>500</option><option>1000</option></select>
        <button class="btn" onclick="loadData()">تحديث</button>
      </div>
      <div class="muted" id="updated">-</div>
    </div>
    <section id="overview" class="section active"></section>
    <section id="tools" class="section"></section>
    <section id="investigate" class="section"></section>
    <section id="blocked" class="section"></section>
    <section id="queue" class="section"></section>
    <section id="users" class="section"></section>
    <section id="subscriptions" class="section"></section>
    <section id="watches" class="section"></section>
    <section id="trusted" class="section"></section>
    <section id="tetherWatcher" class="section"></section>
    <section id="payments" class="section"></section>
    <section id="alerts" class="section"></section>
    <section id="events" class="section"></section>
    <section id="details" class="section"></section>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
const urlToken = new URLSearchParams(location.search).get('token');
let TOKEN = urlToken || localStorage.adminWebToken || prompt('أدخل توكن لوحة المدير');
localStorage.adminWebToken = TOKEN || '';
let DATA = null;
const tabs = [
  ['overview','الملخص'],['tools','الأدوات'],['investigate','تحقيق'],['blocked','المحظورة'],['queue','الطابور'],['users','المستخدمون'],
  ['subscriptions','الاشتراكات'],['watches','المتابعة'],['trusted','المنصات'],['payments','المدفوعات'],['alerts','التنبيهات'],['events','سجل البحث'],['details','تفاصيل البحث']
];
tabs.splice(9, 0, ['tetherWatcher', 'مراقب Tether']);
document.getElementById('nav').innerHTML = tabs.map(([id,label]) => '<button data-tab="'+id+'" onclick="showTab(\\''+id+'\\')">'+label+'</button>').join('');
document.querySelector('[data-tab=overview]').classList.add('active');
document.getElementById('search').addEventListener('keydown', e => { if(e.key === 'Enter') loadData(); });
loadData();
setInterval(loadData, 60000);

function authHeaders(){return {'authorization':'Bearer '+TOKEN,'content-type':'application/json'}}
async function api(path, options={}){
  const res = await fetch(path, {...options, headers:{...authHeaders(), ...(options.headers||{})}});
  const data = await res.json();
  if(!data.ok){
    if(res.status === 401){
      localStorage.removeItem('adminWebToken');
      TOKEN = prompt('التوكن غير صحيح. أدخل توكن لوحة المدير من جديد') || '';
      localStorage.adminWebToken = TOKEN;
    }
    throw new Error(data.error || 'فشل الطلب');
  }
  return data.data;
}
async function loadData(){
  try{
    const q = encodeURIComponent(document.getElementById('search').value.trim());
    const limit = document.getElementById('limit').value;
    DATA = await api('/api/dashboard?q='+q+'&limit='+limit);
    renderAll();
    applyInvestigationParam();
    toast('تم التحديث');
  }catch(err){ toast(err.message); }
}
function applyInvestigationParam(){
  const value = new URLSearchParams(location.search).get('investigate');
  if(!value || window.investigationParamApplied) return;
  window.investigationParamApplied = true;
  showTab('investigate');
  document.getElementById('investigateAddress').value = value;
  runInvestigation();
}
function showTab(id){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector('[data-tab='+id+']').classList.add('active');
}
function renderAll(){
  document.getElementById('updated').textContent = 'آخر تحديث: '+fmtDate(DATA.generatedAt);
  renderOverview(); renderTools(); renderInvestigate(); renderBlocked(); renderQueue(); renderUsers(); renderSubs(); renderWatches(); renderTrusted(); renderTetherWatcher(); renderPayments(); renderAlerts(); renderEvents(); renderDetails();
}
function renderOverview(){
  const s = DATA.summary;
  cardGrid('overview', [
    ['العناوين المحظورة', s.risk.blocked, 'إجمالي: '+s.risk.total],
    ['العلاقات الخطرة', s.risk.riskyEdges, 'كل العلاقات: '+s.risk.edges],
    ['بانتظار الفحص', s.queue.pending, 'قيد الفحص: '+s.queue.running],
    ['المستخدمون', s.users.total, 'الفحوصات: '+s.users.searches],
    ['مشتركين نشطين', s.subscriptions.active, 'محافظ متابعة: '+s.subscriptions.watches],
    ['الإيراد', money(s.subscriptions.revenue)+' USDT', 'مدفوعات: '+s.subscriptions.paidPayments],
    ['تنبيهات مفتوحة', s.subscriptions.openAlerts, 'مكتومة: '+s.subscriptions.mutedAlerts],
    ['منصات موثوقة', s.trusted.total, 'يدوي: '+s.trusted.manual+' | تلقائي: '+s.trusted.automatic],
  ]);
}
function renderTools(){
  document.getElementById('tools').innerHTML = '<div class="tools">'+
    tool('إضافة عناوين محظورة كبذور','<textarea id="seedInput" placeholder="T...\\nT..."></textarea><button class="btn" onclick="addSeeds()">إضافة للطابور</button>')+
    tool('منح اشتراك 30 يوم','<input id="grantInput" placeholder="@username أو Telegram ID"><button class="btn green" onclick="grant()">تفعيل الاشتراك</button>')+
    tool('إضافة منصة موثوقة','<input id="trustAddress" placeholder="عنوان TRON"><input id="trustName" placeholder="اسم المنصة"><button class="btn amber" onclick="trust()">حفظ المنصة</button>')+
    tool('إرسال جماعي','<textarea id="broadcastText" placeholder="نص الرسالة للمستخدمين"></textarea><button class="btn danger" onclick="broadcast()">إرسال بعد التأكيد</button>')+
    tool('فحص رفع الحظر','<input id="unbanLimit" value="50"><button class="btn secondary" onclick="unbanCheck()">فحص الآن</button>')+
    tool('تصدير','<button class="btn secondary" onclick="download(\\'/api/export/blocked\\')">تصدير المحظور</button> <button class="btn secondary" onclick="download(\\'/api/export/users\\')">تصدير المستخدمين</button>')+
  '</div>';
}
function renderInvestigate(){
  const el = document.getElementById('investigate');
  if(!el.dataset.ready){
    el.dataset.ready = '1';
    el.innerHTML =
      '<div class="card tool">'+
        '<h3>تحقيق في عنوان</h3>'+
        '<p class="muted">يفحص سجل بحث المستخدمين ومحافظ المتابعة وعلاقات القاعدة المحلية حتى درجتين.</p>'+
        '<input id="investigateAddress" placeholder="عنوان TRON">'+
        '<button class="btn" onclick="runInvestigation()">تشغيل التحقيق</button>'+
      '</div>'+
      '<div id="investigationResult"></div>';
  }
}
async function runInvestigation(){
  const address = document.getElementById('investigateAddress').value.trim();
  if(!address) return toast('اكتب العنوان أولا');
  try{
    const data = await api('/api/investigate',{method:'POST',body:JSON.stringify({address,limit:100})});
    renderInvestigationResult(data);
    toast('تم التحقيق');
  }catch(err){ toast(err.message === 'invalid_address' ? 'العنوان غير صالح' : err.message); }
}
function renderInvestigationResult(r){
  document.getElementById('investigationResult').innerHTML =
    '<div class="grid">'+
      metricCard('بحث مباشر', r.summary.directUserMatches, 'متابعة مباشرة: '+r.summary.directWatchMatches)+
      metricCard('علاقات مباشرة', r.summary.directRelations, 'عليها مستخدمون: '+r.summary.directRelatedUserMatches)+
      metricCard('علاقات غير مباشرة', r.summary.indirectRelations, 'عليها مستخدمون: '+r.summary.indirectRelatedUserMatches)+
      metricCard('محظور داخل الشبكة', r.summary.blacklistedInNetwork, 'خطر مباشر: '+r.summary.riskyDirect+' | غير مباشر: '+r.summary.riskyIndirect)+
    '</div>'+
    '<div class="card"><h3>العنوان محل التحقيق</h3>'+tableHtml(['العنوان','حالة القاعدة','بحث عنه','يتابعه'], [r.self], x => [addr(r.address), investigationRisk(x.risk), investigationUsers(x.users), investigationUsers(x.watchers)])+'</div>'+
    '<div class="card"><h3>عناوين مرتبطة مباشرة وبحث عنها مستخدمون</h3>'+investigationRelationTable(r.directHits, false)+'</div>'+
    '<div class="card"><h3>عناوين مرتبطة غير مباشرة وبحث عنها مستخدمون</h3>'+investigationRelationTable(r.indirectHits, true)+'</div>'+
    '<div class="card"><h3>أخطر العلاقات المباشرة</h3>'+investigationRelationTable(r.riskyDirect, false)+'</div>';
}
function investigationRelationTable(rows, showVia){
  return tableHtml(showVia ? ['العنوان','عبر','الحالة','علاقات','آخر علاقة','مستخدمون'] : ['العنوان','الحالة','علاقات','آخر علاقة','مستخدمون'], rows, r => {
    const base = [addr(r.address), investigationRisk(r.risk), r.edgeCount, fmtDate(r.latestAt), investigationUsers([...(r.users||[]), ...(r.watchers||[])])];
    if(showVia) base.splice(1, 0, (r.via||[]).slice(0,3).map(addr).join('<br>') || '-');
    return base;
  });
}
function investigationRisk(risk){
  if(!risk || !risk.isKnown) return tag('غير معروف');
  if(risk.isBlacklisted === true) return tag('محظور');
  if(risk.wasBlacklisted === true) return tag('كان محظورا');
  if(risk.isBlacklisted === false) return tag('غير محظور');
  return tag('موجود');
}
function investigationUsers(users){
  if(!users || users.length === 0) return '-';
  return users.slice(0,5).map(u => userLink(u)+' <span class="muted">('+((u.count||u.lastRisk)?((u.count?'عدد '+u.count:'')+(u.lastRisk?' | '+u.lastRisk:'')):'متابعة')+')</span>').join('<br>');
}
function renderBlocked(){ table('blocked',['العنوان','تاريخ الإضافة','آخر فحص','سبب الإدراج'], DATA.blocked, r => [addr(r.address), fmtDate(blockedAt(r)), fmtDate(r.lastChecked), sourceLabels(r.sources).join('<br>')]); }
function renderQueue(){ table('queue',['العنوان','الحالة','الأولوية','العمق','السبب','المحاولة','التالي'], DATA.queue, r => [addr(r.address), tag(r.status), r.priority, r.depth, r.reason, r.attempts, fmtDate(r.nextRunAt)]); }
function renderUsers(){ table('users',['المستخدم','Chat','الفحوصات','آخر ظهور','آخر عناوين'], DATA.users, r => [userLink(r), r.chatId||'-', r.searches||0, fmtDate(r.lastSeen), Object.keys(r.addresses||{}).slice(-3).map(addr).join('<br>')]); }
function renderSubs(){ table('subscriptions',['المستخدم','الحالة','ينتهي','فحوص اليوم','محافظ','آخر ظهور'], DATA.subscriptions, r => [userLink(r), subTag(r), fmtDate(r.subscription&&r.subscription.expiresAt), usageLine(r.usage), (r.watches||[]).length, fmtDate(r.lastSeen)]); }
function renderWatches(){ table('watches',['العنوان','المستخدم','آخر فحص ناجح','الحالة','المخاطر','تنبيهات'], DATA.watches, r => [addr(r.address), userLink(r), fmtDate(r.lastSuccessfulCheckedAt||r.lastCheckedAt), tag(r.lastStatus||'-'), riskTag(r.lastSuccessfulRisk||r.lastRisk), r.sentAlerts||0]); }
function renderTrusted(){ table('trusted',['العنوان','الاسم','المصدر','تلقائي','آخر ظهور','إجراء'], DATA.trusted, r => [addr(r.address), esc(r.name), r.source||'-', r.auto?'نعم':'لا', fmtDate(r.lastSeen), '<button class="btn danger" onclick="untrust(\\''+r.address+'\\')">حذف</button>']); }
function renderPayments(){ table('payments',['ID','المستخدم','الحالة','من','المبلغ','أنشئت','دفعت'], DATA.payments, r => [esc(r.id), r.userId, tag(r.status), addr(r.fromAddress), money(r.receivedAmount||r.amount), fmtDate(r.createdAt), fmtDate(r.paidAt)]); }
function renderAlerts(){ table('alerts',['المحفظة','المستخدم','النوع','الطرف','المبلغ','إرسال','مكتوم'], DATA.alerts, r => [addr(r.watchAddress), r.userId, tag(r.alertType), addr(r.counterparty), money(r.amount), r.sentCount||0, r.muted?'نعم':'لا']); }
function renderEvents(){ table('events',['الوقت','المستخدم','العنوان','المخاطر','محظور'], DATA.events, r => [fmtDate(r.at), userLink(r), addr(r.address), riskTag(r.risk), String(r.blacklisted)]); }
function renderDetails(){ document.getElementById('details').innerHTML = DATA.addressDetails ? '<div class="card details"><h3>تفاصيل العنوان</h3><pre>'+esc(JSON.stringify(DATA.addressDetails,null,2))+'</pre></div>' : '<div class="empty">اكتب عنوان TRON في البحث لعرض التفاصيل.</div>'; }

function renderTetherWatcher(){
  const w = DATA.tetherWatcher;
  document.getElementById('tetherWatcher').innerHTML =
    '<div class="grid">'+
      metricCard('حالة المراقب', w.status, 'آخر دورة: '+fmtDate(w.updatedAt))+
      metricCard('آخر حدث مقروء', fmtDate(w.lastEventAt), 'أحداث محفوظة: '+w.trackedEvents)+
      metricCard('دخلت من Tether', w.totalAdded, 'اليوم: '+w.addedToday)+
      metricCard('الاستيراد التاريخي', w.backfill.running ? 'يعمل الآن' : (w.backfill.completed ? 'مكتمل' : 'جاهز'), 'أضيف تاريخيا: '+(w.backfill.totals.added||0))+
    '</div>'+
    '<div class="card"><h3>الاستيراد التاريخي</h3><p class="muted">يستورد أحداث Tether القديمة بصمت بدون إرسال تنبيهات للمدير.</p><button class="btn amber" onclick="startTetherBackfill()">بدء/متابعة الاستيراد التاريخي</button><div class="muted" style="margin-top:10px">منذ: '+fmtDate(w.backfill.fromTimestamp)+' | آخر تحديث: '+fmtDate(w.backfill.updatedAt)+' | المرحلة: '+(w.backfill.phase||'-')+'</div></div>'+
    '<div class="card"><h3>آخر عناوين دخلت قائمة Tether السوداء</h3>'+tableHtml(['العنوان','وقت الحظر','آخر فحص','سبب الإدراج'], w.latestAdded, r => [addr(r.address), fmtDate(tetherAt(r)), fmtDate(r.lastChecked), sourceLabels(r.sources).join('<br>')])+'</div>'+
    '<div class="card"><h3>آخر أحداث رفع الحظر من Tether</h3>'+tableHtml(['العنوان','وقت رفع الحظر','آخر فحص'], w.latestRemoved, r => [addr(r.address), fmtDate(r.unblacklistedAt), fmtDate(r.lastChecked)])+'</div>';
}

function metricCard(label, value, sub){ return '<div class="card metric"><div class="label">'+label+'</div><div class="value">'+value+'</div><div class="sub">'+sub+'</div></div>'; }
function tableHtml(heads, rows, map){
  if(!rows || !rows.length) return '<div class="empty">لا توجد بيانات مطابقة.</div>';
  return '<table><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+map(r).map(c=>'<td>'+safeCell(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
function cardGrid(id, items){ document.getElementById(id).innerHTML = '<div class="grid">'+items.map(i=>'<div class="card metric"><div class="label">'+i[0]+'</div><div class="value">'+i[1]+'</div><div class="sub">'+i[2]+'</div></div>').join('')+'</div>'; }
function tool(title, body){ return '<div class="card tool"><h3>'+title+'</h3>'+body+'</div>'; }
function table(id, heads, rows, map){
  const el = document.getElementById(id);
  if(!rows.length){ el.innerHTML='<div class="empty">لا توجد بيانات مطابقة.</div>'; return; }
  el.innerHTML = '<table><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+map(r).map(c=>'<td>'+safeCell(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
function safeCell(v){ return v == null ? '-' : String(v); }
function addr(a){ if(!a) return '-'; return '<a class="mono" target="_blank" href="https://tronscan.org/#/address/'+encodeURIComponent(a)+'">'+short(a)+'</a>'; }
function userLink(u){ const id=u.userId||u.chatId; const label=u.username||u.name||id||'-'; return id?'<a href="tg://user?id='+encodeURIComponent(id)+'">'+esc(label)+'</a>':esc(label); }
function tag(v){ const cls = /failed|محظور|blocked|expired|canceled/.test(String(v))?'red':/paid|done|checked|active/.test(String(v))?'green':/pending|running|partial/.test(String(v))?'amber':''; return '<span class="tag '+cls+'">'+esc(v||'-')+'</span>'; }
function riskTag(v){ return tag(v||'-'); }
function subTag(r){ const exp = Date.parse((r.subscription||{}).expiresAt||''); return exp>Date.now()?tag('نشط'):tag((r.subscription||{}).status||'مجاني'); }
function usageLine(u){ if(!u) return '-'; return 'مدفوع: '+(u.paidDayCount||0)+' | مجاني: '+(u.freeDayCount||0); }
function blockedAt(r){ return r.blacklistedAt || r.tetherBlacklistedAt || r.firstSeen || r.lastChecked; }
function tetherAt(r){ return r.tetherBlacklistedAt || r.blacklistedAt || r.firstSeen || r.lastChecked; }
function sourceLabels(sources){
  const labels = {
    tether_event: 'حظر مباشر من حدث Tether على الشبكة',
    tether_event_removed: 'حدث رفع حظر من Tether',
    tether_event_history: 'استيراد تاريخي من أحداث Tether',
    tether_event_history_removed: 'استيراد تاريخي لحدث رفع حظر من Tether',
    user_check: 'اكتشف أثناء فحص مستخدم للعنوان نفسه',
    user_check_counterparty: 'اكتشف كطرف مقابل أثناء فحص مستخدم',
    crawler: 'اكتشفه الزاحف من معاملات عنوان محظور',
    crawler_check: 'تأكد منه الزاحف عبر فحص Tether',
    seed: 'بذرة أولية للنظام',
    admin_seed: 'أضافه المدير يدويا من بوت المدير',
    admin_web_seed: 'أضافه المدير يدويا من لوحة الويب',
    unban_monitor: 'راجعه نظام متابعة رفع الحظر',
    admin_web_unban_check: 'راجعه المدير من لوحة الويب',
  };
  const list = [...new Set(sources || [])].map(source => labels[source] || ('مصدر غير مصنف: '+source));
  return list.length ? list : ['غير محدد'];
}
function short(a){ return a && a.length>14 ? a.slice(0,6)+'...'+a.slice(-6) : a; }
function fmtDate(v){ if(!v) return '-'; const d=new Date(v); if(isNaN(d)) return esc(v); return d.toLocaleString('en-GB',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function money(v){ return Number(v||0).toLocaleString('en-US',{maximumFractionDigits:2}); }
function esc(v){ return String(v??'').replace(/[&<>"]/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s])); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.style.display='block'; clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>t.style.display='none',3000); }
async function addSeeds(){ const data=await api('/api/seeds',{method:'POST',body:JSON.stringify({input:document.getElementById('seedInput').value})}); toast('أضيف: '+data.added.length+' | موجود: '+data.existing.length+' | خطأ: '+data.invalid.length); loadData(); }
async function grant(){ const data=await api('/api/grant',{method:'POST',body:JSON.stringify({query:document.getElementById('grantInput').value})}); toast(data.ok?'تم التفعيل حتى '+fmtDate(data.expiresAt):'لم يتم العثور على المستخدم'); loadData(); }
async function trust(){ await api('/api/trusted',{method:'POST',body:JSON.stringify({address:document.getElementById('trustAddress').value,name:document.getElementById('trustName').value})}); toast('تم حفظ المنصة'); loadData(); }
async function untrust(address){ if(!confirm('حذف العنوان من الموثوق؟')) return; await api('/api/trusted/'+encodeURIComponent(address),{method:'DELETE'}); toast('تم الحذف'); loadData(); }
async function broadcast(){ const text=document.getElementById('broadcastText').value; if(!text.trim()) return toast('اكتب الرسالة أولا'); if(!confirm('تأكيد إرسال الرسالة لكل المستخدمين؟')) return; const data=await api('/api/broadcast',{method:'POST',body:JSON.stringify({text})}); toast('تم: '+(data.sent||0)+' | فشل: '+(data.failed||0)); }
async function unbanCheck(){ const data=await api('/api/unban-check',{method:'POST',body:JSON.stringify({limit:document.getElementById('unbanLimit').value})}); toast('تم فحص '+data.checked+' | رفع حظر: '+data.unbanned.length+' | أخطاء: '+data.errors.length); loadData(); }
async function startTetherBackfill(){ const data=await api('/api/tether-backfill',{method:'POST',body:JSON.stringify({days:3650,maxPages:5000})}); toast(data.started?'تم بدء الاستيراد التاريخي':'الاستيراد يعمل بالفعل'); loadData(); }
function download(path){ window.open(path+'?token='+encodeURIComponent(TOKEN),'_blank'); }
</script>
</body>
</html>`;

