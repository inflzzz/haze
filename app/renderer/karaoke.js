// Tela do karaokê. O som (instrumental, microfone, plugins, gravação) roda em src/karaoke.py; esta tela manda
// comandos e desenha letra, tempo e controles com o que o motor conta (linhas ESTADO a cada 50 ms).
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...filhos) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const f of filhos) if (f) e.append(f);
  return e;
};
const fmt = (s) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const virgula = (n) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1).replace('.', ',') + ' s';
const motor = (c) => api.karaokeMotor(c);

const st = {
  cfg: {},            // config.karaoke salva (aparelhos por nome, efeitos, volumes)
  aparelhos: null,
  musica: null,       // job.json da música carregada
  linhas: [],         // letra sincronizada
  atraso: 0,          // segundos somados aos tempos da letra
  efeitos: [],        // o que o motor contou (EFEITOS)
  pos: 0, posEm: 0, tocando: false, gravando: false, duracao: 0,
  arrastando: false,
  preparando: false,
  motorVivo: false,
  transpor: 0,        // semitons em que a música está tocando
  melodia: null,      // { passo, midi[] } da voz original
  trilha: [],         // notas cantadas: { t, m, certo }
  placar: { certas: 0, cantadas: 0 },
};

function status(texto, erro) {
  $('k-status').textContent = texto || '';
  $('k-status').classList.toggle('erro', !!erro);
}

// ---------- preferências ----------
async function salvarCfg(patch) {
  const c = await api.configLer();
  st.cfg = { ...(c.karaoke || {}), ...patch };
  await api.configSalvar({ karaoke: st.cfg });
}

// ---------- aparelhos ----------
function preencherAparelhos() {
  const a = st.aparelhos;
  const opcoes = (sel, lista, nomeSalvo, padrao) => {
    sel.replaceChildren(...lista.map((x) => el('option', { value: String(x.id), text: x.nome })));
    const achado = lista.find((x) => x.nome === nomeSalvo) || lista.find((x) => x.id === padrao) || lista[0];
    if (achado) sel.value = String(achado.id);
  };
  opcoes($('k-entrada'), a.entradas, st.cfg.entradaNome, a.padrao[0]);
  opcoes($('k-saida'), a.saidas, st.cfg.saidaNome, a.padrao[1]);
}
function abrirAparelhos() {
  return motor({
    cmd: 'aparelhos', entrada: Number($('k-entrada').value), saida: Number($('k-saida').value),
    exclusivo: $('k-exclusivo').getAttribute('aria-checked') === 'true',
  });
}
for (const id of ['k-entrada', 'k-saida']) {
  $(id).addEventListener('change', async () => {
    const nome = (sel) => (sel.selectedOptions[0] || {}).textContent || '';
    await salvarCfg({ entradaNome: nome($('k-entrada')), saidaNome: nome($('k-saida')) });
    abrirAparelhos();
  });
}

// ---------- motor ----------
// Liga o motor e manda tudo que ele precisa saber. Chamado na abertura e quando ele cai.
async function iniciarMotor() {
  st.motorVivo = true;
  if (st.aparelhos) await abrirAparelhos();
  await mandarVolumes();
  await motor({ cmd: 'ouvir', ligado: $('k-ouvir').getAttribute('aria-checked') === 'true' });
  await mandarEfeitos();
  if (st.musica) await motor({ cmd: 'musica', instrumental: st.inst || st.musica.instrumental, guia: st.guia || st.musica.guia });
}
function mandarEfeitos() {
  st.efeitos = [];
  st.tomPendente = true;
  $('k-ef-nota').textContent = (st.cfg.efeitos || []).length ? 'carregando…' : '';
  return motor({ cmd: 'efeitos', lista: (st.cfg.efeitos || []).map((x) => ({ arquivo: x.arquivo, ligado: x.ligado !== false })) });
}
function mandarVolumes() {
  const v = (id) => Number($(id).value) / 100;
  $('k-v-inst-n').textContent = $('k-v-inst').value + '%';
  $('k-v-voz-n').textContent = $('k-v-voz').value + '%';
  $('k-v-guia-n').textContent = $('k-v-guia').value + '%';
  return motor({ cmd: 'volumes', instrumental: v('k-v-inst'), voz: v('k-v-voz'), guia: v('k-v-guia') });
}
let salvarVolumes = 0;
for (const id of ['k-v-inst', 'k-v-voz', 'k-v-guia']) {
  $(id).addEventListener('input', () => {
    mandarVolumes();
    clearTimeout(salvarVolumes);
    salvarVolumes = setTimeout(() => salvarCfg({ volumes: { inst: $('k-v-inst').value, voz: $('k-v-voz').value, guia: $('k-v-guia').value } }), 600);
  });
}
const chave = (id, cb) => $(id).addEventListener('click', () => {
  const on = $(id).getAttribute('aria-checked') !== 'true';
  $(id).setAttribute('aria-checked', String(on));
  cb(on);
});
chave('k-ouvir', (on) => { motor({ cmd: 'ouvir', ligado: on }); salvarCfg({ ouvir: on }); });
chave('k-semcoro', (on) => salvarCfg({ semCoro: on }));
chave('k-exclusivo', (on) => { salvarCfg({ exclusivo: on }); abrirAparelhos(); });

