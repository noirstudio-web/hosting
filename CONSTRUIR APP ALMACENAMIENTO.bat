@echo off
title Noir Studio - Construir app de almacenamiento
cd /d "%~dp0"
node scripts\build-agent.cjs
pause
