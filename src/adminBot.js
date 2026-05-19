import 'dotenv/config';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TelegramBot from 'node-telegram-bot-api';
import { validateTRC20 } from './validator/trc20.js';
import {
  enqueueAddress,
  loadRiskDb,
  saveRiskDb,
  upsertAddress,
} from './crawler/riskDb.js';
import { isBlacklistedByTether } from './api/trongrid.js';
import { loadUsageLog } from './usageLog.js';
import { logger } from './utils/logger.js';

const token = process.env.ADMIN_BOT_TOKEN;
const allowedChatIds = parseIdList(process.env.ADMIN_CHAT_IDS);
const maxListItems = Math.max(5, Number(process.env.ADMIN_LIST_LIMIT) || 10);
const unbanMonitorIntervalMs = Math.max(60_000, Number(process.env.UNBAN_MONITOR_INTERVAL_MS) || 3_600_000);
const unbanMonitorDelayMs = Math.max(250, Number(process.env.UNBAN_MONITOR_DELAY_MS) || 600);
let unbanMonitorRunning = false;

if (!token) {
  logger.error('ADMIN_BOT_TOKEN is not set. Add it to your .env file.');
  process.exit(1);
}

if (allowedChatIds.size === 0) {
  logger.error('ADMIN_CHAT_IDS is not set. Refusing to start an unrestricted admin bot.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const adminKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '/status' }, { text: '/pending' }],
      [{ text: '/blocked' }, { text: '/export_blocked' }],
      [{ text: '/users' }, { text: '/export_users' }],
      [{ text: '/check_unbanned' }, { text: '/help' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  },
};
const adminHtml = { parse_mode: 'HTML', ...adminKeyboard };

await bot.setMyCommands([
  { command: 'status', description: 'حالة القاعدة والطابور' },
  { command: 'add', description: 'إضافة بذور' },
  { command: 'pending', description: 'العناوين المنتظرة' },
  { command: 'blocked', description: 'آخر العناوين المحظورة' },
  { command: 'export_blocked', description: 'تصدير كل المحظور' },
  { command: 'users', description: 'قائمة المستخدمين' },
  { command: 'user', description: 'تفاصيل مستخدم' },
  { command: 'addr', description: 'من بحث عن عنوان' },
  { command: 'export_users', description: 'تصدير سجل المستخدمين' },
  { command: 'check_unbanned', description: 'فحص رفع الحظر يدويا' },
  { command: 'help', description: 'عرض الأوامر' },
]);

bot.onText(/^\/start|^\/help/, async (msg) => {
  if (!isAllowed(msg)) return;
  await bot.sendMessage(msg.chat.id, helpText(), adminHtml);
});

bot.onText(/^\/status/, async (msg) => {
  if (!isAllowed(msg)) return;
  const db = await loadRiskDb();
  await bot.sendMessage(msg.chat.id, formatStatus(db), adminHtml);
});

bot.onText(/^\/add(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const input = match?.[1]?.trim();
  if (!input) {
    await bot.sendMessage(
      msg.chat.id,
      'أرسل العناوين بعد الأمر:\n<code>/add T... T...</code>\nأو كل عنوان بسطر.',
      adminHtml
    );
    return;
  }

  const result = await addSeeds(input);
  await bot.sendMessage(msg.chat.id, formatAddResult(result), adminHtml);
});

bot.onText(/^\/pending/, async (msg) => {
  if (!isAllowed(msg)) return;
  const db = await loadRiskDb();
  const pending = (db.queue ?? [])
    .filter(item => item.status === 'pending')
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
    .slice(0, maxListItems);

  await bot.sendMessage(
    msg.chat.id,
    formatQueueList('العناوين المنتظرة', pending),
    adminHtml
  );
});

bot.onText(/^\/blocked/, async (msg) => {
  if (!isAllowed(msg)) return;
  const db = await loadRiskDb();
  const blocked = Object.values(db.addresses ?? {})
    .filter(item => item.isBlacklisted === true)
    .sort((a, b) => (b.lastChecked ?? b.firstSeen ?? '').localeCompare(a.lastChecked ?? a.firstSeen ?? ''))
    .slice(0, maxListItems);

  await bot.sendMessage(
    msg.chat.id,
    formatBlockedList(blocked),
    adminHtml
  );
});

bot.onText(/^\/export_blocked/, async (msg) => {
  if (!isAllowed(msg)) return;
  const db = await loadRiskDb();
  const blocked = Object.values(db.addresses ?? {})
    .filter(item => item.isBlacklisted === true)
    .sort((a, b) => a.address.localeCompare(b.address));
  const file = await writeTempFile('blocked-addresses.txt', blocked.map(item => item.address).join('\n') + '\n');
  await bot.sendDocument(msg.chat.id, file, adminKeyboard, { filename: 'blocked-addresses.txt', contentType: 'text/plain' });
  await fs.rm(file, { force: true });
});

bot.onText(/^\/users/, async (msg) => {
  if (!isAllowed(msg)) return;
  const usage = await loadUsageLog();
  const users = Object.values(usage.users ?? {})
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
  const message = formatUsersList(users);
  if (message.length <= 3500) {
    await bot.sendMessage(msg.chat.id, message, adminHtml);
    return;
  }

  const file = await writeTempFile('bot-users-list.txt', buildUsersListExport(users));
  await bot.sendDocument(msg.chat.id, file, adminKeyboard, { filename: 'bot-users-list.txt', contentType: 'text/plain' });
  await fs.rm(file, { force: true });
});

bot.onText(/^\/user(?:\s+(\S+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const userId = match?.[1]?.trim();
  if (!userId) {
    await bot.sendMessage(msg.chat.id, 'استخدم:\n<code>/user USER_ID</code>', adminHtml);
    return;
  }
  const usage = await loadUsageLog();
  await bot.sendMessage(msg.chat.id, formatUserDetails(usage.users?.[userId], userId), adminHtml);
});

bot.onText(/^\/addr(?:\s+(\S+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const address = match?.[1]?.trim();
  if (!address) {
    await bot.sendMessage(msg.chat.id, 'استخدم:\n<code>/addr T...</code>', adminHtml);
    return;
  }
  const usage = await loadUsageLog();
  await bot.sendMessage(msg.chat.id, formatAddressUsers(usage, address), adminHtml);
});

bot.onText(/^\/export_users/, async (msg) => {
  if (!isAllowed(msg)) return;
  const usage = await loadUsageLog();
  const file = await writeTempFile('bot-users-usage.txt', buildUsageExport(usage));
  await bot.sendDocument(msg.chat.id, file, adminKeyboard, { filename: 'bot-users-usage.txt', contentType: 'text/plain' });
  await fs.rm(file, { force: true });
});

bot.onText(/^\/check_unbanned/, async (msg) => {
  if (!isAllowed(msg)) return;
  const waiting = await bot.sendMessage(msg.chat.id, 'جاري فحص العناوين المحظورة من Tether...', adminKeyboard);
  const result = await checkUnbannedAddresses();
  await bot.deleteMessage(msg.chat.id, waiting.message_id).catch(() => {});
  await bot.sendMessage(msg.chat.id, formatUnbanCheckResult(result), adminHtml);
});

bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;
  if (!msg.text || msg.text.startsWith('/')) return;

  const addresses = extractAddresses(msg.text);
  if (addresses.length === 0) return;

  const result = await addSeeds(addresses.join('\n'));
  await bot.sendMessage(msg.chat.id, formatAddResult(result), adminHtml);
});

bot.on('polling_error', (err) => logger.error('Admin bot polling error:', err.message));

logger.info('Admin bot is running and polling for manager commands.');
setInterval(runAutomaticUnbanMonitor, unbanMonitorIntervalMs);

function parseIdList(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function isAllowed(msg) {
  const chatId = String(msg.chat?.id ?? '');
  const fromId = String(msg.from?.id ?? '');
  return allowedChatIds.has(chatId) || allowedChatIds.has(fromId);
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
      sources: ['admin_seed'],
      lastChecked: new Date().toISOString(),
    });

    const queued = enqueueAddress(db, address, {
      priority: 1,
      depth: 0,
      reason: 'admin_seed',
    });

    if (queued) added.push(address);
    else existing.push(address);
  }

  if (added.length || existing.length || invalid.length) {
    await saveRiskDb(db);
  }

  return { added, existing, invalid };
}

