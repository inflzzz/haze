// "Voz pelo celular": uma página na rede de casa. O celular grava (ou manda um link de música), o PC troca a
// voz e devolve os áudios prontos. Não é ao vivo dentro de outros apps (o celular não permite); é gravar
// aqui e anexar lá.
//
// Segurança: só liga quando o usuário pede (ou deixou marcado para ligar junto com o app); o endereço leva
// um código que só muda se ele pedir; aceita só áudio, com limite de tamanho, e links http(s); nada além dos
// caminhos abaixo é servido.
// É HTTPS com certificado próprio porque o navegador do celular só libera o microfone em página segura;
// por ser certificado próprio, o celular mostra um aviso na primeira vez ("avançar mesmo assim").
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORTAS = [47821, 47822, 47823, 47824];   // tenta a primeira livre
const LIMITE = 40 * 1024 * 1024;   // 40 MB por gravação

// Endereço do PC na rede de casa (ignora adaptadores virtuais).
function ipLocal() {
  const todos = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces())) {
    for (const a of lista || []) {
      if (a.family === 'IPv4' && !a.internal) todos.push({ nome, ip: a.address });
    }
  }
  const real = todos.filter((x) => !/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback/i.test(x.nome));
  const casa = (x) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.ip);
  return (real.find(casa) || real[0] || todos[0] || { ip: '127.0.0.1' }).ip;
}

async function certificado(pasta, ip) {
  const arq = path.join(pasta, 'certificado.json');
  try {
    const c = JSON.parse(fs.readFileSync(arq, 'utf8'));
    if (c.ip === ip && c.key && c.cert) return c;
  } catch {}
  const feito = await require('selfsigned').generate([{ name: 'commonName', value: 'Lado B' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }, { type: 2, value: 'localhost' }] }],
  });
  const c = { ip, key: feito.private, cert: feito.cert };
  fs.writeFileSync(arq, JSON.stringify(c));
  return c;
}

