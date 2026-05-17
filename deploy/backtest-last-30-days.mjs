import { ema, rsi, macd, bollinger, atr, supportResistance, percentChange } from "../src/indicators.js";

const DEFAULT_TARGET_SYMBOLS = ["XRP", "TRX", "TON"];
const SYMBOLS = (process.env.TARGET_SYMBOLS || DEFAULT_TARGET_SYMBOLS.join(","))
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const TRADE_USDT = Number(process.env.BACKTEST_TRADE_USDT || 50);
const LOOKBACK_DAYS = Number(process.env.BACKTEST_DAYS || 30);
const OFFSET_DAYS = Number(process.env.BACKTEST_OFFSET_DAYS || 0);
const MODE = process.env.BACKTEST_MODE || "strong-buy";
const TRAIL_ATR = process.env.BACKTEST_TRAIL_ATR ? Number(process.env.BACKTEST_TRAIL_ATR) : null;
const TRAIL_AFTER = process.env.BACKTEST_TRAIL_AFTER || "tp1";
const NO_REPEAT = process.env.BACKTEST_NO_REPEAT === "true";
const BTC_MIN_SCORE = process.env.BACKTEST_BTC_FILTER ? Number(process.env.BACKTEST_BTC_FILTER) : 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function actionFromCandles(symbol, candles, bitcoinScore = 50) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
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
  const averageVolume = volumes.slice(-30, -1).reduce((sum, value) => sum + value, 0) / Math.max(volumes.slice(-30, -1).length, 1);
  const volumeRatio = volumes.at(-1) / averageVolume;

  if ([ema20, ema50, ema200, currentRsi, currentMacd, bands].some((value) => value === null || value === undefined)) {
    return null;
  }

  const trendRaw = [
    current > ema20 ? 0.35 : -0.2,
    current > ema50 ? 0.35 : -0.25,
    current > ema200 ? 0.3 : -0.35,
    ema20 > ema50 ? 0.2 : -0.15
  ].reduce((sum, value) => sum + value, 0);

  const momentumRaw = [
    currentRsi > 50 && currentRsi < 70 ? 0.35 : currentRsi >= 70 ? -0.1 : -0.2,
    currentMacd?.histogram > 0 ? 0.3 : -0.2,
    percentChange(current, previous24h) > 0 ? 0.25 : -0.15,
    bands && current > bands.middle ? 0.15 : -0.1
  ].reduce((sum, value) => sum + value, 0);

  const volumeRaw = volumeRatio > 1.15 ? 0.8 : volumeRatio > 0.85 ? 0.35 : -0.3;
  const marketContextRaw = 0.55;
  const bitcoinFilterRaw = symbol === "BTC" ? 0.7 : bitcoinScore >= 65 ? 0.65 : bitcoinScore >= 50 ? 0.25 : -0.25;
  const distanceToSupport = activeSupport ? ((current - activeSupport) / current) * 100 : (currentAtr / current) * 100;
  const distanceToResistance = activeResistance ? ((activeResistance - current) / current) * 100 : (currentAtr * 2 / current) * 100;
  const riskRaw = distanceToResistance > distanceToSupport * 0.8 ? 0.55 : 0.05;

  const weights = {
    trend: 24,
    momentum: 19,
    volume: 15,
    marketContext: 18,
    bitcoinFilter: 16,
    riskControl: 8
  };
  const factors = {
    trend: clamp(trendRaw, -1, 1),
    momentum: clamp(momentumRaw, -1, 1),
    volume: clamp(volumeRaw, -1, 1),
    marketContext: clamp(marketContextRaw, -1, 1),
    bitcoinFilter: clamp(bitcoinFilterRaw, -1, 1),
    riskControl: clamp(riskRaw, -1, 1)
  };
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const weighted = Object.entries(factors).reduce((sum, [key, value]) => sum + ((value + 1) / 2) * weights[key], 0);
  const confidence = clamp(Math.round((weighted / totalWeight) * 100), 0, 100);
  const risk = confidence >= 78 ? "medium" : confidence >= 65 ? "medium" : "high";
  const stopAtr = risk === "high" ? 2.3 : 1.8;
  const targetAtr = risk === "high" ? 3.6 : 2.8;
  const atrStop = current - currentAtr * stopAtr;
  const stop = activeSupport ? Math.min(activeSupport * 0.995, atrStop) : atrStop;
  const target1 = current + currentAtr * targetAtr;
  const target2 = current + currentAtr * targetAtr * 1.55;
  const target3 = current + currentAtr * targetAtr * 2.2;
  let action = "انتظار";
  if (confidence >= 82) action = "شراء صريح";
  else if (confidence >= 78) action = "شراء مشروط";
  else if (confidence >= 65) action = "مراقبة للشراء";
  else if (confidence <= 42) action = "تجنب";
  return { symbol, action, confidence, entry: current, stop, target1, target2, target3, atr: currentAtr, timestamp: candles.at(-1).timestamp };
}

