@echo off
rem Starts the D2R level editor server and opens it in the default browser.
cd /d "%~dp0"
start "" http://127.0.0.1:8765/
python -I server.py 8765
