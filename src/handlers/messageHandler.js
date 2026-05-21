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
  cancelPayment,
  canSearch,
  consumeSearch,
  createPayment,
  getPendingPayment,
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
import { scanPayments, scanSingleWatchedWallet } from '../subscriptionTasks.js';

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
    if (isSubscribed(user)) {
      user.state = null;
      await saveSubscriptions(db);
      await bot.sendMessage(chatId, `✅ اشتراكك فعال حتى ${shortDate(user.subscription.expiresAt)}.\n\nيمكنك استخدام الفحص المدفوع ومتابعة المحافظ الآن.`, { ...mainKeyboard });
      return;
    }

    const pending = getPendingPayment(db, user);
    if (pending) {
      await saveSubscriptions(db);
      await bot.sendMessage(chatId, pendingPaymentText(pending), paymentOptions(pending));
      return;
    }

    user.state = null;
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, subscriptionOfferText(), subscribeNowOptions());
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
    return;
  }

  if (data.startsWith('payment_check:')) {
    const id = data.slice('payment_check:'.length);
    await bot.answerCallbackQuery(query.id, { text: 'جاري التحقق من الدفع...' });
    await verifyPaymentStatus(bot, msg.chat.id, db, user, id);
    return;
  }

  if (data === 'subscribe_now') {
    if (isSubscribed(user)) {
      user.state = null;
      await saveSubscriptions(db);
      await bot.answerCallbackQuery(query.id, { text: 'اشتراكك فعال حاليا' });
      await bot.sendMessage(msg.chat.id, `✅ اشتراكك فعال حتى ${shortDate(user.subscription.expiresAt)}.`, { ...mainKeyboard });
      return;
    }

    const pending = getPendingPayment(db, user);
    if (pending) {
      await saveSubscriptions(db);
      await bot.answerCallbackQuery(query.id, { text: 'لديك نافذة دفع مفتوحة' });
      await bot.sendMessage(msg.chat.id, pendingPaymentText(pending), paymentOptions(pending));
      return;
    }

    user.state = { type: 'payment_from_address' };
    await saveSubscriptions(db);
    await bot.answerCallbackQuery(query.id, { text: 'أرسل عنوان الدفع' });
    await bot.sendMessage(msg.chat.id, 'أرسل عنوان TRC20 الذي سترسل منه الدفعة.', { ...mainKeyboard });
    return;
  }

  if (data.startsWith('payment_cancel:')) {
    const id = data.slice('payment_cancel:'.length);
    const canceled = cancelPayment(db, user, id);
    await saveSubscriptions(db);
    await bot.answerCallbackQuery(query.id, { text: canceled ? 'تم إلغاء الدفعة' : 'لا توجد دفعة قابلة للإلغاء' });
    await bot.sendMessage(
      msg.chat.id,
      canceled ? 'تم إلغاء نافذة الدفع. يمكنك فتح اشتراك جديد متى أردت.' : 'لا توجد نافذة دفع مفتوحة قابلة للإلغاء.',
      { ...mainKeyboard }
    );
  }
}

export async function handlePaidCommand(bot, msg) {
  const db = await loadSubscriptions();
  const user = touchUser(db, msg);
  const pending = getPendingPayment(db, user);
  if (!pending) {
    await saveSubscriptions(db);
    await bot.sendMessage(msg.chat.id, 'لا توجد نافذة دفع مفتوحة حاليا. اضغط زر الاشتراك للبدء.', { ...mainKeyboard });
    return;
  }
  await verifyPaymentStatus(bot, msg.chat.id, db, user, pending.id);
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
  if (isSubscribed(user)) {
    user.state = null;
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, `✅ اشتراكك فعال حتى ${shortDate(user.subscription.expiresAt)}. لا تحتاج فتح نافذة دفع جديدة.`, { ...mainKeyboard });
    return;
  }

  const existing = getPendingPayment(db, user);
  if (existing) {
    user.state = null;
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, pendingPaymentText(existing), paymentOptions(existing));
    return;
  }

  const formatResult = validateTRC20(text);
  if (!formatResult.valid) {
    await bot.sendMessage(chatId, 'العنوان غير صالح. أرسل عنوان TRON للمحفظة التي ستدفع منها.', { ...mainKeyboard });
    return;
  }

  const payment = createPayment(db, user, text);
  await saveSubscriptions(db);
  await bot.sendMessage(chatId, paymentInstructions(payment), paymentOptions(payment));
}

