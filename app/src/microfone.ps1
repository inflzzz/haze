# Microfone padrão do Windows: lista os microfones, diz qual é o padrão e, se pedido, troca o padrão.
# Usado pela voz ao vivo: ao ligar, o padrão vira o cabo virtual (todos os programas ouvem a voz trocada);
# ao desligar, volta ao microfone de antes.
#
#   powershell -File microfone.ps1                      -> JSON { padrao: {id,nome}, microfones: [{id,nome}] }
#   powershell -File microfone.ps1 -Definir "<id>"      -> troca o padrão para esse id e devolve o mesmo JSON
#   powershell -File microfone.ps1 -DefinirNome "CABLE Output"   -> idem, pelo começo do nome
param([string]$Definir = "", [string]$DefinirNome = "")

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace LadoB {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] class PolicyConfigClient {}

  // Só a ordem dos métodos importa; os que não são usados ficam sem parâmetros.
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat();
    [PreserveSig] int GetDeviceFormat();
    [PreserveSig] int ResetDeviceFormat();
    [PreserveSig] int SetDeviceFormat();
    [PreserveSig] int GetProcessingPeriod();
    [PreserveSig] int SetProcessingPeriod();
    [PreserveSig] int GetShareMode();
    [PreserveSig] int SetShareMode();
    [PreserveSig] int GetPropertyValue();
    [PreserveSig] int SetPropertyValue();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
  }

  public static class Som {
    // dataFlow 1 = captura (microfones); role 0 = uso geral, 1 = multimídia, 2 = comunicação
    public static string MicrofonePadrao() {
      var e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice d;
      if (e.GetDefaultAudioEndpoint(1, 0, out d) != 0 || d == null) return "";
      string id;
      d.GetId(out id);
      return id ?? "";
    }
    public static int DefinirPadrao(string id) {
      var p = (IPolicyConfig)(new PolicyConfigClient());
      int r = 0;
      for (int papel = 0; papel < 3; papel++) { int x = p.SetDefaultEndpoint(id, papel); if (x != 0) r = x; }
      return r;
    }
  }
}
"@

# Os microfones ativos e seus nomes ficam no registro do Windows (só leitura aqui).
$raiz = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture"
$microfones = @()
foreach ($k in Get-ChildItem $raiz) {
  $p = Get-ItemProperty $k.PSPath
  if ($p.DeviceState -ne 1) { continue }
  $props = Get-ItemProperty (Join-Path $k.PSPath "Properties")
  $nome = [string]$props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  $placa = [string]$props.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
  $microfones += [pscustomobject]@{ id = "{0.0.1.00000000}." + $k.PSChildName.ToLower(); nome = "$nome ($placa)" }
}

$erro = ""
if ($DefinirNome) {
  $alvo = $microfones | Where-Object { $_.nome.StartsWith($DefinirNome, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  if ($alvo) { $Definir = $alvo.id } else { $erro = "microfone nao encontrado: $DefinirNome" }
}
if ($Definir -and -not $erro) {
  $r = [LadoB.Som]::DefinirPadrao($Definir)
  if ($r -ne 0) { $erro = "o Windows recusou a troca (codigo $r)" }
}

$idPadrao = [LadoB.Som]::MicrofonePadrao()
$padrao = $microfones | Where-Object { $_.id -eq $idPadrao.ToLower() } | Select-Object -First 1
if (-not $padrao) { $padrao = [pscustomobject]@{ id = $idPadrao; nome = "" } }

[pscustomobject]@{ padrao = $padrao; microfones = $microfones; erro = $erro } | ConvertTo-Json -Depth 4 -Compress
