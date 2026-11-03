@echo off
rem Compila o yue2.cpp com CUDA usando o toolkit portátil da pasta tools (nada é instalado no C:).
rem O nvcc falha calado com espaço no caminho, então tudo passa por atalhos (junctions) em D:\_ladob.
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio Build Tools nao encontrado & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat"

if not exist "D:\_ladob\tmp" mkdir "D:\_ladob\tmp"
if not exist "D:\_ladob\cuda" mklink /J "D:\_ladob\cuda" "%ROOT%\tools\cuda\13.4"
if not exist "D:\_ladob\yue2" mklink /J "D:\_ladob\yue2" "%ROOT%\engine\yue2.cpp"

set "CUDA_HOME=D:\_ladob\cuda"
set "CUDA_PATH=%CUDA_HOME%"
set "CUDACXX=%CUDA_HOME%\bin\nvcc.exe"
set "PATH=%ROOT%\tools\cmake\bin;C:\Program Files\CMake\bin;%ROOT%\tools\ninja;%CUDA_HOME%\bin;%CUDA_HOME%\bin\x64;%PATH%"
set "TEMP=D:\_ladob\tmp"
set "TMP=D:\_ladob\tmp"

cd /d "D:\_ladob\yue2"
if exist build-cuda rd /s /q build-cuda
mkdir build-cuda
cd build-cuda

cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=native -DCUDAToolkit_ROOT=%CUDA_HOME% || exit /b 1
cmake --build . -j %NUMBER_OF_PROCESSORS% --target yue-synth yue-transcribe yue-plan yue-tokenize || exit /b 1
