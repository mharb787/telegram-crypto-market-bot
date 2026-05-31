import fs from 'node:fs/promises';

const query = process.argv[2];
const enabled = process.argv[3] !== 'false';

if (!query) {
  console.error('Usage: node scripts/setUnlimitedSearches.mjs USERNAME_OR_ID [true|false]');
  process.exit(1);
}

const file = 'data/subscriptions.json';
const db = JSON.parse(await fs.readFile(file, 'utf8'));
const normalize = value => String(value ?? '').trim().replace(/^@/, '').toLowerCase();
const needle = normalize(query);

const user = Object.values(db.users ?? {}).find(item =>
  normalize(item.userId) === needle ||
  normalize(item.username) === needle ||
  normalize(item.chatId) === needle ||
  normalize(item.name) === needle
);

if (!user) {
  console.log(JSON.stringify({ ok: false, reason: 'not_found', query }));
  process.exit(2);
}

user.usage ??= {};
user.usage.unlimitedSearches = enabled;
user.usage.unlimitedGrantedAt = new Date().toISOString();
db.updatedAt = new Date().toISOString();

await fs.writeFile(file, JSON.stringify(db, null, 2));

console.log(JSON.stringify({
  ok: true,
  userId: user.userId,
  username: user.username ?? null,
  name: user.name ?? null,
  unlimitedSearches: user.usage.unlimitedSearches,
}));
