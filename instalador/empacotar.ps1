# Monta o pacote para outro PC: só o app, o motor (Vulkan) e as ferramentas pequenas.
# Nada pessoal entra (configurações, saída, modelos de voz, anotações). As IAs são baixadas pelo app.
# Uso: powershell -File instalador\empacotar.ps1 [-Saida D:\Haze-pacote]
param([string]$Saida = 'D:\Haze-pacote')
$ErrorActionPreference = 'Stop'
$raiz = Split-Path $PSScriptRoot -Parent
$alvo = Join-Path $Saida 'Haze'

if (Test-Path $Saida) { Remove-Item -Recurse -Force $Saida }
New-Item -ItemType Directory -Force $alvo | Out-Null

function Copiar($de, $para, [string[]]$arquivos = @('*'), [string[]]$fora = @()) {
  $lista = @($de, $para) + $arquivos + @('/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($fora.Count) { $lista += '/XF'; $lista += $fora }
  & robocopy @lista | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "falhou ao copiar $de" }
}

Write-Host 'app...'
Copiar (Join-Path $raiz 'app') (Join-Path $alvo 'app') @('*') @('diag-test.js', 'test-cli.js', 'lado-b.ico')

Write-Host 'motor (Vulkan)...'
$vk = Join-Path $raiz 'engine\yue2.cpp\build-vk'
$vkAlvo = Join-Path $alvo 'engine\yue2.cpp\build-vk'
New-Item -ItemType Directory -Force $vkAlvo | Out-Null
Get-ChildItem "$vk\*" -File -Include 'yue-*.exe', '*.dll' | Copy-Item -Destination $vkAlvo
$wh = Join-Path $raiz 'engine\whisper.cpp\build-vk\bin\Release'
$whAlvo = Join-Path $alvo 'engine\whisper.cpp\build-vk\bin\Release'
New-Item -ItemType Directory -Force $whAlvo | Out-Null
Get-ChildItem "$wh\*" -File -Include 'whisper-cli.exe', '*.dll' | Copy-Item -Destination $whAlvo

Write-Host 'ferramentas...'
foreach ($par in @(@('tools\ffmpeg\bin', @('ffmpeg.exe', 'ffprobe.exe')), @('tools\yt-dlp', @('yt-dlp.exe')), @('tools\uv', @('uv.exe')))) {
  $d = Join-Path $alvo $par[0]
  New-Item -ItemType Directory -Force $d | Out-Null
  foreach ($a in $par[1]) { Copy-Item (Join-Path (Join-Path $raiz $par[0]) $a) $d }
}
Copy-Item (Join-Path $raiz 'LICENSE') $alvo -ErrorAction SilentlyContinue

Copy-Item (Join-Path $PSScriptRoot 'instalar.ps1') $Saida
Copy-Item (Join-Path $PSScriptRoot 'Instalar Haze.cmd') $Saida

$zip = Join-Path (Split-Path $Saida -Parent) 'Haze-instalador.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Write-Host 'compactando...'
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C $Saida 'Instalar Haze.cmd' 'instalar.ps1' 'Haze'
if ($LASTEXITCODE) { throw 'falhou ao compactar' }
'{0}  {1:N0} MB' -f $zip, ((Get-Item $zip).Length / 1MB)
