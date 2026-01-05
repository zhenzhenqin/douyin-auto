@echo off
title 抖音自动火花助手
echo 正在启动服务，请勿关闭此窗口...
echo 请等待浏览器自动打开...

:: 使用当前目录下的 node.exe 运行 ui.js
".\node.exe" ui.js

pause