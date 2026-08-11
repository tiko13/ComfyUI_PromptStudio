@echo off
setlocal EnableExtensions

set "SETUP_DIR=%~dp0"
set "PYTHON_EXE="

for %%P in (
  "%SETUP_DIR%..\..\..\venv\Scripts\python.exe"
  "%SETUP_DIR%..\..\..\..\python_embeded\python.exe"
  "%SETUP_DIR%.runtime\python.exe"
) do if not defined PYTHON_EXE if exist "%%~fP" set "PYTHON_EXE=%%~fP"

if not defined PYTHON_EXE (
  for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined PYTHON_EXE set "PYTHON_EXE=%%~fP"
)

if not defined PYTHON_EXE (
  set "RUNTIME_DIR=%SETUP_DIR%.runtime"
  set "RUNTIME_ZIP=%TEMP%\prompt-studio-python-3.13.12.zip"
  if not exist "%SETUP_DIR%.runtime\python.exe" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop';" ^
      "$url='https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip';" ^
      "$zip=$env:TEMP+'\prompt-studio-python-3.13.12.zip';" ^
      "$expected='76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0';" ^
      "Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip;" ^
      "$actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant();" ^
      "if($actual -ne $expected){Remove-Item -LiteralPath $zip -Force; throw 'The official Python runtime checksum did not match.'};" ^
      "New-Item -ItemType Directory -Force -Path '%SETUP_DIR%.runtime' | Out-Null;" ^
      "Expand-Archive -LiteralPath $zip -DestinationPath '%SETUP_DIR%.runtime' -Force;" ^
      "Remove-Item -LiteralPath $zip -Force"
    if errorlevel 1 (
      powershell.exe -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Prompt Studio Setup could not obtain its small official Python helper. Check your internet connection and try again.','Prompt Studio Setup') | Out-Null"
      exit /b 1
    )
  )
  set "PYTHON_EXE=%SETUP_DIR%.runtime\python.exe"
)

set "PYTHON_WINDOW=%PYTHON_EXE:python.exe=pythonw.exe%"
if not exist "%PYTHON_WINDOW%" set "PYTHON_WINDOW=%PYTHON_EXE%"
start "" "%PYTHON_WINDOW%" "%SETUP_DIR%wizard.py"
exit /b 0
