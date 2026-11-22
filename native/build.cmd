@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /std:c++20 /O2 /EHsc /LD bitknit.cc /Fe:bitknit.dll /link /NOLOGO
