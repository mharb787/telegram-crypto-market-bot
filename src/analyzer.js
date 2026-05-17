import { atr, bollinger, ema, macd, percentChange, rsi, supportResistance } from "./indicators.js";
import { getMarketSessionContext } from "./marketSessions.js";
import { OkxClient } from "./okx.js";
import { appendJsonLog, loadStrategy, readJson, writeJson } from "./storage.js";

const DEFAULT_TARGET_SYMBOLS = ["XRP", "TRX", "TON"];
const ASSET_NAMES = {
  BTC: "Bitcoin",
  XRP: "XRP",
  TRX: "TRON",
  TON: "Toncoin"
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "غير متاح";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
}

export async function fetchTopCryptoAssets(limit = 5) {
  return (process.env.TARGET_SYMBOLS || DEFAULT_TARGET_SYMBOLS.join(","))
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, limit)
    .map((symbol) => ({
      id: symbol.toLowerCase(),
      name: ASSET_NAMES[symbol] ?? symbol,
      symbol
    }));
}

async function fetchOkxCandles(symbol, interval = "1h", limit = 220) {
  const bar = interval === "4h" ? "4H" : "1H";
  const okx = new OkxClient();
  return okx.getCandles(symbol, bar, limit);
}

async function buildAssetAnalysis(asset, strategy, bitcoinState) {
  const candles1h = await fetchOkxCandles(asset.symbol, "1h", 220);
  const candles4h = await fetchOkxCandles(asset.symbol, "4h", 220);
  const closes = candles4h.map((candle) => candle.close);
  const volumes = candles4h.map((candle) => candle.volume);
  const current = closes.at(-1);
  const previous24h = closes.at(-7) ?? closes[0];
  const currentAtr = atr(candles4h, 14) ?? current * 0.025;
  const levels = supportResistance(candles4h);
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
  const session = getMarketSessionContext();
  const sessionMultiplier = strategy.sessionMultipliers[session.activeKey] ?? 1;

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
  const marketContextRaw = session.isHighVolatilityWindow ? 0.25 : 0.55;
  const bitcoinFilterRaw = asset.symbol === "BTC" ? 0.7 : bitcoinState.score >= 65 ? 0.65 : bitcoinState.score >= 50 ? 0.25 : -0.25;
  const distanceToSupport = activeSupport ? ((current - activeSupport) / current) * 100 : (currentAtr / current) * 100;
  const distanceToResistance = activeResistance ? ((activeResistance - current) / current) * 100 : (currentAtr * 2 / current) * 100;
  const riskRaw = distanceToResistance > distanceToSupport * 0.8 ? 0.55 : 0.05;

  const factors = {
    trend: clamp(trendRaw, -1, 1),
    momentum: clamp(momentumRaw, -1, 1),
    volume: clamp(volumeRaw, -1, 1),
    marketContext: clamp(marketContextRaw, -1, 1),
    bitcoinFilter: clamp(bitcoinFilterRaw, -1, 1),
    riskControl: clamp(riskRaw, -1, 1)
  };

  const totalWeight = Object.values(strategy.weights).reduce((sum, value) => sum + value, 0);
  const weighted = Object.entries(factors).reduce((sum, [key, value]) => sum + ((value + 1) / 2) * strategy.weights[key], 0);
  const confidence = clamp(Math.round((weighted / totalWeight) * 100 * sessionMultiplier), 0, 100);
  const risk = confidence >= 78 && !session.isHighVolatilityWindow ? "medium" : confidence >= 65 ? "medium" : "high";
  const profile = strategy.riskProfiles[risk] ?? strategy.riskProfiles.medium;
  const atrStop = current - currentAtr * profile.stopAtr;
  const stop = activeSupport ? Math.min(activeSupport * 0.995, atrStop) : atrStop;
  const target1 = current + currentAtr * profile.targetAtr;
  const target2 = current + currentAtr * profile.targetAtr * 1.55;

  let action = "انتظار";
  if (confidence >= 82) action = "شراء صريح";
  else if (confidence >= 78) action = "شراء مشروط";
  else if (confidence >= 65) action = "مراقبة للشراء";
  else if (confidence <= 42) action = "تجنب";

  const reasons = [
    current > ema50
      ? `السعر أعلى من EMA50 ويميل لاتجاه إيجابي على فريم 4 ساعات.`
      : `السعر أسفل EMA50، لذلك الاتجاه لم يؤكد الصعود بعد.`,
    currentRsi > 50 && currentRsi < 70
      ? `RSI عند ${fmt(currentRsi, 1)} يعطي زخمًا صحيًا بدون تشبع شرائي واضح.`
      : `RSI عند ${fmt(currentRsi, 1)} يحتاج حذرًا لأنه ${currentRsi >= 70 ? "قريب من التشبع الشرائي" : "لا يؤكد الزخم الصاعد"}.`,
    currentMacd?.histogram > 0
      ? `MACD histogram إيجابي، وهذا يدعم استمرار الزخم.`
      : `MACD لا يعطي تأكيدًا إيجابيًا كافيًا الآن.`,
    volumeRatio > 1
      ? `حجم التداول أعلى من متوسط آخر 30 شمعة بحوالي ${fmt((volumeRatio - 1) * 100, 1)}%.`
      : `الحجم أقل من المتوسط، لذلك الإشارة تحتاج تأكيدًا إضافيًا.`,
    session.note,
    asset.symbol === "BTC"
      ? `BTC نفسه هو فلتر السوق الأساسي.`
      : `فلتر BTC الحالي يعطي درجة ${bitcoinState.score}/100، لذلك ${bitcoinState.score >= 65 ? "السوق يسمح بمخاطرة مدروسة على العملات الكبرى" : "المخاطرة على العملات البديلة أعلى من المعتاد"}.`
  ];

  return {
    asset,
    symbol: asset.symbol,
    action,
    confidence,
    risk,
    current,
    stop,
    target1,
    target2,
    support: activeSupport,
    resistance: activeResistance,
    indicators: { ema20, ema50, ema200, rsi: currentRsi, macd: currentMacd, bollinger: bands, atr: currentAtr, volumeRatio },
    factors,
    reasons,
    session,
    timestamp: new Date().toISOString(),
    price24hChangeFromCandles: percentChange(current, previous24h),
    candles1hCount: candles1h.length
  };
}

