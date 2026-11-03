/* Haze: lógica da mesa. Interface em português. */
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

// Tempos medidos na RTX 5060, em segundos por segundo de música (D). A síntese tem um termo em D².
//   CUDA:   30 s de música -> síntese 4,7 s;  281 s -> 152 s.   Vulkan: 30 s -> 6,5 s;  303 s -> 26 min.
const TEMPOS = {
  cuda: { composicao: 0.18, sintese: 0.12, sintese2: 0.0015, final: 0.03, separar: 0.55, voz: 1.1, fixo: 30 },
  vulkan: { composicao: 0.6, sintese: 0, sintese2: 0.017, final: 0.25, separar: 0.55, voz: 1.1, fixo: 30 },
};
let TEMPO = TEMPOS.vulkan;
const LONGO = 600; // acima de 10 min de espera, o programa avisa antes de gravar

const state = {
  nome: 'Haze',
  limite: 360,
  arquivo: null,
  voz: '',
  tom: 0,
  analise: null,        // { key, meta } da última análise (baixar + melodia + letra)
  letraDe: null,        // de qual origem é a letra que está no campo (null = digitada sem origem)
  abcEditado: null,     // { key, abc } partitura editada pelo usuário
  longoOk: null,        // key de uma gravação longa já confirmada
  rodando: false,
  modo: 'mesa',         // quem recebe o progresso: 'mesa' | 'sep'
  modoMesa: 'cover',    // 'cover' = regravar com o motor | 'voz' = só trocar a voz no Applio
  tomPorModo: { cover: 0, voz: 0, criar: 0, continuar: 0 },
  plano: null,          // { key, meta } partitura planejada no modo Criar
  carregada: null,      // gravação mostrada na Saída
  variacao: 0,
  lora: { dir: null, files: [] },
  midis: {},            // "pasta|variação" -> arquivo .mid já feito
};

// ---------- utilidades ----------
function fileUrl(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}
function parseTime(txt) {
  const t = (txt || '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(Number);
  if (parts.length > 3 || parts.some((n) => !isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function fmt(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const fmt2 = (sec) => (sec == null || !isFinite(sec) ? '--:--' : fmt(sec).padStart(5, '0'));
const sw = (id) => $(id).getAttribute('aria-checked') === 'true';
const nomeArquivo = (p) => p.split(/[\\/]/).pop();

function setStatus(texto, falha) {
  const s = $('status');
  s.textContent = texto || '';
  s.title = texto || '';
  s.classList.toggle('falha', !!falha);
  if (falha && texto) api.erroTela(texto);
}
function setRec(titulo, sub, classe) {
  $('rec-titulo').textContent = titulo;
  $('rec-sub').textContent = sub || '';
  const r = document.querySelector('.rec');
  r.classList.toggle('aviso', classe === 'aviso');
  r.classList.toggle('falha', classe === 'falha');
}

// ---------- abas ----------
document.querySelectorAll('.aba').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tela').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'hist') carregarHistorico();
    if (b.dataset.tab === 'fala') prepararFala();
    if (b.dataset.tab === 'diag') rodarDiagnostico();
    if (b.dataset.tab === 'instalar') carregarInstalar();
  }));
const irPara = (tab) => document.querySelector(`.aba[data-tab="${tab}"]`).click();

// ---------- modo da mesa ----------
//   cover     regravar uma música com outra voz e estilo
//   voz       só trocar a voz no Applio (sem o motor)
//   criar     música nova, do zero (estilo + letra, ou instrumental)
//   continuar um trecho de música real abre a gravação e o motor compõe o resto
const MODOS = {
  cover: { rec: 'Gravar', dica: 'Regravar: o motor grava a música de novo com outra voz e outro estilo.' },
  voz: { rec: 'Trocar a voz', dica: 'Trocar voz: separa o instrumental e passa o vocal original no seu modelo do Applio.' },
  criar: { rec: 'Gravar', dica: 'Criar: música nova a partir do estilo e da letra. Sem música de origem.' },
  continuar: { rec: 'Gravar', dica: 'Continuar: o trecho escolhido abre a gravação e o motor compõe o resto.' },
};
const tituloRec = () => MODOS[state.modoMesa].rec;
const ehModo = (...m) => m.includes(state.modoMesa);

function aplicarModo() {
  const m = state.modoMesa;
  document.querySelectorAll('#modos .modo').forEach((x) => {
    x.classList.toggle('on', x.dataset.modo === m);
    x.setAttribute('aria-selected', String(x.dataset.modo === m));
  });
  // Entrada
  $('bloco-criar').hidden = m !== 'criar';
  $('bloco-origem').hidden = m === 'criar';
  $('bloco-duracao').hidden = !ehModo('criar', 'continuar');
  $('trecho-rotulo').textContent = m === 'continuar' ? 'Trecho que abre a gravação' : 'Trecho';
  $('in-fim').placeholder = m === 'continuar' ? '20 s depois' : 'até o final';
  $('sw-instrumental').hidden = m !== 'criar';
  $('sw-previa').hidden = ehModo('criar', 'continuar');
  $('sw-revisar').hidden = m !== 'cover';
  $('sw-partitura').hidden = !ehModo('cover', 'criar');
  ['sw-separar', 'sw-voz', 'sw-repetir'].forEach((id) => { $(id).hidden = m === 'voz'; });
  $('mais-opcoes').hidden = ![...$('mais-opcoes').querySelectorAll('.chave')].some((x) => !x.hidden);
  // Módulo do meio: no modo voz nada do motor vale e entra o painel da voz (modelo e chaves principais);
  // nos outros modos esse mesmo bloco mora no diálogo "Voz (Applio)".
  $('proc-esq').hidden = m === 'voz';
  $('painel-voz').hidden = m !== 'voz';
  $('versao-rotulo').textContent = m === 'voz' ? 'Voz' : 'Versão';
  $(m === 'voz' ? 'voz-slot' : 'voz-slot-dlg').append($('vz-essenciais'));
  // o fader só existe em cover (tom da melodia) e voz (tom da voz)
  $('fader').classList.toggle('fora-de-uso', ehModo('criar', 'continuar'));
  $('tom-rotulo').textContent = m === 'voz' ? 'Tom da voz' : 'Tom';
  $('tom-rotulo').title = m === 'voz' ? 'Em 0, com "Escolher o tom sozinho" ligado em Ajustes, o app escolhe o tom.' : '';
  aplicarInstrumental();
  setTom(state.tomPorModo[m]);
  atualizarSaida();
  atualizarMesa();
}
function aplicarInstrumental() {
  const inst = state.modoMesa === 'criar' && sw('sw-instrumental');
  $('in-letra').disabled = inst;
  $('vozes').classList.toggle('fora-de-uso', inst);
  $('sw-voz').classList.toggle('fora-de-uso', inst);
  if (state.modoMesa === 'criar') {
    $('letra-nota').textContent = inst ? 'instrumental não usa letra' : 'escreva a letra';
  } else if (state.modoMesa === 'continuar') {
    $('letra-nota').textContent = 'a do trecho e depois a nova';
  } else if (!$('in-letra').value.trim()) {
    $('letra-nota').textContent = 'vazia = reconhecer sozinho';
  }
}
document.querySelectorAll('#modos .modo').forEach((b) =>
  b.addEventListener('click', () => {
    if (state.rodando || b.dataset.modo === state.modoMesa) return;
    state.tomPorModo[state.modoMesa] = state.tom;
    state.modoMesa = b.dataset.modo;
    api.configSalvar({ modo: state.modoMesa });
    aplicarModo();
    setStatus(MODOS[state.modoMesa].dica);
  }));

// ---------- chaves ----------
document.querySelectorAll('.chave').forEach((c) =>
  c.addEventListener('click', () => {
    c.setAttribute('aria-checked', String(c.getAttribute('aria-checked') !== 'true'));
    // trocar a voz precisa do vocal separado: uma chave puxa a outra
    if (c.id === 'sw-voz' && sw('sw-voz')) $('sw-separar').setAttribute('aria-checked', 'true');
    if (c.id === 'sw-separar' && !sw('sw-separar')) $('sw-voz').setAttribute('aria-checked', 'false');
    if (c.id === 'sw-partitura') atualizarSaida();
    if (c.id === 'sw-instrumental') aplicarInstrumental();
    atualizarMesa();
  }));

// ---------- origem ----------
const origemId = () => (state.arquivo ? 'f:' + state.arquivo : 'u:' + $('in-url').value.trim());
const temOrigem = () => !!state.arquivo || !!$('in-url').value.trim();

function setArquivo(p) {
  state.arquivo = p;
  $('arquivo').hidden = !p;
  $('arquivo-nome').textContent = p ? nomeArquivo(p) : '';
  $('in-url').disabled = !!p;
  if (p) $('in-url').value = '';
  atualizarMesa();
}
$('btn-arquivo').addEventListener('click', async () => {
  const p = await api.escolherAudio();
  if (p) setArquivo(p);
});
$('btn-arquivo-tirar').addEventListener('click', () => setArquivo(null));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  const p = f && api.caminhoDoArquivo(f);
  if (p) { irPara('mesa'); setArquivo(p); }
});
['in-url', 'in-ini', 'in-fim', 'in-estilo', 'in-titulo', 'in-duracao'].forEach((id) => $(id).addEventListener('input', atualizarMesa));
// Ctrl+V com um link, em qualquer lugar da janela, cai no campo de origem; Enter no campo começa.
document.addEventListener('paste', (e) => {
  const alvo = e.target;
  if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.isContentEditable)) return;
  if (document.querySelector('dialog[open]') || state.rodando || state.modoMesa === 'criar') return;
  const texto = ((e.clipboardData && e.clipboardData.getData('text')) || '').trim();
  if (!/^https?:[/][/][^ ]+$/i.test(texto)) return;
  e.preventDefault();
  irPara('mesa');
  if (state.arquivo) $('btn-arquivo-tirar').click();
  $('in-url').value = texto;
  $('in-url').dispatchEvent(new Event('input', { bubbles: true }));
  $('in-url').focus();
  setStatus('Link colado. Enter começa.');
});
$('in-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.rodando && $('in-url').value.trim()) { e.preventDefault(); $('btn-rec').click(); }
});
$('in-partitura-modo').addEventListener('change', atualizarMesa);
// letra digitada pertence à origem que está na mesa naquele momento
$('in-letra').addEventListener('input', () => {
  state.letraDe = temOrigem() ? origemId() : null;
  if (state.modoMesa === 'cover') $('letra-nota').textContent = $('in-letra').value.trim() ? 'sua letra' : 'vazia = reconhecer sozinho';
  atualizarMesa();
});

// ---------- voz ----------
document.querySelectorAll('.voz').forEach((b) =>
  b.addEventListener('click', () => {
    state.voz = b.dataset.voz;
    document.querySelectorAll('.voz').forEach((x) => x.classList.toggle('on', x === b));
    atualizarMesa();
  }));

// ---------- "sem": o que não entra na gravação ----------
// O motor não tem prompt negativo; o que existe é escrever "no X" nas tags de estilo. Este campo só organiza isso.
document.querySelectorAll('#sem .tecla').forEach((b) =>
  b.addEventListener('click', () => {
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    atualizarMesa();
  }));
$('in-sem').addEventListener('input', atualizarMesa);
function semLista() {
  const prontos = [...document.querySelectorAll('#sem .tecla[aria-pressed="true"]')].map((b) => b.dataset.sem);
  const livres = $('in-sem').value.split(',')
    .map((s) => s.trim().replace(/^(no|sem|without)\s+/i, ''))
    .filter(Boolean)
    .map((s) => 'no ' + s);
  return [...prontos, ...livres];
}
function semLimpar() {
  document.querySelectorAll('#sem .tecla').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  $('in-sem').value = '';
}

// ---------- fader de tom ----------
// de −12 o fader pula direto para −24 (uma oitava a mais para voz grave), sem os valores do meio
const TONS = [-24, ...Array.from({ length: 25 }, (_, i) => i - 12)];
const TRAVAS = [-24, -12, -7, -5, 0, 5, 7, 12];
const idxTom = (v) => Math.max(0, TONS.indexOf(v));
const posTom = (v) => 4 + ((TONS.length - 1 - idxTom(v)) / (TONS.length - 1)) * 92;
function montarFader() {
  const c = $('curso');
  c.replaceChildren(el('div', { class: 'fenda' }));
  for (const v of TONS) {
    const forte = TRAVAS.includes(v);
    c.append(el('div', { class: 'risco' + (forte ? ' forte' : ''), style: `top:${posTom(v)}%` }));
    if (forte) {
      c.append(el('button', {
        class: 'num', 'data-v': v, style: `top:${posTom(v)}%`, tabindex: '-1',
        text: v > 0 ? '+' + v : v === 0 ? '0' : '−' + Math.abs(v),
        onclick: (e) => { e.stopPropagation(); setTom(v); },
      }));
    }
  }
  const knob = el('button', {
    class: 'knob', id: 'knob', role: 'slider', 'aria-label': 'Tom da melodia em semitons',
    'aria-valuemin': '-24', 'aria-valuemax': '12',
  });
  knob.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (d) { e.preventDefault(); setTom(TONS[Math.max(0, Math.min(TONS.length - 1, idxTom(state.tom) + d))]); }
    if (e.key === 'Home') setTom(0);
  });
  c.append(knob);

  const deY = (y) => {
    const r = c.getBoundingClientRect();
    const pct = ((y - r.top) / r.height) * 100;
    const n = TONS.length - 1;
    return TONS[Math.max(0, Math.min(n, Math.round(n - ((pct - 4) / 92) * n)))];
  };
  let arrastando = false;
  c.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('num')) return;
    arrastando = true;
    c.setPointerCapture(e.pointerId);
    setTom(deY(e.clientY));
  });
  c.addEventListener('pointermove', (e) => { if (arrastando) setTom(deY(e.clientY)); });
  c.addEventListener('pointerup', () => { arrastando = false; });
  c.addEventListener('dblclick', () => setTom(0));
  setTom(0);
}
function setTom(v) {
  v = Math.round(v);
  v = v < -12 ? -24 : Math.min(12, v);
  state.tom = v;
  $('tom-num').textContent = v > 0 ? '+' + v : v === 0 ? '0' : '−' + Math.abs(v);
  const k = $('knob');
  if (k) { k.style.top = posTom(v) + '%'; k.setAttribute('aria-valuenow', v); }
  document.querySelectorAll('#curso .num').forEach((n) => n.classList.toggle('on', Number(n.dataset.v) === v));
  atualizarMesa();
}

// ---------- presets de estilo ----------
async function carregarPresets(lista) {
  const list = lista || await api.presetsListar();
  const box = $('presets');
  box.replaceChildren();
  for (const p of list) {
    box.append(el('span', { class: 'preset' },
      el('button', { class: 'tecla', text: p.nome, title: p.estilo, onclick: () => { $('in-estilo').value = p.estilo; atualizarMesa(); } }),
      el('button', {
        class: 'tecla tira', text: '×', 'aria-label': 'Apagar preset ' + p.nome,
        onclick: async () => carregarPresets(await api.presetsApagar(p.nome)),
      })));
  }
  box.append(el('button', {
    class: 'tecla', text: '+ Guardar estilo',
    onclick: async () => {
      const estilo = $('in-estilo').value.trim();
      if (!estilo) return setStatus('Escreva um estilo antes de guardar.', true);
      const nome = estilo.split(',')[0].trim().slice(0, 22) || 'Estilo';
      carregarPresets(await api.presetsSalvar({ nome, estilo }));
      setStatus(`Estilo guardado como "${nome}".`);
    },
  }));
}

// ---------- ajustes ----------
document.querySelectorAll('dialog').forEach((d) => {
  d.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => d.close()));
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', atualizarMesa);
});
$('btn-ajustes').addEventListener('click', () => $('dlg-ajustes').showModal());
const soDigitos = (id) => { const v = $(id).value.trim(); return /^\d{1,19}$/.test(v) ? v : null; };
$('aj-usar-sementes').addEventListener('click', () => {
  const r = state.carregada && state.carregada.replay;
  if (!r || !r.seed) return setStatus('A gravação carregada não tem sementes guardadas.', true);
  $('aj-semente').value = r.seed;
  $('aj-semente-lm').value = r.lm_seed || '';
});
$('aj-limpar-sementes').addEventListener('click', () => { $('aj-semente').value = ''; $('aj-semente-lm').value = ''; });
$('aj-lora').addEventListener('click', async () => {
  const r = await api.escolherPastaLora();
  if (!r) return;
  state.lora = r;
  $('aj-lora-info').textContent = r.files.length ? r.dir : 'nenhum .safetensors nessa pasta';
  const box = $('aj-lora-lista');
  box.replaceChildren();
  for (const f of r.files) {
    box.append(el('label', { class: 'lora-item' },
      el('input', { type: 'checkbox', 'data-nome': f }),
      el('span', { text: f }),
      el('input', { class: 'campo', type: 'number', step: '0.1', min: '0', max: '2', value: '1', 'data-forca': f, 'aria-label': 'Força' })));
  }
});
function loraEscolhido() {
  if (!state.lora.dir) return null;
  const list = [];
  document.querySelectorAll('#aj-lora-lista input[type=checkbox]:checked').forEach((c) => {
    const name = c.dataset.nome;
    const scale = parseFloat(document.querySelector(`#aj-lora-lista input[data-forca="${CSS.escape(name)}"]`).value);
    list.push({ name, scale: isFinite(scale) ? scale : 1 });
  });
  return list.length ? { dir: state.lora.dir, list } : null;
}

