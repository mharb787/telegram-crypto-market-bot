import { validateTRC20 } from '../validator/trc20.js';
import { checkOnChain } from '../validator/onchain.js';
import {
  loadingMessage,
  onChainReport,
  invalidAddressMessage,
  fmt,
} from '../utils/formatter.js';
import {
  ACCOUNT_BUTTON,
  CHECK_BUTTON,
  MY_WALLETS_BUTTON,
  SUBSCRIBE_BUTTON,
  WATCH_BUTTON,
  mainKeyboard,
} from './commandHandler.js';
import { logger } from '../utils/logger.js';
import { recordUsage } from '../usageLog.js';
import {
  addWatch,
  canSearch,
  consumeSearch,
  createPayment,
  getSearchAllowance,
  isSubscribed,
  loadSubscriptions,
  muteAlert,
  OWNER_USDT_ADDRESS,
  paymentWindowMinutes,
  removeWatch,
  replaceWatch,
  saveSubscriptions,
  subscriptionPrice,
  touchUser,
  watchLimit,
} from '../subscriptions.js';

export async function handleMessage(bot, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();

  if (!text) return;

  const db = await loadSubscriptions();
  const user = touchUser(db, msg);

  if (text === CHECK_BUTTON) {
    user.state = null;
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, '📥 أرسل عنوان TRON الذي تريد فحصه:', { ...mainKeyboard });
    return;
  }

  if (text === SUBSCRIBE_BUTTON) {
    user.state = { type: 'payment_from_address' };
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, subscriptionOfferText(), { ...mainKeyboard });
    return;
  }

  if (text === WATCH_BUTTON) {
    if (!isSubscribed(user)) {
      await saveSubscriptions(db);
      await bot.sendMessage(chatId, paywallText(user), { ...mainKeyboard });
      return;
    }
    user.state = { type: 'add_watch' };
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, `🛡️ أرسل عنوان TRON لإضافته للمتابعة.\n\nالحد المتاح: ${watchLimit()} محافظ.`, { ...mainKeyboard });
    return;
  }

  if (text === MY_WALLETS_BUTTON) {
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, watchedWalletsText(user), watchedWalletsOptions(user));
    return;
  }

  if (text === ACCOUNT_BUTTON) {
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, accountText(user), { ...mainKeyboard });
    return;
  }

  if (user.state?.type === 'payment_from_address') {
    await handlePaymentAddress(bot, msg, db, user, text);
    return;
  }

  if (user.state?.type === 'add_watch') {
    await handleAddWatch(bot, msg, db, user, text);
    return;
  }

  if (user.state?.type === 'edit_watch') {
    await handleEditWatch(bot, msg, db, user, text);
    return;
  }

  await handleWalletCheck(bot, msg, db, user, text);
}

export async function handleCallback(bot, query) {
  const msg = query.message;
  if (!msg) return;
  const data = query.data ?? '';
  const db = await loadSubscriptions();
  const user = touchUser(db, { chat: msg.chat, from: query.from });

  if (data.startsWith('watch_del:')) {
    const id = data.slice('watch_del:'.length);
    const removed = removeWatch(user, id);
    await saveSubscriptions(db);
    await bot.answerCallbackQuery(query.id, { text: removed ? 'تم حذف المحفظة' : 'لم يتم العثور على المحفظة' });
    await bot.sendMessage(msg.chat.id, watchedWalletsText(user), watchedWalletsOptions(user));
    return;
  }

  if (data.startsWith('watch_edit:')) {
    const id = data.slice('watch_edit:'.length);
    const watch = user.watches?.find(item => item.id === id);
    if (!watch) {
      await bot.answerCallbackQuery(query.id, { text: 'لم يتم العثور على المحفظة' });
      return;
    }
    user.state = { type: 'edit_watch', id };
    await saveSubscriptions(db);
    await bot.answerCallbackQuery(query.id, { text: 'أرسل العنوان الجديد' });
    await bot.sendMessage(msg.chat.id, `أرسل العنوان الجديد بدل:\n${watch.address}`, { ...mainKeyboard });
    return;
  }

  if (data.startsWith('mute_alert:')) {
    const id = data.slice('mute_alert:'.length);
    const muted = muteAlert(db, id);
    await saveSubscriptions(db);
    await bot.answerCallbackQuery(query.id, { text: muted ? 'تم كتم التنبيه' : 'التنبيه غير موجود' });
  }
}

