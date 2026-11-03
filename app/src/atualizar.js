// Atualização pelo GitHub: confere a última versão publicada e, se for mais nova, baixa o instalador,
// fecha o app, troca os arquivos do programa e abre de novo. As IAs instaladas, as configurações e
// as músicas ficam como estão (só app\, engine\ e as ferramentas pequenas são trocados).
// Numa cópia de desenvolvimento (pasta com .git) não atualiza: ali quem manda é o Git.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ROOT } = require('./config');

const REPO = 'inflzzz/haze';
const ARQUIVO = 'Haze-instalador.zip';
const TMP = path.join(ROOT, 'tools', 'tmp');

const versaoAtual = () => { try { return require('../package.json').version; } catch { return '0.0.0'; } };
const partes = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function maisNova(a, b) {
  const x = partes(a), y = partes(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
const ehDesenvolvimento = () => fs.existsSync(path.join(ROOT, '.git'));

async function verificar() {
  const atual = versaoAtual();
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'Haze', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error('o GitHub respondeu ' + r.status);
  const j = await r.json();
  const nova = String(j.tag_name || '').replace(/^v/i, '');
  const asset = (j.assets || []).find((a) => a.name === ARQUIVO);
  return {
    atual, nova, temNova: !!nova && maisNova(nova, atual), notas: String(j.body || '').slice(0, 2000),
    url: asset ? asset.browser_download_url : null, tamanho: asset ? asset.size : 0,
    desenvolvimento: ehDesenvolvimento(),
  };
}

async function baixar(url, destino, aviso) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Haze' } });
  if (!r.ok) throw new Error('download recusado (' + r.status + ')');
  const total = Number(r.headers.get('content-length')) || 0;
  let feito = 0, ultimo = 0;
  const contador = new (require('stream').Transform)({
    transform(p, _e, cb) {
      feito += p.length;
      if (Date.now() - ultimo > 500) { ultimo = Date.now(); aviso(total ? Math.round((feito / total) * 100) : 0); }
      cb(null, p);
    },
  });
  await pipeline(Readable.fromWeb(r.body), contador, fs.createWriteStream(destino));
}

// Baixa, confere e deixa pronto o script que troca os arquivos depois que o app fechar.
// Devolve o caminho do script; quem chama abre o script e fecha o app.
async function preparar(aviso) {
  if (ehDesenvolvimento()) throw new Error('Esta é a cópia de desenvolvimento (tem .git): atualize pelo Git.');
  const v = await verificar();
  if (!v.temNova) throw new Error('Você já está na versão mais nova (' + v.atual + ').');
  if (!v.url) throw new Error('A versão ' + v.nova + ' não tem o arquivo ' + ARQUIVO + '.');
  fs.mkdirSync(TMP, { recursive: true });
  const zip = path.join(TMP, 'atualizacao.zip');
  const pasta = path.join(TMP, 'atualizacao');
  fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(pasta, { recursive: true });
  aviso('baixando a versão ' + v.nova + '…');
  await baixar(v.url, zip, (pct) => aviso(`baixando a versão ${v.nova}: ${pct}%`));
  aviso('abrindo o pacote…');
  await new Promise((resolve, reject) => {
    const p = spawn('C:\\Windows\\System32\\tar.exe', ['-xf', zip, '-C', pasta], { windowsHide: true });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('não consegui abrir o pacote'))));
    p.on('error', reject);
  });
  const novo = path.join(pasta, 'Haze');
  if (!fs.existsSync(path.join(novo, 'app', 'main.js'))) throw new Error('o pacote baixado está incompleto');

  const electron = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
  const ps = path.join(TMP, 'atualizar.ps1');
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  fs.writeFileSync(ps, '\ufeff' + [
    '$ErrorActionPreference = "Continue"',
    `$alvo = ${q(process.pid)}`,
    'for ($i = 0; $i -lt 120 -and (Get-Process -Id $alvo -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }',
    'Start-Sleep -Seconds 1',
    // app\ espelhado (sai o que a versão nova não tem); engine e ferramentas só recebem os arquivos novos
    `robocopy ${q(path.join(novo, 'app'))} ${q(path.join(ROOT, 'app'))} /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`,
    `robocopy ${q(path.join(novo, 'engine'))} ${q(path.join(ROOT, 'engine'))} /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`,
    `robocopy ${q(path.join(novo, 'tools'))} ${q(path.join(ROOT, 'tools'))} /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`,
    `Start-Process ${q(electron)} -ArgumentList '.' -WorkingDirectory ${q(path.join(ROOT, 'app'))}`,
    `Remove-Item -Recurse -Force ${q(pasta)}, ${q(zip)} -ErrorAction SilentlyContinue`,
  ].join('\r\n'));
  return ps;
}

// O script nasce pelo WMI: assim ele não é filho do app e não morre quando o app fecha
// (um filho "detached" comum ainda pode ser fechado junto, se o app estiver dentro de um grupo de processos).
function rodarDepoisDeFechar(ps) {
  const linha = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps}"`;
  const cmd = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${linha.replace(/'/g, "''")}' } | Out-Null`;
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true, stdio: 'ignore' });
    p.on('close', resolve);
    p.on('error', () => {
      spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      resolve();
    });
  });
}

module.exports = { verificar, preparar, rodarDepoisDeFechar, versaoAtual, maisNova };