// ---------- leitura da mesa ----------
function lerMesa() {
  const ini = parseTime($('in-ini').value);
  let fim = parseTime($('in-fim').value);
  if (Number.isNaN(ini) || Number.isNaN(fim)) throw new Error('Tempo inválido no trecho. Use 1:47 ou 107.');
  if (fim != null && fim <= (ini || 0)) throw new Error('O fim do trecho precisa vir depois do início.');
  const previa = sw('sw-previa');
  const estilo = [state.voz, $('in-estilo').value.trim(), ...semLista()].filter(Boolean).join(', ');
  const duracao = parseTime($('in-duracao').value);
  if (ehModo('criar', 'continuar') && (duracao == null || Number.isNaN(duracao) || duracao < 10)) {
    throw new Error('Duração inválida. Use 2:00 ou 120 (mínimo 10 segundos).');
  }
  const instrumental = state.modoMesa === 'criar' && sw('sw-instrumental');
  return {
    modo: state.modoMesa,
    titulo: $('in-titulo').value.trim(),
    duracao: duracao == null ? null : Math.min(duracao, state.limite),
    cot: $('in-partitura-modo').value,
    instrumental,
    url: state.arquivo ? null : $('in-url').value.trim(),
    file: state.arquivo,
    ini: ini || 0, fim, previa,
    tom: state.tom,
    idioma: $('aj-idioma').value,
    estilo,
    passos: parseInt($('aj-passos').value, 10) || 32,
    separar: sw('sw-separar'),
    // a voz do Applio precisa do vocal separado
    voz: sw('sw-voz') && sw('sw-separar') && !instrumental ? vozEscolhida() : null,
  };
}

// ---------- Applio (troca de voz) ----------
// Mesmos controles da tela de inferência do Applio. Padrões iguais aos dele, menos índice 0,55 e proteção 0,20
// (com 0,75/0,33 o R curto do português sumia no modelo EduCanto; no Applio, proteção menor protege mais).
const VOZ_LISTAS = {
  f0: ['rmvpe', 'fcpe', 'crepe', 'crepe-tiny', 'hybrid[crepe+rmvpe]', 'hybrid[crepe+fcpe]', 'hybrid[rmvpe+fcpe]', 'hybrid[crepe+rmvpe+fcpe]'],
  embedder: ['contentvec', 'spin', 'spin-v2', 'chinese-hubert-base', 'japanese-hubert-base', 'korean-hubert-base'],
  tomExtra: ['-12', '+12', '-24', '+24'],   // tom da faixa extra (chave "Faixa extra noutro tom")
};
const sinal = (v) => (v > 0 ? '+' + v : String(v).replace('-', '−'));
const VOZ_REGUAS = [
  { id: 'pitch', rot: 'Tom da voz (semitons)', min: -24, max: 24, step: 1, def: 0, fmt: sinal, depOff: 'tomSozinho' },
  { id: 'indexRate', rot: 'Proporção do índice', min: 0, max: 1, step: 0.01, def: 0.55 },
  { id: 'volumeEnvelope', rot: 'Envelope de volume', min: 0, max: 1, step: 0.01, def: 1 },
  { id: 'protect', rot: 'Proteção de consoantes e respiração', min: 0, max: 0.5, step: 0.01, def: 0.2 },
  { id: 'autotuneStrength', rot: 'Força do autotune', min: 0, max: 1, step: 0.1, def: 1, dep: 'autotune' },
  { id: 'proposedPitchThreshold', rot: 'Limiar do tom proposto', min: 50, max: 1199, step: 1, def: 155, dep: 'proposedPitch' },
  { id: 'cleanStrength', rot: 'Força da limpeza', min: 0, max: 1, step: 0.1, def: 0.5, dep: 'cleanAudio' },
  { id: 'formantQfrency', rot: 'Formante: quefrência', min: 0, max: 16, step: 0.1, def: 1, dep: 'formant' },
  { id: 'formantTimbre', rot: 'Formante: timbre', min: 0, max: 16, step: 0.1, def: 1, dep: 'formant' },
];
const VOZ_CHAVES = [
  // as quatro primeiras são passadas nossas, em volta do Applio; tom sozinho e instrumental acompanhando
  // abrem desligados (o tom automático errou em música que não era para mexer)
  { id: 'doisTons', rot: 'Dois tons por frase (emenda sozinho)', def: true, onde: 'tom' },
  { id: 'tomSozinho', rot: 'Escolher o tom sozinho', onde: 'tom' },
  { id: 'instrumentalAcompanha', rot: 'Instrumental acompanha o tom', onde: 'tom' },
  // mais uma faixa inteira, noutro tom, na mesma rodada (ex.: tom 0 e −12, cada uma num arquivo)
  { id: 'tomExtraLigado', rot: 'Faixa extra noutro tom', onde: 'tom' },
  { id: 'tirarCoro', rot: 'Tirar coro e segunda voz', def: true, onde: 'limpeza' },
  { id: 'tirarEco', rot: 'Tirar o eco', def: true, onde: 'limpeza' },
  { id: 'coroNaVoz', rot: 'Coro também na sua voz', def: true, onde: 'acabamento' },
  { id: 'limparPausas', rot: 'Silêncio limpo entre as frases', def: true, onde: 'acabamento' },
  { id: 'igualarVolume', rot: 'Volume igual ao do vocal original', def: true, onde: 'acabamento' },
  { id: 'splitAudio', rot: 'Dividir o áudio em partes', def: true },
  { id: 'autotune', rot: 'Autotune' },
  { id: 'proposedPitch', rot: 'Tom proposto' },
  { id: 'cleanAudio', rot: 'Limpar o áudio' },
  { id: 'formant', rot: 'Mudar o formante' },
];
const VOZ_PADRAO = Object.fromEntries([
  ...VOZ_REGUAS.map((r) => [r.id, r.def]),
  ...VOZ_CHAVES.map((c) => [c.id, !!c.def]),
  ['f0', 'rmvpe'], ['embedder', 'contentvec'], ['tomExtra', '-12'],
]);

function casas(step) { return step >= 1 ? 0 : step >= 0.1 ? 1 : 2; }

function montarPainelVoz() {
  for (const [id, ops] of Object.entries(VOZ_LISTAS)) {
    $('vz-' + id).replaceChildren(...ops.map((o) => el('option', { value: o, text: id === 'tomExtra' ? o.replace('-', '−') : o })));
    $('vz-' + id).addEventListener('change', salvarVoz);
  }
  $('vz-modelo').addEventListener('change', () => { atualizarAltura(); atualizarSegundo(); salvarVoz(); });
  $('vz-modelo2').addEventListener('change', () => {
    state.config.voz2Pth = $('vz-modelo2').value;
    api.configSalvar({ voz2Pth: state.config.voz2Pth });
    atualizarSegundo();
    atualizarMesa();
  });
  $('vz-altura2').addEventListener('change', () => {
    const m2 = modelo2Atual();
    if (!m2) return;
    state.config.alturaModelos = { ...(state.config.alturaModelos || {}), [m2.pth]: Number($('vz-altura2').value) || 0 };
    api.configSalvar({ alturaModelos: state.config.alturaModelos });
  });
  $('vz-altura').addEventListener('change', () => {
    const m = modeloAtual();
    if (!m) return;
    state.config.alturaModelos = { ...(state.config.alturaModelos || {}), [m.pth]: Number($('vz-altura').value) || 0 };
    api.configSalvar({ alturaModelos: state.config.alturaModelos });
  });

  const reguas = $('vz-reguas');
  for (const r of VOZ_REGUAS) {
    const input = el('input', { type: 'range', id: 'vz-' + r.id, min: r.min, max: r.max, step: r.step, 'aria-label': r.rot });
    const out = el('output', { id: 'vz-' + r.id + '-v' });
    input.addEventListener('input', () => { out.textContent = lerRegua(r); });
    input.addEventListener('change', salvarVoz);
    reguas.append(el('div', { class: 'regua', id: 'vz-' + r.id + '-linha' }, el('span', { class: 'etq', text: r.rot }), input, out));
  }
  const chaves = $('vz-chaves');
  for (const c of VOZ_CHAVES) {
    const b = el('button', { class: 'chave', id: 'vz-' + c.id, role: 'switch', 'aria-checked': 'false' }, el('i'), document.createTextNode(c.rot));
    b.addEventListener('click', () => {
      b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true'));
      dependenciasVoz();
      salvarVoz();
    });
    (c.onde ? $('vz-chaves-' + c.onde) : chaves).append(b);
  }
  $('btn-voz-avancado').addEventListener('click', () => $('dlg-voz').showModal());
  $('btn-voz-ao-vivo').addEventListener('click', abrirAoVivo);
  $('btn-modelos').addEventListener('click', () => { $('md-aviso').textContent = ''; pintarBiblioteca(); $('dlg-modelos').showModal(); });
  $('vz-padrao').addEventListener('click', () => { preencherVoz(VOZ_PADRAO); salvarVoz(); });
  $('vz-pasta').addEventListener('click', async () => {
    const dir = await api.escolherPastaApplio();
    if (!dir) return;
    await api.configSalvar({ applioDir: dir });
    carregarConfig();
  });
  $('btn-voz').addEventListener('click', () => { $('dlg-ajustes').close(); $('dlg-voz').showModal(); });
  $('sw-voz').addEventListener('click', () => setTimeout(salvarVoz, 0));
}

function lerRegua(r) {
  const v = Number($('vz-' + r.id).value);
  return r.fmt ? r.fmt(v) : v.toFixed(casas(r.step)).replace('.', ',');
}
// régua que depende de uma chave fica apagada enquanto a chave está desligada
function dependenciasVoz() {
  for (const r of VOZ_REGUAS) {
    if (!r.dep && !r.depOff) continue;
    const ligada = $('vz-' + (r.dep || r.depOff)).getAttribute('aria-checked') === 'true';
    const on = r.dep ? ligada : !ligada;
    $('vz-' + r.id + '-linha').classList.toggle('desligada', !on);
    $('vz-' + r.id).disabled = !on;
  }
  const extra = $('vz-tomExtraLigado').getAttribute('aria-checked') === 'true';
  $('vz-tomExtra-linha').classList.toggle('desligada', !extra);
  $('vz-tomExtra').disabled = !extra;
}
function preencherVoz(v) {
  const val = { ...VOZ_PADRAO, ...(v || {}) };
  for (const r of VOZ_REGUAS) {
    $('vz-' + r.id).value = val[r.id];
    $('vz-' + r.id + '-v').textContent = lerRegua(r);
  }
  for (const c of VOZ_CHAVES) $('vz-' + c.id).setAttribute('aria-checked', String(!!val[c.id]));
  for (const id of Object.keys(VOZ_LISTAS)) $('vz-' + id).value = VOZ_LISTAS[id].includes(val[id]) ? val[id] : VOZ_PADRAO[id];
  dependenciasVoz();
}
function ajustesVoz() {
  const v = {};
  for (const r of VOZ_REGUAS) v[r.id] = Number(Number($('vz-' + r.id).value).toFixed(casas(r.step)));
  for (const c of VOZ_CHAVES) v[c.id] = $('vz-' + c.id).getAttribute('aria-checked') === 'true';
  for (const id of Object.keys(VOZ_LISTAS)) v[id] = $('vz-' + id).value;
  return v;
}

// Tudo que o núcleo precisa para chamar o Applio, ou null se não há modelo.
// ---------- voz pelo celular ----------
function pintarCelular(r) {
  const ligada = !!(r && r.url);
  if (r && 'auto' in r) $('cel-auto').setAttribute('aria-checked', String(!!r.auto));
  $('cel-corpo').hidden = !ligada;
  if (ligada) { $('cel-qr').src = r.qr; $('cel-url').textContent = r.url; }
  $('cel-ligar').textContent = ligada ? 'Desligar' : 'Ligar';
  $('btn-celular').classList.toggle('no-ar', ligada);
  $('btn-celular').textContent = ligada ? '● Celular' : 'Celular';
}
$('btn-karaoke').addEventListener('click', () => api.karaokeJanela());
$('btn-celular').addEventListener('click', async () => {
  pintarCelular(await api.celularEstado());
  $('dlg-celular').showModal();
});
$('cel-auto').addEventListener('click', () => setTimeout(() => api.configSalvar({ celularAuto: sw('cel-auto') }), 0));
// a página pode ter sido ligada sozinha na abertura, ou ter terminado um cover pedido pelo celular
api.onCelular((ev) => {
  if (ev.tipo === 'no-ar') api.celularEstado().then(pintarCelular);
  if (ev.tipo === 'cover-pronto') { carregarRecentes(); setStatus('Cover pedido pelo celular ficou pronto. Está nos recentes e no histórico.'); }
});
$('cel-ligar').addEventListener('click', async () => {
  $('cel-ligar').disabled = true;
  const estado = await api.celularEstado();
  if (estado.ligada) { await api.celularDesligar(); pintarCelular({ auto: estado.auto }); $('cel-aviso').textContent = 'Página desligada.'; }
  else {
    const r = await api.celularLigar();
    if (r.ok) { pintarCelular(r); $('cel-aviso').textContent = 'No ar. Com a voz ao vivo ligada a conversão não roda: desligue uma para usar a outra.'; }
    else $('cel-aviso').textContent = r.error;
  }
  $('cel-ligar').disabled = false;
});

// ---------- biblioteca de modelos ----------
// Cada modelo tem uma ficha nas preferências: favorito, língua e pasta. Os arquivos do Applio não se mexem.
const LINGUAS = [['', 'língua: —'], ['pt', 'Português'], ['es', 'Espanhol'], ['en', 'Inglês'], ['ja', 'Japonês'], ['outra', 'Outra']];
const nomeDaLingua = (c) => (LINGUAS.find(([v]) => v === c) || ['', ''])[1];
const ficha = (pth) => ((state.config && state.config.biblioteca) || {})[pth] || {};
const md = { filtro: { tipo: 'todos', valor: '' } };

// Opções para uma lista de modelos: favoritos primeiro, depois uma seção por pasta, depois o resto.
function opcoesDeModelos() {
  const todos = (state.config && state.config.modelos) || [];
  const opcao = (m) => el('option', { value: m.pth, text: (ficha(m.pth).fav ? '★ ' : '') + m.nome });
  const grupos = [];
  const favs = todos.filter((m) => ficha(m.pth).fav);
  if (favs.length) grupos.push(['Favoritos', favs]);
  for (const p of (state.config && state.config.pastas) || []) {
    const dela = todos.filter((m) => !ficha(m.pth).fav && ficha(m.pth).pasta === p);
    if (dela.length) grupos.push([p, dela]);
  }
  const resto = todos.filter((m) => !ficha(m.pth).fav && !((state.config.pastas || []).includes(ficha(m.pth).pasta)));
  if (!grupos.length) return resto.map(opcao);
  if (resto.length) grupos.push(['Sem pasta', resto]);
  return grupos.map(([rotulo, lista]) => el('optgroup', { label: rotulo }, ...lista.map(opcao)));
}
// Refaz as três listas (modelo principal, segundo modelo, voz ao vivo) mantendo o que estava escolhido.
function montarListasDeModelos() {
  const c = state.config;
  const tem = (pth) => c.modelos.some((m) => m.pth === pth);
  const antes = { a: $('vz-modelo').value, b: $('vz-modelo2').value, v: $('av-modelo').value };
  $('vz-modelo').replaceChildren(...opcoesDeModelos());
  $('vz-modelo').value = tem(antes.a) ? antes.a : tem(c.vozPth) ? c.vozPth : (c.modelos[0] || {}).pth || '';
  $('vz-modelo2').replaceChildren(el('option', { value: '', text: 'nenhum' }), ...opcoesDeModelos());
  $('vz-modelo2').value = tem(antes.b) ? antes.b : tem(c.voz2Pth) ? c.voz2Pth : '';
  if ($('av-modelo').options.length) {
    $('av-modelo').replaceChildren(...opcoesDeModelos());
    if (tem(antes.v)) $('av-modelo').value = antes.v;
  }
}
async function guardarFicha(pth, dados) {
  state.config.biblioteca = await api.bibliotecaSalvar({ pth, dados });
  montarListasDeModelos();
  pintarBiblioteca();
}
function guardarPastas(pastas) {
  state.config.pastas = pastas;
  api.configSalvar({ pastas });
  montarListasDeModelos();
  pintarBiblioteca();
}
function pintarBiblioteca() {
  const c = state.config;
  const todos = c.modelos || [];
  const pastas = c.pastas || [];
  const f = md.filtro;
  const linguasEmUso = LINGUAS.filter(([v]) => v && todos.some((m) => ficha(m.pth).lingua === v));
  const chip = (texto, tipo, valor, n) => el('button', {
    class: 'tecla p' + (f.tipo === tipo && f.valor === valor ? ' on' : ''), text: texto + ' (' + n + ')',
    onclick: () => { md.filtro = { tipo, valor }; pintarBiblioteca(); },
  });
  $('md-filtros').replaceChildren(
    chip('Todos', 'todos', '', todos.length),
    chip('★ Favoritos', 'fav', '', todos.filter((m) => ficha(m.pth).fav).length),
    ...(linguasEmUso.length ? [el('span', { class: 'sep' })] : []),
    ...linguasEmUso.map(([v, t]) => chip(t, 'lingua', v, todos.filter((m) => ficha(m.pth).lingua === v).length)),
    ...(pastas.length ? [el('span', { class: 'sep' })] : []),
    ...pastas.map((p) => chip(p, 'pasta', p, todos.filter((m) => ficha(m.pth).pasta === p).length)),
  );
  const mostra = (m) => {
    const x = ficha(m.pth);
    return f.tipo === 'todos' || (f.tipo === 'fav' && x.fav) || (f.tipo === 'lingua' && x.lingua === f.valor) || (f.tipo === 'pasta' && x.pasta === f.valor);
  };
  const emUso = $('vz-modelo').value;
  const linhas = todos.filter(mostra).sort((a, b) => (!!ficha(b.pth).fav - !!ficha(a.pth).fav) || a.nome.localeCompare(b.nome, 'pt'));
  $('md-modelos').replaceChildren(...(linhas.length ? linhas.map((m) => {
    const x = ficha(m.pth);
    const lingua = el('select', { class: 'campo', 'aria-label': 'Língua de ' + m.nome }, ...LINGUAS.map(([v, t]) => el('option', { value: v, text: t })));
    lingua.value = x.lingua || '';
    lingua.addEventListener('change', () => guardarFicha(m.pth, { lingua: lingua.value }));
    const pasta = el('select', { class: 'campo', 'aria-label': 'Pasta de ' + m.nome }, el('option', { value: '', text: 'pasta: —' }), ...pastas.map((p) => el('option', { value: p, text: p })));
    pasta.value = pastas.includes(x.pasta) ? x.pasta : '';
    pasta.addEventListener('change', () => guardarFicha(m.pth, { pasta: pasta.value }));
    return el('div', { class: 'md-modelo' + (m.pth === emUso ? ' em-uso' : '') },
      el('button', { class: 'md-estrela' + (x.fav ? ' on' : ''), text: x.fav ? '★' : '☆', title: x.fav ? 'Tirar dos favoritos' : 'Pôr nos favoritos', onclick: () => guardarFicha(m.pth, { fav: !x.fav }) }),
      el('span', { class: 'nome', title: 'Clique para mudar o nome. Pasta no Applio: ' + (m.pastaNome || m.nome), onclick: (e) => renomearModelo(m, e.currentTarget) },
        document.createTextNode(m.nome), el('small', { text: m.pth === emUso ? 'em uso' : '' })),
      lingua, pasta,
      el('button', { class: 'tecla p', text: '▶', title: 'Ouvir uma amostra desta voz (na primeira vez leva uns 20 s)', onclick: (e) => ouvirAmostra(m, e.currentTarget) }),
      el('button', { class: 'tecla p', text: 'Usar', title: 'Escolher este modelo para trocar a voz', onclick: () => {
        $('vz-modelo').value = m.pth;
        $('vz-modelo').dispatchEvent(new Event('change'));
        pintarBiblioteca();
        setStatus('Modelo de voz: ' + m.nome + '.');
      } }),
      el('button', { class: 'tecla p md-lixo', text: '×', title: 'Apagar este modelo (vai para a Lixeira)', onclick: () => apagarModelo(m) }));
  }) : [el('div', { class: 'vazio', text: 'Nenhum modelo aqui.' })]));
  $('md-apagar-pasta').hidden = f.tipo !== 'pasta';
}
// Mudar o nome que aparece no app (apelido). A pasta do modelo no Applio continua com o nome dela.
function renomearModelo(m, onde) {
  if (onde.querySelector('input')) return;
  const campo = el('input', { class: 'campo', type: 'text', maxlength: '40', spellcheck: 'false', value: m.nome, 'aria-label': 'Nome do modelo' });
  onde.replaceChildren(campo);
  campo.focus();
  campo.select();
  let feito = false;
  const fechar = async (salvar) => {
    if (feito) return;
    feito = true;
    const novo = campo.value.trim().slice(0, 40);
    if (salvar && novo && novo !== m.nome) {
      // nome igual ao da pasta = sem apelido
      state.config.biblioteca = await api.bibliotecaSalvar({ pth: m.pth, dados: { apelido: novo === (m.pastaNome || '') ? '' : novo } });
      await carregarConfig();
    }
    pintarBiblioteca();
  };
  campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') fechar(true); else if (e.key === 'Escape') fechar(false); });
  campo.addEventListener('blur', () => fechar(true));
  campo.addEventListener('click', (e) => e.stopPropagation());
}

