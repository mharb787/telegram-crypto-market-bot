import TelegramBot from 'node-telegram-bot-api';
import { handleStart }   from './handlers/commandHandler.js';
import { handleCallback, handleMessage, handlePaidCommand } from './handlers/messageHandler.js';
import { startSubscriptionTasks } from './subscriptionTasks.js';
import { logger }        from './utils/logger.js';

export function createBot(token) {
  const bot = new TelegramBot(token, {
    polling: {
      interval: 300,
      // Telegram keeps the last allowed_updates value when it is omitted.
      // Request callback_query explicitly so inline buttons keep working even
      // if another deployment previously limited polling to messages only.
      params: {
        timeout: 10,
        allowed_updates: ['message', 'callback_query'],
      },
    },
    // The library keeps HTTP connections alive by default. Without a client-side
    // timeout, a half-open Telegram connection can leave polling stuck forever.
    request: { timeout: 30_000 },
  });

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

  bot.onText(/\/paid/, (msg) => {
    handlePaidCommand(bot, msg).catch((err) =>
      logger.error('handlePaidCommand error:', err)
    );
  });

  bot.on('callback_query', (query) => {
    logger.info(
      `Callback received — chat:${query.message?.chat?.id ?? '-'} data:${query.data ?? '-'}`
    );
    handleCallback(bot, query).catch((err) =>
      logger.error('handleCallback error:', err)
    );
  });

  bot.on('polling_error', (err) => logger.error('Polling error:', err.message));

  startSubscriptionTasks(bot);

  return bot;
}
