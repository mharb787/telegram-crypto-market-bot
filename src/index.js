import 'dotenv/config';
import { createBot } from './bot.js';
import { logger }    from './utils/logger.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.error('TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.');
  process.exit(1);
}

logger.info('Starting TRC20 validator bot…');
createBot(token);
logger.info('Bot is running and polling for messages.');
