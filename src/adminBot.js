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
import { checkBlacklistConstantContract, isBlacklistedByTether } from './api/trongrid.js';
import { loadUsageLog } from './usageLog.js';
import { loadSubscriptions } from './subscriptions.js';
import { logger } from './utils/logger.js';

const token = process.env.ADMIN_BOT_TOKEN;
const userBotToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedChatIds = parseIdList(process.env.ADMIN_CHAT_IDS);
const maxListItems = Math.max(5, Number(process.env.ADMIN_LIST_LIMIT) || 10);
const unbanMonitorIntervalMs = Math.max(60_000, Number(process.env.UNBAN_MONITOR_INTERVAL_MS) || 3_600_000);
const unbanMonitorDelayMs = Math.max(250, Number(process.env.UNBAN_MONITOR_DELAY_MS) || 600);
const unbanConfirmDelayMs = Math.max(500, Number(process.env.UNBAN_CONFIRM_DELAY_MS) || 1500);
const broadcastDelayMs = Math.max(50, Number(process.env.ADMIN_BROADCAST_DELAY_MS) || 120);
let unbanMonitorRunning = false;
const pendingBroadcasts = new Map();

if (!token) {
  logger.error('ADMIN_BOT_TOKEN is not set. Add it to your .env file.');
  process.exit(1);
}

if (allowedChatIds.size === 0) {
  logger.error('ADMIN_CHAT_IDS is not set. Refusing to start an unrestricted admin bot.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const userBot = userBotToken ? new TelegramBot(userBotToken, { polling: false }) : null;
const adminKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '/status' }, { text: '/stats' }],
      [{ text: '/subs' }, { text: '/users' }],
      [{ text: '/pending' }, { text: '/blocked' }],
      [{ text: '/blocked' }, { text: '/export_blocked' }],
      [{ text: '/export_users' }],
      [{ text: '/broadcast' }],
      [{ text: '/check_unbanned' }, { text: '/help' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  },
};
const adminHtml = { parse_mode: 'HTML', ...adminKeyboard };

await bot.setMyCommands([
  { command: 'status', description: 'حالة القاعدة والطابور' },
  { command: 'stats', description: 'إحصائيات مختصرة كاملة' },
  { command: 'subs', description: 'إحصائيات الاشتراكات والمدفوعات' },
  { command: 'add', description: 'إضافة بذور' },
  { command: 'pending', description: 'العناوين المنتظرة' },
  { command: 'blocked', description: 'آخر العناوين المحظورة' },
  { command: 'export_blocked', description: 'تصدير كل المحظور' },
  { command: 'users', description: 'قائمة المستخدمين' },
  { command: 'user', description: 'تفاصيل مستخدم' },
  { command: 'addr', description: 'من بحث عن عنوان' },
  { command: 'export_users', description: 'تصدير سجل المستخدمين' },
  { command: 'broadcast', description: 'إرسال رسالة لكل المستخدمين' },
  { command: 'confirm_broadcast', description: 'تأكيد الإرسال الجماعي' },
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
  const usage = await loadUsageLog();
  const subs = await loadSubscriptions();
  await bot.sendMessage(msg.chat.id, formatStatus(db, usage, subs), adminHtml);
});

bot.onText(/^\/stats/, async (msg) => {
  if (!isAllowed(msg)) return;
  const db = await loadRiskDb();
  const usage = await loadUsageLog();
  const subs = await loadSubscriptions();
  await bot.sendMessage(msg.chat.id, formatStats(db, usage, subs), adminHtml);
});

