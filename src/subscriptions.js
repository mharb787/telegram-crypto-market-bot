import { readJson, writeJson } from './storage.js';

const FILE = 'subscriptions.json';
const FREE_WEEKLY_LIMIT = Math.max(1, Number(process.env.FREE_WEEKLY_LIMIT) || 3);
const PAID_DAILY_LIMIT = Math.max(1, Number(process.env.PAID_DAILY_LIMIT) || 50);
const WATCH_LIMIT = Math.max(1, Number(process.env.PAID_WATCH_LIMIT) || 5);
const SUBSCRIPTION_DAYS = Math.max(1, Number(process.env.SUBSCRIPTION_DAYS) || 30);
const PAYMENT_WINDOW_MS = Math.max(60_000, Number(process.env.PAYMENT_WINDOW_MS) || 15 * 60_000);
const SUBSCRIPTION_PRICE_USDT = Math.max(0, Number(process.env.SUBSCRIPTION_PRICE_USDT) || 10);
const PAYMENT_TOLERANCE_USDT = Math.max(0, Number(process.env.PAYMENT_TOLERANCE_USDT) || 0.05);
export const OWNER_USDT_ADDRESS = process.env.OWNER_USDT_ADDRESS || 'TM8rEU2GEDzPLGRTCWhGAyPUUnchMYojiC';

export async function loadSubscriptions() {
  return readJson(FILE, {
    version: 1,
    updatedAt: null,
    users: {},
    payments: {},
    alerts: {},
  });
}

export async function saveSubscriptions(db) {
  db.updatedAt = new Date().toISOString();
  await writeJson(FILE, db);
}

export function touchUser(db, msg) {
  const now = new Date().toISOString();
  const userId = String(msg.from?.id ?? msg.chat?.id ?? 'unknown');
  const chatId = String(msg.chat?.id ?? 'unknown');
  const username = msg.from?.username ? `@${msg.from.username}` : null;
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null;
  const user = db.users[userId] ?? {
    userId,
    chatId,
    username,
    name,
    firstSeen: now,
    lastSeen: now,
    usage: {},
    subscription: { status: 'free', expiresAt: null, reminders: {} },
    watches: [],
    state: null,
  };

  user.chatId = chatId;
  user.username = username ?? user.username;
  user.name = name ?? user.name;
  user.lastSeen = now;
  user.usage ??= {};
  user.subscription ??= { status: 'free', expiresAt: null, reminders: {} };
  user.subscription.reminders ??= {};
  user.watches ??= [];
  db.users[userId] = user;
  return user;
}

export function isSubscribed(user, nowMs = Date.now()) {
  return Boolean(user?.subscription?.expiresAt && Date.parse(user.subscription.expiresAt) > nowMs);
}

export function getPlan(user) {
  return isSubscribed(user) ? 'paid' : 'free';
}

export function getSearchAllowance(user, now = new Date()) {
  if (isSubscribed(user, now.getTime())) {
    const key = dayKey(now);
    const used = user.usage?.paidDayKey === key ? Number(user.usage.paidDayCount ?? 0) : 0;
    return { plan: 'paid', limit: PAID_DAILY_LIMIT, used, remaining: Math.max(0, PAID_DAILY_LIMIT - used), period: 'يوميا' };
  }

  const key = weekKey(now);
  const used = user.usage?.freeWeekKey === key ? Number(user.usage.freeWeekCount ?? 0) : 0;
  return { plan: 'free', limit: FREE_WEEKLY_LIMIT, used, remaining: Math.max(0, FREE_WEEKLY_LIMIT - used), period: 'أسبوعيا' };
}

export function canSearch(user, now = new Date()) {
  const allowance = getSearchAllowance(user, now);
  return { allowed: allowance.remaining > 0, ...allowance };
}

