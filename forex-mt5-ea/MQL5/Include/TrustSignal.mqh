//+------------------------------------------------------------------+
//|                                               TrustSignal.mqh    |
//|          6-Factor Trust Score System -- ForexTrust EA            |
//|  Weights: Trend 24% | Momentum 19% | Volume 15% |               |
//|           Context 18% | DXY 16% | Risk/Reward 8%                |
//+------------------------------------------------------------------+
#ifndef TRUST_SIGNAL_MQH
#define TRUST_SIGNAL_MQH

struct STrustBreakdown
{
   double trendScore;
   double momentumScore;
   double volumeScore;
   double contextScore;
   double dxyScore;
   double rrScore;
   double totalScore;
   double atr;
   double support;
   double resistance;
};

class CTrustSignal
{
private:
   string   m_symbol;
   ENUM_TIMEFRAMES m_tf;

   // Indicator handles
   int      m_hATR;
   int      m_hEMA20;
   int      m_hEMA50;
   int      m_hEMA200;
   int      m_hRSI;
   int      m_hMACD;
   int      m_hBands;

   // DXY handle (optional)
   int      m_hDXY_EMA20;
   int      m_hDXY_EMA50;
   string   m_dxySymbol;
   bool     m_dxyAvailable;
   bool     m_invertDXY;

   int      m_atrPeriod;
   int      m_volPeriod;

   double Price(int shift = 0)
   {
      return iClose(m_symbol, m_tf, shift);
   }

   double GetBuffer(int handle, int bufferIdx, int shift)
   {
      double buf[];
      ArraySetAsSeries(buf, true);
      if(CopyBuffer(handle, bufferIdx, shift, 1, buf) < 1) return 0;
      return buf[0];
   }

   // -------------------------------------------------------
   // 1. TREND SCORE (EMA20, EMA50, EMA200) -- weight 24%
   // -------------------------------------------------------
   double CalcTrend()
   {
      double price  = Price(0);
      double ema20  = GetBuffer(m_hEMA20,  0, 0);
      double ema50  = GetBuffer(m_hEMA50,  0, 0);
      double ema200 = GetBuffer(m_hEMA200, 0, 0);

      if(ema20 == 0 || ema50 == 0 || ema200 == 0) return 50;

      bool aboveAll = (price > ema20) && (ema20 > ema50) && (ema50 > ema200);
      bool above2   = (price > ema20) && (ema20 > ema50);
      bool above1   = (price > ema20);
      bool below1   = (price < ema20) && (price > ema50);
      bool bearAll  = (price < ema20) && (ema20 < ema50) && (ema50 < ema200);

      double ema20Prev = GetBuffer(m_hEMA20, 0, 3);
      double ema50Prev = GetBuffer(m_hEMA50, 0, 3);
      double slopeBonus = 0;
      if(ema20 > ema20Prev && ema50 > ema50Prev) slopeBonus = 10;
      else if(ema20 > ema20Prev) slopeBonus = 5;

      double score;
      if(aboveAll)    score = 90 + slopeBonus;
      else if(above2) score = 70 + slopeBonus;
      else if(above1) score = 50;
      else if(below1) score = 30;
      else if(bearAll) score = 5;
      else             score = 20;

      return MathMin(100, score);
   }

