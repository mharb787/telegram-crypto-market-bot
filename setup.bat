@echo off
echo.
echo ====================================
echo   TRC20 Bot - اعداد تلقائي
echo ====================================
echo.

:: Create .env file with bot token
echo TELEGRAM_BOT_TOKEN=7866127531:AAEs-lIuFHGPxRZYEqfdt28aV8kSEjRcdw4 > .env
echo LOG_LEVEL=info >> .env
echo.
echo [1/3] تم انشاء ملف .env

:: Install dependencies
echo [2/3] جاري تثبيت المكتبات...
call npm install
echo.

echo [3/3] تم الاعداد بنجاح!
echo.
echo لتشغيل البوت اكتب:
echo    npm start
echo.
pause
