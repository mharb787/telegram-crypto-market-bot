import { readJson, writeJson } from './storage.js';

const USAGE_FILE = 'usage-log.json';
const MAX_EVENTS = Math.max(500, Number(process.env.USAGE_LOG_LIMIT) || 5000);

export async function recordUsage(msg, address, result = {}) {
  const log = await loadUsageLog();
  const userId = String(msg.from?.id ?? msg.chat?.id ?? 'unknown');
  const chatId = String(msg.chat?.id ?? 'unknown');
  const username = msg.from?.username ? `@${msg.from.username}` : null;
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null;
  const now = new Date().toISOString();

  const user = log.users[userId] ?? {
    userId,
    chatId,
    username,
    name,
    firstSeen: now,
    lastSeen: now,
    searches: 0,
    addresses: {},
  };

  user.chatId = chatId;
  user.username = username ?? user.username;
  user.name = name ?? user.name;
  user.lastSeen = now;
  user.searches += 1;
  user.addresses[address] = {
    address,
    count: (user.addresses[address]?.count ?? 0) + 1,
    firstSeen: user.addresses[address]?.firstSeen ?? now,
    lastSeen: now,
    lastRisk: result.risk ?? null,
    lastBlacklisted: result.blacklisted ?? null,
  };

  log.users[userId] = user;
  log.events.push({
    at: now,
    userId,
    chatId,
    username,
    name,
    address,
    risk: result.risk ?? null,
    blacklisted: result.blacklisted ?? null,
  });
  log.events = log.events.slice(-MAX_EVENTS);
  log.updatedAt = now;
  await writeJson(USAGE_FILE, log);
}

export async function loadUsageLog() {
  return readJson(USAGE_FILE, {
    version: 1,
    updatedAt: null,
    users: {},
    events: [],
  });
}