async function checkUnbannedAddresses() {
  if (unbanMonitorRunning) {
    return { checked: 0, unbanned: [], errors: [], skipped: 'الفحص يعمل حاليا' };
  }

  unbanMonitorRunning = true;
  try {
    const db = await loadRiskDb();
    const blocked = Object.values(db.addresses ?? {})
      .filter(item => item.isBlacklisted === true)
      .sort((a, b) => (a.lastChecked ?? a.firstSeen ?? '').localeCompare(b.lastChecked ?? b.firstSeen ?? ''));
    const unbanned = [];
    const errors = [];
    const now = new Date().toISOString();

    for (const item of blocked) {
      try {
        const status = await isBlacklistedByTether(item.address);
        if (status === false) {
          upsertAddress(db, item.address, {
            isBlacklisted: false,
            wasBlacklisted: true,
            unblacklistedAt: now,
            lastChecked: now,
            sources: ['unban_monitor'],
          });
          unbanned.push(item.address);
        } else if (status === true) {
          upsertAddress(db, item.address, {
            isBlacklisted: true,
            lastChecked: now,
            sources: ['unban_monitor'],
          });
        } else {
          errors.push({ address: item.address, error: 'unknown_status' });
        }
      } catch (err) {
        errors.push({ address: item.address, error: err.message });
      }

      await delay(unbanMonitorDelayMs);
    }

    if (unbanned.length > 0) await saveRiskDb(db);
    return { checked: blocked.length, unbanned, errors };
  } finally {
    unbanMonitorRunning = false;
  }
}

