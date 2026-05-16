import { analyzeMarket, formatReport, rememberRecommendations, reviewOpenRecommendations, tuneStrategyFromHistory } from "./analyzer.js";
import { TelegramBot } from "./telegram.js";
import { loadStrategy, readJson, writeJson } from "./storage.js";
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
  dryRun: process.env.DRY_RUN === "true" || process.argv.includes("--once")
};

const bot = new TelegramBot({ token: config.token, chatId: config.chatId, dryRun: config.dryRun });
let lastReportAt = 0;

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
    await bot.sendMessage(formatReport(report));
    lastReportAt = Date.now();
  }

  return report;
}

async function handleCommand(text, message) {
  if (message.chat?.id && !config.chatId) {
    bot.chatId = message.chat.id;
    await writeJson("runtime-config.json", { chatId: String(message.chat.id), learnedAt: new Date().toISOString() });
  }

  const command = text.trim().split(/\s+/)[0].toLowerCase();
  if (command === "/start") {
    await bot.sendMessage([
      "بوت تحليل الكريبتو يعمل.",
      "الأوامر:",
      "/report تقرير فوري",
      "/status حالة الاستراتيجية",
      "/history آخر التوصيات المسجلة"
    ].join("\n"));
    return;
  }

  if (command === "/report") {
    const report = await runCycle({ forceReport: true, send: false });
    await bot.sendMessage(formatReport(report));
    return;
  }

  if (command === "/status") {
    const strategy = await loadStrategy();
    await bot.sendMessage([
      "حالة الاستراتيجية:",
      `أقل ثقة للتنبيه: ${strategy.minConfidenceToAlert}`,
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

  await bot.sendMessage("تم تشغيل بوت تحليل الكريبتو.");
  await runCycle({ forceReport: true });

  setInterval(() => {
    runCycle().catch((error) => console.error(error));
  }, config.analysisIntervalMinutes * 60 * 1000);

  setInterval(() => {
    bot.poll(handleCommand).catch((error) => console.error(error));
  }, 3000);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