async function handleWalletCheck(bot, msg, db, user, text) {
  const chatId = msg.chat.id;
  const formatResult = validateTRC20(text);

  if (!formatResult.valid) {
    await saveSubscriptions(db);
    await bot.sendMessage(
      chatId,
      invalidAddressMessage(text, formatResult.reason),
      { parse_mode: 'Markdown', ...mainKeyboard }
    );
    return;
  }

  const allowance = canSearch(user);
  if (!allowance.allowed) {
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, paywallText(user), { ...mainKeyboard });
    return;
  }

  logger.info(`On-chain check started — chat:${chatId} addr:${text}`);
  const loading = await bot.sendMessage(chatId, loadingMessage(text), { parse_mode: 'Markdown' });

  try {
    const onchain = await checkOnChain(text);
    consumeSearch(user);
    await saveSubscriptions(db);
    await recordUsage(msg, text, onchain);
    logger.info(`On-chain check done — risk:${onchain.risk} addr:${text}`);

    const report = onChainReport(text, fmt, onchain);
    await deleteMessageQuietly(bot, chatId, loading.message_id);
    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown', ...mainKeyboard });
  } catch (err) {
    logger.error('On-chain check failed:', err.message);
    await saveSubscriptions(db);
    await deleteMessageQuietly(bot, chatId, loading.message_id);
    await bot.sendMessage(
      chatId,
      `✅ *صيغة العنوان صحيحة*\n\n` +
      `\`${text}\`\n\n` +
      `⚠️ *تعذّر الاتصال بشبكة TRON*\n_${err.message}_\n\n` +
      `حاول إرسال العنوان مرة أخرى بعد قليل.`,
      { parse_mode: 'Markdown', ...mainKeyboard }
    );
  }
}

async function handlePaymentAddress(bot, msg, db, user, text) {
  const chatId = msg.chat.id;
  const formatResult = validateTRC20(text);
  if (!formatResult.valid) {
    await bot.sendMessage(chatId, 'العنوان غير صالح. أرسل عنوان TRON للمحفظة التي ستدفع منها.', { ...mainKeyboard });
    return;
  }

  const payment = createPayment(db, user, text);
  await saveSubscriptions(db);
  await bot.sendMessage(chatId, paymentInstructions(payment), { ...mainKeyboard });
}

async function handleAddWatch(bot, msg, db, user, text) {
  const chatId = msg.chat.id;
  const formatResult = validateTRC20(text);
  if (!formatResult.valid) {
    await bot.sendMessage(chatId, 'العنوان غير صالح. أرسل عنوان TRON صحيح لإضافته للمتابعة.', { ...mainKeyboard });
    return;
  }

  const result = addWatch(user, text);
  await saveSubscriptions(db);
  await bot.sendMessage(chatId, watchResultText(result), result.ok ? watchedWalletsOptions(user) : { ...mainKeyboard });
}

async function handleEditWatch(bot, msg, db, user, text) {
  const chatId = msg.chat.id;
  const formatResult = validateTRC20(text);
  if (!formatResult.valid) {
    await bot.sendMessage(chatId, 'العنوان غير صالح. أرسل عنوان TRON صحيح للتعديل.', { ...mainKeyboard });
    return;
  }

  const result = replaceWatch(user, user.state.id, text);
  await saveSubscriptions(db);
  await bot.sendMessage(chatId, result.ok ? 'تم تعديل المحفظة.' : watchResultText(result), watchedWalletsOptions(user));
}

