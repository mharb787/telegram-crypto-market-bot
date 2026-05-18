const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 2;
const ts = () => new Date().toISOString();

export const logger = {
  error: (...a) => current >= 0 && console.error(`[${ts()}] ERROR`, ...a),
  warn:  (...a) => current >= 1 && console.warn(`[${ts()}]  WARN`, ...a),
  info:  (...a) => current >= 2 && console.log(`[${ts()}]  INFO`, ...a),
  debug: (...a) => current >= 3 && console.log(`[${ts()}] DEBUG`, ...a),
};
