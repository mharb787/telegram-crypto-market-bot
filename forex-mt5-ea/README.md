# ForexTrust EA — MT5 Expert Advisor

نظام تداول فوركس احترافي مبني على **نظام ثقة من 6 عوامل** مثبت بنتائج 3 سنوات على بوت كريبتو.

---

## هيكل الملفات

```
forex-mt5-ea/
└── MQL5/
    ├── Experts/
    │   └── ForexTrustEA.mq5      ← الملف الرئيسي (EA)
    └── Include/
        ├── TrustSignal.mqh        ← حساب نقاط الثقة (6 عوامل)
        ├── TradeManager.mqh       ← إدارة الصفقات والـ Trailing Stop
        └── TelegramNotifier.mqh   ← إشعارات تليغرام
```

---

## نظام الثقة (Trust Score)

| العامل | الوزن | المؤشرات |
|--------|-------|----------|
| Trend | 24% | EMA20 / EMA50 / EMA200 + slope |
| Momentum | 19% | RSI + MACD (histogram) + Bollinger Bands |
| Volume Ratio | 15% | حجم الشمعة ÷ متوسط 20 شمعة |
| Market Context | 18% | الجلسة (لندن/نيويورك) + ATR volatility |
| DXY Filter | 16% | Dollar Index EMA20/50 (بديل Bitcoin filter) |
| Risk/Reward | 8% | مسافة الدعم vs المقاومة |

**الدخول فقط عند Trust >= 82**

---

## منطق وقف الخسارة والأهداف

```
SL   = ATR × 1.8 (أو عند الدعم — أيهما أقل خطورة)
TP1  = ATR × 2.0 (هدف مرجعي)
TP2  = ATR × 4.34 (عند هذا المستوى يتفعل Trailing Stop)

Trailing Stop:
  عند وصول السعر لـ TP2:
    Stop = Peak − ATR × 1.0 (للشراء)
    Stop = Peak + ATR × 1.0 (للبيع)
```

---

## التثبيت

### 1. نسخ الملفات

```
ForexTrustEA.mq5     →  [MT5 Data Folder]\MQL5\Experts\
TrustSignal.mqh      →  [MT5 Data Folder]\MQL5\Include\
TradeManager.mqh     →  [MT5 Data Folder]\MQL5\Include\
TelegramNotifier.mqh →  [MT5 Data Folder]\MQL5\Include\
```

> للوصول لمجلد الداتا: في MT5 → File → Open Data Folder

### 2. تفعيل WebRequest للتليغرام

MT5 → Tools → Options → Expert Advisors:
- Allow WebRequest for listed URL ✅
- أضف: `https://api.telegram.org`

### 3. إعداد تليغرام

1. أنشئ بوت جديد عبر @BotFather
2. احصل على `Bot Token`
3. احصل على `Chat ID` من @userinfobot
4. أدخلهما في إعدادات EA

### 4. تجميع وتشغيل

1. افتح MetaEditor (F4 في MT5)
2. اضغط F7 لتجميع `ForexTrustEA.mq5`
3. في MT5: سحب EA على الرسم البياني H4
4. تفعيل Auto Trading ✅

---

## الأزواج الموصى بها

| الزوج | ملاحظات |
|-------|--------|
| `XAUUSD` | الذهب — أفضل أداء، DXY معكوس |
| `EURUSD` | ليكويديتي عالية، سبريد منخفض |
| `GBPUSD` | تقلب أعلى — مناسب |
| `USDJPY` | اضبط `InpInvertDXY = false` |

---

## إعدادات Strategy Tester (Backtesting)

```
Mode:       Every tick based on real ticks
Period:     H4
Date Range: 3 سنوات على الأقل
Spread:     Current (أو 2-3 pips)
```

---

## الإعدادات الرئيسية

| الإعداد | القيمة | الوصف |
|---------|--------|-------|
| `InpTrustThreshold` | 82 | حد الدخول |
| `InpRiskPercent` | 1.0% | خطورة لكل صفقة |
| `InpSL_ATR` | 1.8 | مضاعف ATR للـ SL |
| `InpTP2_ATR` | 4.34 | مضاعف ATR لتفعيل Trailing |
| `InpTrail_ATR` | 1.0 | مضاعف ATR للـ Trailing Stop |
| `InpMaxSpreadPips` | 4.0 | أقصى سبريد مسموح |
| `InpDXYSymbol` | "DXY" | رمز Dollar Index |
| `InpTradeSell` | false | تداول بيع (معطل افتراضياً) |

---

## فلاتر السلامة المدمجة

- **فلتر الجمعة**: لا دخول بعد 20:00 UTC يوم الجمعة
- **فلتر السبريد**: يرفض الدخول إذا السبريد > الحد المحدد
- **فلتر الجلسة**: أفضل أداء في تداخل لندن/نيويورك (12:00-16:00 UTC)
- **إدارة رأس المال**: حجم الصفقة يُحسب بناءً على % الحساب وحجم الـ ATR
- **صفقة واحدة فقط**: لا يفتح صفقة جديدة إذا كانت هناك صفقة مفتوحة
- **مزامنة بعد إعادة التشغيل**: يجد الصفقة المفتوحة تلقائياً

---

## توقعات الأداء

بناءً على الاستراتيجية الأصلية (كريبتو، 3 سنوات):

| المقياس | التوقع |
|---------|--------|
| نسبة النجاح | 65-75% |
| العائد السنوي | 15-20% |
| أقصى تراجع | < 10% |
| Risk:Reward | 1:2.4 متوسط |

> **تحذير**: الفوركس يختلف عن الكريبتو. يجب إجراء Backtesting شامل قبل التداول الحقيقي.

---

## إشعارات تليغرام

| الحدث | الرسالة |
|-------|--------|
| فتح BUY | 📈 مع السعر، SL، TP1، TP2، الحجم، نقاط الثقة |
| فتح SELL | 📉 مع نفس التفاصيل |
| إغلاق رابح | ✅ مع سبب الإغلاق والربح |
| إغلاق خاسر | ❌ مع سبب الإغلاق والخسارة |
| بدء EA | ⚠️ تنبيه تشغيل |
