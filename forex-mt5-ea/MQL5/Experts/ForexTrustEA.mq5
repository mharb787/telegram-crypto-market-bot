//+------------------------------------------------------------------+
//|                                              ForexTrustEA.mq5    |
//|          Trust Score Forex Expert Advisor v1.1                   |
//|                                                                  |
//|  Exact port of proven crypto bot strategy to MT5 Forex:         |
//|    - 6-factor trust score with original weights & formulas       |
//|    - Session multipliers (us_open=0.9, etc.)                     |
//|    - Risk profiles: medium SL=ATR*1.8, TP2=ATR*4.34             |
//|    - Trailing stop activates at TP2 (ATR*targetAtr*1.55)        |
//|    - Friday 20:00 UTC block, spread filter, one trade at a time  |
//|    - Telegram Arabic notifications                               |
//+------------------------------------------------------------------+
#property copyright   "ForexTrust EA"
#property version     "1.10"
#property description "6-Factor Trust Score — Exact Port from Crypto Bot"
#property strict

#include "..\Include\TrustSignal.mqh"
#include "..\Include\TradeManager.mqh"
#include "..\Include\TelegramNotifier.mqh"

//+------------------------------------------------------------------+
input group "════ Strategy ════"
input int    InpTrustThreshold  = 82;
input bool   InpTradeBuy        = true;
input bool   InpTradeSell       = false;
input ENUM_TIMEFRAMES InpTF     = PERIOD_H4;

input group "════ ATR ════"
input int    InpATRPeriod       = 14;
input double InpTrail_ATR       = 1.0;

input group "════ EMA ════"
input int    InpEMA20           = 20;
input int    InpEMA50           = 50;
input int    InpEMA200          = 200;

input group "════ Money Management ════"
input double InpRiskPercent     = 1.0;
input double InpMaxSpreadPips   = 4.0;

input group "════ DXY Filter ════"
input string InpDXYSymbol       = "DXY";
input bool   InpInvertDXY       = true;

input group "════ Volume ════"
input int    InpVolPeriod       = 30;

input group "════ RSI ════"
input int    InpRSIPeriod       = 14;

input group "════ Telegram ════"
input string InpTgToken         = "";
input string InpTgChatID        = "";
input bool   InpTgEnabled       = true;

input group "════ General ════"
input int    InpMagic           = 202401;
input bool   InpShowDashboard   = true;
input bool   InpLogSignals      = true;

//+------------------------------------------------------------------+
CTrustSignal      g_signal;
CTradeManager     g_trade;
CTelegramNotifier g_telegram;

datetime g_lastBarTime  = 0;
int      g_totalTrades  = 0;
int      g_winTrades    = 0;
double   g_totalPnL     = 0;
string   g_lastSignal   = "Waiting...";
double   g_lastTrust    = 0;
ulong    g_lastClosedDeal = 0;

const string LBL_TITLE = "TrustEA_T";
const string LBL_TRUST = "TrustEA_S";
const string LBL_SIG   = "TrustEA_M";
const string LBL_POS   = "TrustEA_P";
const string LBL_STAT  = "TrustEA_R";

//+------------------------------------------------------------------+
int OnInit()
{
   Print("ForexTrustEA v1.1 — ", _Symbol, " ", EnumToString(InpTF));

   if(!g_signal.Init(_Symbol, InpTF,
                     InpATRPeriod, InpEMA20, InpEMA50, InpEMA200,
                     InpRSIPeriod, InpVolPeriod,
                     InpDXYSymbol, InpInvertDXY))
   {
      Alert("ForexTrustEA: indicator init failed");
      return INIT_FAILED;
   }

   g_trade.Init(_Symbol, InpMagic, InpRiskPercent, InpTrail_ATR, InpMaxSpreadPips);

   if(InpTgEnabled) g_telegram.Init(InpTgToken, InpTgChatID);
   if(g_trade.SyncPosition())
      Print("Synced existing position ticket=", g_trade.GetTicket());

   if(InpShowDashboard) DrawDashboard();
   g_telegram.SendAlert("بدأ ForexTrustEA v1.1 على " + _Symbol + " " + EnumToString(InpTF));
   return INIT_SUCCEEDED;
}

