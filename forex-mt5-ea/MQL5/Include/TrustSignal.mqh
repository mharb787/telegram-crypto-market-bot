//+------------------------------------------------------------------+
//|                                               TrustSignal.mqh    |
//|          6-Factor Trust Score — exact port of crypto strategy    |
//|                                                                  |
//|  Each factor maps to [-1, +1], normalized to [0,1], then        |
//|  weighted exactly as in the original JS bot:                    |
//|    Trend 24% | Momentum 19% | Volume 15%                        |
//|    Context 18% | DXY 16% | Risk/Reward 8%                       |
//|  Session multipliers applied after base score.                  |
//+------------------------------------------------------------------+
#ifndef TRUST_SIGNAL_MQH
#define TRUST_SIGNAL_MQH

struct STrustBreakdown
{
   double trendFactor;      // [-1, 1]
   double momentumFactor;
   double volumeFactor;
   double contextFactor;
   double dxyFactor;
   double rrFactor;
   double baseScore;        // before session multiplier [0, 100]
   double totalScore;       // after session multiplier  [0, 100]
   double sessionMult;
   double atr;
   double support;
   double resistance;
};

class CTrustSignal
{
private:
   string          m_symbol;
   ENUM_TIMEFRAMES m_tf;

   int    m_hATR;
   int    m_hEMA20;
   int    m_hEMA50;
   int    m_hEMA200;
   int    m_hRSI;
   int    m_hMACD;
   int    m_hBands;

   int    m_hDXY_EMA20;
   int    m_hDXY_EMA50;
   int    m_hDXY_RSI;
   string m_dxySymbol;
   bool   m_dxyAvailable;
   bool   m_invertDXY;
   int    m_volPeriod;

   double Buf(int handle, int bufIdx, int shift)
   {
      double b[];
      ArraySetAsSeries(b, true);
      if(CopyBuffer(handle, bufIdx, shift, 1, b) < 1) return 0;
      return b[0];
   }

   double Clamp(double v, double lo, double hi) { return MathMin(hi, MathMax(lo, v)); }
   double Norm(double factor) { return (Clamp(factor, -1, 1) + 1.0) / 2.0 * 100.0; }

   // 1. TREND (24%) — exact JS replica
   double TrendFactor()
   {
      double price  = iClose(m_symbol, m_tf, 0);
      double ema20  = Buf(m_hEMA20,  0, 0);
      double ema50  = Buf(m_hEMA50,  0, 0);
      double ema200 = Buf(m_hEMA200, 0, 0);
      if(ema20 == 0 || ema50 == 0 || ema200 == 0) return 0;

      double raw = (price > ema20  ? 0.35 : -0.20) +
                   (price > ema50  ? 0.35 : -0.25) +
                   (price > ema200 ? 0.30 : -0.35) +
                   (ema20  > ema50 ? 0.20 : -0.15);
      return Clamp(raw, -1, 1);
   }

   // 2. MOMENTUM (19%) — RSI + MACD histogram + 24h change + BB middle
   double MomentumFactor()
   {
      double rsiVal  = Buf(m_hRSI,   0, 0);
      double macdH   = Buf(m_hMACD,  2, 0);
      double bbMid   = Buf(m_hBands, 0, 0);
      double price   = iClose(m_symbol, m_tf, 0);
      double prev24h = iClose(m_symbol, m_tf, 6);

      double rsiPart  = (rsiVal > 50 && rsiVal < 70) ? 0.35 :
                        (rsiVal >= 70)                ? -0.10 : -0.20;
      double macdPart = (macdH > 0)                  ? 0.30  : -0.20;
      double chgPart  = (prev24h > 0 && price > prev24h) ? 0.25 : -0.15;
      double bbPart   = (bbMid  > 0 && price > bbMid)    ? 0.15 : -0.10;

      return Clamp(rsiPart + macdPart + chgPart + bbPart, -1, 1);
   }

   // 3. VOLUME (15%) — volumeRatio vs 30-bar average
   double VolumeFactor()
   {
      long volBuf[];
      ArraySetAsSeries(volBuf, true);
      int need = m_volPeriod + 1;
      if(CopyTickVolume(m_symbol, m_tf, 0, need, volBuf) < need) return 0.35;

      long   cur    = volBuf[0];
      double avgVol = 0;
      for(int i = 1; i <= m_volPeriod; i++) avgVol += (double)volBuf[i];
      avgVol /= m_volPeriod;

      if(avgVol <= 0) return 0.35;
      double ratio = cur / avgVol;
      return (ratio > 1.15) ? 0.80 : (ratio > 0.85) ? 0.35 : -0.30;
   }