async function runAutomaticUnbanMonitor() {
  try {
    const result = await checkUnbannedAddresses();
    if (result.unbanned.length === 0) return;
    const message = formatUnbanAlert(result);
    for (const chatId of allowedChatIds) {
      await bot.sendMessage(chatId, message, adminHtml).catch((err) =>
        logger.warn(`Unban monitor notify failed for ${chatId}: ${err.message}`)
      );
    }
  } catch (err) {
    logger.warn('Automatic unban monitor failed:', err.message);
  }
}

function extractAddresses(text) {
  return String(text ?? '').match(/T[1-9A-HJ-NP-Za-km-z]{33}/g) ?? [];
}

function formatStatus(db) {
  const addresses = Object.values(db.addresses ?? {});
  const blockedCount = addresses.filter(item => item.isBlacklisted === true).length;
  const queueStats = (db.queue ?? []).reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  return [
    '<b>حالة قاعدة المخاطر</b>',
    '',
    `العناوين المحظورة: <b>${blockedCount}</b>`,
    `إجمالي العناوين: <b>${addresses.length}</b>`,
    `العلاقات/التعاملات: <b>${Object.keys(db.edges ?? {}).length}</b>`,
    '',
    '<b>الطابور</b>',
    `بانتظار الفحص: <b>${queueStats.pending ?? 0}</b>`,
    `قيد الفحص: <b>${queueStats.running ?? 0}</b>`,
    `منتهية: <b>${queueStats.done ?? 0}</b>`,
    `فاشلة: <b>${queueStats.failed ?? 0}</b>`,
    '',
    `آخر تحديث: <code>${db.updatedAt ?? 'غير معروف'}</code>`,
  ].join('\n');
}

function formatAddResult({ added, existing, invalid }) {
  const lines = [
    '<b>نتيجة إضافة البذور</b>',
    '',
    `أضيفت للطابور: <b>${added.length}</b>`,
    `موجودة مسبقا/قيد الفحص: <b>${existing.length}</b>`,
    `غير صالحة: <b>${invalid.length}</b>`,
  ];

  if (added.length) lines.push('', '<b>المضافة</b>', ...added.slice(0, maxListItems).map(addr => `<code>${addr}</code>`));
  if (invalid.length) lines.push('', '<b>غير الصالحة</b>', ...invalid.slice(0, maxListItems).map(addr => `<code>${addr}</code>`));

  return lines.join('\n');
}

