export function welcomeMessage() {
  return rtlLines([
    '👋 أهلا بك في بوت فحص محافظ TRON USDT.',
    '',
    'أرسل أي عنوان TRON وسيتم فحص:',
    '• حالة الحظر من Tether',
    '• رصيد USDT',
    '• التعاملات المعروفة مع القائمة السوداء',
    '• عمر ونشاط المحفظة',
  ]);
}

export function loadingMessage(address) {
  return rtlLines([
    '⏳ جاري فحص المحفظة...',
    '',
    address,
    '',
    'يتم التحقق من حالة الحظر، معاملات USDT، وتفاصيل المحفظة.',
  ]);
}

export function onChainReport(address, fmtNumber, onchain) {
  const localCount = onchain.localRisk?.blacklistedInteractionCount ?? 0;
  const directCount = onchain.blacklistedInteractions?.length ?? 0;
  const blacklistTxCount = Math.max(localCount, directCount);
  const events = collectRiskEvents(address, onchain).slice(0, 5);
  const ageDays = onchain.age?.days;
  const avgTxsPerDay = ageDays > 0 ? (onchain.totalTransactions ?? 0) / ageDays : 0;

  return rtlLines([
    '📋 *نتيجة فحص المحفظة*',
    '',
    '*الشبكة:* TRON',
    `*العنوان:* \`${address}\``,
    `📂 *النوع:* ${walletType(onchain, blacklistTxCount)}`,
    `🛡️ *حالة العنوان نفسه:* ${directBlacklistStatus(onchain)}`,
    '',
    '💰 *الرصيد والحالة*',
    `*USDT:* $${fmtNumber(onchain.balance?.usdt ?? 0, 2)} — ${statusLabel(onchain)}`,
    '',
    '🔗 *الارتباطات*',
    connectionSummary(blacklistTxCount),
    usdtScopeNote(onchain, blacklistTxCount),
    '',
    '📜 *سجل الأحداث*',
    ...formatEvents(events, fmtNumber),
    '',
    '📊 *تفاصيل المحفظة*',
    '⏱️ *السلوك:*',
    `• *العمر:* ${ageDays ?? 'غير معروف'}${ageDays === undefined ? '' : ' يوم'}`,
    `• *النشاط:* ${activityLabel(avgTxsPerDay, onchain.totalTransactions ?? 0)}`,
    `• *العناوين المقابلة:* ${onchain.checkedCounterparties ?? 0}`,
    `• *متوسط العمليات/اليوم:* ${avgTxsPerDay.toFixed(2)}`,
  ]);
}

export function invalidAddressMessage(address, reason) {
  return rtlLines([
    '❌ *عنوان TRON غير صالح*',
    '',
    `\`${address}\``,
    '',
    `*السبب:* ${reason}`,
  ]);
}

function walletType(onchain, blacklistTxCount) {
  if (onchain.apiError) return 'فحص غير مكتمل';
  if (onchain.blacklisted === true) return 'عنوان محظور';
  if (blacklistTxCount > 0) return 'غير محظور لكنه تعامل مع القائمة السوداء';
  if (onchain.blacklisted === null) return 'تعذر التحقق منه';
  if ((onchain.totalTransactions ?? 0) === 0) return 'لا توجد معاملات USDT ضمن الفحص الحالي';
  return 'لم تظهر مؤشرات خطر ضمن الفحص الحالي';
}

function statusLabel(onchain) {
  if (onchain.blacklisted === true) return '❌ محظور';
  if (onchain.risk === 'high') return '⚠️ عالي الخطورة';
  if (onchain.blacklisted === false) return '✅ غير محظور';
  return '⚠️ غير معروف';
}

function directBlacklistStatus(onchain) {
  if (onchain.blacklisted === true) return '❌ محظور من Tether';
  if (onchain.blacklisted === false) return '✅ غير محظور من Tether';
  return '⚠️ تعذر التحقق';
}

function connectionSummary(blacklistTxCount) {
  if (blacklistTxCount === 0) {
    return '✅ *تعاملات USDT مع القائمة السوداء:* لم تظهر ضمن الفحص الحالي';
  }
  if (blacklistTxCount > 0) {
    return `⚠️ *تعاملات USDT مع القائمة السوداء:* ${blacklistTxCount} عملية`;
  }
}

function usdtScopeNote(onchain, blacklistTxCount) {
  if (onchain.apiError) {
    return '⚠️ *تنبيه:* تعذر إكمال الفحص الخارجي، لذلك لا يمكن الجزم بالنتيجة النهائية';
  }
  if ((onchain.totalTransactions ?? 0) === 0) {
    return 'ℹ️ *نطاق الفحص:* لم يتم العثور على معاملات USDT لهذا العنوان ضمن حد الفحص الحالي';
  }
  if (blacklistTxCount === 0) {
    return `ℹ️ *نطاق الفحص:* تم فحص آخر ${onchain.reviewedTransactions ?? onchain.totalTransactions} معاملة USDT ولم تظهر تعاملات محظورة`;
  }
  return 'ℹ️ *نطاق الفحص:* العلاقات أعلاه محسوبة من معاملات USDT فقط';
}

function collectRiskEvents(address, onchain) {
  const direct = (onchain.blacklistedInteractions ?? []).map(item => ({
    timestamp: item.timestamp ?? parseDate(item.date),
    date: item.date,
    amount: item.amount,
    token: item.token ?? 'USDT',
    counterparty: item.counterparty,
  }));

  const local = (onchain.localRisk?.blacklistedInteractions ?? []).map(item => ({
    timestamp: item.timestamp ?? parseDate(item.date),
    date: item.date,
    amount: item.amount,
    token: item.token ?? 'USDT',
    counterparty: item.blacklistedAddress ?? (item.from === address ? item.to : item.from),
  }));

  const seen = new Set();
  return [...direct, ...local]
    .filter(item => {
      const key = `${item.timestamp}:${item.amount}:${item.counterparty}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function formatEvents(events, fmtNumber) {
  if (events.length === 0) return ['لا توجد أحداث USDT مع عناوين محظورة ضمن البيانات الحالية.'];
  return events.map(item => {
    const date = item.timestamp ? formatUtcDate(item.timestamp) : (item.date ?? 'وقت غير معروف');
    return `🔴 ${date}: ❌ *${fmtNumber(item.amount, 2)} ${item.token ?? 'USDT'}*`;
  });
}

function parseDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatUtcDate(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function activityLabel(avgTxsPerDay, totalTransactions) {
  if (totalTransactions === 0) return 'غير نشط';
  if (avgTxsPerDay < 0.05) return 'نادر';
  if (avgTxsPerDay < 1) return 'متقطع';
  if (avgTxsPerDay < 5) return 'نشط';
  return 'نشاط مرتفع';
}

function rtlLines(lines) {
  const rtlMark = '\u200f';
  return lines.map(line => (line ? `${rtlMark}${line}` : '')).join('\n');
}

export function fmt(value, decimals = 2) {
  if (!value && value !== 0) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}
