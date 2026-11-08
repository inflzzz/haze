const path = require('path');
const fs = require('fs');

// Nome do programa: troque só aqui.
const APP_NAME = 'Haze';

// Raiz do projeto: pasta que contém engine\, models\, sep-env\ e saida\.
const ROOT = process.env.MEUCOVER_ROOT || path.resolve(__dirname, '..', '..');

// Motor: CUDA na placa NVIDIA (medido 10x mais rápido que Vulkan em música longa na RTX 5060),
// Vulkan no resto (Radeon, Intel). MEUCOVER_MOTOR=vulkan força o Vulkan.
const cudaDir = path.join(ROOT, 'engine', 'yue2.cpp', 'build-cuda');
// build-vk com Ninja põe os .exe na raiz da pasta; o build antigo (Visual Studio) punha em Release
const vulkanDir = [path.join(ROOT, 'engine', 'yue2.cpp', 'build-vk'), path.join(ROOT, 'engine', 'yue2.cpp', 'build-vk', 'Release')]
  .find((d) => fs.existsSync(path.join(d, 'yue-synth.exe'))) || path.join(ROOT, 'engine', 'yue2.cpp', 'build-vk');
const cudaLibs = path.join(ROOT, 'tools', 'cuda', '13.4', 'bin', 'x64');
const temNvidia = fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvcuda.dll'));
const motor = process.env.MEUCOVER_MOTOR !== 'vulkan' && temNvidia
  && fs.existsSync(path.join(cudaDir, 'yue-synth.exe')) && fs.existsSync(path.join(cudaLibs, 'cudart64_13.dll'))
  ? 'cuda' : 'vulkan';
const motorDir = motor === 'cuda' ? cudaDir : vulkanDir;
// pastas que precisam estar no PATH dos programas do motor (DLLs do CUDA)
const extraPath = motor === 'cuda' ? [cudaLibs] : [];

const paths = {
  root: ROOT,
  ytdlp: 'yt-dlp',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  yueSynth: path.join(motorDir, 'yue-synth.exe'),
  yueTranscribe: path.join(motorDir, 'yue-transcribe.exe'),
  yuePlan: path.join(motorDir, 'yue-plan.exe'),
  yueTokenize: path.join(motorDir, 'yue-tokenize.exe'),
  whisper: path.join(ROOT, 'engine', 'whisper.cpp', 'build-vk', 'bin', 'Release', 'whisper-cli.exe'),
  separator: path.join(ROOT, 'sep-env', 'Scripts', 'audio-separator.exe'),
  sepPython: path.join(ROOT, 'sep-env', 'Scripts', 'python.exe'),
  tomScript: path.join(__dirname, 'tom.py'),
  emendarScript: path.join(__dirname, 'emendar.py'),
  acabamentoScript: path.join(__dirname, 'acabamento.py'),
  aoVivoScript: path.join(__dirname, 'aovivo.py'),
  karaokeScript: path.join(__dirname, 'karaoke.py'),
  karaokeAnalise: path.join(__dirname, 'karaoke_analise.py'),
  midiScript: path.join(__dirname, 'midi.py'),
  formanteScript: path.join(__dirname, 'formante.py'),
  ttsPython: path.join(ROOT, 'tts-env', 'Scripts', 'python.exe'),
  falarScript: path.join(__dirname, 'falar.py'),
  // fala com a voz clonada (Chatterbox), em ambiente próprio: precisa de outro torch que o tts-env
  clonePython: path.join(ROOT, 'clone-env', 'Scripts', 'python.exe'),
  clonarScript: path.join(__dirname, 'clonar.py'),
  modelsDir: path.join(ROOT, 'models'),
  separatorModelsDir: path.join(ROOT, 'models', 'separator'),
  outDir: path.join(ROOT, 'saida'),
};

const models = {
  backbone: path.join(paths.modelsDir, 'YuE2-3B-Q8_0.gguf'),
  vae: path.join(paths.modelsDir, 'YuE2-Vae-F32.gguf'),
  sheetsage: path.join(paths.modelsDir, 'SheetSage2-Q8_0.gguf'),
  mert: path.join(paths.modelsDir, 'MERT-v2-FullSong-Q8_0.gguf'),
  whisper: path.join(paths.modelsDir, 'ggml-large-v3-turbo-q5_0.bin'),
  tokenizer: path.join(paths.modelsDir, 'yue2-mothersuperior-realaudio-tokenizer-v4-Q8_0.gguf'),
  kokoro: path.join(paths.modelsDir, 'kokoro', 'kokoro-v1.0.onnx'),
  kokoroVozes: path.join(paths.modelsDir, 'kokoro', 'voices-v1.0.bin'),
  // o Chatterbox baixa os pesos sozinho na primeira vez e guarda aqui (inglês ~3 GB, multilíngue ~2 GB)
  chatterboxDir: path.join(paths.modelsDir, 'chatterbox', 'hf'),
  // gravação de referência que vem pronta: o trecho falado (rap) do dataset do EduCanto
  referenciaPadrao: path.join(paths.modelsDir, 'chatterbox', 'referencias', 'edu-rap-billionaire.wav'),
};

// Separação de vocal: mesmo modelo e ajustes usados no UVR5
// (MDX-Net, "UVR-MDX-NET Inst HQ 3", segmento 256, overlap padrão 0.25).
const separator = {
  model: 'UVR-MDX-NET-Inst_HQ_3.onnx',
  args: ['--mdx_segment_size', '256', '--mdx_overlap', '0.25'],
  // O Inst HQ 3 é feito para o instrumental; o vocal dele é a sobra (nota 8.8). O vocal sai deste
  // modelo próprio (nota 12.6), que é o que o Applio precisa receber limpo.
  vocalModel: 'vocals_mel_band_roformer.ckpt',
  // Tira eco e reverb do vocal antes do Applio: voz com eco sai borrada na troca.
  ecoModel: 'dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt',
  // Deixa só a voz principal: coro e segunda voz embolam a troca. O coro sai em arquivo à parte.
  coroModel: 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt',
};

// Teto do motor: 9000 passos semânticos a 25/s.
const MAX_SECONDS = 360;

// Python do Applio: o instalador oficial (conda) deixa em env\python.exe; o instalador do app
// (venv do uv) deixa em env\Scripts\python.exe.
function applioPython(dir) {
  const conda = path.join(dir || '', 'env', 'python.exe');
  const venv = path.join(dir || '', 'env', 'Scripts', 'python.exe');
  return fs.existsSync(conda) || !fs.existsSync(venv) ? conda : venv;
}

// Ferramentas que vêm junto (ffmpeg, yt-dlp, uv) entram no PATH do app e de tudo que ele abre,
// para funcionar em PC que não tem nada instalado.
function prepararPath() {
  const chave = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const nossas = [path.join(ROOT, 'tools', 'ffmpeg', 'bin'), path.join(ROOT, 'tools', 'yt-dlp'), path.join(ROOT, 'tools', 'uv')]
    .filter((d) => fs.existsSync(d));
  process.env[chave] = [...nossas, process.env[chave] || ''].join(path.delimiter);
}
prepararPath();

function ensureDirs() {
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.separatorModelsDir, { recursive: true });
}

module.exports = { APP_NAME, ROOT, paths, models, separator, motor, extraPath, MAX_SECONDS, ensureDirs, applioPython };
