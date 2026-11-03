// Letra sincronizada para o karaokê, do LRCLIB (lrclib.net): base aberta, sem chave nem cadastro.
// Só leitura: o app pergunta pelo nome da música e recebe a letra com o tempo de cada linha (formato LRC).

const SITE = 'https://lrclib.net/api';
const UA = 'LadoB-karaoke/0.1 (app pessoal)';

// "Artista - Música (Official Video) [HD]" -> "Artista - Música"
function limparTitulo(t) {
  return String(t || '')
    .replace(/[([{【][^)\]}】]*(official|oficial|video|vídeo|clipe|clip|lyric|letra|legendad|tradu|audio|áudio|hd|4k|hq|visualizer|ao vivo|live|remaster|mv|m\/v)[^)\]}】]*[)\]}】]/gi, ' ')
    .replace(/\b(official (music )?video|video oficial|clipe oficial|lyrics?|letra)\b/gi, ' ')
    .replace(/[|•].*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// [mm:ss.xx] texto  (uma linha pode ter vários tempos)
function lerLrc(texto) {
  const linhas = [];
  for (const bruta of String(texto || '').split(/\r?\n/)) {
    const tempos = [...bruta.matchAll(/\[(\d+):(\d+(?:[.,]\d+)?)\]/g)];
    if (!tempos.length) continue;
    const frase = bruta.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tempos) linhas.push({ t: Number(m[1]) * 60 + Number(m[2].replace(',', '.')), texto: frase });
  }
  return linhas.sort((a, b) => a.t - b.t);
}

async function pedir(caminho) {
  const r = await fetch(SITE + caminho, { headers: { 'User-Agent': UA, 'Lrclib-Client': UA }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('o site de letras respondeu ' + r.status);
  return r.json();
}

// Escolhe a melhor entre as achadas: com tempo por linha primeiro, depois a de duração mais parecida.
function escolher(lista, duracao) {
  const boas = (lista || []).filter((x) => x && !x.instrumental && (x.syncedLyrics || x.plainLyrics));
  if (!boas.length) return null;
  const dif = (x) => (duracao && x.duration ? Math.abs(x.duration - duracao) : 0);
  boas.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || (Math.min(dif(a), 30) > 8) - (Math.min(dif(b), 30) > 8) || dif(a) - dif(b));
  return boas[0];
}

function formatar(x) {
  return {
    fonte: 'lrclib',
    musica: x.trackName || '',
    artista: x.artistName || '',
    linhas: x.syncedLyrics ? lerLrc(x.syncedLyrics) : [],
    simples: x.plainLyrics || '',
  };
}

// { artista, faixa, titulo, duracao } vindos do vídeo, ou { busca } digitada pela pessoa.
// Devolve { fonte, musica, artista, linhas:[{t, texto}], simples } ou null.
async function buscar({ artista, faixa, titulo, duracao, busca }) {
  const q = (o) => '/search?' + new URLSearchParams(o).toString();
  const tentativas = [];
  if (busca) tentativas.push(q({ q: busca }));
  else {
    const limpo = limparTitulo(titulo);
    let a = String(artista || '').replace(/\s*-\s*topic$/i, '').trim();
    let f = limparTitulo(faixa || '');
    // título no formato "Artista - Música" diz mais que o canal
    const partes = limpo.split(/\s+[-–—]\s+/);
    if (partes.length >= 2 && (!f || f === limpo)) { a = partes[0]; f = partes.slice(1).join(' - '); }
    if (f && a) tentativas.push(q({ track_name: f, artist_name: a }));
    if (f && a) tentativas.push(q({ q: `${a} ${f}` }));
    if (limpo) tentativas.push(q({ q: limpo }));
    if (f) tentativas.push(q({ track_name: f }));
  }
  let ultimoErro = null;
  for (const t of tentativas) {
    try {
      const achada = escolher(await pedir(t), duracao);
      if (achada) return formatar(achada);
    } catch (e) {
      ultimoErro = e;
    }
  }
  if (ultimoErro) throw ultimoErro;
  return null;
}

module.exports = { buscar, lerLrc, limparTitulo };
