//+------------------------------------------------------------------+
//|                                              TradeManager.mqh    |
//|        Position sizing, execution & trailing stop management     |
//+------------------------------------------------------------------+
#ifndef TRADE_MANAGER_MQH
#define TRADE_MANAGER_MQH

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

struct STradeState
{
   ulong  ticket;
   bool   trailingActive;
   double peakPrice;
   double openPrice;
   double tp2Level;
   double atrAtOpen;
};

class CTradeManager
{
private:
   CTrade        m_trade;
   CPositionInfo m_pos;

   string   m_symbol;
   int      m_magic;
   double   m_riskPct;
   double   m_slATR;
   double   m_tp2ATR;
   double   m_trailATR;
   double   m_maxSpreadPips;

   STradeState m_state;

   double PipValue()
   {
      double point  = SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      int    digits = (int)SymbolInfoInteger(m_symbol, SYMBOL_DIGITS);
      if(digits == 3 || digits == 5) return point * 10;
      return point;
   }

   double NormalizeLots(double lots)
   {
      double minLot  = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);
      double maxLot  = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MAX);
      double lotStep = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_STEP);
      lots = MathFloor(lots / lotStep) * lotStep;
      return MathMax(minLot, MathMin(maxLot, lots));
   }

   bool SpreadOK()
   {
      double spread     = SymbolInfoInteger(m_symbol, SYMBOL_SPREAD) *
                          SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      double pip        = PipValue();
      double spreadPips = (pip > 0) ? spread / pip : 0;
      if(spreadPips > m_maxSpreadPips)
      {
         Print("Spread too wide: ", DoubleToString(spreadPips, 1), " pips (max ", m_maxSpreadPips, ")");
         return false;
      }
      return true;
   }

