// Baixa e instala modelos de voz (RVC) a partir de uma lista de links colada pelo usuário.
// Só aceita links https do Hugging Face. De um .zip saem apenas o .pth e o .index: nada é executado e o
// resto do pacote é descartado. Cada modelo ganha uma pasta própria em <Applio>\logs\<nome>, com nome
// sem acento (a biblioteca do índice não abre caminho com acento).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const LIMITE = 2 * 1024 * 1024 * 1024;   // 2 GB por arquivo
const ALTURAS = { grave: 130, media: 175, 'média': 175, aguda: 220 };
const LINGUAS = ['pt', 'es', 'en', 'ja', 'outra'];

function nomeSeguro(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'modelo';
}

// Aceita JSON ([{ nome, zip }] ou [{ nome, pth, index }]; opcionais "altura": grave | media | aguda,
// "lingua": pt | es | en | ja | outra, "pasta": nome de uma pasta da biblioteca)
// ou só links, um por linha. Devolve { itens, erros }.
function lerLista(texto) {
  const erros = [];
  let bruto = [];
  const t = String(texto || '').trim();
  if (!t) return { itens: [], erros: ['Cole a lista de modelos.'] };
  if (t[0] === '[' || t[0] === '{') {
    try {
      const j = JSON.parse(t);
      bruto = Array.isArray(j) ? j : j.modelos || [];
    } catch (e) {
      return { itens: [], erros: ['O texto não é um JSON válido: ' + e.message] };
    }
  } else {
    bruto = t.split(/\s+/).filter(Boolean).map((u) => (/\.pth(\?|$)/i.test(u) ? { pth: u } : { zip: u }));
  }
  const itens = [];
  for (const b of bruto) {
    const zip = b.zip || b.url || '';
    const pth = b.pth || '';
    const index = b.index || '';
    const links = [zip, pth, index].filter(Boolean);
    if (!zip && !pth) { erros.push('Item sem link de .zip nem de .pth.'); continue; }
    const ruim = links.find((u) => !linkAceito(u));
    if (ruim) { erros.push('Link recusado (só https://huggingface.co/…): ' + String(ruim).slice(0, 80)); continue; }
    const doLink = decodeURIComponent(new URL(zip || pth).pathname.split('/').pop() || '').replace(/\.(zip|pth)$/i, '');
    itens.push({ nome: nomeSeguro(b.nome || doLink), zip, pth, index, altura: ALTURAS[String(b.altura || '').toLowerCase()] || 0,
      lingua: LINGUAS.includes(String(b.lingua || '').toLowerCase()) ? String(b.lingua).toLowerCase() : '', pasta: String(b.pasta || '').trim().slice(0, 40) });
  }
  return { itens, erros };
}

function linkAceito(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === 'huggingface.co';
  } catch {
    return false;
  }
}

async function baixar(url, destino, aviso, sinal) {
  const r = await fetch(url, { redirect: 'follow', signal: sinal });
  if (!r.ok) throw new Error('o servidor respondeu ' + r.status);
  const total = Number(r.headers.get('content-length')) || 0;
  if (total > LIMITE) throw new Error('arquivo grande demais');
  let feito = 0;
  let ultimo = 0;
  const contador = new (require('stream').Transform)({
    transform(pedaco, _enc, cb) {
      feito += pedaco.length;
      if (feito > LIMITE) return cb(new Error('arquivo grande demais'));
      const agora = Date.now();
      if (agora - ultimo > 300) { ultimo = agora; aviso(feito, total); }
      cb(null, pedaco);
    },
  });
  await pipeline(Readable.fromWeb(r.body), contador, fs.createWriteStream(destino));
  aviso(feito, total);
}

function extrair(zip, pasta) {
  // o tar do Windows abre .zip e recusa caminhos que tentem sair da pasta de destino
  return new Promise((resolve, reject) => {
    execFile('C:\\Windows\\System32\\tar.exe', ['-xf', zip, '-C', pasta], { windowsHide: true }, (err) => (err ? reject(new Error('não consegui abrir o .zip')) : resolve()));
  });
}

function arquivosDe(pasta) {
  const out = [];
  for (const it of fs.readdirSync(pasta, { withFileTypes: true })) {
    const p = path.join(pasta, it.name);
    if (it.isDirectory()) out.push(...arquivosDe(p));
    else out.push({ file: p, nome: it.name, size: fs.statSync(p).size });
  }
  return out;
}

// De uma pasta já extraída, escolhe a voz (.pth que não é ponto de treino G_/D_) e o índice (de preferência
// o "added_…", senão o maior) e copia para <Applio>\logs\<nome>. Devolve { pth, index }.
function instalarDaPasta(pasta, nome, applioDir) {
  const todos = arquivosDe(pasta);
  const vozes = todos.filter((a) => /\.pth$/i.test(a.nome) && !/^[GD]_/i.test(a.nome)).sort((a, b) => b.size - a.size);
  if (!vozes.length) throw new Error('o pacote não tem arquivo de voz (.pth)');
  const indices = todos.filter((a) => /\.index$/i.test(a.nome))
    .sort((a, b) => (/^added_/i.test(b.nome) - /^added_/i.test(a.nome)) || b.size - a.size);
  const destino = path.join(applioDir, 'logs', nome);
  fs.mkdirSync(destino, { recursive: true });
  const pth = path.join(destino, nome + '.pth');
  fs.copyFileSync(vozes[0].file, pth);
  let index = '';
  if (indices.length) {
    index = path.join(destino, nome + '.index');
    fs.copyFileSync(indices[0].file, index);
  }
  return { pth, index };
}