export function consumeSearch(user, now = new Date()) {
  user.usage ??= {};
  if (isSubscribed(user, now.getTime())) {
    const key = dayKey(now);
    if (user.usage.paidDayKey !== key) {
      user.usage.paidDayKey = key;
      user.usage.paidDayCount = 0;
    }
    user.usage.paidDayCount = Number(user.usage.paidDayCount ?? 0) + 1;
    return;
  }

  const key = weekKey(now);
  if (user.usage.freeWeekKey !== key) {
    user.usage.freeWeekKey = key;
    user.usage.freeWeekCount = 0;
  }
  user.usage.freeWeekCount = Number(user.usage.freeWeekCount ?? 0) + 1;
}

export function createPayment(db, user, fromAddress) {
  const existing = getPendingPayment(db, user);
  if (existing) return existing;

  const now = Date.now();
  const id = `${user.userId}-${now}`;
  const payment = {
    id,
    userId: user.userId,
    chatId: user.chatId,
    fromAddress,
    toAddress: OWNER_USDT_ADDRESS,
    amount: SUBSCRIPTION_PRICE_USDT,
    minAmount: SUBSCRIPTION_PRICE_USDT - PAYMENT_TOLERANCE_USDT,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PAYMENT_WINDOW_MS).toISOString(),
    txid: null,
  };
  db.payments[id] = payment;
  user.pendingPaymentId = id;
  user.state = null;
  return payment;
}

export function getPendingPayment(db, user) {
  const id = user?.pendingPaymentId;
  const payment = id ? db.payments?.[id] : null;
  if (!payment || payment.status !== 'pending') return null;
  if (Date.parse(payment.expiresAt) <= Date.now()) return null;
  return payment;
}

export function cancelPayment(db, user, paymentId) {
  const payment = db.payments?.[paymentId];
  if (!payment || payment.userId !== user.userId || payment.status !== 'pending') return false;
  payment.status = 'canceled';
  payment.canceledAt = new Date().toISOString();
  payment.cancelReason = 'user_canceled';
  if (user.pendingPaymentId === paymentId) user.pendingPaymentId = null;
  user.state = null;
  return true;
}

export function activateSubscription(db, payment, tx) {
  const user = db.users[payment.userId];
  if (!user) return null;
  const now = Date.now();
  payment.status = 'paid';
  payment.paidAt = new Date(now).toISOString();
  payment.txid = tx.txid;
  payment.receivedAmount = tx.amount;
  user.pendingPaymentId = null;
  user.subscription = {
    status: 'active',
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SUBSCRIPTION_DAYS * 86_400_000).toISOString(),
    reminders: {},
  };
  return user;
}

export function expireOldPayments(db) {
  const now = Date.now();
  let changed = false;
  for (const payment of Object.values(db.payments ?? {})) {
    if (payment.status !== 'pending') continue;
    const user = db.users[payment.userId];
    if (isSubscribed(user)) {
      payment.status = 'canceled';
      payment.canceledAt = new Date(now).toISOString();
      payment.cancelReason = 'subscription_active';
      if (user?.pendingPaymentId === payment.id) user.pendingPaymentId = null;
      changed = true;
      continue;
    }
    if (Date.parse(payment.expiresAt) > now) continue;
    payment.status = 'expired';
    if (user?.pendingPaymentId === payment.id) user.pendingPaymentId = null;
    changed = true;
  }
  return changed;
}

export function addWatch(user, address) {
  user.watches ??= [];
  if (!isSubscribed(user)) return { ok: false, reason: 'subscription_required' };
  if (user.watches.some(item => item.address === address)) return { ok: false, reason: 'exists' };
  if (user.watches.length >= WATCH_LIMIT) return { ok: false, reason: 'limit' };
  const now = new Date().toISOString();
  const watch = {
    id: `${Date.now()}`,
    address,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: null,
  };
  user.watches.push(watch);
  user.state = null;
  return { ok: true, watch };
}

export function removeWatch(user, id) {
  const before = user.watches?.length ?? 0;
  user.watches = (user.watches ?? []).filter(item => item.id !== id);
  return user.watches.length !== before;
}

