@echo off
rem Opens the written-premium (GGWP) dashboard. It always shows the most recent CSV in inputs\ggwp-pyramid.
rem Leave the black window open while you use the dashboard; close it to stop.
cd /d "%~dp0"
set PY=python
if exist ".venv\Scripts\python.exe" set PY=".venv\Scripts\python.exe"
%PY% serve.py --open ggwp.html
if errorlevel 1 pause