async function verifyPaymentStatus(bot, chatId, db, user, paymentId) {
  const payment = db.payments?.[paymentId];
  if (!payment || payment.userId !== user.userId) {
    await saveSubscriptions(db);
    await bot.sendMessage(chatId, 'لا توجد نافذة دفع مطابقة لهذا الطلب.', { ...mainKeyboard });
    return;
  }

  await scanPayments(bot);
  const fresh = await loadSubscriptions();
  const updated = fresh.payments?.[paymentId];
  const freshUser = fresh.users?.[user.userId];
  if (updated?.status === 'paid' || isSubscribed(freshUser)) {
    await bot.sendMessage(chatId, '✅ تم تأكيد الدفع وتفعيل الاشتراك بنجاح.', { ...mainKeyboard });
    return;
  }

  if (updated?.status === 'expired') {
    await bot.sendMessage(chatId, 'انتهت نافذة الدفع. اضغط زر الاشتراك لفتح نافذة جديدة.', { ...mainKeyboard });
    return;
  }

  await bot.sendMessage(
    chatId,
    '⏳ لم يظهر التحويل بعد.\n\nالرجاء الانتظار قليلا، وسيتم التفعيل تلقائيا عند وصول الدفع. يمكنك الضغط على "تم الدفع" مرة أخرى بعد دقيقة.',
    cancelPaymentOptions(updated ?? payment)
  );
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
  if (!result.ok) {
    await bot.sendMessage(chatId, watchResultText(result), { ...mainKeyboard });
    return;
  }

  const waiting = await bot.sendMessage(chatId, '✅ تم إضافة المحفظة للمتابعة.\n\nجاري فحصها بدقة الآن...');
  const freshDb = await loadSubscriptions();
  const freshUser = freshDb.users?.[user.userId];
  const freshWatch = freshUser?.watches?.find(item => item.id === result.watch.id);
  if (!freshUser || !freshWatch) {
    await deleteMessageQuietly(bot, chatId, waiting.message_id);
    await bot.sendMessage(chatId, 'تمت الإضافة، لكن تعذر تشغيل الفحص الفوري الآن.', { ...mainKeyboard });
    return;
  }

  const scan = await scanSingleWatchedWallet(freshDb, freshUser, freshWatch);
  await saveSubscriptions(freshDb);
  await deleteMessageQuietly(bot, chatId, waiting.message_id);
  await bot.sendMessage(chatId, immediateWatchScanText(scan), watchedWalletsOptions(freshUser));
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
    `السعر: ${subscriptionPrice()} USDT`,
    'الشبكة: TRC20',
    'المزايا:',
    '• 50 فحص يوميا',
    `• متابعة مخاطر حتى ${watchLimit()} محافظ`,
    '• تنبيهات تلقائية عند ظهور تعاملات خطرة',
  ].join('\n');
}

function subscribeNowOptions() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'اشترك الآن', callback_data: 'subscribe_now' },
      ]],
    },
  };
}

function paymentInstructions(payment) {
  return [
    '✅ تم فتح نافذة دفع لك.',
    '',
    `ادفع: <b>${payment.amount} USDT TRC20</b>`,
    `من: <code>${payment.fromAddress}</code>`,
    `إلى: <code>${OWNER_USDT_ADDRESS}</code>`,
    '',
    `يجب وصول الدفعة خلال ${paymentWindowMinutes()} دقيقة.`,
    'عند وصول التحويل سيتم تفعيل الاشتراك تلقائيا.',
    '',
    'بعد الدفع اضغط زر "تم الدفع" أو أرسل /paid للتحقق السريع.',
  ].join('\n');
}

function pendingPaymentText(payment) {
  return [
    '⏳ لديك نافذة دفع مفتوحة بالفعل.',
    '',
    `ادفع: <b>${payment.amount} USDT TRC20</b>`,
    `من: <code>${payment.fromAddress}</code>`,
    `إلى: <code>${OWNER_USDT_ADDRESS}</code>`,
    `تنتهي: ${shortDate(payment.expiresAt)}`,
    '',
    'إذا دفعت بالفعل اضغط "تم الدفع" أو أرسل /paid.',
    'إذا لم يظهر الدفع مباشرة، الرجاء الانتظار قليلا حتى تؤكده الشبكة.',
  ].join('\n');
}

function paymentOptions(payment) {
  return {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'نسخ عنوان الدفع', copy_text: { text: OWNER_USDT_ADDRESS } }],
        [{ text: 'تم الدفع', callback_data: `payment_check:${payment.id}` }],
        [{ text: 'إلغاء الدفعة', callback_data: `payment_cancel:${payment.id}` }],
      ],
    },
  };
}

function cancelPaymentOptions(payment) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'إلغاء الدفعة', callback_data: `payment_cancel:${payment.id}` },
      ]],
    },
  };
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

function immediateWatchScanText(scan) {
  if (scan.error) {
    return `تمت إضافة المحفظة، لكن تعذر إكمال الفحص الفوري الآن.\n\nالسبب: ${scan.error.message}\nسيعاد فحصها تلقائيا كل ساعة.`;
  }

  if (scan.alertsCreated > 0) {
    const indirect = (scan.interactions ?? []).filter(item => item.alertType === 'indirect').length;
    const confirmed = scan.alertsCreated - indirect;
    return [
      '🚨 تمت إضافة المحفظة وتم رصد تعاملات خطرة ضمن الفحص الحالي.',
      '',
      `خطر مؤكد: ${confirmed}`,
      `خطر غير مباشر: ${indirect}`,
      'سيتم إرسال تنبيه المخاطر ومتابعته تلقائيا.',
    ].join('\n');
  }

  if (scan.onchain?.apiError) {
    return 'تمت إضافة المحفظة، لكن الفحص الفوري غير مكتمل بسبب ضغط أو خطأ من مزود الشبكة. سيعاد فحصها تلقائيا كل ساعة.';
  }

  const localCount = scan.onchain?.localRisk?.blacklistedInteractionCount ?? 0;
  if (localCount > 0) {
    return `⚠️ تمت إضافة المحفظة للمتابعة وفحصها الآن.\nتوجد تعاملات سابقة مع القائمة السوداء: ${localCount} عملية.\nسيتم مراقبة المحفظة وإبلاغك بأي تعاملات خطرة جديدة.`;
  }

  return '✅ تمت إضافة المحفظة للمتابعة وفحصها الآن.\nلم تظهر مؤشرات خطر ضمن الفحص الحالي، وسيتم إبلاغك عند ظهور أي مخاطر.';
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
