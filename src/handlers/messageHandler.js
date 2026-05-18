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

  // ── Step 2: send "loading" message, then fetch on-chain data ─────────────
  logger.info(`On-chain check started — chat:${chatId} addr:${text}`);

  const loadingMsg = await bot.sendMessage(
    chatId,
    loadingMessage(text),
    { parse_mode: 'Markdown' }
  );

  try {
    const onchain = await checkOnChain(text);
    const report  = onChainReport(text, fmt, onchain);

    // Edit the loading message in-place with the full report
    await bot.editMessageText(report, {
      chat_id:    chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      ...mainKeyboard,
    });

    logger.info(`Report sent — risk:${onchain.risk} addr:${text}`);
  } catch (err) {
    logger.error('On-chain check failed:', err.message);

    await bot.editMessageText(
      `📋 *نتيجة الفحص الأولي*\n\n` +
      `\`${text}\`\n\n` +
      `✅ *صيغة العنوان:* صحيحة\n` +
      `⚠️ *تعذّر الاتصال بالشبكة* — لم يمكن جلب البيانات الآنية.\n` +
      `_حاول مرة أخرى بعد قليل._`,
      {
        chat_id:    chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown',
        ...mainKeyboard,
      }
    );
  }
}
