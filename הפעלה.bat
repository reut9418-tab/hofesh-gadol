@echo off
rem -- Chofesh Gadol reports system launcher (ASCII only: cmd misparses Hebrew batch text) --

cd /d "%~dp0backend"
start "Chofesh - Backend" cmd /k node server.js

cd /d "%~dp0frontend"
start "Chofesh - Frontend" cmd /k node node_modules\vite\bin\vite.js

timeout /t 5 >nul
start "" http://localhost:5273
