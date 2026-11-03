@echo off
cd /d "%~dp0"
if not exist "%~dp0instalar.ps1" (
  echo.
  echo   Primeiro extraia o .zip inteiro:
  echo   clique com o botao direito em Haze-instalador.zip e escolha "Extrair tudo...".
  echo   Depois abra a pasta extraida e de dois cliques em "Instalar Haze.cmd".
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
if errorlevel 1 pause