// Amostra: uma frase em português na voz do modelo. Voz aguda é lida por leitora, as outras por leitor.
const somDaAmostra = new Audio();
async function ouvirAmostra(m, botao) {
  if (state.rodando) return setStatus('Espere o trabalho atual terminar para gerar a amostra.', true);
  somDaAmostra.pause();
  const altura = m.treino ? 0 : Number((state.config.alturaModelos || {})[m.pth]) || 0;
  botao.textContent = '…';
  botao.disabled = true;
  const r = await api.modeloAmostra({ pth: m.pth, index: m.index, feminina: altura >= 200 });
  botao.textContent = '▶';
  botao.disabled = false;
  if (!r.ok) return setStatus(r.error || 'Não consegui gerar a amostra.', true);
  somDaAmostra.src = fileUrl(r.data);
  somDaAmostra.play();
}
$('dlg-modelos').addEventListener('close', () => somDaAmostra.pause());
async function apagarModelo(m) {
  somDaAmostra.pause();
  const r = await api.modeloApagar({ pth: m.pth });
  if (!r.ok) { if (r.error) setStatus(r.error, true); return; }
  await carregarConfig();
  pintarBiblioteca();
  setStatus('Modelo ' + m.nome + ' foi para a Lixeira.');
}
document.querySelectorAll('.md-aba').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.md-aba').forEach((x) => x.classList.toggle('on', x === b));
  $('md-biblioteca').hidden = b.dataset.md !== 'biblioteca';
  $('md-baixar-painel').hidden = b.dataset.md !== 'baixar';
  $('md-procurar').hidden = b.dataset.md !== 'procurar';
  if (b.dataset.md === 'biblioteca') pintarBiblioteca();
  if (b.dataset.md === 'procurar') setTimeout(() => $('md-termo').focus(), 0);
}));

// ---------- procurar modelos no Hugging Face ----------
const instaladosPorNome = () => new Set(((state.config && state.config.modelos) || []).map((m) => String(m.pastaNome || m.nome || '').toLowerCase()));
async function procurarModelos() {
  const termo = $('md-termo').value.trim();
  const box = $('md-resultados');
  if (!termo) return;
  box.replaceChildren(el('div', { class: 'vazio', text: 'Procurando…' }));
  $('md-procurar-ir').disabled = true;
  const r = await api.modelosProcurar(termo);
  $('md-procurar-ir').disabled = false;
  box.replaceChildren();
  if (!r.ok) return box.append(el('div', { class: 'vazio', text: 'Não consegui procurar: ' + r.error }));
  if (!r.itens.length) return box.append(el('div', { class: 'vazio', text: `Nada com voz pronta para "${termo}". Tente outro jeito de escrever (sem espaço, só o primeiro nome).` }));
  const ja = instaladosPorNome();
  for (const it of r.itens) {
    const cab = el('div', { class: 'md-res-cab' },
      el('span', { class: 'mono', text: it.repo }),
      el('span', { class: 'fraco', text: (it.downloads ? '↓ ' + it.downloads + ' no mês' : 'pouco baixado') + (it.total > it.opcoes.length ? ` · ${it.total} vozes, mostrando as com "${termo}"` : '') }),
      el('button', { class: 'tecla p', text: 'Página', title: 'Abrir a página no navegador', onclick: () => api.abrirHf('https://huggingface.co/' + it.repo) }));
    const linhas = it.opcoes.map((o) => {
      const tem = ja.has(o.nome.toLowerCase());
      return el('div', { class: 'md-res-linha' },
        el('span', { text: o.nome }),
        el('span', { class: 'fraco', text: (o.zip ? 'pacote .zip' : 'voz .pth' + (o.index ? ' + índice' : ' sem índice')) }),
        el('button', { class: 'tecla p' + (tem ? '' : ' forte'), text: tem ? 'Já tenho' : 'Baixar', disabled: tem,
          onclick: () => baixarDaBusca(o) }));
    });
    box.append(el('div', { class: 'md-res' }, cab, ...linhas));
  }
}
// Baixar pela busca usa o mesmo caminho da lista colada: mostra o andamento na aba "Baixar por link".
function baixarDaBusca(o) {
  const item = o.zip ? { nome: o.nome, zip: o.zip } : { nome: o.nome, pth: o.pth, ...(o.index ? { index: o.index } : {}) };
  $('md-lista').value = JSON.stringify([item], null, 2);
  document.querySelector('.md-aba[data-md="baixar"]').click();
  $('md-baixar').click();
}
$('md-procurar-ir').addEventListener('click', procurarModelos);
$('md-termo').addEventListener('keydown', (e) => { if (e.key === 'Enter') procurarModelos(); });
$('md-criar-pasta').addEventListener('click', () => {
  const nome = $('md-nova-pasta').value.trim().slice(0, 40);
  const pastas = state.config.pastas || [];
  if (!nome || pastas.includes(nome)) return;
  $('md-nova-pasta').value = '';
  md.filtro = { tipo: 'pasta', valor: nome };
  guardarPastas([...pastas, nome]);
});
$('md-nova-pasta').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('md-criar-pasta').click(); });
$('md-apagar-pasta').addEventListener('click', () => {
  // os modelos da pasta continuam instalados; só ficam sem pasta
  const nome = md.filtro.valor;
  md.filtro = { tipo: 'todos', valor: '' };
  guardarPastas((state.config.pastas || []).filter((p) => p !== nome));
});

// ---------- baixar modelos de voz ----------
// O usuário cola a lista e clica; o app baixa, extrai e instala. A tela só mostra o andamento.
const linhaDoModelo = (i, nome) => {
  let linha = document.getElementById('md-linha-' + i);
  if (!linha) {
    linha = el('div', { class: 'md-linha', id: 'md-linha-' + i }, el('span', { class: 'mono', text: nome }), el('span', { class: 'fraco', text: '' }));
    $('md-andamento').append(linha);
  }
  return linha.lastChild;
};
api.onModelos((ev) => {
  const alvo = linhaDoModelo(ev.i, ev.nome);
  alvo.textContent = ev.texto;
  alvo.className = /^instalado|^já estava/.test(ev.texto) ? 'ok' : /^falhou|^cancelado/.test(ev.texto) ? 'ruim' : 'fraco';
});
$('md-baixar').addEventListener('click', async () => {
  const texto = $('md-lista').value;
  const lista = await api.modelosConferir(texto);
  $('md-andamento').replaceChildren();
  if (!lista.itens.length) { $('md-aviso').textContent = lista.erros[0] || 'Nenhum modelo na lista.'; return; }
  lista.itens.forEach((it, i) => { linhaDoModelo(i, it.nome).textContent = 'na fila'; });
  $('md-aviso').textContent = lista.erros.length ? lista.erros.length + ' item(ns) recusado(s): ' + lista.erros[0] : '';
  $('md-baixar').disabled = true;
  $('md-cancelar').hidden = false;
  const r = await api.modelosBaixar(texto);
  $('md-baixar').disabled = false;
  $('md-cancelar').hidden = true;
  if (!r.ok) { $('md-aviso').textContent = r.error; return; }
  const bons = r.feitos.filter((f) => f.ok).length;
  $('md-aviso').textContent = bons + ' de ' + r.feitos.length + ' instalado(s). Já aparecem na biblioteca.';
  await carregarConfig();
  pintarBiblioteca();
});
$('md-cancelar').addEventListener('click', () => api.modelosCancelar());

// ---------- voz ao vivo ----------
// O microfone entra, sai a voz do modelo. O motor é o de tempo real do Applio, comandado daqui.
const aoVivo = { ligada: false, aparelhos: null };
// Qualidade da voz ao vivo. A chave é o tamanho do bloco de som (ms), que é também o grosso do atraso.
//   emenda   transição entre um bloco e o seguinte: mais longa = sem degraus nem estalos
//   contexto quanto de fala anterior o motor relê a cada bloco: mais = timbre mais firme, mais placa
//   portao   abaixo disso é silêncio. Fica no mínimo (-60 dB): o microfone do usuário já passa pelo portão
//            do Voicemod (-50 dB); um segundo portão mais alto aqui cortaria o começo das palavras
//   indice   teto da proporção do índice ao vivo (alto demais deixa metálico)
const QUALIDADE_AO_VIVO = {
  150: { emenda: 0.05, contexto: 1.5, portao: -60, indice: 0.5 },
  250: { emenda: 0.10, contexto: 2.5, portao: -60, indice: 0.5 },
  400: { emenda: 0.15, contexto: 4.0, portao: -60, indice: 0.5 },
};
function pintarAoVivo(texto, cor) {
  $('av-estado').textContent = texto;
  $('av-lamp').className = 'lamp' + (cor ? ' ' + cor : '');
  $('av-ligar').textContent = aoVivo.ligada ? 'Desligar' : 'Ligar';
  $('btn-voz-ao-vivo').classList.toggle('no-ar', aoVivo.ligada);
  $('btn-voz-ao-vivo').textContent = aoVivo.ligada ? '● Ao vivo' : 'Voz ao vivo';
  $('btn-voz-ao-vivo').title = aoVivo.ligada ? 'Voz ao vivo ligada. Clique para abrir.' : 'Fale no microfone e saia na voz do modelo';
  // o modelo pode ser trocado com a voz no ar; os aparelhos e a qualidade não
  ['av-entrada', 'av-saida', 'av-bloco', 'av-retorno-em'].forEach((id) => { $(id).disabled = aoVivo.ligada; });
  if (!aoVivo.ligada) $('av-vu').style.width = '0';
  $('av-testar').disabled = !aoVivo.ligada || cor !== 'sinal' || !!aoVivo.testando;
}
// Põe na régua o tom guardado para o modelo escolhido; se ele nunca foi usado, o valor de reserva.
function tomDoModeloAoVivo(reserva) {
  const tons = (state.config && state.config.aoVivoTons) || {};
  const guardado = tons[$('av-modelo').value];
  $('av-tom').value = Number.isFinite(guardado) ? guardado : reserva;
  $('av-tom-v').textContent = sinal(Number($('av-tom').value));
}
function guardarAoVivo() {
  const nome = (id) => { const o = $(id).selectedOptions[0]; return o ? o.textContent : ''; };
  state.config.aoVivo = {
    entrada: nome('av-entrada'), saida: nome('av-saida'), modelo: $('av-modelo').value, bloco: Number($('av-bloco').value), tom: Number($('av-tom').value),
    retorno: sw('av-retorno'), retornoEm: nome('av-retorno-em'), micro: sw('av-micro'),
  };
  // cada modelo lembra o tom que foi usado com ele
  if ($('av-modelo').value) state.config.aoVivoTons = { ...(state.config.aoVivoTons || {}), [$('av-modelo').value]: Number($('av-tom').value) };
  api.configSalvar({ aoVivo: state.config.aoVivo, aoVivoTons: state.config.aoVivoTons || {} });
}
async function abrirAoVivo() {
  const c = state.config;
  const salvo = c.aoVivo || {};
  $('av-modelo').replaceChildren(...opcoesDeModelos());
  const principal = modeloAtual();
  $('av-modelo').value = c.modelos.some((m) => m.pth === salvo.modelo) ? salvo.modelo : principal ? principal.pth : '';
  $('av-bloco').value = [150, 250, 400].includes(salvo.bloco) ? String(salvo.bloco) : '250';
  if (!aoVivo.ligada) {
    tomDoModeloAoVivo(salvo.tom || 0);
    $('av-retorno').setAttribute('aria-checked', String(!!salvo.retorno));
    $('av-micro').setAttribute('aria-checked', String(salvo.micro !== false));
  }
  const real = await api.aoVivoEstado();
  aoVivo.ligada = real.ligada;
  if (real.ligada) {
    if (real.pth && state.config.modelos.some((x) => x.pth === real.pth)) $('av-modelo').value = real.pth;
    $('av-tom').value = real.tom;
    $('av-tom-v').textContent = sinal(real.tom);
    $('av-retorno').setAttribute('aria-checked', String(!!real.retorno));
  }
  $('dlg-aovivo').showModal();
  if (aoVivo.ligada) return pintarAoVivo('no ar', 'sinal');
  pintarAoVivo('procurando microfones…', 'pisca');
  $('av-ligar').disabled = true;
  const r = await api.aoVivoAparelhos();
  $('av-ligar').disabled = !r.ok;
  if (!r.ok) return pintarAoVivo(r.error, 'erro');
  aoVivo.aparelhos = r;
  // ordem de preferência: o que foi usado da última vez; senão o aparelho de costume (microfone limpo do
  // Voicemod, alto-falantes Realtek); senão o padrão do Windows
  const encher = (id, lista, nomeSalvo, padrao, costume) => {
    $(id).replaceChildren(...lista.map((a) => el('option', { value: String(a.id), text: a.nome })));
    const achado = lista.find((a) => a.nome === nomeSalvo) || lista.find((a) => a.nome.includes(costume))
      || lista.find((a) => a.id === padrao) || lista[0];
    if (achado) $(id).value = String(achado.id);
  };
  encher('av-entrada', r.entradas, salvo.entrada, r.padrao && r.padrao[0], 'Microphone (Voicemod)');
  encher('av-saida', r.saidas, salvo.saida, r.padrao && r.padrao[1], 'Speakers (Realtek');
  encher('av-retorno-em', r.saidas, salvo.retornoEm, r.padrao && r.padrao[1], 'Speakers (Realtek');
  pintarAoVivo('desligada');
}
$('av-ligar').addEventListener('click', async () => {
  if (aoVivo.ocupada) return;
  aoVivo.ocupada = true;
  try { await ligarOuDesligarAoVivo(); } finally { aoVivo.ocupada = false; }
});
async function ligarOuDesligarAoVivo() {
  if (aoVivo.ligada) {
    aoVivo.ligada = false;
    pintarAoVivo('desligada');
    await api.aoVivoDesligar();
    return;
  }
  if (state.rodando) return pintarAoVivo('há uma música sendo convertida: espere terminar', 'erro');
  const m = state.config.modelos.find((x) => x.pth === $('av-modelo').value);
  if (!m) return pintarAoVivo('escolha um modelo de voz', 'erro');
  if (!$('av-entrada').value || !$('av-saida').value) return pintarAoVivo('escolha o microfone e a saída', 'erro');
  guardarAoVivo();
  const v = ajustesVoz();
  const q = QUALIDADE_AO_VIVO[Number($('av-bloco').value)] || QUALIDADE_AO_VIVO[250];
  const r = await api.aoVivoLigar({
    pth: m.pth, index: m.index, entrada: Number($('av-entrada').value), saida: Number($('av-saida').value),
    tom: Number($('av-tom').value), bloco: Number($('av-bloco').value),
    retorno: sw('av-retorno'), retornoEm: Number($('av-retorno-em').value),
    // só troca o microfone do Windows se a voz estiver indo para o cabo virtual
    microAuto: sw('av-micro') && (($('av-saida').selectedOptions[0] || {}).textContent || '').startsWith('CABLE Input'),
    emenda: q.emenda, contexto: q.contexto, portao: q.portao,
    f0: v.f0, embedder: v.embedder, indexRate: Math.min(v.indexRate, q.indice), protect: v.protect,
  });
  if (!r.ok) return pintarAoVivo(r.error, 'erro');
  aoVivo.ligada = true;
  pintarAoVivo('abrindo o microfone…', 'pisca');
}
$('av-tom').addEventListener('input', () => {
  $('av-tom-v').textContent = sinal(Number($('av-tom').value));
  if (aoVivo.ligada) api.aoVivoTom(Number($('av-tom').value));
});
$('av-tom').addEventListener('change', () => { if (state.config) guardarAoVivo(); });
// qualquer escolha fica guardada na hora, não só ao ligar
['av-entrada', 'av-saida', 'av-bloco', 'av-retorno-em'].forEach((id) => $(id).addEventListener('change', () => { if (state.config) guardarAoVivo(); }));
$('av-modelo').addEventListener('change', async () => {
  if (!state.config) return;
  tomDoModeloAoVivo(0);   // modelo que nunca foi usado começa em 0
  guardarAoVivo();
  if (!aoVivo.ligada) return;
  // voz no ar: troca sem desligar; o tom guardado desse modelo vai junto
  const m = state.config.modelos.find((x) => x.pth === $('av-modelo').value);
  if (!m) return;
  aoVivo.trocandoAte = Date.now() + 5000;
  pintarAoVivo('trocando para ' + m.nome + '…', 'pisca');
  const r = await api.aoVivoModelo({ pth: m.pth, index: m.index, tom: Number($('av-tom').value) });
  if (!r.ok && r.error) { aoVivo.trocandoAte = 0; pintarAoVivo(r.error, 'erro'); }
});
// Testar voz: grava 8 s da voz já trocada e toca de volta, para ouvir como os outros ouvem.
const testeAoVivo = new Audio();
$('av-testar').addEventListener('click', async () => {
  if (!aoVivo.ligada || aoVivo.testando) return;
  testeAoVivo.pause();
  const r = await api.aoVivoTestar(8);
  if (!r.ok) return pintarAoVivo(r.error, 'erro');
  aoVivo.testando = true;
  $('av-testar').disabled = true;
  let falta = r.segundos;
  const contar = () => { $('av-aviso').textContent = 'Gravando o teste: fale agora… ' + falta + ' s'; };
  contar();
  clearInterval(aoVivo.relogioTeste);
  aoVivo.relogioTeste = setInterval(() => {
    falta -= 1;
    if (falta > 0) return contar();
    clearInterval(aoVivo.relogioTeste);
    $('av-aviso').textContent = 'Preparando o teste…';
    // se o arquivo não chegar (voz desligada no meio), solta o botão
    setTimeout(() => { if (aoVivo.testando) { aoVivo.testando = false; $('av-aviso').textContent = 'O teste não chegou. Tente de novo.'; } }, 6000);
  }, 1000);
});
testeAoVivo.addEventListener('ended', () => { $('av-aviso').textContent = 'Fim do teste. É assim que os outros ouvem.'; });
$('dlg-aovivo').addEventListener('close', () => testeAoVivo.pause());
$('av-micro').addEventListener('click', () => setTimeout(() => { if (state.config) guardarAoVivo(); }, 0));
// retorno: liga e desliga na hora, sem reiniciar a voz
$('av-retorno').addEventListener('click', () => setTimeout(() => {
  if (state.config) guardarAoVivo();
  api.aoVivoRetorno(sw('av-retorno'));
  const mesmo = $('av-retorno-em').value === $('av-saida').value;
  $('av-aviso').textContent = sw('av-retorno') && mesmo
    ? 'Retorno e saída estão no mesmo aparelho: você já se ouve pela saída. Escolha outro aparelho no retorno.'
    : 'Fechar esta janela não desliga a voz.';
}, 0));
api.onAoVivo((ev) => {
  if (ev.tipo === 'teste') {
    aoVivo.testando = false;
    clearInterval(aoVivo.relogioTeste);
    $('av-aviso').textContent = 'Tocando o teste em ' + (($('av-retorno-em').selectedOptions[0] || {}).textContent || 'seu fone') + '…';
    if (ev.tocando) {
      // o motor já está tocando no aparelho do retorno; aqui só o aviso de fim
      clearTimeout(aoVivo.fimTeste);
      aoVivo.fimTeste = setTimeout(() => { $('av-aviso').textContent = 'Fim do teste. É assim que os outros ouvem.'; }, (ev.segundos || 8) * 1000 + 300);
    } else {
      testeAoVivo.src = fileUrl(ev.arquivo);
      testeAoVivo.play();
    }
    return;
  }
  if (ev.tipo === 'microfone') {
    $('av-aviso').textContent = !ev.ok ? ev.error
      : ev.volta ? 'Microfone do Windows voltou para ' + ev.nome + ': os programas ouvem sua voz normal.'
        : 'Microfone do Windows agora é o cabo: todo programa ouve só a voz trocada.' + (ev.anterior ? ' Ao desligar, volta para ' + ev.anterior + '.' : '');
    return;
  }
  if (ev.tipo === 'religando') { aoVivo.trocandoAte = 0; return pintarAoVivo('religando com o modelo novo… (uns 20 s)', 'pisca'); }
  if (ev.tipo === 'fim') {
    aoVivo.testando = false;
    clearInterval(aoVivo.relogioTeste);
    aoVivo.ligada = false;
    return pintarAoVivo(ev.erro ? 'parou: ' + ev.erro : 'desligada', ev.erro ? 'erro' : '');
  }
  if (!aoVivo.ligada || ev.tipo !== 'estado') return;
  if (aoVivo.trocandoAte && Date.now() < aoVivo.trocandoAte) return;   // deixa o aviso de troca na tela um instante
  if (ev.latencia == null) return pintarAoVivo('abrindo o microfone…', 'pisca');
  if (!ev.pronto) return pintarAoVivo(ev.ouvindo ? 'carregando o modelo… (uns 20 s)' : 'abrindo o microfone…', 'pisca');
  if (ev.aquecendo > 0) return pintarAoVivo('aquecendo… (' + ev.aquecendo + ')', 'pisca');
  // atraso que se ouve: o bloco de som mais o tempo que o motor leva para convertê-lo
  const atraso = Math.round(Number($('av-bloco').value) + ev.latencia);
  pintarAoVivo('no ar · atraso ~' + atraso + ' ms', 'sinal');
  // o motor informa o volume do microfone de 0 a 1; o medidor mostra de -60 dB a 0 dB
  const db = 20 * Math.log10(Math.max(ev.volume || 0, 0.00001));
  $('av-vu').style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)).toFixed(0) + '%';
});

