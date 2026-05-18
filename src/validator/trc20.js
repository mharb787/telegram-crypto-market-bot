import { base58Decode, verifyChecksum } from './checksum.js';

const TRC20_LENGTH   = 34;
const TRON_PREFIX    = 0x41; // all mainnet addresses start with byte 0x41
const BASE58_CHARS   = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

/**
 * Returns { valid, reason, risk, riskDetails }
 */
export function validateTRC20(address) {
  if (!address || typeof address !== 'string') {
    return invalid('العنوان فارغ أو غير نصي');
  }

  const addr = address.trim();

  if (!addr.startsWith('T')) {
    return invalid('عنوان TRC20 يجب أن يبدأ بالحرف T');
  }

  if (addr.length !== TRC20_LENGTH) {
    return invalid(
      `طول العنوان غير صحيح (${addr.length} حرف بدلاً من ${TRC20_LENGTH})`
    );
  }

  if (!BASE58_CHARS.test(addr)) {
    return invalid('العنوان يحتوي على حروف غير مسموح بها في Base58');
  }

  const decoded = base58Decode(addr);
  if (!decoded) {
    return invalid('تعذّر فك ترميز العنوان (Base58 خاطئ)');
  }

  if (decoded.length !== 25) {
    return invalid(`حجم البيانات المفكوكة غير صحيح (${decoded.length} بايت بدلاً من 25)`);
  }

  if (decoded[0] !== TRON_PREFIX) {
    return invalid(`البادئة غير مدعومة (0x${decoded[0].toString(16)} بدلاً من 0x41)`);
  }

  if (!verifyChecksum(decoded)) {
    return invalid('Checksum خاطئ — قد يكون العنوان تالفاً أو مكتوباً بشكل خاطئ');
  }

  return assess(addr, decoded);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function invalid(reason) {
  return { valid: false, reason, risk: 'invalid', riskDetails: '' };
}

/**
 * Heuristic risk assessment based on address entropy and known null-patterns.
 */
function assess(addr, decoded) {
  // Payload is bytes [1..20] — the 20-byte account address
  const payload = decoded.subarray(1, 21);

  // Null address: all zeros
  if (payload.every(b => b === 0)) {
    return {
      valid: true,
      risk: 'high',
      riskDetails: 'عنوان فارغ (null address) — لا ترسل إليه أموالاً أبداً',
    };
  }

  // Low entropy: too many repeated bytes (burn / honeypot pattern)
  const counts = {};
  for (const b of payload) counts[b] = (counts[b] ?? 0) + 1;
  const maxRepeat = Math.max(...Object.values(counts));
  if (maxRepeat >= 14) {
    return {
      valid: true,
      risk: 'high',
      riskDetails: 'تكرار غير طبيعي في بايتات العنوان — قد يكون عنواناً اصطيادياً',
    };
  }

  if (maxRepeat >= 10) {
    return {
      valid: true,
      risk: 'medium',
      riskDetails: 'بعض التكرار في بايتات العنوان — تحقق من العنوان جيداً قبل الإرسال',
    };
  }

  return {
    valid: true,
    risk: 'safe',
    riskDetails: 'العنوان يبدو طبيعياً ولا توجد أنماط مشبوهة',
  };
}