function shouldEnter(signal) {
  if (!signal) return false;
  if (MODE === "strong-buy") return signal.action === "شراء صريح";
  if (MODE === "all-non-avoid") return signal.action !== "تجنب";
  return ["شراء صريح", "شراء مشروط", "مراقبة للشراء"].includes(signal.action);
}

function settle(signal, futureCandles) {
  for (const candle of futureCandles) {
    const hitStop = candle.low <= signal.stop;
    const hitTarget = candle.high >= signal.target1;
    if (hitStop && hitTarget) return { status: "loss", exit: signal.stop, timestamp: candle.timestamp, ambiguous: true };
    if (hitTarget) return { status: "win", exit: signal.target1, timestamp: candle.timestamp };
    if (hitStop) return { status: "loss", exit: signal.stop, timestamp: candle.timestamp };
  }
  const last = futureCandles.at(-1);
  const exit = last?.close ?? signal.entry;
  return { status: exit > signal.entry ? "open_profit" : "open_loss", exit, timestamp: last?.timestamp };
}

function settleTrailing(signal, futureCandles, trailAtr, trailAfter = "tp1") {
  const activationPrice = trailAfter === "tp3" ? signal.target3 : trailAfter === "tp2" ? signal.target2 : signal.target1;
  let activated = false;
  let peak = signal.entry;
  let trailingStop = signal.stop;

  for (const candle of futureCandles) {
    if (!activated) {
      if (candle.low <= signal.stop) {
        return { status: "loss", exit: signal.stop, timestamp: candle.timestamp };
      }
      if (trailAfter === "tp2" && candle.high >= signal.target1 && candle.high < signal.target2) {
        // بين TP1 و TP2 — الصفقة رابحة جزئياً لكن لم يتفعل trailing بعد
      }
      if (candle.high >= activationPrice) {
        activated = true;
        peak = activationPrice;
        trailingStop = activationPrice;
      }
    }

    if (activated) {
      if (candle.high > peak) {
        peak = candle.high;
        const newTrail = peak - signal.atr * trailAtr;
        if (newTrail > trailingStop) trailingStop = newTrail;
      }
      if (candle.low <= trailingStop) {
        return { status: "win", exit: trailingStop, timestamp: candle.timestamp };
      }
    }
  }

  const last = futureCandles.at(-1);
  const exit = last?.close ?? signal.entry;
  if (activated) return { status: "win", exit, timestamp: last?.timestamp };
  return { status: exit > signal.entry ? "open_profit" : "open_loss", exit, timestamp: last?.timestamp };
}

function profitUsdt(entry, exit) {
  return TRADE_USDT * ((exit - entry) / entry);
}

const until = Date.now() - OFFSET_DAYS * 24 * 60 * 60 * 1000;
const since = until - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const warmupSince = since - 220 * 4 * 60 * 60 * 1000;
const all = {};