// Altura da voz do modelo. Treinado neste Applio: medida das curvas do treino. Baixado pronto: o usuário diz.
const ALTURAS = [['0', 'não sei (música inteira num tom só)'], ['130', 'grave (homem)'], ['175', 'média'], ['220', 'aguda (mulher)']];
function modeloAtual() {
  const c = state.config;
  return c && c.modelos ? c.modelos.find((x) => x.pth === $('vz-modelo').value) || null : null;
}
function atualizarAltura() {
  const m = modeloAtual();
  const sel = $('vz-altura');
  sel.closest('label').hidden = !!(m && m.treino);
  if (m && m.treino) {
    sel.replaceChildren(el('option', { value: '0', text: 'medida do treino (automática)' }));
    sel.disabled = true;
    return;
  }
  sel.disabled = !m;
  sel.replaceChildren(...ALTURAS.map(([value, text]) => el('option', { value, text })));
  const salva = m && state.config.alturaModelos ? state.config.alturaModelos[m.pth] : null;
  sel.value = ALTURAS.some(([v]) => v === String(salva)) ? String(salva) : '0';
}
// Segundo modelo (opcional): a mesma música sai também na voz dele, em faixa própria.
function modelo2Atual() {
  const c = state.config;
  const m = modeloAtual();
  const pth = $('vz-modelo2').value;
  const m2 = c && c.modelos ? c.modelos.find((x) => x.pth === pth) : null;
  return m2 && m && m2.pth !== m.pth ? m2 : null;
}
function atualizarSegundo() {
  const m2 = modelo2Atual();
  const precisa = !!m2 && !m2.treino;
  $('vz-altura2-linha').hidden = !precisa;
  if (precisa) {
    const sel = $('vz-altura2');
    sel.replaceChildren(...ALTURAS.map(([value, text]) => el('option', { value, text })));
    const salva = state.config.alturaModelos ? state.config.alturaModelos[m2.pth] : null;
    sel.value = ALTURAS.some(([v]) => v === String(salva)) ? String(salva) : '0';
  }
}
function vozEscolhida() {
  const c = state.config;
  if (!c || !c.applioOk || !$('vz-pitch')) return null;
  const m = modeloAtual();
  if (!m) return null;
  const v = { applioDir: c.applioDir, pth: m.pth, index: m.index, nome: m.nome, ...ajustesVoz(), centroModelo: m.treino ? 0 : Number($('vz-altura').value) || 0 };
  const m2 = modelo2Atual();
  v.segundo = m2 ? { pth: m2.pth, index: m2.index, nome: m2.nome, centroModelo: m2.treino ? 0 : Number($('vz-altura2').value) || 0 } : null;
  return v;
}
async function carregarConfig() {
  const c = await api.configLer();
  state.config = c;
  montarListasDeModelos();
  atualizarAltura();
  preencherVoz(c.voz);
  atualizarSegundo();
  $('aj-cantor').setAttribute('aria-checked', String(c.cantor !== false));
  $('aj-som').setAttribute('aria-checked', String(c.som !== false));
  $('palco').hidden = c.cantor === false;
  $('vz-info').textContent = c.applioOk
    ? `${c.applioDir} (${c.modelos.length} ${c.modelos.length === 1 ? 'modelo' : 'modelos'})`
    : c.applioDir ? `${c.applioDir}: não achei o core.py ou o env\\python.exe` : 'não encontrado';
  const tem = c.applioOk && c.modelos.length > 0;
  const chave = $('sw-voz');
  chave.disabled = !tem;
  chave.style.opacity = tem ? '' : '.45';
  if (!tem) chave.setAttribute('aria-checked', 'false');   // as chaves da mesa sempre abrem apagadas
  rotuloVoz();
  atualizarSaida();
  atualizarMesa();
}
function rotuloVoz() {
  const v = vozEscolhida();
  $('sw-voz-txt').textContent = v ? `Trocar a voz no Applio (${v.nome})` : 'Trocar a voz no Applio (configure em Ajustes)';
  $('aj-voz-resumo').textContent = v ? 'modelo ' + v.nome + ', tom ' + (v.tomSozinho ? 'automático' : sinal(v.pitch)) : 'nenhum modelo escolhido';
}
function salvarVoz() {
  const v = vozEscolhida();
  api.configSalvar({ vozPth: v ? v.pth : '', voz: ajustesVoz(), vozLigada: sw('sw-voz') });
  rotuloVoz();
  atualizarSaida();
}
const chaveDe = (o) => JSON.stringify([o.url, o.file, o.ini, o.fim, o.previa, o.tom, o.idioma]);

// Duração do que vai ser gravado, quando já dá para saber.
function duracaoPrevista(o) {
  if (o.modo === 'criar' || o.modo === 'continuar') return o.duracao;
  const key = chaveDe(o);
  if (state.analise && state.analise.key === key) return Math.min(state.analise.meta.duration, state.limite);
  if (o.previa) return 30;
  if (o.fim != null) return Math.min(o.fim - o.ini, state.limite);
  return null;
}
function estimativa(dur, o) {
  if (dur == null) return null;
  return TEMPO.fixo + dur * TEMPO.composicao
    + (dur * TEMPO.sintese + dur * dur * TEMPO.sintese2) * (o.passos / 32)
    + dur * TEMPO.final + (o.separar ? dur * TEMPO.separar : 0) + (o.voz ? 15 + dur * TEMPO.voz : 0);
}
function textoEspera(seg) {
  if (seg < 90) return 'cerca de 1 min';
  return `cerca de ${Math.round(seg / 60)} min`;
}

// Atualiza visor, lâmpadas e o texto do botão de gravar conforme o que está na mesa.
function atualizarMesa() {
  if (!$('knob')) return;
  let o = null;
  try { o = lerMesa(); } catch {}
  const analisada = o && state.analise && state.analise.key === chaveDe(o) ? state.analise.meta : null;

  // visor
  const url = $('in-url').value.trim();
  if (state.modoMesa === 'criar') {
    $('vis-titulo').textContent = (o && o.titulo) || 'Música nova';
    $('vis-sub').textContent = o && o.instrumental ? 'instrumental, do zero' : 'do zero';
  } else if (analisada) {
    $('vis-titulo').textContent = analisada.title || 'Sem título';
    $('vis-sub').textContent = state.arquivo ? 'arquivo local' : 'pronta para gravar';
  } else if (state.arquivo) {
    $('vis-titulo').textContent = nomeArquivo(state.arquivo).replace(/\.[^.]+$/, '');
    $('vis-sub').textContent = 'arquivo local';
  } else if (url) {
    $('vis-titulo').textContent = 'Link colado';
    $('vis-sub').textContent = url.replace(/^https?:\/\/(www\.)?/, '');
  } else {
    $('vis-titulo').textContent = 'Sem música';
    $('vis-sub').textContent = 'cole um link ou escolha um arquivo';
  }
  const ini = o ? (o.modo === 'criar' ? 0 : o.ini) : null;
  const dur = o ? duracaoPrevista(o) : null;
  $('vis-ini').textContent = fmt2(ini == null ? null : ini);
  $('vis-fim').textContent = fmt2(dur == null ? null : ini + dur);
  $('vis-tot').textContent = fmt2(dur);

  $('lamp-entrada').className = 'lamp' + (temOrigem() ? ' sinal' : '');
  const soVoz = state.modoMesa === 'voz';
  $('lamp-versao').className = 'lamp' + ((soVoz ? vozEscolhida() : o && o.estilo) ? ' on' : '');

  if (state.rodando) return;
  if (soVoz) {
    const v = vozEscolhida();
    if (!temOrigem()) return setRec('Trocar a voz', 'escolha uma música');
    if (!o) return setRec('Trocar a voz', 'confira o trecho', 'falha');
    if (!v) return setRec('Trocar a voz', 'escolha um modelo em "Voz (Applio)"', 'aviso');
    const t = dur == null ? null : 20 + dur * (TEMPO.separar + TEMPO.voz * (v.segundo ? 2 : 1));
    const nomes = v.nome + (v.segundo ? ' + ' + v.segundo.nome : '');
    const tomTxt = v.tomSozinho && state.tom === 0 ? 'tom automático' : 'tom ' + sinal(state.tom);
    return setRec('Trocar a voz', (t == null ? 'voz ' + nomes + ': o tempo aparece depois de baixar' : textoEspera(t) + ', voz ' + nomes) + ', ' + tomTxt);
  }
  if (state.modoMesa !== 'criar' && !temOrigem()) return setRec('Gravar', 'escolha uma música');
  if (!o) return setRec('Gravar', ehModo('criar', 'continuar') ? 'confira a duração' : 'confira o trecho', 'falha');
  if (!o.estilo) return setRec('Gravar', o.instrumental ? 'escreva o estilo do instrumental' : 'escolha uma voz ou escreva um estilo');
  if (ehModo('criar', 'continuar') && !o.instrumental && !$('in-letra').value.trim()) return setRec('Gravar', 'escreva a letra');
  const est = estimativa(dur, o);
  if (est == null) return setRec('Gravar', 'o tempo aparece depois de baixar a música');
  if (est > LONGO) {
    return setRec('Gravar', `${textoEspera(est)} de espera. Um trecho de até 3 min, ou 16 passos em Ajustes, encurta bastante.`, 'aviso');
  }
  setRec('Gravar', `${textoEspera(est)} nesta placa`);
}

// ---------- cadeia de sinal ----------
const ORDEM = ['download', 'partitura', 'letra', 'cover', 'separar', 'voz'];
const cadeia = { ativas: [], atual: null, inicio: 0, relogio: null };
const etapaEl = (k) => document.querySelector(`.etapa[data-etapa="${k}"]`);

// ---------- som de aviso ----------
// Feito na hora, sem arquivo: três notas subindo quando termina, duas descendo quando dá erro.
let somCtx = null;
function tocarAviso(tipo) {
  if (!sw('aj-som')) return;
  try {
    somCtx = somCtx || new AudioContext();
    const notas = tipo === 'erro' ? [392, 294] : [659.25, 880, 1318.5];
    const t0 = somCtx.currentTime + 0.03;
    notas.forEach((hz, i) => {
      const o = somCtx.createOscillator();
      const g = somCtx.createGain();
      const t = t0 + i * 0.16;
      o.type = 'sine';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i === notas.length - 1 ? 0.9 : 0.35));
      o.connect(g).connect(somCtx.destination);
      o.start(t);
      o.stop(t + 1);
    });
  } catch {}
}

