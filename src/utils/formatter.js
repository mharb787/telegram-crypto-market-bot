export function welcomeMessage() {
  return (
    `👋 *أهلاً بك في بوت مراجعة عناوين TRC20*\n\n` +
    `🔍 *ما الذي يفعله هذا البوت؟*\n` +
    `يقوم البوت بتحليل أي عنوان TRON (TRC20) ويعطيك تقريراً شاملاً:\n\n` +
    `🚫 *القائمة السوداء لـ Tether* — هل حظرت Tether هذا العنوان؟\n` +
    `📅 *عمر المحفظة* — منذ متى وهي نشطة على الشبكة؟\n` +
    `🔗 *التعاملات المشبوهة* — هل تعاملت مع عناوين محظورة؟\n` +
    `💰 *الرصيد الحالي* — مجموع TRX و USDT في المحفظة\n` +
    `🛡️ *تقييم الخطورة الكلي* — درجة المخاطرة الإجمالية\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 *طريقة الاستخدام:*\n` +
    `أرسل عنوان TRC20 مباشرةً أو اضغط الزر بالأسفل 👇`
  );
}

/** Message sent while waiting for on-chain data */
export function loadingMessage(address) {
  return (
    `⏳ *جاري فحص العنوان…*\n\n` +
    `\`${address}\`\n\n` +
    `يتم الآن الاتصال بشبكة TRON والتحقق من:\n` +
    `• القائمة السوداء لـ Tether\n` +
    `• عمر المحفظة وأول عملية\n` +
    `• التعاملات مع عناوين محظورة\n` +
    `• الرصيد الحالي\n\n` +
    `_قد يستغرق ذلك بضع ثوانٍ…_`
  );
}

/** Full report after on-chain checks */
export function onChainReport(address, fmt, onchain) {
  const lines = [];

  // Header
  lines.push(`📋 *تقرير مراجعة العنوان*`);
  lines.push(`\`${address}\``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  // Format validity
  lines.push(`✅ *صيغة العنوان:* صحيحة`);

  // Tether blacklist
  if (onchain.blacklisted === true) {
    lines.push(`🚫 *قائمة Tether السوداء:* *محظور* ⛔`);
  } else if (onchain.blacklisted === false) {
    lines.push(`🚫 *قائمة Tether السوداء:* غير محظور ✅`);
  } else {
    lines.push(`🚫 *قائمة Tether السوداء:* تعذّر التحقق ⚠️`);
  }

  // Wallet age
  if (onchain.age) {
    const { date, days } = onchain.age;
    const label = days === 0 ? 'اليوم' : days < 7 ? `${days} أيام فقط` : days < 30 ? `${days} يوماً` : `${Math.floor(days / 30)} شهراً (${days} يوم)`;
    lines.push(`📅 *عمر المحفظة:* ${label} (منذ ${date})`);
  } else {
    lines.push(`📅 *عمر المحفظة:* لا يوجد نشاط مسجّل بعد`);
  }

  // Transactions reviewed
  lines.push(`🔄 *العمليات المراجعة:* آخر ${onchain.totalTransactions} عملية TRC20`);

  // Suspicious counterparties
  if (onchain.bannedCounterparties.length > 0) {
    lines.push(`⛔ *تعاملات مشبوهة:* ${onchain.bannedCounterparties.length} عنوان محظور في التاريخ`);
    for (const addr of onchain.bannedCounterparties.slice(0, 3)) {
      lines.push(`   • \`${addr}\``);
    }
    if (onchain.bannedCounterparties.length > 3) {
      lines.push(`   • _…و ${onchain.bannedCounterparties.length - 3} أخرى_`);
    }
  } else {
    lines.push(`🔗 *التعاملات المشبوهة:* لا توجد تعاملات مع عناوين محظورة ✅`);
  }

  // Balance
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`💰 *الرصيد الحالي:*`);
  lines.push(`   • TRX:  ${fmt(onchain.balance.trx, 2)} TRX`);
  lines.push(`   • USDT: ${fmt(onchain.balance.usdt, 2)} USDT`);

  // Risk verdict
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🛡️ *تقييم الخطورة الكلي:* ${riskVerdict(onchain.risk)}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`⚠️ _هذا التقرير للاسترشاد فقط. تحقق دائماً قبل إرسال أي مبلغ._`);

  return lines.join('\n');
}

/** Message when address format is invalid */
export function invalidAddressMessage(address, reason) {
  return (
    `⛔ *العنوان غير صالح*\n\n` +
    `\`${address}\`\n\n` +
    `❌ *السبب:* ${reason}`
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function riskVerdict(risk) {
  const map = {
    blacklisted: '🔴 *خطر جداً — محظور من Tether*',
    high:        '🔴 *مرتفع — تعاملات مع عناوين محظورة*',
    medium:      '🟡 *متوسط — محفظة حديثة جداً*',
    safe:        '🟢 *منخفض — لا توجد مؤشرات خطر*',
  };
  return map[risk] ?? '⚪ غير محدد';
}

export function fmt(value, decimals = 2) {
  if (!value && value !== 0) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}
