import { PNG } from "pngjs";
import { ema } from "./indicators.js";
import { OkxClient } from "./okx.js";

const COLORS = {
  bg: [12, 16, 24, 255],
  panel: [17, 24, 39, 255],
  grid: [46, 56, 77, 255],
  text: [229, 231, 235, 255],
  muted: [148, 163, 184, 255],
  green: [34, 197, 94, 255],
  red: [239, 68, 68, 255],
  blue: [96, 165, 250, 255],
  yellow: [250, 204, 21, 255],
  purple: [168, 85, 247, 255],
  orange: [251, 146, 60, 255],
  cyan: [34, 211, 238, 255],
  white: [255, 255, 255, 255]
};

function setPixel(png, x, y, color) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = color[3];
}

function fillRect(png, x, y, w, h, color) {
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(png.height, Math.ceil(y + h)); yy += 1) {
    for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(png.width, Math.ceil(x + w)); xx += 1) {
      setPixel(png, xx, yy, color);
    }
  }
}

function line(png, x0, y0, x1, y1, color) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = Math.round(x0);
  let y = Math.round(y0);

  while (true) {
    setPixel(png, x, y, color);
    if (x === Math.round(x1) && y === Math.round(y1)) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function hLine(png, x0, x1, y, color, dashed = false) {
  for (let x = x0; x <= x1; x += dashed ? 10 : 1) {
    if (dashed) line(png, x, y, Math.min(x + 6, x1), y, color);
    else setPixel(png, x, y, color);
  }
}

function drawSeries(png, values, xForIndex, yForPrice, color) {
  let last = null;
  values.forEach((value, index) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    const point = { x: xForIndex(index), y: yForPrice(value) };
    if (last) line(png, last.x, last.y, point.x, point.y, color);
    last = point;
  });
}

function emaSeries(values, period) {
  return values.map((_, index) => {
    const slice = values.slice(0, index + 1);
    return slice.length >= period ? ema(slice, period) : null;
  });
}

function fmt(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

// Tiny block font for digits/basic latin labels. Arabic explanation stays in Telegram caption.
const FONT = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ".": ["000", "000", "000", "000", "010"],
  ",": ["000", "000", "000", "010", "100"],
  ":": ["000", "010", "000", "010", "000"],
  "-": ["000", "000", "111", "000", "000"],
  "/": ["001", "001", "010", "100", "100"],
  " ": ["000", "000", "000", "000", "000"],
  "$": ["111", "110", "111", "011", "111"],
  "%": ["101", "001", "010", "100", "101"],
  "A": ["010", "101", "111", "101", "101"],
  "B": ["110", "101", "110", "101", "110"],
  "C": ["111", "100", "100", "100", "111"],
  "D": ["110", "101", "101", "101", "110"],
  "E": ["111", "100", "110", "100", "111"],
  "F": ["111", "100", "110", "100", "100"],
  "G": ["111", "100", "101", "101", "111"],
  "H": ["101", "101", "111", "101", "101"],
  "I": ["111", "010", "010", "010", "111"],
  "L": ["100", "100", "100", "100", "111"],
  "M": ["101", "111", "111", "101", "101"],
  "N": ["101", "111", "111", "111", "101"],
  "O": ["111", "101", "101", "101", "111"],
  "P": ["111", "101", "111", "100", "100"],
  "R": ["110", "101", "110", "101", "101"],
  "S": ["111", "100", "111", "001", "111"],
  "T": ["111", "010", "010", "010", "010"],
  "U": ["101", "101", "101", "101", "111"],
  "X": ["101", "101", "010", "101", "101"],
  "Y": ["101", "101", "010", "010", "010"]
};

function text(png, value, x, y, color, scale = 2) {
  const chars = String(value).toUpperCase().split("");
  let cursor = x;
  for (const char of chars) {
    const glyph = FONT[char] ?? FONT[" "];
    glyph.forEach((row, rowIndex) => {
      row.split("").forEach((bit, colIndex) => {
        if (bit === "1") fillRect(png, cursor + colIndex * scale, y + rowIndex * scale, scale, scale, color);
      });
    });
    cursor += 4 * scale;
  }
}

