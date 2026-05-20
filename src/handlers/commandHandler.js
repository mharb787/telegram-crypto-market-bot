import { welcomeMessage } from '../utils/formatter.js';

export const CHECK_BUTTON = '🔎 فحص عنوان TRC20';
export const SUBSCRIBE_BUTTON = '💳 الاشتراك';
export const WATCH_BUTTON = '🛡️ متابعة المخاطر على عنوانك';
export const MY_WALLETS_BUTTON = '📋 محافظي المتابعة';
export const ACCOUNT_BUTTON = '👤 حسابي';

export const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: CHECK_BUTTON }],
      [{ text: WATCH_BUTTON }, { text: MY_WALLETS_BUTTON }],
      [{ text: SUBSCRIBE_BUTTON }, { text: ACCOUNT_BUTTON }],
    ],
    resize_keyboard: true,
    persistent: true,
  },
};

export async function handleStart(bot, chatId) {
  await bot.sendMessage(chatId, welcomeMessage(), {
    parse_mode: 'Markdown',
    ...mainKeyboard,
  });
}