api.onKaraokeMotor((ev) => {
  switch (ev.tipo) {
    case 'ESTADO': return estado(ev);
    case 'EFEITOS': mostrarEfeitos(ev.lista); return talvezTom();
    case 'MUSICA':
      st.duracao = ev.duracao;
      $('k-barra').max = String(ev.duracao);
      $('k-play').disabled = false;
      $('k-barra').disabled = false;
      $('k-rec').disabled = false;
      talvezTom();
      return status('Pronta. Espaço toca e pausa.');
    case 'TOM':
      st.tomNoPlugin = ev.plugins.length ? ev.plugins.join(', ') : '';
      return mostrarTom();
    case 'GRAVADO': return gravado(ev);
    case 'EDITOR':
      return status(ev.aberto ? 'Efeitos em pausa enquanto a tela do plugin estiver aberta. Ajuste e feche no X para ouvir de novo.' : 'Ajuste do plugin salvo.');
    case 'APARELHOS_OK': $('k-lamp-mic').className = 'lamp sinal'; return;
    case 'AVISO': return status(ev.mensagem, true);
    case 'ERRO': $('k-lamp-mic').className = 'lamp erro'; return status(ev.mensagem, true);
    case 'CAIU':
      st.motorVivo = false;
      st.tocando = false;
      status('O motor de som parou. Religando…', true);
      return setTimeout(iniciarMotor, 1500);
    default:
  }
});

// ---------- tom da música ----------
const NOTAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
// tom medido, já com a troca de tom aplicada
function tomAgora() {
  const t = st.musica && st.musica.tom;
  if (!t) return null;
  const base = NOTAS.indexOf(t.nota);
  if (base < 0) return null;
  const n = (((base + (st.transpor || 0)) % 12) + 12) % 12;
  const rel = t.modo === 'maior' ? [(n + 9) % 12, 'menor'] : [(n + 3) % 12, 'maior'];
  return { nota: NOTAS[n], modo: t.modo, nome: `${NOMES[n]} ${t.modo}`, relativo: `${NOMES[rel[0]]} ${rel[1]}` };
}
function mostrarTom() {
  const t = tomAgora();
  const g = $('k-tomgrupo');
  g.hidden = !st.musica;
  const s = st.alvoTom != null ? st.alvoTom : st.transpor || 0;
  const marca = s ? ` ${s > 0 ? '+' : ''}${s}` : '';
  $('k-tom').textContent = (t ? t.nome : 'tom') + marca;
  const incerto = !!(st.musica && st.musica.tom && st.musica.tom.outra);
  g.classList.toggle('incerto', incerto);
  $('k-tom').title = [
    t ? `${t.nome} tem as mesmas notas que ${t.relativo}.` : 'Tom não medido.',
    incerto ? `Medição incerta: pode ser ${st.musica.tom.outra.nome} (no tom original). Se soar errado, troque no controle Tom do Auto-Tune.` : '',
    st.tomNoPlugin ? `Já posto no ${st.tomNoPlugin}.` : '',
    s ? `Música ${s > 0 ? 'subida' : 'descida'} ${Math.abs(s)} meio${Math.abs(s) > 1 ? 's' : ''} tom.` : '',
  ].filter(Boolean).join('\n');
}
function mandarTom() {
  const t = tomAgora();
  if (t) motor({ cmd: 'tom', nota: t.nota, modo: t.modo });
}

// Troca de tom: os botões só mexem no número; meio segundo depois do último clique a música é refeita
// no tom novo (a primeira vez de cada tom leva alguns segundos) e continua do mesmo ponto.
let esperaTom = 0;
function pedirTom(d) {
  if (!st.musica || st.trocandoTom) return;
  st.alvoTom = Math.max(-7, Math.min(7, (st.alvoTom != null ? st.alvoTom : st.transpor || 0) + d));
  mostrarTom();
  clearTimeout(esperaTom);
  esperaTom = setTimeout(aplicarTom, 600);
}
$('k-tom-menos').addEventListener('click', () => pedirTom(-1));
$('k-tom-mais').addEventListener('click', () => pedirTom(1));
async function aplicarTom() {
  const alvo = st.alvoTom;
  if (alvo == null || !st.musica) return;
  if (alvo === (st.transpor || 0)) { st.alvoTom = null; return mostrarTom(); }
  st.trocandoTom = true;
  const pos = posAgora();
  const tocava = st.tocando;
  if (tocava) motor({ cmd: 'pausar' });
  status('Passando a música para o tom novo…');
  const r = await api.karaokeTom({ dir: st.musica.dir, semitons: alvo });
  st.trocandoTom = false;
  st.alvoTom = null;
  if (!r.ok) {
    mostrarTom();
    if (tocava) motor({ cmd: 'tocar' });
    return status(r.cancelled ? 'Troca de tom parada.' : r.error.split('\n')[0], !r.cancelled);
  }
  st.transpor = r.data.transpor;
  st.inst = r.data.instrumental;
  st.guia = r.data.guia;
  st.tomPendente = true;   // o Auto-Tune recebe o tom novo assim que a música recarregar
  mostrarTom();
  zerarPlacar();
  await motor({ cmd: 'musica', instrumental: st.inst, guia: st.guia, pos, tocar: tocava });
}

