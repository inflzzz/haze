@echo off
rem Compila o yue2.cpp com Vulkan (Radeon, Intel e NVIDIA sem CUDA), em Release com Ninja.
rem Os .exe saem em engine\yue2.cpp\build-vk.
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio Build Tools nao encontrado & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat"

if not defined VULKAN_SDK set "VULKAN_SDK=D:\VulkanSDK\1.4.363.0"
set "PATH=%ROOT%\tools\cmake\bin;C:\Program Files\CMake\bin;%ROOT%\tools\ninja;%VULKAN_SDK%\Bin;%PATH%"

if not exist "D:\_ladob\tmp" mkdir "D:\_ladob\tmp"
if not exist "D:\_ladob\yue2" mklink /J "D:\_ladob\yue2" "%ROOT%\engine\yue2.cpp"
set "TEMP=D:\_ladob\tmp"
set "TMP=D:\_ladob\tmp"

cd /d "D:\_ladob\yue2"
if exist build-vk rd /s /q build-vk
mkdir build-vk
cd build-vk

cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON || exit /b 1
cmake --build . -j %NUMBER_OF_PROCESSORS% --target yue-synth yue-transcribe yue-plan yue-tokenize || exit /b 1
