import crypto from "node:crypto";

function normalizeNumber(value, digits = 8) {
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

export class OkxClient {
  constructor({
    apiKey = process.env.OKX_API_KEY,
    apiSecret = process.env.OKX_API_SECRET,
    passphrase = process.env.OKX_API_PASSPHRASE,
    baseUrl = process.env.OKX_BASE_URL || "https://www.okx.com",
    simulated = process.env.OKX_SIMULATED_TRADING === "true"
  } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.simulated = simulated;
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiSecret && this.passphrase);
  }

  sign(timestamp, method, requestPath, body = "") {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(`${timestamp}${method.toUpperCase()}${requestPath}${body}`)
      .digest("base64");
  }

  async request(method, path, body = null, { auth = false } = {}) {
    const bodyText = body ? JSON.stringify(body) : "";
    const headers = { "content-type": "application/json" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    if (auth) {
      if (!this.hasCredentials()) {
        throw new Error("OKX API keys are not configured on the server.");
      }
      const timestamp = new Date().toISOString();
      headers["OK-ACCESS-KEY"] = this.apiKey;
      headers["OK-ACCESS-SIGN"] = this.sign(timestamp, method, path, bodyText);
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      headers["OK-ACCESS-PASSPHRASE"] = this.passphrase;
      if (this.simulated) headers["x-simulated-trading"] = "1";
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: bodyText || undefined,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.code !== "0") {
        throw new Error(`OKX ${method} ${path} failed: ${payload.msg || response.statusText}`);
      }
      return payload.data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`OKX ${method} ${path} timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getTicker(symbol) {
    const instId = `${symbol.toUpperCase()}-USDT`;
    const data = await this.request("GET", `/api/v5/market/ticker?instId=${instId}`);
    const ticker = data?.[0];
    if (!ticker) throw new Error(`No OKX ticker found for ${instId}`);
    return {
      instId,
      last: Number(ticker.last),
      ask: Number(ticker.askPx),
      bid: Number(ticker.bidPx),
      ts: Number(ticker.ts)
    };
  }

  async getCandles(symbol, bar = "4H", limit = 120) {
    const instId = `${symbol.toUpperCase()}-USDT`;
    const data = await this.request("GET", `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
    return data
      .map((row) => ({
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      }))
      .reverse();
  }

  async placeSpotMarketBuyWithTpSl({ symbol, quoteAmount, takeProfit, stopLoss }) {
    const instId = `${symbol.toUpperCase()}-USDT`;
    const clientId = `t${Date.now()}${symbol}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    const body = {
      instId,
      tdMode: "cash",
      clOrdId: clientId,
      side: "buy",
      ordType: "market",
      sz: normalizeNumber(quoteAmount, 2),
      tgtCcy: "quote_ccy",
      attachAlgoOrds: [
        {
          attachAlgoClOrdId: `${clientId}a`.slice(0, 32),
          tpTriggerPx: normalizeNumber(takeProfit),
          tpOrdPx: "-1",
          slTriggerPx: normalizeNumber(stopLoss),
          slOrdPx: "-1"
        }
      ]
    };

    const data = await this.request("POST", "/api/v5/trade/order", body, { auth: true });
    return {
      instId,
      clientId,
      orderId: data?.[0]?.ordId,
      statusCode: data?.[0]?.sCode,
      statusMessage: data?.[0]?.sMsg,
      raw: data?.[0]
    };
  }

  async getOrderDetails(ordId, instId) {
    const data = await this.request("GET", `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`, null, { auth: true });
    return data?.[0] ?? null;
  }

  async placeTrailingStopAlgo({ instId, sz, activePx, callbackRatio }) {
    const body = {
      instId,
      tdMode: "cash",
      side: "sell",
      ordType: "move_order_stop",
      sz: normalizeNumber(sz, 8),
      activePx: normalizeNumber(activePx),
      callbackRatio: normalizeNumber(Math.min(callbackRatio, 0.1), 6)
    };
    return this.request("POST", "/api/v5/trade/order-algo", body, { auth: true });
  }

  async placeSpotMarketBuyWithTrailingTP({ symbol, quoteAmount, stopLoss, activationPrice, callbackRatio }) {
    const instId = `${symbol.toUpperCase()}-USDT`;
    const clientId = `t${Date.now()}${symbol}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);

    // Market buy with SL only — TP handled by trailing stop algo
    const body = {
      instId,
      tdMode: "cash",
      clOrdId: clientId,
      side: "buy",
      ordType: "market",
      sz: normalizeNumber(quoteAmount, 2),
      tgtCcy: "quote_ccy",
      attachAlgoOrds: [
        {
          attachAlgoClOrdId: `${clientId}sl`.slice(0, 32),
          slTriggerPx: normalizeNumber(stopLoss),
          slOrdPx: "-1"
        }
      ]
    };

    const buyData = await this.request("POST", "/api/v5/trade/order", body, { auth: true });
    const orderId = buyData?.[0]?.ordId;

    // Poll for fill size — market orders fill within seconds
    let fillSz = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const order = await this.getOrderDetails(orderId, instId);
      if (order?.state === "filled" && Number(order.fillSz) > 0) {
        fillSz = Number(order.fillSz);
        break;
      }
    }

    let trailAlgoId = null;
    if (fillSz && fillSz > 0) {
      const trailData = await this.placeTrailingStopAlgo({ instId, sz: fillSz, activePx: activationPrice, callbackRatio });
      trailAlgoId = trailData?.[0]?.algoId;
    }

    return {
      instId,
      clientId,
      orderId,
      trailAlgoId,
      fillSz,
      mode: "trailing",
      statusCode: buyData?.[0]?.sCode,
      statusMessage: buyData?.[0]?.sMsg,
      raw: buyData?.[0]
    };
  }
}