void OnDeinit(int reason)
{
   g_signal.Release();
   if(InpShowDashboard) DeleteDashboard();
}

void OnTick()
{
   if(g_trade.HasOpenPosition())
      g_trade.ManageTrailingStop(g_signal.GetATR(0));

   datetime barTime = iTime(_Symbol, InpTF, 0);
   if(barTime == g_lastBarTime) return;
   g_lastBarTime = barTime;
   OnNewBar();
}

void OnNewBar()
{
   CheckPositionClosed();
   if(g_trade.HasOpenPosition()) { UpdateDashboard(); return; }

   STrustBreakdown bd = g_signal.Calculate();
   g_lastTrust  = bd.totalScore;
   g_lastSignal = StringFormat("Trust=%.0f (base=%.0f x%.2f) | Min=%d",
                               bd.totalScore, bd.baseScore, bd.sessionMult, InpTrustThreshold);

   if(InpLogSignals) Print(g_signal.FormatBreakdown(bd));

   // Hard block: weekend or Friday 20:00+
   if(bd.contextFactor <= -0.99)
   {
      g_lastSignal = "Weekend/FridayClose block";
      UpdateDashboard();
      return;
   }

   bool highVolSession = (bd.sessionMult < 1.0);
   bool entryBuy  = InpTradeBuy  && (bd.totalScore >= InpTrustThreshold);
   bool entrySell = InpTradeSell && (bd.totalScore >= InpTrustThreshold)
                    && (bd.trendFactor < -0.30);

   if(entryBuy)
   {
      double sl, tp1, tp2, lots;
      int    conf = (int)bd.totalScore;
      if(g_trade.OpenBuy(bd.atr, bd.support, conf, highVolSession, sl, tp1, tp2, lots))
      {
         double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         PrintFormat("BUY %s | Trust=%.0f | Entry=%.5f SL=%.5f TP2=%.5f Lots=%.2f",
                     _Symbol, bd.totalScore, entry, sl, tp2, lots);
         g_telegram.SendTradeOpen(_Symbol, "BUY", entry, sl, tp1, tp2, lots, conf);
         g_lastSignal = StringFormat("BUY @ %.5f | Trust=%.0f", entry, bd.totalScore);
         g_totalTrades++;
      }
   }
   else if(entrySell)
   {
      double sl, tp1, tp2, lots;
      int    conf = (int)bd.totalScore;
      if(g_trade.OpenSell(bd.atr, bd.resistance, conf, highVolSession, sl, tp1, tp2, lots))
      {
         double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         PrintFormat("SELL %s | Trust=%.0f | Entry=%.5f SL=%.5f TP2=%.5f Lots=%.2f",
                     _Symbol, bd.totalScore, entry, sl, tp2, lots);
         g_telegram.SendTradeOpen(_Symbol, "SELL", entry, sl, tp1, tp2, lots, conf);
         g_lastSignal = StringFormat("SELL @ %.5f | Trust=%.0f", entry, bd.totalScore);
         g_totalTrades++;
      }
   }
   else
      g_lastSignal = StringFormat("No entry | Trust=%.0f < %d", bd.totalScore, InpTrustThreshold);

   UpdateDashboard();
}

//+------------------------------------------------------------------+
void CheckPositionClosed()
{
   if(g_trade.GetTicket() == 0) return;
   CPositionInfo pos;
   if(pos.SelectByTicket(g_trade.GetTicket())) return;

   HistorySelect(TimeCurrent() - 7200, TimeCurrent());
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == g_lastClosedDeal) break;
      if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      g_lastClosedDeal = deal;
      double profit = HistoryDealGetDouble(deal, DEAL_PROFIT) +
                      HistoryDealGetDouble(deal, DEAL_SWAP)   +
                      HistoryDealGetDouble(deal, DEAL_COMMISSION);
      double closePrice = HistoryDealGetDouble(deal, DEAL_PRICE);
      string reason     = DealCloseReason(deal);

      g_totalPnL += profit;
      if(profit > 0) g_winTrades++;

      g_telegram.SendTradeClose(_Symbol, g_trade.GetDirection(),
         g_trade.GetOpenPrice(), closePrice, profit, reason);
      PrintFormat("CLOSED %s | PnL=%.2f | %s", _Symbol, profit, reason);
      break;
   }
   g_trade.ResetState();
   g_lastSignal = "Closed — scanning...";
}