   // 4. MARKET CONTEXT (18%)
   // isHighVolatilityWindow (open/close transitions) = RISKY = lower score 0.25
   // Normal hours = stable = higher score 0.55
   // Weekend / Friday 20:00+ UTC = hard block (-1)
   double ContextFactor()
   {
      MqlDateTime dt;
      TimeToStruct(TimeCurrent(), dt);
      int hour = dt.hour;
      int dow  = dt.day_of_week;

      if(dow == 0) return -1.0;
      if(dow == 5 && hour >= 20) return -1.0;

      bool highVolWindow =
         (hour == 0) ||
         (hour == 6) ||
         (hour == 7 || (hour == 8 && dt.min < 30)) ||
         ((hour == 15 && dt.min >= 30) || (hour == 16 && dt.min < 30)) ||
         ((hour == 13 && dt.min >= 30) || hour == 14) ||
         (hour == 20);

      return highVolWindow ? 0.25 : 0.55;
   }

   // Session multipliers — exact values from default-strategy.json
   double SessionMultiplier()
   {
      MqlDateTime dt;
      TimeToStruct(TimeCurrent(), dt);
      int hour = dt.hour;
      int mn   = dt.min;

      if((hour == 13 && mn >= 30) || hour == 14)    return 0.90; // us_open
      if(hour == 20)                                 return 0.94; // us_close
      if(hour == 0)                                  return 0.94; // asia_open
      if(hour == 7 || (hour == 8 && mn < 30))       return 0.95; // europe_open
      if(hour == 6)                                  return 0.96; // asia_close
      if((hour == 15 && mn >= 30) || (hour == 16 && mn < 30)) return 0.96; // europe_close
      return 1.0;
   }

   // 5. DXY FILTER (16%) — mirrors BTC filter scale: 0.65 / 0.25 / -0.25
   double DXYFactor()
   {
      if(!m_dxyAvailable) return 0.25;

      double dxyEMA20 = Buf(m_hDXY_EMA20, 0, 0);
      double dxyEMA50 = Buf(m_hDXY_EMA50, 0, 0);
      double dxyRSI   = Buf(m_hDXY_RSI,   0, 0);
      double dxyPrice = iClose(m_dxySymbol, m_tf, 0);

      if(dxyEMA20 == 0 || dxyEMA50 == 0) return 0.25;

      // Build a mini DXY confidence (0-100)
      double dxyScore = 50;
      if(dxyPrice > dxyEMA50 && dxyEMA20 > dxyEMA50) dxyScore += 20;
      else if(dxyPrice < dxyEMA50)                    dxyScore -= 20;
      if(dxyRSI > 55 && dxyRSI < 70)                dxyScore += 10;
      else if(dxyRSI <= 45)                          dxyScore -= 10;
      dxyScore = Clamp(dxyScore, 0, 100);

      if(m_invertDXY) dxyScore = 100 - dxyScore; // bearish DXY = good for XAU/EUR/GBP

      if(dxyScore >= 65) return 0.65;
      if(dxyScore >= 50) return 0.25;
      return -0.25;
   }

   // 6. RISK/REWARD (8%)
   // Support = 12th percentile of lows (60 bars)
   // Resistance = 12th percentile of highs (60 bars, from top)
   // distToResistance > distToSupport * 0.8 ? 0.55 : 0.05
   double RRFactor(double &supportOut, double &resistanceOut)
   {
      double highs[], lows[];
      ArraySetAsSeries(highs, true);
      ArraySetAsSeries(lows,  true);

      int lookback = 60;
      if(CopyHigh(m_symbol, m_tf, 0, lookback, highs) < lookback ||
         CopyLow (m_symbol, m_tf, 0, lookback, lows)  < lookback)
      { supportOut = 0; resistanceOut = 0; return 0.25; }

      double sortedLows[], sortedHighs[];
      ArrayCopy(sortedLows,  lows,  0, 0, lookback);
      ArrayCopy(sortedHighs, highs, 0, 0, lookback);
      ArraySort(sortedLows);   // ascending
      ArraySort(sortedHighs);  // ascending

      int pctIdx        = (int)MathFloor(lookback * 0.12);
      supportOut        = sortedLows[pctIdx];
      resistanceOut     = sortedHighs[lookback - 1 - pctIdx];

      double current          = iClose(m_symbol, m_tf, 0);
      double distToSupport    = (current - supportOut)    / current * 100;
      double distToResistance = (resistanceOut - current) / current * 100;

      return (distToResistance > distToSupport * 0.8) ? 0.55 : 0.05;
   }

public:
   CTrustSignal() :
      m_hATR(INVALID_HANDLE), m_hEMA20(INVALID_HANDLE),
      m_hEMA50(INVALID_HANDLE), m_hEMA200(INVALID_HANDLE),
      m_hRSI(INVALID_HANDLE), m_hMACD(INVALID_HANDLE),
      m_hBands(INVALID_HANDLE), m_hDXY_EMA20(INVALID_HANDLE),
      m_hDXY_EMA50(INVALID_HANDLE), m_hDXY_RSI(INVALID_HANDLE),
      m_dxyAvailable(false), m_invertDXY(true), m_volPeriod(30) {}