export function replaceWatch(user, id, address) {
  const watch = (user.watches ?? []).find(item => item.id === id);
  if (!watch) return { ok: false, reason: 'not_found' };
  if ((user.watches ?? []).some(item => item.id !== id && item.address === address)) return { ok: false, reason: 'exists' };
  watch.address = address;
  watch.updatedAt = new Date().toISOString();
  user.state = null;
  return { ok: true, watch };
}

export function buildAlertKey(userId, watchAddress, interaction) {
  return [
    userId,
    watchAddress,
    interaction.alertType ?? 'confirmed',
    interaction.txid ?? interaction.date ?? interaction.timestamp ?? 'unknown',
    interaction.counterparty ?? interaction.blacklistedAddress ?? 'counterparty',
  ].join(':');
}

export function createOrGetAlert(db, { userId, chatId, watchAddress, interaction }) {
  const uniqueKey = buildAlertKey(userId, watchAddress, interaction);
  const existing = Object.values(db.alerts ?? {}).find(item => item.uniqueKey === uniqueKey);
  if (existing) return { alert: existing, created: false };
  const now = new Date().toISOString();
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const alert = {
    id,
    uniqueKey,
    userId,
    chatId,
    watchAddress,
    alertType: interaction.alertType ?? 'confirmed',
    counterparty: interaction.counterparty ?? interaction.blacklistedAddress ?? null,
    amount: interaction.amount ?? null,
    token: interaction.token ?? 'USDT',
    timestamp: interaction.timestamp ?? null,
    date: interaction.date ?? null,
    txid: interaction.txid ?? null,
    createdAt: now,
    lastSentAt: null,
    nextAt: now,
    sentCount: 0,
    muted: false,
  };
  db.alerts[id] = alert;
  return { alert, created: true };
}

export function dueAlerts(db, nowMs = Date.now()) {
  return Object.values(db.alerts ?? {}).filter(alert =>
    !alert.muted &&
    Number(alert.sentCount ?? 0) < 5 &&
    (!alert.nextAt || Date.parse(alert.nextAt) <= nowMs)
  );
}

export function markAlertSent(alert) {
  const now = Date.now();
  alert.sentCount = Number(alert.sentCount ?? 0) + 1;
  alert.lastSentAt = new Date(now).toISOString();
  alert.nextAt = new Date(now + 30 * 60_000).toISOString();
}

export function muteAlert(db, id) {
  if (id?.startsWith('g')) {
    let changed = false;
    for (const alert of Object.values(db.alerts ?? {})) {
      if (alertMuteGroupId(alert) !== id) continue;
      alert.muted = true;
      alert.mutedAt = new Date().toISOString();
      changed = true;
    }
    return changed;
  }

  if (id?.startsWith('group:')) {
    const [, userId, watchAddress, alertType] = id.split(':');
    let changed = false;
    for (const alert of Object.values(db.alerts ?? {})) {
      if (alert.userId !== userId || alert.watchAddress !== watchAddress || (alert.alertType ?? 'confirmed') !== alertType) continue;
      alert.muted = true;
      alert.mutedAt = new Date().toISOString();
      changed = true;
    }
    return changed;
  }

  const alert = db.alerts?.[id];
  if (!alert) return false;
  alert.muted = true;
  alert.mutedAt = new Date().toISOString();
  return true;
}

export function alertMuteGroupId(alert) {
  return `g${shortHash([
    alert.userId,
    alert.watchAddress,
    alert.alertType ?? 'confirmed',
  ].join(':'))}`;
}

export function watchLimit() {
  return WATCH_LIMIT;
}

export function subscriptionPrice() {
  return SUBSCRIPTION_PRICE_USDT;
}

export function paymentWindowMinutes() {
  return Math.round(PAYMENT_WINDOW_MS / 60_000);
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function shortHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
