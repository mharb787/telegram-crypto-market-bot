//+------------------------------------------------------------------+
//|                                              TradeManager.mqh    |
//|   Position sizing, execution & trailing stop management          |
//|   Risk profiles match original default-strategy.json:           |
//|     medium: stopAtr=1.8, targetAtr=2.8, TP2=2.8*1.55=4.34      |
//+------------------------------------------------------------------+
#ifndef TRADE_MANAGER_MQH
#define TRADE_MANAGER_MQH

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

struct SRiskProfile
{
   double stopAtr;
   double targetAtr;
};

struct STradeState
{
   ulong  ticket;
   bool   trailingActive;
   double peakPrice;
   double openPrice;
   double tp2Level;
   double atrAtOpen;
   string direction;
};

class CTradeManager
{
private:
   CTrade        m_trade;
   CPositionInfo m_pos;

   string   m_symbol;
   int      m_magic;
   double   m_riskPct;
   double   m_trailATR;
   double   m_maxSpreadPips;
   STradeState m_state;

   SRiskProfile m_profiles[3]; // 0=low 1=medium 2=high

   double PipValue()
   {
      double point  = SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      int    digits = (int)SymbolInfoInteger(m_symbol, SYMBOL_DIGITS);
      return (digits == 3 || digits == 5) ? point * 10 : point;
   }

   double NormalizeLots(double lots)
   {
      double mn = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);
      double mx = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MAX);
      double st = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_STEP);
      lots = MathFloor(lots / st) * st;
      return MathMax(mn, MathMin(mx, lots));
   }

   bool SpreadOK()
   {
      double spread = SymbolInfoInteger(m_symbol, SYMBOL_SPREAD) *
                      SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      double pip    = PipValue();
      double pips   = (pip > 0) ? spread / pip : 0;
      if(pips > m_maxSpreadPips)
      { Print("Spread ", DoubleToString(pips,1), " > max ", m_maxSpreadPips); return false; }
      return true;
   }

   SRiskProfile ChooseProfile(int confidence, bool highVolSession)
   {
      if(confidence >= 78 && !highVolSession) return m_profiles[1];
      if(confidence >= 65)                    return m_profiles[1];
      return m_profiles[2];
   }

   double CalcLotSize(double atr, double stopAtrMult)
   {
      double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
      double riskAmt  = balance * m_riskPct / 100.0;
      double point    = SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      double tickVal  = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_SIZE);
      double slPts    = atr * stopAtrMult / point;
      if(slPts <= 0) return SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);
      double valPerPt = (tickSize > 0) ? tickVal / tickSize : tickVal;
      return NormalizeLots(riskAmt / (slPts * valPerPt));
   }

