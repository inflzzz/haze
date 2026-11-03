# Instalador do Haze: copia o app para uma pasta, cria os atalhos e abre o app.
# As IAs não vêm aqui: cada uma é baixada pelo próprio app, na aba Instalar, na versão certa pra placa de vídeo.
$ErrorActionPreference = 'Stop'
# qualquer erro aparece na tela e espera o Enter, em vez de a janela sumir
trap {
  Write-Host ''
  Write-Host ('Deu erro: ' + $_.Exception.Message) -ForegroundColor Red
  Read-Host 'Enter para sair'
  exit 1
}
$origem = Join-Path $PSScriptRoot 'Haze'

Write-Host ''
Write-Host '  H A Z E   -  instalador' -ForegroundColor Magenta
Write-Host ''
if (-not (Test-Path (Join-Path $origem 'app\main.js'))) {
  Write-Host 'Não achei a pasta "Haze" ao lado deste instalador. Extraia o .zip inteiro antes de rodar.' -ForegroundColor Red
  Read-Host 'Enter para sair'; exit 1
}

$padrao = 'C:\Haze'
Write-Host 'As IAs ocupam bastante espaço (até ~30 GB com tudo). Prefira um SSD.'
$destino = Read-Host "Onde instalar? (Enter = $padrao, ou digite outra pasta, ex.: D:\Haze)"
if ([string]::IsNullOrWhiteSpace($destino)) { $destino = $padrao }
$destino = $destino.Trim().Trim('"')

Write-Host ''
Write-Host "Copiando para $destino ..."
New-Item -ItemType Directory -Force $destino | Out-Null
& robocopy $origem $destino /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host 'A cópia falhou.' -ForegroundColor Red; Read-Host 'Enter para sair'; exit 1 }

# O PyTorch precisa do Visual C++ da Microsoft; a maioria dos PCs já tem.
if (-not (Test-Path "$env:SystemRoot\System32\vcruntime140_1.dll")) {
  Write-Host 'Instalando o Visual C++ da Microsoft (o Windows vai pedir permissão)...'
  $vc = Join-Path $env:TEMP 'vc_redist.x64.exe'
  Invoke-WebRequest -UseBasicParsing 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $vc
  Start-Process $vc -ArgumentList '/install', '/passive', '/norestart' -Wait
}

$exe = Join-Path $destino 'app\node_modules\electron\dist\electron.exe'
$icone = Join-Path $destino 'app\haze.ico'
$shell = New-Object -ComObject WScript.Shell
$lugares = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))
foreach ($pasta in $lugares) {
  $lnk = $shell.CreateShortcut((Join-Path $pasta 'Haze.lnk'))
  $lnk.TargetPath = $exe
  $lnk.Arguments = '.'
  $lnk.WorkingDirectory = Join-Path $destino 'app'
  $lnk.IconLocation = $icone
  $lnk.Description = 'Haze: música e voz com IA'
  $lnk.Save()
}

Write-Host ''
Write-Host 'Pronto! O atalho "Haze" está na área de trabalho.' -ForegroundColor Green
Write-Host 'Na primeira vez o app abre na aba Instalar: escolha o que quer usar e ele baixa o resto.'
Start-Process $exe -ArgumentList '.' -WorkingDirectory (Join-Path $destino 'app')
Start-Sleep -Seconds 3