// ---------- afinação ----------
// A melodia da voz original (nota a cada 20 ms) vira barras rolando; a nota que a pessoa canta, medida pelo
// motor na voz crua, vira pontos por cima. Cantar uma oitava abaixo ou acima conta como certo.
const dobrar = (d) => ((((d + 6) % 12) + 12) % 12) - 6;   // diferença em semitons, sem contar oitava
function notaDaMusica(t) {
  const m = st.melodia;
  if (!m) return 0;
  const i = Math.round(t / m.passo);
  const v = i >= 0 && i < m.midi.length ? m.midi[i] : 0;
  return v > 0 ? v + (st.transpor || 0) : 0;
}
function zerarPlacar() {
  st.trilha = [];
  st.placar = { certas: 0, cantadas: 0 };
  $('k-placar').hidden = true;
}
function ouvirVoz(ev) {
  if (ev.voz == null || ev.voz_pos == null || !st.melodia) return;
  const ref = notaDaMusica(ev.voz_pos);
  if (!ref) return;
  const d = dobrar(ev.voz - ref);
  const certo = Math.abs(d) <= 0.6;
  st.trilha.push({ t: ev.voz_pos, m: ref + d, certo });
  if (st.trilha.length > 400) st.trilha.splice(0, 200);
  st.placar.cantadas++;
  if (certo) st.placar.certas++;
  if (st.placar.cantadas >= 20) {
    $('k-placar').hidden = false;
    $('k-placar').textContent = `Afinação ${placarPct()}%`;
  }
}
const placarPct = () => Math.round((100 * st.placar.certas) / Math.max(1, st.placar.cantadas));

async function carregarMelodia(dir) {
  st.melodia = null;
  $('k-regua').hidden = true;
  const r = await api.karaokeMelodia(dir);
  if (!st.musica || st.musica.dir !== dir) return;
  if (!r.ok) return status('Sem régua de afinação: ' + r.error.split('\n')[0], true);
  const m = r.data;
  const vozes = m.midi.filter((x) => x > 0).sort((a, b) => a - b);
  if (vozes.length < 50) return;
  const lo = vozes[Math.floor(vozes.length * 0.02)];
  const hi = vozes[Math.floor(vozes.length * 0.98)];
  const meio = (lo + hi) / 2;
  const meia = Math.max(7, (hi - lo) / 2 + 2);
  st.melodia = m;
  st.faixa = { lo: meio - meia, hi: meio + meia };
  $('k-regua').hidden = false;
  // a medição da melodia também remede o tom: pega o resultado novo
  const novo = await api.karaokeLer(dir);
  if (novo && st.musica && st.musica.dir === dir && JSON.stringify(novo.tom) !== JSON.stringify(st.musica.tom)) {
    st.musica.tom = novo.tom;
    st.tomPendente = true;
    mostrarTom();
    talvezTom();
  }
}

