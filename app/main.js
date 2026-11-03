const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pipeline = require('./src/pipeline');
const { APP_NAME, ROOT, paths, models, separator, motor, MAX_SECONDS, ensureDirs, applioPython } = require('./src/config');

// Dados do Electron (cache, preferências) ficam no D:, junto do projeto, nunca no C:.
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(ROOT, '.dados-app'));
}
app.setName(APP_NAME);

let win = null;
let current = null; // { job } do trabalho em andamento
const dragIcons = {}; // ícone de arrastar por extensão

// ---------- presets ----------
const presetsFile = () => path.join(app.getPath('userData'), 'presets.json');
function readPresets() {
  try { return JSON.parse(fs.readFileSync(presetsFile(), 'utf8')); } catch { return []; }
}
function writePresets(list) {
  fs.mkdirSync(path.dirname(presetsFile()), { recursive: true });
  fs.writeFileSync(presetsFile(), JSON.stringify(list, null, 2));
}

// ---------- preferências (inclui o Applio) ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch {}
  // primeira vez: procura o Applio nos lugares comuns
  if (!c.applioDir) {
    c.applioDir = ['D:\\Applio', 'C:\\Applio', path.join(ROOT, 'Applio'), path.join(ROOT, '..', 'Applio')]
      .find((d) => fs.existsSync(path.join(d, 'core.py'))) || '';
  }
  // padrões novos da troca de voz (proteção 0,33 e áudio em partes): aplicados uma vez a quem já tinha salvo
  if ((c.vozVersao || 0) < 2) {
    if (c.voz) c.voz = { ...c.voz, protect: 0.33, splitAudio: true };
    c.vozVersao = 2;
    try { writeConfig(c); } catch {}
  }
  // tom sozinho e instrumental acompanhando deixaram de ser padrão: desliga uma vez em quem já tinha salvo
  if ((c.vozVersao || 0) < 3) {
    if (c.voz) c.voz = { ...c.voz, tomSozinho: false, instrumentalAcompanha: false };
    c.vozVersao = 3;
    try { writeConfig(c); } catch {}
  }
  // dois tons por frase virou padrão: liga uma vez em quem já tinha salvo
  if ((c.vozVersao || 0) < 4) {
    if (c.voz) c.voz = { ...c.voz, doisTons: true };
    c.vozVersao = 4;
    try { writeConfig(c); } catch {}
  }
  // índice 0,55 e proteção 0,20 viraram padrão (o R curto sumia com 0,75/0,33): aplica uma vez a quem já tinha salvo
  if ((c.vozVersao || 0) < 5) {
    if (c.voz) c.voz = { ...c.voz, indexRate: 0.55, protect: 0.2 };
    c.vozVersao = 5;
    try { writeConfig(c); } catch {}
  }
  return c;
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

// Modelos de voz do Applio: logs\<nome>\<modelo>.pth, com o .index da mesma pasta. Só leitura.
// Modelos com o nome que o usuário deu na biblioteca (apelido). "pastaNome" guarda o nome da pasta no Applio.
function modelosDoUsuario(c) {
  return applioModelos(c.applioDir).map((x) => {
    const apelido = String(((c.biblioteca || {})[x.pth] || {}).apelido || '').trim();
    return { ...x, pastaNome: x.nome, nome: apelido || x.nome };
  });
}
function applioModelos(dir) {
  const out = [];
  const logs = path.join(dir || '', 'logs');
  if (!dir || !fs.existsSync(logs)) return out;
  for (const pasta of fs.readdirSync(logs, { withFileTypes: true })) {
    if (!pasta.isDirectory() || /^(pretraineds?|mute|zips|reference|custom)$/i.test(pasta.name)) continue;
    const base = path.join(logs, pasta.name);
    let arquivos = [];
    try { arquivos = fs.readdirSync(base); } catch { continue; }
    const index = arquivos.find((f) => f.toLowerCase().endsWith('.index'));
    for (const f of arquivos) {
      if (!f.toLowerCase().endsWith('.pth') || /^[GD]_/.test(f)) continue;
      out.push({
        nome: pasta.name, arquivo: f,
        pth: path.join(base, f), index: index ? path.join(base, index) : '',
        treino: fs.existsSync(path.join(base, 'f0_voiced')),   // modelo treinado aqui: dá para medir a altura da voz dele
      });
    }
  }
  return out;
}

// ---------- janela ----------
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(__dirname, 'haze.ico'),
    width: 1240,
    height: 860,
    minWidth: 1120,
    minHeight: 740,
    title: APP_NAME,
    backgroundColor: '#1f1c19',
    autoHideMenuBar: true,
    // testes automáticos rodam com a janela invisível e sem som, para não atrapalhar quem está usando o PC
    show: !process.env.MEUCOVER_SHOT,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Modo de teste visual: MEUCOVER_SHOT=<arquivo.png> tira uma captura da tela e fecha.
  // MEUCOVER_TAB=<mesa|separar|hist|diag> escolhe a aba; MEUCOVER_EVAL=<arquivo.js> roda um roteiro na página.
  if (process.env.MEUCOVER_SHOT) {
    win.webContents.setAudioMuted(true);
    win.webContents.on('console-message', (_e, level, msg, line, src) => {
      if (!/Security Warning/.test(msg)) console.log(`[renderer:${level}] ${msg} (${path.basename(src || '')}:${line})`);
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const tab = process.env.MEUCOVER_TAB;
        if (tab) await win.webContents.executeJavaScript(`document.querySelector('[data-tab="${tab}"]').click()`);
        if (process.env.MEUCOVER_EVAL) {
          await win.webContents.executeJavaScript(fs.readFileSync(process.env.MEUCOVER_EVAL, 'utf8'));
        }
      } catch (e) {
        console.log('[teste] erro no roteiro:', e.message);
      }
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.MEUCOVER_SHOT, img.toPNG());
        console.log('captura salva:', process.env.MEUCOVER_SHOT);
        app.quit();
      }, Number(process.env.MEUCOVER_WAIT) || 2500);
    });
  }
}

app.whenReady().then(async () => {
  ensureDirs();
  try { dragIcons['*'] = await app.getFileIcon(process.execPath, { size: 'normal' }); } catch {}
  createWindow();
  // o app fechou de mau jeito com a voz ligada da última vez? devolve o microfone do Windows
  microfoneDeVolta().catch(() => {});
  // página do celular: liga junto com o app se o usuário deixou marcado (nos testes automáticos, não)
  if (readConfig().celularAuto && !process.env.MEUCOVER_SHOT) celularLigar().then((r) => { if (r.ok) send('celular', { tipo: 'no-ar' }); });
});
app.on('window-all-closed', () => {
  if (current && current.job) current.job.cancel();
  aoVivoDesligar(true);
  microfoneDeVoltaJa();
  if (celularNoAr) { try { celularNoAr.fechar(); } catch {} }
  app.quit();
});

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// Roda um trabalho de cada vez; devolve { ok, data } ou { ok:false, error }.
async function guarded(fn) {
  if (current) return { ok: false, error: 'Já existe um trabalho em andamento.' };
  if (aoVivo) return { ok: false, error: 'A voz ao vivo está ligada e usa a placa de vídeo. Desligue antes de converter.' };
  current = {};
  try {
    return { ok: true, data: await fn(current) };
  } catch (e) {
    if (!(e instanceof pipeline.Cancelled)) guardarErro('trabalho', e.message);
    return { ok: false, error: e.message, cancelled: e instanceof pipeline.Cancelled };
  } finally {
    current = null;
  }
}

