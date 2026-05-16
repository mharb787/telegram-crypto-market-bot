import { createRecommendationChart } from "../src/chart.js";

const buffer = await createRecommendationChart({
  symbol: "BTC",
  name: "Bitcoin",
  confidence: 85,
  entry: 78000,
  stop: 76000,
  target1: 81000,
  target2: 83000,
  support: 77000,
  resistance: 82000
});

console.log(`png bytes ${buffer.length}`);