function cores() {
  if (st.cores) return st.cores;
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  st.cores = { ambar: v('--ambar'), verde: v('--verde'), serigrafia: v('--serigrafia'), aresta: v('--aresta'), painel3: v('--painel-3'), aco: v('--aco') };
  return st.cores;
}
function desenharRegua(pos) {
  const cv = $('k-regua');
  if (cv.hidden || !st.melodia) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  const c = cores();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const ANTES = 3;
  const DEPOIS = 5;
  const px = w / (ANTES + DEPOIS);
  const X = (t) => (t - pos + ANTES) * px;
  const lo = st.faixa.lo + (st.transpor || 0);
  const hi = st.faixa.hi + (st.transpor || 0);
  const semi = (h - 16) / (hi - lo);
  const Y = (m) => h - 8 - (m - lo) * semi;
  // linhas de oitava (dó), bem apagadas
  g.strokeStyle = c.aresta;
  g.globalAlpha = 0.35;
  g.lineWidth = 1;
  for (let m = Math.ceil(lo / 12) * 12; m <= hi; m += 12) { g.beginPath(); g.moveTo(0, Y(m)); g.lineTo(w, Y(m)); g.stroke(); }
  g.globalAlpha = 1;
  // notas da música: trechos seguidos na mesma nota viram uma barra
  const M = st.melodia.midi;
  const P = st.melodia.passo;
  const i0 = Math.max(0, Math.floor((pos - ANTES) / P));
  const i1 = Math.min(M.length, Math.ceil((pos + DEPOIS) / P));
  const alt = Math.max(4, Math.min(10, semi * 0.8));
  for (let i = i0; i < i1;) {
    if (!(M[i] > 0)) { i++; continue; }
    const nota = Math.round(M[i]);
    let j = i + 1;
    while (j < i1 && M[j] > 0 && Math.round(M[j]) === nota) j++;
    const t0 = i * P;
    const t1 = j * P;
    g.fillStyle = t0 <= pos && pos < t1 ? c.ambar : c.painel3;
    g.fillRect(X(t0), Y(nota + (st.transpor || 0)) - alt / 2, Math.max(2, X(t1) - X(t0) - 1), alt);
    i = j;
  }
  // agulha
  g.fillStyle = c.serigrafia;
  g.globalAlpha = 0.5;
  g.fillRect(X(pos), 0, 1, h);
  g.globalAlpha = 1;
  // a sua voz
  let antes = null;
  for (const p of st.trilha) {
    if (p.t < pos - ANTES || p.t > pos + 0.5) { antes = null; continue; }
    const x = X(p.t);
    const y = Y(p.m);
    if (antes && p.t - antes.t < 0.15) {
      g.strokeStyle = p.certo ? c.verde : c.serigrafia;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(antes.x, antes.y); g.lineTo(x, y); g.stroke();
    }
    g.fillStyle = p.certo ? c.verde : c.serigrafia;
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
    antes = { t: p.t, x, y };
  }
}
// O tom da música vai para o Auto-Tune uma vez por música (ou por corrente de plugins nova), quando os dois
// estão prontos. Depois disso, o que a pessoa escolher no controle Tom vale.
function talvezTom() {
  if (!st.tomPendente || !st.musica || !st.musica.tom || !st.efeitos.some((x) => x.ok)) return;
  st.tomPendente = false;
  mandarTom();
}

// ---------- estado vindo do motor ----------
function estado(ev) {
  st.pos = ev.pos;
  st.posEm = performance.now();
  st.tocando = ev.tocando;
  if (ev.duracao) st.duracao = ev.duracao;
  if (st.gravando !== ev.gravando) {
    st.gravando = ev.gravando;
    $('k-rec').classList.toggle('gravando', ev.gravando);
    $('k-rec').title = ev.gravando ? 'Parar e salvar a gravação' : 'Gravar (a partir de onde a música está)';
  }
  $('k-play').textContent = ev.tocando ? '❚❚' : '▶';
  $('k-play').setAttribute('aria-label', ev.tocando ? 'Pausar' : 'Tocar');
  const n = Math.min(1, ev.nivel || 0);
  $('k-nivel').style.width = Math.round(Math.sqrt(n) * 100) + '%';
  $('k-nivel').classList.toggle('alto', n > 0.95);
  $('k-lat').textContent = ev.microfone
    ? `Atraso até o fone: ~${ev.latencia_ms} ms (Windows ${ev.lat_som} · plugins ${ev.lat_plugins} · fila ${ev.lat_fila})` + (ev.pausa ? ' · efeitos em pausa' : '')
    : 'Microfone desligado';
  ouvirVoz(ev);
}
function posAgora() {
  if (!st.tocando) return st.pos;
  return Math.min(st.duracao || Infinity, st.pos + (performance.now() - st.posEm) / 1000);
}

// ---------- letra ----------
let desenhada = '';
function quadro() {
  const pos = posAgora();
  if (!st.arrastando) $('k-barra').value = String(pos);
  $('k-tempo').textContent = `${fmt(pos)} / ${fmt(st.duracao)}`;
  if (st.linhas.length) desenharLetra(pos);
  desenharRegua(pos);
  requestAnimationFrame(quadro);
}
requestAnimationFrame(quadro);

