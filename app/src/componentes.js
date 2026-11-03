// Instalação por partes: o app vem só com o básico e cada função baixa o que precisa quando o usuário pede.
// A placa de vídeo decide qual PyTorch entra em cada ambiente:
//   NVIDIA RTX 50 -> CUDA 12.8 | outras NVIDIA -> CUDA 12.6
//   Radeon RX 7000 / 780M (RDNA3) e RX 9000 (RDNA4) -> ROCm da AMD (versão de teste, sem garantia)
//   o resto, ou se a placa falhar no teste -> processador (mais lento, mas funciona)
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { ROOT, paths, models, separator } = require('./config');

const UV = path.join(ROOT, 'tools', 'uv', 'uv.exe');
const ESTADO = path.join(ROOT, '.dados-app', 'componentes.json');
const TMP = path.join(ROOT, 'tools', 'tmp');

const TORCH = {
  cu128: 'https://download.pytorch.org/whl/cu128',
  cu126: 'https://download.pytorch.org/whl/cu126',
  cpu: 'https://download.pytorch.org/whl/cpu',
};
const ROCM = {
  gfx110X: 'https://rocm.nightlies.amd.com/v2/gfx110X-all/',
  gfx120X: 'https://rocm.nightlies.amd.com/v2/gfx120X-all/',
};
const APPLIO_VERSAO = '3.6.4';
const HF_YUE = 'https://huggingface.co/Serveurperso/YuE2-GGUF/resolve/main/';

// ---------- placa de vídeo ----------

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, out) => resolve(err ? '' : String(out || '')));
  });
}

let placaCache = null;
async function detectarPlaca(forcar) {
  if (placaCache && !forcar) return placaCache;
  const nomes = (await sh('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }']))
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const nv = (await sh('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader,nounits'])).trim();
  let p;
  // HAZE_PLACA=cpu força o processador (para testar ou se a placa der problema)
  if (process.env.HAZE_PLACA === 'cpu') {
    p = { nome: nomes[0] || 'não encontrada', fabricante: 'outra', backend: 'cpu', modo: 'Processador (forçado)' };
  } else if (nv) {
    const [nome, mem, cap] = nv.split('\n')[0].split(',').map((s) => s.trim());
    const cc = parseFloat(cap) || 0;
    p = { nome, fabricante: 'nvidia', vramGB: Math.round((parseInt(mem, 10) || 0) / 1024),
      backend: cc >= 12 ? 'cu128' : 'cu126', modo: 'Placa NVIDIA (CUDA)' };
  } else {
    const amd = nomes.find((n) => /radeon|amd/i.test(n));
    let familia = null;
    if (amd && /RX\s*7\d{3}|Radeon\s*7[4-9]0M/i.test(amd)) familia = 'gfx110X';
    else if (amd && /RX\s*9\d{3}/i.test(amd)) familia = 'gfx120X';
    if (familia) {
      p = { nome: amd, fabricante: 'amd', backend: 'rocm', rocm: ROCM[familia],
        modo: 'Placa AMD (ROCm, versão de teste)' };
    } else {
      p = { nome: amd || nomes[0] || 'não encontrada', fabricante: amd ? 'amd' : 'outra', backend: 'cpu',
        modo: 'Processador (mais lento)' };
    }
  }
  p.todas = nomes;
  placaCache = p;
  return p;
}

// ---------- estado ----------

function lerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; }
}
function gravarEstado(id, dados) {
  const e = lerEstado();
  e[id] = { ...dados, quando: new Date().toISOString() };
  fs.mkdirSync(path.dirname(ESTADO), { recursive: true });
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2));
}

// ---------- execução ----------

let atual = null;   // { child, cancelado }

function ambiente(extra = {}) {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    UV_PYTHON_INSTALL_DIR: path.join(ROOT, 'tools', 'python'),
    UV_CACHE_DIR: path.join(ROOT, 'tools', 'uv-cache'),
    UV_HTTP_TIMEOUT: '300', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', ...extra };
  return env;
}

function rodar(log, cmd, args, { cwd, env } = {}) {
  if (atual && atual.cancelado) return Promise.reject(new Error('Cancelado.'));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env || ambiente(), windowsHide: true });
    if (atual) atual.child = child;
    const fim = [];
    let buf = '';
    const feed = (c) => {
      buf += c.toString('utf8');
      const partes = buf.split(/[\r\n]+/);
      buf = partes.pop();
      for (const l of partes) {
        if (!l.trim()) continue;
        log(l);
        fim.push(l);
        if (fim.length > 12) fim.shift();
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => reject(new Error(`não consegui abrir ${path.basename(cmd)}: ${e.message}`)));
    child.on('close', (code) => {
      if (atual) atual.child = null;
      if (atual && atual.cancelado) return reject(new Error('Cancelado.'));
      if (code !== 0) return reject(new Error(`${path.basename(cmd)} falhou (código ${code}).\n${fim.slice(-6).join('\n')}`));
      resolve(fim);
    });
  });
}