   // -------------------------------------------------------
   // 2. MOMENTUM SCORE (RSI, MACD, BB, Price Change) -- weight 19%
   // -------------------------------------------------------
   double CalcMomentum()
   {
      double score = 0;

      // RSI (0-40 pts)
      double rsi = GetBuffer(m_hRSI, 0, 0);
      if(rsi >= 55 && rsi < 70)       score += 40;
      else if(rsi >= 50 && rsi < 55)  score += 30;
      else if(rsi >= 45 && rsi < 50)  score += 15;
      else if(rsi >= 70 && rsi < 78)  score += 20;
      else if(rsi >= 30 && rsi < 45)  score += 10;

      // MACD (0-35 pts)
      double macdMain     = GetBuffer(m_hMACD, 0, 0);
      double macdSignal   = GetBuffer(m_hMACD, 1, 0);
      double macdHist     = GetBuffer(m_hMACD, 2, 0);
      double macdHistPrev = GetBuffer(m_hMACD, 2, 1);

      bool macdAboveSignal = (macdMain > macdSignal);
      bool macdPositive    = (macdMain > 0);
      bool histGrowing     = (macdHist > macdHistPrev);

      if(macdAboveSignal && macdPositive && histGrowing) score += 35;
      else if(macdAboveSignal && macdPositive)           score += 25;
      else if(macdAboveSignal)                           score += 15;
      else if(macdPositive)                              score += 10;

      // Bollinger Bands (0-25 pts)
      double bbUpper  = GetBuffer(m_hBands, 1, 0);
      double bbLower  = GetBuffer(m_hBands, 2, 0);
      double price    = Price(0);
      double bbRange  = bbUpper - bbLower;

      if(bbRange > 0)
      {
         double relPos = (price - bbLower) / bbRange;
         if(relPos >= 0.6 && relPos < 0.9)   score += 25;
         else if(relPos >= 0.5 && relPos < 0.6) score += 18;
         else if(relPos >= 0.4 && relPos < 0.5) score += 10;
         else if(relPos >= 0.9)               score += 15;
      }

      return MathMin(100, score);
   }

   // -------------------------------------------------------
   // 3. VOLUME SCORE -- weight 15%
   // -------------------------------------------------------
   double CalcVolume()
   {
      long volBuf[];
      ArraySetAsSeries(volBuf, true);
      if(CopyTickVolume(m_symbol, m_tf, 0, m_volPeriod + 1, volBuf) < m_volPeriod + 1)
         return 50;

      long currentVol = volBuf[0];
      double avgVol   = 0;
      for(int i = 1; i <= m_volPeriod; i++) avgVol += (double)volBuf[i];
      avgVol /= m_volPeriod;

      if(avgVol <= 0) return 50;
      double ratio = currentVol / avgVol;

      if(ratio >= 2.0)      return 100;
      else if(ratio >= 1.5) return 80;
      else if(ratio >= 1.2) return 65;
      else if(ratio >= 1.0) return 55;
      else if(ratio >= 0.7) return 40;
      else                  return 20;
   }

   // -------------------------------------------------------
   // 4. MARKET CONTEXT SCORE (Session, Volatility) -- weight 18%
   // -------------------------------------------------------
   double CalcMarketContext()
   {
      MqlDateTime dt;
      TimeToStruct(TimeCurrent(), dt);
      int hour = dt.hour;
      int dow  = dt.day_of_week;

      // Friday close avoidance (after 20:00 UTC)
      if(dow == 5 && hour >= 20) return 0;
      if(dow == 0) return 0;

      double sessionScore;
      if(hour >= 12 && hour < 16)      sessionScore = 100; // London/NY overlap
      else if(hour >= 7  && hour < 12) sessionScore = 80;  // London
      else if(hour >= 16 && hour < 21) sessionScore = 75;  // NY
      else if(hour >= 0  && hour < 7)  sessionScore = 35;  // Asian
      else                             sessionScore = 20;

      double atrCurrent = GetBuffer(m_hATR, 0, 0);
      double atrBuf[];
      ArraySetAsSeries(atrBuf, true);
      double atrAvg = 0;
      if(CopyBuffer(m_hATR, 0, 0, 20, atrBuf) == 20)
      {
         for(int i = 0; i < 20; i++) atrAvg += atrBuf[i];
         atrAvg /= 20;
      }

      double volBonus = 0;
      if(atrAvg > 0)
      {
         double atrRatio = atrCurrent / atrAvg;
         if(atrRatio >= 1.3)     volBonus = 10;
         else if(atrRatio >= 1.0) volBonus = 5;
         else if(atrRatio < 0.6)  volBonus = -15;
      }

      return MathMax(0, MathMin(100, sessionScore + volBonus));
   }