function desenharLetra(pos) {
  const L = st.linhas;
  const t = (i) => L[i].t + st.atraso;
  let i = -1;
  for (let k = 0; k < L.length; k++) { if (t(k) <= pos) i = k; else break; }
  const box = $('k-letra');
  const chaveQuadro = String(i);
  if (chaveQuadro !== desenhada) {
    desenhada = chaveQuadro;
    const linha = (k, cls) => {
      if (k < 0 || k >= L.length) return null;
      const txt = L[k].texto;
      return el('div', { class: 'k-l ' + cls + (txt ? '' : ' pausa'), text: txt || '♪ ♪ ♪' });
    };
    box.replaceChildren(...[
      el('div', { class: 'k-conta', id: 'k-conta' }),
      linha(i - 1, 'antes'),
      i >= 0 ? linha(i, 'agora') : el('div', { class: 'k-l agora pausa', text: '♪ ♪ ♪' }),
      linha(i + 1, 'depois'),
      linha(i + 2, 'depois'),
    ].filter(Boolean));
  }
  // preenchimento da linha atual: anda do início dela até perto da próxima
  const agora = box.querySelector('.k-l.agora');
  if (agora && i >= 0) {
    const fim = i + 1 < L.length ? t(i + 1) : t(i) + 4;
    const dur = Math.min(Math.max(0.6, (fim - t(i)) * 0.85), 3 + L[i].texto.length * 0.12);
    agora.style.setProperty('--p', Math.min(100, ((pos - t(i)) / dur) * 100).toFixed(1) + '%');
  }
  // contagem antes da próxima linha cantada quando vem de pausa longa
  const conta = $('k-conta');
  if (conta) {
    let prox = i + 1;
    while (prox < L.length && !L[prox].texto) prox++;
    const falta = prox < L.length ? t(prox) - pos : Infinity;
    const pausaLonga = i < 0 || !L[i].texto || (prox < L.length && t(prox) - t(i) > 6);
    const n = pausaLonga && falta > 0 && falta <= 3 ? Math.ceil(falta) : 0;
    if (conta.childElementCount !== n) conta.replaceChildren(...Array.from({ length: n }, () => el('i')));
  }
}

function mostrarLetraParada() {
  const m = st.musica;
  const box = $('k-letra');
  desenhada = '';
  st.linhas = (m && m.letra && m.letra.linhas) || [];
  if (st.linhas.length) return;
  if (m && m.letra && m.letra.simples) {
    box.replaceChildren(el('div', { class: 'k-simples', text: m.letra.simples }));
    return status('Achei só a letra sem tempo: ela fica parada na tela.');
  }
  box.replaceChildren(el('div', { class: 'k-vazio', text: m ? 'Não achei a letra desta música. Busque pelo nome na lateral (Letra).' : 'A letra aparece aqui.' }));
}

function mostrarAtraso() {
  const medido = st.musica ? Number(st.musica.atrasoMedido) || 0 : 0;
  $('k-atraso').textContent = virgula(st.atraso) + (Math.abs(st.atraso - medido) < 0.05 && medido ? ' (medido)' : '');
}
let salvarAtraso = 0;
const mudarAtraso = (d) => {
  st.atraso = Math.round((st.atraso + d) * 10) / 10;
  desenhada = '';
  mostrarAtraso();
  clearTimeout(salvarAtraso);
  if (st.musica) salvarAtraso = setTimeout(() => api.karaokeAtraso({ dir: st.musica.dir, atraso: st.atraso }), 500);
};
$('k-atraso-menos').addEventListener('click', () => mudarAtraso(-0.2));
$('k-atraso-mais').addEventListener('click', () => mudarAtraso(0.2));

// ---------- música ----------
async function carregar(dir) {
  const m = await api.karaokeLer(dir);
  if (!m || !m.instrumental) return status('Não consegui abrir essa música.', true);
  st.musica = m;
  st.tomPendente = true;
  st.tomNoPlugin = '';
  st.alvoTom = null;
  st.atraso = Number(m.atraso) || 0;
  // a música abre no tom em que foi cantada da última vez
  st.transpor = 0;
  st.inst = m.instrumental;
  st.guia = m.guia;
  if (m.transpor) {
    status('Abrindo no tom que você usou da última vez…');
    const r = await api.karaokeTom({ dir, semitons: m.transpor });
    if (r.ok) { st.transpor = r.data.transpor; st.inst = r.data.instrumental; st.guia = r.data.guia; }
  }
  zerarPlacar();
  mostrarTom();
  $('k-titulo').textContent = m.title || 'Sem título';
  const l = m.letra;
  $('k-sub').textContent = l && (l.musica || l.artista) ? [l.artista, l.musica].filter(Boolean).join(' — ') + ' · letra do LRCLIB' : 'sem letra';
  $('k-busca').value = l && l.musica ? [l.artista, l.musica].filter(Boolean).join(' ') : (m.title || '');
  $('k-lamp').className = 'lamp sinal';
  $('k-gravado').hidden = true;
  mostrarAtraso();
  mostrarLetraParada();
  $('k-play').disabled = true;
  status('Carregando a música…');
  await motor({ cmd: 'musica', instrumental: st.inst, guia: st.guia });
  carregarMelodia(dir);
}

