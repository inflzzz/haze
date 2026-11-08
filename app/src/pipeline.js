const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, paths, models, separator, extraPath, MAX_SECONDS, ensureDirs, applioPython } = require('./config');

// PATH dos programas chamados: as DLLs do CUDA entram na frente quando o motor é CUDA.
// No Windows a variável costuma se chamar "Path"; reaproveita o nome existente para não criar duas.
const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === 'path') || 'PATH';
childEnv[pathKey] = [...extraPath, childEnv[pathKey] || ''].join(path.delimiter);

// ---------- pastas e nomes ----------
//
// saida\<Título> (dd-mm HHhMM)\
//   <Título> (gravação).mp3        o que o usuário usa fica na raiz, com nome legível
//   <Título> (vocal).wav
//   <Título> (instrumental).wav
//   <Título> (voz <modelo>).wav
//   letra.txt, partitura.abc, job.json
//   _trabalho\                     downloads, recortes, registros e pedidos ao motor

const p2 = (n) => String(n).padStart(2, '0');

// Tira o que o Windows não aceita em nome de arquivo.
function limpo(nome, max = 80) {
  const s = String(nome || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (s || 'Sem título').slice(0, max).trim();
}

function work(dir) {
  const w = path.join(dir, '_trabalho');
  fs.mkdirSync(w, { recursive: true });
  return w;
}

function newJobDir() {
  ensureDirs();
  const d = new Date();
  const id = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const dir = path.join(paths.outDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

// Dá à pasta o nome da música: "Título (dd-mm HHhMM)". Devolve o novo caminho (ou o mesmo, se não der).
function nomearPasta(dir, id, titulo) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id) || [];
  const quando = m.length ? `${m[3]}-${m[2]} ${m[4]}h${m[5]}` : id;
  const base = `${limpo(titulo, 70)} (${quando})`;
  let alvo = path.join(paths.outDir, base);
  for (let n = 2; fs.existsSync(alvo); n++) alvo = path.join(paths.outDir, `${base} ${n}`);
  try { fs.renameSync(dir, alvo); return alvo; } catch { return dir; }
}

function readMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
}
function saveMeta(dir, patch) {
  const f = path.join(dir, 'job.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...patch }, null, 2));
}
const comDir = (dir, meta) => ({ ...meta, id: meta.id || path.basename(dir), dir });

// ---------- execução ----------

class Cancelled extends Error {}

class Job {
  constructor(dir, onEvent) {
    this.onEvent = onEvent || (() => {});
    this.child = null;
    this.cancelled = false;
    this.setDir(dir);
  }
  setDir(dir) {
    this.dir = dir;
    this.logPath = path.join(work(dir), 'log.txt');
  }
  log(line) {
    try { fs.appendFileSync(this.logPath, line + '\n'); } catch {}
  }
  emit(stage, pct, message) {
    this.onEvent({ stage, pct, message });
  }
  cancel() {
    this.cancelled = true;
    if (this.child && this.child.pid) {
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    }
  }
  check() {
    if (this.cancelled) throw new Cancelled('Cancelado pelo usuário');
  }
}

// Executa um programa, entrega cada linha (\r ou \n) a onLine, falha se o código != 0.
function run(job, cmd, args, { onLine, cwd } = {}) {
  job.check();
  return new Promise((resolve, reject) => {
    job.log(`> ${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: childEnv });
    job.child = child;
    const tail = [];
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split(/[\r\n]+/);
      buf = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        job.log(line);
        tail.push(line);
        if (tail.length > 25) tail.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => reject(new Error(`Não consegui iniciar ${path.basename(cmd)}: ${e.message}`)));
    child.on('close', (code) => {
      job.child = null;
      if (buf.trim()) { job.log(buf); tail.push(buf); }
      if (job.cancelled) return reject(new Cancelled('Cancelado pelo usuário'));
      if (code !== 0) {
        return reject(new Error(`${path.basename(cmd)} falhou (código ${code}).\n${tail.slice(-8).join('\n')}`));
      }
      resolve(tail);
    });
  });
}

async function probeDuration(job, file) {
  const lines = await run(job, paths.ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  const n = parseFloat(lines[lines.length - 1]);
  if (!isFinite(n)) throw new Error('Não consegui ler a duração do áudio.');
  return n;
}

function need(file, what) {
  if (!fs.existsSync(file)) throw new Error(`Falta ${what}. Se for uma função que você ainda não instalou, instale na aba Instalar. (${file})`);
}

// ---------- letra ----------

// Transforma o texto do Whisper em letra com marcações [verse]/[chorus].
// Blocos de 4 linhas; bloco que repete outro vira [chorus].
function formatLyrics(text) {
  const lines = text
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[.?!])\s+/))
    .map((s) => s.trim())
    .filter((s) => s && !/^[\[\(].*[\]\)]$/.test(s)); // tira [MÚSICA], (aplausos) etc.
  // Linha toda em maiúsculas no meio de uma letra normal costuma ser invenção do Whisper sobre a introdução.
  const gritada = (s) => /\p{L}/u.test(s) && s === s.toUpperCase();
  if (lines.filter(gritada).length < lines.length / 3) {
    for (let i = lines.length - 1; i >= 0; i--) if (gritada(lines[i])) lines.splice(i, 1);
  }
  const blocks = [];
  for (let i = 0; i < lines.length; i += 4) blocks.push(lines.slice(i, i + 4));
  const seen = new Set();
  const norm = (b) => b.join(' ').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
  return blocks
    .map((b) => {
      const key = norm(b);
      const tag = seen.has(key) ? 'chorus' : 'verse';
      seen.add(key);
      return `[${tag}]\n${b.join('\n')}`;
    })
    .join('\n\n') + (blocks.length ? '\n' : '');
}

// ---------- etapas ----------

// ext 'wav' guarda o áudio sem recomprimir (usado quando o vocal original vai direto para o Applio).
async function download(job, url, dest, ext = 'mp3') {
  job.emit('download', 0, 'Baixando áudio…');
  // --print-to-file grava em UTF-8 (o stdout do yt-dlp.exe sai na codepage do console e quebra acentos)
  const titleFile = path.join(dest, 'titulo.txt');
  await run(job, paths.ytdlp, ['--no-playlist', '--skip-download', '--print-to-file', '%(title)s', titleFile, url]);
  let title = 'Sem título';
  try { title = fs.readFileSync(titleFile, 'utf8').trim() || title; } catch {}

  // O YouTube às vezes bloqueia um cliente (HTTP 403): tenta o padrão e depois alternativas.
  let lastErr = null;
  for (const client of [null, 'android', 'mweb']) {
    try {
      const args = ['--no-playlist', '-x', '--audio-format', ext, '--audio-quality', '0',
        '--newline', '-o', path.join(dest, 'origem.%(ext)s')];
      if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
      args.push(url);
      await run(job, paths.ytdlp, args, {
        onLine: (l) => {
          const m = l.match(/\[download\]\s+([\d.]+)%/);
          if (m) job.emit('download', parseFloat(m[1]), 'Baixando áudio…');
        },
      });
      lastErr = null;
      break;
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      lastErr = e;
      job.log(`Download falhou com cliente ${client || 'padrão'}; tentando outro…`);
    }
  }
  if (lastErr) throw lastErr;
  return { title, name: 'origem.' + ext };
}

async function importLocal(job, file, dest, ext = 'mp3') {
  job.emit('download', 0, 'Importando arquivo…');
  const qualidade = ext === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-q:a', '0'];
  await run(job, paths.ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-vn', ...qualidade, path.join(dest, 'origem.' + ext)]);
  return { title: path.basename(file, path.extname(file)), name: 'origem.' + ext };
}

async function trim(job, src, dest, start, end) {
  const args = ['-y', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', src);
  if (end != null) args.push('-t', String(Math.max(1, end - (start || 0))));
  if (/[.]wav$/i.test(dest)) args.push('-c:a', 'pcm_s16le', dest);
  else args.push('-q:a', '0', dest);
  await run(job, paths.ffmpeg, args);
}

// Separa vocal e instrumental (mesmo modelo e ajustes do UVR5). Devolve os dois arquivos, ainda em outDir.
async function separate(job, audio, outDir, label) {
  need(paths.separator, 'o separador de vocal (sep-env)');
  fs.mkdirSync(outDir, { recursive: true });
  const duas = !!separator.vocalModel && fs.existsSync(path.join(paths.separatorModelsDir, separator.vocalModel));
  const passo = (ini, fim, texto) => (l) => {
    const m = l.match(/(\d+)%\|/);
    if (m) job.emit(label, Math.round(ini + (parseInt(m[1], 10) * (fim - ini)) / 100), texto);
  };
  job.emit(label, 0, 'Separando o instrumental…');
  await run(job, paths.separator, [
    audio, '--model_filename', separator.model,
    '--model_file_dir', paths.separatorModelsDir,
    '--output_dir', outDir, '--output_format', 'WAV', ...separator.args,
  ], { onLine: passo(0, duas ? 45 : 100, 'Separando o instrumental…') });
  const files = fs.readdirSync(outDir);
  const vocals = files.find((f) => /\(Vocals\)/i.test(f));
  const instr = files.find((f) => /\(Instrumental\)/i.test(f));
  if (!vocals || !instr) throw new Error('O separador não gerou os arquivos esperados.');
  const out = { vocals: path.join(outDir, vocals), instrumental: path.join(outDir, instr) };

  // Segunda passada só para o vocal, com o modelo próprio de voz. Se falhar, fica o vocal da primeira.
  if (duas) {
    const dirVoz = path.join(outDir, 'vocal');
    fs.mkdirSync(dirVoz, { recursive: true });
    job.emit(label, 45, 'Separando o vocal (modelo de voz)…');
    try {
      await run(job, paths.separator, [
        audio, '--model_filename', separator.vocalModel,
        '--model_file_dir', paths.separatorModelsDir,
        '--output_dir', dirVoz, '--output_format', 'WAV', '--single_stem', 'Vocals',
      ], { onLine: passo(45, 100, 'Separando o vocal (modelo de voz)…') });
      const limpo2 = fs.readdirSync(dirVoz).find((f) => /\(Vocals\)/i.test(f));
      if (limpo2) out.vocals = path.join(dirVoz, limpo2);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      job.log('vocal limpo falhou, usando o vocal da primeira passada: ' + (e && e.message));
    }
  }
  return out;
}

// Separa uma gravação e deixa as duas faixas na raiz da pasta, com o nome da música.
async function separateNamed(job, dir, cover, titulo, n) {
  const tmp = path.join(work(dir), `stems_${n + 1}`);
  const st = await separate(job, cover, tmp, 'separar');
  const suf = n === 0 ? '' : ` ${n + 1}`;
  const out = {
    vocals: path.join(dir, `${limpo(titulo)} (vocal${suf}).wav`),
    instrumental: path.join(dir, `${limpo(titulo)} (instrumental${suf}).wav`),
  };
  fs.renameSync(st.vocals, out.vocals);
  fs.renameSync(st.instrumental, out.instrumental);
  return out;
}

async function transcribeScore(job, audio, dest) {
  need(paths.yueTranscribe, 'yue-transcribe.exe');
  need(models.sheetsage, 'o modelo SheetSage2');
  job.emit('partitura', 0, 'Ouvindo a melodia…');
  await run(job, paths.yueTranscribe, [
    '--model', models.sheetsage, '--audio', audio, '--melody-only', '--out', dest,
  ]);
  job.emit('partitura', 100, 'Melodia anotada');
  return fs.readFileSync(dest, 'utf8');
}

async function transcribeLyrics(job, vocalWav, wdir, lang) {
  need(paths.whisper, 'whisper-cli.exe');
  need(models.whisper, 'o modelo Whisper');
  job.emit('letra', 0, 'Reconhecendo a letra…');
  const wav16 = path.join(wdir, 'vocal16k.wav');
  // Corta o silêncio do começo do vocal: o Whisper decide o idioma pelos primeiros 30 s, e numa
  // introdução sem voz ele chuta errado e inventa texto (já saiu letra em coreano por isso).
  await run(job, paths.ffmpeg, [
    '-y', '-loglevel', 'error', '-i', vocalWav,
    '-af', 'silenceremove=start_periods=1:start_duration=0.25:start_threshold=-38dB',
    '-ar', '16000', '-ac', '1', wav16,
  ]);
  const base = path.join(wdir, 'letra_bruta');
  // -mc 0: sem contexto entre trechos, evita o laço de frases repetidas. -sns: ignora sons que não são fala.
  await run(job, paths.whisper, [
    '-m', models.whisper, '-f', wav16, '-l', lang || 'auto', '-ml', '45', '-mc', '0', '-sns', '-otxt', '-of', base,
  ]);
  // sem -nt: cada linha vem como "[00:00:01.000 --> 00:00:04.000]   texto"; -ml 45 quebra em versos curtos
  const raw = fs.readFileSync(base + '.txt', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');
  job.emit('letra', 100, 'Letra reconhecida');
  return formatLyrics(raw);
}

// ---------- fase 1: análise ----------
// Baixa/importa, recorta, anota a melodia e reconhece a letra.
// opts: { url | file, start, end, preview, lyrics, lang, semitones }
async function analyze(opts, onEvent, ctl = {}) {
  let { id, dir } = newJobDir();
  const job = new Job(dir, onEvent);
  ctl.job = job;
  try {
    const src = opts.url
      ? await download(job, opts.url, work(dir))
      : await importLocal(job, opts.file, work(dir));
    job.check();

    // agora que o título é conhecido, a pasta ganha o nome da música
    dir = nomearPasta(dir, id, src.title);
    job.setDir(dir);
    const w = work(dir);
    const origem = path.join(w, src.name);

    const start = Math.max(0, Number(opts.start) || 0);
    let end = opts.end != null && opts.end !== '' ? Number(opts.end) : null;
    if (opts.preview) end = start + 30;
    let fonte = origem;
    if (start > 0 || end != null) {
      fonte = path.join(w, 'fonte.mp3');
      await trim(job, origem, fonte, start, end);
    }
    const duration = await probeDuration(job, fonte);

    // Mudar o tom: só o áudio usado para a partitura é transposto (a letra usa o original).
    // Ex.: -12 desce uma oitava, então uma voz grossa alcança uma música cantada por mulher.
    const semitones = Math.max(-24, Math.min(24, Math.round(Number(opts.semitones) || 0)));
    let scoreAudio = fonte;
    if (semitones !== 0) {
      job.emit('partitura', 0, `Ajustando o tom (${semitones > 0 ? '+' : ''}${semitones} semitons)…`);
      scoreAudio = path.join(w, 'fonte_tom.mp3');
      await run(job, paths.ffmpeg, [
        '-y', '-loglevel', 'error', '-i', fonte,
        '-af', `rubberband=pitch=${Math.pow(2, semitones / 12).toFixed(6)}`, '-q:a', '0', scoreAudio,
      ]);
    }
    const abc = await transcribeScore(job, scoreAudio, path.join(dir, 'partitura.abc'));

    let lyrics = opts.lyrics && opts.lyrics.trim() ? opts.lyrics : '';
    let lyricsAuto = false;
    if (!lyrics) {
      try {
        const stems = await separate(job, fonte, path.join(w, 'fonte_stems'), 'letra');
        lyrics = await transcribeLyrics(job, stems.vocals, w, opts.lang);
        lyricsAuto = true;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        job.log('Falha na letra automática: ' + e.message);
        lyrics = '';
      }
    }
    fs.writeFileSync(path.join(dir, 'letra.txt'), lyrics, 'utf8');

    const result = {
      id, kind: 'cover', title: src.title, source: opts.url || opts.file, fonte,
      duration, abc, lyrics, lyricsAuto, start, end, semitones, status: 'analisado',
    };
    saveMeta(dir, result);
    job.emit('analise', 100, 'Análise pronta');
    return comDir(dir, result);
  } catch (e) {
    saveMeta(dir, { id, status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message });
    throw e;
  }
}

// ---------- fase 2: gravação ----------
// opts: { style, abc, lyrics, duration, variations, seed, lmSeed, steps, format, bitrate,
//         separateCover, adapters:{dir,list}, voz:{...} }
async function generate(dir, opts, onEvent, ctl = {}) {
  let meta = readMeta(dir);

  // Regravar a mesma análise com outro estilo nunca apaga a gravação anterior:
  // se esta pasta já tem uma gravação, a nova ganha uma pasta própria.
  if (meta.covers && meta.covers.length) {
    const novo = newJobDir();
    const base = {
      id: novo.id, kind: meta.kind || 'cover', title: meta.title, source: meta.source, fonte: meta.fonte,
      duration: meta.duration, start: meta.start, end: meta.end, semitones: meta.semitones,
      abc: meta.abc, lyrics: meta.lyrics, lyricsAuto: meta.lyricsAuto, status: 'analisado',
      cot: meta.cot, instrumental: meta.instrumental, trecho: meta.trecho,
    };
    // os códigos do trecho de origem (modo continuar) vão junto para a pasta nova
    if (meta.codigos && fs.existsSync(meta.codigos)) {
      base.codigos = path.join(work(novo.dir), 'codigos.csv');
      fs.copyFileSync(meta.codigos, base.codigos);
    }
    saveMeta(novo.dir, base);
    dir = nomearPasta(novo.dir, novo.id, meta.title);
    if (base.codigos) { base.codigos = path.join(work(dir), 'codigos.csv'); saveMeta(dir, { codigos: base.codigos }); }
    fs.writeFileSync(path.join(dir, 'partitura.abc'), meta.abc || '', 'utf8');
    fs.writeFileSync(path.join(dir, 'letra.txt'), meta.lyrics || '', 'utf8');
    meta = base;
  }

  const job = new Job(dir, onEvent);
  ctl.job = job;
  const w = work(dir);
  const titulo = meta.title || 'Sem título';
  try {
    need(paths.yueSynth, 'yue-synth.exe');
    need(models.backbone, 'o modelo YuE2');
    need(models.vae, 'o modelo VAE');

    const instrumental = !!(opts.instrumental != null ? opts.instrumental : meta.instrumental);
    const continuar = !!(meta.codigos && fs.existsSync(meta.codigos));
    // cover: a partitura vem da música original ('melody'). Do zero: o motor escreve a dele ('full' ou
    // 'melody') ou vai direto ('off'). Continuar: sem partitura, a música de origem é o guia.
    const cot = continuar ? 'off' : (opts.cot || meta.cot || 'melody');
    const abc = cot === 'off' ? '' : ((opts.abc != null ? opts.abc : meta.abc) || '');
    let lyrics = opts.lyrics != null ? opts.lyrics : (meta.lyrics || '');
    if (!opts.style || !opts.style.trim()) throw new Error('Escolha uma voz ou escreva um estilo.');
    if (instrumental) lyrics = '[instrumental]\n';
    else if (!lyrics.trim()) throw new Error('Sem letra. Escreva ou cole a letra antes de gravar.');
    if (instrumental && !/\binstrumental\b/i.test(opts.style)) opts = { ...opts, style: 'instrumental, ' + opts.style.trim() };
    saveMeta(dir, { abc, lyrics, cot, instrumental, status: 'gravando', error: undefined });
    fs.writeFileSync(path.join(dir, 'letra.txt'), instrumental ? '' : lyrics, 'utf8');
    if (abc) fs.writeFileSync(path.join(dir, 'partitura.abc'), abc, 'utf8');

    const duration = Math.min(opts.duration || meta.duration, MAX_SECONDS);
    const fmt = opts.format || 'mp3';
    const ext = fmt === 'mp3' ? 'mp3' : 'wav';
    const variations = Math.min(Math.max(parseInt(opts.variations, 10) || 1, 1), 4);

    // As sementes do motor são inteiros de 64 bits (19 dígitos): não cabem em Number do JS.
    // Viajam como texto e entram no JSON por substituição, sem passar por Number.
    const seedTxt = (v) => (v != null && /^\d{1,19}$/.test(String(v).trim()) ? String(v).trim() : '-1');
    const req = {
      style: opts.style.trim(),
      lyrics,
      abc,
      cot,
      duration,
      lm_seed: '@@LM_SEED@@',
      seed: '@@SEED@@',
      steps: opts.steps || 32,
      synth_batch_size: variations,
      output_format: fmt,
      mp3_bitrate: opts.bitrate || 192,
    };
    if (opts.adapters && opts.adapters.list && opts.adapters.list.length) req.adapters = opts.adapters.list;
    // Duração exata: para o motor, "duration" é só um teto; ele encerra quando a letra acaba.
    // min_tokens proíbe o fim antes da hora (25 códigos por segundo). Os outros valores são os padrões do modelo.
    if (opts.exato) {
      req.semantic_sampling = {
        temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2, penalty_window: 50,
        min_tokens: Math.max(200, Math.round((duration - 3) * 25)), max_tokens: 9000,
      };
    }
    if (continuar) {
      // os códigos do trecho real abrem a música; o motor compõe o resto até a duração pedida
      req.source_tokens = fs.readFileSync(meta.codigos, 'utf8').trim();
      req.source_start = 0;
      req.source_end = -1;
    }
    const reqFile = path.join(w, 'pedido.json');
    fs.writeFileSync(reqFile, JSON.stringify(req, null, 2)
      .replace('"@@LM_SEED@@"', seedTxt(opts.lmSeed))
      .replace('"@@SEED@@"', seedTxt(opts.seed)), 'utf8');
    delete req.lm_seed;
    delete req.seed;
    delete req.source_tokens; // não vai para o job.json: é enorme e já está em codigos.csv

    for (const f of fs.readdirSync(w)) if (/^cover.*\.(mp3|wav|json)$/.test(f)) fs.unlinkSync(path.join(w, f));
    const args = [
      '--model', models.backbone, '--vae', models.vae, '--request', reqFile,
      '--out', path.join(w, `cover.${ext}`),
    ];
    if (opts.adapters && opts.adapters.dir) args.push('--adapters', opts.adapters.dir);
    const scoreFile = path.join(w, 'partitura-motor.abc');
    const motorEscreve = cot !== 'off' && !abc.trim();
    if (motorEscreve) { try { fs.unlinkSync(scoreFile); } catch {} args.push('--score', scoreFile); }

    job.emit(motorEscreve ? 'partitura' : 'cover', 0, motorEscreve ? 'Escrevendo a partitura…' : 'Gravando…');
    await run(job, paths.yueSynth, args, {
      onLine: (l) => {
        let m = l.match(/\[AR\] Score (\d+)\/(\d+)/);
        if (m) return job.emit('partitura', Math.min(95, Math.round((m[1] / 900) * 100)), 'Escrevendo a partitura…');
        m = l.match(/\[AR\] Semantic (\d+)\/(\d+)/);
        if (m) return job.emit('cover', Math.round((m[1] / m[2]) * 45), 'Compondo a música…');
        m = l.match(/\[NAR\] Step (\d+)\/(\d+)/);
        if (m) return job.emit('cover', 45 + Math.round((m[1] / m[2]) * 50), 'Sintetizando o som…');
        if (/\[VAE\]/.test(l)) return job.emit('cover', 97, 'Finalizando o som…');
      },
    });

    // Sementes realmente usadas: o motor grava um JSON de replay ao lado do áudio.
    const replay = readReplaySeeds(w);
    if (motorEscreve && fs.existsSync(scoreFile)) {
      const escrita = fs.readFileSync(scoreFile, 'utf8');
      if (escrita.trim()) {
        fs.writeFileSync(path.join(dir, 'partitura.abc'), escrita, 'utf8');
        saveMeta(dir, { abc: escrita });
      }
    }

    // A gravação vai para a raiz da pasta, com o nome da música.
    const brutos = fs.readdirSync(w).filter((f) => new RegExp(`^cover.*\\.${ext}$`).test(f)).sort();
    if (!brutos.length) throw new Error('O motor terminou sem gerar áudio.');
    const covers = brutos.map((f, i) => {
      const alvo = path.join(dir, `${limpo(titulo)} (gravação${i === 0 ? '' : ' ' + (i + 1)}).${ext}`);
      fs.renameSync(path.join(w, f), alvo);
      return alvo;
    });
    job.emit('cover', 100, 'Gravação pronta');

    // Separa só a primeira variação; as outras são separadas sob demanda (separateTake).
    const stemsList = covers.map(() => null);
    if (opts.separateCover !== false) stemsList[0] = await separateNamed(job, dir, covers[0], titulo, 0);

    const result = {
      status: 'pronto', style: req.style, covers, stems: stemsList[0], stemsList, replay,
      request: req, format: fmt, finishedAt: new Date().toISOString(),
    };
    saveMeta(dir, result);

    // Troca de voz no Applio, se pedida e se há vocal separado.
    if (opts.voz && opts.voz.pth && stemsList[0]) {
      await trocarVozes(job, dir, 0, opts.voz);
    }

    job.emit('fim', 100, 'Tudo pronto');
    return comDir(dir, readMeta(dir));
  } catch (e) {
    saveMeta(dir, { status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message });
    throw e;
  }
}

function readReplaySeeds(wdir) {
  try {
    const f = fs.readdirSync(wdir).filter((n) => /^cover.*\.json$/.test(n)).sort()[0];
    const txt = fs.readFileSync(path.join(wdir, f), 'utf8');
    const lm = txt.match(/"lm_seed":\s*(-?\d+)/);
    const sd = txt.match(/"seed":\s*(-?\d+)/);
    return { lm_seed: lm ? lm[1] : null, seed: sd ? sd[1] : null };
  } catch {
    return null;
  }
}

// Separa vocal/instrumental de uma variação que ainda não foi separada.
async function separateTake(dir, index, onEvent, ctl = {}) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  const meta = readMeta(dir);
  const cover = meta.covers && meta.covers[index];
  if (!cover) throw new Error('Variação não encontrada.');
  const stemsList = meta.stemsList || meta.covers.map((_, i) => (i === 0 ? meta.stems || null : null));
  stemsList[index] = await separateNamed(job, dir, cover, meta.title, index);
  saveMeta(dir, { stemsList, stems: stemsList[0] });
  job.emit('fim', 100, 'Tudo pronto');
  return comDir(dir, readMeta(dir));
}

// ---------- troca de voz (Applio / RVC) ----------
// A biblioteca que lê o índice de voz (faiss) não abre arquivo cujo caminho tem acento ou cedilha
// (ex.: logs\\criança\\x.index): o índice fica de fora sem aviso e, na voz ao vivo, o motor cai.
// Para esses casos o Applio recebe um atalho (ligação física, sem ocupar espaço) do mesmo arquivo,
// com nome simples, guardado nos dados do app. A pasta do Applio não é tocada.
function indiceSeguro(arquivo) {
  if (!arquivo || !/[^\x20-\x7E]/.test(arquivo) || !fs.existsSync(arquivo)) return arquivo || '';
  try {
    const st = fs.statSync(arquivo);
    const pasta = path.join(ROOT, '.dados-app', 'indices');
    const nome = require('crypto').createHash('md5').update(arquivo + '|' + st.size + '|' + st.mtimeMs).digest('hex') + '.index';
    const atalho = path.join(pasta, nome);
    if (!fs.existsSync(atalho)) {
      fs.mkdirSync(pasta, { recursive: true });
      try { fs.linkSync(arquivo, atalho); } catch { fs.copyFileSync(arquivo, atalho); }
    }
    return atalho;
  } catch {
    return arquivo;
  }
}

// Linha de comando da conversão. O Applio só aceita valores de uma lista fixa em cada opção;
// aqui cada um é ajustado ao passo dele.
function argsInfer(voz, entrada, saida) {
  const num = (v, def, min, max, casas) => {
    const x = Number.isFinite(Number(v)) ? Number(v) : def;
    return Math.min(max, Math.max(min, x)).toFixed(casas);
  };
  const sn = (v) => (v ? 'True' : 'False');
  const args = [
    'core.py', 'infer',
    '--pitch', num(voz.pitch, 0, -24, 24, 0),
    '--f0_method', voz.f0 || 'rmvpe',
    '--index_rate', num(voz.indexRate, 0.55, 0, 1, 2),
    '--volume_envelope', num(voz.volumeEnvelope, 1, 0, 1, 2),
    '--protect', num(voz.protect, 0.2, 0, 0.5, 3),
    '--embedder_model', voz.embedder || 'contentvec',
    '--split_audio', sn(voz.splitAudio),
    '--f0_autotune', sn(voz.autotune),
    '--f0_autotune_strength', num(voz.autotuneStrength, 1, 0, 1, 1),
    '--clean_audio', sn(voz.cleanAudio),
    '--clean_strength', num(voz.cleanStrength, 0.5, 0, 1, 1),
    // o formante do Applio mexe na voz do cantor ANTES de converter, e o modelo apaga quase tudo;
    // por isso ele fica desligado aqui e é aplicado na voz já convertida (formanteDepois)
    '--formant_shifting', 'False',
    '--input_path', entrada,
    '--output_path', saida,
    '--pth_path', voz.pth,
    '--index_path', indiceSeguro(voz.index),
    '--export_format', 'WAV',
  ];
  // --proposed_pitch usa type=bool no Applio: qualquer texto, até "False", vira verdadeiro.
  // Por isso a opção só entra na linha de comando quando está ligada.
  if (voz.proposedPitch) {
    args.push('--proposed_pitch', 'True', '--proposed_pitch_threshold', num(voz.proposedPitchThreshold, 155, 50, 1199, 0));
  }
  return args;
}

// ---------- preparo do vocal para o Applio ----------
const temModelo = (m) => !!m && fs.existsSync(path.join(paths.separatorModelsDir, m)) && fs.existsSync(paths.separator);

// Uma passada do separador com um modelo auxiliar. O resultado fica em `pasta` (dentro de _trabalho)
// e é reaproveitado enquanto a entrada não mudar. Devolve os .wav gerados, ou null se falhou:
// nesse caso quem chamou segue com o vocal que tinha.
async function passadaAux(job, dir, entrada, modelo, pasta, extra, ini, fim, texto) {
  const lista = () => (fs.existsSync(pasta)
    ? fs.readdirSync(pasta).filter((f) => /\.wav$/i.test(f)).map((f) => path.join(pasta, f)) : []);
  const feitos = lista();
  const idade = fs.statSync(entrada).mtimeMs;
  if (feitos.length && feitos.every((f) => fs.statSync(f).mtimeMs >= idade)) return feitos;
  fs.rmSync(pasta, { recursive: true, force: true });
  fs.mkdirSync(pasta, { recursive: true });
  job.emit('voz', ini, texto);
  // o separador cola o nome do modelo no nome do arquivo: entra com nome curto para o caminho não estourar
  const curto = path.join(work(dir), 'v.wav');
  try {
    fs.copyFileSync(entrada, curto);
    await run(job, paths.separator, [
      curto, '--model_filename', modelo,
      '--model_file_dir', paths.separatorModelsDir,
      '--output_dir', pasta, '--output_format', 'WAV', ...extra,
    ], {
      onLine: (l) => {
        const m = l.match(/(\d+)%\|/);
        if (m) job.emit('voz', Math.round(ini + (parseInt(m[1], 10) * (fim - ini)) / 100), texto);
      },
    });
    const novos = lista();
    if (novos.length) return novos;
    job.log(`${texto} o separador não gerou arquivo; seguindo com o vocal anterior`);
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    job.log(`${texto} falhou; seguindo com o vocal anterior: ${e && e.message}`);
  } finally {
    fs.rmSync(curto, { force: true });
  }
  return null;
}

// Limpa o vocal antes da troca: primeiro tira coro e segunda voz, depois o eco. Ocupa de 0 a 45% da etapa.
// Devolve o vocal pronto para o Applio e, se houver, o arquivo do coro que saiu.
async function prepararVocal(job, dir, vocal, n, voz) {
  const etapas = [];
  if (voz.tirarCoro && temModelo(separator.coroModel)) etapas.push('coro');
  if (voz.tirarEco && temModelo(separator.ecoModel)) etapas.push('eco');
  const fatia = etapas.length ? 45 / etapas.length : 0;
  let atual = vocal;
  let coro = null;
  let marca = '';
  for (const [i, etapa] of etapas.entries()) {
    const ini = Math.round(i * fatia);
    const fim = Math.round((i + 1) * fatia);
    if (etapa === 'coro') {
      const arqs = await passadaAux(job, dir, atual, separator.coroModel, path.join(work(dir), `principal_${n + 1}`),
        [], ini, fim, 'Tirando coro e segunda voz…');
      const principal = arqs && arqs.find((f) => /\(Vocals\)/i.test(path.basename(f)));
      if (principal) {
        atual = principal;
        marca = 'p';
        coro = arqs.find((f) => /\(Instrumental\)/i.test(path.basename(f))) || null;
      }
    } else {
      // pasta separada conforme veio ou não do vocal sem coro, para não reaproveitar o resultado errado
      const arqs = await passadaAux(job, dir, atual, separator.ecoModel, path.join(work(dir), `seco${marca}_${n + 1}`),
        ['--single_stem', 'noreverb'], ini, fim, 'Tirando o eco do vocal…');
      if (arqs && arqs[0]) atual = arqs[0];
    }
  }
  return { entrada: atual, coro };
}

// Altura do vocal e altura natural do modelo de voz (lida das curvas de tom do treino, em logs/<nome>/f0_voiced).
// Devolve { vocal: {centro…}, modelo: {centro…} } ou null se não deu para medir.
async function medirTom(job, vocal, voz, comFrases) {
  if (!fs.existsSync(paths.sepPython) || !fs.existsSync(paths.tomScript)) return null;
  let res = null;
  try {
    await run(job, paths.sepPython, [
      paths.tomScript, '--vocal', vocal, '--treino', path.join(path.dirname(voz.pth), 'f0_voiced'),
      ...(comFrases ? ['--frases'] : []),
    ], {
      onLine: (l) => {
        if (!l.startsWith('TOM ')) return;
        try { res = JSON.parse(l.slice(4)); } catch {}
      },
    });
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    job.log('medir o tom falhou: ' + (e && e.message));
  }
  // modelo baixado pronto não tem as curvas do treino: vale a altura que o usuário informou
  if (res && res.vocal && !res.modelo && Number(voz.centroModelo) > 0) res.modelo = { centro: Number(voz.centroModelo) };
  return res && res.vocal && res.modelo ? res : null;
}

// Dois tons: para cada frase, a oitava (tom base, uma abaixo ou uma acima) que deixa a voz mais perto da
// altura natural do modelo. Frases vizinhas na mesma oitava viram um bloco só.
// frases: [[ini, fim, hz], …]   devolve uma escolha por frase: [{ ini, fim, hz, pitch }, …]
function planoDeOitavas(frases, centro, base) {
  const opcoes = [-12, 0, 12].map((k) => base + k).filter((x) => Math.abs(x) <= 24);
  const dist = (hz, tom) => Math.abs(Math.log2((hz * Math.pow(2, tom / 12)) / centro));
  const plano = [];
  let anterior = null;
  for (const [ini, fim, hz] of frases) {
    let melhor = opcoes.reduce((a, b) => (dist(hz, b) < dist(hz, a) ? b : a));
    // frase no limite entre duas oitavas fica na da frase anterior, para não ficar trocando à toa
    if (anterior != null && melhor !== anterior && opcoes.includes(anterior) && dist(hz, anterior) - dist(hz, melhor) < 0.08) melhor = anterior;
    anterior = melhor;
    plano.push({ ini, fim, hz, pitch: melhor });
  }
  return plano;
}

// Frases vizinhas no mesmo tom viram um bloco só: [{ ini, fim, pitch }, …]
function blocosDe(frases) {
  const blocos = [];
  for (const f of frases) {
    const u = blocos[blocos.length - 1];
    if (u && u.pitch === f.pitch) u.fim = f.fim;
    else blocos.push({ ini: f.ini, fim: f.fim, pitch: f.pitch });
  }
  return blocos;
}

// Junta os pedaços de cada versão num arquivo só e devolve onde ele ficou (ver porNoLugar).
// Os cortes caem no meio da pausa entre dois blocos.
async function emendarTons(job, dir, blocos, tons, saida) {
  const partes = blocos.map((b, i) => ({
    arquivo: tons.find((t) => t.pitch === b.pitch).file,
    ini: i === 0 ? 0 : (blocos[i - 1].fim + b.ini) / 2,
    fim: i === blocos.length - 1 ? null : (b.fim + blocos[i + 1].ini) / 2,
  }));
  const plano = path.join(work(dir), 'plano_tons.json');
  // monta num arquivo de trabalho e só depois põe no lugar: o final pode estar aberto em outro programa
  const pronto = path.join(work(dir), 'emenda.wav');
  fs.rmSync(pronto, { force: true });
  fs.writeFileSync(plano, JSON.stringify({ saida: pronto, partes }, null, 2));
  await run(job, paths.sepPython, [paths.emendarScript, '--plano', plano]);
  if (!fs.existsSync(pronto)) throw new Error('A emenda dos dois tons não gerou o arquivo.');
  const final = await porNoLugar(pronto, saida);
  fs.rmSync(pronto, { force: true });
  return final;
}

// Copia por cima do arquivo final e devolve onde ficou. Arquivo carregado no FL Studio (ou tocando em outro
// programa) fica preso e não aceita ser regravado: aí o resultado sai ao lado, com "emenda 2", "emenda 3"…
async function porNoLugar(origem, destino) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.copyFileSync(origem, destino);
      return destino;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const ext = path.extname(destino);
  const raiz = destino.slice(0, -ext.length).replace(/ emenda [0-9]+[)]$/, ')');
  for (let n = 2; n < 60; n++) {
    const outro = raiz.replace(/[)]$/, ` emenda ${n})`) + ext;
    if (fs.existsSync(outro)) continue;
    fs.copyFileSync(origem, outro);
    return outro;
  }
  throw new Error(`Não consegui gravar "${path.basename(destino)}": o arquivo está aberto em outro programa.`);
}

// Quanto o tom escolhido foge de uma oitava inteira, de -6 a +6. É o que o instrumental precisa andar
// para continuar afinado com a voz.
function foraDaOitava(semitons) {
  let d = ((semitons % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

async function mudarTom(job, origem, destino, semitons) {
  await run(job, paths.ffmpeg, [
    '-y', '-loglevel', 'error', '-i', origem,
    '-af', `rubberband=pitch=${Math.pow(2, semitons / 12).toFixed(6)}:pitchq=quality:channels=together`,
    '-c:a', 'pcm_s16le', destino,
  ]);
}

async function volumeMedio(job, file) {
  let db = null;
  try {
    await run(job, paths.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
      onLine: (l) => {
        const m = l.match(/mean_volume:\s*(-?[\d.]+) dB/);
        if (m) db = parseFloat(m[1]);
      },
    });
  } catch (e) {
    if (e instanceof Cancelled) throw e;
  }
  return db;
}

// Depois do Applio: silêncio limpo nas pausas e volume igual ao do vocal de origem (o guia).
// Se falhar, a voz fica como o Applio entregou.
async function acabamento(job, voz, guia, alvo) {
  const pedidos = [];
  if (voz.limparPausas) pedidos.push('--pausas');
  if (voz.igualarVolume) pedidos.push('--volume');
  if (!pedidos.length || !fs.existsSync(paths.sepPython) || !fs.existsSync(paths.acabamentoScript)) return;
  try {
    await run(job, paths.sepPython, [paths.acabamentoScript, '--guia', guia, '--alvo', alvo, ...pedidos]);
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    job.log('acabamento da voz falhou; ela fica como o Applio entregou: ' + (e && e.message));
  }
}

// Chave "Mudar o formante": engrossa ou afina a voz já convertida, sem mudar as notas.
async function formanteDepois(job, voz, arquivo) {
  const timbre = Math.min(16, Math.max(0.1, Number(voz.formantTimbre) || 1));
  if (!voz.formant || Math.abs(timbre - 1) < 0.001) return;
  const q = Math.min(16, Math.max(0.1, Number(voz.formantQfrency) || 1));
  await run(job, applioPython(voz.applioDir), ['-I', paths.formanteScript, '--arquivo', arquivo,
    '--timbre', timbre.toFixed(2), '--quefrencia', q.toFixed(2)]);
}

// Uma conversão inteira no Applio, num tom, já com o acabamento.
async function converter(job, voz, tom, entrada, saida) {
  const py = applioPython(voz.applioDir);
  await run(job, py, argsInfer({ ...voz, pitch: tom }, entrada, saida), { cwd: voz.applioDir });
  if (!fs.existsSync(saida)) throw new Error('O Applio terminou sem gerar o arquivo de voz.');
  await formanteDepois(job, voz, saida);
  await acabamento(job, voz, entrada, saida);
}

// O Applio roda por linha de comando, no ambiente Python dele; nada dentro da pasta dele é alterado.
// voz: { applioDir, pth, index, nome, pitch, f0, indexRate, protect, …, limparPausas, igualarVolume, coroNaVoz,
//        tirarCoro, tirarEco, tomSozinho, instrumentalAcompanha }
async function trocarVozInterno(job, dir, n, voz) {
  const meta = readMeta(dir);
  const stemsList = meta.stemsList || [meta.stems || null];
  const st = stemsList[n];
  if (!st || !st.vocals) throw new Error('Separe o vocal desta gravação antes de trocar a voz.');
  const py = applioPython(voz.applioDir);
  need(py, 'o Python do Applio');
  need(path.join(voz.applioDir, 'core.py'), 'o core.py do Applio');
  need(voz.pth, 'o modelo de voz (.pth)');

  const titulo = limpo(meta.title);
  const nome = limpo(voz.nome || path.basename(voz.pth, '.pth'), 30);
  const suf = n === 0 ? '' : ' ' + (n + 1);
  let out = path.join(dir, `${titulo} (voz ${nome}${suf}).wav`);

  const prep = await prepararVocal(job, dir, st.vocals, n, voz);

  // Tom: o do painel, ou o que deixa a voz da música na altura natural do modelo.
  let pitch = Math.max(-24, Math.min(24, Math.round(Number(voz.pitch) || 0)));
  let tomAuto = false;
  let medida = null;
  if (voz.tomSozinho || voz.doisTons) {
    job.emit('voz', 45, voz.doisTons ? 'Medindo a altura de cada frase…' : 'Medindo o tom da voz…');
    medida = await medirTom(job, prep.entrada, voz, !!voz.doisTons);
    if (!medida) job.log('não deu para medir o tom (ou o modelo não tem as curvas do treino); usando o tom do painel na música inteira');
  }
  if (voz.tomSozinho && medida) {
    const bruto = 12 * Math.log2(medida.modelo.centro / medida.vocal.centro);
    let p = voz.instrumentalAcompanha ? Math.round(bruto) : Math.round(bruto / 12) * 12;
    // a um semitom da oitava inteira não compensa mexer no instrumental
    if (Math.abs(foraDaOitava(p)) <= 1) p -= foraDaOitava(p);
    pitch = Math.max(-24, Math.min(24, p));
    tomAuto = true;
    job.log(`tom sozinho: vocal ${medida.vocal.centro} Hz, modelo ${medida.modelo.centro} Hz, escolhido ${pitch} semitons`);
  }
  const sinal = (x) => (x > 0 ? '+' + x : String(x));
  const desvio = voz.instrumentalAcompanha ? foraDaOitava(pitch) : 0;

  // Dois tons: cada frase vai na oitava que cai melhor na voz do modelo.
  const base = pitch;   // tom pedido; cada frase pode ir uma oitava acima ou abaixo dele
  let blocos = null;
  let frases = null;
  if (voz.doisTons && medida && medida.frases && medida.frases.length) {
    frases = planoDeOitavas(medida.frases, medida.modelo.centro, pitch);
    blocos = blocosDe(frases);
    job.log('dois tons: ' + blocos.map((b) => `${b.ini.toFixed(1)}-${b.fim.toFixed(1)}s tom ${sinal(b.pitch)}`).join(', '));
  }
  const usados = blocos ? [...new Set(blocos.map((b) => b.pitch))] : [pitch];
  let tons = null;
  if (usados.length === 1) {
    // a música inteira cabe numa oitava só: conversão comum
    pitch = usados[0];
    blocos = null;
    job.emit('voz', 50, `Trocando a voz (${nome}, tom ${sinal(pitch)})…`);
    await converter(job, voz, pitch, prep.entrada, out);
  } else {
    // uma conversão inteira por oitava (ficam na pasta) e a emenda delas no arquivo principal
    tons = [];
    for (const [i, tom] of usados.entries()) {
      const arq = path.join(dir, `${titulo} (voz ${nome} tom ${sinal(tom)}${suf}).wav`);
      job.emit('voz', 50 + Math.round((i * 35) / usados.length), `Trocando a voz (${nome}, tom ${sinal(tom)})…`);
      await converter(job, voz, tom, prep.entrada, arq);
      tons.push({ pitch: tom, file: arq });
    }
    job.emit('voz', 86, 'Emendando os tons, frase a frase…');
    out = await emendarTons(job, dir, blocos, tons, out);
  }
  if (!fs.existsSync(out)) throw new Error('O Applio terminou sem gerar o arquivo de voz.');

  // Faixa extra: mais uma versão inteira noutro tom, na mesma rodada (ex.: 0 e −12, cada uma num arquivo).
  // Se esse tom já saiu inteiro pelos dois tons, reaproveita; se é o tom do arquivo principal, não repete.
  let extra = null;
  const tomExtra = Math.max(-24, Math.min(24, Math.round(Number(voz.tomExtra))));
  if (voz.tomExtraLigado && Number.isFinite(tomExtra)) {
    const pronta = (tons || []).find((t) => t.pitch === tomExtra);
    if (pronta) extra = { pitch: tomExtra, file: pronta.file };
    else if (!(usados.length === 1 && usados[0] === tomExtra)) {
      const arq = path.join(dir, `${titulo} (voz ${nome} tom ${sinal(tomExtra)}${suf}).wav`);
      job.emit('voz', 87, `Trocando a voz também no tom ${sinal(tomExtra)} (faixa extra)…`);
      await converter(job, voz, tomExtra, prep.entrada, arq);
      extra = { pitch: tomExtra, file: arq };
    }
  }

  // Instrumental e coro no mesmo tom da voz nova, sempre em arquivos separados.
  const rotulo = desvio ? ` tom ${sinal(desvio)}` : '';
  let instrumental = null;
  let coro = null;
  if (desvio && st.instrumental && fs.existsSync(st.instrumental)) {
    job.emit('voz', 88, `Levando o instrumental para o tom da voz (${sinal(desvio)})…`);
    instrumental = path.join(dir, `${titulo} (instrumental${rotulo}${suf}).wav`);
    await mudarTom(job, st.instrumental, instrumental, desvio);
  }
  let coroVoz = null;
  let coroTons = null;
  if (prep.coro) {
    const db = await volumeMedio(job, prep.coro);
    if (db != null && db > -45) {   // coro praticamente mudo não vira arquivo
      coro = path.join(dir, `${titulo} (coro${rotulo}${suf}).wav`);
      if (desvio) await mudarTom(job, prep.coro, coro, desvio);
      else fs.copyFileSync(prep.coro, coro);

      if (voz.coroNaVoz) {
        // o coro passa pelo mesmo modelo, nos mesmos tons e com a mesma emenda da voz principal
        coroTons = [];
        for (const [i, tom] of usados.entries()) {
          job.emit('voz', 90 + Math.round((i * 8) / usados.length), `Passando o coro para a voz ${nome} (tom ${sinal(tom)})…`);
          const arq = path.join(work(dir), `coro_${n + 1}_${nome}_tom_${tom}.wav`);
          await converter(job, voz, tom, prep.coro, arq);
          coroTons.push({ pitch: tom, file: arq });
        }
        const destino = path.join(dir, `${titulo} (coro ${nome}${suf}).wav`);
        coroVoz = usados.length === 1
          ? await porNoLugar(coroTons[0].file, destino)
          : await emendarTons(job, dir, blocos, coroTons, destino);
      }
    }
  }

  // sobras de uma troca anterior desta mesma voz, em outro tom
  const mesma = (v) => v.variacao === n && v.modelo === nome;   // a troca anterior desta variação com este modelo
  const antiga = (meta.vozes || []).find(mesma);
  const novos = [instrumental, coro, coroVoz, ...(tons || []).map((t) => t.file), extra && extra.file];
  for (const velho of antiga ? [antiga.instrumental, antiga.coro, antiga.coroVoz, ...(antiga.tons || []).map((t) => t.file), antiga.extra && antiga.extra.file] : []) {
    if (velho && !novos.includes(velho)) fs.rmSync(velho, { force: true });
  }
  const vozes = (meta.vozes || []).filter((v) => !mesma(v));
  vozes.push({ file: out, modelo: nome, variacao: n, pitch, base, tomAuto, tomInstrumental: desvio, instrumental, coro, coroVoz, coroTons, tons, blocos, frases, extra,
    centroModelo: medida ? medida.modelo.centro : Number(voz.centroModelo) || 0 });
  saveMeta(dir, { vozes });
  job.emit('voz', 100, 'Voz trocada');
  return out;
}

// Troca a voz com o modelo principal e, se houver, com o segundo (voz.segundo): sai uma faixa inteira de
// cada um, na mesma rodada. O preparo do vocal é feito uma vez só e serve aos dois.
async function trocarVozes(job, dir, n, voz) {
  const out = await trocarVozInterno(job, dir, n, voz);
  const s = voz.segundo;
  if (s && s.pth && s.pth !== voz.pth) await trocarVozInterno(job, dir, n, { ...voz, ...s, segundo: null });
  return out;
}

// Refaz a emenda com o tom que o usuário escolheu para cada frase (escolhas[i] vale para a frase i).
// As versões inteiras de cada tom já estão na pasta; só converte de novo se faltar a de algum tom.
async function reemendar(dir, n, escolhas, voz, onEvent, ctl = {}, modelo = null) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  const meta = readMeta(dir);
  const atual = (meta.vozes || []).filter((v) => v.variacao === n && (!modelo || v.modelo === modelo)).pop();
  // trocas feitas antes de as frases serem guardadas têm só os blocos: cada bloco vale como uma frase
  const medidas = atual && (atual.frases && atual.frases.length ? atual.frases : atual.blocos);
  if (!medidas || !medidas.length) {
    throw new Error('Esta voz não tem as frases medidas. Troque a voz de novo com "Dois tons por frase" ligado.');
  }
  const st = (meta.stemsList || [meta.stems || null])[n];
  const titulo = limpo(meta.title);
  const suf = n === 0 ? '' : ' ' + (n + 1);
  const sinal = (x) => (x > 0 ? '+' + x : String(x));
  const arquivoDoTom = (tom) => path.join(dir, `${titulo} (voz ${atual.modelo} tom ${sinal(tom)}${suf}).wav`);
  const base = atual.base != null ? atual.base : atual.pitch;
  const validos = [base - 12, base, base + 12].filter((x) => Math.abs(x) <= 24);
  const frases = medidas.map((f, i) => {
    const tom = Math.round(Number(escolhas && escolhas[i]));
    return { ...f, pitch: validos.includes(tom) ? tom : f.pitch };
  });

  let tons = (atual.tons || []).filter((t) => fs.existsSync(t.file));
  if (!tons.length) {
    // a música tinha saído inteira num tom só: o arquivo principal vira a versão desse tom
    const arq = arquivoDoTom(atual.pitch);
    fs.copyFileSync(atual.file, arq);
    tons = [{ pitch: atual.pitch, file: arq }];
  }
  const usados = [...new Set(frases.map((f) => f.pitch))];
  const faltam = usados.filter((tom) => !tons.some((t) => t.pitch === tom));
  let prep = null;
  if (faltam.length) {
    if (!voz || !voz.pth) throw new Error('Escolha o modelo de voz para converter o tom que falta.');
    const nome = limpo(voz.nome || path.basename(voz.pth, '.pth'), 30);
    if (nome !== atual.modelo) throw new Error(`Esta voz foi feita com o modelo ${atual.modelo}. Escolha esse modelo para converter o tom que falta.`);
    if (!st || !st.vocals) throw new Error('O vocal separado desta gravação não está mais na pasta.');
    const py = applioPython(voz.applioDir);
    need(py, 'o Python do Applio');
    need(voz.pth, 'o modelo de voz (.pth)');
    prep = await prepararVocal(job, dir, st.vocals, n, voz);
    for (const [i, tom] of faltam.entries()) {
      const arq = arquivoDoTom(tom);
      job.emit('voz', 50 + Math.round((i * 35) / faltam.length), `Convertendo a versão em tom ${sinal(tom)}…`);
      await converter(job, voz, tom, prep.entrada, arq);
      tons.push({ pitch: tom, file: arq });
    }
  }

  job.emit('voz', 88, 'Emendando os tons, frase a frase…');
  const blocos = blocosDe(frases);
  const final = usados.length === 1
    ? await porNoLugar(tons.find((t) => t.pitch === usados[0]).file, atual.file)
    : await emendarTons(job, dir, blocos, tons, atual.file);

  // o coro na voz do modelo segue a mesma emenda; se faltar a versão de algum tom e não houver como
  // converter agora, ele fica como estava
  let coroVoz = atual.coroVoz || null;
  let coroTons = (atual.coroTons || []).filter((t) => fs.existsSync(t.file));
  if (coroVoz && coroTons.length) {
    for (const tom of usados.filter((x) => !coroTons.some((t) => t.pitch === x))) {
      if (!prep || !prep.coro) break;
      const arq = path.join(work(dir), `coro_${n + 1}_${atual.modelo}_tom_${tom}.wav`);
      job.emit('voz', 92, `Passando o coro para o tom ${sinal(tom)}…`);
      await converter(job, voz, tom, prep.coro, arq);
      coroTons.push({ pitch: tom, file: arq });
    }
    if (usados.every((x) => coroTons.some((t) => t.pitch === x))) {
      coroVoz = usados.length === 1
        ? await porNoLugar(coroTons.find((t) => t.pitch === usados[0]).file, coroVoz)
        : await emendarTons(job, dir, blocos, coroTons, coroVoz);
    } else {
      job.log('coro na voz: falta a versão de um tom e não há como converter agora; o coro ficou como estava');
    }
  }

  const vozes = (meta.vozes || []).map((v) => (v !== atual ? v : {
    ...v, file: final, coroVoz, coroTons, base, frases, tons, blocos: usados.length === 1 ? null : blocos, pitch: usados.length === 1 ? usados[0] : base,
  }));
  saveMeta(dir, { vozes });
  job.emit('voz', 100, 'Emenda refeita');
  job.emit('fim', 100, 'Tudo pronto');
  return comDir(dir, readMeta(dir));
}

async function trocarVoz(dir, index, voz, onEvent, ctl = {}) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  await trocarVozes(job, dir, index, voz);
  job.emit('fim', 100, 'Tudo pronto');
  return comDir(dir, readMeta(dir));
}

// ---------- criar do zero, planejar e continuar ----------

function tituloDe(opts) {
  if (opts.title && opts.title.trim()) return opts.title.trim();
  const linha = String(opts.lyrics || '').split(/\n/).map((l) => l.trim()).find((l) => l && !/^\[.*\]$/.test(l));
  return linha ? linha.slice(0, 50) : (opts.instrumental ? 'Instrumental' : 'Música nova');
}
function duracaoPedida(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10) throw new Error('A duração precisa ter pelo menos 10 segundos.');
  return Math.min(n, MAX_SECONDS);
}

// Cria a pasta de uma música feita do zero (sem música de origem).
function novaOriginal(opts) {
  const novo = newJobDir();
  const title = tituloDe(opts);
  const dir = nomearPasta(novo.dir, novo.id, title);
  const meta = {
    id: novo.id, kind: 'original', title, duration: duracaoPedida(opts.duration),
    lyrics: opts.instrumental ? '' : (opts.lyrics || ''), abc: opts.abc || '',
    cot: opts.cot || 'full', instrumental: !!opts.instrumental, status: 'analisado',
  };
  saveMeta(dir, meta);
  return { dir, meta };
}

// Planejar: o motor escreve a partitura (melodia e acordes) sem gravar áudio. Leva segundos.
// opts: { title, style, lyrics, cot: 'full'|'melody', duration, instrumental, lmSeed }
async function planejar(opts, onEvent, ctl = {}) {
  need(paths.yuePlan, 'yue-plan.exe');
  need(models.backbone, 'o modelo YuE2');
  if (!opts.style || !opts.style.trim()) throw new Error('Escolha uma voz ou escreva um estilo.');
  if (!opts.instrumental && !(opts.lyrics || '').trim()) throw new Error('Escreva a letra antes de planejar.');
  const { dir, meta } = novaOriginal({ ...opts, cot: opts.cot === 'melody' ? 'melody' : 'full' });
  const job = new Job(dir, onEvent);
  ctl.job = job;
  try {
    const w = work(dir);
    const style = opts.instrumental && !/\binstrumental\b/i.test(opts.style) ? 'instrumental, ' + opts.style.trim() : opts.style.trim();
    const reqFile = path.join(w, 'plano.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      style, lyrics: opts.instrumental ? '[instrumental]\n' : opts.lyrics, cot: meta.cot, duration: meta.duration,
    }, null, 2), 'utf8');
    const out = path.join(dir, 'partitura.abc');
    job.emit('partitura', 0, 'Escrevendo a partitura…');
    await run(job, paths.yuePlan, ['--model', models.backbone, '--request', reqFile, '--out', out], {
      onLine: (l) => {
        const m = l.match(/\[AR\] Score (\d+)\/(\d+)/);
        if (m) job.emit('partitura', Math.min(95, Math.round((m[1] / 900) * 100)), 'Escrevendo a partitura…');
      },
    });
    const abc = fs.readFileSync(out, 'utf8');
    if (!abc.trim()) throw new Error('O motor não escreveu a partitura.');
    saveMeta(dir, { abc, style, status: 'planejado' });
    job.emit('partitura', 100, 'Partitura pronta');
    return comDir(dir, readMeta(dir));
  } catch (e) {
    saveMeta(dir, { status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message });
    throw e;
  }
}

// Criar do zero: estilo + letra (ou instrumental). Com opts.dir, usa a pasta de um plano já feito.
// opts: { dir?, title, style, lyrics, cot, duration, instrumental, abc, ...opções de gravação }
async function compor(opts, onEvent, ctl = {}) {
  let dir = opts.dir;
  if (!dir || !fs.existsSync(path.join(dir, 'job.json'))) dir = novaOriginal(opts).dir;
  return generate(dir, { ...opts, duration: duracaoPedida(opts.duration) }, onEvent, ctl);
}

// Continuar: um trecho de uma música real abre a gravação e o motor compõe o resto.
// opts: { url | file, start, end (trecho mantido), duration (total), style, lyrics, ...opções de gravação }
async function continuar(opts, onEvent, ctl = {}) {
  let { id, dir } = newJobDir();
  const job = new Job(dir, onEvent);
  ctl.job = job;
  try {
    need(paths.yueTokenize, 'yue-tokenize.exe');
    need(models.tokenizer, 'o modelo que ouve o áudio (tokenizer)');
    need(models.mert, 'o modelo MERT');
    const total = duracaoPedida(opts.duration);
    if (!opts.style || !opts.style.trim()) throw new Error('Escolha uma voz ou escreva um estilo.');
    if (!(opts.lyrics || '').trim()) throw new Error('Escreva a letra: a do trecho e a da continuação.');

    const src = opts.url
      ? await download(job, opts.url, work(dir))
      : await importLocal(job, opts.file, work(dir));
    job.check();
    const titulo = src.title + ' (continuação)';
    dir = nomearPasta(dir, id, titulo);
    job.setDir(dir);
    const w = work(dir);

    const start = Math.max(0, Number(opts.start) || 0);
    const end = opts.end != null && opts.end !== '' ? Number(opts.end) : start + 20;
    const fonte = path.join(w, 'fonte.mp3');
    await trim(job, path.join(w, src.name), fonte, start, end);
    const trecho = await probeDuration(job, fonte);
    if (trecho < 3) throw new Error('O trecho de origem é curto demais (mínimo 3 segundos).');
    if (trecho >= total - 5) throw new Error('A duração total precisa ser maior que o trecho de origem.');

    job.emit('partitura', 0, 'Ouvindo o trecho de origem…');
    const codigos = path.join(w, 'codigos.csv');
    await run(job, paths.yueTokenize, ['--model', models.tokenizer, '--audio', fonte, '--out', codigos]);
    job.emit('partitura', 100, 'Trecho ouvido');

    saveMeta(dir, {
      id, kind: 'continuacao', title: titulo, source: opts.url || opts.file, fonte, codigos,
      duration: total, trecho, start, end, lyrics: opts.lyrics, abc: '', cot: 'off', status: 'analisado',
    });
    job.check();
    return await generate(dir, { ...opts, duration: total }, onEvent, ctl);
  } catch (e) {
    try { saveMeta(dir, { id, status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message }); } catch {}
    throw e;
  }
}

// ---------- fala (texto -> voz) ----------
// O texto é lido por um leitor local (Kokoro, em tts-env): sem internet e sem serviço de terceiros.
// (O leitor que vem no Applio usa um serviço da Microsoft que passou a recusar conexão, erro 403.)
// Com "converter", a leitura passa depois pelo modelo de voz do Applio.
// Com leitor "clone", quem lê é o Chatterbox, imitando a voz e o jeito de falar de uma gravação curta
// (referencia); aí o ritmo e a entonação saem da pessoa, não de uma voz pronta.
// opts: { texto, leitor ('kokoro'|'clone'), vozBase, referencia, lingua, emocao (0.25..1), velocidade (-50..50, em %),
//         converter, voz:{...ajustes do Applio} }
async function falar(opts, onEvent, ctl = {}) {
  const texto = String(opts.texto || '').trim();
  if (!texto) throw new Error('Escreva o texto que vai ser falado.');
  const clone = opts.leitor === 'clone';
  const referencia = opts.referencia || models.referenciaPadrao;
  if (clone) {
    need(paths.clonePython, 'a fala com voz clonada (clone-env)');
    need(referencia, 'a gravação da sua voz (referência)');
  } else {
    need(paths.ttsPython, 'o leitor de texto (tts-env)');
    need(models.kokoro, 'o modelo do leitor de texto');
  }
  const converter = !!opts.converter;
  const voz = opts.voz || {};
  if (converter) {
    if (!voz.pth) throw new Error('Escolha um modelo de voz em Ajustes, "Voz (Applio)".');
    need(applioPython(voz.applioDir || ''), 'o Python do Applio');
    need(voz.pth, 'o modelo de voz (.pth)');
  }

  const novo = newJobDir();
  const titulo = 'Fala - ' + texto.replace(/\s+/g, ' ').slice(0, 40);
  const dir = nomearPasta(novo.dir, novo.id, titulo);
  const job = new Job(dir, onEvent);
  ctl.job = job;
  try {
    const w = work(dir);
    fs.writeFileSync(path.join(dir, 'texto.txt'), texto, 'utf8');
    const vozBase = opts.vozBase || 'pm_alex';
    const apelido = clone ? 'Minha voz'
      : limpo((vozBase.split('_')[1] || vozBase).replace(/^./, (c) => c.toUpperCase()), 30);
    const velocidade = 1 + Math.max(-50, Math.min(50, Number(opts.velocidade) || 0)) / 100;
    const base = converter ? path.join(w, 'fala-base.wav') : path.join(dir, limpo(titulo) + ' (voz ' + apelido + ').wav');

    if (clone) {
      const lingua = /^[a-z]{2}$/.test(opts.lingua || '') ? opts.lingua : 'en';
      const emocao = Math.max(0.25, Math.min(1, Number(opts.emocao) || 0.5));
      const cru = Math.abs(velocidade - 1) < 0.01 ? base : path.join(w, 'fala-clone.wav');
      job.emit('voz', 0, 'Lendo o texto com a sua voz… (na primeira vez baixa o modelo, uns minutos)');
      const msg = (l) => {
        const m = /trecho (\d+)\/(\d+)/.exec(l);
        if (m) job.emit('voz', Math.round((converter ? 45 : 90) * (m[1] - 1) / m[2]), 'Lendo com a sua voz: trecho ' + m[1] + ' de ' + m[2] + '…');
      };
      await run(job, paths.clonePython, [
        '-I', paths.clonarScript, '--texto', path.join(dir, 'texto.txt'), '--referencia', referencia,
        '--lingua', lingua, '--exagero', emocao.toFixed(2), '--modelos', models.chatterboxDir, '--saida', cru,
      ], { onLine: msg });
      if (!fs.existsSync(cru)) throw new Error('A voz clonada terminou sem gerar o áudio.');
      // o Chatterbox não tem velocidade própria: o ffmpeg acelera ou desacelera sem mudar o tom
      if (cru !== base) {
        await run(job, paths.ffmpeg, ['-y', '-v', 'error', '-i', cru, '-filter:a', 'atempo=' + velocidade.toFixed(2), base]);
      }
    } else {
      job.emit('voz', 0, 'Lendo o texto (' + apelido + ')…');
      await run(job, paths.ttsPython, [
        '-I', paths.falarScript, '--modelo', models.kokoro, '--vozes', models.kokoroVozes,
        '--texto', path.join(dir, 'texto.txt'), '--voz', vozBase, '--velocidade', velocidade.toFixed(2), '--saida', base,
      ]);
    }
    if (!fs.existsSync(base)) throw new Error('O leitor terminou sem gerar o áudio.');

    let final = base;
    let estilo = 'fala ' + apelido;
    if (converter) {
      const nome = limpo(voz.nome || path.basename(voz.pth, '.pth'), 30);
      final = path.join(dir, limpo(titulo) + ' (voz ' + nome + ').wav');
      job.emit('voz', 50, 'Trocando a voz (' + nome + ')…');
      await run(job, applioPython(voz.applioDir), argsInfer(voz, base, final), { cwd: voz.applioDir });
      if (!fs.existsSync(final)) throw new Error('O Applio terminou sem gerar a fala convertida.');
      await formanteDepois(job, voz, final);      estilo = 'fala ' + nome + ' (lida por ' + apelido + ')';
    }
    saveMeta(dir, {
      id: novo.id, kind: 'fala', title: titulo, covers: [final], lyrics: texto,
      style: estilo, status: 'pronto', finishedAt: new Date().toISOString(),
    });
    job.emit('fim', 100, 'Tudo pronto');
    return comDir(dir, readMeta(dir));
  } catch (e) {
    saveMeta(dir, { id: novo.id, kind: 'fala', title: titulo, status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message });
    throw e;
  }
}

// ---------- modo "só trocar a voz" ----------
// Sem regravar nada: baixa (ou importa), separa o instrumental e passa o vocal ORIGINAL no modelo do Applio.
// Saem a voz trocada e o instrumental em arquivos separados.
// opts: { url | file, start, end, preview, voz:{...} }
async function soVoz(opts, onEvent, ctl = {}) {
  let { id, dir } = newJobDir();
  const job = new Job(dir, onEvent);
  ctl.job = job;
  try {
    if (!opts.voz || !opts.voz.pth) throw new Error('Escolha um modelo de voz em "Voz (Applio)".');
    const src = opts.url
      ? await download(job, opts.url, work(dir), 'wav')
      : await importLocal(job, opts.file, work(dir), 'wav');
    job.check();
    dir = nomearPasta(dir, id, src.title);
    job.setDir(dir);
    const w = work(dir);
    const origem = path.join(w, src.name);

    const start = Math.max(0, Number(opts.start) || 0);
    let end = opts.end != null && opts.end !== '' ? Number(opts.end) : null;
    if (opts.preview) end = start + 30;
    let fonte = origem;
    if (start > 0 || end != null) {
      fonte = path.join(w, 'fonte.wav');
      await trim(job, origem, fonte, start, end);
    }
    const duration = await probeDuration(job, fonte);

    // o trecho original fica na pasta, para comparar com o resultado
    const original = path.join(dir, `${limpo(src.title)} (original)${path.extname(fonte)}`);
    fs.copyFileSync(fonte, original);
    saveMeta(dir, {
      id, kind: 'voz', title: src.title, source: opts.url || opts.file, fonte,
      duration, start, end, covers: [original], status: 'separando',
    });

    const stems = await separateNamed(job, dir, fonte, src.title, 0);
    saveMeta(dir, { stems, stemsList: [stems] });
    await trocarVozes(job, dir, 0, opts.voz);

    saveMeta(dir, {
      status: 'pronto', style: `voz ${opts.voz.nome || 'trocada'}`, finishedAt: new Date().toISOString(),
    });
    job.emit('fim', 100, 'Tudo pronto');
    return comDir(dir, readMeta(dir));
  } catch (e) {
    saveMeta(dir, { id, status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message });
    throw e;
  }
}

// Amostra de um modelo de voz: uma frase lida pelo leitor local e passada no modelo. Serve para escolher
// modelo de ouvido na biblioteca. Tudo fica em `pasta` (dados do app), nada vai para o histórico.
// voz: { applioDir, pth, index }   vozBase: voz do leitor (ex.: pf_dora para modelo feminino)
async function amostra(voz, destino, vozBase, onEvent, ctl = {}) {
  need(paths.ttsPython, 'o leitor de texto (tts-env)');
  need(models.kokoro, 'o modelo do leitor de texto');
  need(applioPython(voz.applioDir || ''), 'o Python do Applio');
  need(voz.pth, 'o modelo de voz (.pth)');
  const pasta = path.dirname(destino);
  fs.mkdirSync(pasta, { recursive: true });
  const job = new Job(pasta, onEvent);
  ctl.job = job;
  const base = path.join(pasta, 'base-' + vozBase + '.wav');
  if (!fs.existsSync(base)) {
    const texto = path.join(pasta, 'frase.txt');
    fs.writeFileSync(texto, 'Oi, tudo bem? Essa é a minha voz. Escuta como eu falo baixinho, e como eu falo mais animada, bem alto! Gostou?', 'utf8');
    await run(job, paths.ttsPython, [
      '-I', paths.falarScript, '--modelo', models.kokoro, '--vozes', models.kokoroVozes,
      '--texto', texto, '--voz', vozBase, '--velocidade', '1.00', '--saida', base,
    ]);
    if (!fs.existsSync(base)) throw new Error('O leitor terminou sem gerar o áudio da amostra.');
  }
  const ajustes = { pitch: 0, f0: 'rmvpe', indexRate: 0.55, volumeEnvelope: 1, protect: 0.2, embedder: 'contentvec' };
  await run(job, applioPython(voz.applioDir), argsInfer({ ...ajustes, ...voz }, base, destino), { cwd: voz.applioDir });
  if (!fs.existsSync(destino)) throw new Error('O Applio terminou sem gerar a amostra.');
  return destino;
}

// ---------- karaokê ----------
// Prepara uma música para cantar: baixa, tira a voz principal (o coro fica, como em karaokê de verdade, ou sai
// junto se semCoro), busca a letra sincronizada e mede o tom. Música já preparada pelo mesmo link é reaproveitada.
// opts: { url | file, semCoro }
const letra = require('./letra');

function karaokePronto(fonte, semCoro) {
  let pastas = [];
  try { pastas = fs.readdirSync(paths.outDir); } catch { return null; }
  for (const p of pastas) {
    const dir = path.join(paths.outDir, p);
    try {
      const m = readMeta(dir);
      if (m.kind === 'karaoke' && m.status === 'pronto' && m.source === fonte && !!m.semCoro === !!semCoro
        && fs.existsSync(m.instrumental)) return comDir(dir, m);
    } catch {}
  }
  return null;
}

// Mede tom e atraso da letra (sep-env). Falhar aqui não impede de cantar.
async function karaokeAnalisar(job, dir, { instrumental, vocal, linhas, melodia }) {
  if (!fs.existsSync(paths.sepPython)) return {};
  const args = [paths.karaokeAnalise];
  if (instrumental) args.push('--instrumental', instrumental);
  if (vocal && melodia) args.push('--vocal', vocal, '--melodia', melodia);
  if (vocal && linhas && linhas.length) {
    const tempos = path.join(work(dir), 'tempos-letra.json');
    fs.writeFileSync(tempos, JSON.stringify(linhas.filter((l) => l.texto).map((l) => l.t)));
    if (!args.includes('--vocal')) args.push('--vocal', vocal);
    args.push('--tempos', tempos);
  }
  let res = {};
  try {
    await run(job, paths.sepPython, args, { onLine: (l) => { if (l.startsWith('ANALISE ')) { try { res = JSON.parse(l.slice(8)); } catch {} } } });
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    job.log('análise do karaokê falhou: ' + (e && e.message));
  }
  return res;
}

async function karaoke(opts, onEvent, ctl = {}) {
  const fonte = opts.url || opts.file;
  const pronto = karaokePronto(fonte, opts.semCoro);
  if (pronto) return pronto;
  let { id, dir } = newJobDir();
  const job = new Job(dir, onEvent);
  ctl.job = job;
  try {
    // artista e nome da música, quando o vídeo traz: ajudam a achar a letra certa
    const info = { artista: '', faixa: '', duracao: 0 };
    if (opts.url) {
      job.emit('download', 0, 'Lendo o link…');
      const arq = path.join(work(dir), 'info.txt');
      try {
        await run(job, paths.ytdlp, ['--no-playlist', '--skip-download', '--print-to-file',
          '%(artist,creator|)s\t%(track|)s\t%(duration|0)s', arq, opts.url]);
        const [a, f, d] = fs.readFileSync(arq, 'utf8').trim().split('\t');
        Object.assign(info, { artista: (a || '').split(',')[0].trim(), faixa: (f || '').trim(), duracao: Number(d) || 0 });
      } catch (e) {
        if (e instanceof Cancelled) throw e;
      }
    }
    const src = opts.url
      ? await download(job, opts.url, work(dir), 'wav')
      : await importLocal(job, opts.file, work(dir), 'wav');
    job.check();
    dir = nomearPasta(dir, id, src.title + ' karaokê');
    job.setDir(dir);
    const w = work(dir);
    const origem = path.join(w, src.name);
    const duration = await probeDuration(job, origem);
    saveMeta(dir, { id, kind: 'karaoke', title: src.title, source: fonte, duration, semCoro: !!opts.semCoro, covers: [], status: 'separando' });

    // separação: com coro = modelo de karaokê na música inteira (tira só a voz principal)
    let instr = null;
    let vocal = null;
    if (!opts.semCoro && temModelo(separator.coroModel)) {
      const arqs = await passadaAux(job, dir, origem, separator.coroModel, path.join(w, 'karaoke'), [], 0, 100, 'Tirando a voz principal…');
      if (arqs) {
        instr = arqs.find((f) => /\(Instrumental\)/i.test(path.basename(f)));
        vocal = arqs.find((f) => /\(Vocals\)/i.test(path.basename(f)));
      }
    }
    if (!instr || !vocal) {
      const st = await separate(job, origem, path.join(w, 'stems'), 'separar');
      instr = st.instrumental;
      vocal = st.vocals;
    }
    const t = limpo(src.title);
    const instrumental = path.join(dir, `${t} (instrumental karaokê).wav`);
    const guia = path.join(dir, `${t} (voz original).wav`);
    fs.renameSync(instr, instrumental);
    fs.renameSync(vocal, guia);

    job.emit('letra', 0, 'Procurando a letra…');
    let achada = null;
    try {
      achada = await letra.buscar({ artista: info.artista, faixa: info.faixa, titulo: src.title, duracao: info.duracao || duration });
    } catch (e) {
      job.log('letra: ' + e.message);
    }
    job.emit('letra', 50, 'Medindo o tom da música…');
    const melodia = path.join(w, 'melodia.json');
    const an = await karaokeAnalisar(job, dir, { instrumental, vocal: guia, linhas: achada && achada.linhas, melodia });
    if (achada && achada.linhas.length) {
      fs.writeFileSync(path.join(dir, 'letra.lrc'),
        achada.linhas.map((l) => `[${p2(Math.floor(l.t / 60))}:${(l.t % 60).toFixed(2).padStart(5, '0')}]${l.texto}`).join('\n'), 'utf8');
    } else if (achada && achada.simples) {
      fs.writeFileSync(path.join(dir, 'letra.txt'), achada.simples, 'utf8');
    }
    saveMeta(dir, {
      status: 'pronto', style: 'karaokê', instrumental, guia, letra: achada, tom: an.tom || null,
      melodia: fs.existsSync(melodia) ? melodia : null, transpor: 0,
      atraso: Number(an.atraso) || 0, atrasoMedido: Number(an.atraso) || 0, finishedAt: new Date().toISOString(),
    });
    job.emit('fim', 100, 'Pronta para cantar');
    return comDir(dir, readMeta(dir));
  } catch (e) {
    saveMeta(dir, { id, kind: 'karaoke', status: e instanceof Cancelled ? 'cancelado' : 'erro', error: e.message });
    throw e;
  }
}

// Busca a letra de novo (pela pessoa digitando nome e artista) e remede o atraso.
async function karaokeLetra(dir, busca, onEvent, ctl = {}) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  const m = readMeta(dir);
  job.emit('letra', 0, 'Procurando a letra…');
  const achada = await letra.buscar({ busca, duracao: m.duration });
  if (!achada) throw new Error('Não achei letra para "' + busca + '".');
  job.emit('letra', 50, 'Acertando o tempo da letra…');
  const an = await karaokeAnalisar(job, dir, { vocal: m.guia, linhas: achada.linhas });
  saveMeta(dir, { letra: achada, atraso: Number(an.atraso) || 0, atrasoMedido: Number(an.atraso) || 0 });
  return comDir(dir, readMeta(dir));
}

// Melodia da voz original, para a régua de afinação. Músicas preparadas antes dela existir medem na primeira vez.
async function karaokeMelodia(dir, onEvent, ctl = {}) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  const m = readMeta(dir);
  if (m.melodia && fs.existsSync(m.melodia)) return m.melodia;
  const melodia = path.join(work(dir), 'melodia.json');
  job.emit('melodia', 0, 'Medindo a melodia da voz e conferindo o tom…');
  // de quebra remede o tom com a melodia junto (a medição antiga só ouvia o instrumental)
  const an = await karaokeAnalisar(job, dir, { instrumental: m.instrumental, vocal: m.guia, melodia });
  if (!fs.existsSync(melodia)) throw new Error('Não consegui medir a melodia desta música.');
  saveMeta(dir, { melodia, ...(an.tom ? { tom: an.tom } : {}) });
  return melodia;
}

// Muda o tom da música para cantar: instrumental e voz guia transpostos em semitons, com o mesmo rubberband
// da troca de voz. O instrumental no tom novo fica na pasta da música (é o que vai para o FL junto da
// gravação); a guia fica em _trabalho. Cada tom é feito uma vez e reaproveitado.
async function karaokeTom(dir, semitons, onEvent, ctl = {}) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  const m = readMeta(dir);
  const s = Math.max(-7, Math.min(7, Math.round(Number(semitons) || 0)));
  if (!s) {
    saveMeta(dir, { transpor: 0 });
    return { instrumental: m.instrumental, guia: m.guia, transpor: 0 };
  }
  const marca = (s > 0 ? '+' : '') + s;
  const instrumental = path.join(dir, `${limpo(m.title)} (instrumental karaokê tom ${marca}).wav`);
  const guia = path.join(work(dir), `guia tom ${marca}.wav`);
  const fazer = async (origem, destino, ini, texto) => {
    if (fs.existsSync(destino)) return;
    job.emit('tom', ini, texto);
    // nome provisório: um tom cortado no meio não é confundido com pronto
    const parcial = destino.replace(/\.wav$/i, '.parcial.wav');
    await mudarTom(job, origem, parcial, s);
    fs.renameSync(parcial, destino);
  };
  await fazer(m.instrumental, instrumental, 0, `Passando a música para o tom ${marca}…`);
  if (m.guia && fs.existsSync(m.guia)) await fazer(m.guia, guia, 70, 'Passando a voz guia para o tom novo…');
  saveMeta(dir, { transpor: s });
  return { instrumental, guia: fs.existsSync(guia) ? guia : m.guia, transpor: s };
}

// A aba "Separar vocal" aceita arquivo do PC ou link, como a mesa.
function fonteDeSeparacao(origem) {
  if (typeof origem === 'string' && origem.trim()) return { file: origem };
  if (origem && origem.file) return { file: origem.file };
  if (origem && origem.url && origem.url.trim()) return { url: origem.url.trim() };
  throw new Error('Escolha um arquivo ou cole um link.');
}

// Com link, baixa primeiro (em wav) e só depois dá o nome da música à pasta.
async function prepararSeparacao(fonte, onEvent, ctl, sufixo) {
  const novo = newJobDir();
  const job = new Job(novo.dir, onEvent);
  ctl.job = job;
  let titulo = fonte.file ? path.basename(fonte.file, path.extname(fonte.file)) : '';
  let baixado = null;
  if (fonte.url) {
    const src = await download(job, fonte.url, work(novo.dir), 'wav');
    job.check();
    titulo = src.title;
    baixado = src.name;
  }
  const dir = nomearPasta(novo.dir, novo.id, titulo + sufixo);
  job.setDir(dir);
  const file = baixado ? path.join(work(dir), baixado) : fonte.file;
  return { id: novo.id, job, dir, file, titulo };
}

// Separa vocal/instrumental de qualquer arquivo de áudio (função avulsa).
async function separateOnly(origem, onEvent, ctl = {}) {
  const fonte = fonteDeSeparacao(origem);
  const { id, job, dir, file, titulo } = await prepararSeparacao(fonte, onEvent, ctl, ' separada');
  const stems = await separateNamed(job, dir, file, titulo, 0);
  saveMeta(dir, { id, status: 'pronto', title: titulo, source: fonte.url || fonte.file, stems, kind: 'separacao' });
  return { dir, stems };
}

// Separa por instrumento com o Demucs de 6 faixas: voz, bateria, baixo, guitarra, piano e o resto.
// O modelo (~50 MB) baixa sozinho na primeira vez, na pasta dos modelos de separação.
const INSTRUMENTOS = [
  ['Vocals', 'voz', 'Voz'], ['Drums', 'bateria', 'Bateria'], ['Bass', 'baixo', 'Baixo'],
  ['Guitar', 'guitarra', 'Guitarra'], ['Piano', 'piano', 'Piano'], ['Other', 'outros', 'Outros'],
];
async function separarInstrumentos(origem, onEvent, ctl = {}) {
  need(paths.separator, 'o separador de vocal (sep-env)');
  const fonte = fonteDeSeparacao(origem);
  const { id, job, dir, file, titulo } = await prepararSeparacao(fonte, onEvent, ctl, ' por instrumento');
  const tmp = path.join(work(dir), 'instrumentos');
  fs.mkdirSync(tmp, { recursive: true });
  job.emit('separar', 0, 'Separando por instrumento (na primeira vez baixa o modelo)…');
  await run(job, paths.separator, [
    file, '--model_filename', 'htdemucs_6s.yaml', '--model_file_dir', paths.separatorModelsDir,
    '--output_dir', tmp, '--output_format', 'WAV',
  ], {
    onLine: (l) => {
      const m = l.match(/(\d+)%\|/);
      if (m) job.emit('separar', parseInt(m[1], 10), 'Separando por instrumento…');
    },
  });
  const arquivos = fs.readdirSync(tmp);
  const faixas = [];
  for (const [chave, nome, rotulo] of INSTRUMENTOS) {
    const achado = arquivos.find((f) => f.includes(`(${chave})`));
    if (!achado) continue;
    const destino = path.join(dir, `${limpo(titulo)} (${nome}).wav`);
    fs.renameSync(path.join(tmp, achado), destino);
    faixas.push({ nome: rotulo, file: destino });
  }
  if (!faixas.length) throw new Error('O separador não gerou as faixas por instrumento.');
  saveMeta(dir, { id, status: 'pronto', title: titulo, source: fonte.url || fonte.file, faixas, kind: 'instrumentos' });
  return { dir, faixas };
}

// ---------- melodia e acordes em MIDI (src/midi.py, no sep-env) ----------
// Da voz separada sai a melodia; do instrumental, o andamento e os acordes. O .mid fica na pasta da música.
async function midi(dir, n, onEvent, ctl = {}) {
  const job = new Job(dir, onEvent);
  ctl.job = job;
  const meta = readMeta(dir);
  const st = (meta.stemsList && meta.stemsList[n]) || (n === 0 ? meta.stems : null);
  if (!st || !st.vocals) throw new Error('Separe a voz desta gravação antes de tirar o MIDI.');
  need(paths.sepPython, 'o separador de vocal (sep-env)');
  const saida = path.join(dir, `${limpo(meta.title || 'música', 70)} (melodia e acordes).mid`);
  let acordes = '';
  job.emit('midi', 10, 'lendo a melodia e os acordes…');
  await run(job, paths.sepPython, ['-I', paths.midiScript, '--vocal', st.vocals,
    ...(st.instrumental ? ['--instrumental', st.instrumental] : []), '--saida', saida], {
    onLine: (l) => {
      if (l.startsWith('ACORDES ')) acordes = l.slice(8).trim();
      else if (/^lendo/.test(l)) job.emit('midi', 50, l);
    },
  });
  if (!fs.existsSync(saida)) throw new Error('O MIDI não foi gerado.');
  job.emit('midi', 100, 'pronto');
  return { file: saida, acordes };
}

module.exports = {
  midi, separarInstrumentos,
  analyze, generate, planejar, compor, continuar, separateTake, trocarVoz, reemendar, amostra, soVoz, falar, separateOnly,
  karaoke, karaokeLetra, karaokeMelodia, karaokeTom, saveMeta, readMeta,
  Job, Cancelled, formatLyrics, newJobDir, limpo, indiceSeguro,
};
