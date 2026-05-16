import { execSync } from "node:child_process";

const MONTHS = Number(process.env.BACKTEST_MONTHS || 8);
const TRADE_USDT = Number(process.env.BACKTEST_TRADE_USDT || 50);

const results = [];

process.stdout.write(`\nجاري تشغيل ${MONTHS} أشهر...\n\n`);

for (let i = MONTHS - 1; i >= 0; i--) {
  const env = { ...process.env, BACKTEST_OFFSET_DAYS: String(i * 30), BACKTEST_TRADE_USDT: String(TRADE_USDT) };
  process.stdout.write(`  الشهر ${MONTHS - i}/${MONTHS} (offset=${i * 30})...\r`);
  const output = execSync("node deploy/backtest-last-30-days.mjs", { env }).toString();
  results.push(JSON.parse(output));
}

process.stdout.write(" ".repeat(40) + "\r");

const W = 82;
const line = "─".repeat(W);

console.log("\n" + "═".repeat(W));
console.log("  BACKTEST SUMMARY — آخر " + MONTHS + " أشهر | حجم الصفقة: $" + TRADE_USDT);
console.log("═".repeat(W));
console.log(
  "  " +
  "الفترة".padEnd(24) +
  "صفقات".padStart(7) +
  "ربح".padStart(6) +
  "خسارة".padStart(7) +
  "مفتوحة".padStart(8) +
  "نجاح%".padStart(8) +
  "الربح".padStart(10)
);
console.log("  " + line);

let totalProfit = 0;
let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;

for (const r of results) {
  const from = r.from.slice(0, 10);
  const until = r.until.slice(0, 10);
  const period = `${from} → ${until}`;
  const profitStr = (r.totalProfit >= 0 ? "+" : "") + "$" + r.totalProfit.toFixed(2);
  const winRateStr = r.closedTrades > 0 ? r.winRate + "%" : "—";
  totalProfit += r.totalProfit;
  totalTrades += r.totalTrades;
  totalWins += r.wins;
  totalLosses += r.losses;
  const flag = r.totalTrades === 0 ? " ⛔" : r.totalProfit >= 0 ? " ✅" : " ❌";
  console.log(
    "  " +
    period.padEnd(24) +
    String(r.totalTrades).padStart(7) +
    String(r.wins).padStart(6) +
    String(r.losses).padStart(7) +
    String(r.open).padStart(8) +
    winRateStr.padStart(8) +
    profitStr.padStart(10) +
    flag
  );
}

console.log("  " + line);
const overallWinRate = (totalWins + totalLosses) > 0
  ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(2) + "%"
  : "—";
const totalStr = (totalProfit >= 0 ? "+" : "") + "$" + totalProfit.toFixed(2);
console.log(
  "  " +
  "TOTAL".padEnd(24) +
  String(totalTrades).padStart(7) +
  String(totalWins).padStart(6) +
  String(totalLosses).padStart(7) +
  String(totalTrades - totalWins - totalLosses).padStart(8) +
  overallWinRate.padStart(8) +
  totalStr.padStart(10)
);
console.log("═".repeat(W) + "\n");

console.log("  العملات:", results[0]?.symbols?.join(", ") ?? "—");
console.log("  وضع الإشارة:", results[0]?.mode ?? "—");
console.log("  ملاحظة: بدون رسوم أو انزلاق سعري\n");
