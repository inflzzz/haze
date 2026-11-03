// uso: node cli.js <url> <inicio-seg> <estilo> [duracao-seg]
const { analyze, generate } = require('./src/pipeline');
const [url, start, style, dur] = process.argv.slice(2);
const ev = (e) => { if (e.pct === 0 || e.pct === 100) process.stdout.write(`[${e.stage}] ${Math.round(e.pct)}% ${e.message}\n`); };
(async () => {
  const t0 = Date.now();
  const a = await analyze({ url, start: Number(start), end: Number(start) + Number(dur || 30), semitones: Number(process.env.SEMI || 0) }, ev);
  console.log('TITULO', a.title, '| dur', a.duration.toFixed(1) + 's', '| letraAuto', a.lyricsAuto, '| pasta', a.dir);
  console.log(a.lyrics);
  const g = await generate(a.dir, { style, variations: 1, separateCover: false }, ev);
  console.log('COVER', g.covers.join(' | '));
  console.log('tempo', ((Date.now() - t0) / 1000).toFixed(0) + 's');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
