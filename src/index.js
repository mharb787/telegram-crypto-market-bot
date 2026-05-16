import { analyzeMarket, formatReport, rememberRecommendations, reviewOpenRecommendations, tuneStrategyFromHistory } from "./analyzer.js";
import { TelegramBot } from "./telegram.js";
import { loadStrategy, readJson, writeJson } from "./storage.js";
import {
  checkTradeReadiness,
  executeTrade,
  formatTradeOpened,
  getPendingTrade,
  getTradeRecommendation,
  parseTradeAmount,
  saveTradeRecommendation,
  setPendingTrade
} from "./trading.js";
import { OkxClient } from "./okx.js";
import fs from "node:fs";

function loadDotEnv() {
  if (!fs.existsSync(".env")) return;
  const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const config = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  analysisIntervalMinutes: envNumber("ANALYSIS_INTERVAL_MINUTES", 30),
  reportIntervalHours: envNumber("REPORT_INTERVAL_HOURS", 6),
  minConfidenceToAlert: envNumber("MIN_CONFIDENCE_TO_ALERT", 68),
  minTradeUsdt: envNumber("MIN_TRADE_USDT", 5),
  maxTradeUsdt: envNumber("MAX_TRADE_USDT", 500),
  maxPriceDriftPercent: envNumber("MAX_PRICE_DRIFT_PERCENT", 0.5),
  maxRecommendationAgeMinutes: envNumber("MAX_RECOMMENDATION_AGE_MINUTES", 20),
  dryRun: process.env.DRY_RUN === "true" || process.argv.includes("--once")
};

const bot = new TelegramBot({ token: config.token, chatId: config.chatId, dryRun: config.dryRun });
let lastReportAt = 0;

