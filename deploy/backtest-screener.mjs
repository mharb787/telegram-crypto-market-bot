import { ema, rsi, macd, bollinger, atr, supportResistance, percentChange } from "../src/indicators.js";

const TRADE_USDT = Number(process.env.BACKTEST_TRADE_USDT || 50);
const LOOKBACK_DAYS = Number(process.env.SCREENER_DAYS || 180);
const TOP_N = Number(process.env.SCREENER_TOP || 15);
const MIN_TRADES = Number(process.env.SCREENER_MIN_TRADES || 3);

// Top ~50 coins by market cap — stablecoins and BTC excluded
const CANDIDATES = [
  "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "TRX", "LINK", "AVAX",
  "TON", "DOT", "BCH", "LTC", "UNI", "NEAR", "ICP", "APT", "FIL",
  "ARB", "OP", "ATOM", "INJ", "VET", "ALGO", "AAVE", "HBAR", "XLM",
  "ETC", "STX", "IMX", "LDO", "EGLD", "FTM", "CHZ", "XMR",
  "SAND", "MANA", "AXS", "GALA", "GMT", "SNX", "CRV", "COMP",
  "MKR", "SUI", "SEI", "RUNE", "WLD", "ONDO", "JUP"
];

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function actionFromCandles(symbol, candles, bitcoinScore = 50) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const current = closes.at(-1);
  const previous24h = closes.at(-7) ?? closes[0];
  const currentAtr = atr(candles, 14) ?? current * 0.025;
  const levels = supportResistance(candles);
  const activeSupport = levels.support && levels.support < current ? levels.support : null;
  const activeResistance = levels.resistance && levels.resistance > current ? levels.resistance : null;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const currentRsi = rsi(closes, 14);
  const currentMacd = macd(closes);
  const bands = bollinger(closes, 20);
  const averageVolume = volumes.slice(-30, -1).reduce((s, v) => s + v, 0) / Math.max(volumes.slice(-30, -1).length, 1);
  const volumeRatio = volumes.at(-1) / averageVolume;

  if ([ema20, ema50, ema200, currentRsi, currentMacd, bands].some((v) => v === null || v === undefined)) return null;

  const trendRaw = [
    current > ema20 ? 0.35 : -0.2,
    current > ema50 ? 0.35 : -0.25,
    current > ema200 ? 0.3 : -0.35,
    ema20 > ema50 ? 0.2 : -0.15
  ].reduce((s, v) => s + v, 0);

  const momentumRaw = [
    currentRsi > 50 && currentRsi < 70 ? 0.35 : currentRsi >= 70 ? -0.1 : -0.2,
    currentMacd?.histogram > 0 ? 0.3 : -0.2,
    percentChange(current, previous24h) > 0 ? 0.25 : -0.15,
    bands && current > bands.middle ? 0.15 : -0.1
  ].reduce((s, v) => s + v, 0);

  const volumeRaw = volumeRatio > 1.15 ? 0.8 : volumeRatio > 0.85 ? 0.35 : -0.3;
  const marketContextRaw = 0.55;
  const bitcoinFilterRaw = symbol === "BTC" ? 0.7 : bitcoinScore >= 65 ? 0.65 : bitcoinScore >= 50 ? 0.25 : -0.25;
  const distanceToSupport = activeSupport ? ((current - activeSupport) / current) * 100 : (currentAtr / current) * 100;
  const distanceToResistance = activeResistance ? ((activeResistance - current) / current) * 100 : (currentAtr * 2 / current) * 100;
  const riskRaw = distanceToResistance > distanceToSupport * 0.8 ? 0.55 : 0.05;

  const weights = { trend: 24, momentum: 19, volume: 15, marketContext: 18, bitcoinFilter: 16, riskControl: 8 };
  const factors = {
    trend: clamp(trendRaw, -1, 1),
    momentum: clamp(momentumRaw, -1, 1),
    volume: clamp(volumeRaw, -1, 1),
    marketContext: clamp(marketContextRaw, -1, 1),
    bitcoinFilter: clamp(bitcoinFilterRaw, -1, 1),
    riskControl: clamp(riskRaw, -1, 1)
  };
  const totalWeight = Object.values(weights).reduce((s, v) => s + v, 0);
  const weighted = Object.entries(factors).reduce((s, [k, v]) => s + ((v + 1) / 2) * weights[k], 0);
  const confidence = clamp(Math.round((weighted / totalWeight) * 100), 0, 100);
  const risk = confidence >= 78 ? "medium" : confidence >= 65 ? "medium" : "high";
  const stopAtr = risk === "high" ? 2.3 : 1.8;
  const targetAtr = risk === "high" ? 3.6 : 2.8;
  const atrStop = current - currentAtr * stopAtr;
  const stop = activeSupport ? Math.min(activeSupport * 0.995, atrStop) : atrStop;
  const target1 = current + currentAtr * targetAtr;

  let action = "انتظار";
  if (confidence >= 82) action = "شراء صريح";
  else if (confidence >= 78) action = "شراء مشروط";
  else if (confidence >= 65) action = "مراقبة للشراء";
  else if (confidence <= 42) action = "تجنب";
  return { symbol, action, confidence, entry: current, stop, target1, timestamp: candles.at(-1).timestamp };
}