   // -------------------------------------------------------
   // 5. DXY SCORE (Dollar Index Filter) -- weight 16%
   // -------------------------------------------------------
   double CalcDXY()
   {
      if(!m_dxyAvailable) return 50;

      double dxyEMA20 = GetBuffer(m_hDXY_EMA20, 0, 0);
      double dxyEMA50 = GetBuffer(m_hDXY_EMA50, 0, 0);
      double dxyPrice = iClose(m_dxySymbol, m_tf, 0);

      if(dxyEMA20 == 0 || dxyEMA50 == 0) return 50;

      bool dxyBearish = (dxyPrice < dxyEMA20) && (dxyEMA20 < dxyEMA50);
      bool dxyNeutral = (MathAbs(dxyPrice - dxyEMA20) / dxyEMA20 < 0.003);
      bool dxyBullish = (dxyPrice > dxyEMA20) && (dxyEMA20 > dxyEMA50);

      double rawScore;
      if(dxyBearish)       rawScore = 85;
      else if(dxyNeutral)  rawScore = 50;
      else if(dxyBullish)  rawScore = 20;
      else                 rawScore = 40;

      // For XAUUSD/EUR/GBP: DXY bearish = GOOD (same direction as pair)
      // For USD/XXX: invert
      return m_invertDXY ? rawScore : 100 - rawScore;
   }

   // -------------------------------------------------------
   // 6. RISK/REWARD SCORE (Support vs Resistance) -- weight 8%
   // -------------------------------------------------------
   double CalcRiskReward(double &supportOut, double &resistanceOut)
   {
      double highs[], lows[];
      ArraySetAsSeries(highs, true);
      ArraySetAsSeries(lows,  true);

      int lookback = 50;
      if(CopyHigh(m_symbol, m_tf, 0, lookback, highs) < lookback) { supportOut = 0; resistanceOut = 0; return 50; }
      if(CopyLow (m_symbol, m_tf, 0, lookback, lows)  < lookback) { supportOut = 0; resistanceOut = 0; return 50; }

      double price = Price(0);
      double atr   = GetBuffer(m_hATR, 0, 0);
      if(atr == 0) { supportOut = 0; resistanceOut = 0; return 50; }

      double support    = 0, resistance = 0;
      double minDistS   = atr * 10, minDistR = atr * 10;

      for(int i = 2; i < lookback - 2; i++)
      {
         if(lows[i] < lows[i-1] && lows[i] < lows[i+1] &&
            lows[i] < lows[i-2] && lows[i] < lows[i+2])
         {
            double dist = price - lows[i];
            if(dist > 0 && dist < minDistS) { minDistS = dist; support = lows[i]; }
         }
         if(highs[i] > highs[i-1] && highs[i] > highs[i+1] &&
            highs[i] > highs[i-2] && highs[i] > highs[i+2])
         {
            double dist = highs[i] - price;
            if(dist > 0 && dist < minDistR) { minDistR = dist; resistance = highs[i]; }
         }
      }

      supportOut    = (support > 0)    ? support    : price - atr * 2;
      resistanceOut = (resistance > 0) ? resistance : price + atr * 3;

      double distToSupport    = price - supportOut;
      double distToResistance = resistanceOut - price;

      if(distToResistance <= 0) return 20;
      double rr = distToResistance / MathMax(distToSupport, atr * 0.5);

      if(rr >= 3.0)      return 100;
      else if(rr >= 2.0) return 80;
      else if(rr >= 1.5) return 65;
      else if(rr >= 1.0) return 45;
      else               return 20;
   }

public:
   CTrustSignal() :
      m_hATR(INVALID_HANDLE), m_hEMA20(INVALID_HANDLE),
      m_hEMA50(INVALID_HANDLE), m_hEMA200(INVALID_HANDLE),
      m_hRSI(INVALID_HANDLE), m_hMACD(INVALID_HANDLE),
      m_hBands(INVALID_HANDLE), m_hDXY_EMA20(INVALID_HANDLE),
      m_hDXY_EMA50(INVALID_HANDLE), m_dxyAvailable(false),
      m_atrPeriod(14), m_volPeriod(20), m_invertDXY(true) {}

