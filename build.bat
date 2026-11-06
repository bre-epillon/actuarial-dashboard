@echo off
rem Builds the data files from the Excel inputs, then opens the Explorer.
rem Put the two workbooks in inputs\ and check sources.json first (see README).
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating a private Python environment ^(first run only^)...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :fail
)
echo Building the datasets ^(about 30 seconds^)...
".venv\Scripts\python.exe" recon.py build %* || goto :fail
echo.
echo Done. Opening the Explorer - the Reconciliation tool is linked at the top right.
start "" "%~dp0explorer.html"
exit /b 0
:fail
echo.
echo Something went wrong - see the message above.
pause
exit /b 1
