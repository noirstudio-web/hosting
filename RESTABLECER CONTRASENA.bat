@echo off
title Noir Studio - Restablecer contrasena
cd /d "%~dp0"
node server.js --reset-password
pause