public:
   CTradeManager() : m_state({0, false, 0, 0, 0, 0, ""}) {}

   void Init(string symbol, int magic, double riskPct,
             double trailATR, double maxSpreadPips)
   {
      m_symbol        = symbol;
      m_magic         = magic;
      m_riskPct       = riskPct;
      m_trailATR      = trailATR;
      m_maxSpreadPips = maxSpreadPips;

      m_profiles[0].stopAtr = 1.4; m_profiles[0].targetAtr = 2.0;
      m_profiles[1].stopAtr = 1.8; m_profiles[1].targetAtr = 2.8;
      m_profiles[2].stopAtr = 2.3; m_profiles[2].targetAtr = 3.6;

      m_trade.SetExpertMagicNumber(magic);
      m_trade.SetDeviationInPoints(30);
      m_trade.SetTypeFilling(ORDER_FILLING_FOK);
      m_state.ticket = 0;
   }

   bool OpenBuy(double atr, double support, int confidence, bool highVolSession,
                double &outSL, double &outTP1, double &outTP2, double &outLots)
   {
      if(!SpreadOK()) return false;
      SRiskProfile p = ChooseProfile(confidence, highVolSession);

      double ask     = SymbolInfoDouble(m_symbol, SYMBOL_ASK);
      double slByATR = ask - atr * p.stopAtr;
      double slBySup = (support > 0 && support < ask) ? support * 0.995 : slByATR;
      double sl      = MathMin(slByATR, slBySup);
      double tp1     = ask + atr * p.targetAtr;
      double tp2     = ask + atr * p.targetAtr * 1.55;
      double lots    = CalcLotSize(atr, p.stopAtr);

      double minStop = SymbolInfoInteger(m_symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
      if(ask - sl < minStop) sl = ask - minStop * 1.5;

      bool ok = m_trade.Buy(lots, m_symbol, ask, sl, tp2,
                            StringFormat("TrustEA|T=%d", confidence));
      if(ok)
      {
         m_state = {m_trade.ResultOrder(), false, ask, ask, tp2, atr, "BUY"};
      }
      outSL = sl; outTP1 = tp1; outTP2 = tp2; outLots = lots;
      return ok;
   }

   bool OpenSell(double atr, double resistance, int confidence, bool highVolSession,
                 double &outSL, double &outTP1, double &outTP2, double &outLots)
   {
      if(!SpreadOK()) return false;
      SRiskProfile p = ChooseProfile(confidence, highVolSession);

      double bid     = SymbolInfoDouble(m_symbol, SYMBOL_BID);
      double slByATR = bid + atr * p.stopAtr;
      double slByRes = (resistance > 0 && resistance > bid) ? resistance * 1.005 : slByATR;
      double sl      = MathMax(slByATR, slByRes);
      double tp1     = bid - atr * p.targetAtr;
      double tp2     = bid - atr * p.targetAtr * 1.55;
      double lots    = CalcLotSize(atr, p.stopAtr);

      double minStop = SymbolInfoInteger(m_symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
      if(sl - bid < minStop) sl = bid + minStop * 1.5;

      bool ok = m_trade.Sell(lots, m_symbol, bid, sl, tp2,
                             StringFormat("TrustEA|T=%d", confidence));
      if(ok)
      {
         m_state = {m_trade.ResultOrder(), false, bid, bid, tp2, atr, "SELL"};
      }
      outSL = sl; outTP1 = tp1; outTP2 = tp2; outLots = lots;
      return ok;
   }

   bool ManageTrailingStop(double currentATR)
   {
      if(m_state.ticket == 0) return false;
      if(!m_pos.SelectByTicket(m_state.ticket)) { m_state.ticket = 0; return false; }
      if(m_pos.Magic() != m_magic)              { m_state.ticket = 0; return false; }

      double bid   = SymbolInfoDouble(m_symbol, SYMBOL_BID);
      double ask   = SymbolInfoDouble(m_symbol, SYMBOL_ASK);
      bool   isBuy = (m_pos.PositionType() == POSITION_TYPE_BUY);
      double price = isBuy ? bid : ask;
      double tATR  = (currentATR > 0) ? currentATR : m_state.atrAtOpen;

      if(isBuy  && price > m_state.peakPrice) m_state.peakPrice = price;
      if(!isBuy && price < m_state.peakPrice) m_state.peakPrice = price;

      bool tp2Hit = isBuy ? (price >= m_state.tp2Level) : (price <= m_state.tp2Level);
      if(tp2Hit && !m_state.trailingActive)
      {
         m_state.trailingActive = true;
         Print("Trailing ACTIVATED | ticket=", m_state.ticket, " peak=", m_state.peakPrice);
      }
      if(!m_state.trailingActive) return false;

      double newSL = isBuy ? m_state.peakPrice - tATR * m_trailATR
                           : m_state.peakPrice + tATR * m_trailATR;
      newSL = NormalizeDouble(newSL, _Digits);
      double curSL = m_pos.StopLoss();

      bool mustMove = isBuy ? (newSL > curSL + _Point) : (newSL < curSL - _Point);
      if(mustMove)
      {
         double minStop = SymbolInfoInteger(m_symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
         bool valid = isBuy ? (bid - newSL >= minStop) : (newSL - ask >= minStop);
         if(valid) { m_trade.PositionModify(m_state.ticket, newSL, m_pos.TakeProfit()); return true; }
      }
      return false;
   }

   bool HasOpenPosition()
   { return (m_state.ticket > 0) && m_pos.SelectByTicket(m_state.ticket); }

   bool SyncPosition()
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(m_pos.SelectByIndex(i) &&
            m_pos.Symbol() == m_symbol && m_pos.Magic() == m_magic)
         {
            string dir = (m_pos.PositionType() == POSITION_TYPE_BUY) ? "BUY" : "SELL";
            m_state = {m_pos.Ticket(), false, m_pos.PriceOpen(), m_pos.PriceOpen(), 0, 0, dir};
            Print("Synced position ticket=", m_state.ticket);
            return true;
         }
      }
      return false;
   }

   ulong  GetTicket()        { return m_state.ticket; }
   bool   IsTrailingActive() { return m_state.trailingActive; }
   double GetPeakPrice()     { return m_state.peakPrice; }
   double GetTP2Level()      { return m_state.tp2Level; }
   double GetOpenPrice()     { return m_state.openPrice; }
   string GetDirection()     { return m_state.direction; }

   void ResetState()
   { m_state = {0, false, 0, 0, 0, 0, ""}; }
};

#endif