bot.onText(/^\/subs/, async (msg) => {
  if (!isAllowed(msg)) return;
  const subs = await loadSubscriptions();
  await bot.sendMessage(msg.chat.id, formatSubscriptionStats(subs), adminHtml);
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

bot.onText(/^\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const text = match?.[1]?.trim();
  if (!text) {
    await bot.sendMessage(
      msg.chat.id,
      'استخدم:\n<code>/broadcast نص الرسالة</code>\n\nلن يتم الإرسال إلا بعد أمر التأكيد.',
      adminHtml
    );
    return;
  }

  if (!userBot) {
    await bot.sendMessage(
      msg.chat.id,
      'لا يمكن الإرسال الآن: TELEGRAM_BOT_TOKEN غير موجود في إعدادات بوت المدير على السيرفر.',
      adminHtml
    );
    return;
  }

  const usage = await loadUsageLog();
  const recipients = getBroadcastRecipients(usage);
  if (recipients.length === 0) {
    await bot.sendMessage(msg.chat.id, 'لا يوجد مستخدمون مسجلون للإرسال لهم.', adminHtml);
    return;
  }

  const id = String(Date.now());
  pendingBroadcasts.set(id, {
    text,
    recipients,
    createdAt: Date.now(),
    adminChatId: String(msg.chat.id),
  });

  await bot.sendMessage(
    msg.chat.id,
    formatBroadcastPreview(id, text, recipients.length),
    adminHtml
  );
});

bot.onText(/^\/confirm_broadcast(?:\s+(\S+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const id = match?.[1]?.trim();
  const pending = id ? pendingBroadcasts.get(id) : null;
  if (!pending || pending.adminChatId !== String(msg.chat.id)) {
    await bot.sendMessage(msg.chat.id, 'لا يوجد بث معلق بهذا الرقم. ابدأ من /broadcast.', adminHtml);
    return;
  }

  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    pendingBroadcasts.delete(id);
    await bot.sendMessage(msg.chat.id, 'انتهت مهلة تأكيد البث. أعد الأمر /broadcast.', adminHtml);
    return;
  }

  pendingBroadcasts.delete(id);
  const waiting = await bot.sendMessage(msg.chat.id, `جاري الإرسال إلى ${pending.recipients.length} مستخدم...`, adminKeyboard);
  const result = await sendBroadcast(pending.text, pending.recipients);
  await bot.deleteMessage(msg.chat.id, waiting.message_id).catch(() => {});
  await bot.sendMessage(msg.chat.id, formatBroadcastResult(result), adminHtml);
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
          const confirmed = await confirmUnbanned(item.address);
          if (confirmed.ok) {
            upsertAddress(db, item.address, {
              isBlacklisted: false,
              wasBlacklisted: true,
              unblacklistedAt: now,
              lastChecked: now,
              sources: ['unban_monitor'],
            });
            unbanned.push(item.address);
          } else {
            errors.push({ address: item.address, error: `unban_not_confirmed:${confirmed.results.join(',')}` });
          }
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

async function confirmUnbanned(address) {
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    try {
      const status = await checkBlacklistConstantContract(address);
      results.push(status);
      if (status !== false) return { ok: false, results };
    } catch (err) {
      logger.warn(`Unban confirmation failed for ${address}: ${err.message}`);
      results.push('error');
      return { ok: false, results };
    }
    if (i < 2) await delay(unbanConfirmDelayMs);
  }
  return { ok: true, results };
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

function formatStatus(db, usage = null, subs = null) {
  const addresses = Object.values(db.addresses ?? {});
  const blockedCount = addresses.filter(item => item.isBlacklisted === true).length;
  const queueStats = (db.queue ?? []).reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const usageStats = summarizeUsage(usage);
  const subStats = summarizeSubscriptions(subs);
  const unblockedCount = addresses.filter(item => item.wasBlacklisted === true && item.isBlacklisted === false).length;

  return [
    '<b>📊 ملخص النظام</b>',
    '',
    '<b>🧱 قاعدة المخاطر</b>',
    `• العناوين المحظورة: <b>${blockedCount}</b>`,
    `• إجمالي العناوين: <b>${addresses.length}</b>`,
    `• العلاقات: <b>${Object.keys(db.edges ?? {}).length}</b>`,
    '',
    '<b>⚙️ الطابور</b>',
    `• بانتظار الفحص: <b>${queueStats.pending ?? 0}</b>`,
    `• قيد الفحص: <b>${queueStats.running ?? 0}</b>`,
    `• منتهية: <b>${queueStats.done ?? 0}</b>`,
    `• فاشلة: <b>${queueStats.failed ?? 0}</b>`,
    '',
    '<b>👥 المستخدمون</b>',
    `• عدد المستخدمين: <b>${usageStats.users}</b>`,
    `• إجمالي الفحوصات: <b>${usageStats.searches}</b>`,
    `• آخر فحص: <code>${shortDate(usageStats.lastSeen)}</code>`,
    '',
    '<b>💳 الاشتراكات</b>',
    `• نشطة: <b>${subStats.active}</b>`,
    `• إيراد مدفوع: <b>${fmtMoney(subStats.revenue)} USDT</b>`,
    `• مدفوعات معلقة: <b>${subStats.pendingPayments}</b>`,
    `• محافظ متابعة: <b>${subStats.watches}</b>`,
    '',
    '<b>🚫 رفع الحظر</b>',
    `• تم رفع الحظر عن: <b>${unblockedCount}</b>`,
    '',
    '<b>🕷️ الزاحف</b>',
    `• آخر تحديث: <code>${shortDate(db.updatedAt)}</code>`,
  ].join('\n');
}

function formatStats(db, usage = null, subs = null) {
  const addresses = Object.values(db.addresses ?? {});
  const queueStats = (db.queue ?? []).reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const usageStats = summarizeUsage(usage);
  const subStats = summarizeSubscriptions(subs);
  const blocked = addresses.filter(item => item.isBlacklisted === true);
  const notBlocked = addresses.filter(item => item.isBlacklisted === false);
  const unknown = addresses.filter(item => item.isBlacklisted == null);
  const unblocked = addresses.filter(item => item.wasBlacklisted === true && item.isBlacklisted === false);
  const blacklistedEdges = Object.values(db.edges ?? {}).filter(edge => edge.blacklistedAddress);
  const recentBlocked = blocked
    .sort((a, b) => (b.lastChecked ?? b.firstSeen ?? '').localeCompare(a.lastChecked ?? a.firstSeen ?? ''))
    .slice(0, 5)
    .map(item => `• <code>${item.address}</code>`)
    .join('\n') || '• لا يوجد';

  return [
    '<b>📈 الإحصائيات</b>',
    '',
    '<b>العناوين</b>',
    `• محظورة: <b>${blocked.length}</b>`,
    `• غير محظورة: <b>${notBlocked.length}</b>`,
    `• غير معروفة: <b>${unknown.length}</b>`,
    `• رُفع حظرها: <b>${unblocked.length}</b>`,
    `• الإجمالي: <b>${addresses.length}</b>`,
    '',
    '<b>العلاقات</b>',
    `• كل العلاقات: <b>${Object.keys(db.edges ?? {}).length}</b>`,
    `• علاقات مع القائمة السوداء: <b>${blacklistedEdges.length}</b>`,
    '',
    '<b>الطابور</b>',
    `• pending: <b>${queueStats.pending ?? 0}</b>`,
    `• running: <b>${queueStats.running ?? 0}</b>`,
    `• done: <b>${queueStats.done ?? 0}</b>`,
    `• failed: <b>${queueStats.failed ?? 0}</b>`,
    '',
    '<b>المستخدمون</b>',
    `• المستخدمون: <b>${usageStats.users}</b>`,
    `• الفحوصات: <b>${usageStats.searches}</b>`,
    `• العناوين الفريدة: <b>${usageStats.uniqueAddresses}</b>`,
    `• آخر فحص: <code>${shortDate(usageStats.lastSeen)}</code>`,
    '',
    '<b>الاشتراكات</b>',
    `• نشطة: <b>${subStats.active}</b>`,
    `• مجانية/غير نشطة: <b>${subStats.free}</b>`,
    `• منتهية: <b>${subStats.expired}</b>`,
    `• محافظ متابعة: <b>${subStats.watches}</b>`,
    `• تنبيهات مفتوحة: <b>${subStats.openAlerts}</b>`,
    `• إيراد مدفوع: <b>${fmtMoney(subStats.revenue)} USDT</b>`,
    '',
    '<b>المدفوعات</b>',
    `• مدفوعة: <b>${subStats.paidPayments}</b>`,
    `• معلقة: <b>${subStats.pendingPayments}</b>`,
    `• ملغاة: <b>${subStats.canceledPayments}</b>`,
    `• منتهية: <b>${subStats.expiredPayments}</b>`,
    '',
    '<b>آخر محظور مكتشف</b>',
    recentBlocked,
    '',
    `آخر تحديث للقاعدة: <code>${shortDate(db.updatedAt)}</code>`,
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
    ...items.map((item, index) => `${index + 1}. <code>${item.address}</code>\nآخر فحص: <code>${shortDate(item.lastChecked ?? item.firstSeen)}</code>`),
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
      `آخر استخدام: <code>${shortDate(user.lastSeen)}</code>`,
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
    `أول استخدام: <code>${shortDate(user.firstSeen)}</code>`,
    `آخر استخدام: <code>${shortDate(user.lastSeen)}</code>`,
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
        `آخر بحث: <code>${shortDate(item.lastSeen)}</code>`,
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

function getBroadcastRecipients(usage) {
  const recipients = new Map();
  for (const user of Object.values(usage.users ?? {})) {
    const chatId = user.chatId ?? user.userId;
    if (!chatId) continue;
    recipients.set(String(chatId), {
      chatId: String(chatId),
      userId: String(user.userId ?? chatId),
      name: displayUser(user),
    });
  }
  return [...recipients.values()];
}

function formatBroadcastPreview(id, text, count) {
  const preview = text.length > 900 ? `${text.slice(0, 900)}...` : text;
  return [
    '<b>تأكيد إرسال جماعي</b>',
    '',
    `عدد المستلمين: <b>${count}</b>`,
    '',
    '<b>نص الرسالة</b>',
    escapeHtml(preview),
    '',
    'للتأكيد أرسل:',
    `<code>/confirm_broadcast ${escapeHtml(id)}</code>`,
    '',
    'تنتهي مهلة التأكيد خلال 10 دقائق.',
  ].join('\n');
}

async function sendBroadcast(text, recipients) {
  const result = { total: recipients.length, sent: 0, failed: 0, failures: [] };
  for (const recipient of recipients) {
    try {
      await userBot.sendMessage(recipient.chatId, text);
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      result.failures.push({
        chatId: recipient.chatId,
        userId: recipient.userId,
        error: err.message,
      });
      logger.warn(`Broadcast failed for ${recipient.chatId}: ${err.message}`);
    }
    await delay(broadcastDelayMs);
  }
  return result;
}

function formatBroadcastResult(result) {
  return [
    '<b>نتيجة الإرسال الجماعي</b>',
    '',
    `المستلمين: <b>${result.total}</b>`,
    `تم الإرسال: <b>${result.sent}</b>`,
    `فشل: <b>${result.failed}</b>`,
    result.failures.length
      ? `\nأول الأخطاء:\n${result.failures.slice(0, 5).map(item => `<code>${escapeHtml(item.chatId)}</code> - ${escapeHtml(item.error)}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n');
}

function summarizeSubscriptions(subs) {
  const users = Object.values(subs?.users ?? {});
  const payments = Object.values(subs?.payments ?? {});
  const alerts = Object.values(subs?.alerts ?? {});
  const now = Date.now();
  let active = 0;
  let expired = 0;
  let free = 0;
  let watches = 0;
  let paidSearchesToday = 0;
  let freeSearchesThisWeek = 0;
  let activeWatchesUsers = 0;
  const today = new Date().toISOString().slice(0, 10);
  const week = currentWeekKey();

  for (const user of users) {
    const expiresAt = Date.parse(user.subscription?.expiresAt ?? '');
    if (Number.isFinite(expiresAt) && expiresAt > now) active += 1;
    else if (Number.isFinite(expiresAt) && expiresAt <= now) expired += 1;
    else free += 1;

    const userWatches = user.watches?.length ?? 0;
    watches += userWatches;
    if (userWatches > 0) activeWatchesUsers += 1;
    if (user.usage?.paidDayKey === today) paidSearchesToday += Number(user.usage.paidDayCount ?? 0);
    if (user.usage?.freeWeekKey === week) freeSearchesThisWeek += Number(user.usage.freeWeekCount ?? 0);
  }

  const paid = payments.filter(item => item.status === 'paid');
  return {
    users: users.length,
    active,
    expired,
    free,
    watches,
    activeWatchesUsers,
    paidSearchesToday,
    freeSearchesThisWeek,
    paidPayments: paid.length,
    pendingPayments: payments.filter(item => item.status === 'pending').length,
    canceledPayments: payments.filter(item => item.status === 'canceled').length,
    expiredPayments: payments.filter(item => item.status === 'expired').length,
    revenue: paid.reduce((sum, item) => sum + Number(item.receivedAmount ?? item.amount ?? 0), 0),
    openAlerts: alerts.filter(item => !item.muted && Number(item.sentCount ?? 0) < 5).length,
    mutedAlerts: alerts.filter(item => item.muted).length,
    alerts: alerts.length,
    updatedAt: subs?.updatedAt ?? null,
  };
}

function formatSubscriptionStats(subs) {
  const stats = summarizeSubscriptions(subs);
  const recentPaid = Object.values(subs?.payments ?? {})
    .filter(item => item.status === 'paid')
    .sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''))
    .slice(0, 5)
    .map(item => `• <code>${escapeHtml(item.userId)}</code> — <b>${fmtMoney(item.receivedAmount ?? item.amount)} USDT</b> — ${shortDate(item.paidAt)}`)
    .join('\n') || '• لا يوجد';
  const expiringSoon = Object.values(subs?.users ?? {})
    .filter(user => {
      const expiresAt = Date.parse(user.subscription?.expiresAt ?? '');
      return Number.isFinite(expiresAt) && expiresAt > Date.now();
    })
    .sort((a, b) => (a.subscription.expiresAt ?? '').localeCompare(b.subscription.expiresAt ?? ''))
    .slice(0, 5)
    .map(user => `• <code>${escapeHtml(user.userId)}</code> — ${escapeHtml(displayUser(user))} — ${shortDate(user.subscription.expiresAt)}`)
    .join('\n') || '• لا يوجد';

  return [
    '<b>💳 إحصائيات الاشتراكات</b>',
    '',
    '<b>المستخدمون</b>',
    `• إجمالي مستخدمي النظام: <b>${stats.users}</b>`,
    `• مشتركين نشطين: <b>${stats.active}</b>`,
    `• مجاني/غير نشط: <b>${stats.free}</b>`,
    `• منتهية اشتراكاتهم: <b>${stats.expired}</b>`,
    '',
    '<b>الاستخدام</b>',
    `• فحوصات المشتركين اليوم: <b>${stats.paidSearchesToday}</b>`,
    `• فحوصات المجاني هذا الأسبوع: <b>${stats.freeSearchesThisWeek}</b>`,
    `• محافظ متابعة: <b>${stats.watches}</b>`,
    `• مستخدمون لديهم متابعة: <b>${stats.activeWatchesUsers}</b>`,
    '',
    '<b>المدفوعات</b>',
    `• مدفوعة: <b>${stats.paidPayments}</b>`,
    `• معلقة: <b>${stats.pendingPayments}</b>`,
    `• ملغاة: <b>${stats.canceledPayments}</b>`,
    `• منتهية: <b>${stats.expiredPayments}</b>`,
    `• إجمالي الإيراد: <b>${fmtMoney(stats.revenue)} USDT</b>`,
    '',
    '<b>التنبيهات</b>',
    `• إجمالي التنبيهات: <b>${stats.alerts}</b>`,
    `• مفتوحة/تتكرر: <b>${stats.openAlerts}</b>`,
    `• مكتومة: <b>${stats.mutedAlerts}</b>`,
    '',
    '<b>آخر المدفوعات</b>',
    recentPaid,
    '',
    '<b>أقرب الاشتراكات انتهاء</b>',
    expiringSoon,
    '',
    `آخر تحديث: <code>${shortDate(stats.updatedAt)}</code>`,
  ].join('\n');
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

function summarizeUsage(usage) {
  if (!usage) return { users: 0, searches: 0, uniqueAddresses: 0, lastSeen: null };
  const users = Object.values(usage.users ?? {});
  const uniqueAddresses = new Set();
  let searches = 0;
  let lastSeen = null;

  for (const user of users) {
    searches += Number(user.searches ?? 0);
    if (user.lastSeen && (!lastSeen || user.lastSeen > lastSeen)) lastSeen = user.lastSeen;
    for (const address of Object.keys(user.addresses ?? {})) uniqueAddresses.add(address);
  }

  return {
    users: users.length,
    searches,
    uniqueAddresses: uniqueAddresses.size,
    lastSeen,
  };
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

function shortDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtMoney(value) {
  return Number(value ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function currentWeekKey() {
  const date = new Date();
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function helpText() {
  return [
    '<b>أوامر بوت المدير</b>',
    '',
    '<code>/status</code> حالة القاعدة والطابور',
    '<code>/stats</code> إحصائيات مختصرة كاملة',
    '<code>/subs</code> إحصائيات الاشتراكات والمدفوعات',
    '<code>/add T...</code> إضافة بذور',
    '<code>/pending</code> العناوين المنتظرة',
    '<code>/blocked</code> آخر العناوين المحظورة',
    '<code>/export_blocked</code> تصدير كل المحظور كملف',
    '<code>/users</code> قائمة المستخدمين',
    '<code>/user USER_ID</code> تفاصيل مستخدم وعناوينه',
    '<code>/addr T...</code> من بحث عن عنوان معين',
    '<code>/export_users</code> تصدير سجل المستخدمين',
    '<code>/broadcast نص الرسالة</code> تجهيز رسالة لكل المستخدمين',
    '<code>/confirm_broadcast ID</code> تأكيد الإرسال الجماعي',
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
