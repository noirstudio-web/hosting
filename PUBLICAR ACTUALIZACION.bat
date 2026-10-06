@echo off
chcp 65001 >nul
title Noir Studio - Publicar actualizacion
cd /d "%~dp0"
echo.
echo   Publicar una actualizacion (servidor en la nube + web)
echo.
set /p NOTAS=  Describe los cambios (Enter para omitir): 
node scripts\publish.cjs "%NOTAS%"
pause