   bool Init(string symbol, ENUM_TIMEFRAMES tf,
             int atrPeriod, int ema20, int ema50, int ema200,
             int rsiPeriod, int volPeriod,
             string dxySymbol, bool invertDXY)
   {
      m_symbol    = symbol;
      m_tf        = tf;
      m_atrPeriod = atrPeriod;
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
         Print("TrustSignal: Failed to create indicator handles for ", symbol);
         return false;
      }

      m_dxyAvailable = false;
      if(StringLen(dxySymbol) > 0 && SymbolSelect(dxySymbol, true))
      {
         m_hDXY_EMA20 = iMA(dxySymbol, tf, ema20, 0, MODE_EMA, PRICE_CLOSE);
         m_hDXY_EMA50 = iMA(dxySymbol, tf, ema50, 0, MODE_EMA, PRICE_CLOSE);
         if(m_hDXY_EMA20 != INVALID_HANDLE && m_hDXY_EMA50 != INVALID_HANDLE)
         {
            m_dxyAvailable = true;
            Print("TrustSignal: DXY filter enabled using ", dxySymbol);
         }
      }
      else if(StringLen(dxySymbol) > 0)
         Print("TrustSignal: DXY symbol '", dxySymbol, "' not available -- DXY filter disabled (neutral 50)");

      return true;
   }

   void Release()
   {
      if(m_hATR    != INVALID_HANDLE) IndicatorRelease(m_hATR);
      if(m_hEMA20  != INVALID_HANDLE) IndicatorRelease(m_hEMA20);
      if(m_hEMA50  != INVALID_HANDLE) IndicatorRelease(m_hEMA50);
      if(m_hEMA200 != INVALID_HANDLE) IndicatorRelease(m_hEMA200);
      if(m_hRSI    != INVALID_HANDLE) IndicatorRelease(m_hRSI);
      if(m_hMACD   != INVALID_HANDLE) IndicatorRelease(m_hMACD);
      if(m_hBands  != INVALID_HANDLE) IndicatorRelease(m_hBands);
      if(m_hDXY_EMA20 != INVALID_HANDLE) IndicatorRelease(m_hDXY_EMA20);
      if(m_hDXY_EMA50 != INVALID_HANDLE) IndicatorRelease(m_hDXY_EMA50);
   }

   double GetATR(int shift = 0) { return GetBuffer(m_hATR, 0, shift); }

   STrustBreakdown Calculate()
   {
      STrustBreakdown bd;

      bd.trendScore    = CalcTrend();
      bd.momentumScore = CalcMomentum();
      bd.volumeScore   = CalcVolume();
      bd.contextScore  = CalcMarketContext();
      bd.dxyScore      = CalcDXY();
      bd.rrScore       = CalcRiskReward(bd.support, bd.resistance);
      bd.atr           = GetATR(0);

      bd.totalScore = bd.trendScore    * 0.24 +
                      bd.momentumScore * 0.19 +
                      bd.volumeScore   * 0.15 +
                      bd.contextScore  * 0.18 +
                      bd.dxyScore      * 0.16 +
                      bd.rrScore       * 0.08;

      return bd;
   }

   string FormatBreakdown(const STrustBreakdown &bd)
   {
      return StringFormat(
         "Trust=%.1f | Trend=%.0f(24%%) Momentum=%.0f(19%%) "
         "Volume=%.0f(15%%) Context=%.0f(18%%) DXY=%.0f(16%%) RR=%.0f(8%%)",
         bd.totalScore,
         bd.trendScore, bd.momentumScore, bd.volumeScore,
         bd.contextScore, bd.dxyScore, bd.rrScore
      );
   }
};

#endif
