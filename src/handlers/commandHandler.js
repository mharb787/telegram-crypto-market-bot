import { welcomeMessage } from '../utils/formatter.js';

/** Persistent reply keyboard always shown at bottom of chat */
export const mainKeyboard = {
  reply_markup: {
    keyboard: [[{ text: '🔍 فحص عنوان TRC20' }]],
    resize_keyboard: true,
    persistent: true,
  },
};

/**
 * Handles /start command.
 * Sends welcome message + persistent keyboard.
 */
export async function handleStart(bot, chatId) {
  await bot.sendMessage(chatId, welcomeMessage(), {
    parse_mode: 'Markdown',
    ...mainKeyboard,
  });
}
