const SESSION_WINDOWS_UTC = [
  { name: "asia_open", label: "افتتاح آسيا", start: "00:00", end: "01:00" },
  { name: "asia_close", label: "إغلاق آسيا", start: "06:00", end: "07:00" },
  { name: "europe_open", label: "افتتاح أوروبا", start: "07:00", end: "08:30" },
  { name: "europe_close", label: "إغلاق أوروبا", start: "15:30", end: "16:30" },
  { name: "us_open", label: "افتتاح السوق الأمريكي", start: "13:30", end: "15:00" },
  { name: "us_close", label: "إغلاق السوق الأمريكي", start: "20:00", end: "21:00" }
];

function minutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function getMarketSessionContext(date = new Date()) {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const active = SESSION_WINDOWS_UTC.find((session) => utcMinutes >= minutes(session.start) && utcMinutes < minutes(session.end));
  const next = SESSION_WINDOWS_UTC.find((session) => utcMinutes < minutes(session.start)) ?? SESSION_WINDOWS_UTC[0];
  const nextStartsInMinutes = utcMinutes < minutes(next.start)
    ? minutes(next.start) - utcMinutes
    : 24 * 60 - utcMinutes + minutes(next.start);

  return {
    activeKey: active?.name ?? "normal",
    activeLabel: active?.label ?? "جلسة عادية بدون افتتاح أو إغلاق حساس",
    nextLabel: next.label,
    nextStartsInMinutes,
    isHighVolatilityWindow: Boolean(active),
    note: active
      ? `${active.label} نشط الآن، لذلك يتم تخفيض الثقة قليلًا لأن السيولة والتذبذب قد يتغيران بسرعة.`
      : `لا توجد نافذة افتتاح/إغلاق عالمية حساسة الآن. النافذة القادمة: ${next.label} خلال ${nextStartsInMinutes} دقيقة تقريبًا.`
  };
}