   bool Init(string symbol, ENUM_TIMEFRAMES tf,
             int atrPeriod, int ema20, int ema50, int ema200,
             int rsiPeriod, int volPeriod,
             string dxySymbol, bool invertDXY)
   {
      m_symbol    = symbol;
      m_tf        = tf;
      m_volPeriod = volPeriod;
      m_dxySymbol = dxySymbol;
      m_invertDXY = invertDXY;

      m_hATR    = iATR  (symbol, tf, atrPeriod);
      m_hEMA20  = iMA   (symbol, tf, ema20,  0, MODE_EMA, PRICE_CLOSE);
      m_hEMA50  = iMA   (symbol, tf, ema50,  0, MODE_EMA, PRICE_CLOSE);
      m_hEMA200 = iMA   (symbol, tf, ema200, 0, MODE_EMA, PRICE_CLOSE);
      m_hRSI    = iRSI  (symbol, tf, rsiPeriod, PRICE_CLOSE);
      m_hMACD   = iMACD (symbol, tf, 12, 26, 9, PRICE_CLOSE);
      m_hBands  = iBands(symbol, tf, 20, 0, 2.0, PRICE_CLOSE);

      if(m_hATR == INVALID_HANDLE || m_hEMA20 == INVALID_HANDLE ||
         m_hEMA50 == INVALID_HANDLE || m_hEMA200 == INVALID_HANDLE ||
         m_hRSI == INVALID_HANDLE || m_hMACD == INVALID_HANDLE ||
         m_hBands == INVALID_HANDLE)
      {
         Print("TrustSignal: indicator init failed for ", symbol);
         return false;
      }

      m_dxyAvailable = false;
      if(StringLen(dxySymbol) > 0 && SymbolSelect(dxySymbol, true))
      {
         m_hDXY_EMA20 = iMA (dxySymbol, tf, ema20,     0, MODE_EMA, PRICE_CLOSE);
         m_hDXY_EMA50 = iMA (dxySymbol, tf, ema50,     0, MODE_EMA, PRICE_CLOSE);
         m_hDXY_RSI   = iRSI(dxySymbol, tf, rsiPeriod, PRICE_CLOSE);
         if(m_hDXY_EMA20 != INVALID_HANDLE && m_hDXY_EMA50 != INVALID_HANDLE)
         {
            m_dxyAvailable = true;
            Print("TrustSignal: DXY filter active — ", dxySymbol);
         }
      }
      else if(StringLen(dxySymbol) > 0)
         Print("TrustSignal: '", dxySymbol, "' not found — DXY filter neutral (0.25)");

      return true;
   }

   void Release()
   {
      int handles[] = {m_hATR, m_hEMA20, m_hEMA50, m_hEMA200,
                       m_hRSI, m_hMACD, m_hBands,
                       m_hDXY_EMA20, m_hDXY_EMA50, m_hDXY_RSI};
      for(int i = 0; i < ArraySize(handles); i++)
         if(handles[i] != INVALID_HANDLE) IndicatorRelease(handles[i]);
   }

   double GetATR(int shift = 0) { return Buf(m_hATR, 0, shift); }

   STrustBreakdown Calculate()
   {
      STrustBreakdown bd;
      bd.atr = GetATR(0);

      bd.trendFactor    = TrendFactor();
      bd.momentumFactor = MomentumFactor();
      bd.volumeFactor   = VolumeFactor();
      bd.contextFactor  = ContextFactor();
      bd.dxyFactor      = DXYFactor();
      bd.rrFactor       = RRFactor(bd.support, bd.resistance);

      // Exact weight formula from default-strategy.json:
      // confidence = sum((factor+1)/2 * weight) / totalWeight * 100 * sessionMult
      double weighted =
         Norm(bd.trendFactor)    / 100.0 * 24 +
         Norm(bd.momentumFactor) / 100.0 * 19 +
         Norm(bd.volumeFactor)   / 100.0 * 15 +
         Norm(bd.contextFactor)  / 100.0 * 18 +
         Norm(bd.dxyFactor)      / 100.0 * 16 +
         Norm(bd.rrFactor)       / 100.0 * 8;

      bd.baseScore   = Clamp(MathRound(weighted), 0, 100);
      bd.sessionMult = SessionMultiplier();
      bd.totalScore  = Clamp(MathRound(bd.baseScore * bd.sessionMult), 0, 100);
      return bd;
   }

   string FormatBreakdown(const STrustBreakdown &bd)
   {
      return StringFormat(
         "Trust=%.0f (base=%.0f x%.2f) | "
         "Trend=%.2f(24%%) Mom=%.2f(19%%) Vol=%.2f(15%%) "
         "Ctx=%.2f(18%%) DXY=%.2f(16%%) RR=%.2f(8%%)",
         bd.totalScore, bd.baseScore, bd.sessionMult,
         bd.trendFactor, bd.momentumFactor, bd.volumeFactor,
         bd.contextFactor, bd.dxyFactor, bd.rrFactor);
   }
};

#endif
