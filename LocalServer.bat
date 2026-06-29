@echo off
start "" py -m http.server 5500
timeout /t 1 >nul
start "" http://localhost:5500