function labelLine(png, y, label, price, color, chart) {
  hLine(png, chart.left, chart.right, y, color, true);
  fillRect(png, chart.right + 8, y - 12, 150, 24, color);
  text(png, `${label} ${fmt(price)}`, chart.right + 14, y - 6, COLORS.bg, 2);
}

export async function createRecommendationChart(recommendation) {
  const okx = new OkxClient();
  const candles = await okx.getCandles(recommendation.symbol, "4H", 120);
  const width = 1100;
  const height = 700;
  const png = new PNG({ width, height });
  fillRect(png, 0, 0, width, height, COLORS.bg);

  const chart = { left: 70, top: 80, right: 920, bottom: 610 };
  fillRect(png, chart.left, chart.top, chart.right - chart.left, chart.bottom - chart.top, COLORS.panel);

  const prices = candles.flatMap((candle) => [candle.high, candle.low]).concat([
    recommendation.entry,
    recommendation.stop,
    recommendation.target1,
    recommendation.target2
  ]);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const padding = (max - min) * 0.12 || max * 0.02;
  const low = min - padding;
  const high = max + padding;
  const yForPrice = (price) => chart.bottom - ((price - low) / (high - low)) * (chart.bottom - chart.top);
  const xForIndex = (index) => chart.left + (index / (candles.length - 1)) * (chart.right - chart.left);

  for (let i = 0; i <= 5; i += 1) {
    const y = chart.top + i * ((chart.bottom - chart.top) / 5);
    hLine(png, chart.left, chart.right, y, COLORS.grid);
    const price = high - i * ((high - low) / 5);
    text(png, fmt(price), chart.right + 10, y - 5, COLORS.muted, 2);
  }

  text(png, `${recommendation.symbol}/USDT 4H`, chart.left, 28, COLORS.text, 3);
  text(png, `CONF ${recommendation.confidence}/100`, chart.left, 56, COLORS.muted, 2);

  const candleWidth = Math.max(3, Math.floor((chart.right - chart.left) / candles.length * 0.55));
  candles.forEach((candle, index) => {
    const x = xForIndex(index);
    const openY = yForPrice(candle.open);
    const closeY = yForPrice(candle.close);
    const highY = yForPrice(candle.high);
    const lowY = yForPrice(candle.low);
    const color = candle.close >= candle.open ? COLORS.green : COLORS.red;
    line(png, x, highY, x, lowY, color);
    fillRect(png, x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(2, Math.abs(closeY - openY)), color);
  });

  const closes = candles.map((candle) => candle.close);
  drawSeries(png, emaSeries(closes, 20), xForIndex, yForPrice, COLORS.yellow);
  drawSeries(png, emaSeries(closes, 50), xForIndex, yForPrice, COLORS.blue);
  drawSeries(png, emaSeries(closes, 200), xForIndex, yForPrice, COLORS.purple);

  labelLine(png, yForPrice(recommendation.entry), "ENTRY", recommendation.entry, COLORS.cyan, chart);
  labelLine(png, yForPrice(recommendation.stop), "SL", recommendation.stop, COLORS.red, chart);
  labelLine(png, yForPrice(recommendation.target1), "TP1", recommendation.target1, COLORS.green, chart);
  labelLine(png, yForPrice(recommendation.target2), "TP2", recommendation.target2, COLORS.green, chart);
  if (recommendation.support) labelLine(png, yForPrice(recommendation.support), "SUP", recommendation.support, COLORS.orange, chart);
  if (recommendation.resistance) labelLine(png, yForPrice(recommendation.resistance), "RES", recommendation.resistance, COLORS.orange, chart);

  text(png, "EMA20", chart.left + 10, height - 54, COLORS.yellow, 2);
  text(png, "EMA50", chart.left + 110, height - 54, COLORS.blue, 2);
  text(png, "EMA200", chart.left + 210, height - 54, COLORS.purple, 2);
  text(png, "AUTO CHART FROM OKX CANDLES", chart.left + 420, height - 54, COLORS.muted, 2);

  return PNG.sync.write(png);
}