function cadeiaIniciar(ativas, jaFeitas = []) {
  cadeiaParar();
  if (ativas.length) cadeia.comeco = Date.now();
  cadeia.ativas = ativas;
  cadeia.atual = null;
  for (const k of ORDEM) {
    const e = etapaEl(k);
    e.className = 'etapa' + (ativas.includes(k) || jaFeitas.includes(k) ? '' : ' fora');
    e.querySelector('.lamp').className = 'lamp' + (jaFeitas.includes(k) ? ' sinal' : '');
    e.querySelector('.tc').textContent = '';
  }
}
function cadeiaEvento(ev) {
  if (!cadeia.ativas.includes(ev.stage)) return;
  if (cadeia.atual !== ev.stage) {
    const agora = Date.now();
    for (const k of cadeia.ativas) {
      if (k === ev.stage) break;
      const e = etapaEl(k);
      if (!e.querySelector('.lamp').classList.contains('sinal')) {
        e.querySelector('.lamp').className = 'lamp sinal';
        e.classList.remove('ativa');
        if (k === cadeia.atual) e.querySelector('.tc').textContent = fmt((agora - cadeia.inicio) / 1000);
      }
    }
    cadeia.atual = ev.stage;
    cadeia.inicio = agora;
    const e = etapaEl(ev.stage);
    e.classList.add('ativa');
    e.querySelector('.lamp').className = 'lamp pisca';
    clearInterval(cadeia.relogio);
    cadeia.relogio = setInterval(() => {
      if (cadeia.atual) etapaEl(cadeia.atual).querySelector('.tc').textContent = fmt((Date.now() - cadeia.inicio) / 1000);
    }, 500);
  }
}
// fim: 'ok' acende tudo; 'pausa' fecha a etapa atual; 'erro' marca a etapa atual; 'cancelado' apaga
function cadeiaFechar(como) {
  clearInterval(cadeia.relogio);
  // trabalho de poucos segundos (ex.: refazer a emenda) não precisa de aviso
  if ((como === 'ok' || como === 'erro') && cadeia.comeco && Date.now() - cadeia.comeco > 8000) { tocarAviso(como); api.piscar(); }
  if (como !== 'pausa') cadeia.comeco = 0;
  const agora = Date.now();
  for (const k of cadeia.ativas) {
    const e = etapaEl(k);
    const lamp = e.querySelector('.lamp');
    const atual = k === cadeia.atual;
    e.classList.remove('ativa');
    if (atual) e.querySelector('.tc').textContent = fmt((agora - cadeia.inicio) / 1000);
    if (como === 'ok') lamp.className = 'lamp sinal';
    else if (atual) lamp.className = 'lamp' + (como === 'erro' ? ' erro' : como === 'pausa' ? ' sinal' : '');
    else if (!lamp.classList.contains('sinal')) lamp.className = 'lamp';
  }
  cadeia.atual = null;
}
function cadeiaParar() { clearInterval(cadeia.relogio); cadeia.atual = null; }

api.onProgresso((ev) => {
  if (state.modo === 'sep') {
    $('sep-barra').firstElementChild.style.width = ev.pct + '%';
    $('sep-msg').textContent = ev.message;
    return;
  }
  if (state.modo === 'fala') { $('fl-msg').textContent = ev.message; return; }
  cadeiaEvento(ev);
  const pct = ev.pct > 0 && ev.pct < 100 ? ` ${Math.round(ev.pct)}%` : '';
  setStatus(ev.message + pct);
  if (state.rodando) $('rec-sub').textContent = ev.message + pct;
});

function setRodando(on) {
  state.rodando = on;
  document.querySelector('.rec').classList.toggle('rodando', on);
  $('btn-rec').setAttribute('aria-label', on ? 'Parar' : 'Gravar');
  $('lamp-saida').className = 'lamp' + (on ? ' pisca' : state.carregada ? ' sinal' : '');
  if (on) setRec('Parar', 'começando…');
}

// ---------- gravar ----------
$('btn-rec').addEventListener('click', async () => {
  if (state.rodando) {
    state.seq = 0;
    setStatus('Parando…');
    api.cancelar();
    return;
  }
  let o;
  try { o = lerMesa(); } catch (e) { setStatus(e.message, true); return setRec(tituloRec(), e.message, 'falha'); }
  if (state.modoMesa !== 'criar' && !o.url && !o.file) return setStatus('Cole um link ou escolha um arquivo.', true);
  if (state.modoMesa === 'voz') return trocarSoVoz(o);
  if (state.modoMesa === 'criar') return gravarDoZero(o);
  if (state.modoMesa === 'continuar') return gravarContinuacao(o);
  if (!o.estilo) return setStatus('Escolha uma voz ou escreva um estilo.', true);

  const key = chaveDe(o);
  // letra no campo só vale se for desta música
  const campo = $('in-letra').value;
  const letraValida = campo.trim() && (state.letraDe === null || state.letraDe === origemId());
  if (campo.trim() && !letraValida) $('in-letra').value = '';

  const reusar = state.analise && state.analise.key === key;
  const etapasAnalise = ['download', 'partitura', 'letra'];
  const etapasGravar = ['cover', ...(o.separar ? ['separar'] : []), ...(o.voz ? ['voz'] : [])];
  cadeiaIniciar(reusar ? etapasGravar : [...etapasAnalise, ...etapasGravar], reusar ? etapasAnalise : []);
  state.modo = 'mesa';
  setRodando(true);

  let meta;
  if (reusar) {
    meta = state.analise.meta;
  } else {
    const r = await api.analisar({
      url: o.url, file: o.file, start: o.ini, end: o.fim, preview: o.previa,
      semitones: o.tom, lang: o.idioma, lyrics: letraValida ? campo : '',
    });
    if (!r.ok) return terminar(r);
    meta = r.data;
    state.analise = { key, meta };
    state.abcEditado = null;
    atualizarMesa(); // o visor passa a mostrar o nome e a duração reais
    if (!letraValida) {
      $('in-letra').value = meta.lyrics;
      state.letraDe = origemId();
      $('letra-nota').textContent = meta.lyrics.trim() ? 'reconhecida, confira' : 'não reconhecida: cole a letra';
    }
    carregarRecentes();

    // pausas: sem letra, conferir a letra, ou gravação longa
    const semLetra = !$('in-letra').value.trim();
    const conferir = sw('sw-revisar') && meta.lyricsAuto;
    const est = estimativa(Math.min(meta.duration, state.limite), o);
    const longa = est > LONGO && state.longoOk !== key;
    if (semLetra || conferir || longa) {
      state.longoOk = key;
      cadeiaFechar('pausa');
      setRodando(false);
      atualizarMesa();
      const msg = semLetra ? 'Não consegui reconhecer a letra. Cole a letra e aperte Gravar.'
        : longa ? `Música de ${fmt(meta.duration)}: ${textoEspera(est)} de espera. Aperte Gravar para seguir, ou ajuste o trecho.`
          : 'Confira a letra e aperte Gravar.';
      setStatus(msg);
      return setRec('Gravar', msg, 'aviso');
    }
  }

  const letra = $('in-letra').value;
  if (!letra.trim()) {
    cadeiaFechar('pausa');
    setRodando(false);
    setStatus('Cole a letra da música antes de gravar.', true);
    return setRec('Gravar', 'falta a letra', 'falha');
  }
  const abc = state.abcEditado && state.abcEditado.key === key ? state.abcEditado.abc : meta.abc;
  const r = await api.gerar({
    dir: meta.dir,
    opts: {
      style: o.estilo, lyrics: letra, abc,
      variations: parseInt($('aj-variacoes').value, 10) || 1,
      format: $('aj-formato').value,
      steps: o.passos,
      seed: sementeDe('aj-semente'),
      lmSeed: sementeDe('aj-semente-lm'),
      separateCover: o.separar,
      voz: o.voz,
      adapters: loraEscolhido(),
    },
  });
  if (!r.ok) return terminar(r);
  cadeiaFechar('ok');
  setRodando(false);
  carregar(r.data);
  carregarRecentes();
  setStatus('Gravação pronta.');
  atualizarMesa();
  talvezRepetir();
});

// Opções de gravação comuns a todos os modos que usam o motor.
function opcoesGravacao(o) {
  return {
    style: o.estilo,
    variations: parseInt($('aj-variacoes').value, 10) || 1,
    format: $('aj-formato').value,
    steps: o.passos,
    seed: sementeDe('aj-semente'),
    lmSeed: sementeDe('aj-semente-lm'),
    separateCover: o.separar,
    voz: o.voz,
    adapters: loraEscolhido(),
    exato: ehModo('criar', 'continuar'),   // o motor não pode encerrar antes da duração pedida
  };
}
const etapasDepois = (o) => [...(o.separar ? ['separar'] : []), ...(o.voz ? ['voz'] : [])];
function fecharGravacao(r, msg) {
  if (!r.ok) return terminar(r);
  cadeiaFechar('ok');
  setRodando(false);
  carregar(r.data);
  carregarRecentes();
  setStatus(msg);
  atualizarMesa();
  talvezRepetir();
}

// Modo "criar": música nova. Se há um plano de partitura para estes mesmos dados, grava em cima dele.
const chavePlano = (o) => JSON.stringify([o.titulo, o.estilo, o.instrumental ? '' : $('in-letra').value, o.cot, o.duracao, o.instrumental]);
async function gravarDoZero(o) {
  if (!o.estilo) return setStatus('Escreva o estilo da música.', true);
  const letra = $('in-letra').value;
  if (!o.instrumental && !letra.trim()) return setStatus('Escreva a letra, ou ligue "Instrumental".', true);
  const plano = state.plano && state.plano.key === chavePlano(o) ? state.plano : null;
  const escreve = o.cot !== 'off' && !plano;
  cadeiaIniciar([...(escreve ? ['partitura'] : []), 'cover', ...etapasDepois(o)], plano ? ['partitura'] : []);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.compor({
    ...opcoesGravacao(o),
    dir: plano ? plano.meta.dir : null,
    abc: plano ? plano.abc : '',
    title: o.titulo, lyrics: letra, cot: o.cot, duration: o.duracao, instrumental: o.instrumental,
  });
  if (r.ok) state.plano = null;
  fecharGravacao(r, 'Música nova gravada.');
}

// Planejar: o motor escreve a partitura em segundos; o usuário vê, edita e só então grava.
async function planejarPartitura() {
  if (state.rodando) return setStatus('Espere o trabalho atual terminar.', true);
  let o;
  try { o = lerMesa(); } catch (e) { return setStatus(e.message, true); }
  if (o.cot === 'off') return setStatus('Escolha um tipo de partitura para planejar.', true);
  if (!o.estilo) return setStatus('Escreva o estilo da música.', true);
  const letra = $('in-letra').value;
  if (!o.instrumental && !letra.trim()) return setStatus('Escreva a letra, ou ligue "Instrumental".', true);
  cadeiaIniciar(['partitura']);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.planejar({
    title: o.titulo, style: o.estilo, lyrics: letra, cot: o.cot, duration: o.duracao, instrumental: o.instrumental,
  });
  if (!r.ok) return terminar(r);
  cadeiaFechar('ok');
  setRodando(false);
  state.plano = { key: chavePlano(o), meta: r.data, abc: r.data.abc };
  atualizarMesa();
  setStatus('Partitura planejada. Veja, edite se quiser, e aperte Gravar.');
  abrirPartitura('plano');
}

// Modo "continuar": um trecho real abre a música e o motor compõe o resto.
async function gravarContinuacao(o) {
  if (!o.estilo) return setStatus('Escolha uma voz ou escreva um estilo.', true);
  const letra = $('in-letra').value;
  if (!letra.trim()) return setStatus('Escreva a letra: a do trecho e a da continuação.', true);
  cadeiaIniciar(['download', 'partitura', 'cover', ...etapasDepois(o)]);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.continuar({
    ...opcoesGravacao(o),
    url: o.url, file: o.file, start: o.ini, end: o.fim, duration: o.duracao, lyrics: letra,
  });
  fecharGravacao(r, 'Continuação gravada.');
}

// Frase de fim de troca: diz o tom usado e avisa quando o instrumental foi para outro tom.
function resumoTroca(meta, variacao, nome) {
  const todas = ((meta && meta.vozes) || []).filter((e) => e.variacao === variacao);
  const modelos = [...new Set(todas.map((e) => e.modelo))];
  if (modelos.length > 1) {
    return 'Vozes trocadas: ' + modelos.join(' e ') + ', uma faixa inteira de cada. Escolha qual ver nos botões ao lado de "Voz final".';
  }
  const x = todas.pop();
  if (!x || x.pitch == null) return 'Voz trocada (' + nome + '). Voz e instrumental estão em arquivos separados.';
  if (x.tons && x.tons.length > 1) {
    return 'Voz trocada (' + nome + ') em ' + x.tons.length + ' tons, emendados frase a frase: ' + x.tons.map((t) => sinal(t.pitch)).join(' e ')
      + '. As versões inteiras de cada tom estão na pasta.' + (x.coro ? ' O coro saiu em arquivo à parte.' : '');
  }
  let t = 'Voz trocada (' + nome + ', tom ' + sinal(x.pitch) + (x.tomAuto ? ' escolhido sozinho' : '') + ').';
  if (x.instrumental) t += ' Use o instrumental em tom ' + sinal(x.tomInstrumental) + ': é o que afina com essa voz.';
  if (x.coro) t += ' O coro saiu em arquivo à parte, na pasta.';
  return t;
}

// Modo "só trocar a voz": baixar, separar o instrumental e passar o vocal original no Applio.
async function trocarSoVoz(o) {
  const voz = vozEscolhida();
  if (!voz) return setStatus('Escolha um modelo de voz em "Voz (Applio)".', true);
  // neste modo o fader da mesa é o tom da voz; em 0, com "tom sozinho" ligado, o app escolhe
  if (state.tom !== 0 || !voz.tomSozinho) { voz.pitch = state.tom; voz.tomSozinho = false; }
  cadeiaIniciar(['download', 'separar', 'voz']);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.soVoz({ url: o.url, file: o.file, start: o.ini, end: o.fim, preview: o.previa, voz });
  if (!r.ok) return terminar(r);
  cadeiaFechar('ok');
  setRodando(false);
  carregar(r.data);
  carregarRecentes();
  setStatus(resumoTroca(r.data, 0, voz.nome));
  atualizarMesa();
}

function terminar(r) {
  cadeiaFechar(r.cancelled ? 'cancelado' : 'erro');
  setRodando(false);
  atualizarMesa();
  if (r.cancelled) return setStatus('Parado.');
  setStatus(r.error.split('\n')[0], true);
  $('status').title = r.error;
  setRec(tituloRec(), r.error.split('\n')[0], 'falha');
}

