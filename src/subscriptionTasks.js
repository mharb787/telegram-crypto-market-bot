import { getRecentUSDTTransfers } from './api/trongrid.js';
import { checkOnChain } from './validator/onchain.js';
import {
  activateSubscription,
  createOrGetAlert,
  dueAlerts,
  expireOldPayments,
  isSubscribed,
  loadSubscriptions,
  markAlertSent,
  OWNER_USDT_ADDRESS,
  saveSubscriptions,
} from './subscriptions.js';
import { logger } from './utils/logger.js';

const PAYMENT_SCAN_MS = Math.max(30_000, Number(process.env.PAYMENT_SCAN_MS) || 60_000);
const WATCH_SCAN_MS = Math.max(60_000, Number(process.env.WATCH_SCAN_MS) || 15 * 60_000);
const ALERT_SCAN_MS = Math.max(60_000, Number(process.env.ALERT_SCAN_MS) || 5 * 60_000);
const REMINDER_SCAN_MS = Math.max(60_000, Number(process.env.REMINDER_SCAN_MS) || 60 * 60_000);
const WATCH_REVIEW_LIMIT = Math.max(200, Number(process.env.WATCH_USDT_REVIEW_LIMIT) || 5000);

let paymentScanRunning = false;
let watchScanRunning = false;
let alertScanRunning = false;
let reminderScanRunning = false;

export function startSubscriptionTasks(bot) {
  setInterval(() => scanPayments(bot).catch(err => logger.warn('Payment scan failed:', err.message)), PAYMENT_SCAN_MS);
  setInterval(() => scanWatchedWallets().catch(err => logger.warn('Watched wallet scan failed:', err.message)), WATCH_SCAN_MS);
  setInterval(() => sendDueAlerts(bot).catch(err => logger.warn('Alert scan failed:', err.message)), ALERT_SCAN_MS);
  setInterval(() => sendSubscriptionReminders(bot).catch(err => logger.warn('Reminder scan failed:', err.message)), REMINDER_SCAN_MS);

  scanPayments(bot).catch(err => logger.warn('Initial payment scan failed:', err.message));
  sendDueAlerts(bot).catch(err => logger.warn('Initial alert scan failed:', err.message));
}

async function scanPayments(bot) {
  if (paymentScanRunning) return;
  paymentScanRunning = true;
  try {
    const db = await loadSubscriptions();
    let changed = expireOldPayments(db);
    const pending = Object.values(db.payments ?? {}).filter(item => item.status === 'pending');
    if (pending.length === 0) {
      if (changed) await saveSubscriptions(db);
      return;
    }

    const transfers = await getRecentUSDTTransfers(OWNER_USDT_ADDRESS, { maxTransactions: 120, pageLimit: 100 });
    for (const payment of pending) {
      const match = findPaymentTransfer(payment, transfers);
      if (!match) continue;
      const user = activateSubscription(db, payment, match);
      changed = true;
      if (user?.chatId) {
        await bot.sendMessage(
          user.chatId,
          `✅ تم تفعيل اشتراكك بنجاح.\n\nالخطة فعالة لمدة شهر.\nيمكنك الآن استخدام 50 فحص يوميا ومتابعة حتى 5 محافظ.`
        ).catch(err => logger.warn(`Subscription activation notify failed: ${err.message}`));
      }
    }

    if (changed) await saveSubscriptions(db);
  } catch (err) {
    logger.warn('Payment scan failed:', err.message);
  } finally {
    paymentScanRunning = false;
  }
}

async function scanWatchedWallets() {
  if (watchScanRunning) return;
  watchScanRunning = true;
  try {
    const db = await loadSubscriptions();
    let changed = false;
    for (const user of Object.values(db.users ?? {})) {
      if (!isSubscribed(user)) continue;
      for (const watch of user.watches ?? []) {
        try {
          const onchain = await checkOnChain(watch.address, {
            maxReviewedTransfers: WATCH_REVIEW_LIMIT,
            minAuditUsdt: 0,
            forceCounterpartyAudit: true,
          });
          watch.lastCheckedAt = new Date().toISOString();
          changed = true;

          const interactions = [
            ...(onchain.blacklistedInteractions ?? []),
            ...(onchain.localRisk?.blacklistedInteractions ?? []),
          ];
          for (const interaction of interactions) {
            const result = createOrGetAlert(db, {
              userId: user.userId,
              chatId: user.chatId,
              watchAddress: watch.address,
              interaction,
            });
            changed = changed || result.created;
          }
        } catch (err) {
          logger.warn(`Watched wallet scan failed ${watch.address}: ${err.message}`);
        }
      }
    }
    if (changed) await saveSubscriptions(db);
  } finally {
    watchScanRunning = false;
  }
}