async function baixar(log, url, destino) {
  if (fs.existsSync(destino) && fs.statSync(destino).size > 0) { log('já baixado: ' + path.basename(destino)); return; }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const parte = destino + '.parte';
  const ctrl = new AbortController();
  if (atual) atual.abortar = () => ctrl.abort();
  const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
  if (!r.ok) throw new Error(`download recusado (${r.status}): ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const mb = (b) => (b / 1048576).toFixed(0) + ' MB';
  let feito = 0;
  let ultimo = 0;
  const contador = new Transform({
    transform(pedaco, _e, cb) {
      feito += pedaco.length;
      const agora = Date.now();
      if (agora - ultimo > 1500) {
        ultimo = agora;
        log(`baixando ${path.basename(destino)}: ${mb(feito)}${total ? ' de ' + mb(total) + ` (${Math.round((feito / total) * 100)}%)` : ''}`);
      }
      cb(null, pedaco);
    },
  });
  await pipeline(Readable.fromWeb(r.body), contador, fs.createWriteStream(parte));
  fs.renameSync(parte, destino);
  log(`baixado: ${path.basename(destino)} (${mb(feito)})`);
}

// ---------- Python ----------

const pyDe = (env) => path.join(env, 'Scripts', 'python.exe');

async function criarAmbiente(log, dir, versao) {
  log(`Preparando o Python ${versao} em ${path.basename(dir)}…`);
  await rodar(log, UV, ['venv', '--managed-python', '--python', versao, '--allow-existing', dir]);
  return pyDe(dir);
}

function pip(log, py, args) {
  return rodar(log, UV, ['pip', 'install', '--python', py, ...args]);
}

// Testa se o PyTorch enxerga a placa e faz uma conta nela.
const TESTE_GPU = [
  'import torch',
  'assert torch.cuda.is_available(), "a placa não apareceu para o PyTorch"',
  'x = torch.randn(256, 256, device="cuda")',
  'print("placa ok:", torch.cuda.get_device_name(0), float((x @ x).sum()))',
].join('\n');

// Instala o PyTorch certo para a placa. Se a placa falhar no teste, troca pelo de processador.
// Devolve o backend que ficou ('cu128' | 'cu126' | 'rocm' | 'cpu').
async function instalarTorch(log, py, placa, pacotes) {
  const indice = placa.backend === 'rocm' ? placa.rocm : TORCH[placa.backend];
  log(`Instalando o PyTorch (${placa.modo})…`);
  try {
    await pip(log, py, ['--extra-index-url', indice, ...pacotes]);
    if (placa.backend === 'cpu') return 'cpu';
    await rodar(log, py, ['-c', TESTE_GPU]);
    return placa.backend;
  } catch (e) {
    if (/Cancelado/.test(e.message) || placa.backend === 'cpu') throw e;
    log('A placa não funcionou com o PyTorch (' + e.message.split('\n')[0] + ').');
    log('Trocando pela versão de processador: funciona em qualquer PC, só que mais devagar.');
    await pip(log, py, ['--reinstall-package', 'torch', '--extra-index-url', TORCH.cpu, ...pacotes]);
    return 'cpu';
  }
}

// ---------- o que cada função precisa ----------

const sepEnv = path.join(ROOT, 'sep-env');
const ttsEnv = path.join(ROOT, 'tts-env');
const cloneEnv = path.join(ROOT, 'clone-env');
const existe = (...fs_) => fs_.every((f) => f && fs.existsSync(f));

const MODELOS_YUE = [
  [models.backbone, HF_YUE + 'YuE2-3B-Q8_0.gguf'],
  [models.vae, HF_YUE + 'YuE2-Vae-F32.gguf'],
  [models.sheetsage, HF_YUE + 'SheetSage2-Q8_0.gguf'],
  [models.mert, HF_YUE + 'MERT-v2-FullSong-Q8_0.gguf'],
  [models.tokenizer, HF_YUE + 'yue2-mothersuperior-realaudio-tokenizer-v4-Q8_0.gguf'],
  [models.whisper, 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'],
];

const COMPONENTES = [
  {
    id: 'separar',
    nome: 'Separar voz e instrumental',
    desc: 'Tira a voz da música, limpa eco e coro. Precisa disto para trocar a voz de uma música e para o karaokê.',
    tamanho: '4 a 7 GB',
    instalado: () => existe(paths.separator, path.join(paths.separatorModelsDir, separator.model)),
    async instalar(log, placa) {
      const py = await criarAmbiente(log, sepEnv, '3.12');
      const backend = await instalarTorch(log, py, placa, ['torch', 'torchvision']);
      log('Instalando o separador e as ferramentas de áudio…');
      await pip(log, py, [backend.startsWith('cu') ? 'audio-separator[gpu]' : 'audio-separator[cpu]',
        'audioread', 'pedalboard', 'sounddevice', 'librosa', 'soundfile', 'scipy', 'psutil']);
      for (const m of [separator.model, separator.vocalModel, separator.ecoModel, separator.coroModel, 'htdemucs_6s.yaml']) {
        log('Baixando o modelo de separação ' + m + '…');
        await rodar(log, paths.separator, ['--model_filename', m, '--model_file_dir', paths.separatorModelsDir, '--download_model_only']);
      }
      return backend;
    },
  },
  {
    id: 'applio',
    nome: 'Trocar voz (Applio)',
    desc: 'Põe a voz de um modelo RVC na música, na fala e na voz ao vivo. Instala o Applio dentro da pasta do app.',
    tamanho: '5 a 8 GB',
    pesadoNoProcessador: false,
    instalado: (ctx) => existe(path.join(ctx.applioDir || '', 'core.py')) && existe(require('./config').applioPython(ctx.applioDir)),
    async instalar(log, placa, ctx) {
      const dir = path.join(ROOT, 'Applio');
      if (!existe(path.join(dir, 'core.py'))) {
        const zip = path.join(TMP, `applio-${APPLIO_VERSAO}.zip`);
        await baixar(log, `https://github.com/IAHispano/Applio/archive/refs/tags/${APPLIO_VERSAO}.zip`, zip);
        log('Abrindo o pacote do Applio…');
        const aberto = path.join(TMP, 'applio-aberto');
        fs.rmSync(aberto, { recursive: true, force: true });
        fs.mkdirSync(aberto, { recursive: true });
        await rodar(log, 'C:\\Windows\\System32\\tar.exe', ['-xf', zip, '-C', aberto]);
        const raiz = fs.readdirSync(aberto).map((n) => path.join(aberto, n)).find((p) => existe(path.join(p, 'core.py')));
        if (!raiz) throw new Error('o pacote do Applio veio sem o core.py');
        fs.mkdirSync(dir, { recursive: true });
        for (const n of fs.readdirSync(raiz)) fs.renameSync(path.join(raiz, n), path.join(dir, n));
        fs.rmSync(aberto, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
      }
      const py = await criarAmbiente(log, path.join(dir, 'env'), '3.12');
      const backend = await instalarTorch(log, py, placa, ['torch', 'torchaudio']);
      log('Instalando o que o Applio precisa…');
      const req = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8').split(/\r?\n/)
        .filter((l) => !/^\s*(torch|torchaudio)\s*[=<>~!]/i.test(l)).join('\n');
      const reqTmp = path.join(TMP, 'applio-requisitos.txt');
      fs.mkdirSync(TMP, { recursive: true });
      fs.writeFileSync(reqTmp, req);
      await pip(log, py, ['-r', reqTmp]);
      log('Baixando os modelos básicos do Applio (voz, tom)…');
      await rodar(log, py, ['core.py', 'prerequisites', '--pretraineds_hifigan', 'False', '--models', 'True', '--exe', 'True'], { cwd: dir });
      ctx.usarApplio(dir);
      return backend;
    },
  },
  {
    id: 'kokoro',
    nome: 'Fala com voz pronta',
    desc: 'Lê um texto com vozes prontas (português, inglês e outras). Leve: roda bem até sem placa de vídeo.',
    tamanho: '0,5 GB',
    instalado: () => existe(paths.ttsPython, models.kokoro, models.kokoroVozes),
    async instalar(log) {
      const py = await criarAmbiente(log, ttsEnv, '3.12');
      await pip(log, py, ['kokoro-onnx', 'soundfile']);
      const base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/';
      await baixar(log, base + 'kokoro-v1.0.onnx', models.kokoro);
      await baixar(log, base + 'voices-v1.0.bin', models.kokoroVozes);
      return 'cpu';
    },
  },
  {
    id: 'clone',
    nome: 'Fala com voz clonada',
    desc: 'Lê um texto com a voz e o jeito de falar de uma gravação sua de 10 a 20 segundos (Chatterbox).',
    tamanho: '6 a 9 GB',
    pesadoNoProcessador: true,
    instalado: () => existe(paths.clonePython, path.join(models.chatterboxDir, 'hub', 'models--ResembleAI--chatterbox')),
    async instalar(log, placa) {
      const py = await criarAmbiente(log, cloneEnv, '3.11');
      const backend = await instalarTorch(log, py, placa, ['torch', 'torchaudio']);
      log('Instalando o Chatterbox…');
      // o Chatterbox pede torch 2.6 fixo; entra sem as dependências e elas vêm à parte, com o torch já instalado
      await pip(log, py, ['--no-deps', 'chatterbox-tts==0.1.7']);
      await pip(log, py, ['numpy<2', 'librosa==0.11.0', 's3tokenizer', 'transformers==5.2.0', 'diffusers==0.29.0',
        'resemble-perth>=1.0.0', 'conformer==0.3.2', 'safetensors==0.5.3', 'spacy-pkuseg', 'pykakasi==2.3.0',
        'pyloudnorm', 'omegaconf', 'soundfile', 'huggingface_hub', 'setuptools<81']);
      log('Baixando o modelo de voz em inglês (~3 GB; os outros idiomas baixam no primeiro uso)…');
      fs.mkdirSync(models.chatterboxDir, { recursive: true });
      await rodar(log, py, ['-c', 'from huggingface_hub import snapshot_download as s; '
        + 's("ResembleAI/chatterbox", allow_patterns=["ve.safetensors","t3_cfg.safetensors","s3gen.safetensors","tokenizer.json","conds.pt"]); print("ok")'],
      { env: ambiente({ HF_HOME: models.chatterboxDir }) });
      return backend;
    },
  },
  {
    id: 'motor',
    nome: 'Gravar música com IA (YuE2)',
    desc: 'Regravar, Criar e Continuar na Mesa: o motor compõe e canta. Inclui o Whisper, que tira a letra da música.',
    tamanho: '5,7 GB',
    instalado: () => existe(paths.yueSynth, ...MODELOS_YUE.map(([f]) => f)),
    async instalar(log) {
      if (!existe(paths.yueSynth)) throw new Error('o motor (yue-synth.exe) não veio no pacote do app');
      for (const [arq, url] of MODELOS_YUE) await baixar(log, url, arq);
      return 'vulkan';
    },
  },
];

