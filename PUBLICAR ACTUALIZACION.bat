@echo off
chcp 65001 >nul
title Noir Studio - Publicar actualizacion
cd /d "%~dp0"
echo.
echo   Publicar una actualizacion para el PC servidor
echo.
set /p NOTAS=  Describe los cambios (Enter para omitir): 
node scripts\publish.cjs "%NOTAS%"
pause