async function sendDueAlerts(bot) {
  if (alertScanRunning) return;
  alertScanRunning = true;
  try {
    const db = await loadSubscriptions();
    const alerts = dueAlerts(db);
    if (alerts.length === 0) return;
    for (const alert of alerts) {
      await bot.sendMessage(alert.chatId, riskAlertText(alert), {
        reply_markup: {
          inline_keyboard: [[{ text: 'كتم هذا التنبيه', callback_data: `mute_alert:${alert.id}` }]],
        },
      }).catch(err => logger.warn(`Risk alert send failed ${alert.chatId}: ${err.message}`));
      markAlertSent(alert);
    }
    await saveSubscriptions(db);
  } finally {
    alertScanRunning = false;
  }
}

async function sendSubscriptionReminders(bot) {
  if (reminderScanRunning) return;
  reminderScanRunning = true;
  try {
    const db = await loadSubscriptions();
    let changed = false;
    const now = Date.now();
    for (const user of Object.values(db.users ?? {})) {
      const expiresAt = Date.parse(user.subscription?.expiresAt ?? '');
      if (!Number.isFinite(expiresAt)) continue;
      user.subscription.reminders ??= {};
      const dayBefore = expiresAt - 86_400_000;
      const fiveDaysAfter = expiresAt + 5 * 86_400_000;

      if (now >= dayBefore && now < expiresAt && !user.subscription.reminders.before1d) {
        await bot.sendMessage(user.chatId, '⏳ تذكير: اشتراكك ينتهي خلال يوم واحد. يمكنك التجديد في أي وقت من زر الاشتراك.').catch(() => {});
        user.subscription.reminders.before1d = new Date().toISOString();
        changed = true;
      } else if (now >= expiresAt && now < fiveDaysAfter && !user.subscription.reminders.expired) {
        await bot.sendMessage(user.chatId, '⚠️ انتهى اشتراكك اليوم. تم إيقاف مزايا المتابعة وحد الفحص المدفوع حتى التجديد.').catch(() => {});
        user.subscription.reminders.expired = new Date().toISOString();
        changed = true;
      } else if (now >= fiveDaysAfter && !user.subscription.reminders.after5d) {
        await bot.sendMessage(user.chatId, '💳 مرّت 5 أيام على انتهاء الاشتراك. يمكنك تجديده بـ 10 USDT لاستعادة المتابعة والتنبيهات.').catch(() => {});
        user.subscription.reminders.after5d = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await saveSubscriptions(db);
  } finally {
    reminderScanRunning = false;
  }
}

function findPaymentTransfer(payment, transfers) {
  const createdAt = Date.parse(payment.createdAt);
  const expiresAt = Date.parse(payment.expiresAt);
  return (transfers ?? []).map(normalizeTransfer).find(tx =>
    tx &&
    tx.from === payment.fromAddress &&
    tx.to === payment.toAddress &&
    tx.amount >= payment.minAmount &&
    tx.timestamp >= createdAt &&
    tx.timestamp <= expiresAt
  );
}

function normalizeTransfer(tx) {
  const decimals = tx.token_info?.decimals ?? 6;
  const amount = Number(tx.value ?? 0) / 10 ** decimals;
  const timestamp = tx.block_timestamp ?? null;
  if (!tx.from || !tx.to || !Number.isFinite(amount) || !timestamp) return null;
  return {
    from: tx.from,
    to: tx.to,
    amount,
    timestamp,
    txid: tx.transaction_id,
  };
}

function riskAlertText(alert) {
  const amount = alert.amount == null ? 'غير معروف' : `${Number(alert.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${alert.token ?? 'USDT'}`;
  const time = alert.timestamp ? shortDate(alert.timestamp) : (alert.date ?? 'وقت غير معروف');
  return [
    '🚨 تحذير مخاطر عاجل',
    '',
    'تم رصد تعامل USDT مرتبط بالقائمة السوداء على محفظة تتابعها.',
    '',
    `المحفظة: ${alert.watchAddress}`,
    `العنوان المحظور: ${alert.counterparty ?? 'غير معروف'}`,
    `المبلغ: ${amount}`,
    `الوقت: ${time}`,
    '',
    `هذا التنبيه سيتكرر حتى 5 مرات كل نصف ساعة ما لم تضغط كتم.`,
  ].join('\n');
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
