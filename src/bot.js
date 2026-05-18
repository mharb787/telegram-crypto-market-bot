import TelegramBot from 'node-telegram-bot-api';
import { handleStart }   from './handlers/commandHandler.js';
import { handleMessage } from './handlers/messageHandler.js';
import { logger }        from './utils/logger.js';

export function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    handleStart(bot, msg.chat.id).catch((err) =>
      logger.error('handleStart error:', err)
    );
  });

  bot.on('message', (msg) => {
    // Skip commands (handled above)
    if (msg.text?.startsWith('/')) return;

    handleMessage(bot, msg).catch((err) =>
      logger.error('handleMessage error:', err)
    );
  });

  bot.on('polling_error', (err) => logger.error('Polling error:', err.message));

  return bot;
}
