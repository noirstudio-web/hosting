@echo off
title Noir Studio - Hosting (solo red local)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\iniciar.ps1" -SoloLocal
if errorlevel 1 pause
