const { analyze, generate } = require('./src/pipeline');
const ev = (e) => process.stdout.write(`[${e.stage}] ${Math.round(e.pct)}% ${e.message}\n`);
(async () => {
  const t0 = Date.now();
  const a = await analyze({ url: 'https://www.youtube.com/watch?v=TkV5709EG5M', start: 107, preview: true }, (e) => { if (e.pct === 0 || e.pct === 100) ev(e); });
  console.log('ANALISE', a.title, a.duration.toFixed(1) + 's', 'letraAuto=' + a.lyricsAuto, '\n' + a.lyrics);
  const g = await generate(a.dir, { style: 'acoustic guitar, deep male vocal, piano, emotional, slow', variations: 1 }, (e) => { if (e.pct === 0 || e.pct === 100) ev(e); });
  console.log('PRONTO', JSON.stringify({ covers: g.covers, stems: g.stems }, null, 1));
  console.log('tempo total', ((Date.now() - t0) / 1000).toFixed(0) + 's');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
