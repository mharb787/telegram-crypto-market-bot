#!/usr/bin/env bash
set -euo pipefail

cd /opt/telegram-crypto-market-bot

ensure_env() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_env OKX_API_KEY ""
ensure_env OKX_API_SECRET ""
ensure_env OKX_API_PASSPHRASE ""
ensure_env OKX_SIMULATED_TRADING "false"
ensure_env MIN_TRADE_USDT "5"
ensure_env MAX_TRADE_USDT "500"
ensure_env MAX_PRICE_DRIFT_PERCENT "0.5"
ensure_env MAX_RECOMMENDATION_AGE_MINUTES "20"

chmod 600 .env
