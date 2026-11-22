@echo off
rem Builds D2REditor.exe (the editor launcher).
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
rc /nologo /fo launcher.res launcher.rc || exit /b 1
cl /nologo /utf-8 /std:c++20 /O2 /EHsc /MT /W4 /DUNICODE /D_UNICODE launcher.cpp launcher.res /Fe:D2REditor.exe /link /NOLOGO /SUBSYSTEM:WINDOWS user32.lib shell32.lib ole32.lib advapi32.lib ws2_32.lib gdi32.lib
