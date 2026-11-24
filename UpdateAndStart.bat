@echo off
setlocal
pushd "%~dp0" || exit /b 1
node launcher\update-personal.mjs
if errorlevel 1 goto failed
set "NODE_ENV=production"
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
if errorlevel 1 goto failed
node server.js %*
set "result=%errorlevel%"
popd
exit /b %result%
:failed
echo Update stopped. Review the message above.
popd
exit /b 1