function formatQueueList(title, items) {
  if (items.length === 0) return `<b>${title}</b>\n\nلا يوجد عناوين بانتظار الفحص.`;
  return [
    `<b>${title}</b>`,
    '',
    ...items.map((item, index) => `${index + 1}. <code>${item.address}</code>\nعمق: ${item.depth} | سبب: ${escapeHtml(item.reason ?? '-')}`),
  ].join('\n');
}

function formatBlockedList(items) {
  if (items.length === 0) return '<b>العناوين المحظورة</b>\n\nلا يوجد عناوين محظورة مخزنة.';
  return [
    '<b>آخر العناوين المحظورة</b>',
    '',
    ...items.map((item, index) => `${index + 1}. <code>${item.address}</code>\nآخر فحص: <code>${item.lastChecked ?? item.firstSeen ?? '-'}</code>`),
  ].join('\n');
}

function formatUsersList(users) {
  if (users.length === 0) return '<b>سجل المستخدمين</b>\n\nلا يوجد استخدام مسجل بعد.';
  return [
    '<b>آخر مستخدمي البوت</b>',
    '',
    ...users.map((user, index) => [
      `${index + 1}. <code>${escapeHtml(user.userId)}</code>`,
      `الاسم: ${escapeHtml(displayUser(user))}`,
      `عدد الفحوصات: <b>${user.searches ?? 0}</b>`,
      `آخر استخدام: <code>${user.lastSeen ?? '-'}</code>`,
      `الأمر: <code>/user ${escapeHtml(user.userId)}</code>`,
    ].join('\n')),
  ].join('\n\n');
}

function formatUserDetails(user, userId) {
  if (!user) return `لا يوجد مستخدم مسجل بهذا الرقم: <code>${escapeHtml(userId)}</code>`;
  const addresses = Object.values(user.addresses ?? {})
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));

  return [
    '<b>تفاصيل المستخدم</b>',
    '',
    `ID: <code>${escapeHtml(user.userId)}</code>`,
    `الاسم: ${escapeHtml(displayUser(user))}`,
    `Chat: <code>${escapeHtml(user.chatId ?? '-')}</code>`,
    `عدد الفحوصات: <b>${user.searches ?? 0}</b>`,
    `أول استخدام: <code>${user.firstSeen ?? '-'}</code>`,
    `آخر استخدام: <code>${user.lastSeen ?? '-'}</code>`,
    '',
    '<b>آخر العناوين</b>',
    ...(addresses.length ? addresses.map(item => `<code>${item.address}</code>\nعدد: ${item.count} | آخر نتيجة: ${escapeHtml(item.lastRisk ?? '-')}`) : ['لا يوجد عناوين.']),
  ].join('\n');
}

function formatAddressUsers(usage, address) {
  const users = Object.values(usage.users ?? {})
    .filter(user => user.addresses?.[address])
    .sort((a, b) => (b.addresses[address].lastSeen ?? '').localeCompare(a.addresses[address].lastSeen ?? ''));

  if (users.length === 0) {
    return [
      '<b>بحث العنوان</b>',
      '',
      `<code>${escapeHtml(address)}</code>`,
      '',
      'لا يوجد مستخدم مسجل بحث عن هذا العنوان.',
    ].join('\n');
  }

  return [
    '<b>المستخدمون الذين بحثوا عن العنوان</b>',
    '',
    `<code>${escapeHtml(address)}</code>`,
    '',
    ...users.map((user, index) => {
      const item = user.addresses[address];
      return [
        `${index + 1}. <code>${escapeHtml(user.userId)}</code>`,
        `الاسم: ${escapeHtml(displayUser(user))}`,
        `عدد مرات البحث: <b>${item.count ?? 0}</b>`,
        `آخر بحث: <code>${item.lastSeen ?? '-'}</code>`,
        `آخر نتيجة: ${escapeHtml(item.lastRisk ?? '-')}`,
      ].join('\n');
    }),
  ].join('\n\n');
}

function formatUnbanCheckResult(result) {
  if (result.skipped) return `⚠️ ${escapeHtml(result.skipped)}`;
  if (result.unbanned.length === 0) {
    return [
      '<b>فحص رفع الحظر</b>',
      '',
      `تم فحص: <b>${result.checked}</b> عنوان`,
      'لا يوجد أي عنوان تم رفع الحظر عنه حاليا.',
      result.errors.length ? `تعذر التحقق من: <b>${result.errors.length}</b> عنوان` : null,
    ].filter(Boolean).join('\n');
  }

  return formatUnbanAlert(result);
}