// Baixa e instala um item. aviso(texto) recebe o andamento em palavras.
async function instalar(item, applioDir, tmpRaiz, aviso, sinal) {
  const destino = path.join(applioDir, 'logs', item.nome);
  if (fs.existsSync(destino) && fs.readdirSync(destino).some((f) => /\.pth$/i.test(f))) {
    return { nome: item.nome, pulado: true, pth: path.join(destino, fs.readdirSync(destino).find((f) => /\.pth$/i.test(f))) };
  }
  const tmp = path.join(tmpRaiz, item.nome + '-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const mb = (b) => (b / 1048576).toFixed(0) + ' MB';
  const andamento = (oque) => (feito, total) => aviso(oque + ' ' + mb(feito) + (total ? ' de ' + mb(total) : ''));
  try {
    if (item.zip) {
      const zip = path.join(tmp, 'pacote.zip');
      await baixar(item.zip, zip, andamento('baixando'), sinal);
      aviso('extraindo…');
      const aberto = path.join(tmp, 'aberto');
      fs.mkdirSync(aberto);
      await extrair(zip, aberto);
      return { nome: item.nome, ...instalarDaPasta(aberto, item.nome, applioDir) };
    }
    const solto = path.join(tmp, 'solto');
    fs.mkdirSync(solto);
    await baixar(item.pth, path.join(solto, 'voz.pth'), andamento('baixando a voz'), sinal);
    if (item.index) await baixar(item.index, path.join(solto, 'voz.index'), andamento('baixando o índice'), sinal);
    return { nome: item.nome, ...instalarDaPasta(solto, item.nome, applioDir) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Procura modelos no Hugging Face pelo nome do repositório e devolve só os que têm voz pronta
// (.zip ou .pth). Repositório com muitos arquivos (coleção) mostra só os arquivos com o termo no nome.
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const linkHf = (repo, f) => `https://huggingface.co/${repo}/resolve/main/${f.split('/').map(encodeURIComponent).join('/')}`;
// Nome para instalar: o do arquivo sem "- Weights.gg Model" e afins; se for genérico ("model"), o do repositório.
function nomeDoArquivo(arquivo, repo) {
  let n = arquivo.split('/').pop().replace(/\.(zip|pth)$/i, '').replace(/[\s_-]*(weights(\.gg)?|rvc\s*v?2?)?[\s_-]*model$/i, '').trim();
  if (!n || /^(model|modelo|voice|voz|added|final)$/i.test(n) || n.length < 3) n = repo.split('/').pop();
  return nomeSeguro(n.replace(/[\s_-]+rvc[\s_-]*v?\d*$/i, ''));
}
async function procurar(termo) {
  const t = String(termo || '').trim().slice(0, 80);
  if (!t) return { itens: [] };
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(t)}&sort=downloads&direction=-1&limit=80&full=true`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Haze' } });
  if (!r.ok) throw new Error('o Hugging Face respondeu ' + r.status);
  const lista = await r.json();
  const itens = [];
  for (const m of Array.isArray(lista) ? lista : []) {
    const files = (m.siblings || []).map((s) => s.rfilename);
    const opcoes = [];
    const tags = (m.tags || []).join(' ');
    // diz que é RVC: tem índice, ou "rvc" no nome ou nas etiquetas
    const pareceRvc = files.some((f) => /\.index$/i.test(f)) || /rvc/i.test(m.id) || /rvc/i.test(tags);
    // arquivos de outras IAs (texto, imagem, LoRA): repositório assim só entra se disser que é RVC
    const outraIa = /lora|peft|diffusers|transformers|gguf|text-generation|text-to-image|stable-diffusion/i.test(tags)
      || files.some((f) => /(^|\/)(adapter_config|config|tokenizer(_config)?|model_index)\.json$|\.(safetensors|gguf|ckpt|bin)$/i.test(f));
    const zipRuim = (f) => /lora|adapter|checkpoint|dataset|gguf|safetensors|diffusion|sdxl|lyco/i.test(f.split('/').pop());
    if (pareceRvc || !outraIa) {
      for (const z of files.filter((f) => /\.zip$/i.test(f) && !zipRuim(f))) opcoes.push({ arquivo: z, zip: linkHf(m.id, z) });
    }
    const vozes = files.filter((f) => /\.pth$/i.test(f) && !/^[GD]_|^f0[GD]|pretrain|hubert|rmvpe|contentvec/i.test(f.split('/').pop()));
    // .pth solto só conta como voz RVC se o repositório disser que é RVC
    for (const p of pareceRvc ? vozes : []) {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
      const idx = files.find((f) => /\.index$/i.test(f) && f.startsWith(dir) && !f.slice(dir.length).includes('/'))
        || (vozes.length === 1 ? files.find((f) => /\.index$/i.test(f)) : null);
      opcoes.push({ arquivo: p, pth: linkHf(m.id, p), index: idx ? linkHf(m.id, idx) : '' });
    }
    if (!opcoes.length) continue;
    let escolhidas = opcoes.length > 6 ? opcoes.filter((o) => semAcento(o.arquivo).includes(semAcento(t))) : opcoes;
    if (!escolhidas.length) escolhidas = opcoes.slice(0, 6);
    itens.push({
      repo: m.id, downloads: m.downloads || 0, likes: m.likes || 0, total: opcoes.length,
      opcoes: escolhidas.slice(0, 8).map((o) => ({ ...o, nome: nomeDoArquivo(o.arquivo, m.id) })),
    });
    if (itens.length >= 30) break;
  }
  return { itens };
}

module.exports = { lerLista, instalar, instalarDaPasta, nomeSeguro, linkAceito, procurar };