// opcoes: {
//   pasta, pagina (html), icone (png), nome, codigo (fixo, para o atalho na tela inicial do celular continuar valendo),
//   modelos() -> [{id, nome, grupo}],
//   converter(arquivo, modeloId, tom, avisar) -> Promise<arquivo pronto>          (uma gravação de voz)
//   cover(link, modeloId, tom, avisar)        -> Promise<[{rotulo, arquivo}]>     (uma música por link)
//   falar(texto, modeloId, tom, avisar)       -> Promise<arquivo pronto>          (um texto lido na voz do modelo)
// }
async function ligar(opcoes) {
  fs.mkdirSync(opcoes.pasta, { recursive: true });
  const ip = ipLocal();
  const cert = await certificado(opcoes.pasta, ip);
  const codigo = /^[0-9a-f]{8,}$/.test(opcoes.codigo || '') ? opcoes.codigo : crypto.randomBytes(5).toString('hex');
  const base = '/c/' + codigo;
  const trabalhos = new Map();   // id -> { estado, texto, arquivos: [{rotulo, arquivo}] }
  let fila = Promise.resolve();  // um trabalho por vez

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const arquivo = (res, file, tipo) => {
    res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  };
  // Uma voz pronta em mp3 vira a lista entregue ao celular. 'voz-nota' é a mesma voz em .opus, o formato das
  // mensagens de voz; a página usa no botão "Mandar como mensagem de voz".
  const comNota = (mp3) => {
    const opus = mp3.replace(/\.mp3$/i, '.opus');
    return [{ rotulo: 'voz', arquivo: mp3 }, ...(opus !== mp3 && fs.existsSync(opus) ? [{ rotulo: 'voz-nota', arquivo: opus }] : [])];
  };
  // põe um trabalho na fila e devolve o id; fazer(avisar) entrega a lista de arquivos prontos
  const enfileirar = (fazer) => {
    const id = crypto.randomBytes(6).toString('hex');
    const t = { estado: 'fila', texto: 'na fila…', arquivos: [] };
    trabalhos.set(id, t);
    fila = fila.then(async () => {
      t.estado = 'convertendo';
      t.texto = 'começando…';
      try {
        t.arquivos = await fazer((texto) => { t.texto = texto; });
        t.estado = 'pronto';
        t.texto = 'pronto';
      } catch (e) {
        t.estado = 'erro';
        t.texto = String((e && e.message) || e).split('\n')[0];
      }
    });
    return id;
  };

  const servidor = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    if (!u.pathname.startsWith(base + '/') && u.pathname !== base) { res.writeHead(404); return res.end(); }
    const resto = u.pathname.slice(base.length) || '/';
    const q = u.searchParams;

    if (req.method === 'GET' && resto === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(opcoes.pagina).pipe(res);
    }
    // o que o celular usa para pôr a página na tela inicial com nome e ícone
    if (req.method === 'GET' && resto === '/manifest.json') {
      return json(res, 200, {
        name: opcoes.nome || 'Haze', short_name: opcoes.nome || 'Haze', start_url: base + '/', scope: base + '/',
        display: 'standalone', background_color: '#1f1c19', theme_color: '#1f1c19',
        icons: [{ src: base + '/icone.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
      });
    }
    if (req.method === 'GET' && resto === '/icone.png' && opcoes.icone && fs.existsSync(opcoes.icone)) return arquivo(res, opcoes.icone, 'image/png');
    if (req.method === 'GET' && resto === '/modelos') return json(res, 200, opcoes.modelos());
    if (req.method === 'GET' && resto === '/estado') {
      const t = trabalhos.get(q.get('id'));
      if (!t) return json(res, 404, { estado: 'erro', texto: 'pedido não encontrado (o app foi reaberto?)' });
      return json(res, 200, { estado: t.estado, texto: t.texto, arquivos: t.arquivos.map((a, n) => ({ rotulo: a.rotulo, n })) });
    }
    if (req.method === 'GET' && resto.startsWith('/arquivo/')) {
      const [id, n] = resto.slice('/arquivo/'.length).split('/');
      const t = trabalhos.get(id);
      const a = t && t.estado === 'pronto' ? t.arquivos[parseInt(n, 10)] : null;
      if (!a || !fs.existsSync(a.arquivo)) { res.writeHead(404); return res.end(); }
      return arquivo(res, a.arquivo, /\.mp3$/i.test(a.arquivo) ? 'audio/mpeg' : /\.opus$/i.test(a.arquivo) ? 'audio/ogg' : 'audio/mp4');
    }
    if (req.method === 'POST' && resto === '/texto') {
      const pedacos = [];
      let total = 0;
      req.on('data', (p) => { total += p.length; if (total > 20000) req.destroy(); else pedacos.push(p); });
      req.on('end', () => {
        const texto = Buffer.concat(pedacos).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 1500);
        if (texto.length < 2) return json(res, 400, { erro: 'escreva o texto' });
        if (!opcoes.falar) return json(res, 400, { erro: 'função não disponível' });
        const modelo = q.get('modelo') || '';
        const tom = q.get('tom') || 'auto';
        json(res, 200, { id: enfileirar(async (avisar) => comNota(await opcoes.falar(texto, modelo, tom, avisar))) });
      });
      return;
    }
    if (req.method === 'POST' && resto === '/cover') {
      const link = String(q.get('link') || '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(link) || link.length > 500) return json(res, 400, { erro: 'cole um link válido' });
      if (!opcoes.cover) return json(res, 400, { erro: 'função não disponível' });
      const modelo = q.get('modelo') || '';
      const tom = q.get('tom') || 'auto';
      return json(res, 200, { id: enfileirar((avisar) => opcoes.cover(link, modelo, tom, avisar)) });
    }
    if (req.method === 'POST' && resto === '/enviar') {
      const dir = path.join(opcoes.pasta, crypto.randomBytes(6).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const entrada = path.join(dir, 'entrada.bin');
      const saida = fs.createWriteStream(entrada);
      let total = 0;
      let grande = false;
      req.on('data', (p) => {
        total += p.length;
        if (total > LIMITE) { grande = true; req.destroy(); saida.destroy(); }
      });
      req.pipe(saida);
      saida.on('close', () => {
        if (grande || total < 1000) {
          fs.rmSync(dir, { recursive: true, force: true });
          if (!res.headersSent) json(res, 413, { erro: grande ? 'gravação grande demais' : 'gravação vazia' });
          return;
        }
        const modelo = q.get('modelo') || '';
        const tom = q.get('tom') || 'auto';
        json(res, 200, { id: enfileirar(async (avisar) => comNota(await opcoes.converter(entrada, modelo, tom, avisar))) });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // nos testes automáticos (janela escondida) fica só no próprio PC, para não acionar o firewall
  const onde = opcoes.soLocal ? '127.0.0.1' : '0.0.0.0';
  let porta = 0;
  for (const p of PORTAS) {
    const livre = await new Promise((resolve) => {
      const falhou = () => resolve(false);
      servidor.once('error', falhou);
      servidor.listen(p, onde, () => { servidor.removeListener('error', falhou); resolve(true); });
    });
    if (livre) { porta = p; break; }
  }
  if (!porta) { const e = new Error('nenhuma porta livre'); e.code = 'EADDRINUSE'; throw e; }
  return {
    url: `https://${ip}:${porta}${base}/`,
    codigo,
    // o celular deixa a ligação aberta entre um pedido e outro; sem derrubá-las o fechamento não termina
    fechar: () => new Promise((resolve) => {
      servidor.close(() => resolve());
      if (servidor.closeAllConnections) servidor.closeAllConnections();
    }),
  };
}

module.exports = { ligar, ipLocal };
