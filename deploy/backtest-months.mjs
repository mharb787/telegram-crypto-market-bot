import { execSync } from "node:child_process";

const MONTHS = Number(process.env.BACKTEST_MONTHS || 8);
const TRADE_USDT = Number(process.env.BACKTEST_TRADE_USDT || 50);
const TARGET = Number(process.env.BACKTEST_TARGET || 1);
const TRAIL_ATR = process.env.BACKTEST_TRAIL_ATR || "";
const TRAIL_AFTER = process.env.BACKTEST_TRAIL_AFTER || "tp1";
const NO_REPEAT = process.env.BACKTEST_NO_REPEAT === "true";

const results = [];

const modeLabel = TRAIL_ATR ? `TRAIL×${TRAIL_ATR}@${TRAIL_AFTER.toUpperCase()}` : `TP${TARGET}`;
process.stdout.write(`\nجاري تشغيل ${MONTHS} أشهر... [${modeLabel}]\n\n`);

for (let i = MONTHS - 1; i >= 0; i--) {
  const env = {
    ...process.env,
    BACKTEST_OFFSET_DAYS: String(i * 30),
    BACKTEST_TRADE_USDT: String(TRADE_USDT),
    BACKTEST_TARGET: String(TARGET),
    BACKTEST_NO_REPEAT: NO_REPEAT ? "true" : "false",
    BACKTEST_TRAIL_AFTER: TRAIL_AFTER
  };
  process.stdout.write(`  الشهر ${MONTHS - i}/${MONTHS} (offset=${i * 30})...\r`);
  try {
    const output = execSync("node deploy/backtest-last-30-days.mjs", { env }).toString();
    results.push(JSON.parse(output));
  } catch (error) {
    console.error(`\nخطأ في الشهر offset=${i * 30}:`, error.message);
  }
}

process.stdout.write(" ".repeat(40) + "\r");

const W = 86;
console.log("\n" + "═".repeat(W));
console.log(`  BACKTEST SUMMARY — آخر ${MONTHS} أشهر | $${TRADE_USDT}/صفقة | TP${TARGET}`);
console.log("═".repeat(W));
console.log(
  "  " +
  "الفترة".padEnd(24) +
  "صفقات".padStart(7) +
  " │" +
  "ربح".padStart(6) +
  "خسارة".padStart(7) +
  "مفتوحة".padStart(8) +
  "نجاح%".padStart(8) +
  "الربح".padStart(10)
);
console.log("  " + "─".repeat(W));

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
  const flag = r.totalTrades === 0 ? " ⛔" : r.totalProfit >= 0 ? " ✅" : " ❌";
  totalProfit += r.totalProfit;
  totalTrades += r.totalTrades;
  totalWins += r.wins;
  totalLosses += r.losses;
  console.log(
    "  " +
    period.padEnd(24) +
    String(r.totalTrades).padStart(7) +
    " │" +
    String(r.wins).padStart(6) +
    String(r.losses).padStart(7) +
    String(r.open).padStart(8) +
    winRateStr.padStart(8) +
    profitStr.padStart(10) +
    flag
  );
}

console.log("  " + "─".repeat(W));
const overallWinRate = (totalWins + totalLosses) > 0
  ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(2) + "%"
  : "—";
const totalStr = (totalProfit >= 0 ? "+" : "") + "$" + totalProfit.toFixed(2);
console.log(
  "  " +
  "TOTAL".padEnd(24) +
  String(totalTrades).padStart(7) +
  " │" +
  String(totalWins).padStart(6) +
  String(totalLosses).padStart(7) +
  String(totalTrades - totalWins - totalLosses).padStart(8) +
  overallWinRate.padStart(8) +
  totalStr.padStart(10)
);
console.log("═".repeat(W) + "\n");

const maxConcurrent = Math.max(...results.map((r) => r.maxConcurrentTrades ?? 0));
const symbols = results[0]?.symbols ?? [];
console.log("  وضع الإشارة:", results[0]?.mode ?? "—");
console.log("  الهدف: " + modeLabel);
console.log(`  أقصى صفقات مفتوحة في نفس الوقت: ${maxConcurrent} صفقة (${maxConcurrent * TRADE_USDT}$)`);
if (NO_REPEAT) console.log("  وضع: منع التكرار — صفقة واحدة لكل عملة حتى الإغلاق");
console.log("  ملاحظة: بدون رسوم أو انزلاق سعري\n");

// Per-symbol breakdown
const symbolStats = {};
for (const r of results) {
  for (const [sym, data] of Object.entries(r.bySymbol ?? {})) {
    if (!symbolStats[sym]) symbolStats[sym] = { trades: 0, wins: 0, losses: 0, open: 0, profit: 0 };
    symbolStats[sym].trades += data.trades;
    symbolStats[sym].wins += data.wins;
    symbolStats[sym].losses += data.losses;
    symbolStats[sym].open += (data.trades - data.wins - data.losses);
    symbolStats[sym].profit += data.profit;
  }
}

if (Object.keys(symbolStats).length > 0) {
  console.log("═".repeat(W));
  console.log("  أداء كل عملة — " + MONTHS + " أشهر");
  console.log("═".repeat(W));
  console.log(
    "  " +
    "العملة".padEnd(10) +
    "صفقات".padStart(8) +
    " │" +
    "ربح".padStart(7) +
    "خسارة".padStart(8) +
    "نجاح%".padStart(9) +
    "الربح الكلي".padStart(13)
  );
  console.log("  " + "─".repeat(W));
  const sorted = Object.entries(symbolStats).sort((a, b) => b[1].profit - a[1].profit);
  for (const [sym, s] of sorted) {
    const wr = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) + "%" : "—";
    const pr = (s.profit >= 0 ? "+" : "") + "$" + s.profit.toFixed(2);
    const flag = s.profit >= 0 ? " ✅" : " ❌";
    console.log(
      "  " +
      sym.padEnd(10) +
      String(s.trades).padStart(8) +
      " │" +
      String(s.wins).padStart(7) +
      String(s.losses).padStart(8) +
      wr.padStart(9) +
      pr.padStart(13) +
      flag
    );
  }
  console.log("═".repeat(W) + "\n");
}