// ---------- canais (tocador + forma de onda + medidor) ----------
const VU_N = 26;
const canais = [];
class Canal {
  constructor(root) {
    this.root = root;
    this.file = null;
    this.peaks = null;
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.play = root.querySelector('[data-play]');
    this.janela = root.querySelector('[data-janela]');
    this.svg = root.querySelector('.onda');
    this.tc = root.querySelector('[data-tc]');
    this.vu = root.querySelector('[data-vu]');
    if (this.vu) this.vu.replaceChildren(...Array.from({ length: VU_N }, () => el('i')));
    this.play.addEventListener('click', () => this.alternar());
    this.janela.addEventListener('click', (e) => {
      if (!this.file || !this.audio.duration) return;
      const r = this.janela.getBoundingClientRect();
      this.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.audio.duration;
      this.pintar();
    });
    // arrastar o arquivo para fora (ex.: soltar no Applio)
    this.janela.addEventListener('dragstart', (e) => { e.preventDefault(); if (this.file) api.arrastar(this.file); });
    this.audio.addEventListener('timeupdate', () => this.pintar());
    this.audio.addEventListener('loadedmetadata', () => this.pintar());
    this.audio.addEventListener('ended', () => { this.play.classList.remove('on'); this.audio.currentTime = 0; this.pintar(); });
    const salvar = root.querySelector('[data-salvar]');
    const pasta = root.querySelector('[data-pasta]');
    if (salvar) salvar.addEventListener('click', () => this.file && api.salvarCopia(this.file));
    if (pasta) pasta.addEventListener('click', () => this.file && api.mostrarNaPasta(this.file));
    canais.push(this);
  }
  async set(file) {
    this.audio.pause();
    this.play.classList.remove('on');
    this.file = file || null;
    this.peaks = null;
    this.env = null;      // volume em alta resolução, para a boca do cantor
    this.envTeto = 1;
    this.svg.replaceChildren();
    this.root.querySelectorAll('[data-play],[data-salvar],[data-pasta]').forEach((b) => (b.disabled = !file));
    this.janela.classList.toggle('viva', !!file);
    this.janela.draggable = !!file;
    this.tc.textContent = '--:--';
    this.pintarVu(0);
    if (!file) { this.audio.removeAttribute('src'); return; }
    this.audio.src = fileUrl(file);
    const p = await api.picos({ file, n: 150 });
    if (this.file !== file || !p) return;
    this.peaks = p.peaks;
    const n = p.peaks.length, H = 32;
    this.svg.setAttribute('viewBox', `0 0 ${n * 4} ${H}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');
    const max = Math.max(0.05, ...p.peaks);
    const ns = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    p.peaks.forEach((v, i) => {
      const h = Math.max(1.5, (v / max) * H);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', i * 4); r.setAttribute('y', (H - h) / 2);
      r.setAttribute('width', 3); r.setAttribute('height', h);
      frag.append(r);
    });
    this.svg.append(frag);
    this.tc.textContent = fmt(p.duration);
  }
  alternar() {
    if (!this.file) return;
    if (this.audio.paused) {
      canais.forEach((c) => { if (c !== this) { c.audio.pause(); c.play.classList.remove('on'); c.pintarVu(0); } });
      this.audio.play();
      this.carregarVolumeFino();
      this.play.classList.add('on');
    } else {
      this.audio.pause();
      this.play.classList.remove('on');
      this.pintarVu(0);
    }
  }
  pintar() {
    const d = this.audio.duration;
    if (!d || !isFinite(d)) return;
    const frac = this.audio.currentTime / d;
    const rects = this.svg.children;
    const ate = Math.floor(frac * rects.length);
    for (let i = 0; i < rects.length; i++) rects[i].classList.toggle('tocado', i < ate);
    this.tc.textContent = this.audio.currentTime > 0 ? `${fmt(this.audio.currentTime)} / ${fmt(d)}` : fmt(d);
    if (this.peaks && !this.audio.paused) {
      const i = Math.min(this.peaks.length - 1, ate);
      const max = Math.max(0.05, ...this.peaks);
      this.pintarVu(Math.max(this.peaks[i], this.peaks[Math.max(0, i - 1)]) / max);
    }
  }
  // Curva de volume com 20 pontos por segundo: é o que faz a boca do cantor acompanhar as sílabas.
  async carregarVolumeFino() {
    if (this.env || !this.file) return;
    const file = this.file;
    const dur = this.audio.duration || (this.peaks ? this.peaks.length : 30);
    const p = await api.picos({ file, n: Math.max(200, Math.min(6000, Math.round(dur * 20))) });
    if (!p || this.file !== file) return;
    this.env = p.peaks;
    // teto = volume que 90% dos pontos não passam; evita que um estalo isolado achate todo o resto
    const ord = [...p.peaks].sort((a, b) => a - b);
    this.envTeto = Math.max(0.03, ord[Math.floor(ord.length * 0.9)] || 0.03);
  }
  pintarVu(nivel) {
    if (!this.vu) return;
    const acesos = Math.round(nivel * VU_N);
    [...this.vu.children].forEach((s, i) => { s.className = i < acesos ? (i > 21 ? 'r' : i > 14 ? 'a' : 'v') : ''; });
  }
}
const canalCover = new Canal(document.querySelector('[data-canal="cover"]'));
const canalVocal = new Canal(document.querySelector('[data-canal="vocal"]'));
const canalInstr = new Canal(document.querySelector('[data-canal="instr"]'));
const canalVoz = new Canal(document.querySelector('[data-canal="voz"]'));

// canal avulso, para a aba "Separar vocal"
function novoCanal(nome) {
  const root = el('div', { class: 'canal' },
    el('div', { class: 'canal-cab' }, el('span', { class: 'canal-nome', text: nome }), el('span', { class: 'tc', 'data-tc': true, text: '--:--' })),
    el('div', { class: 'canal-corpo' },
      el('button', { class: 'play', 'data-play': true, 'aria-label': 'Tocar ' + nome }),
      el('div', { class: 'janela', 'data-janela': true })),
    el('div', { class: 'vu', 'data-vu': true }),
    el('div', { class: 'canal-acoes' },
      el('button', { class: 'tecla p', 'data-salvar': true, text: 'Salvar' }),
      el('button', { class: 'tecla p', 'data-pasta': true, text: 'Pasta' })));
  root.querySelector('.janela').append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  root.querySelector('svg').setAttribute('class', 'onda');
  return root;
}

// ---------- saída ----------
function stemsDe(meta, v) {
  if (meta.stemsList && meta.stemsList[v]) return meta.stemsList[v];
  return v === 0 ? meta.stems || null : null;
}
function carregar(meta) {
  state.carregada = meta;
  state.variacao = 0;
  atualizarSaida();
}
function atualizarSaida() {
  const m = state.carregada;
  $('btn-partitura').hidden = !(m && m.abc && sw('sw-partitura'));
  if (!m) return;
  $('saida-titulo').textContent = m.title || m.id || 'Gravação';
  document.querySelector('[data-canal="cover"] .canal-nome').textContent = m.kind === 'voz' ? 'Original' : 'Gravação';
  $('saida-sub').textContent = [m.style, m.duration ? fmt(m.duration) : null].filter(Boolean).join(' / ');
  $('saida-sub').title = m.style || '';
  $('lamp-saida').className = 'lamp' + (state.rodando ? ' pisca' : ' sinal');

  const covers = m.covers || [];
  const box = $('variacoes');
  box.hidden = covers.length < 2;
  box.replaceChildren(el('span', { class: 'etq', text: 'Variação' }));
  covers.forEach((_, i) => box.append(el('button', {
    class: 'tecla p' + (i === state.variacao ? ' on' : ''), text: String(i + 1),
    onclick: () => { state.variacao = i; atualizarSaida(); },
  })));

  const v = Math.min(state.variacao, Math.max(0, covers.length - 1));
  const st = stemsDe(m, v);
  if (canalCover.file !== (covers[v] || null)) canalCover.set(covers[v]);
  if (canalVocal.file !== (st ? st.vocals : null)) canalVocal.set(st && st.vocals);
  $('btn-separar-esta').hidden = !covers[v] || !!st;

  // vozes trocadas desta variação: uma por modelo. Os botões ao lado de "Voz final" escolhem qual aparece.
  const porModelo = [...new Map((m.vozes || []).filter((x) => x.variacao === v).map((x) => [x.modelo, x])).values()];
  const vistas = porModelo.map((x) => ({ id: x.modelo, rot: x.modelo, voz: x }));
  const vista = vistas.find((o) => o.id === state.vozVista) || vistas[0] || null;
  const voz = vista ? vista.voz : null;
  const ref = voz;                                             // de onde vêm instrumental e coro
  const arquivoVoz = voz ? voz.file : null;
  state.vozAtual = voz;
  $('voz-vistas').replaceChildren(...(vistas.length > 1 ? vistas.map((o) => el('button', {
    class: 'tecla p' + (o === vista ? ' on' : ''), text: o.rot,
    onclick: () => { state.vozVista = o.id; atualizarSaida(); },
  })) : []));

  // se a voz ficou fora da oitava, o instrumental que vale é o que foi levado para o tom dela
  const instr = ref && ref.instrumental ? ref.instrumental : (st ? st.instrumental : null);
  if (canalInstr.file !== instr) canalInstr.set(instr);
  $('instr-tom').textContent = ref && ref.instrumental ? 'tom ' + sinal(ref.tomInstrumental) : '';
  $('canal-voz').hidden = !vista;
  $('canais').classList.toggle('foco-voz', !!vista);
  const extras = [];
  if (voz) {
    for (const t of voz.tons && voz.tons.length > 1 ? voz.tons : []) extras.push(['tom ' + sinal(t.pitch), t.file, 'Versão inteira neste tom']);
    if (voz.extra && !(voz.tons || []).some((t) => t.file === voz.extra.file)) {
      extras.push(['tom ' + sinal(voz.extra.pitch), voz.extra.file, 'Faixa extra inteira neste tom']);
    }
    if (voz.coroVoz) extras.push(['coro ' + voz.modelo, voz.coroVoz, 'Coro e segunda voz, já na voz do modelo']);
    if (voz.coro) extras.push([voz.coroVoz ? 'coro original' : 'coro', voz.coro, 'Coro e segunda voz do cantor original']);
  }
  const btnFrases = frasesDe(voz).length
    ? el('button', { class: 'tecla p', text: 'Tons por frase', title: 'Ver e trocar o tom de cada frase', onclick: abrirFrases }) : null;
  // tudo que vai para a mixagem, de uma vez: voz, instrumental e coro
  const pacote = arquivoVoz ? [arquivoVoz, instr, ref && (ref.coroVoz || ref.coro)].filter(Boolean) : [];
  const btnTudo = pacote.length > 1 ? el('button', {
    class: 'tecla p extra', text: 'Arrastar tudo', draggable: 'true',
    title: 'Arraste para o FL Studio: ' + pacote.map(nomeArquivo).join(', '),
  }) : null;
  if (btnTudo) {
    btnTudo.addEventListener('dragstart', (e) => { e.preventDefault(); api.arrastar(pacote); });
    btnTudo.addEventListener('click', () => setStatus('Segure e arraste este botão para o FL Studio: vão ' + pacote.length + ' arquivos juntos.'));
  }
  $('voz-extras').replaceChildren(...[btnFrases, btnTudo].filter(Boolean), ...extras.map(([texto, file, dica]) => {
    const b = el('button', { class: 'tecla p extra', text: texto, title: dica + ': clique para ver na pasta, arraste para o FL Studio', draggable: 'true' });
    b.addEventListener('click', () => api.mostrarNaPasta(file));
    b.addEventListener('dragstart', (e) => { e.preventDefault(); api.arrastar(file); });
    return b;
  }));
  $('voz-modelo').textContent = !voz ? '' : (vistas.length > 1 ? '' : voz.modelo + ', ') + (voz.tons && voz.tons.length > 1 ? 'tons ' + voz.tons.map((t) => sinal(t.pitch)).join(' / ')
      : voz.pitch != null ? 'tom ' + sinal(voz.pitch) : '');
  if (canalVoz.file !== arquivoVoz) canalVoz.set(arquivoVoz);
  const escolhida = vozEscolhida();
  $('btn-trocar-voz').hidden = !st || !escolhida;
  if (escolhida) $('btn-trocar-voz').textContent = `Trocar a voz (${escolhida.nome})`;
  const midiFeito = state.midis[m.dir + '|' + v];
  $('btn-midi').hidden = !st || !st.vocals;
  $('btn-midi').textContent = midiFeito ? 'MIDI pronto (arraste)' : 'Melodia em MIDI';
  $('btn-midi').classList.toggle('extra', !!midiFeito);
  $('btn-midi').draggable = !!midiFeito;
}

// ---------- melodia e acordes em MIDI ----------
$('btn-midi').addEventListener('dragstart', (e) => {
  const m = state.carregada;
  const f = m && state.midis[m.dir + '|' + state.variacao];
  e.preventDefault();
  if (f) api.arrastar(f);
});
$('btn-midi').addEventListener('click', async () => {
  if (state.rodando) return setStatus('Espere o trabalho atual terminar.', true);
  const m = state.carregada;
  if (!m) return;
  const chave = m.dir + '|' + state.variacao;
  if (state.midis[chave]) return api.mostrarNaPasta(state.midis[chave]);
  state.modo = 'mesa';
  setRodando(true);
  setStatus('Lendo a melodia e os acordes… (leva cerca de meio minuto)');
  const r = await api.midi({ dir: m.dir, index: state.variacao });
  setRodando(false);
  atualizarMesa();
  if (!r.ok) return setStatus(r.error, true);
  state.midis[chave] = r.data.file;
  atualizarSaida();
  const ac = r.data.acordes ? r.data.acordes.split(' ') : [];
  setStatus('MIDI pronto: melodia e acordes' + (ac.length ? ' (começa com ' + ac.slice(0, 6).join(' – ') + ')' : '') + '. Arraste o botão para o FL Studio.');
});
// ---------- editor de frases: o tom de cada frase de uma voz ----------
// Cada frase mostra as opções. Clicar numa opção toca a frase nela (do arquivo inteiro que já está na
// pasta) e deixa escolhida; "Aplicar" refaz só a emenda.
// editor.opcoes: [{ valor, rot, file }]   editor.lista: [{ ini, fim, hz, atual }]
const editor = { tipo: 'tons', voz: null, antes: null, opcoes: [], lista: [], escolhas: [], audio: new Audio(), fim: 0 };
editor.audio.addEventListener('timeupdate', () => { if (editor.audio.currentTime >= editor.fim) editor.audio.pause(); });
// trocas antigas guardaram só os blocos (frases vizinhas já juntas): servem do mesmo jeito
const frasesDe = (voz) => (voz && voz.frases && voz.frases.length ? voz.frases : (voz && voz.blocos) || []);
function abrirFrases() {
  const voz = state.vozAtual;
  if (!frasesDe(voz).length) return;
  const base = voz.base != null ? voz.base : voz.pitch;
  const tons = voz.tons || [];
  editor.tipo = 'tons';
  editor.voz = voz;
  editor.antes = voz.file;
  editor.lista = frasesDe(voz).map((f) => ({ ini: f.ini, fim: f.fim, hz: f.hz, atual: f.pitch }));
  // opções: o tom pedido e uma oitava abaixo, mais qualquer outro que já esteja em uso
  editor.opcoes = [...new Set([base, base - 12, ...editor.lista.map((f) => f.atual)])].sort((a, b) => b - a)
    .map((tom) => ({ valor: tom, rot: sinal(tom), file: (tons.find((t) => t.pitch === tom) || {}).file || null }));
  $('fr-titulo').textContent = 'Tons por frase (' + voz.modelo + ')';
  $('fr-dica').textContent = 'Clique num tom para ouvir a frase nele e deixar escolhido. "Aplicar" refaz só a emenda, na hora.';
  abrirEditor();
}
function abrirEditor() {
  editor.escolhas = editor.lista.map((f) => f.atual);
  pintarEditor();
  $('dlg-frases').showModal();
}
function pintarEditor() {
  $('fr-lista').replaceChildren(...editor.lista.map((f, i) => el('div', { class: 'frase' },
    el('span', { class: 'mono', text: fmt(f.ini) + ' – ' + fmt(f.fim) }),
    el('span', { class: 'fraco', text: f.hz ? Math.round(f.hz) + ' Hz' : '' }),
    el('span', { class: 'frase-tons' }, ...editor.opcoes.map((o) => el('button', {
      class: 'tecla p' + (editor.escolhas[i] === o.valor ? ' on' : ''), text: o.rot,
      title: o.file ? 'Ouvir a frase assim e escolher' : 'Ainda não há versão neste tom: ela é convertida ao aplicar',
      onclick: () => { editor.escolhas[i] = o.valor; tocarFrase(f, o); pintarEditor(); },
    }))),
  )));
  const mudou = editor.lista.filter((f, i) => f.atual !== editor.escolhas[i]).length;
  const falta = editor.escolhas.some((valor) => !(editor.opcoes.find((o) => o.valor === valor) || {}).file);
  $('fr-aplicar').disabled = !mudou;
  $('fr-aviso').textContent = !mudou ? 'nada mudou' : mudou + (mudou === 1 ? ' frase mudou' : ' frases mudaram') + (falta ? '; falta converter um tom (demora mais)' : '');
}
function tocarFrase(f, o) {
  editor.audio.pause();
  if (!o.file) return;
  canais.forEach((c) => { c.audio.pause(); c.play.classList.remove('on'); c.pintarVu(0); });
  const url = fileUrl(o.file);
  const ir = () => { editor.audio.currentTime = Math.max(0, f.ini - 0.15); editor.fim = f.fim + 0.2; editor.audio.play(); };
  if (editor.audio.dataset.url !== url) {
    editor.audio.dataset.url = url;
    editor.audio.src = url;
    editor.audio.addEventListener('loadedmetadata', ir, { once: true });
  } else ir();
}
$('fr-parar').addEventListener('click', () => editor.audio.pause());
$('dlg-frases').addEventListener('close', () => editor.audio.pause());
$('fr-aplicar').addEventListener('click', async () => {
  if (state.rodando) return setStatus('Espere a gravação atual terminar.', true);
  const m = state.carregada;
  const v = state.variacao;
  editor.audio.pause();
  editor.audio.removeAttribute('src');
  delete editor.audio.dataset.url;
  $('dlg-frases').close();
  canalVoz.set(null);   // solta o arquivo antes de regravar por cima
  cadeiaIniciar(['voz']);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.reemendar({ dir: m.dir, index: v, escolhas: editor.escolhas, voz: vozEscolhida(), modelo: editor.voz.modelo });
  if (!r.ok) { atualizarSaida(); return terminar(r); }
  cadeiaFechar('ok');
  setRodando(false);
  state.carregada = r.data;
  state.variacao = v;
  atualizarSaida();
  atualizarMesa();
  const agora = (state.vozAtual || {}).file;
  setStatus(agora && agora !== editor.antes
    ? 'Emenda refeita. O arquivo antigo estava aberto em outro programa (FL Studio?), então a nova saiu ao lado: ' + nomeArquivo(agora)
    : 'Emenda refeita com o que você escolheu.');
});

$('btn-trocar-voz').addEventListener('click', async () => {
  if (state.rodando) return setStatus('Espere a gravação atual terminar.', true);
  const voz = vozEscolhida();
  if (!voz) return setStatus('Escolha um modelo de voz em Ajustes.', true);
  const m = state.carregada;
  const v = state.variacao;
  cadeiaIniciar(['voz']);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.trocarVoz({ dir: m.dir, index: v, voz });
  if (!r.ok) return terminar(r);
  cadeiaFechar('ok');
  setRodando(false);
  state.carregada = r.data;
  state.variacao = v;
  atualizarSaida();
  atualizarMesa();
  setStatus(resumoTroca(r.data, v, voz.nome));
});
$('btn-separar-esta').addEventListener('click', async () => {
  if (state.rodando) return setStatus('Espere a gravação atual terminar.', true);
  const m = state.carregada;
  cadeiaIniciar(['separar']);
  state.modo = 'mesa';
  setRodando(true);
  const r = await api.separarVariacao({ dir: m.dir, index: state.variacao });
  if (!r.ok) return terminar(r);
  cadeiaFechar('ok');
  setRodando(false);
  const v = state.variacao;
  state.carregada = r.data;
  state.variacao = v;
  atualizarSaida();
  atualizarMesa();
  setStatus('Vocal e instrumental separados.');
});

// ---------- partitura ----------
function desenharPartitura(abc) {
  const alvo = $('pt-folha');
  alvo.replaceChildren();
  try { ABCJS.renderAbc(alvo, abc, { responsive: 'resize', staffwidth: 820 }); }
  catch { alvo.textContent = 'Não consegui desenhar esta partitura. O texto ABC continua válido.'; }
}
// de onde veio a partitura aberta: 'carregada' (gravação na Saída) ou 'plano' (modo Criar)
let partituraDe = 'carregada';
function abrirPartitura(origem) {
  partituraDe = origem;
  const abc = origem === 'plano' ? state.plano && state.plano.abc : state.carregada && state.carregada.abc;
  if (!abc) return setStatus('Não há partitura para mostrar.', true);
  $('pt-abc').value = abc;
  $('pt-usar').textContent = origem === 'plano' ? 'Gravar com esta partitura' : 'Usar esta partitura na próxima gravação';
  $('dlg-partitura').showModal();
  desenharPartitura(abc);
}
$('btn-partitura').addEventListener('click', () => abrirPartitura('carregada'));
$('btn-planejar').addEventListener('click', planejarPartitura);
$('pt-desenhar').addEventListener('click', () => desenharPartitura($('pt-abc').value));
$('pt-salvar').addEventListener('click', () => {
  const dir = partituraDe === 'plano' ? state.plano && state.plano.meta.dir : state.carregada && state.carregada.dir;
  if (dir) api.salvarCopia(dir + '\\partitura.abc');
});
$('pt-usar').addEventListener('click', () => {
  const abc = $('pt-abc').value;
  if (partituraDe === 'plano') {
    if (!state.plano) return;
    state.plano.abc = abc;
    $('dlg-partitura').close();
    return $('btn-rec').click();
  }
  if (!state.analise) return setStatus('Carregue a música na mesa antes de usar uma partitura editada.', true);
  state.abcEditado = { key: state.analise.key, abc };
  $('dlg-partitura').close();
  setStatus('Partitura editada será usada na próxima gravação desta música.');
});

// ---------- recentes e histórico ----------
const prontas = (items) => items.filter((m) => m.status === 'pronto' && m.covers && m.covers.length);

async function carregarRecentes() {
  const items = prontas(await api.historico()).slice(0, 3);
  const box = $('recentes');
  box.replaceChildren();
  if (!items.length) return;
  box.append(el('span', { class: 'etq', text: 'Recentes' }));
  for (const m of items) {
    box.append(el('button', { class: 'fita', text: m.title || m.id, title: `${m.title || ''}\n${m.style || ''}`, onclick: () => { irPara('mesa'); carregar(m); } }));
  }
}

function dataDe(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id || '');
  return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : '';
}
async function carregarHistorico() {
  const items = await api.historico();
  const box = $('hist-lista');
  box.replaceChildren();
  if (!items.length) return box.append(el('div', { class: 'vazio', text: 'Nenhuma gravação ainda.' }));
  for (const m of items) {
    const pronta = m.status === 'pronto' && m.covers && m.covers.length;
    const lamp = pronta ? 'sinal' : m.status === 'erro' ? 'erro' : '';
    const rotulo = m.kind === 'karaoke' ? (m.status === 'pronto' ? 'karaokê' : m.status === 'erro' ? 'falhou' : 'parada')
      : m.kind === 'separacao' ? 'separação de vocal'
      : m.kind === 'fala' ? m.style || 'fala' : m.status === 'planejado' ? 'só a partitura' : m.kind === 'voz' && pronta ? 'troca de ' + m.style : pronta ? m.style : m.status === 'erro' ? 'falhou' : m.status === 'cancelado' ? 'parada' : 'só analisada';
    const acoes = el('div', { class: 'fita-acoes' });
    if (m.kind === 'karaoke' && m.status === 'pronto') acoes.append(el('button', { class: 'tecla p', text: 'Cantar', onclick: () => api.karaokeJanela(m.dir) }));
    if (pronta) acoes.append(el('button', { class: 'tecla p', text: 'Ouvir na mesa', onclick: () => { irPara('mesa'); carregar(m); } }));
    if (m.abc && m.source) acoes.append(el('button', { class: 'tecla p', text: 'Regravar', onclick: () => regravar(m) }));
    acoes.append(
      el('button', { class: 'tecla p', text: 'Pasta', onclick: () => api.mostrarNaPasta(m.dir) }),
      el('button', { class: 'tecla p', text: 'Lixeira', onclick: async () => { await api.apagarItem(m.dir); carregarHistorico(); carregarRecentes(); } }));
    box.append(el('div', { class: 'fita-linha' },
      el('div', { class: 'fita-topo' },
        el('span', { class: 'lamp ' + lamp }),
        el('span', { class: 'fita-titulo', text: m.title || m.id }),
        el('span', { class: 'tc', text: dataDe(m.id) })),
      el('div', { class: 'fita-meta', text: [rotulo, m.duration ? fmt(m.duration) : null].filter(Boolean).join(' / ') }),
      m.error && !pronta ? el('div', { class: 'erro', text: m.error.split('\n')[0] }) : null,
      acoes));
  }
}
// Põe a música de volta na mesa, reaproveitando a análise (não baixa de novo).
function regravar(m) {
  if (state.rodando) return setStatus('Espere a gravação atual terminar.', true);
  const link = /^https?:/i.test(m.source);
  setArquivo(link ? null : m.source);
  if (link) $('in-url').value = m.source;
  $('in-ini').value = m.start ? fmt(m.start) : '';
  $('in-fim').value = m.end != null ? fmt(m.end) : '';
  $('sw-previa').setAttribute('aria-checked', 'false');
  setTom(m.semitones || 0);
  $('in-letra').value = m.lyrics || '';
  state.letraDe = origemId();
  $('letra-nota').textContent = 'da gravação anterior';
  if (m.style) {
    $('in-estilo').value = m.style;
    state.voz = '';
    document.querySelectorAll('.voz').forEach((x) => x.classList.toggle('on', x.dataset.voz === ''));
  }
  try { state.analise = { key: chaveDe(lerMesa()), meta: m }; } catch { state.analise = null; }
  state.abcEditado = null;
  irPara('mesa');
  atualizarMesa();
  setStatus('Música de volta na mesa. Mude a voz ou o estilo e aperte Gravar.');
}
$('btn-pasta-saida').addEventListener('click', () => api.abrirPastaSaida());

// ---------- separar vocal (avulso) ----------
let sepArquivo = null;
let sepModo = 'vocal';
document.querySelectorAll('#sep-modo [data-sep]').forEach((b) => b.addEventListener('click', () => {
  if (state.rodando) return;
  sepModo = b.dataset.sep;
  document.querySelectorAll('#sep-modo [data-sep]').forEach((x) => x.classList.toggle('on', x === b));
}));
$('btn-sep-arquivo').addEventListener('click', async () => {
  const p = await api.escolherAudio();
  if (!p) return;
  sepArquivo = p;
  $('sep-arquivo').textContent = nomeArquivo(p);
  $('btn-sep-ir').disabled = false;
});
$('btn-sep-parar').addEventListener('click', () => api.cancelar());
$('btn-sep-ir').addEventListener('click', async () => {
  if (state.rodando) { $('sep-erro').hidden = false; $('sep-erro').textContent = 'Espere a gravação atual terminar.'; return; }
  $('sep-erro').hidden = true;
  $('sep-canais').replaceChildren();
  $('sep-barra').hidden = false;
  $('sep-barra').firstElementChild.style.width = '0%';
  $('btn-sep-ir').disabled = true;
  $('btn-sep-parar').hidden = false;
  $('lamp-sep').className = 'lamp pisca';
  state.modo = 'sep';
  state.rodando = true;
  const porInstrumento = sepModo === 'instrumentos';
  const r = porInstrumento ? await api.separarInstrumentos(sepArquivo) : await api.separarArquivo(sepArquivo);
  state.rodando = false;
  state.modo = 'mesa';
  $('btn-sep-ir').disabled = false;
  $('btn-sep-parar').hidden = true;
  $('sep-barra').hidden = true;
  $('sep-msg').textContent = '';
  if (!r.ok) {
    $('lamp-sep').className = 'lamp' + (r.cancelled ? '' : ' erro');
    $('sep-erro').hidden = false;
    $('sep-erro').textContent = r.cancelled ? 'Parado.' : r.error;
    return;
  }
  $('lamp-sep').className = 'lamp sinal';
  const faixas = porInstrumento ? r.data.faixas.map((f) => [f.nome, f.file])
    : [['Vocal', r.data.stems.vocals], ['Instrumental', r.data.stems.instrumental]];
  if (porInstrumento) {
    const tudo = el('button', { class: 'tecla p extra', text: 'Arrastar todas as faixas', draggable: 'true',
      title: 'Segure e arraste para o FL Studio: vão as ' + faixas.length + ' faixas juntas' });
    tudo.addEventListener('dragstart', (e) => { e.preventDefault(); api.arrastar(faixas.map(([, f]) => f)); });
    tudo.addEventListener('click', () => api.mostrarNaPasta(faixas[0][1]));
    $('sep-canais').append(el('div', { class: 'linha', style: 'margin:10px 0' }, tudo));
  }
  for (const [nome, file] of faixas) {
    const root = novoCanal(nome);
    $('sep-canais').append(root);
    new Canal(root).set(file);
  }
});

// ---------- fala (texto -> voz) ----------
let falaPronta = false;
function atualizarFala() {
  const conv = sw('fl-converter');
  const clone = $('fl-leitor').value === 'clone';
  const v = vozEscolhida();
  $('fl-modelo').value = v ? v.nome : 'nenhum: escolha em Ajustes, Voz (Applio)';
  $('fl-modelo-rot').classList.toggle('fora-de-uso', !conv);
  $('fl-tom-linha').classList.toggle('desligada', !conv);
  $('fl-tom').disabled = !conv;
  // voz clonada: idioma, gravação de referência e emoção; voz pronta: a lista de vozes do leitor
  $('fl-base-rot').hidden = clone;
  $('fl-lingua-rot').hidden = !clone;
  $('fl-ref-linha').hidden = !clone;
  $('fl-emocao-linha').hidden = !clone;
  const ref = state.config && state.config.falaReferencia;
  $('fl-ref').value = ref ? nomeArquivo(ref)
    : state.temReferenciaPadrao ? 'padrão: a gravação que veio com o app' : 'nenhuma: clique em Gravar (ou Trocar… para escolher um arquivo)';
  $('fl-ref-padrao').disabled = !ref;
}
async function prepararFala() {
  const c = state.config || {};
  if (!falaPronta) {
    if (c.falaLeitor) $('fl-leitor').value = c.falaLeitor;
    if (c.falaLingua) $('fl-lingua').value = c.falaLingua;
    if (c.falaEmocao) { $('fl-emocao').value = c.falaEmocao; $('fl-emocao-v').textContent = c.falaEmocao; }
  }
  atualizarFala();
  if (falaPronta) return;
  $('fl-msg').textContent = 'Carregando as vozes…';
  const vozes = await api.ttsVozes();
  $('fl-msg').textContent = vozes.length ? '' : 'Não consegui carregar as vozes do leitor.';
  if (!vozes.length) return;
  // português primeiro, depois os outros idiomas
  vozes.sort((a, b) => (a.idioma === 'Português' ? 0 : 1) - (b.idioma === 'Português' ? 0 : 1) || a.idioma.localeCompare(b.idioma) || a.id.localeCompare(b.id));
  $('fl-base').replaceChildren(...vozes.map((x) => el('option', { value: x.id, text: x.idioma + ': ' + x.apelido + (x.genero ? ' (' + x.genero + ')' : '') })));
  const guardada = state.config && state.config.falaVoz;
  $('fl-base').value = vozes.some((x) => x.id === guardada) ? guardada : vozes[0].id;
  falaPronta = true;
}
$('fl-velocidade').addEventListener('input', () => { const n = Number($('fl-velocidade').value); $('fl-velocidade-v').textContent = (n > 0 ? '+' : '') + n + '%'; });
$('fl-tom').addEventListener('input', () => { $('fl-tom-v').textContent = sinal(Number($('fl-tom').value)); });
$('fl-base').addEventListener('change', () => api.configSalvar({ falaVoz: $('fl-base').value }));
// guarda também no state.config: a tela relê dali ao voltar para a aba
const guardarFala = (parte) => { state.config = { ...(state.config || {}), ...parte }; api.configSalvar(parte); };
$('fl-leitor').addEventListener('change', () => { guardarFala({ falaLeitor: $('fl-leitor').value }); atualizarFala(); });
$('fl-lingua').addEventListener('change', () => guardarFala({ falaLingua: $('fl-lingua').value }));
$('fl-emocao').addEventListener('input', () => { $('fl-emocao-v').textContent = $('fl-emocao').value; });
$('fl-emocao').addEventListener('change', () => guardarFala({ falaEmocao: Number($('fl-emocao').value) }));
$('fl-ref-trocar').addEventListener('click', async () => {
  const f = await api.escolherAudio('Gravação da sua voz (5 a 20 segundos)');
  if (!f) return;
  guardarFala({ falaReferencia: f });
  atualizarFala();
});
$('fl-ref-padrao').addEventListener('click', () => { guardarFala({ falaReferencia: null }); atualizarFala(); });

// Gravar a referência direto no microfone: até 20 s, sem os filtros do navegador (eles mudam o timbre).
const ROTEIRO = {
  en: 'Leia em voz alta, do seu jeito normal: "Hey, what\'s up everyone? Today I want to show you something I\'ve been working on for a while. It\'s not perfect yet, but honestly, I think you\'re going to love it. Let me know what you think!"',
  pt: 'Leia em voz alta, do seu jeito normal: "E aí, pessoal, tudo certo? Hoje eu quero mostrar uma coisa que eu tô fazendo faz um tempo. Ainda não tá perfeita, mas sinceramente, acho que vocês vão curtir. Me falem o que acharam!"',
};
const gravacao = { rec: null, partes: [], inicio: 0, timer: null };
function pararGravacaoRef() {
  if (gravacao.rec && gravacao.rec.state !== 'inactive') gravacao.rec.stop();
}
$('fl-ref-gravar').addEventListener('click', async () => {
  if (gravacao.rec && gravacao.rec.state === 'recording') return pararGravacaoRef();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  } catch (e) {
    return setStatus('Não consegui usar o microfone: ' + e.message + '. Confira em Configurações do Windows > Privacidade > Microfone.', true);
  }
  gravacao.partes = [];
  gravacao.rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  gravacao.rec.ondataavailable = (e) => { if (e.data.size) gravacao.partes.push(e.data); };
  gravacao.rec.onstop = async () => {
    clearInterval(gravacao.timer);
    stream.getTracks().forEach((t) => t.stop());
    $('fl-ref-gravar').textContent = '● Gravar';
    $('fl-ref-roteiro').hidden = true;
    const seg = (Date.now() - gravacao.inicio) / 1000;
    if (seg < 4) return setStatus('Gravação curta demais: fale pelo menos 5 segundos.', true);
    setStatus('Guardando a gravação…');
    const dados = await new Blob(gravacao.partes, { type: 'audio/webm' }).arrayBuffer();
    const r = await api.salvarGravacao(dados);
    if (!r.ok) return setStatus('Não consegui guardar a gravação: ' + r.error, true);
    guardarFala({ falaReferencia: r.file });
    atualizarFala();
    setStatus(`Gravação de ${Math.round(seg)} s guardada. Ela passa a ser a sua voz na fala clonada.`);
  };
  const lingua = $('fl-lingua').value === 'pt' ? 'pt' : 'en';
  $('fl-ref-roteiro').textContent = ROTEIRO[lingua];
  $('fl-ref-roteiro').hidden = false;
  gravacao.inicio = Date.now();
  gravacao.rec.start(250);
  const tique = () => {
    const s = Math.floor((Date.now() - gravacao.inicio) / 1000);
    $('fl-ref-gravar').textContent = `■ Parar (${s}s)`;
    if (s >= 20) pararGravacaoRef();
  };
  tique();
  gravacao.timer = setInterval(tique, 250);
});
const ouvirRef = new Audio();
$('fl-ref-ouvir').addEventListener('click', () => {
  const ref = (state.config && state.config.falaReferencia) || (state.temReferenciaPadrao ? state.referenciaPadrao : null);
  if (!ref) return setStatus('Ainda não tem gravação: clique em Gravar.', true);
  if (!ouvirRef.paused) { ouvirRef.pause(); return; }
  ouvirRef.src = fileUrl(ref);
  ouvirRef.play();
});
$('fl-converter').addEventListener('click', () => setTimeout(atualizarFala, 0));
$('btn-falar-parar').addEventListener('click', () => api.cancelar());
$('btn-falar').addEventListener('click', async () => {
  const erro = (t) => { $('fl-erro').hidden = !t; $('fl-erro').textContent = t || ''; };
  erro('');
  if (state.rodando) return erro('Espere o trabalho atual terminar.');
  const texto = $('fl-texto').value.trim();
  if (!texto) return erro('Escreva o texto.');
  const converter = sw('fl-converter');
  const voz = converter ? vozEscolhida() : null;
  if (converter && !voz) return erro('Escolha um modelo de voz em Ajustes, "Voz (Applio)".');
  if (voz) voz.pitch = Number($('fl-tom').value);
  state.modo = 'fala';
  state.rodando = true;
  $('btn-falar').disabled = true;
  $('btn-falar-parar').hidden = false;
  $('lamp-fala').className = 'lamp pisca';
  $('fl-msg').textContent = 'Começando…';
  const r = await api.falar({
    texto, leitor: $('fl-leitor').value, vozBase: $('fl-base').value,
    referencia: (state.config && state.config.falaReferencia) || null,
    lingua: $('fl-lingua').value, emocao: Number($('fl-emocao').value) / 100,
    velocidade: Number($('fl-velocidade').value), converter, voz,
  });
  state.rodando = false;
  state.modo = 'mesa';
  $('btn-falar').disabled = false;
  $('btn-falar-parar').hidden = true;
  $('fl-msg').textContent = '';
  if (!r.ok) {
    $('lamp-fala').className = 'lamp' + (r.cancelled ? '' : ' erro');
    return erro(r.cancelled ? 'Parado.' : r.error);
  }
  $('lamp-fala').className = 'lamp sinal';
  const root = novoCanal(r.data.style || 'Fala');
  $('fl-canais').prepend(root);
  new Canal(root).set(r.data.covers[0]);
  carregarRecentes();
});

// ---------- instalar as funções ----------
const inst = { rodando: false, situacao: {}, itens: [] };
const NOMES_BACKEND = { cu128: 'na placa NVIDIA', cu126: 'na placa NVIDIA', rocm: 'na placa AMD', vulkan: 'na placa (Vulkan)', cpu: 'no processador' };

async function carregarInstalar() {
  const d = await api.componentesEstado();
  inst.itens = d.itens;
  const gpu = d.placa.backend !== 'cpu';
  $('inst-lamp').className = 'lamp ' + (gpu ? 'sinal' : 'on');
  $('inst-placa-nome').textContent = d.placa.nome + (d.placa.vramGB ? ` (${d.placa.vramGB} GB)` : '');
  $('inst-placa-modo').textContent = 'As IAs vão rodar: ' + d.placa.modo;
  desenharInstalar();
  return d;
}

function desenharInstalar() {
  const lista = $('inst-lista');
  lista.replaceChildren();
  for (const c of inst.itens) {
    const sit = inst.situacao[c.id];
    const rodandoEste = sit && sit.rodando;
    let texto = c.instalado ? 'Instalado' + (c.backend ? ', roda ' + (NOMES_BACKEND[c.backend] || c.backend) : '') : 'Não instalado';
    let classe = '';
    if (sit && sit.texto) { texto = sit.texto; classe = sit.classe || ''; }
    else if (!c.instalado && c.lento) { texto += ' · sem placa compatível isto fica MUITO lento (minutos por frase)'; classe = 'aviso'; }
    lista.append(el('div', { class: 'inst-item' },
      el('span', { class: 'lamp ' + (rodandoEste ? 'pisca' : c.instalado ? 'sinal' : '') }),
      el('div', { class: 'inst-nome' }, el('b', { text: c.nome }), el('span', { text: c.tamanho })),
      el('button', { class: 'tecla p', text: c.instalado ? 'Reinstalar' : 'Instalar', disabled: inst.rodando,
        onclick: () => rodarInstalacao([c.id]) }),
      el('div', { class: 'inst-desc', text: c.desc }),
      el('div', { class: 'inst-sit ' + classe, text: texto })));
  }
  $('inst-tudo').disabled = inst.rodando || inst.itens.every((c) => c.instalado);
  $('inst-cancelar').hidden = !inst.rodando;
}

async function rodarInstalacao(ids) {
  if (inst.rodando || !ids.length) return;
  inst.rodando = true;
  for (const id of ids) inst.situacao[id] = { texto: 'Na fila…' };
  const reg = $('inst-registro');
  reg.hidden = false;
  reg.textContent = '';
  desenharInstalar();
  const r = await api.componentesInstalar(ids);
  inst.rodando = false;
  if (!r.ok) setStatus(r.error, true);
  await carregarInstalar();
}

api.onComponentes((ev) => {
  const reg = $('inst-registro');
  if (ev.linha) {
    reg.textContent += ev.linha + '\n';
    if (reg.textContent.length > 60000) reg.textContent = reg.textContent.slice(-40000);
    reg.scrollTop = reg.scrollHeight;
    inst.situacao[ev.id] = { rodando: true, texto: ev.linha.slice(0, 140) };
  } else if (ev.fim === 'ok') {
    inst.situacao[ev.id] = { texto: 'Pronto! Roda ' + (NOMES_BACKEND[ev.backend] || ev.backend) + '.' };
    setStatus('Instalado: ' + (inst.itens.find((c) => c.id === ev.id) || {}).nome);
  } else if (ev.fim) {
    inst.situacao[ev.id] = { texto: ev.fim === 'cancelado' ? 'Cancelado. Clique em Instalar para continuar de onde parou.'
      : 'Deu erro. Tente de novo (ele continua de onde parou).\n' + (ev.erro || ''), classe: 'falha' };
  }
  desenharInstalar();
});

$('inst-tudo').addEventListener('click', () => {
  const faltam = inst.itens.filter((c) => !c.instalado && !c.lento).map((c) => c.id);
  rodarInstalacao(faltam.length ? faltam : inst.itens.filter((c) => !c.instalado).map((c) => c.id));
});
$('inst-cancelar').addEventListener('click', () => api.componentesCancelar());

// ---------- atualização ----------
async function verificarAtualizacao(avisar) {
  $('att-texto').textContent = 'Procurando…';
  const r = await api.atualizacaoVerificar();
  $('att-instalar').hidden = true;
  if (!r.ok) { $('att-texto').textContent = `Versão ${r.atual}. Não consegui ver se tem nova (${r.error}).`; return; }
  if (!r.temNova) { $('att-texto').textContent = `Versão ${r.atual}: é a mais nova.`; return; }
  if (r.desenvolvimento) {
    $('att-texto').textContent = `Versão ${r.atual}. Saiu a ${r.nova}, mas esta é a cópia de desenvolvimento: atualize pelo Git.`;
    return;
  }
  $('att-texto').textContent = `Versão ${r.atual}. Saiu a ${r.nova}` + (r.tamanho ? ` (${Math.round(r.tamanho / 1048576)} MB)` : '')
    + '. As IAs instaladas, os ajustes e as músicas continuam como estão.';
  $('att-instalar').hidden = !r.url;
  if (avisar) setStatus(`Saiu a versão ${r.nova} do Haze: atualize na aba Instalar.`);
}
$('att-procurar').addEventListener('click', () => verificarAtualizacao(false));
$('att-instalar').addEventListener('click', async () => {
  if (state.rodando) return setStatus('Espere o trabalho atual terminar.', true);
  $('att-instalar').disabled = true;
  $('att-procurar').disabled = true;
  const r = await api.atualizacaoInstalar();
  if (!r.ok) {
    $('att-instalar').disabled = false;
    $('att-procurar').disabled = false;
    $('att-texto').textContent = 'Não deu para atualizar: ' + r.error;
  }
});
api.onAtualizacao((texto) => { $('att-texto').textContent = texto; setStatus(texto); });
// confere sozinho uns segundos depois de abrir (sem atrapalhar se estiver sem internet)
setTimeout(() => verificarAtualizacao(true).catch(() => {}), 6000);

// ---------- relatório de erro ----------
document.querySelectorAll('[data-relatorio]').forEach((b) => b.addEventListener('click', async () => {
  const r = await api.relatorio();
  setStatus(r.ok ? 'Relatório copiado. Cole (Ctrl+V) numa mensagem para quem vai te ajudar.' : 'Não consegui montar o relatório.', !r.ok);
}));

// Primeira vez num PC novo: nada instalado -> abre a aba Instalar.
async function verificarPrimeiraVez() {
  try {
    const d = await carregarInstalar();
    if (!d.itens.some((c) => c.instalado)) irPara('instalar');
  } catch {}
}
verificarPrimeiraVez();

// ---------- diagnóstico ----------
async function rodarDiagnostico() {
  const out = $('diag-saida');
  out.replaceChildren(el('div', { class: 'vazio', text: 'Verificando…' }));
  const d = await api.diagnostico();
  out.replaceChildren();
  for (const c of d.checks) {
    out.append(el('div', { class: 'd-linha' },
      el('span', { class: 'lamp ' + (c.ok ? 'sinal' : 'erro') }),
      el('span', { class: 'd-nome', text: c.nome }),
      el('span', { class: 'd-det', text: c.ok ? c.detalhe : 'faltando: ' + c.detalhe })));
  }
  out.append(el('div', { class: 'd-linha' },
    el('span', { class: 'lamp ' + (d.gpus.length ? 'sinal' : 'erro') }),
    el('span', { class: 'd-nome', text: 'Placa de vídeo' }),
    el('span', { class: 'd-det', text: d.vram || d.gpus.join(', ') || 'não detectada' })));
  out.append(el('div', { class: 'd-linha' },
    el('span', { class: 'lamp' }),
    el('span', { class: 'd-nome', text: 'Limite por gravação' }),
    el('span', { class: 'd-det', text: `${fmt(d.limiteSegundos)} de música. Pasta: ${d.pastaSaida}` })));
}
$('btn-diag').addEventListener('click', rodarDiagnostico);

// ---------- espaço em disco ----------
const gb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1).replace('.', ',') + ' GB' : Math.round(b / 1048576) + ' MB');
async function medirDisco() {
  const d = await api.trabalhoMedir();
  $('disco-texto').textContent = d.pastas
    ? `Arquivos de trabalho: ${gb(d.bytes)} em ${d.pastas} ${d.pastas === 1 ? 'música' : 'músicas'}. Com mais de 7 dias: ${gb(d.bytesAntigas)} em ${d.antigas}.`
    : 'Nenhum arquivo de trabalho guardado.';
  $('btn-limpar-antigos').disabled = !d.antigas;
  $('btn-limpar-todos').disabled = !d.pastas;
}
async function limparDisco(dias) {
  $('disco-texto').textContent = 'Mandando para a Lixeira…';
  const r = await api.trabalhoLimpar({ dias });
  await medirDisco();
  if (!r.ok) return setStatus(r.error, true);
  setStatus(r.pastas ? `${gb(r.bytes)} de ${r.pastas} ${r.pastas === 1 ? 'música foi' : 'músicas foram'} para a Lixeira. Esvazie a Lixeira para liberar o espaço.` : 'Nada para limpar.');
}
$('btn-limpar-antigos').addEventListener('click', () => limparDisco(7));
$('btn-limpar-todos').addEventListener('click', () => limparDisco(0));
document.querySelector('.aba[data-tab="diag"]').addEventListener('click', medirDisco);
$('btn-ytdlp').addEventListener('click', async () => {
  const pre = $('ytdlp-saida');
  pre.hidden = false;
  pre.textContent = 'Atualizando…';
  const r = await api.atualizarYtdlp();
  pre.textContent = (r.ok ? 'Feito.\n' : 'Não deu certo.\n') + r.texto;
});

// ---------- pedir letra (sem API) ----------
// Monta um pedido completo para colar no Claude ou no ChatGPT e recebe a letra de volta.
function pedidoDeLetra() {
  const dur = parseTime($('lt-duracao').value);
  const seg = dur && !Number.isNaN(dur) ? Math.min(dur, state.limite) : 120;
  const secoes = Math.max(2, Math.min(14, Math.round(seg / 22)));
  const estilo = [state.voz, $('in-estilo').value.trim()].filter(Boolean).join(', ');
  const linhas = [
    'Escreva a letra de uma música.',
    '',
    'Tema: ' + ($('lt-tema').value.trim() || '(livre)'),
    'Idioma da letra: ' + $('lt-idioma').value,
  ];
  if ($('lt-clima').value.trim()) linhas.push('Clima: ' + $('lt-clima').value.trim());
  if (estilo) linhas.push('Estilo musical (para dar o ritmo dos versos): ' + estilo);
  linhas.push(
    'Tamanho: música de cerca de ' + fmt(seg) + ', então ' + secoes + ' seções no total.',
    '',
    'Formato obrigatório, porque a letra vai direto para um programa:',
    '- Cada seção começa com uma marcação sozinha na linha, em inglês e entre colchetes: [verse], [chorus], [bridge] ou [outro].',
    '- De 4 a 6 versos por seção, um verso por linha, cada verso com no máximo 10 palavras.',
    '- O refrão ([chorus]) aparece pelo menos duas vezes, com o texto idêntico.',
    '- Uma linha em branco entre as seções.',
    '- Sem título, sem acordes, sem explicação antes ou depois. Responda só com a letra.',
  );
  return linhas.join('\n');
}
// Limpa o que costuma vir junto: cercas de código, título, marcações em outro formato.
function arrumarLetra(texto) {
  const mapa = { verso: 'verse', estrofe: 'verse', refrao: 'chorus', 'refrão': 'chorus', coro: 'chorus', ponte: 'bridge', final: 'outro', intro: 'intro', introducao: 'intro', 'introdução': 'intro' };
  return texto.replace(/\r/g, '').split('\n')
    .filter((l) => !/^\s*```/.test(l))
    .map((l) => l.trim().replace(/^\*\*(.*)\*\*$/, '$1'))
    .map((l) => {
      const m = /^[\[(]\s*([^\])]+?)\s*[\])]\s*:?$/.exec(l) || /^(verso|estrofe|refr[aã]o|coro|ponte|verse|chorus|bridge|outro|intro)\s*\d*\s*:$/i.exec(l);
      if (!m) return l;
      const nome = m[1].toLowerCase().replace(/\s*\d+$/, '').trim();
      return '[' + (mapa[nome] || nome) + ']';
    })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
