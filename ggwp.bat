@echo off
rem Opens the written-premium (GGWP) dashboard. It always shows the most recent Underwriting Report workbook
rem in inputs\ggwp-pyramid. Leave the black window open while you use the dashboard; close it to stop.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating a private Python environment ^(first run only^)...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :fail
)
".venv\Scripts\python.exe" serve.py --open ggwp.html
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Something went wrong - see the message above.
pause
exit /b 1
