const DEFAULT_LIMIT = 100;

export function investigateAddress(address, { riskDb, usage, subs, limit = DEFAULT_LIMIT } = {}) {
  const normalized = String(address ?? '').trim();
  const edges = Object.values(riskDb?.edges ?? {});
  const edgeMap = buildEdgeMap(edges);
  const directMap = edgeMap.get(normalized) ?? new Map();
  const directAddresses = [...directMap.keys()];
  const secondMap = new Map();

  for (const directAddress of directAddresses) {
    const neighbors = edgeMap.get(directAddress) ?? new Map();
    for (const [secondAddress, secondEdges] of neighbors) {
      if (secondAddress === normalized || directMap.has(secondAddress)) continue;
      const current = secondMap.get(secondAddress) ?? { address: secondAddress, via: new Set(), edges: [] };
      current.via.add(directAddress);
      current.edges.push(...secondEdges);
      secondMap.set(secondAddress, current);
    }
  }

  const direct = directAddresses.map(related => buildRelationItem({
    address: related,
    degree: 1,
    edges: directMap.get(related) ?? [],
    users: userMatchesForAddress(usage, related),
    watchers: watchMatchesForAddress(subs, related),
    risk: riskInfo(riskDb, related),
  }));

  const indirect = [...secondMap.values()].map(item => buildRelationItem({
    address: item.address,
    degree: 2,
    via: [...item.via],
    edges: item.edges,
    users: userMatchesForAddress(usage, item.address),
    watchers: watchMatchesForAddress(subs, item.address),
    risk: riskInfo(riskDb, item.address),
  }));

  const self = {
    address: normalized,
    users: userMatchesForAddress(usage, normalized),
    watchers: watchMatchesForAddress(subs, normalized),
    risk: riskInfo(riskDb, normalized),
  };

  const directHits = direct.filter(item => hasHumanMatch(item));
  const indirectHits = indirect.filter(item => hasHumanMatch(item));
  const riskyDirect = direct.filter(item => isRisky(item.risk));
  const riskyIndirect = indirect.filter(item => isRisky(item.risk));

  return {
    address: normalized,
    generatedAt: new Date().toISOString(),
    summary: {
      directUserMatches: self.users.length,
      directWatchMatches: self.watchers.length,
      directRelations: direct.length,
      indirectRelations: indirect.length,
      directRelatedUserMatches: countUniqueUsers(directHits),
      indirectRelatedUserMatches: countUniqueUsers(indirectHits),
      riskyDirect: riskyDirect.length,
      riskyIndirect: riskyIndirect.length,
      blacklistedInNetwork: [...direct, ...indirect, self].filter(item => item.risk?.isBlacklisted === true).length,
    },
    self,
    direct: sortRelationItems(direct).slice(0, limit),
    directHits: sortRelationItems(directHits).slice(0, limit),
    indirect: sortRelationItems(indirect).slice(0, limit),
    indirectHits: sortRelationItems(indirectHits).slice(0, limit),
    riskyDirect: sortRelationItems(riskyDirect).slice(0, limit),
    riskyIndirect: sortRelationItems(riskyIndirect).slice(0, limit),
  };
}

export function formatInvestigationForTelegram(result, { webUrl = null } = {}) {
  const lines = [
    '<b>تقرير تحقيق عنوان</b>',
    '',
    `<code>${escapeHtml(result.address)}</code>`,
    '',
    '<b>الملخص</b>',
    `• بحث مباشر عن العنوان: <b>${result.summary.directUserMatches}</b> مستخدم`,
    `• متابعة مباشرة للعنوان: <b>${result.summary.directWatchMatches}</b> مستخدم`,
    `• علاقات مباشرة: <b>${result.summary.directRelations}</b>`,
    `• علاقات غير مباشرة: <b>${result.summary.indirectRelations}</b>`,
    `• مستخدمون بحثوا/تابعوا عناوين مرتبطة مباشرة: <b>${result.summary.directRelatedUserMatches}</b>`,
    `• مستخدمون بحثوا/تابعوا عناوين مرتبطة غير مباشرة: <b>${result.summary.indirectRelatedUserMatches}</b>`,
    `• عناوين محظورة داخل الشبكة: <b>${result.summary.blacklistedInNetwork}</b>`,
    '',
    '<b>مطابقة العنوان نفسه</b>',
    ...formatUserMatches(result.self.users, result.self.watchers),
    '',
    '<b>أهم ارتباطات مباشرة عليها مستخدمون</b>',
    ...formatRelationHits(result.directHits, 8),
    '',
    '<b>أهم ارتباطات غير مباشرة عليها مستخدمون</b>',
    ...formatRelationHits(result.indirectHits, 8),
  ];

  if (webUrl) {
    lines.push('', `<a href="${escapeHtml(webUrl)}">فتح لوحة الويب للتفاصيل</a>`);
  }

  return lines.join('\n');
}

function buildEdgeMap(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!edge.from || !edge.to) continue;
    addEdge(map, edge.from, edge.to, edge);
    addEdge(map, edge.to, edge.from, edge);
  }
  return map;
}

