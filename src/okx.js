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

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: bodyText || undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== "0") {
      throw new Error(`OKX ${method} ${path} failed: ${payload.msg || response.statusText}`);
    }
    return payload.data;
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
}