function formatUnbanAlert(result) {
  return [
    '<b>تنبيه رفع حظر</b>',
    '',
    `تم فحص: <b>${result.checked}</b> عنوان`,
    `عناوين لم تعد محظورة: <b>${result.unbanned.length}</b>`,
    '',
    ...result.unbanned.slice(0, 30).map(address => `<code>${address}</code>`),
    result.unbanned.length > 30 ? `\n... و ${result.unbanned.length - 30} أخرى` : null,
  ].filter(Boolean).join('\n');
}

function buildUsageExport(usage) {
  const lines = [];
  const users = Object.values(usage.users ?? {})
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));

  lines.push(`updatedAt: ${usage.updatedAt ?? '-'}`);
  lines.push(`users: ${users.length}`);
  lines.push('');

  for (const user of users) {
    lines.push(`USER ${user.userId} | ${displayUser(user)} | searches:${user.searches ?? 0} | last:${user.lastSeen ?? '-'}`);
    const addresses = Object.values(user.addresses ?? {})
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
    for (const item of addresses) {
      lines.push(`  ${item.address} | count:${item.count} | risk:${item.lastRisk ?? '-'} | blacklisted:${item.lastBlacklisted ?? '-'} | last:${item.lastSeen ?? '-'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildUsersListExport(users) {
  return users.map(user => [
    `USER ${user.userId}`,
    `name: ${displayUser(user)}`,
    `chat: ${user.chatId ?? '-'}`,
    `searches: ${user.searches ?? 0}`,
    `firstSeen: ${user.firstSeen ?? '-'}`,
    `lastSeen: ${user.lastSeen ?? '-'}`,
    `command: /user ${user.userId}`,
  ].join('\n')).join('\n\n');
}

function displayUser(user) {
  return user.username || user.name || user.chatId || '-';
}

function helpText() {
  return [
    '<b>أوامر بوت المدير</b>',
    '',
    '<code>/status</code> حالة القاعدة والطابور',
    '<code>/add T...</code> إضافة بذور',
    '<code>/pending</code> العناوين المنتظرة',
    '<code>/blocked</code> آخر العناوين المحظورة',
    '<code>/export_blocked</code> تصدير كل المحظور كملف',
    '<code>/users</code> قائمة المستخدمين',
    '<code>/user USER_ID</code> تفاصيل مستخدم وعناوينه',
    '<code>/addr T...</code> من بحث عن عنوان معين',
    '<code>/export_users</code> تصدير سجل المستخدمين',
    '<code>/check_unbanned</code> فحص رفع الحظر يدويا',
  ].join('\n');
/*
  return [
    '<b>أوامر بوت المدير</b>',
    '',
    '<code>/status</code> حالة القاعدة والطابور',
    '<code>/add T...</code> إضافة بذور',
    '<code>/pending</code> العناوين المنتظرة',
    '<code>/blocked</code> آخر العناوين المحظورة',
    '<code>/export_blocked</code> تصدير كل المحظور كملف',
    '<code>/users</code> آخر مستخدمي البوت',
    '<code>/user USER_ID</code> تفاصيل مستخدم وعناوينه',
    '<code>/export_users</code> تصدير سجل المستخدمين كملف',
  ].join('\n');
*/
/*
  return [
    '<b>أوامر بوت المدير</b>',
    '',
    '<code>/status</code> حالة قاعدة البيانات والطابور',
    '<code>/add T...</code> إضافة عنوان أو عدة عناوين كبذور',
    '<code>/pending</code> أول العناوين المنتظرة',
    '<code>/blocked</code> آخر العناوين المحظورة',
    '',
    'يمكنك أيضا إرسال عناوين فقط بدون أمر، وسيتم إضافتها كبذور.',
  ].join('\n');
*/
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function writeTempFile(fileName, content) {
  const file = path.join(os.tmpdir(), `${Date.now()}-${fileName}`);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
