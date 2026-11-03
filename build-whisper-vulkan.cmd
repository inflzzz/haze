@echo off
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio Build Tools nao encontrado & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat"

if not defined VULKAN_SDK set "VULKAN_SDK=D:\VulkanSDK\1.4.363.0"
set "PATH=%ROOT%\tools\cmake\bin;C:\Program Files\CMake\bin;%VULKAN_SDK%\Bin;%PATH%"
cd /d "%ROOT%\engine\whisper.cpp"
if not exist build-vk mkdir build-vk
cd build-vk
cmake .. -G "Visual Studio 17 2022" -A x64 -DGGML_VULKAN=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON || exit /b 1
cmake --build . --config Release -j %NUMBER_OF_PROCESSORS% --target whisper-cli || exit /b 1