function getBitcoinStateFromAnalysis(analysis) {
  return analysis.symbol === "BTC"
    ? { score: analysis.confidence, trendPositive: analysis.current > analysis.indicators.ema50 }
    : { score: 50, trendPositive: false };
}

export async function analyzeMarket() {
  const strategy = await loadStrategy();
  const assets = await fetchTopCryptoAssets(5);
  const btcAsset = { symbol: "BTC", name: "Bitcoin" };
  const btcAnalysis = await buildAssetAnalysis(btcAsset, strategy, { score: 50 });
  const bitcoinState = getBitcoinStateFromAnalysis(btcAnalysis);
  const results = [];
  for (const asset of assets) {
    try {
      results.push(await buildAssetAnalysis(asset, strategy, bitcoinState));
    } catch (error) {
      results.push({ asset, symbol: asset.symbol, error: error.message, timestamp: new Date().toISOString() });
    }
  }
  await appendJsonLog("reports.json", { timestamp: new Date().toISOString(), results });
  return { strategy, results };
}

export function formatReport({ results }) {
  const valid = results.filter((item) => !item.error);
  const header = [
    "📊 تقرير تحليل أكبر 5 عملات كريبتو",
    `الوقت: ${new Date().toLocaleString("ar", { timeZone: "Asia/Hebron" })}`,
    `سياق الأسواق: ${valid[0]?.session?.activeLabel ?? "غير متاح"}`,
    ""
  ];
  const sections = valid.map((item) => [
    `<b>${item.asset.name} (${item.symbol})</b>`,
    `التوصية: ${item.action}`,
    `الثقة: ${item.confidence}/100 | المخاطرة: ${item.risk}`,
    `السعر: $${fmt(item.current, 4)}`,
    `الدخول: حول السعر الحالي مع تأكيد شمعة وحجم`,
    `وقف الخسارة: $${fmt(item.stop, 4)}`,
    `الأهداف: $${fmt(item.target1, 4)} ثم $${fmt(item.target2, 4)}`,
    `دعم/مقاومة: $${fmt(item.support, 4)} / $${fmt(item.resistance, 4)}`,
    `سبب التوصية: ${item.reasons.join(" ")}`,
    `ما يلغيها: كسر الدعم، انعكاس BTC، أو افتتاح سوق عالمي بعكس الاتجاه مع حجم مرتفع.`
  ].join("\n"));
  const errors = results.filter((item) => item.error).map((item) => `${item.symbol}: تعذر التحليل (${item.error})`);
  return [...header, ...sections, ...errors, "", "تنبيه: هذا تحليل آلي احتمالي وليس نصيحة مالية. استخدم إدارة رأس المال دائمًا."].join("\n\n");
}

