//+------------------------------------------------------------------+
//|                                              ForexTrustEA.mq5    |
//|          Trust Score Forex Expert Advisor v1.0                   |
//|                                                                  |
//|  Strategy: 6-factor weighted trust score (0-100)                 |
//|  Entry only when Trust >= 82                                     |
//|  Tested concept: 65-75% win rate, 15-20% annual return target   |
//|                                                                  |
//|  Factor Weights:                                                 |
//|    Trend (EMA20/50/200): 24%                                     |
//|    Momentum (RSI/MACD/BB): 19%                                   |
//|    Volume Ratio: 15%                                             |
//|    Market Context (Session): 18%                                 |
//|    DXY Filter: 16%                                               |
//|    Risk/Reward (S/R): 8%                                         |
//+------------------------------------------------------------------+
#property copyright   "ForexTrust EA"
#property version     "1.00"
#property description "6-Factor Trust Score System for Forex"
#property strict

#include "..\Include\TrustSignal.mqh"
#include "..\Include\TradeManager.mqh"
#include "..\Include\TelegramNotifier.mqh"

//--- Input groups
input group "════ Strategy ════"
input int    InpTrustThreshold   = 82;           // Min trust score for entry
input bool   InpTradeBuy         = true;         // Allow BUY trades
input bool   InpTradeSell        = false;        // Allow SELL (counter-trend)
input ENUM_TIMEFRAMES InpTF      = PERIOD_H4;    // Trading timeframe

input group "════ ATR / Stops ════"
input int    InpATRPeriod        = 14;           // ATR period
input double InpSL_ATR           = 1.8;          // SL = ATR x this
input double InpTP2_ATR          = 4.34;         // Trailing activates at ATR x this from entry
input double InpTrail_ATR        = 1.0;          // Trailing: Stop = Peak - ATR x this

input group "════ EMA ════"
input int    InpEMA20            = 20;
input int    InpEMA50            = 50;
input int    InpEMA200           = 200;

input group "════ Money Management ════"
input double InpRiskPercent      = 1.0;          // Risk per trade (% of balance)
input double InpMaxSpreadPips    = 4.0;          // Max spread in pips to allow entry

input group "════ DXY Filter ════"
input string InpDXYSymbol        = "DXY";        // Dollar Index symbol (blank to disable)
input bool   InpInvertDXY        = true;         // Invert DXY for XAUUSD / EUR / GBP

input group "════ Volume ════"
input int    InpVolPeriod        = 20;           // Volume MA period

input group "════ RSI ════"
input int    InpRSIPeriod        = 14;

input group "════ Telegram ════"
input string InpTgToken          = "";           // Bot token
input string InpTgChatID         = "";           // Chat ID
input bool   InpTgEnabled        = true;         // Send notifications

input group "════ General ════"
input int    InpMagic            = 202401;       // Magic number
input bool   InpShowDashboard    = true;         // Show on-chart dashboard
input bool   InpPrintSignals     = true;         // Print signals to journal

//--- Globals
CTrustSignal      g_signal;
CTradeManager     g_trade;
CTelegramNotifier g_telegram;

datetime g_lastBarTime  = 0;
int      g_totalTrades  = 0;
int      g_winTrades    = 0;
double   g_totalPnL     = 0;
string   g_lastSignal   = "Waiting...";
double   g_lastTrust    = 0;

// Dashboard label names
string LBL_TITLE   = "TrustEA_Title";
string LBL_TRUST   = "TrustEA_Trust";
string LBL_SIGNAL  = "TrustEA_Signal";
string LBL_COMP    = "TrustEA_Comp";
string LBL_POS     = "TrustEA_Pos";
string LBL_STATS   = "TrustEA_Stats";