// ---------- relatório de erro: o que precisa para consertar de longe ----------
const errosRecentes = [];          // { quando, onde, erro }
const instalacaoRecente = [];      // últimas linhas da aba Instalar
function guardarErro(onde, erro) {
  errosRecentes.push({ quando: new Date().toLocaleString('pt-BR'), onde, erro: String(erro || '').slice(0, 3000) });
  if (errosRecentes.length > 5) errosRecentes.shift();
}
function ultimoLogDeTrabalho() {
  try {
    const pastas = fs.readdirSync(paths.outDir, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => path.join(paths.outDir, d.name, '_trabalho', 'log.txt')).filter((f) => fs.existsSync(f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!pastas.length) return '';
    return fs.readFileSync(pastas[0].f, 'utf8').split(/\r?\n/).slice(-40).join('\n');
  } catch { return ''; }
}
async function montarRelatorio() {
  const os = require('os');
  const versao = (() => { try { return require('./package.json').version; } catch { return '?'; } })();
  const est = await componentes.estado(ctxComponentes()).catch(() => null);
  const linhas = [
    `=== Relatório do ${APP_NAME} ${versao} (${new Date().toLocaleString('pt-BR')}) ===`,
    `Windows ${os.release()} · ${os.cpus()[0] ? os.cpus()[0].model.trim() : '?'} · RAM ${Math.round(os.totalmem() / 1073741824)} GB`,
    `Pasta do app: ${ROOT} · motor de música: ${motor}`,
  ];
  if (est) {
    linhas.push(`Placa: ${est.placa.nome}${est.placa.vramGB ? ` (${est.placa.vramGB} GB)` : ''} → ${est.placa.modo}`);
    if (est.placa.todas && est.placa.todas.length > 1) linhas.push(`Todas as placas: ${est.placa.todas.join(' | ')}`);
    linhas.push('', 'Funções:');
    for (const c of est.itens) linhas.push(`  ${c.instalado ? '[x]' : '[ ]'} ${c.nome}${c.backend ? ' (' + c.backend + ')' : ''}`);
  }
  const c = readConfig();
  linhas.push(`Applio: ${c.applioDir || 'não configurado'}`);
  if (errosRecentes.length) {
    linhas.push('', 'Últimos erros:');
    for (const e of errosRecentes) linhas.push(`--- ${e.quando} (${e.onde})`, e.erro);
  }
  if (instalacaoRecente.length) linhas.push('', 'Últimas linhas da instalação:', ...instalacaoRecente.slice(-40));
  const log = ultimoLogDeTrabalho();
  if (log) linhas.push('', 'Fim do registro do último trabalho:', log);
  // o nome do usuário do Windows não precisa ir junto
  return linhas.join('\n').split(os.homedir()).join('%USERPROFILE%');
}
// ---------- atualização pelo GitHub (src/atualizar.js) ----------
const atualizar = require('./src/atualizar');
ipcMain.handle('atualizacao-verificar', async () => {
  try { return { ok: true, ...(await atualizar.verificar()) }; } catch (e) {
    return { ok: false, atual: atualizar.versaoAtual(), error: e.message };
  }
});
ipcMain.handle('atualizacao-instalar', async () => {
  if (current) return { ok: false, error: 'Espere o trabalho atual terminar.' };
  try {
    const ps = await atualizar.preparar((texto) => send('atualizacao', texto));
    send('atualizacao', 'fechando para trocar os arquivos… o app abre sozinho de novo');
    setTimeout(async () => { await atualizar.rodarDepoisDeFechar(ps); app.quit(); }, 1200);
    return { ok: true };
  } catch (e) {
    guardarErro('atualizar', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('relatorio', async () => {
  const texto = await montarRelatorio();
  clipboard.writeText(texto);
  return { ok: true, linhas: texto.split('\n').length };
});
ipcMain.on('erro-tela', (_e, texto) => guardarErro('tela', texto));
const progresso = (ev) => send('progresso', ev);

// ---------- IPC: trabalho ----------
ipcMain.handle('analisar', (_e, opts) => guarded((ctl) => pipeline.analyze(opts, progresso, ctl)));
ipcMain.handle('gerar', (_e, { dir, opts }) => guarded((ctl) => pipeline.generate(dir, opts, progresso, ctl)));
ipcMain.handle('separar-variacao', (_e, { dir, index }) =>
  guarded((ctl) => pipeline.separateTake(dir, index, progresso, ctl)));
ipcMain.handle('separar-arquivo', (_e, file) => guarded((ctl) => pipeline.separateOnly(file, progresso, ctl)));
ipcMain.handle('separar-instrumentos', (_e, file) => guarded((ctl) => pipeline.separarInstrumentos(file, progresso, ctl)));
ipcMain.handle('so-voz', (_e, opts) => guarded((ctl) => pipeline.soVoz(opts, progresso, ctl)));
ipcMain.handle('falar', (_e, opts) => guarded((ctl) => pipeline.falar(opts, progresso, ctl)));
// vozes do leitor local; a lista só é lida uma vez
let vozesTts = null;
ipcMain.handle('tts-vozes', async () => {
  if (vozesTts) return vozesTts;
  const r = await new Promise((resolve) => {
    execFile(paths.ttsPython, ['-I', paths.falarScript, '--modelo', models.kokoro, '--vozes', models.kokoroVozes, '--listar'],
      { windowsHide: true, timeout: 60000, maxBuffer: 1 << 22 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  try { vozesTts = JSON.parse(r.slice(r.indexOf('['))); } catch { vozesTts = null; }
  return vozesTts || [];
});
ipcMain.handle('planejar', (_e, opts) => guarded((ctl) => pipeline.planejar(opts, progresso, ctl)));
ipcMain.handle('compor', (_e, opts) => guarded((ctl) => pipeline.compor(opts, progresso, ctl)));
ipcMain.handle('continuar', (_e, opts) => guarded((ctl) => pipeline.continuar(opts, progresso, ctl)));
ipcMain.handle('trocar-voz', (_e, { dir, index, voz }) =>
  guarded((ctl) => pipeline.trocarVoz(dir, index, voz, progresso, ctl)));
ipcMain.handle('midi', (_e, { dir, index }) => guarded((ctl) => pipeline.midi(dir, index, progresso, ctl)));
ipcMain.handle('reemendar', (_e, { dir, index, escolhas, voz, modelo }) =>
  guarded((ctl) => pipeline.reemendar(dir, index, escolhas, voz, progresso, ctl, modelo)));

// ---------- IPC: preferências e Applio ----------
ipcMain.handle('config-ler', () => {
  const c = readConfig();
  const ok = !!c.applioDir && fs.existsSync(path.join(c.applioDir, 'core.py'))
    && fs.existsSync(applioPython(c.applioDir));
  return { ...c, applioOk: ok, modelos: ok ? modelosDoUsuario(c) : [] };
});
ipcMain.handle('config-salvar', (_e, patch) => {
  const c = { ...readConfig(), ...patch };
  delete c.applioOk;
  delete c.modelos;
  writeConfig(c);
  return true;
});
ipcMain.handle('escolher-pasta-applio', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pasta do Applio (onde fica o core.py)', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// ---------- IPC: baixar modelos de voz ----------
// O usuário cola a lista e manda baixar; o app busca no Hugging Face, tira do pacote só a voz (.pth) e o
// índice (.index) e põe em <Applio>\\logs\\<nome>. Detalhes e limites em src/modelos.js.
const modelos = require('./src/modelos');
let baixandoModelos = null;   // AbortController do download em andamento
ipcMain.handle('modelos-conferir', (_e, texto) => modelos.lerLista(texto));
ipcMain.handle('modelos-procurar', async (_e, termo) => {
  try { return { ok: true, ...(await modelos.procurar(termo)) }; } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- IPC: voz pelo celular ----------
// Uma página na rede de casa: o celular grava, o PC troca a voz e devolve o áudio pronto para compartilhar.
// Só fica no ar enquanto o usuário deixa ligado. Detalhes e limites em src/celular.js.
const celular = require('./src/celular');
let celularNoAr = null;   // { url, qr, fechar }
const celularPasta = () => path.join(app.getPath('userData'), 'celular');
const celularId = (pth) => crypto.createHash('md5').update(pth.toLowerCase()).digest('hex').slice(0, 12);   // a página não vê caminhos do PC
function celularModelos() {
  const c = readConfig();
  const todos = modelosDoUsuario(c);
  const ficha = (x) => (c.biblioteca || {})[x.pth] || {};
  const item = (grupo) => (x) => ({ id: celularId(x.pth), nome: x.nome, grupo });
  const favs = todos.filter((x) => ficha(x).fav);
  const out = favs.map(item('Favoritos'));
  for (const p of c.pastas || []) out.push(...todos.filter((x) => !ficha(x).fav && ficha(x).pasta === p).map(item(p)));
  const resto = todos.filter((x) => !ficha(x).fav && !(c.pastas || []).includes(ficha(x).pasta));
  out.push(...resto.map(item(out.length ? 'Outros' : '')));
  return out;
}
const rodarFfmpeg = (args) => new Promise((resolve, reject) => {
  execFile(paths.ffmpeg, ['-y', '-loglevel', 'error', ...args], { windowsHide: true }, (err, _o, e) => (err ? reject(new Error('não consegui ler o áudio: ' + String(e || err.message).split('\n')[0])) : resolve()));
});
// Converte uma gravação vinda do celular com o mesmo caminho da troca de voz de música, sem a parte de
// separar instrumento: é só voz falada.
async function celularConverter(entrada, modeloId, tom, avisar) {
  const c = readConfig();
  const m2 = modelosDoUsuario(c).find((x) => celularId(x.pth) === modeloId);
  if (!m2) throw new Error('modelo de voz não encontrado');
  const dir = path.dirname(entrada);
  const wav = path.join(dir, 'gravado.wav');
  avisar('lendo a gravação…');
  await rodarFfmpeg(['-i', entrada, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
  const faixas = { vocals: wav, instrumental: null };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id: path.basename(dir), kind: 'voz', title: 'celular', covers: [], stems: faixas, stemsList: [faixas], status: 'pronto' }));
  const centro = m2.treino ? 0 : Number((c.alturaModelos || {})[m2.pth]) || 0;
  const fixo = tom !== 'auto' && Number.isFinite(Number(tom));
  const voz = {
    ...(c.voz || {}), applioDir: c.applioDir, pth: m2.pth, index: m2.index, nome: m2.nome, centroModelo: centro, segundo: null,
    // automático: cada frase vai na oitava que cai melhor na voz do modelo (precisa da altura dele)
    pitch: fixo ? Math.max(-24, Math.min(24, Math.round(Number(tom)))) : 0, doisTons: !fixo, tomSozinho: false, instrumentalAcompanha: false,
    tirarCoro: false, tirarEco: false, coroNaVoz: false, limparPausas: true, igualarVolume: true,
  };
  const r = await guarded((ctl) => pipeline.trocarVoz(dir, 0, voz, (ev) => avisar(ev.message || 'convertendo…'), ctl));
  if (!r.ok) throw new Error(r.error || 'a conversão falhou');
  const feita = (r.data.vozes || []).slice(-1)[0];
  if (!feita || !fs.existsSync(feita.file)) throw new Error('a conversão não gerou áudio');
  avisar('finalizando…');
  const pronto = path.join(dir, 'voz.mp3');
  await rodarFfmpeg(['-i', feita.file, '-c:a', 'libmp3lame', '-q:a', '2', pronto]);
  // mesma voz no formato das mensagens de voz do WhatsApp: compartilhada assim, costuma chegar como gravada na hora
  await rodarFfmpeg(['-i', feita.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', path.join(dir, 'voz.opus')]).catch(() => {});
  return pronto;
}
// Cover pedido pelo celular: o mesmo "Trocar voz" da mesa (baixa, separa, troca a voz), com os ajustes de voz
// que estão salvos no app. As faixas completas ficam em "saida", como sempre; o celular recebe cópias em mp3,
// voz e instrumental separados.
// Texto digitado no celular: o leitor local (Kokoro) lê e o resultado passa pelo mesmo caminho de uma
// gravação. Modelo de voz aguda é lido por leitora, os outros por leitor, para o tom já sair perto.
async function celularFalar(texto, modeloId, tom, avisar) {
  const c = readConfig();
  const m2 = modelosDoUsuario(c).find((x) => celularId(x.pth) === modeloId);
  if (!m2) throw new Error('modelo de voz não encontrado');
  if (!fs.existsSync(paths.ttsPython) || !fs.existsSync(models.kokoro)) throw new Error('o leitor de texto não está instalado no PC');
  const dir = path.join(celularPasta(), 't-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const arquivoTexto = path.join(dir, 'texto.txt');
  fs.writeFileSync(arquivoTexto, texto, 'utf8');
  const fala = path.join(dir, 'fala.wav');
  const aguda = !m2.treino && Number((c.alturaModelos || {})[m2.pth]) >= 200;
  avisar('lendo o texto…');
  await new Promise((resolve, reject) => {
    execFile(paths.ttsPython, ['-I', paths.falarScript, '--modelo', models.kokoro, '--vozes', models.kokoroVozes,
      '--texto', arquivoTexto, '--voz', aguda ? 'pf_dora' : 'pm_alex', '--velocidade', '1.00', '--saida', fala],
    { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } }, (err, _o, e) => (err ? reject(new Error('o leitor falhou: ' + String(e || err.message).trim().split('\n').pop())) : resolve()));
  });
  if (!fs.existsSync(fala)) throw new Error('o leitor não gerou áudio');
  return celularConverter(fala, modeloId, tom, avisar);
}
async function celularCover(link, modeloId, tom, avisar) {
  const c = readConfig();
  const m2 = modelosDoUsuario(c).find((x) => celularId(x.pth) === modeloId);
  if (!m2) throw new Error('modelo de voz não encontrado');
  const fixo = tom !== 'auto' && Number.isFinite(Number(tom));
  const padrao = { tirarCoro: true, tirarEco: true, limparPausas: true, igualarVolume: true, doisTons: true, splitAudio: true, protect: 0.2, indexRate: 0.55 };
  const voz = {
    ...padrao, ...(c.voz || {}), applioDir: c.applioDir, pth: m2.pth, index: m2.index, nome: m2.nome, segundo: null, tomSozinho: false,
    centroModelo: m2.treino ? 0 : Number((c.alturaModelos || {})[m2.pth]) || 0,
    ...(fixo ? { pitch: Math.max(-24, Math.min(24, Math.round(Number(tom)))), doisTons: false } : { pitch: 0 }),
  };
  const r = await guarded((ctl) => pipeline.soVoz({ url: link, voz }, (ev) => {
    avisar((ev.message || 'trabalhando…') + (ev.pct > 0 && ev.pct < 100 ? ' ' + Math.round(ev.pct) + '%' : ''));
  }, ctl));
  if (!r.ok) throw new Error(r.error || 'a conversão falhou');
  const feita = (r.data.vozes || []).slice(-1)[0];
  if (!feita || !fs.existsSync(feita.file)) throw new Error('a conversão não gerou a voz');
  send('celular', { tipo: 'cover-pronto' });   // a janela do PC atualiza a lista de recentes
  avisar('preparando os arquivos para o celular…');
  const dir = path.join(celularPasta(), 'm-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const faixas = [['voz', feita.file], ['instrumental', feita.instrumental || (r.data.stems || {}).instrumental], ['coro', feita.coroVoz || feita.coro]];
  const prontas = [];
  for (const [rotulo, origem] of faixas) {
    if (!origem || !fs.existsSync(origem)) continue;
    const mp3 = path.join(dir, rotulo + '.mp3');
    await rodarFfmpeg(['-i', origem, '-c:a', 'libmp3lame', '-q:a', '2', mp3]);
    prontas.push({ rotulo, arquivo: mp3 });
  }
  return prontas;
}
async function celularLigar() {
  if (celularNoAr) return { ok: true, url: celularNoAr.url, qr: celularNoAr.qr };
  try {
    const pasta = celularPasta();
    // gravações de sessões anteriores não ficam guardadas
    if (fs.existsSync(pasta)) for (const it of fs.readdirSync(pasta, { withFileTypes: true })) if (it.isDirectory()) fs.rmSync(path.join(pasta, it.name), { recursive: true, force: true });
    // o código do endereço fica o mesmo de uma vez para a outra: o atalho na tela inicial do celular continua valendo
    let c = readConfig();
    if (!/^[0-9a-f]{10}$/.test(c.celularCodigo || '')) { c = { ...c, celularCodigo: crypto.randomBytes(5).toString('hex') }; writeConfig(c); }
    const no = await celular.ligar({
      pasta, pagina: path.join(__dirname, 'src', 'celular.html'), icone: path.join(__dirname, 'src', 'celular-icone.png'), nome: APP_NAME,
      codigo: c.celularCodigo, modelos: celularModelos, converter: celularConverter, cover: celularCover, falar: celularFalar, soLocal: !!process.env.MEUCOVER_SHOT,
    });
    const qr = await require('qrcode').toDataURL(no.url, { margin: 1, width: 280, color: { dark: '#151311', light: '#e8dec8' } });
    celularNoAr = { ...no, qr };
    return { ok: true, url: no.url, qr };
  } catch (e) {
    return { ok: false, error: e.code === 'EADDRINUSE' ? 'As portas que o app usa para isso estão ocupadas por outro programa.' : 'Não consegui abrir a página: ' + e.message };
  }
}
ipcMain.handle('celular-estado', () => ({ ...(celularNoAr ? { ligada: true, url: celularNoAr.url, qr: celularNoAr.qr } : { ligada: false }), auto: !!readConfig().celularAuto }));
ipcMain.handle('celular-ligar', () => celularLigar());
ipcMain.handle('celular-desligar', async () => {
  const no = celularNoAr;
  celularNoAr = null;
  if (no) await no.fechar();
  return true;
});
ipcMain.handle('modelos-baixar', async (_e, texto) => {
  if (baixandoModelos) return { ok: false, error: 'Já há um download em andamento.' };
  const c = readConfig();
  if (!c.applioDir || !fs.existsSync(path.join(c.applioDir, 'logs'))) return { ok: false, error: 'Não achei a pasta "logs" do Applio.' };
  const { itens, erros } = modelos.lerLista(texto);
  if (!itens.length) return { ok: false, error: erros[0] || 'Nenhum modelo na lista.' };
  baixandoModelos = new AbortController();
  const tmp = path.join(app.getPath('userData'), 'modelos-tmp');
  const feitos = [];
  const alturas = {};
  const fichas = {};   // língua e pasta de cada modelo instalado, para a biblioteca
  try {
    for (const [i, item] of itens.entries()) {
      const aviso = (texto2) => send('modelos', { i, nome: item.nome, texto: texto2 });
      aviso('começando…');
      try {
        const r = await modelos.instalar(item, c.applioDir, tmp, aviso, baixandoModelos.signal);
        if (item.altura && r.pth) alturas[r.pth] = item.altura;
        if (r.pth && !r.pulado && (item.lingua || item.pasta)) fichas[r.pth] = { lingua: item.lingua, pasta: item.pasta };
        feitos.push({ nome: item.nome, ok: true });
        aviso(r.pulado ? 'já estava instalado' : 'instalado' + (r.index ? '' : ' (pacote sem índice)'));
      } catch (e) {
        if (baixandoModelos.signal.aborted) { aviso('cancelado'); break; }
        feitos.push({ nome: item.nome, ok: false });
        aviso('falhou: ' + e.message);
      }
    }
  } finally {
    baixandoModelos = null;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  if (Object.keys(alturas).length || Object.keys(fichas).length) {
    const agora = readConfig();
    const biblioteca = { ...(agora.biblioteca || {}) };
    const pastas = [...(agora.pastas || [])];
    for (const [pth, f] of Object.entries(fichas)) {
      biblioteca[pth] = { ...(biblioteca[pth] || {}), ...(f.lingua ? { lingua: f.lingua } : {}), ...(f.pasta ? { pasta: f.pasta } : {}) };
      if (f.pasta && !pastas.includes(f.pasta)) pastas.push(f.pasta);
    }
    writeConfig({ ...agora, alturaModelos: { ...(agora.alturaModelos || {}), ...alturas }, biblioteca, pastas });
  }
  return { ok: true, feitos, erros };
});
// Amostra de um modelo (uma frase na voz dele). Fica guardada nos dados do app; só é gerada na primeira vez.
ipcMain.handle('modelo-amostra', async (_e, { pth, index, feminina }) => {
  if (!pth || !fs.existsSync(pth)) return { ok: false, error: 'Modelo não encontrado.' };
  const st = fs.statSync(pth);
  const pasta = path.join(app.getPath('userData'), 'amostras');
  const destino = path.join(pasta, crypto.createHash('md5').update(pth + '|' + st.size + '|' + st.mtimeMs + '|' + (feminina ? 'f' : 'm')).digest('hex') + '.wav');
  if (fs.existsSync(destino)) return { ok: true, data: destino };
  const voz = { applioDir: readConfig().applioDir, pth, index: index || '' };
  return guarded((ctl) => pipeline.amostra(voz, destino, feminina ? 'pf_dora' : 'pm_alex', () => {}, ctl));
});

// Apagar um modelo: a pasta dele em <Applio>\\logs vai para a Lixeira (dá para restaurar), depois de confirmar.
ipcMain.handle('modelo-apagar', async (_e, { pth }) => {
  const c = readConfig();
  const logs = path.join(c.applioDir || '', 'logs');
  const pasta = path.dirname(String(pth || ''));
  // só mexe em pasta de modelo: filha direta de logs, fora as pastas do próprio Applio
  if (!c.applioDir || path.dirname(pasta).toLowerCase() !== logs.toLowerCase() || !fs.existsSync(pth)
    || /^(pretraineds?|mute.*|zips|reference|custom)$/i.test(path.basename(pasta))) return { ok: false, error: 'Não é uma pasta de modelo.' };
  if (current) return { ok: false, error: 'Espere o trabalho atual terminar.' };
  if (aoVivo && aoVivo.pth === pth) return { ok: false, error: 'Este modelo está na voz ao vivo. Desligue ou troque de modelo antes.' };
  const treinado = fs.existsSync(path.join(pasta, 'f0_voiced'));
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Mandar para a Lixeira', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true,
    message: 'Apagar o modelo "' + path.basename(pasta) + '"?',
    detail: 'A pasta inteira vai para a Lixeira:\n' + pasta + (treinado ? '\n\nAtenção: este modelo foi treinado neste computador. Os dados do treino vão junto.' : ''),
  });
  if (r.response !== 0) return { ok: false, cancelado: true };
  try { await shell.trashItem(pasta); } catch (e) { return { ok: false, error: 'Não consegui mandar para a Lixeira: ' + e.message }; }
  const agora = readConfig();
  const sem = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => path.dirname(k).toLowerCase() !== pasta.toLowerCase()));
  writeConfig({
    ...agora, biblioteca: sem(agora.biblioteca), alturaModelos: sem(agora.alturaModelos), aoVivoTons: sem(agora.aoVivoTons),
    vozPth: agora.vozPth && path.dirname(agora.vozPth).toLowerCase() === pasta.toLowerCase() ? '' : agora.vozPth,
    voz2Pth: agora.voz2Pth && path.dirname(agora.voz2Pth).toLowerCase() === pasta.toLowerCase() ? '' : agora.voz2Pth,
  });
  return { ok: true };
});

// Ficha de um modelo na biblioteca (favorito, língua, pasta). Junta com o que já está salvo, modelo a modelo.
ipcMain.handle('biblioteca-salvar', (_e, { pth, dados }) => {
  const c = readConfig();
  const biblioteca = { ...(c.biblioteca || {}) };
  biblioteca[pth] = { ...(biblioteca[pth] || {}), ...dados };
  writeConfig({ ...c, biblioteca });
  return biblioteca;
});
ipcMain.handle('modelos-cancelar', () => { if (baixandoModelos) baixandoModelos.abort(); return true; });

ipcMain.handle('cancelar', () => {
  if (current && current.job) current.job.cancel();
  return true;
});

// ---------- IPC: arquivos ----------
ipcMain.handle('escolher-audio', async (_e, titulo) => {
  const r = await dialog.showOpenDialog(win, {
    title: typeof titulo === 'string' && titulo ? titulo : 'Escolher música',
    properties: ['openFile'],
    filters: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('escolher-pasta-lora', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pasta dos LoRAs (.safetensors)', properties: ['openDirectory'] });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.safetensors'));
  return { dir, files };
});

ipcMain.handle('salvar-copia', async (_e, src) => {
  const r = await dialog.showSaveDialog(win, { title: 'Salvar como', defaultPath: path.basename(src) });
  if (r.canceled) return false;
  fs.copyFileSync(src, r.filePath);
  return r.filePath;
});

ipcMain.handle('copiar', (_e, texto) => { clipboard.writeText(String(texto || '')); return true; });
// ---------- microfone padrão do Windows ----------
// A voz trocada sai num cabo virtual (CABLE Input -> CABLE Output). Para os outros programas ouvirem só
// ela, sem o usuário escolher microfone em cada um, o app põe o CABLE Output como microfone padrão enquanto
// a voz ao vivo está ligada e devolve o microfone de antes ao desligar. O de antes fica guardado nas
// preferências: se o app fechar de mau jeito, é devolvido na abertura seguinte.
const microScript = path.join(__dirname, 'src', 'microfone.ps1');
const microArgs = (extra) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', microScript, ...extra];
const microLer = (saida) => {
  const linha = String(saida || '').split(/\r?\n/).reverse().find((x) => x.trim().startsWith('{'));
  try { return JSON.parse(linha); } catch { return null; }
};
let microFila = Promise.resolve();   // uma troca por vez
function microfone(extra = []) {
  const vez = microFila.then(() => new Promise((resolve) => {
    execFile('powershell.exe', microArgs(extra), { windowsHide: true, timeout: 25000 }, (_err, stdout) => resolve(microLer(stdout)));
  }));
  microFila = vez.catch(() => {});
  return vez;
}
async function microfoneParaOCabo() {
  const antes = await microfone();
  if (!antes) return { ok: false, error: 'Não consegui ler os microfones do Windows.' };
  const cabo = antes.microfones.find((x) => x.nome.startsWith('CABLE Output'));
  if (!cabo) return { ok: false, error: 'O cabo virtual (CABLE Output) não está instalado.' };
  const c = readConfig();
  if (antes.padrao.id === cabo.id) return { ok: true, nome: cabo.nome, anterior: (c.microfoneAnterior || {}).nome || '' };
  writeConfig({ ...c, microfoneAnterior: antes.padrao });
  const depois = await microfone(['-Definir', cabo.id]);
  if (!depois || depois.erro || depois.padrao.id !== cabo.id) {
    const agora = readConfig();
    delete agora.microfoneAnterior;
    writeConfig(agora);
    return { ok: false, error: 'O Windows não deixou trocar o microfone padrão' + (depois && depois.erro ? ': ' + depois.erro : '.') };
  }
  return { ok: true, nome: cabo.nome, anterior: antes.padrao.nome };
}
async function microfoneDeVolta() {
  const c = readConfig();
  const antes = c.microfoneAnterior;
  if (!antes || !antes.id) return null;
  const depois = await microfone(['-Definir', antes.id]);
  if (!depois || depois.erro || depois.padrao.id !== antes.id) return { ok: false, error: 'Não consegui devolver o microfone padrão para ' + antes.nome + '.' };
  const agora = readConfig();
  delete agora.microfoneAnterior;
  writeConfig(agora);
  return { ok: true, nome: antes.nome };
}
// ao fechar o app não dá para esperar: devolve o microfone de forma direta
function microfoneDeVoltaJa() {
  const c = readConfig();
  if (!c.microfoneAnterior || !c.microfoneAnterior.id) return;
  try {
    require('child_process').execFileSync('powershell.exe', microArgs(['-Definir', c.microfoneAnterior.id]), { windowsHide: true, timeout: 20000, stdio: 'ignore' });
    delete c.microfoneAnterior;
    writeConfig(c);
  } catch {}
}
const avisarMicrofone = (r, volta) => { if (r) send('aovivo', { tipo: 'microfone', volta: !!volta, ...r }); };

// ---------- IPC: voz ao vivo ----------
// O microfone passa pelo motor de tempo real do Applio (src/aovivo.py, no Python dele) e sai na voz do
// modelo. Um processo só, ligado e desligado daqui. Não roda junto com a conversão de música: os dois
// usariam a mesma placa de vídeo.
// Cada vez que a voz é ligada nasce uma sessão: processo próprio, arquivo de controle próprio. Só a sessão
// atual fala com a tela. Assim um motor antigo que ainda está fechando não confunde o novo nem a tela.
let aoVivo = null;   // { child, tom, retorno, controle }
let aoVivoSessoes = 0;
// comandos para o motor ao vivo vão por arquivo (ver o porquê em src/aovivo.py)
const aoVivoMandar = (s, parar) => {
  try { fs.writeFileSync(s.controle, JSON.stringify({ tom: s.tom, retorno: !parar && s.retorno, parar: !!parar, testar: s.testar || null, modelo: s.modelo || null })); } catch {}
};
const applioPy = () => applioPython(readConfig().applioDir);
const aoVivoMatar = (s) => {
  if (s.child.exitCode != null) return;
  try { require('child_process').execFileSync('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
};
// agora = true encerra na hora (usado antes de ligar outra sessão e ao fechar o app)
function aoVivoDesligar(agora) {
  const s = aoVivo;
  if (!s) return;
  aoVivo = null;
  if (agora) return aoVivoMatar(s);
  aoVivoMandar(s, true);
  // dá um instante para ele soltar os aparelhos de som; depois encerra a árvore (ele tem um processo filho)
  setTimeout(() => { aoVivoMatar(s); try { fs.rmSync(s.controle, { force: true }); } catch {} }, 1500);
}
ipcMain.handle('aovivo-aparelhos', () => new Promise((resolve) => {
  const py = applioPy();
  if (!fs.existsSync(py)) return resolve({ ok: false, error: 'Não achei o Python do Applio. Confira a pasta do Applio em Ajustes finos da voz.' });
  execFile(py, [paths.aoVivoScript, '--listar'], { cwd: path.dirname(path.dirname(py)), windowsHide: true, timeout: 30000 }, (err, stdout) => {
    const linha = String(stdout || '').split(/\r?\n/).find((x) => x.startsWith('APARELHOS '));
    if (!linha) return resolve({ ok: false, error: 'Não consegui listar os aparelhos de som.' + (err ? ' ' + err.message.split('\n')[0] : '') });
    try { resolve({ ok: true, ...JSON.parse(linha.slice(10)) }); } catch { resolve({ ok: false, error: 'Resposta estranha ao listar os aparelhos de som.' }); }
  });
}));
function aoVivoLigar(o) {
  if (current) return { ok: false, error: 'Há uma música sendo convertida. Espere terminar para ligar a voz ao vivo.' };
  const py = applioPy();
  if (!fs.existsSync(py)) return { ok: false, error: 'Não achei o Python do Applio.' };
  if (!o || !o.pth || !fs.existsSync(o.pth)) return { ok: false, error: 'Escolha um modelo de voz.' };
  aoVivoDesligar(true);
  const controle = path.join(app.getPath('userData'), `aovivo-controle-${process.pid}-${++aoVivoSessoes}.json`);
  const args = [
    paths.aoVivoScript, '--modelo', o.pth, '--indice', pipeline.indiceSeguro(o.index),
    '--entrada', String(Number(o.entrada)), '--saida', String(Number(o.saida)),
    '--tom', String(Math.round(Number(o.tom) || 0)), '--f0', o.f0 || 'rmvpe', '--embedder', o.embedder || 'contentvec',
    '--index-rate', String(Number(o.indexRate) >= 0 ? Number(o.indexRate) : 0.55),
    '--protect', String(Number(o.protect) >= 0 ? Number(o.protect) : 0.2),
    '--bloco', String(Number(o.bloco) || 250),
    '--emenda', String(Math.min(0.2, Math.max(0.05, Number(o.emenda) || 0.05))),
    '--contexto', String(Math.min(5, Math.max(0.1, Number(o.contexto) || 2.5))),
    '--portao', String(Math.min(-30, Math.max(-90, Math.round(Number(o.portao) || -60)))),
    '--controle', controle, '--pai', String(process.pid),
    '--retorno', String(Number.isInteger(o.retornoEm) ? o.retornoEm : -1), '--retorno-ligado', o.retorno ? '1' : '0',
  ];
  const eu = { child: null, tom: Math.round(Number(o.tom) || 0), retorno: !!o.retorno, controle, pth: o.pth, opcoes: o, trocaEm: 0 };
  aoVivoMandar(eu, false);
  const child = spawn(py, args, {
    cwd: path.dirname(path.dirname(py)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  });
  eu.child = child;
  aoVivo = eu;
  // microfone do Windows: vai para o cabo se foi pedido (e a saída é o cabo); senão, garante o de antes
  if (o.microAuto) microfoneParaOCabo().then((r) => avisarMicrofone(r, false));
  else microfoneDeVolta().then((r) => avisarMicrofone(r, true));
  let resto = '';
  let ultimoErro = '';
  const ler = (pedaco) => {
    resto += pedaco.toString('utf8');
    const linhas = resto.split(/\r?\n/);
    resto = linhas.pop();
    for (const linha of linhas) {
      if (linha.startsWith('ESTADO ')) { if (aoVivo === eu) { try { send('aovivo', { tipo: 'estado', ...JSON.parse(linha.slice(7)) }); } catch {} } }
      else if (linha.startsWith('TESTE ')) { if (aoVivo === eu) { try { send('aovivo', { tipo: 'teste', ...JSON.parse(linha.slice(6)) }); } catch {} } }
      else if (linha.startsWith('ERRO ')) { try { ultimoErro = JSON.parse(linha.slice(5)).mensagem; } catch {} registro.write(linha + '\n'); }
      else registro.write(linha + '\n');
    }
  };
  // tudo que o motor diz fora dos avisos de estado fica em aovivo-log.txt (um arquivo por sessão, sobrescrito)
  const registro = fs.createWriteStream(path.join(app.getPath('userData'), 'aovivo-log.txt'));
  registro.write('sessão ' + new Date().toLocaleString('pt-BR') + '\n> ' + args.join(' ') + '\n');
  child.stdout.on('data', ler);
  child.stderr.on('data', (d) => registro.write(d));
  child.on('error', (e) => { ultimoErro = e.message; });
  child.on('close', (code) => {
    try { fs.rmSync(controle, { force: true }); } catch {}
    registro.end('fim, código ' + code + '\n');
    // sessão desligada a pedido, ou já trocada por outra, sai calada: a tela já sabe
    if (aoVivo !== eu) return;
    aoVivo = null;
    // caiu logo depois de um pedido de troca de modelo: religa já com o modelo novo, em vez de deixar mudo
    if (code && eu.trocaEm && Date.now() - eu.trocaEm < 60000) {
      const r = aoVivoLigar({ ...eu.opcoes, pth: eu.pth, index: eu.indexNovo, tom: eu.tom, retorno: eu.retorno });
      if (r.ok) { send('aovivo', { tipo: 'religando' }); return; }
    }
    microfoneDeVolta().then((r) => avisarMicrofone(r, true));   // caiu sozinha: o microfone volta ao normal
    send('aovivo', { tipo: 'fim', erro: code ? ultimoErro || 'O motor da voz ao vivo parou sozinho.' : '' });
  });
  return { ok: true };
}
ipcMain.handle('aovivo-ligar', (_e, o) => aoVivoLigar(o));
ipcMain.handle('aovivo-desligar', () => {
  aoVivoDesligar(false);
  microfoneDeVolta().then((r) => avisarMicrofone(r, true));
  return true;
});
ipcMain.handle('aovivo-estado', () => (aoVivo ? { ligada: true, tom: aoVivo.tom, retorno: aoVivo.retorno, pth: aoVivo.pth } : { ligada: false }));
// Troca a voz com a sessão no ar: o motor carrega o outro modelo sem fechar microfone nem saída.
let aoVivoTrocas = 0;
ipcMain.handle('aovivo-modelo', (_e, o) => {
  if (!aoVivo) return { ok: false };
  if (!o || !o.pth || !fs.existsSync(o.pth)) return { ok: false, error: 'Modelo não encontrado.' };
  aoVivo.pth = o.pth;
  aoVivo.tom = Math.round(Number(o.tom) || 0);
  aoVivo.modelo = { id: ++aoVivoTrocas, pth: o.pth, indice: pipeline.indiceSeguro(o.index) };
  aoVivo.trocaEm = Date.now();
  aoVivo.indexNovo = o.index || '';
  aoVivoMandar(aoVivo, false);
  return { ok: true };
});
// Teste: o motor grava alguns segundos da voz já trocada num arquivo dos dados do app; a tela toca.
let aoVivoTestes = 0;
ipcMain.handle('aovivo-testar', (_e, segundos) => {
  if (!aoVivo) return { ok: false, error: 'Ligue a voz ao vivo antes de testar.' };
  const pasta = path.join(app.getPath('userData'), 'aovivo-testes');
  fs.mkdirSync(pasta, { recursive: true });
  for (const velho of fs.readdirSync(pasta)) { try { fs.rmSync(path.join(pasta, velho), { force: true }); } catch {} }
  const s = Math.min(20, Math.max(3, Number(segundos) || 8));
  aoVivo.testar = { id: ++aoVivoTestes, arquivo: path.join(pasta, `teste-${process.pid}-${aoVivoTestes}.wav`), segundos: s };
  aoVivoMandar(aoVivo, false);
  return { ok: true, segundos: s };
});
ipcMain.on('aovivo-tom', (_e, tom) => {
  if (!aoVivo) return;
  aoVivo.tom = Math.round(Number(tom) || 0);
  aoVivoMandar(aoVivo, false);
});
ipcMain.on('aovivo-retorno', (_e, ligado) => {
  if (!aoVivo) return;
  aoVivo.retorno = !!ligado;
  aoVivoMandar(aoVivo, false);
});

// ---------- karaokê ----------
// Janela própria. A música é preparada pelo pipeline (baixar, tirar a voz principal, letra, tom); o som ao vivo
// (instrumental + microfone passando pelos plugins VST3 do usuário + gravação) roda em src/karaoke.py, no
// sep-env, um processo por janela aberta. Comandos vão pela entrada padrão dele (aqui não há o problema do
// aovivo.py: o karaokê não cria processo filho).
let karaokeWin = null;
let karaokeMotor = null;   // { child }
const karaokeEnviar = (canal, dados) => { if (karaokeWin && !karaokeWin.isDestroyed()) karaokeWin.webContents.send(canal, dados); };
const karaokeEstado = (arquivo) => path.join(app.getPath('userData'), 'karaoke-plugins', crypto.createHash('md5').update(arquivo.toLowerCase()).digest('hex') + '.bin');

function karaokeAbrir(dir) {
  if (karaokeWin && !karaokeWin.isDestroyed()) {
    if (karaokeWin.isMinimized()) karaokeWin.restore();
    karaokeWin.focus();
    if (dir) karaokeEnviar('karaoke-abrir', dir);
    return;
  }
  karaokeWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640, icon: path.join(__dirname, 'haze.ico'),
    title: APP_NAME + ' — Karaokê', backgroundColor: '#151311', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  karaokeWin.loadFile(path.join(__dirname, 'renderer', 'karaoke.html'), dir ? { query: { dir } } : undefined);
  karaokeWin.on('closed', () => { karaokeWin = null; karaokeMotorParar(); });
  // recarregou a tela (Ctrl+R): o motor também começa do zero, já com o código novo
  karaokeWin.webContents.on('did-start-loading', () => karaokeMotorParar());
}
ipcMain.handle('karaoke-janela', (_e, dir) => { karaokeAbrir(dir); return true; });

function karaokeMotorLigar() {
  if (karaokeMotor) return { ok: true };
  if (!fs.existsSync(paths.sepPython)) return { ok: false, error: 'Não achei o Python do separador (sep-env).' };
  const child = spawn(paths.sepPython, ['-I', paths.karaokeScript], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  });
  const eu = { child };
  karaokeMotor = eu;
  const registro = fs.createWriteStream(path.join(app.getPath('userData'), 'karaoke-log.txt'));
  registro.write('sessão ' + new Date().toLocaleString('pt-BR') + '\n');
  let resto = '';
  child.stdout.on('data', (pedaco) => {
    resto += pedaco.toString('utf8');
    const linhas = resto.split(/\r?\n/);
    resto = linhas.pop();
    for (const linha of linhas) {
      const m = /^([A-Z_]+) (\{.*\})$/.exec(linha);
      if (!m) { registro.write(linha + '\n'); continue; }
      if (m[1] !== 'ESTADO') registro.write(linha + '\n');
      try { karaokeEnviar('karaoke-motor', { tipo: m[1], ...JSON.parse(m[2]) }); } catch {}
    }
  });
  child.stderr.on('data', (d) => registro.write(d));
  child.stdin.on('error', () => {});
  child.on('error', (e) => registro.write('erro: ' + e.message + '\n'));
  child.on('close', (code) => {
    registro.end('fim, código ' + code + '\n');
    if (karaokeMotor !== eu) return;
    karaokeMotor = null;
    karaokeEnviar('karaoke-motor', { tipo: 'CAIU', codigo: code });
  });
  return { ok: true };
}
function karaokeMotorParar() {
  const m = karaokeMotor;
  karaokeMotor = null;
  if (!m) return;
  try { m.child.stdin.write(JSON.stringify({ cmd: 'sair' }) + '\n'); m.child.stdin.end(); } catch {}
  // dá tempo de salvar gravação e ajustes dos plugins; depois encerra de qualquer jeito
  setTimeout(() => { if (m.child.exitCode == null) { try { require('child_process').execFileSync('taskkill', ['/PID', String(m.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } }, 8000);
}
app.on('before-quit', karaokeMotorParar);

ipcMain.handle('karaoke-motor', (_e, comando) => {
  const r = karaokeMotorLigar();
  if (!r.ok) return r;
  const c = { ...comando };
  // o ajuste salvo de cada plugin fica nos dados do app, um arquivo por plugin
  if (c.cmd === 'efeitos') c.lista = (c.lista || []).map((x) => ({ ...x, estado: karaokeEstado(x.arquivo) }));
  // acentos vão escritos como ê: chegam certos qualquer que seja a codificação da entrada do Python
  const linha = JSON.stringify(c).replace(/[\u007f-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  try { karaokeMotor.child.stdin.write(linha + '\n'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});
ipcMain.handle('karaoke-aparelhos', () => new Promise((resolve) => {
  if (!fs.existsSync(paths.sepPython)) return resolve({ ok: false, error: 'Não achei o Python do separador (sep-env).' });
  execFile(paths.sepPython, ['-I', paths.karaokeScript, '--listar'], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
    const linha = String(stdout || '').split(/\r?\n/).find((x) => x.startsWith('APARELHOS '));
    if (!linha) return resolve({ ok: false, error: 'Não consegui listar os aparelhos de som.' + (err ? ' ' + err.message.split('\n')[0] : '') });
    try { resolve({ ok: true, ...JSON.parse(linha.slice(10)) }); } catch { resolve({ ok: false, error: 'Resposta estranha ao listar os aparelhos de som.' }); }
  });
}));

// Plugins VST3 instalados: pastas padrão do Windows, D:\VST3 e as que a pessoa acrescentar.
// No Windows um .vst3 pode ser arquivo ou pasta; dentro dele não se procura mais nada.
function karaokePastasVst() {
  const pf = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files';
  return [...new Set([path.join(pf, 'VST3'), 'D:\\VST3', ...((readConfig().karaoke || {}).pastasVst || [])])];
}
function karaokeAcharVst() {
  const achados = [];
  const andar = (dir, fundo) => {
    let itens = [];
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of itens) {
      const p = path.join(dir, it.name);
      if (it.name.toLowerCase().endsWith('.vst3')) achados.push({ arquivo: p, nome: it.name.slice(0, -5) });
      else if (it.isDirectory() && fundo < 4) andar(p, fundo + 1);
    }
  };
  for (const d of karaokePastasVst()) andar(d, 0);
  const vistos = new Set();
  return achados.filter((x) => !vistos.has(x.arquivo.toLowerCase()) && vistos.add(x.arquivo.toLowerCase()))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
ipcMain.handle('karaoke-vsts', () => karaokeAcharVst());
ipcMain.handle('karaoke-pasta-vst', async () => {
  const r = await dialog.showOpenDialog(karaokeWin || win, { title: 'Pasta onde ficam seus plugins VST3', properties: ['openDirectory'] });
  if (r.canceled) return karaokeAcharVst();
  const c = readConfig();
  const k = c.karaoke || {};
  writeConfig({ ...c, karaoke: { ...k, pastasVst: [...new Set([...(k.pastasVst || []), r.filePaths[0]])] } });
  return karaokeAcharVst();
});

ipcMain.handle('karaoke-preparar', (_e, opts) => guarded((ctl) => pipeline.karaoke(opts, (ev) => karaokeEnviar('karaoke-progresso', ev), ctl)));
ipcMain.handle('karaoke-letra', (_e, { dir, busca }) => guarded((ctl) => pipeline.karaokeLetra(dir, busca, (ev) => karaokeEnviar('karaoke-progresso', ev), ctl)));
ipcMain.handle('karaoke-tom', (_e, { dir, semitons }) => guarded((ctl) => pipeline.karaokeTom(dir, semitons, (ev) => karaokeEnviar('karaoke-progresso', ev), ctl)));
ipcMain.handle('karaoke-melodia', (_e, dir) => guarded(async (ctl) => {
  const arq = await pipeline.karaokeMelodia(dir, (ev) => karaokeEnviar('karaoke-progresso', ev), ctl);
  return JSON.parse(fs.readFileSync(arq, 'utf8'));
}));
ipcMain.handle('karaoke-ler', (_e, dir) => { try { return { ...pipeline.readMeta(dir), dir }; } catch { return null; } });
ipcMain.handle('karaoke-atraso', (_e, { dir, atraso }) => { try { pipeline.saveMeta(dir, { atraso: Number(atraso) || 0 }); return true; } catch { return false; } });
ipcMain.handle('karaoke-recentes', () => {
  const out = [];
  let pastas = [];
  try { pastas = fs.readdirSync(paths.outDir); } catch {}
  for (const p of pastas) {
    const dir = path.join(paths.outDir, p);
    try {
      const m = pipeline.readMeta(dir);
      if (m.kind === 'karaoke' && m.status === 'pronto') out.push({ dir, id: m.id, title: m.title, duration: m.duration, tom: m.tom });
    } catch {}
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 30);
});

// só abre os dois endereços conhecidos, nunca um link vindo da página
const SITES = { claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/' };
ipcMain.handle('abrir-site', (_e, qual) => { if (SITES[qual]) shell.openExternal(SITES[qual]); return !!SITES[qual]; });
// página de um modelo achado na busca: só abre endereço do Hugging Face
ipcMain.handle('abrir-hf', (_e, url) => {
  const ok = modelos.linkAceito(String(url || ''));
  if (ok) shell.openExternal(url);
  return ok;
});
ipcMain.handle('mostrar-na-pasta', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('abrir-pasta-saida', () => shell.openPath(paths.outDir));

ipcMain.handle('salvar-edicao', (_e, { dir, abc, lyrics }) => {
  const f = path.join(dir, 'job.json');
  const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (abc != null) { fs.writeFileSync(path.join(dir, 'partitura.abc'), abc, 'utf8'); meta.abc = abc; }
  if (lyrics != null) { fs.writeFileSync(path.join(dir, 'letra.txt'), lyrics, 'utf8'); meta.lyrics = lyrics; }
  fs.writeFileSync(f, JSON.stringify(meta, null, 2));
  return true;
});

// Arrastar um arquivo para fora do app (ex.: soltar o vocal no Applio/RVC).
ipcMain.on('arrastar', (e, alvo) => {
  // um arquivo ou vários de uma vez
  const files = (Array.isArray(alvo) ? alvo : [alvo]).filter((f) => f && fs.existsSync(f));
  const file = files[0];
  if (!file) return;
  const ext = path.extname(file).toLowerCase();
  const icon = dragIcons[ext] || dragIcons['*'];
  if (!dragIcons[ext]) app.getFileIcon(file, { size: 'normal' }).then((i) => { dragIcons[ext] = i; }).catch(() => {});
  if (icon) e.sender.startDrag(files.length > 1 ? { file, files, icon } : { file, icon });
});

// Trabalho terminou e a janela não está na frente: o botão do app pisca na barra de tarefas até ela ser aberta.
ipcMain.on('piscar', () => {
  if (!win || win.isDestroyed() || win.isFocused()) return;
  win.flashFrame(true);
  win.once('focus', () => { if (!win.isDestroyed()) win.flashFrame(false); });
});

// ---------- IPC: limpeza de disco ----------
// Cada música guarda arquivos de trabalho em <pasta>\_trabalho (download, vocais intermediários, registro).
// A limpeza manda essas pastas para a Lixeira; a música pronta fica onde está.
function tamanhoDe(dir) {
  let total = 0;
  let itens = [];
  try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const it of itens) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) total += tamanhoDe(p);
    else { try { total += fs.statSync(p).size; } catch {} }
  }
  return total;
}
function pastasDeTrabalho() {
  let musicas = [];
  try { musicas = fs.readdirSync(paths.outDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  const agora = Date.now();
  const out = [];
  for (const d of musicas) {
    const t = path.join(paths.outDir, d.name, '_trabalho');
    let st = null;
    try { st = fs.statSync(t); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.push({ dir: t, bytes: tamanhoDe(t), dias: (agora - st.mtimeMs) / 86400000 });
  }
  return out;
}
ipcMain.handle('trabalho-medir', () => {
  const p = pastasDeTrabalho();
  const soma = (l) => l.reduce((s, x) => s + x.bytes, 0);
  const antigas = p.filter((x) => x.dias > 7);
  return { pastas: p.length, bytes: soma(p), antigas: antigas.length, bytesAntigas: soma(antigas) };
});
ipcMain.handle('trabalho-limpar', async (_e, { dias }) => {
  if (current) return { ok: false, error: 'Espere o trabalho atual terminar.' };
  let pastas = 0;
  let bytes = 0;
  // nunca mexe no que foi usado na última hora
  for (const x of pastasDeTrabalho().filter((y) => y.dias > Math.max(Number(dias) || 0, 1 / 24))) {
    try { await shell.trashItem(x.dir); pastas++; bytes += x.bytes; } catch {}
  }
  return { ok: true, pastas, bytes };
});

// ---------- IPC: forma de onda ----------
// Picos do áudio para desenhar a onda. Decodifica com ffmpeg (mono, 4 kHz) e guarda em cache ao lado do arquivo.
ipcMain.handle('picos', (_e, { file, n }) => new Promise((resolve) => {
  n = Math.max(40, Math.min(6000, Math.round(n) || 180));
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return resolve(null); }
  // o cache fica nos dados do app (no D:), não ao lado do áudio, para a pasta da música ficar limpa
  const cacheDir = path.join(app.getPath('userData'), 'picos');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = path.join(cacheDir, crypto.createHash('md5').update(file.toLowerCase() + '|' + n).digest('hex') + '.json');
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (c.n === n && c.mtime === mtime) return resolve(c);
  } catch {}
  const ff = spawn(paths.ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '4000', '-f', 's16le', '-'], { windowsHide: true });
  const chunks = [];
  ff.stdout.on('data', (c) => chunks.push(c));
  ff.on('error', () => resolve(null));
  ff.on('close', () => {
    const buf = Buffer.concat(chunks);
    const total = Math.floor(buf.length / 2);
    if (!total) return resolve(null);
    const per = Math.max(1, Math.floor(total / n));
    const peaks = [];
    for (let i = 0; i < n; i++) {
      let max = 0;
      const end = Math.min(total, (i + 1) * per);
      for (let j = i * per; j < end; j++) {
        const v = Math.abs(buf.readInt16LE(j * 2));
        if (v > max) max = v;
      }
      peaks.push(Math.round((max / 32768) * 1000) / 1000);
    }
    const res = { n, mtime, duration: total / 4000, peaks };
    try { fs.writeFileSync(cache, JSON.stringify(res)); } catch {}
    resolve(res);
  });
}));

// ---------- IPC: histórico ----------
ipcMain.handle('historico', () => {
  ensureDirs();
  const items = [];
  for (const id of fs.readdirSync(paths.outDir)) {
    const f = path.join(paths.outDir, id, 'job.json');
    if (!fs.existsSync(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      // a pasta leva o nome da música; a ordem vem do id (data e hora) guardado no job.json
      items.push({ ...m, id: m.id || id, dir: path.join(paths.outDir, id) });
    } catch {}
  }
  return items.sort((a, b) => (a.id < b.id ? 1 : -1));
});

ipcMain.handle('apagar-item', async (_e, dir) => {
  // só mexe dentro da pasta de saída, e manda para a Lixeira (dá para restaurar)
  const rel = path.relative(paths.outDir, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try { await shell.trashItem(dir); return true; } catch { return false; }
});

// ---------- IPC: presets ----------
ipcMain.handle('presets-listar', () => readPresets());
ipcMain.handle('presets-salvar', (_e, preset) => {
  const list = readPresets().filter((p) => p.nome !== preset.nome);
  list.push(preset);
  writePresets(list);
  return list;
});
ipcMain.handle('presets-apagar', (_e, nome) => {
  const list = readPresets().filter((p) => p.nome !== nome);
  writePresets(list);
  return list;
});

// ---------- IPC: instalar as funções (src/componentes.js) ----------
const componentes = require('./src/componentes');
const ctxComponentes = () => ({
  applioDir: readConfig().applioDir,
  // depois de instalar o Applio dentro da pasta do app, passa a usar esse, se o atual não servir
  usarApplio: (dir) => {
    const c = readConfig();
    if (!c.applioDir || !fs.existsSync(path.join(c.applioDir, 'core.py'))) { c.applioDir = dir; writeConfig(c); }
  },
});
ipcMain.handle('componentes-estado', () => componentes.estado(ctxComponentes()));
ipcMain.handle('componentes-instalar', async (_e, ids) => {
  try {
    await componentes.instalar(ids, ctxComponentes(), (ev) => {
      if (ev.linha) { instalacaoRecente.push(ev.linha); if (instalacaoRecente.length > 200) instalacaoRecente.shift(); }
      if (ev.fim === 'erro') guardarErro('instalar ' + ev.id, ev.erro);
      if (win && !win.isDestroyed()) win.webContents.send('componentes', ev);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('componentes-cancelar', () => { componentes.cancelar(); return true; });

// ---------- IPC: informações e diagnóstico ----------
function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '') + (stderr || '') }));
  });
}

ipcMain.handle('info', () => ({ nome: APP_NAME, limiteSegundos: MAX_SECONDS, pastaSaida: paths.outDir, motor,
  temReferenciaPadrao: fs.existsSync(models.referenciaPadrao), referenciaPadrao: models.referenciaPadrao }));

// Gravação da voz feita na aba Fala: chega em webm (Opus) e vira wav mono 24 kHz, que é o que o Chatterbox lê.
ipcMain.handle('salvar-gravacao', async (_e, dados) => {
  try {
    const pasta = path.join(app.getPath('userData'), 'gravacoes');
    fs.mkdirSync(pasta, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const nome = `minha-voz-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const webm = path.join(pasta, nome + '.webm');
    const wav = path.join(pasta, nome + '.wav');
    fs.writeFileSync(webm, Buffer.from(dados));
    const r = await sh(paths.ffmpeg, ['-v', 'error', '-y', '-i', webm, '-ac', '1', '-ar', '24000', wav]);
    fs.rmSync(webm, { force: true });
    if (!r.ok || !fs.existsSync(wav)) return { ok: false, error: r.out.trim().split('\n').pop() || 'o ffmpeg falhou' };
    return { ok: true, file: wav };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// VRAM livre agora (MiB), para avisar antes de uma gravação longa.
ipcMain.handle('vram', async () => {
  const r = await sh('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
  if (!r.ok) return null;
  const [used, total] = r.out.trim().split('\n')[0].split(',').map((s) => parseInt(s, 10));
  return isFinite(used) && isFinite(total) ? { used, total, free: total - used } : null;
});

ipcMain.handle('diagnostico', async () => {
  const checks = [];
  const file = (nome, p) => checks.push({ nome, ok: fs.existsSync(p), detalhe: p });
  file(`Motor de gravação (${motor === 'cuda' ? 'CUDA, placa NVIDIA' : 'Vulkan'})`, paths.yueSynth);
  file('Partitura (yue-transcribe)', paths.yueTranscribe);
  file('Letra (whisper-cli)', paths.whisper);
  file('Separador de vocal', paths.separator);
  file('Modelo YuE2 (Q8_0)', models.backbone);
  file('Modelo VAE', models.vae);
  file('Modelo SheetSage2', models.sheetsage);
  file('Modelo MERT', models.mert);
  file('Modelo Whisper', models.whisper);
  file('Modelo de separação', path.join(paths.separatorModelsDir, separator.model));
  const progs = [
    ['yt-dlp', paths.ytdlp, ['--version']],
    ['ffmpeg', paths.ffmpeg, ['-version']],
  ];
  // tudo em paralelo: yt-dlp.exe e o PowerShell demoram alguns segundos para abrir
  const [progRes, gpu, nv] = await Promise.all([
    Promise.all(progs.map(([, cmd, args]) => sh(cmd, args))),
    sh('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }']),
    sh('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader']),
  ]);
  progs.forEach(([nome], i) => {
    const r = progRes[i];
    checks.push({ nome, ok: r.ok, detalhe: r.ok ? r.out.split('\n')[0].trim() : 'não encontrado no PATH' });
  });
  return {
    checks,
    gpus: gpu.ok ? gpu.out.split('\n').map((s) => s.trim()).filter(Boolean) : [],
    vram: nv.ok ? nv.out.trim() : null,
    limiteSegundos: MAX_SECONDS,
    pastaSaida: paths.outDir,
  };
});

ipcMain.handle('atualizar-ytdlp', async () => {
  const r = await sh(paths.ytdlp, ['-U']);
  if (/package manager|winget|pip/i.test(r.out)) {
    const w = await sh('winget', ['upgrade', '-e', '--id', 'yt-dlp.yt-dlp', '--silent',
      '--accept-package-agreements', '--accept-source-agreements']);
    return { ok: w.ok, texto: w.out.trim().split('\n').slice(-3).join('\n') };
  }
  return { ok: r.ok, texto: r.out.trim().split('\n').slice(-3).join('\n') };
});