function addEdge(map, from, to, edge) {
  if (!map.has(from)) map.set(from, new Map());
  const neighbors = map.get(from);
  if (!neighbors.has(to)) neighbors.set(to, []);
  neighbors.get(to).push(edge);
}

function buildRelationItem({ address, degree, via = [], edges, users, watchers, risk }) {
  const latestEdge = [...edges].sort((a, b) => dateValue(b.timestamp ?? b.date) - dateValue(a.timestamp ?? a.date))[0] ?? null;
  const totalAmount = edges.reduce((sum, edge) => sum + Number(edge.amount ?? 0), 0);
  return {
    address,
    degree,
    via,
    edgeCount: edges.length,
    totalAmount,
    latestAt: latestEdge?.timestamp ?? latestEdge?.date ?? null,
    latestTxid: latestEdge?.txid ?? null,
    sampleEdges: edges.slice(0, 5),
    users,
    watchers,
    risk,
  };
}

function userMatchesForAddress(usage, address) {
  return Object.values(usage?.users ?? {})
    .filter(user => user.addresses?.[address])
    .map(user => {
      const item = user.addresses[address];
      return {
        userId: user.userId,
        chatId: user.chatId,
        username: user.username,
        name: user.name,
        count: item.count ?? 0,
        firstSeen: item.firstSeen ?? null,
        lastSeen: item.lastSeen ?? null,
        lastRisk: item.lastRisk ?? null,
        lastBlacklisted: item.lastBlacklisted ?? null,
      };
    })
    .sort((a, b) => dateValue(b.lastSeen) - dateValue(a.lastSeen));
}

function watchMatchesForAddress(subs, address) {
  const matches = [];
  for (const user of Object.values(subs?.users ?? {})) {
    for (const watch of user.watches ?? []) {
      if (watch.address !== address) continue;
      matches.push({
        userId: user.userId,
        chatId: user.chatId,
        username: user.username,
        name: user.name,
        createdAt: watch.createdAt,
        lastCheckedAt: watch.lastCheckedAt,
        lastSuccessfulCheckedAt: watch.lastSuccessfulCheckedAt,
        lastRisk: watch.lastRisk,
        lastSuccessfulRisk: watch.lastSuccessfulRisk,
      });
    }
  }
  return matches.sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt));
}

function riskInfo(riskDb, address) {
  const info = riskDb?.addresses?.[address] ?? null;
  return {
    isKnown: Boolean(info),
    isBlacklisted: info?.isBlacklisted ?? null,
    wasBlacklisted: info?.wasBlacklisted ?? false,
    sources: info?.sources ?? [],
    firstSeen: info?.firstSeen ?? null,
    lastChecked: info?.lastChecked ?? null,
  };
}

function hasHumanMatch(item) {
  return item.users.length > 0 || item.watchers.length > 0;
}

function isRisky(risk) {
  return risk?.isBlacklisted === true || risk?.wasBlacklisted === true;
}

function countUniqueUsers(items) {
  const ids = new Set();
  for (const item of items) {
    for (const user of item.users) ids.add(user.userId);
    for (const user of item.watchers) ids.add(user.userId);
  }
  return ids.size;
}

function sortRelationItems(items) {
  return [...items].sort((a, b) =>
    Number(hasHumanMatch(b)) - Number(hasHumanMatch(a)) ||
    Number(b.risk?.isBlacklisted === true) - Number(a.risk?.isBlacklisted === true) ||
    b.edgeCount - a.edgeCount ||
    dateValue(b.latestAt) - dateValue(a.latestAt)
  );
}

function formatUserMatches(users, watchers) {
  const lines = [];
  if (users.length === 0 && watchers.length === 0) return ['لا يوجد مستخدم بحث عن العنوان نفسه أو يتابعه.'];
  for (const user of users.slice(0, 8)) {
    lines.push(`• بحث: ${formatUser(user)} | عدد: <b>${user.count}</b> | آخر: <code>${shortDate(user.lastSeen)}</code>`);
  }
  for (const user of watchers.slice(0, 8)) {
    lines.push(`• متابعة: ${formatUser(user)} | منذ: <code>${shortDate(user.createdAt)}</code>`);
  }
  return lines;
}

function formatRelationHits(items, max) {
  if (items.length === 0) return ['لا يوجد ضمن البيانات الحالية.'];
  return items.slice(0, max).map((item, index) => {
    const via = item.via?.length ? ` | عبر: <code>${escapeHtml(item.via[0])}</code>` : '';
    const users = [...item.users, ...item.watchers].slice(0, 3).map(formatUser).join('، ');
    return `${index + 1}. <code>${escapeHtml(item.address)}</code>${via}\n   مستخدمون: ${users || '-'}\n   علاقات: <b>${item.edgeCount}</b> | آخر: <code>${shortDate(item.latestAt)}</code>`;
  });
}

function formatUser(user) {
  return escapeHtml(user.username || user.name || user.userId || '-');
}

function shortDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateValue(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
