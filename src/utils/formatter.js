/**
 * Builds the welcome message shown on /start.
 */
export function welcomeMessage() {
  return (
    `👋 *أهلاً بك في بوت مراجعة عناوين TRC20*\n\n` +
    `🔍 *ما الذي يفعله هذا البوت؟*\n` +
    `يقوم البوت بتحليل أي عنوان شبكة TRON (TRC20) ويعطيك تقييماً فورياً يشمل:\n\n` +
    `✅ *التحقق من صحة العنوان* — هل العنوان مكتوب بشكل صحيح؟\n` +
    `🛡️ *مستوى الخطورة* — تقييم حجم المخاطرة عند التعامل مع هذا العنوان\n` +
    `📋 *تفاصيل العنوان* — صيغة العنوان، الـ Checksum، وغيرها\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 *طريقة الاستخدام:*\n` +
    `فقط أرسل عنوان TRC20 مباشرةً في المحادثة\n` +
    `أو اضغط الزر بالأسفل 👇`
  );
}

/**
 * Formats the risk badge based on risk level.
 */
export function riskBadge(level) {
  const badges = {
    safe:    '🟢 *منخفض — آمن*',
    medium:  '🟡 *متوسط — توخَّ الحذر*',
    high:    '🔴 *مرتفع — خطر*',
    invalid: '⛔ *غير صالح*',
  };
  return badges[level] ?? '⚪ غير معروف';
}

/**
 * Builds the result message after validating an address.
 */
export function resultMessage(address, result) {
  if (!result.valid) {
    return (
      `⛔ *العنوان غير صالح*\n\n` +
      `\`${address}\`\n\n` +
      `❌ *السبب:* ${result.reason}`
    );
  }

  return (
    `📋 *نتيجة مراجعة العنوان*\n\n` +
    `\`${address}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ *الحالة:* العنوان صحيح\n` +
    `🛡️ *مستوى الخطورة:* ${riskBadge(result.risk)}\n` +
    `📊 *تفاصيل الخطورة:* ${result.riskDetails}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ _دائماً تحقق من العنوان يدوياً قبل إرسال أي مبلغ._`
  );
}