export async function rememberRecommendations(results) {
  const recommendations = await readJson("recommendations.json", []);
  const now = new Date().toISOString();
  const open = recommendations.filter((item) => item.status === "open");
  const newItems = results
    .filter((item) => !item.error && item.confidence >= 65)
    .map((item) => ({
      id: `${item.symbol}-${Date.now()}`,
      symbol: item.symbol,
      openedAt: now,
      entry: item.current,
      stop: item.stop,
      target1: item.target1,
      target2: item.target2,
      confidence: item.confidence,
      factors: item.factors,
      status: "open"
    }));
  await writeJson("recommendations.json", [...open, ...newItems].slice(-200));
}

async function fetchCurrentOkxPrice(symbol) {
  const okx = new OkxClient();
  const ticker = await okx.getTicker(symbol);
  return ticker.last;
}

export async function reviewOpenRecommendations() {
  const strategy = await loadStrategy();
  const recommendations = await readJson("recommendations.json", []);
  const reviewAfterMs = (strategy.learning?.reviewAfterHours ?? 12) * 60 * 60 * 1000;
  const now = Date.now();
  const reviewed = [];

  for (const recommendation of recommendations) {
    if (recommendation.status !== "open") {
      reviewed.push(recommendation);
      continue;
    }

    try {
      const price = await fetchCurrentOkxPrice(recommendation.symbol);
      const ageMs = now - new Date(recommendation.openedAt).getTime();
      let status = "open";
      if (price <= recommendation.stop) status = "lost";
      else if (price >= recommendation.target1) status = "won";
      else if (ageMs >= reviewAfterMs) status = price > recommendation.entry ? "won" : "lost";

      reviewed.push({
        ...recommendation,
        lastPrice: price,
        reviewedAt: new Date().toISOString(),
        status
      });
    } catch {
      reviewed.push(recommendation);
    }
  }

  await writeJson("recommendations.json", reviewed.slice(-200));
  return reviewed;
}

export async function tuneStrategyFromHistory() {
  const strategy = await loadStrategy();
  if (!strategy.learning?.enabled) return strategy;
  const recommendations = await readJson("recommendations.json", []);
  const closed = recommendations.filter((item) => item.status === "won" || item.status === "lost");
  if (closed.length < strategy.learning.minSamplesBeforeTuning) return strategy;

  const weights = { ...strategy.weights };
  const factors = Object.keys(weights);
  for (const factor of factors) {
    const wins = closed.filter((item) => item.status === "won").reduce((sum, item) => sum + (item.factors?.[factor] ?? 0), 0);
    const losses = closed.filter((item) => item.status === "lost").reduce((sum, item) => sum + (item.factors?.[factor] ?? 0), 0);
    const signal = wins / Math.max(closed.filter((item) => item.status === "won").length, 1) - losses / Math.max(closed.filter((item) => item.status === "lost").length, 1);
    const step = clamp(Math.round(signal * strategy.learning.maxWeightStep), -strategy.learning.maxWeightStep, strategy.learning.maxWeightStep);
    weights[factor] = clamp(weights[factor] + step, strategy.learning.minWeight, strategy.learning.maxWeight);
  }

  const updated = { ...strategy, weights, lastTunedAt: new Date().toISOString() };
  await writeJson("strategy.json", updated);
  await appendJsonLog("strategy-changes.json", { timestamp: updated.lastTunedAt, weights });
  return updated;
}