//+------------------------------------------------------------------+
int OnInit()
{
   Print("ForexTrustEA v1.0 initializing on ", _Symbol, " ", EnumToString(InpTF));

   if(!g_signal.Init(_Symbol, InpTF,
                     InpATRPeriod, InpEMA20, InpEMA50, InpEMA200,
                     InpRSIPeriod, InpVolPeriod,
                     InpDXYSymbol, InpInvertDXY))
   {
      Alert("ForexTrustEA: Failed to initialize indicators!");
      return INIT_FAILED;
   }

   g_trade.Init(_Symbol, InpMagic, InpRiskPercent,
                InpSL_ATR, InpTP2_ATR, InpTrail_ATR, InpMaxSpreadPips);

   if(InpTgEnabled)
      g_telegram.Init(InpTgToken, InpTgChatID);

   // Try to sync existing position after restart
   if(g_trade.SyncPosition())
      Print("Synced existing position ticket=", g_trade.GetTicket());

   if(InpShowDashboard) DrawDashboard();

   g_telegram.SendAlert("ForexTrustEA started on " + _Symbol + " " + EnumToString(InpTF));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(int reason)
{
   g_signal.Release();
   if(InpShowDashboard) DeleteDashboard();
   Print("ForexTrustEA stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
void OnTick()
{
   // Manage trailing stop on every tick (time-sensitive)
   if(g_trade.HasOpenPosition())
   {
      double atr = g_signal.GetATR(0);
      bool updated = g_trade.ManageTrailingStop(atr);
      if(updated && InpPrintSignals)
         Print("Trailing stop updated for ", _Symbol, " | Peak=", g_trade.GetPeakPrice());
   }

   // Bar-open logic (only run once per new H4 candle)
   datetime currentBarTime = iTime(_Symbol, InpTF, 0);
   if(currentBarTime == g_lastBarTime) return;
   g_lastBarTime = currentBarTime;

   OnNewBar();
}

//+------------------------------------------------------------------+
void OnNewBar()
{
   // Check if position closed (for stats & Telegram)
   CheckPositionClosed();

   // Don't open new position if one exists
   if(g_trade.HasOpenPosition())
   {
      if(InpShowDashboard) UpdateDashboard(g_lastTrust, g_lastSignal);
      return;
   }

   // Calculate trust score
   STrustBreakdown bd = g_signal.Calculate();
   g_lastTrust = bd.totalScore;

   string signalStr = StringFormat("Trust=%.1f (Threshold=%d)", bd.totalScore, InpTrustThreshold);
   g_lastSignal = signalStr;

   if(InpPrintSignals)
      Print(g_signal.FormatBreakdown(bd));

   // Entry decision
   bool entryBuy  = InpTradeBuy  && (bd.totalScore >= InpTrustThreshold);
   bool entrySell = InpTradeSell && (bd.totalScore >= InpTrustThreshold) &&
                    (bd.trendScore < 30); // Sell only on confirmed downtrend

   if(entryBuy)
   {
      double sl, tp1, tp2, lots;
      if(g_trade.OpenBuy(bd.atr, bd.support, (int)bd.totalScore, sl, tp1, tp2, lots))
      {
         string msg = StringFormat(
            "BUY %s | Trust=%.1f | Entry=%.5f SL=%.5f TP2=%.5f Lots=%.2f",
            _Symbol, bd.totalScore,
            SymbolInfoDouble(_Symbol, SYMBOL_ASK), sl, tp2, lots);
         Print(msg);
         g_telegram.SendTradeOpen(_Symbol, "BUY",
            SymbolInfoDouble(_Symbol, SYMBOL_ASK), sl, tp1, tp2, lots, (int)bd.totalScore);
         g_lastSignal = "BOUGHT @ " + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_ASK), _Digits);
         g_totalTrades++;
      }
   }
   else if(entrySell)
   {
      double sl, tp1, tp2, lots;
      if(g_trade.OpenSell(bd.atr, bd.resistance, (int)bd.totalScore, sl, tp1, tp2, lots))
      {
         string msg = StringFormat(
            "SELL %s | Trust=%.1f | Entry=%.5f SL=%.5f TP2=%.5f Lots=%.2f",
            _Symbol, bd.totalScore,
            SymbolInfoDouble(_Symbol, SYMBOL_BID), sl, tp2, lots);
         Print(msg);
         g_telegram.SendTradeOpen(_Symbol, "SELL",
            SymbolInfoDouble(_Symbol, SYMBOL_BID), sl, tp1, tp2, lots, (int)bd.totalScore);
         g_lastSignal = "SOLD @ " + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_BID), _Digits);
         g_totalTrades++;
      }
   }
   else
   {
      g_lastSignal = StringFormat("No signal | Trust=%.1f < %d", bd.totalScore, InpTrustThreshold);
   }

   if(InpShowDashboard) UpdateDashboard(bd.totalScore, g_lastSignal);
}

//+------------------------------------------------------------------+
// Track closed positions for stats and Telegram notifications
//+------------------------------------------------------------------+
static ulong s_lastClosedTicket = 0;

