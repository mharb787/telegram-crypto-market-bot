import { validateTRC20 }   from '../validator/trc20.js';
import { checkOnChain }    from '../validator/onchain.js';
import {
  loadingMessage,
  onChainReport,
  invalidAddressMessage,
  fmt,
} from '../utils/formatter.js';
import { mainKeyboard } from './commandHandler.js';
import { logger }       from '../utils/logger.js';

const PROMPT_TEXT = '🔍 فحص عنوان TRC20';

export async function handleMessage(bot, msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text ?? '').trim();

  if (!text) return;

  // User tapped the keyboard button → prompt for address
  if (text === PROMPT_TEXT) {
    await bot.sendMessage(
      chatId,
      '📥 *أرسل عنوان TRC20 الذي تريد مراجعته:*',
      { parse_mode: 'Markdown', ...mainKeyboard }
    );
    return;
  }

  // ── Step 1: format validation (instant) ──────────────────────────────────
  const formatResult = validateTRC20(text);

  if (!formatResult.valid) {
    await bot.sendMessage(
      chatId,
      invalidAddressMessage(text, formatResult.reason),
      { parse_mode: 'Markdown', ...mainKeyboard }
    );
    return;
  }

  // ── Step 2: send loading message ─────────────────────────────────────────
  logger.info(`On-chain check started — chat:${chatId} addr:${text}`);
  await bot.sendMessage(chatId, loadingMessage(text), { parse_mode: 'Markdown' });

  // ── Step 3: fetch on-chain data and send result as a new message ──────────
  try {
    const onchain = await checkOnChain(text);
    logger.info(`On-chain check done — risk:${onchain.risk} addr:${text}`);

    const report = onChainReport(text, fmt, onchain);
    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown', ...mainKeyboard });

  } catch (err) {
    logger.error('On-chain check failed:', err.message);
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