async function preparar() {
  const link = $('k-link').value.trim();
  if (!link) return $('k-link').focus();
  if (!/^https?:\/\//i.test(link)) return status('Isso não parece um link.', true);
  if (st.preparando) return;
  st.preparando = true;
  $('k-preparar').disabled = true;
  $('k-prog').hidden = false;
  $('k-gravado').hidden = true;
  $('k-prog-txt').textContent = 'Começando…';
  $('k-prog-barra').style.width = '0%';
  $('k-lamp').className = 'lamp pisca';
  if (st.tocando) motor({ cmd: 'pausar' });
  const r = await api.karaokePreparar({ url: link, semCoro: $('k-semcoro').getAttribute('aria-checked') === 'true' });
  st.preparando = false;
  $('k-preparar').disabled = false;
  $('k-prog').hidden = true;
  if (!r.ok) {
    $('k-lamp').className = r.cancelled ? 'lamp' : 'lamp erro';
    return status(r.cancelled ? 'Parado.' : r.error.split('\n')[0], !r.cancelled);
  }
  $('k-link').value = '';
  await carregarRecentes();
  carregar(r.data.dir);
}
// etapas do preparo e quanto cada uma pesa na barra
const ETAPAS = { download: [0, 25], voz: [25, 85], separar: [25, 85], letra: [85, 100], fim: [100, 100] };
api.onKaraokeProgresso((ev) => {
  if (!st.preparando && !['letra', 'tom', 'melodia'].includes(ev.stage)) return;
  const [a, b] = ETAPAS[ev.stage] || [0, 100];
  const pct = a + ((b - a) * Math.max(0, Math.min(100, Number(ev.pct) || 0))) / 100;
  $('k-prog-barra').style.width = pct.toFixed(0) + '%';
  if (ev.message) $('k-prog-txt').textContent = ev.message;
  if (!st.preparando) status(ev.message || '');
});
$('k-preparar').addEventListener('click', preparar);
$('k-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') preparar(); });
$('k-cancelar').addEventListener('click', () => api.cancelar());
// Ctrl+V em qualquer lugar fora de um campo: cola o link e já começa
document.addEventListener('paste', (e) => {
  const alvo = e.target;
  if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA')) return;
  const texto = (e.clipboardData.getData('text') || '').trim();
  if (!/^https?:\/\//i.test(texto)) return;
  e.preventDefault();
  $('k-link').value = texto;
  preparar();
});

async function carregarRecentes() {
  const lista = await api.karaokeRecentes();
  $('k-recentes').replaceChildren(el('option', { value: '', text: lista.length ? 'Já preparadas…' : 'Nenhuma preparada ainda' }),
    ...lista.map((x) => el('option', { value: x.dir, text: `${x.title}${x.duration ? ' · ' + fmt(x.duration) : ''}` })));
}
$('k-recentes').addEventListener('change', () => {
  const dir = $('k-recentes').value;
  $('k-recentes').value = '';
  if (dir) carregar(dir);
});

// letra buscada pelo nome
$('k-buscar').addEventListener('click', buscarLetra);
$('k-busca').addEventListener('keydown', (e) => { if (e.key === 'Enter') buscarLetra(); });
async function buscarLetra() {
  if (!st.musica) return status('Escolha uma música antes.', true);
  const busca = $('k-busca').value.trim();
  if (!busca) return;
  status('Procurando a letra…');
  const r = await api.karaokeLetra({ dir: st.musica.dir, busca });
  if (!r.ok) return status(r.error.split('\n')[0], true);
  const m = await api.karaokeLer(st.musica.dir);
  st.musica = m;
  st.atraso = Number(m.atraso) || 0;
  const l = m.letra || {};
  $('k-sub').textContent = [l.artista, l.musica].filter(Boolean).join(' — ') + ' · letra do LRCLIB';
  mostrarAtraso();
  mostrarLetraParada();
  status('Letra trocada.');
}

// ---------- transporte ----------
function tocarPausar() {
  if ($('k-play').disabled) return;
  if (st.tocando) motor({ cmd: 'pausar' });
  else motor({ cmd: 'tocar' });
  st.tocando = !st.tocando;
  st.pos = posAgora();
  st.posEm = performance.now();
}
$('k-play').addEventListener('click', tocarPausar);
const ir = (s) => {
  s = Math.max(0, Math.min(st.duracao || 0, s));
  motor({ cmd: 'ir', s });
  st.pos = s;
  st.posEm = performance.now();
  desenhada = '';
  st.trilha = [];
  if (s < 1) zerarPlacar();   // voltou para o começo: placar novo
};
$('k-barra').addEventListener('input', () => { st.arrastando = true; $('k-tempo').textContent = `${fmt($('k-barra').value)} / ${fmt(st.duracao)}`; });
$('k-barra').addEventListener('change', () => { st.arrastando = false; ir(Number($('k-barra').value)); });
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' && t.type !== 'range' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (e.code === 'Space') { e.preventDefault(); tocarPausar(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); ir(posAgora() - 5); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); ir(posAgora() + 5); }
});