function subscriptionOfferText() {
  return [
    '💳 الاشتراك الشهري',
    '',
    `السعر: ${subscriptionPrice()} USDT TRC20`,
    'المزايا:',
    '• 50 فحص يوميا',
    `• متابعة مخاطر حتى ${watchLimit()} محافظ`,
    '• تنبيهات تلقائية عند ظهور تعاملات خطرة',
    '',
    'أرسل الآن عنوان المحفظة التي ستدفع منها.',
  ].join('\n');
}

function paymentInstructions(payment) {
  return [
    '✅ تم فتح نافذة دفع لك.',
    '',
    `ادفع: ${payment.amount} USDT TRC20`,
    `من: ${payment.fromAddress}`,
    `إلى: ${OWNER_USDT_ADDRESS}`,
    '',
    `يجب وصول الدفعة خلال ${paymentWindowMinutes()} دقيقة.`,
    'عند وصول التحويل سيتم تفعيل الاشتراك تلقائيا.',
  ].join('\n');
}

function paywallText(user) {
  const allowance = getSearchAllowance(user);
  return [
    '🔒 وصلت للحد المجاني.',
    '',
    `المتاح للزائر: ${allowance.limit} عمليات فحص أسبوعيا.`,
    `المستخدم حاليا: ${allowance.used}/${allowance.limit}`,
    '',
    `اشترك بـ ${subscriptionPrice()} USDT شهريا لتحصل على:`,
    '• 50 فحص يوميا',
    `• متابعة مخاطر حتى ${watchLimit()} محافظ`,
    '',
    `اضغط "${SUBSCRIBE_BUTTON}" للبدء.`,
  ].join('\n');
}

function accountText(user) {
  const allowance = getSearchAllowance(user);
  const expires = user.subscription?.expiresAt ? shortDate(user.subscription.expiresAt) : '-';
  return [
    '👤 حسابي',
    '',
    `الخطة: ${isSubscribed(user) ? 'مشترك' : 'مجاني'}`,
    `ينتهي الاشتراك: ${isSubscribed(user) ? expires : '-'}`,
    `الفحوصات: ${allowance.used}/${allowance.limit} ${allowance.period}`,
    `محافظ المتابعة: ${(user.watches ?? []).length}/${watchLimit()}`,
  ].join('\n');
}

function watchedWalletsText(user) {
  if (!isSubscribed(user)) return paywallText(user);
  const watches = user.watches ?? [];
  if (watches.length === 0) {
    return `📋 لا توجد محافظ متابعة بعد.\n\nاضغط "${WATCH_BUTTON}" لإضافة محفظة.`;
  }
  return [
    '📋 محافظي المتابعة',
    '',
    ...watches.map((item, index) => `${index + 1}. ${item.address}\nآخر فحص: ${shortDate(item.lastCheckedAt)}`),
  ].join('\n\n');
}

function watchedWalletsOptions(user) {
  const rows = (user.watches ?? []).map((item, index) => ([
    { text: `تعديل ${index + 1}`, callback_data: `watch_edit:${item.id}` },
    { text: `حذف ${index + 1}`, callback_data: `watch_del:${item.id}` },
  ]));
  if (rows.length === 0) return { ...mainKeyboard };
  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function watchResultText(result) {
  if (result.ok) return '✅ تم إضافة المحفظة للمتابعة.';
  if (result.reason === 'subscription_required') return 'هذه الميزة للمشتركين فقط.';
  if (result.reason === 'exists') return 'هذه المحفظة موجودة مسبقا في المتابعة.';
  if (result.reason === 'limit') return `وصلت للحد الأقصى: ${watchLimit()} محافظ.`;
  return 'تعذر تنفيذ العملية.';
}

function shortDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function deleteMessageQuietly(bot, chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (err) {
    logger.warn('Loading message delete failed:', err.message);
  }
}