string DealCloseReason(ulong deal)
{
   switch((int)HistoryDealGetInteger(deal, DEAL_REASON))
   {
      case DEAL_REASON_SL:     return "Stop Loss";
      case DEAL_REASON_TP:     return "Take Profit";
      case DEAL_REASON_EXPERT: return "Trailing Stop";
      default:                 return "Manual";
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest     &request,
                        const MqlTradeResult      &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(!HistoryDealSelect(trans.deal)) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_ENTRY) == DEAL_ENTRY_OUT)
      CheckPositionClosed();
}

//+------------------------------------------------------------------+
void DrawDashboard()
{
   MakeLabel(LBL_TITLE, 15, 20,  "ForexTrust EA v1.1", 10, clrGold,    true);
   MakeLabel(LBL_TRUST, 15, 40,  "Trust: --",          9,  clrWhite,   false);
   MakeLabel(LBL_SIG,   15, 58,  "Signal: --",         9,  clrSilver,  false);
   MakeLabel(LBL_POS,   15, 76,  "Position: None",     9,  clrSilver,  false);
   MakeLabel(LBL_STAT,  15, 94,  "Stats: --",          8,  clrSilver,  false);
}

void UpdateDashboard()
{
   color clr = (g_lastTrust >= InpTrustThreshold) ? clrLime :
               (g_lastTrust >= 70)                ? clrYellow : clrOrangeRed;
   ObjectSetString(0,  LBL_TRUST, OBJPROP_TEXT,
      StringFormat("Trust: %.0f / %d", g_lastTrust, InpTrustThreshold));
   ObjectSetInteger(0, LBL_TRUST, OBJPROP_COLOR, clr);
   ObjectSetString(0,  LBL_SIG, OBJPROP_TEXT, g_lastSignal);

   bool   hasPos  = g_trade.HasOpenPosition();
   string posText = hasPos ?
      StringFormat("POS: %s | Trail: %s | Peak: %.5f",
         g_trade.GetDirection(),
         g_trade.IsTrailingActive() ? "ON" : "off",
         g_trade.GetPeakPrice())
      : "Position: None";
   ObjectSetString(0,  LBL_POS, OBJPROP_TEXT, posText);
   ObjectSetInteger(0, LBL_POS, OBJPROP_COLOR, hasPos ? clrAquamarine : clrSilver);

   double wr = (g_totalTrades > 0) ? (double)g_winTrades / g_totalTrades * 100 : 0;
   ObjectSetString(0, LBL_STAT, OBJPROP_TEXT,
      StringFormat("Trades: %d | Wins: %d (%.0f%%) | PnL: %.2f $",
         g_totalTrades, g_winTrades, wr, g_totalPnL));
   ChartRedraw(0);
}

void MakeLabel(string name, int x, int y, string txt, int sz, color clr, bool bold)
{
   ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE,  x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE,  y);
   ObjectSetInteger(0, name, OBJPROP_CORNER,     CORNER_LEFT_UPPER);
   ObjectSetString (0, name, OBJPROP_TEXT,       txt);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE,   sz);
   ObjectSetInteger(0, name, OBJPROP_COLOR,      clr);
   ObjectSetString (0, name, OBJPROP_FONT,       bold ? "Arial Bold" : "Arial");
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN,     true);
}

void DeleteDashboard()
{
   string lbls[] = {LBL_TITLE, LBL_TRUST, LBL_SIG, LBL_POS, LBL_STAT};
   for(int i = 0; i < ArraySize(lbls); i++) ObjectDelete(0, lbls[i]);
}
