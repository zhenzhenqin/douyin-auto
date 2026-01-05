@echo off
title 环境初始化
echo ==========================================
echo 正在为你下载必要的浏览器组件...
echo 这可能需要几分钟，取决于你的网速。
echo 请耐心等待，直到看到 "Done" 或 "完成" 字样。
echo ==========================================

:: 使用自带的 node 强制运行 playwright 安装命令
".\node.exe" ".\node_modules\playwright-core\cli.js" install chromium

echo.
echo ==========================================
echo 环境安装完成！现在你可以去点击 "启动程序.bat" 了。
echo ==========================================
pause