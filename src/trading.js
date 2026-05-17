import { OkxClient } from "./okx.js";
import { readJson, writeJson, appendJsonLog } from "./storage.js";

function nowIso() {
  return new Date().toISOString();
}

function pctDiff(current, reference) {
  return Math.abs((current - reference) / reference) * 100;
}

function formatUsd(value, digits = 4) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function isExecutableRecommendation(recommendation) {
  return recommendation && recommendation.action !== "تجنب";
}

export async function saveTradeRecommendation(recommendation) {
  const recommendations = await readJson("trade-recommendations.json", {});
  recommendations[recommendation.id] = recommendation;
  await writeJson("trade-recommendations.json", recommendations);
}

export async function getTradeRecommendation(id) {
  const recommendations = await readJson("trade-recommendations.json", {});
  return recommendations[id] ?? null;
}

export async function setPendingTrade(chatId, pending) {
  const sessions = await readJson("trade-sessions.json", {});
  if (pending) sessions[String(chatId)] = pending;
  else delete sessions[String(chatId)];
  await writeJson("trade-sessions.json", sessions);
}

export async function getPendingTrade(chatId) {
  const sessions = await readJson("trade-sessions.json", {});
  return sessions[String(chatId)] ?? null;
}

export function parseTradeAmount(text) {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function validateTradeAmount(amount, config) {
  if (amount < config.minTradeUsdt) return `المبلغ أقل من الحد الأدنى ${config.minTradeUsdt} USDT.`;
  if (amount > config.maxTradeUsdt) return `المبلغ أعلى من الحد الأقصى ${config.maxTradeUsdt} USDT.`;
  return null;
}

export async function checkTradeReadiness({ recommendation, amountUsdt, config }) {
  if (!isExecutableRecommendation(recommendation)) {
    return { ok: false, message: "هذه التوصية غير قابلة للتنفيذ الآن لأن حالة العملة هي تجنب." };
  }

  const ageMinutes = (Date.now() - new Date(recommendation.createdAt).getTime()) / 60000;
  if (ageMinutes > config.maxRecommendationAgeMinutes) {
    return { ok: false, message: `التوصية قديمة (${Math.round(ageMinutes)} دقيقة). اطلب /report للحصول على توصية جديدة.` };
  }

  const amountError = validateTradeAmount(amountUsdt, config);
  if (amountError) return { ok: false, message: amountError };

  const okx = new OkxClient();
  const ticker = await okx.getTicker(recommendation.symbol);
  const drift = pctDiff(ticker.last, recommendation.entry);

  return {
    ok: true,
    ticker,
    drift,
    needsConfirmation: drift > config.maxPriceDriftPercent,
    message: drift > config.maxPriceDriftPercent
      ? `السعر تغير من وقت التوصية.\nسعر التوصية: $${formatUsd(recommendation.entry)}\nالسعر الحالي: $${formatUsd(ticker.last)}\nالفرق: ${formatUsd(drift, 2)}%\nهل تريد الاستمرار؟`
      : null
  };
}

export async function executeTrade({ recommendation, amountUsdt, ticker }) {
  const okx = new OkxClient();
  const trailAtr = process.env.TRAIL_ATR ? Number(process.env.TRAIL_ATR) : null;
  const trailAfter = process.env.TRAIL_AFTER || "tp1";
  const activationPrice = trailAfter === "tp2" && recommendation.target2 ? recommendation.target2 : recommendation.target1;

  let result;
  if (trailAtr && recommendation.atr) {
    const callbackRatio = (recommendation.atr * trailAtr) / recommendation.entry;
    result = await okx.placeSpotMarketBuyWithTrailingTP({
      symbol: recommendation.symbol,
      quoteAmount: amountUsdt,
      stopLoss: recommendation.stop,
      activationPrice,
      callbackRatio
    });
  } else {
    result = await okx.placeSpotMarketBuyWithTpSl({
      symbol: recommendation.symbol,
      quoteAmount: amountUsdt,
      takeProfit: recommendation.target1,
      stopLoss: recommendation.stop
    });
  }

  const trade = {
    id: `trade-${Date.now()}-${recommendation.symbol}`,
    recommendationId: recommendation.id,
    symbol: recommendation.symbol,
    amountUsdt,
    referencePrice: recommendation.entry,
    executionReferencePrice: ticker.last,
    stop: recommendation.stop,
    target1: recommendation.target1,
    target2: recommendation.target2,
    trailMode: result.mode === "trailing",
    okx: result,
    createdAt: nowIso()
  };
  await appendJsonLog("executed-trades.json", trade);
  return trade;
}

export function formatTradeOpened(trade) {
  const trailActivation = process.env.TRAIL_AFTER === "tp2" && trade.target2 ? trade.target2 : trade.target1;
  const exitMode = trade.trailMode
    ? `تفعيل trailing عند: $${formatUsd(trailActivation)} (${process.env.TRAIL_AFTER === "tp2" ? "TP2" : "TP1"})\nOKX trail algo: ${trade.okx.trailAlgoId ?? "غير متاح"}`
    : `الهدف الأول: $${formatUsd(trade.target1)}`;
  return [
    `تم إرسال أمر الصفقة إلى OKX.`,
    `العملة: ${trade.symbol}`,
    `المبلغ: ${formatUsd(trade.amountUsdt, 2)} USDT`,
    `سعر مرجعي وقت التنفيذ: $${formatUsd(trade.executionReferencePrice)}`,
    `وقف الخسارة: $${formatUsd(trade.stop)}`,
    exitMode,
    `OKX order id: ${trade.okx.orderId ?? "غير متاح"}`
  ].join("\n");
}
