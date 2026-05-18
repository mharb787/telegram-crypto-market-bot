import { validateTRC20 } from '../validator/trc20.js';
import { resultMessage } from '../utils/formatter.js';
import { mainKeyboard } from './commandHandler.js';
import { logger } from '../utils/logger.js';

const PROMPT_TEXT = '🔍 فحص عنوان TRC20';

/**
 * Handles any non-command message.
 * - If text matches the keyboard button, ask user to paste an address.
 * - Otherwise treat the text as a TRC20 address and validate it.
 */
export async function handleMessage(bot, msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text ?? '').trim();

  if (!text) return;

  // User tapped the persistent keyboard button
  if (text === PROMPT_TEXT) {
    await bot.sendMessage(
      chatId,
      '📥 *أرسل عنوان TRC20 الذي تريد مراجعته:*',
      { parse_mode: 'Markdown', ...mainKeyboard }
    );
    return;
  }

  // Looks like an address — validate it
  logger.info(`Validating address from chat ${chatId}: ${text}`);
  const result = validateTRC20(text);
  const reply  = resultMessage(text, result);

  await bot.sendMessage(chatId, reply, {
    parse_mode: 'Markdown',
    ...mainKeyboard,
  });
}