$('k-rec').addEventListener('click', () => {
  if (!st.musica) return;
  if (st.gravando) { motor({ cmd: 'parar_gravacao' }); return status('Salvando a gravação…'); }
  $('k-gravado').hidden = true;
  zerarPlacar();
  motor({ cmd: 'gravar', pasta: st.musica.dir, nome: st.musica.title + (st.transpor ? ` (tom ${st.transpor > 0 ? '+' : ''}${st.transpor})` : '') });
  status('Gravando. Clique de novo para parar e salvar; no fim da música salva sozinho.');
});
function gravado(ev) {
  const box = $('k-gravado');
  if (!ev.arquivos || !ev.arquivos.length) { box.hidden = true; return status(ev.aviso || 'Nada foi gravado.', true); }
  const nome = (f) => f.split(/[\\/]/).pop();
  box.replaceChildren(
    el('b', { text: 'Gravação salva' + (st.placar.cantadas >= 20 ? ` · afinação ${placarPct()}%` : '') }),
    el('div', { class: 'arqs', text: ev.arquivos.map(nome).join('\n') }),
    el('div', { class: 'linha' },
      el('button', { class: 'tecla p', text: 'Mostrar na pasta', onclick: () => api.mostrarNaPasta(ev.arquivos[0]) }),
      el('button', { class: 'tecla p', text: 'Arrastar para o FL', title: 'Segure e arraste para o FL Studio', onmousedown: (e) => { e.preventDefault(); api.arrastar([...ev.arquivos, st.inst].filter(Boolean)); } }),
      el('button', { class: 'tecla p', text: 'Fechar', onclick: () => { box.hidden = true; } })));
  box.querySelector('.arqs').style.whiteSpace = 'pre-line';
  box.hidden = false;
  status('Gravação salva na pasta da música, junto do instrumental.');
}

// ---------- efeitos (VST3) ----------
function mostrarEfeitos(lista) {
  st.efeitos = lista;
  const box = $('k-efeitos');
  box.replaceChildren();
  $('k-ef-nota').textContent = '';
  if (!lista.length) {
    box.append(el('div', { class: 'fraco', text: 'Nenhum plugin. Escolha o Auto-Tune na lista abaixo.' }));
    return;
  }
  let iMotor = 0;   // o motor só conta os plugins que abriram
  lista.forEach((ef, pos) => {
    const meu = ef.ok ? iMotor++ : -1;
    const cab = el('div', { class: 'k-ef-cab' });
    if (ef.ok) {
      const sw = el('button', { class: 'chave', role: 'switch', 'aria-checked': String(ef.ligado), title: 'Ligar ou desligar este efeito' }, el('i'));
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        motor({ cmd: 'ligado', i: meu, ligado: on });
        const efs = (st.cfg.efeitos || []).map((x, k) => (k === pos ? { ...x, ligado: on } : x));
        salvarCfg({ efeitos: efs });
      });
      cab.append(sw);
    }
    cab.append(el('span', { class: 'nome', text: ef.nome || ef.arquivo.split(/[\\/]/).pop().replace(/\.vst3$/i, ''), title: ef.arquivo }));
    if (ef.ok && ef.latencia_ms) cab.append(el('span', { class: 'fraco mono', text: ef.latencia_ms + ' ms', title: 'Atraso que este plugin acrescenta' }));
    if (ef.ok) cab.append(el('button', { class: 'tecla mini', text: 'Abrir', title: 'Abre a tela do próprio plugin', onclick: () => motor({ cmd: 'editor', i: meu }) }));
    if (pos > 0) cab.append(el('button', { class: 'tecla mini', text: '↑', title: 'Passar para antes', onclick: () => moverEfeito(pos, -1) }));
    cab.append(el('button', { class: 'x', text: '×', title: 'Tirar da corrente', 'aria-label': 'Tirar', onclick: () => tirarEfeito(pos) }));
    const caixa = el('div', { class: 'k-ef' + (ef.ok ? '' : ' falhou') }, cab);
    if (!ef.ok) caixa.append(el('div', { class: 'erro', text: 'Não abriu: ' + ef.erro }));
    if (ef.ok && ef.rapidos && ef.rapidos.length) caixa.append(rapidos(meu, ef.rapidos));
    box.append(caixa);
  });
}