public:
   CTradeManager() : m_state({0, false, 0, 0, 0, 0}) {}

   void Init(string symbol, int magic, double riskPct,
             double slATR, double tp2ATR, double trailATR,
             double maxSpreadPips)
   {
      m_symbol        = symbol;
      m_magic         = magic;
      m_riskPct       = riskPct;
      m_slATR         = slATR;
      m_tp2ATR        = tp2ATR;
      m_trailATR      = trailATR;
      m_maxSpreadPips = maxSpreadPips;

      m_trade.SetExpertMagicNumber(magic);
      m_trade.SetDeviationInPoints(30);
      m_trade.SetTypeFilling(ORDER_FILLING_FOK);

      m_state.ticket = 0;
   }

   double CalcLotSize(double atr, ENUM_ORDER_TYPE direction)
   {
      double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
      double riskAmt    = balance * m_riskPct / 100.0;
      double point      = SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      double tickVal    = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize   = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_SIZE);
      double slPoints   = atr * m_slATR / point;

      if(slPoints <= 0) return SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);

      double valuePerPoint = (tickSize > 0) ? tickVal / tickSize : tickVal;
      double lots = riskAmt / (slPoints * valuePerPoint);
      return NormalizeLots(lots);
   }

   bool OpenBuy(double atr, double support, int trustScore,
                double &outSL, double &outTP1, double &outTP2, double &outLots)
   {
      if(!SpreadOK()) return false;

      double ask     = SymbolInfoDouble(m_symbol, SYMBOL_ASK);
      double slByATR = ask - atr * m_slATR;
      double slBySup = (support > 0) ? support - atr * 0.2 : slByATR;
      double sl      = MathMax(slByATR, slBySup);
      double tp1     = ask + atr * 2.0;
      double tp2     = ask + atr * m_tp2ATR;
      double lots    = CalcLotSize(atr, ORDER_TYPE_BUY);

      double minStop = SymbolInfoInteger(m_symbol, SYMBOL_TRADE_STOPS_LEVEL) *
                       SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      if(ask - sl < minStop) sl = ask - minStop * 1.5;

      bool ok = m_trade.Buy(lots, m_symbol, ask, sl, tp2,
                            StringFormat("TrustEA|Trust=%d", trustScore));
      if(ok)
      {
         m_state.ticket         = m_trade.ResultOrder();
         m_state.trailingActive = false;
         m_state.peakPrice      = ask;
         m_state.openPrice      = ask;
         m_state.tp2Level       = tp2;
         m_state.atrAtOpen      = atr;
      }
      outSL = sl; outTP1 = tp1; outTP2 = tp2; outLots = lots;
      return ok;
   }

   bool OpenSell(double atr, double resistance, int trustScore,
                 double &outSL, double &outTP1, double &outTP2, double &outLots)
   {
      if(!SpreadOK()) return false;

      double bid     = SymbolInfoDouble(m_symbol, SYMBOL_BID);
      double slByATR = bid + atr * m_slATR;
      double slByRes = (resistance > 0) ? resistance + atr * 0.2 : slByATR;
      double sl      = MathMin(slByATR, slByRes);
      double tp1     = bid - atr * 2.0;
      double tp2     = bid - atr * m_tp2ATR;
      double lots    = CalcLotSize(atr, ORDER_TYPE_SELL);

      double minStop = SymbolInfoInteger(m_symbol, SYMBOL_TRADE_STOPS_LEVEL) *
                       SymbolInfoDouble(m_symbol, SYMBOL_POINT);
      if(sl - bid < minStop) sl = bid + minStop * 1.5;

      bool ok = m_trade.Sell(lots, m_symbol, bid, sl, tp2,
                             StringFormat("TrustEA|Trust=%d", trustScore));
      if(ok)
      {
         m_state.ticket         = m_trade.ResultOrder();
         m_state.trailingActive = false;
         m_state.peakPrice      = bid;
         m_state.openPrice      = bid;
         m_state.tp2Level       = tp2;
         m_state.atrAtOpen      = atr;
      }
      outSL = sl; outTP1 = tp1; outTP2 = tp2; outLots = lots;
      return ok;
   }

   bool ManageTrailingStop(double currentATR)
   {
      if(m_state.ticket == 0) return false;
      if(!m_pos.SelectByTicket(m_state.ticket)) { m_state.ticket = 0; return false; }
      if(m_pos.Magic() != m_magic) { m_state.ticket = 0; return false; }

      double currentBid = SymbolInfoDouble(m_symbol, SYMBOL_BID);
      double currentAsk = SymbolInfoDouble(m_symbol, SYMBOL_ASK);
      bool   isBuy      = (m_pos.PositionType() == POSITION_TYPE_BUY);
      double price      = isBuy ? currentBid : currentAsk;
      double trailAtr   = (currentATR > 0) ? currentATR : m_state.atrAtOpen;

      if(isBuy  && price > m_state.peakPrice) m_state.peakPrice = price;
      if(!isBuy && price < m_state.peakPrice) m_state.peakPrice = price;

      bool tp2Reached = isBuy ? (price >= m_state.tp2Level) : (price <= m_state.tp2Level);
      if(tp2Reached && !m_state.trailingActive)
      {
         m_state.trailingActive = true;
         Print("Trailing Stop ACTIVATED ticket=", m_state.ticket, " price=", price);
      }

      if(!m_state.trailingActive) return false;

      double newSL     = isBuy ? m_state.peakPrice - trailAtr * m_trailATR
                               : m_state.peakPrice + trailAtr * m_trailATR;
      newSL = NormalizeDouble(newSL, _Digits);
      double currentSL = m_pos.StopLoss();

      bool shouldUpdate = isBuy ? (newSL > currentSL + _Point) : (newSL < currentSL - _Point);
      if(shouldUpdate)
      {
         double minStop = SymbolInfoInteger(m_symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
         bool   validSL = isBuy ? (currentBid - newSL >= minStop) : (newSL - currentAsk >= minStop);
         if(validSL)
         {
            m_trade.PositionModify(m_state.ticket, newSL, m_pos.TakeProfit());
            return true;
         }
      }
      return false;
   }

   bool HasOpenPosition()
   {
      if(m_state.ticket == 0) return false;
      return m_pos.SelectByTicket(m_state.ticket);
   }

   bool SyncPosition()
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(m_pos.SelectByIndex(i))
         {
            if(m_pos.Symbol() == m_symbol && m_pos.Magic() == m_magic)
            {
               m_state.ticket         = m_pos.Ticket();
               m_state.openPrice      = m_pos.PriceOpen();
               m_state.peakPrice      = m_pos.PriceOpen();
               m_state.trailingActive = false;
               Print("TradeManager: Synced position ticket=", m_state.ticket);
               return true;
            }
         }
      }
      return false;
   }

   ulong  GetTicket()         { return m_state.ticket; }
   bool   IsTrailingActive()  { return m_state.trailingActive; }
   double GetPeakPrice()      { return m_state.peakPrice; }
   double GetTP2Level()       { return m_state.tp2Level; }
   double GetOpenPrice()      { return m_state.openPrice; }

   void ResetState()
   {
      m_state.ticket         = 0;
      m_state.trailingActive = false;
      m_state.peakPrice      = 0;
      m_state.openPrice      = 0;
      m_state.tp2Level       = 0;
      m_state.atrAtOpen      = 0;
   }
};

#endif