function fmt(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return "غير متاح";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function recommendationId(item) {
  return `${item.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function toTradeRecommendation(item) {
  return {
    id: recommendationId(item),
    symbol: item.symbol,
    name: item.asset.name,
    action: item.action,
    confidence: item.confidence,
    risk: item.risk,
    entry: item.current,
    stop: item.stop,
    target1: item.target1,
    target2: item.target2,
    support: item.support,
    resistance: item.resistance,
    reasons: item.reasons,
    sessionLabel: item.session?.activeLabel,
    createdAt: new Date().toISOString()
  };
}

function formatRecommendationMessage(recommendation) {
  return [
    `<b>${recommendation.name} (${recommendation.symbol})</b>`,
    `التوصية: ${recommendation.action}`,
    `الثقة: ${recommendation.confidence}/100 | المخاطرة: ${recommendation.risk}`,
    `سعر التوصية: $${fmt(recommendation.entry)}`,
    `وقف الخسارة: $${fmt(recommendation.stop)}`,
    `الأهداف: $${fmt(recommendation.target1)} ثم $${fmt(recommendation.target2)}`,
    `دعم/مقاومة: $${fmt(recommendation.support)} / $${fmt(recommendation.resistance)}`,
    `سياق الأسواق: ${recommendation.sessionLabel ?? "غير متاح"}`,
    `سبب التوصية: ${recommendation.reasons.join(" ")}`,
    `ما يلغيها: تغير السعر بقوة، كسر الدعم، أو انعكاس BTC/السوق العالمي ضد الاتجاه.`,
    "",
    "عند الضغط على زر الصفقة سأسألك عن مبلغ الصفقة بالدولار قبل أي تنفيذ."
  ].join("\n");
}

async function sendRecommendationMessages(report) {
  const valid = report.results.filter((item) => !item.error);
  for (const item of valid) {
    const recommendation = toTradeRecommendation(item);
    await saveTradeRecommendation(recommendation);
    await bot.sendMessage(formatRecommendationMessage(recommendation), {
      reply_markup: {
        inline_keyboard: [[
          {
            text: `ابدأ صفقة ${recommendation.symbol} حسب التوصية`,
            callback_data: `trade:${recommendation.id}`
          }
        ]]
      }
    });
  }
}

async function runCycle({ forceReport = false, send = true } = {}) {
  await reviewOpenRecommendations();
  await tuneStrategyFromHistory();
  const report = await analyzeMarket();
  await rememberRecommendations(report.results);

  const valid = report.results.filter((item) => !item.error);
  const strongest = valid.reduce((best, item) => (item.confidence > (best?.confidence ?? 0) ? item : best), null);
  const shouldSendReport = forceReport || Date.now() - lastReportAt >= config.reportIntervalHours * 60 * 60 * 1000;
  const shouldAlert = strongest && strongest.confidence >= config.minConfidenceToAlert;

  if (send && (shouldSendReport || shouldAlert)) {
    await sendRecommendationMessages(report);
    lastReportAt = Date.now();
  }

  return report;
}

async function rememberChat(message) {
  if (message.chat?.id && !bot.chatId) {
    bot.chatId = message.chat.id;
    await writeJson("runtime-config.json", { chatId: String(message.chat.id), learnedAt: new Date().toISOString() });
  }
}

async function handlePendingAmount(text, message) {
  const pending = await getPendingTrade(message.chat.id);
  if (!pending || pending.stage !== "awaiting_amount" || text.trim().startsWith("/")) return false;

  const amountUsdt = parseTradeAmount(text);
  if (!amountUsdt) {
    await bot.sendMessage("اكتب مبلغ الصفقة بالدولار فقط، مثال: 50");
    return true;
  }

  const recommendation = await getTradeRecommendation(pending.recommendationId);
  if (!recommendation) {
    await setPendingTrade(message.chat.id, null);
    await bot.sendMessage("لم أجد التوصية. اطلب /report للحصول على توصية جديدة.");
    return true;
  }

  try {
    const readiness = await checkTradeReadiness({ recommendation, amountUsdt, config });
    if (!readiness.ok) {
      await setPendingTrade(message.chat.id, null);
      await bot.sendMessage(readiness.message);
      return true;
    }

    if (readiness.needsConfirmation) {
      await setPendingTrade(message.chat.id, {
        stage: "confirm_price_drift",
        recommendationId: recommendation.id,
        amountUsdt,
        createdAt: new Date().toISOString()
      });
      await bot.sendMessage(readiness.message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "استمرار وفتح الصفقة", callback_data: `confirm:${recommendation.id}` }],
            [{ text: "إلغاء", callback_data: `cancel:${recommendation.id}` }]
          ]
        }
      });
      return true;
    }

    const trade = await executeTrade({ recommendation, amountUsdt, ticker: readiness.ticker });
    await setPendingTrade(message.chat.id, null);
    await bot.sendMessage(formatTradeOpened(trade));
  } catch (error) {
    await setPendingTrade(message.chat.id, null);
    await bot.sendMessage(`تعذر فتح الصفقة: ${error.message}`);
  }

  return true;
}

async function handleCommand(text, message) {
  await rememberChat(message);
  if (await handlePendingAmount(text, message)) return;

  const command = text.trim().split(/\s+/)[0].toLowerCase();
  if (command === "/start") {
    await bot.sendMessage([
      "بوت تحليل وتداول الكريبتو يعمل.",
      "الأوامر:",
      "/report توصيات منفصلة مع أزرار الصفقة",
      "/status حالة الاستراتيجية والتداول",
      "/history آخر التوصيات المسجلة"
    ].join("\n"));
    return;
  }

  if (command === "/report") {
    const report = await runCycle({ forceReport: true, send: false });
    await sendRecommendationMessages(report);
    return;
  }

  if (command === "/status") {
    const strategy = await loadStrategy();
    const okx = new OkxClient();
    await bot.sendMessage([
      "حالة الاستراتيجية والتداول:",
      `أقل ثقة للتنبيه: ${strategy.minConfidenceToAlert}`,
      `OKX API: ${okx.hasCredentials() ? "مربوط" : "غير مربوط"}`,
      `حد مبلغ الصفقة: ${config.minTradeUsdt} - ${config.maxTradeUsdt} USDT`,
      `أقصى تغير سعر قبل التأكيد: ${config.maxPriceDriftPercent}%`,
      `الأوزان: ${Object.entries(strategy.weights).map(([key, value]) => `${key}=${value}`).join(", ")}`,
      `آخر ضبط ذاتي: ${strategy.lastTunedAt ?? "لم يحدث بعد"}`
    ].join("\n"));
    return;
  }

  if (command === "/history") {
    const recommendations = await readJson("recommendations.json", []);
    const latest = recommendations.slice(-8).reverse();
    await bot.sendMessage(latest.length
      ? latest.map((item) => `${item.symbol} | ${item.status} | entry ${item.entry} | confidence ${item.confidence}`).join("\n")
      : "لا توجد توصيات مسجلة بعد.");
  }
}

async function handleCallback(callbackQuery) {
  const data = callbackQuery.data ?? "";
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return;
  if (!bot.chatId) {
    bot.chatId = chatId;
    await writeJson("runtime-config.json", { chatId: String(chatId), learnedAt: new Date().toISOString() });
  }

  await bot.answerCallbackQuery(callbackQuery.id);
  const [action, id] = data.split(":");

  if (action === "trade") {
    const recommendation = await getTradeRecommendation(id);
    if (!recommendation) {
      await bot.sendMessage("لم أجد التوصية. اطلب /report للحصول على توصية جديدة.");
      return;
    }
    await setPendingTrade(chatId, {
      stage: "awaiting_amount",
      recommendationId: id,
      createdAt: new Date().toISOString()
    });
    await bot.sendMessage(`كم مبلغ صفقة ${recommendation.symbol} بالدولار؟\nمثال: 50`);
    return;
  }

  if (action === "cancel") {
    await setPendingTrade(chatId, null);
    await bot.sendMessage("تم إلغاء فتح الصفقة.");
    return;
  }

  if (action === "confirm") {
    const pending = await getPendingTrade(chatId);
    if (!pending || pending.stage !== "confirm_price_drift" || pending.recommendationId !== id) {
      await bot.sendMessage("لا توجد صفقة تنتظر التأكيد.");
      return;
    }
    const recommendation = await getTradeRecommendation(id);
    if (!recommendation) {
      await setPendingTrade(chatId, null);
      await bot.sendMessage("لم أجد التوصية. اطلب /report للحصول على توصية جديدة.");
      return;
    }

    try {
      const okx = new OkxClient();
      const ticker = await okx.getTicker(recommendation.symbol);
      const trade = await executeTrade({ recommendation, amountUsdt: pending.amountUsdt, ticker });
      await setPendingTrade(chatId, null);
      await bot.sendMessage(formatTradeOpened(trade));
    } catch (error) {
      await setPendingTrade(chatId, null);
      await bot.sendMessage(`تعذر فتح الصفقة: ${error.message}`);
    }
  }
}

async function startPollingLoop() {
  while (true) {
    try {
      await bot.poll({ onMessage: handleCommand, onCallback: handleCallback });
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  if (!config.token && !config.dryRun) {
    throw new Error("TELEGRAM_BOT_TOKEN is required unless DRY_RUN=true or --once is used.");
  }

  const runtimeConfig = await readJson("runtime-config.json", {});
  if (!bot.chatId && runtimeConfig.chatId) {
    bot.chatId = runtimeConfig.chatId;
  }

  if (process.argv.includes("--once")) {
    const report = await runCycle({ forceReport: true, send: false });
    console.log(formatReport(report));
    return;
  }

  await bot.sendMessage("تم تشغيل بوت تحليل وتداول الكريبتو.");
  await runCycle({ forceReport: true });

  setInterval(() => {
    runCycle().catch((error) => console.error(error));
  }, config.analysisIntervalMinutes * 60 * 1000);

  startPollingLoop().catch((error) => console.error(error));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