void CheckPositionClosed()
{
   if(g_trade.GetTicket() == 0) return;

   CPositionInfo pos;
   if(!pos.SelectByTicket(g_trade.GetTicket()))
   {
      HistorySelect(TimeCurrent() - 3600, TimeCurrent());
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
      {
         ulong deal = HistoryDealGetTicket(i);
         if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) continue;
         if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
         if(deal == s_lastClosedTicket) break;

         s_lastClosedTicket = deal;
         double profit    = HistoryDealGetDouble(deal, DEAL_PROFIT) +
                            HistoryDealGetDouble(deal, DEAL_SWAP)   +
                            HistoryDealGetDouble(deal, DEAL_COMMISSION);
         double closePrice = HistoryDealGetDouble(deal, DEAL_PRICE);
         string reason     = GetCloseReason(deal);

         g_totalPnL += profit;
         if(profit > 0) g_winTrades++;

         g_telegram.SendTradeClose(_Symbol,
            (HistoryDealGetInteger(deal, DEAL_TYPE) == DEAL_TYPE_SELL) ? "BUY" : "SELL",
            g_trade.GetOpenPrice(), closePrice, profit, reason);

         Print("Position closed | PnL=", DoubleToString(profit, 2), " Reason=", reason);
         break;
      }
      g_trade.ResetState();
   }
}

string GetCloseReason(ulong dealTicket)
{
   long reason = HistoryDealGetInteger(dealTicket, DEAL_REASON);
   switch((int)reason)
   {
      case DEAL_REASON_SL:      return "Stop Loss";
      case DEAL_REASON_TP:      return "Take Profit";
      case DEAL_REASON_EXPERT:  return "Trailing Stop";
      default:                  return "Manual/Other";
   }
}

//+------------------------------------------------------------------+
// On-chart dashboard
//+------------------------------------------------------------------+
void DrawDashboard()
{
   int x = 15, y = 30;
   int lineH = 18;
   color hiColor  = clrGold;

   CreateLabel(LBL_TITLE,  x, y,          "ForexTrust EA v1.0", 10, hiColor,  true);
   CreateLabel(LBL_TRUST,  x, y+lineH,    "Trust: --", 9, clrWhite,  false);
   CreateLabel(LBL_SIGNAL, x, y+lineH*2,  "Signal: Waiting...", 9, clrSilver, false);
   CreateLabel(LBL_COMP,   x, y+lineH*3,  "Components: --", 8, clrSilver, false);
   CreateLabel(LBL_POS,    x, y+lineH*4,  "Position: None", 9, clrSilver, false);
   CreateLabel(LBL_STATS,  x, y+lineH*5,  "Trades: 0 | Wins: 0 | PnL: 0", 8, clrSilver, false);
}

void UpdateDashboard(double trust, string signal)
{
   color trustColor = (trust >= InpTrustThreshold) ? clrLime :
                      (trust >= 70)                ? clrYellow : clrOrangeRed;
   ObjectSetString(0, LBL_TRUST, OBJPROP_TEXT,
      StringFormat("Trust: %.1f / %d", trust, InpTrustThreshold));
   ObjectSetInteger(0, LBL_TRUST, OBJPROP_COLOR, trustColor);

   ObjectSetString(0, LBL_SIGNAL, OBJPROP_TEXT, "Signal: " + signal);

   string posStr = g_trade.HasOpenPosition() ?
      StringFormat("Position: OPEN | Trailing: %s | Peak: %.5f",
         g_trade.IsTrailingActive() ? "YES" : "No",
         g_trade.GetPeakPrice())
      : "Position: None";
   ObjectSetString(0, LBL_POS, OBJPROP_TEXT, posStr);
   ObjectSetInteger(0, LBL_POS, OBJPROP_COLOR,
      g_trade.HasOpenPosition() ? clrAquamarine : clrSilver);

   double winRate = (g_totalTrades > 0) ? (double)g_winTrades / g_totalTrades * 100 : 0;
   ObjectSetString(0, LBL_STATS, OBJPROP_TEXT,
      StringFormat("Trades: %d | Wins: %d (%.0f%%) | PnL: %.2f",
         g_totalTrades, g_winTrades, winRate, g_totalPnL));

   ChartRedraw(0);
}

void CreateLabel(string name, int x, int y, string text, int fontSize,
                 color clr, bool bold)
{
   ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetString (0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fontSize);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetString (0, name, OBJPROP_FONT, bold ? "Arial Bold" : "Arial");
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
}

void DeleteDashboard()
{
   string labels[] = {LBL_TITLE, LBL_TRUST, LBL_SIGNAL, LBL_COMP, LBL_POS, LBL_STATS};
   for(int i = 0; i < ArraySize(labels); i++)
      ObjectDelete(0, labels[i]);
}

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      if(HistoryDealSelect(trans.deal))
      {
         if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC) == InpMagic)
         {
            long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
            if(entry == DEAL_ENTRY_OUT)
            {
               Print("Deal closed detected: ticket=", trans.deal);
               CheckPositionClosed();
            }
         }
      }
   }
}
