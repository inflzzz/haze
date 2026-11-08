# Muda o formante (o "corpo" da voz) de um arquivo já convertido, sem mexer nas notas.
# timbre < 1 deixa a voz mais grossa; > 1, mais fina. Roda no Python do Applio (que já tem o stftpitchshift).
# Uso: python -I formante.py --arquivo voz.wav --timbre 0.85 [--quefrencia 1.0]
import argparse

import numpy as np
import soundfile as sf
from stftpitchshift import StftPitchShift

p = argparse.ArgumentParser()
p.add_argument('--arquivo', required=True)
p.add_argument('--timbre', type=float, default=1.0)
p.add_argument('--quefrencia', type=float, default=1.0)   # em milissegundos, como no Applio
a = p.parse_args()

if abs(a.timbre - 1.0) < 1e-3:
    print('formante: timbre 1, nada a fazer')
    raise SystemExit(0)

audio, sr = sf.read(a.arquivo, always_2d=True, dtype='float64')
pico = float(np.abs(audio).max()) or 1.0
# janela maior que a do Applio (que usa 1024 em 16 kHz) porque aqui o áudio está em 40/48 kHz
quadro = 2048 if sr > 24000 else 1024
ps = StftPitchShift(quadro, quadro // 8, sr)
saida = np.stack([
    ps.shiftpitch(audio[:, c], factors=1, quefrency=max(a.quefrencia, 0.1) * 1e-3, distortion=a.timbre)[: len(audio)]
    for c in range(audio.shape[1])
], axis=1)
# trecho em silêncio total pode virar NaN dentro da FFT; vira silêncio de novo
saida = np.nan_to_num(saida, nan=0.0, posinf=0.0, neginf=0.0)
# mesmo pico de antes, para não estourar nem baixar o volume
novo = float(np.abs(saida).max()) or 1.0
saida *= pico / novo
sf.write(a.arquivo, saida, sr, subtype='PCM_16')
print(f'formante ok: timbre {a.timbre}, quefrencia {a.quefrencia} ms, {sr} Hz')
