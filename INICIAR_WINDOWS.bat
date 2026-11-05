@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ====================================
echo     A DOS - SIN FILTROS
 echo ====================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo No tienes Node.js instalado.
  echo Instala la version LTS desde https://nodejs.org/
  echo Reinicia esta ventana al terminar la instalacion.
  pause
  exit /b 1
)
echo Abriendo el juego en el navegador...
start "" /min cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"
echo.
echo Para jugar desde otro movil en vuestra misma WiFi,
echo consulta la guia de instalacion (README.md).
echo.
echo MANTEN ESTA VENTANA ABIERTA MIENTRAS JUGAIS.
echo.
node server.js
pause
