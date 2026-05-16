export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    current = values[i] * multiplier + current * (1 - multiplier);
  }
  return current;
}

export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return null;
  const macdLine = [];
  for (let i = slow; i <= values.length; i += 1) {
    const window = values.slice(0, i);
    macdLine.push(ema(window, fast) - ema(window, slow));
  }
  const signalLine = ema(macdLine, signal);
  const latestMacd = macdLine[macdLine.length - 1];
  return {
    macd: latestMacd,
    signal: signalLine,
    histogram: latestMacd - signalLine
  };
}

export function bollinger(values, period = 20, deviation = 2) {
  if (values.length < period) return null;
  const middle = sma(values, period);
  const slice = values.slice(-period);
  const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const standardDeviation = Math.sqrt(variance);
  return {
    upper: middle + standardDeviation * deviation,
    middle,
    lower: middle - standardDeviation * deviation,
    width: (standardDeviation * deviation * 2) / middle
  };
}

export function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const high = candles[i].high;
    const low = candles[i].low;
    const previousClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return sma(trueRanges, period);
}

export function supportResistance(candles, lookback = 60) {
  const window = candles.slice(-lookback);
  const supports = window.map((candle) => candle.low).sort((a, b) => a - b);
  const resistances = window.map((candle) => candle.high).sort((a, b) => b - a);
  return {
    support: supports[Math.floor(supports.length * 0.12)] ?? null,
    resistance: resistances[Math.floor(resistances.length * 0.12)] ?? null
  };
}

export function percentChange(current, previous) {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}