// ---------- API para o main ----------

async function estado(ctx) {
  const placa = await detectarPlaca();
  const est = lerEstado();
  return {
    placa,
    itens: COMPONENTES.map((c) => ({
      id: c.id, nome: c.nome, desc: c.desc, tamanho: c.tamanho,
      instalado: !!c.instalado(ctx), backend: (est[c.id] || {}).backend || null,
      lento: !!c.pesadoNoProcessador && placa.backend === 'cpu',
    })),
  };
}

// Instala na ordem; aviso({ id, linha } | { id, fim:'ok'|'erro'|'cancelado', erro }).
async function instalar(ids, ctx, aviso) {
  if (atual) throw new Error('Já tem uma instalação rodando.');
  if (!fs.existsSync(UV)) throw new Error('Falta o instalador de Python (tools\\uv\\uv.exe).');
  atual = { child: null, cancelado: false };
  const placa = await detectarPlaca();
  fs.mkdirSync(TMP, { recursive: true });
  try {
    for (const id of ids) {
      const c = COMPONENTES.find((x) => x.id === id);
      if (!c) continue;
      const log = (linha) => aviso({ id, linha });
      log(`=== ${c.nome} — ${placa.nome} → ${placa.modo}`);
      try {
        const backend = await c.instalar(log, placa, ctx);
        gravarEstado(id, { backend, placa: placa.nome });
        aviso({ id, fim: 'ok', backend });
      } catch (e) {
        const cancelado = atual.cancelado;
        aviso({ id, fim: cancelado ? 'cancelado' : 'erro', erro: e.message });
        if (cancelado) break;
      }
    }
  } finally {
    atual = null;
  }
}

function cancelar() {
  if (!atual) return;
  atual.cancelado = true;
  if (atual.abortar) try { atual.abortar(); } catch {}
  if (atual.child && atual.child.pid) spawn('taskkill', ['/pid', String(atual.child.pid), '/T', '/F'], { windowsHide: true });
}

module.exports = { detectarPlaca, estado, instalar, cancelar, COMPONENTES };