function rapidos(i, lista) {
  const grade = el('div', { class: 'k-ef-rap' });
  const mandar = (nome, valor) => motor({ cmd: 'param', i, nome, valor });
  for (const r of lista) {
    grade.append(el('span', { text: r.rotulo }));
    if (r.tipo === 'escolha') {
      const sel = el('select', { class: 'campo' }, ...r.valores.map((v) => el('option', { value: v, text: v })));
      sel.value = r.valor;
      sel.addEventListener('change', () => mandar(r.nome, sel.value));
      grade.append(sel);
    } else if (r.tipo === 'chave') {
      const sw = el('button', { class: 'chave', role: 'switch', 'aria-checked': String(r.valor) }, el('i'));
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        mandar(r.nome, on);
      });
      grade.append(sw);
    } else if (r.nome === 'retune_speed_ms') {
      // velocidade de correção é ao contrário do que se espera (0 ms = mais forte): vira "força", 0 a 100,
      // com a direita mais forte. Força 100 = 0 ms (robô); força 0 = 100 ms (quase natural).
      const ms = (f) => Math.round(100 - f);
      const forca = Math.max(0, Math.min(100, 100 - Number(r.valor)));
      const dizer = (f) => `${Math.round(f)}%${f >= 95 ? ' robô' : f <= 40 ? ' leve' : ''}`;
      const n = el('span', { text: dizer(forca), title: ms(forca) + ' ms' });
      const fader = el('input', { type: 'range', min: '0', max: '100', step: '1', value: String(forca), title: 'Esquerda: mais natural. Direita: mais Auto-Tune.' });
      let espera = 0;
      fader.addEventListener('input', () => {
        const f = Number(fader.value);
        n.textContent = dizer(f);
        n.title = ms(f) + ' ms';
        clearTimeout(espera);
        espera = setTimeout(() => mandar(r.nome, ms(f)), 80);
      });
      grade.append(el('div', { class: 'valor' }, fader, n));
    } else {
      const passo = r.max - r.min > 20 ? 1 : 0.1;
      const n = el('span', { text: String(Math.round(r.valor / passo) * passo).slice(0, 5) });
      const fader = el('input', { type: 'range', min: String(r.min), max: String(r.max), step: String(passo), value: String(r.valor) });
      let espera = 0;
      fader.addEventListener('input', () => {
        n.textContent = String(Number(fader.value)).slice(0, 5);
        clearTimeout(espera);
        espera = setTimeout(() => mandar(r.nome, Number(fader.value)), 80);
      });
      grade.append(el('div', { class: 'valor' }, fader, n));
    }
  }
  return grade;
}

async function moverEfeito(pos, d) {
  const efs = [...(st.cfg.efeitos || [])];
  const [x] = efs.splice(pos, 1);
  efs.splice(Math.max(0, pos + d), 0, x);
  await salvarCfg({ efeitos: efs });
  mandarEfeitos();
}
async function tirarEfeito(pos) {
  const efs = (st.cfg.efeitos || []).filter((_, k) => k !== pos);
  await salvarCfg({ efeitos: efs });
  mandarEfeitos();
}
async function carregarVsts(lista) {
  lista = lista || await api.karaokeVsts();
  st.vsts = lista;
  $('k-vst').replaceChildren(el('option', { value: '', text: lista.length ? 'Acrescentar plugin VST3…' : 'Nenhum VST3 achado' }),
    ...lista.map((x) => el('option', { value: x.arquivo, text: x.nome })));
  return lista;
}
$('k-vst').addEventListener('change', async () => {
  const arquivo = $('k-vst').value;
  $('k-vst').value = '';
  if (!arquivo) return;
  await salvarCfg({ efeitos: [...(st.cfg.efeitos || []), { arquivo, ligado: true }] });
  mandarEfeitos();
});
$('k-vst-pasta').addEventListener('click', async () => carregarVsts(await api.karaokePastaVst()));

// ---------- abertura ----------
async function abrir() {
  const c = await api.configLer();
  st.cfg = c.karaoke || {};
  const vol = st.cfg.volumes || {};
  if (vol.inst != null) $('k-v-inst').value = vol.inst;
  if (vol.voz != null) $('k-v-voz').value = vol.voz;
  if (vol.guia != null) $('k-v-guia').value = vol.guia;
  if (st.cfg.ouvir === false) $('k-ouvir').setAttribute('aria-checked', 'false');
  if (st.cfg.semCoro) $('k-semcoro').setAttribute('aria-checked', 'true');
  if (st.cfg.exclusivo === false) $('k-exclusivo').setAttribute('aria-checked', 'false');
  const info = await api.info();
  document.title = info.nome + ' — Karaokê';
  $('marca').replaceChildren(document.createTextNode(info.nome + ' '), el('b', { text: 'karaokê' }));

  const vsts = await carregarVsts();
  // primeira vez: já monta a corrente com o Auto-Tune e o reverb da Valhalla, se estiverem instalados
  if (!st.cfg.efeitos) {
    const achar = (re) => vsts.find((x) => re.test(x.nome));
    const padrao = [achar(/^auto-tune pro/i) || achar(/auto-?tune/i), achar(/valhallavintageverb/i) || achar(/valhalla/i)].filter(Boolean);
    await salvarCfg({ efeitos: padrao.map((x) => ({ arquivo: x.arquivo, ligado: true })) });
  }
  carregarRecentes();
  status('Procurando microfone e fone…');
  const a = await api.karaokeAparelhos();
  if (a.ok) { st.aparelhos = a; preencherAparelhos(); status(''); } else status(a.error, true);
  await iniciarMotor();
  const dir = new URLSearchParams(location.search).get('dir');
  if (dir) carregar(dir);
}
api.onKaraokeAbrir((dir) => carregar(dir));
abrir();
