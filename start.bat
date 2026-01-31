@echo off
chcp 65001 >nul
echo.
echo ╔════════════════════════════════════════════╗
echo ║   HidenCloud 本地自动续期脚本 v2.0        ║
echo ╚════════════════════════════════════════════╝
echo.
echo 正在启动脚本...
echo.

node win_login.js
node local_renew.js

echo.
echo 按任意键退出...
pause >nul