function settle(signal, futureCandles) {
  for (const candle of futureCandles) {
    const hitStop = candle.low <= signal.stop;
    const hitTarget = candle.high >= signal.target1;
    if (hitStop && hitTarget) return { status: "loss", exit: signal.stop };
    if (hitTarget) return { status: "win", exit: signal.target1 };
    if (hitStop) return { status: "loss", exit: signal.stop };
  }
  const last = futureCandles.at(-1);
  const exit = last?.close ?? signal.entry;
  return { status: exit > signal.entry ? "open_profit" : "open_loss", exit };
}

function profitUsdt(entry, exit) {
  return TRADE_USDT * ((exit - entry) / entry);
}

async function getBinanceCandles(symbol, startTime, endTime) {
  const candles = [];
  let currentStart = startTime;
  while (currentStart < endTime) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", `${symbol}USDT`);
    url.searchParams.set("interval", "4h");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(currentStart));
    url.searchParams.set("endTime", String(endTime));
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Binance HTTP ${res.status}${body ? ": " + body.slice(0, 80) : ""}`);
    }
    const rows = await res.json();
    if (rows.length === 0) break;
    candles.push(...rows.map((r) => ({
      timestamp: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5])
    })));
    if (rows.length < 1000) break;
    currentStart = Number(rows.at(-1)[0]) + 1;
  }
  return candles;
}

async function screenSymbol(symbol, btcCandles, btcMap, startIndex, since, until) {
  const warmupSince = since - 220 * 4 * 60 * 60 * 1000;
  let candles;
  try {
    candles = await getBinanceCandles(symbol, warmupSince, until);
  } catch (e) {
    return { symbol, error: e.message };
  }
  if (candles.length <= startIndex) return { symbol, error: "candles insufficient" };

  const trades = [];
  for (let i = startIndex; i < candles.length - 1; i++) {
    const ts = candles[i].timestamp;
    if (ts < since || ts > until) continue;
    const btcIdx = btcMap.get(ts);
    const btcSignal = btcIdx !== undefined && btcIdx >= startIndex
      ? actionFromCandles("BTC", btcCandles.slice(0, btcIdx + 1), 50)
      : null;
    const signal = actionFromCandles(symbol, candles.slice(0, i + 1), btcSignal?.confidence ?? 50);
    if (!signal || signal.action !== "شراء صريح") continue;
    const outcome = settle(signal, candles.slice(i + 1));
    trades.push({ status: outcome.status, profit: profitUsdt(signal.entry, outcome.exit) });
  }

  const closed = trades.filter((t) => t.status === "win" || t.status === "loss");
  const wins = closed.filter((t) => t.status === "win");
  const losses = closed.filter((t) => t.status === "loss");
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

  return {
    symbol,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    open: trades.length - closed.length,
    winRate: Number(winRate.toFixed(1)),
    totalProfit: Number(totalProfit.toFixed(2))
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const until = Date.now();
const since = until - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const warmupSince = since - 220 * 4 * 60 * 60 * 1000;
const startIndex = 210;

process.stderr.write(`\nجاري تحميل بيانات BTC للفلتر...\n`);
let btcCandles;
try {
  btcCandles = await getBinanceCandles("BTC", warmupSince, until);
} catch (e) {
  process.stderr.write(`\nخطأ: تعذر الاتصال بـ Binance: ${e.message}\n`);
  process.stderr.write(`تأكد من اتصالك بالإنترنت ومن أن Binance متاح في منطقتك.\n\n`);
  process.exit(1);
}

// Build a map: timestamp → index in btcCandles for fast lookup
const btcMap = new Map();
for (let i = 0; i < btcCandles.length; i++) {
  btcMap.set(btcCandles[i].timestamp, i);
}

process.stderr.write(`فحص ${CANDIDATES.length} عملة على آخر ${LOOKBACK_DAYS} يوم...\n\n`);

// Batch 5 at a time to avoid rate limits
const BATCH = 5;
const results = [];
for (let i = 0; i < CANDIDATES.length; i += BATCH) {
  const batch = CANDIDATES.slice(i, i + BATCH);
  process.stderr.write(`  [${i + 1}–${Math.min(i + BATCH, CANDIDATES.length)}/${CANDIDATES.length}] ${batch.join(" ")}...\n`);
  const batchResults = await Promise.all(batch.map((sym) => screenSymbol(sym, btcCandles, btcMap, startIndex, since, until)));
  results.push(...batchResults);
}

// ── Results ───────────────────────────────────────────────────────────────────

const valid = results.filter((r) => !r.error && r.totalTrades >= MIN_TRADES);
const skipped = results.filter((r) => r.error || r.totalTrades < MIN_TRADES);

valid.sort((a, b) => b.totalProfit !== a.totalProfit ? b.totalProfit - a.totalProfit : b.winRate - a.winRate);

const W = 76;
process.stdout.write("\n");
console.log("═".repeat(W));
console.log(`  SCREENER — آخر ${LOOKBACK_DAYS} يوم | $${TRADE_USDT}/صفقة | strong-buy only`);
console.log("═".repeat(W));
console.log(
  "  " +
  "العملة".padEnd(8) +
  "صفقات".padStart(8) +
  "ربح".padStart(6) +
  "خسارة".padStart(7) +
  "نجاح%".padStart(8) +
  "الربح".padStart(11) +
  "  تقييم"
);
console.log("  " + "─".repeat(W - 2));

for (let rank = 0; rank < Math.min(TOP_N, valid.length); rank++) {
  const r = valid[rank];
  const wr = r.winRate + "%";
  const pr = (r.totalProfit >= 0 ? "+" : "") + "$" + Math.abs(r.totalProfit).toFixed(2);
  const sign = r.totalProfit < 0 ? "-" : "";
  let flag;
  if (r.winRate >= 75 && r.totalProfit > 0) flag = "⭐ ممتاز";
  else if (r.winRate >= 65 && r.totalProfit > 0) flag = "✅ جيد";
  else if (r.totalProfit > 0) flag = "👍 مقبول";
  else flag = "❌ خاسر";

  console.log(
    "  " +
    r.symbol.padEnd(8) +
    String(r.totalTrades).padStart(8) +
    String(r.wins).padStart(6) +
    String(r.losses).padStart(7) +
    wr.padStart(8) +
    (sign + "$" + Math.abs(r.totalProfit).toFixed(2)).padStart(11) +
    "  " + flag
  );
}

if (valid.length > TOP_N) {
  console.log(`  ... و ${valid.length - TOP_N} عملة أخرى`);
}

console.log("  " + "─".repeat(W - 2));

// Bottom performers
const bottom = valid.slice(-5).reverse();
if (bottom.length > 0) {
  console.log("  أسوأ 5:");
  for (const r of bottom) {
    const wr = r.winRate + "%";
    const pr = (r.totalProfit >= 0 ? "+" : "-") + "$" + Math.abs(r.totalProfit).toFixed(2);
    console.log(`    ${r.symbol.padEnd(8)} ${String(r.totalTrades).padStart(6)} صفقة | ${wr.padStart(6)} نجاح | ${pr.padStart(8)}`);
  }
  console.log("  " + "─".repeat(W - 2));
}

if (skipped.length > 0) {
  const skipNames = skipped.map((r) => r.error ? `${r.symbol}(!)` : `${r.symbol}(0)`).join("  ");
  console.log(`  تم تجاهل: ${skipNames}`);
}
console.log("═".repeat(W));

// Top 5 recommendation
const top5 = valid.filter((r) => r.totalProfit > 0 && r.winRate >= 60).slice(0, 5);
if (top5.length > 0) {
  console.log(`\n  ✅ التوصية — أفضل 5 عملات:`);
  console.log(`     ${top5.map((r) => r.symbol).join(", ")}`);
  console.log(`\n  مقارنة بنتائجك الحالية (TRX ✅  TON ❌  XRP ❌):`);
  for (const r of top5) {
    const note = ["TRX", "TON", "XRP"].includes(r.symbol) ? " ← موجودة" : " ← جديدة";
    console.log(`     ${r.symbol}: ${r.winRate}% نجاح، +$${r.totalProfit.toFixed(2)}${note}`);
  }
}
console.log("");
