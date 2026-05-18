//+------------------------------------------------------------------+
//|                                           TelegramNotifier.mqh   |
//|                    Telegram Bot API notifications for ForexTrust  |
//+------------------------------------------------------------------+
#ifndef TELEGRAM_NOTIFIER_MQH
#define TELEGRAM_NOTIFIER_MQH

class CTelegramNotifier
{
private:
   string   m_botToken;
   string   m_chatID;
   bool     m_enabled;
   string   m_baseURL;

   string UrlEncode(string text)
   {
      string result = "";
      int len = StringLen(text);
      for(int i = 0; i < len; i++)
      {
         ushort ch = StringGetCharacter(text, i);
         if((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
            (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~')
            result += ShortToString(ch);
         else if(ch == ' ')
            result += "%20";
         else
            result += StringFormat("%%%02X", ch);
      }
      return result;
   }

public:
   CTelegramNotifier() : m_enabled(false) {}

   bool Init(string botToken, string chatID)
   {
      if(StringLen(botToken) == 0 || StringLen(chatID) == 0)
      {
         m_enabled = false;
         return false;
      }
      m_botToken = botToken;
      m_chatID   = chatID;
      m_baseURL  = "https://api.telegram.org/bot" + m_botToken + "/sendMessage";
      m_enabled  = true;
      return true;
   }

   bool Send(string message)
   {
      if(!m_enabled) return false;

      string url = m_baseURL + "?chat_id=" + m_chatID + "&text=" + UrlEncode(message) + "&parse_mode=HTML";

      char   postData[];
      char   result[];
      string headers;
      int    timeout = 5000;

      ArrayResize(postData, 0);
      int res = WebRequest("GET", url, "", timeout, postData, result, headers);

      if(res == -1)
      {
         int err = GetLastError();
         if(err == 4060)
            Print("Telegram: Add 'https://api.telegram.org' to Tools > Options > Expert Advisors > Allow WebRequest");
         else
            Print("Telegram WebRequest error: ", err);
         return false;
      }
      return (res == 200);
   }

   void SendTradeOpen(string symbol, string direction, double price, double sl,
                      double tp1, double tp2, double lots, int trustScore)
   {
      if(!m_enabled) return;
      string emoji = (direction == "BUY") ? "📈" : "📉";
      string msg = StringFormat(
         "%s <b>%s %s</b>\n\n"
         "💰 السعر: %.5f\n"
         "🛑 وقف الخسارة: %.5f\n"
         "🎯 هدف 1: %.5f\n"
         "🎯 هدف 2 (Trailing): %.5f\n"
         "📊 الحجم: %.2f lot\n"
         "⭐ نقاط الثقة: %d/100\n"
         "⏰ %s",
         emoji, direction, symbol,
         price, sl, tp1, tp2, lots, trustScore,
         TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES)
      );
      Send(msg);
   }

   void SendTradeClose(string symbol, string direction, double openPrice,
                       double closePrice, double profit, string reason)
   {
      if(!m_enabled) return;
      string emoji   = (profit >= 0) ? "✅" : "❌";
      string pnlSign = (profit >= 0) ? "+" : "";
      string msg = StringFormat(
         "%s <b>إغلاق %s %s</b>\n\n"
         "📥 سعر الدخول: %.5f\n"
         "📤 سعر الخروج: %.5f\n"
         "💵 الربح/الخسارة: %s%.2f $\n"
         "📋 السبب: %s\n"
         "⏰ %s",
         emoji, direction, symbol,
         openPrice, closePrice,
         pnlSign, profit, reason,
         TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES)
      );
      Send(msg);
   }

   void SendAlert(string message)
   {
      if(!m_enabled) return;
      Send("⚠️ <b>ForexTrust EA</b>\n" + message);
   }
};

#endif
