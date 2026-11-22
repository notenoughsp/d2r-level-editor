@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
rem D2RLoader plugin SDK headers (folder that contains D2RLPlugin\api.h); set D2RL_SDK to override.
if not defined D2RL_SDK set "D2RL_SDK=..\third_party\PluginSDK\include"
set "SDK=%D2RL_SDK%"
rc /nologo /I "%SDK%" /fo world.res world.rc || exit /b 1
cl /nologo /std:c++20 /O2 /EHsc /MT /LD /W4 /I "%SDK%" world.cpp world.res /Fe:d2r-world.dll /link /NOLOGO