$('btn-pedir-letra').addEventListener('click', () => {
  const o = (() => { try { return lerMesa(); } catch { return null; } })();
  const dur = o ? duracaoPrevista(o) : null;
  if (dur) $('lt-duracao').value = fmt(dur);
  $('lt-aviso').textContent = '';
  $('lt-previa').textContent = pedidoDeLetra();
  $('dlg-letra').showModal();
});
['lt-tema', 'lt-clima', 'lt-duracao'].forEach((id) => $(id).addEventListener('input', () => { $('lt-previa').textContent = pedidoDeLetra(); }));
$('lt-idioma').addEventListener('change', () => { $('lt-previa').textContent = pedidoDeLetra(); });
$('lt-copiar').addEventListener('click', async () => {
  if (!$('lt-tema').value.trim()) { $('lt-aviso').textContent = 'Escreva o tema primeiro.'; return; }
  await api.copiar(pedidoDeLetra());
  $('lt-aviso').textContent = 'Pedido copiado. Cole no Claude ou no ChatGPT (Ctrl+V).';
});
$('lt-claude').addEventListener('click', () => api.abrirSite('claude'));
$('lt-chatgpt').addEventListener('click', () => api.abrirSite('chatgpt'));
$('lt-usar').addEventListener('click', () => {
  const t = $('lt-volta').value;
  if (!t.trim()) { $('lt-aviso').textContent = 'Cole a letra no campo de baixo.'; return; }
  $('in-letra').value = arrumarLetra(t);
  $('in-letra').dispatchEvent(new Event('input'));
  $('lt-volta').value = '';
  $('dlg-letra').close();
  setStatus('Letra colocada na mesa.');
});

