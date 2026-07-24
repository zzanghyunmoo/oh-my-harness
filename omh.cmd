@echo off
setlocal
node "%~dp0dist\cli\main.js" %*
exit /b %errorlevel%