async function getBinanceCandles(symbol, startTime, endTime) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", `${symbol}USDT`);
  url.searchParams.set("interval", "4h");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("endTime", String(endTime));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance candles failed for ${symbol}: ${response.status}`);
  const rows = await response.json();
  return rows.map((row) => ({
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  }));
}

for (const symbol of SYMBOLS) {
  try {
    all[symbol] = await getBinanceCandles(symbol, warmupSince, until);
  } catch (error) {
    console.error(`Skipping ${symbol}: ${error.message}`);
    all[symbol] = [];
  }
}

const trades = [];
const startIndex = 210;
const btcCandles = await getBinanceCandles("BTC", warmupSince, until);
const lastExitBySymbol = {};
for (const symbol of SYMBOLS) {
  const candles = all[symbol];
  if (candles.length <= startIndex) continue;
  for (let i = startIndex; i < candles.length - 1; i += 1) {
    if (candles[i].timestamp < since || candles[i].timestamp > until) continue;
    if (NO_REPEAT && lastExitBySymbol[symbol] && candles[i].timestamp < lastExitBySymbol[symbol]) continue;
    const btcIndex = btcCandles.findIndex((candle) => candle.timestamp === candles[i].timestamp);
    const btcSignal = btcIndex >= startIndex ? actionFromCandles("BTC", btcCandles.slice(0, btcIndex + 1), 50) : null;
    if (BTC_MIN_SCORE > 0 && (btcSignal?.confidence ?? 0) < BTC_MIN_SCORE) continue;
    const signal = actionFromCandles(symbol, candles.slice(0, i + 1), btcSignal?.confidence ?? 50);
    if (!shouldEnter(signal)) continue;
    const outcome = TRAIL_ATR ? settleTrailing(signal, candles.slice(i + 1), TRAIL_ATR, TRAIL_AFTER) : settle(signal, candles.slice(i + 1));
    if (NO_REPEAT && outcome.timestamp) lastExitBySymbol[symbol] = outcome.timestamp;
    trades.push({
      ...signal,
      exitTimestamp: outcome.timestamp,
      status: outcome.status,
      exit: outcome.exit,
      profit: profitUsdt(signal.entry, outcome.exit),
      ambiguous: outcome.ambiguous ?? false
    });
  }
}

let maxConcurrent = 0;
for (const trade of trades) {
  const concurrent = trades.filter(
    (other) => other.timestamp <= trade.timestamp && (other.exitTimestamp ?? Infinity) >= trade.timestamp
  ).length;
  if (concurrent > maxConcurrent) maxConcurrent = concurrent;
}

const closed = trades.filter((trade) => trade.status === "win" || trade.status === "loss");
const wins = closed.filter((trade) => trade.status === "win");
const losses = closed.filter((trade) => trade.status === "loss");
const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
const closedWithDuration = closed.filter((t) => t.exitTimestamp && t.timestamp);
const avgDurationHours = closedWithDuration.length
  ? closedWithDuration.reduce((sum, t) => sum + (t.exitTimestamp - t.timestamp) / 3600000, 0) / closedWithDuration.length
  : 0;
const bySymbol = Object.fromEntries(SYMBOLS.map((symbol) => {
  const rows = trades.filter((trade) => trade.symbol === symbol);
  return [symbol, {
    trades: rows.length,
    wins: rows.filter((trade) => trade.status === "win").length,
    losses: rows.filter((trade) => trade.status === "loss").length,
    profit: Number(rows.reduce((sum, trade) => sum + trade.profit, 0).toFixed(2))
  }];
}));

console.log(JSON.stringify({
  mode: MODE,
  trailAtr: TRAIL_ATR,
  days: LOOKBACK_DAYS,
  offsetDays: OFFSET_DAYS,
  from: new Date(since).toISOString(),
  until: new Date(until).toISOString(),
  tradeUsdt: TRADE_USDT,
  symbols: SYMBOLS,
  totalTrades: trades.length,
  closedTrades: closed.length,
  wins: wins.length,
  losses: losses.length,
  open: trades.length - closed.length,
  winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
  totalProfit: Number(totalProfit.toFixed(2)),
  maxConcurrentTrades: maxConcurrent,
  avgTradeDurationHours: Number(avgDurationHours.toFixed(1)),
  bySymbol,
  assumptions: [
    "4H candles",
    "entry at signal candle close",
    "take profit at target1",
    "stop loss at strategy stop",
    "if TP and SL hit same candle, counted as loss",
    "fees/slippage not included",
    "symbols from TARGET_SYMBOLS",
    "historical candles from Binance 4H endpoint"
  ]
}, null, 2));