// ---------- o cantor ----------
// Quadros: 0 boca fechada, 1 meio aberta, 2 aberta, 3 olhos fechados.
// A boca segue o volume real da faixa que toca (20 leituras por segundo). O corpo nunca fica parado:
// respira e balança quando está à toa, bate o pé enquanto o motor trabalha e quica quando canta.
const cantor = { nivel: 0, quadro: 0, pisca: 0, proxPisca: 2500, pulso: 0 };
function nivelTocando(t) {
  const c = canais.find((x) => x.file && !x.audio.paused);
  if (!c || !c.audio.duration) return null;
  if (c.env) {
    const pos = (c.audio.currentTime / c.audio.duration) * (c.env.length - 1);
    const i = Math.floor(pos), frac = pos - i;
    return Math.min(1.2, ((c.env[i] || 0) * (1 - frac) + (c.env[i + 1] || 0) * frac) / c.envTeto);
  }
  // enquanto a curva fina não chega: volume grosso com um vai e vem de sílaba por cima
  if (!c.peaks) return 0.5 * Math.abs(Math.sin(t / 90));
  const i = Math.min(c.peaks.length - 1, Math.floor((c.audio.currentTime / c.audio.duration) * c.peaks.length));
  return (c.peaks[i] / Math.max(0.05, ...c.peaks)) * (0.25 + 0.75 * Math.abs(Math.sin(t / 95) * Math.sin(t / 57 + 1.3)));
}
function quadroCantor(q) {
  if (q === cantor.quadro) return;
  cantor.quadro = q;
  [...$('cantor').children].forEach((im, i) => im.classList.toggle('on', i === q));
}
function animarCantor(t) {
  const box = $('cantor');
  if (box && !$('palco').hidden) {
    const n = nivelTocando(t);
    const cantando = n != null;
    const alvo = cantando ? n : 0;
    // abre rápido, fecha um pouco mais devagar: parece boca, não chave liga-desliga
    cantor.nivel += (alvo - cantor.nivel) * (alvo > cantor.nivel ? 0.7 : 0.3);
    const v = cantor.nivel;
    let q = v < 0.16 ? 0 : v < 0.52 ? 1 : 2;
    if (t > cantor.proxPisca) { cantor.pisca = t + 170; cantor.proxPisca = t + 2200 + Math.random() * 3200; }
    if (q === 0 && t < cantor.pisca) q = 3;
    quadroCantor(q);

    let y = 0, giro = 0, sx = 1, sy = 1;
    if (cantando) {
      cantor.pulso += (Math.min(1, v) - cantor.pulso) * 0.25;
      const p = cantor.pulso;
      y = -9 * p - 3 * Math.abs(Math.sin(t / 210));       // quica com o volume e marca o tempo
      giro = 5 * Math.sin(t / 340) + 2 * p * Math.sin(t / 120);
      sy = 1 + 0.07 * p; sx = 1 - 0.04 * p;               // estica quando solta a voz
    } else if (state.rodando) {
      cantor.pulso *= 0.9;
      y = -4 * Math.abs(Math.sin(t / 260));               // batendo o pé enquanto o motor trabalha
      giro = 2.5 * Math.sin(t / 520);
    } else {
      cantor.pulso *= 0.9;
      sy = 1 + 0.014 * Math.sin(t / 900); sx = 1 - 0.008 * Math.sin(t / 900);   // respirando
      giro = 1.3 * Math.sin(t / 1700);
    }
    if (!box.classList.contains('saudando')) {
      box.style.transform = 'translateY(' + y.toFixed(1) + 'px) rotate(' + giro.toFixed(2) + 'deg) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    }
  }
  requestAnimationFrame(animarCantor);
}
$('cantor').addEventListener('click', () => {
  const box = $('cantor');
  box.style.transform = '';
  box.classList.remove('saudando');
  void box.offsetWidth;
  box.classList.add('saudando');
  setTimeout(() => box.classList.remove('saudando'), 520);
});
$('aj-som').addEventListener('click', () => setTimeout(() => {
  api.configSalvar({ som: sw('aj-som') });
  if (sw('aj-som')) tocarAviso('ok');   // amostra
}, 0));
$('aj-cantor').addEventListener('click', () => setTimeout(() => {
  const on = sw('aj-cantor');
  $('palco').hidden = !on;
  api.configSalvar({ cantor: on });
}, 0));

// ---------- repetir sem parar ----------
// Terminou uma gravação, começa outra com sementes novas, até apertar Parar ou desligar a chave.
function talvezRepetir() {
  if (!sw('sw-repetir') || state.modoMesa === 'voz') { state.seq = 0; return; }
  state.seq = (state.seq || 1) + 1;
  setStatus('Repetir sem parar: começando a gravação ' + state.seq + '. Aperte Parar para encerrar.');
  setTimeout(() => { if (sw('sw-repetir') && !state.rodando) $('btn-rec').click(); else state.seq = 0; }, 1200);
}
// a partir da segunda gravação da sequência, semente fixa não vale (senão sairia sempre a mesma música)
const sementeDe = (id) => (state.seq > 1 ? null : soDigitos(id));

// ---------- início ----------
(async function iniciar() {
  const info = await api.info();
  state.nome = info.nome;
  state.limite = info.limiteSegundos;
  state.temReferenciaPadrao = !!info.temReferenciaPadrao;
  state.referenciaPadrao = info.referenciaPadrao;
  TEMPO =TEMPOS[info.motor] || TEMPOS.vulkan;
  document.title = info.nome;
  const partes = info.nome.split(' ');
  const marca = $('marca');
  marca.replaceChildren(document.createTextNode(partes.length > 1 ? partes.slice(0, -1).join(' ') + ' ' : ''), el('b', { text: partes[partes.length - 1] }));
  montarFader();
  cadeiaIniciar([]);
  carregarPresets();
  montarPainelVoz();
  await carregarConfig();
  // abre no último modo usado; na primeira vez, em Trocar voz
  state.modoMesa = MODOS[state.config.modo] ? state.config.modo : 'voz';
  aplicarModo();
  requestAnimationFrame(animarCantor);
  const items = prontas(await api.historico());
  carregarRecentes();
  if (items.length) carregar(items[0]);
  atualizarMesa();
})();
