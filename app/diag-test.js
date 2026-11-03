const { execFile } = require('child_process');
const sh = (cmd, args) => new Promise((resolve) => {
  const t0 = Date.now();
  execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) =>
    resolve({ cmd, ok: !err, ms: Date.now() - t0, err: err && err.message.slice(0, 80), out: ((stdout || '') + (stderr || '')).split('\n')[0].slice(0, 60) }));
});
(async () => {
  const r = await Promise.all([
    sh('yt-dlp', ['--version']),
    sh('ffmpeg', ['-version']),
    sh('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }']),
    sh('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader']),
  ]);
  console.log(JSON.stringify(r, null, 1));
})();
