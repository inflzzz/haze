"""Melodia da voz e acordes do instrumental num arquivo .mid, para arrastar no FL Studio.

Roda no sep-env. Uso:
  midi.py --vocal VOZ.wav --instrumental INSTR.wav --saida MUSICA.mid

- Andamento: batidas do instrumental (librosa.beat). O .mid sai nesse andamento, então a grade do
  FL Studio fica perto das batidas reais.
- Melodia (faixa 1): altura da voz a cada 10 ms, arredondada para a nota mais próxima; nota que dura
  menos de 90 ms some (consoante, deslize).
- Acordes (faixa 2): croma do instrumental (sem bateria) a cada 2 batidas, comparado com as 24
  tríades maiores e menores; acordes iguais seguidos viram um só.
Imprime "ACORDES <lista>" e "MIDI ok".
"""
import argparse
import struct

import numpy as np

PPQ = 480
NOTAS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


# ---------- arquivo MIDI ----------

def varlen(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def faixa(eventos):
    """eventos: lista de (tique, bytes). Devolve o bloco MTrk."""
    eventos = sorted(eventos, key=lambda e: (e[0], e[1][0] & 0xF0 == 0x90))  # nota desliga antes de ligar
    dados = b""
    agora = 0
    for t, ev in eventos:
        dados += varlen(max(0, t - agora)) + ev
        agora = max(agora, t)
    dados += b"\x00\xFF\x2F\x00"
    return b"MTrk" + struct.pack(">I", len(dados)) + dados


def nome_faixa(texto):
    b = texto.encode("utf-8")
    return b"\xFF\x03" + varlen(len(b)) + b


def notas_para_eventos(notas, canal, seg_para_tique, veloc):
    ev = []
    for ini, fim, nota in notas:
        a, b = seg_para_tique(ini), seg_para_tique(fim)
        if b <= a:
            b = a + 1
        ev.append((a, bytes([0x90 | canal, nota, veloc])))
        ev.append((b, bytes([0x80 | canal, nota, 0])))
    return ev


def gravar(saida, bpm, melodia, acordes):
    seg_para_tique = lambda s: int(round(s * bpm / 60.0 * PPQ))
    us = int(round(60_000_000 / bpm))
    tempo = faixa([(0, nome_faixa("Andamento")), (0, b"\xFF\x51\x03" + us.to_bytes(3, "big")),
                   (0, b"\xFF\x58\x04\x04\x02\x18\x08")])
    f1 = faixa([(0, nome_faixa("Melodia (voz)"))] + notas_para_eventos(melodia, 0, seg_para_tique, 100))
    f2 = faixa([(0, nome_faixa("Acordes"))] + notas_para_eventos(acordes, 1, seg_para_tique, 80))
    with open(saida, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 1, 3, PPQ) + tempo + f1 + f2)


# ---------- análise ----------

def melodia(vocal):
    import librosa
    from scipy.ndimage import median_filter

    sr, passo = 16000, 160
    y, _ = librosa.load(vocal, sr=sr, mono=True)
    f0 = librosa.yin(y, fmin=70, fmax=1000, sr=sr, frame_length=1024, hop_length=passo)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=passo)[0]
    n = min(len(f0), len(rms))
    f0, rms = f0[:n], rms[:n]
    db = 20 * np.log10(np.maximum(rms, 1e-6))
    voz = db > max(np.percentile(db, 95) - 25, -50)
    midi = 69 + 12 * np.log2(np.maximum(f0, 1) / 440.0)
    midi = median_filter(midi, size=7)
    nota = np.where(voz, np.round(midi), 0).astype(int)
    nota = median_filter(nota, size=5)
    dt = passo / sr
    notas = []
    i = 0
    while i < n:
        if nota[i] <= 0:
            i += 1
            continue
        j = i
        while j < n and nota[j] == nota[i]:
            j += 1
        if (j - i) * dt >= 0.09 and 24 <= nota[i] <= 108:
            # a mesma nota logo depois de um buraco curto continua a anterior
            if notas and notas[-1][2] == nota[i] and i * dt - notas[-1][1] < 0.06:
                notas[-1] = (notas[-1][0], j * dt, nota[i])
            else:
                notas.append((i * dt, j * dt, int(nota[i])))
        i = j
    return notas


def acordes(instrumental):
    import librosa

    sr, passo = 22050, 512
    y, _ = librosa.load(instrumental, sr=sr, mono=True)
    harm, perc = librosa.effects.hpss(y, margin=2.0)
    bpm, batidas = librosa.beat.beat_track(y=perc if np.abs(perc).sum() > 0 else y, sr=sr, hop_length=passo)
    bpm = float(np.atleast_1d(bpm)[0]) or 120.0
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    croma = librosa.feature.chroma_cqt(y=harm, sr=sr, hop_length=passo, bins_per_octave=36)
    energia = librosa.feature.rms(y=harm, hop_length=passo)[0]
    tempos = librosa.frames_to_time(np.arange(croma.shape[1]), sr=sr, hop_length=passo)
    marcos = list(batidas[::2]) if len(batidas) > 4 else list(range(0, croma.shape[1], int(sr / passo)))
    marcos = [0] + [m for m in marcos if m > 0] + [croma.shape[1]]

    moldes = []
    for raiz in range(12):
        for tipo, int3 in (("", 4), ("m", 3)):
            v = np.zeros(12)
            v[[raiz, (raiz + int3) % 12, (raiz + 7) % 12]] = [1.0, 0.8, 0.9]
            moldes.append((NOTAS[raiz] + tipo, raiz, int3, v / np.linalg.norm(v)))
    limiar = np.percentile(energia, 20)

    lista = []
    for a, b in zip(marcos[:-1], marcos[1:]):
        if b <= a:
            continue
        if energia[a:b].mean() < limiar:
            lista.append((tempos[a], None))
            continue
        c = croma[:, a:b].mean(axis=1)
        c = c / (np.linalg.norm(c) + 1e-9)
        nome, raiz, int3, _ = max(moldes, key=lambda m: float(m[3] @ c))
        lista.append((tempos[a], (nome, raiz, int3)))
    duracao = len(y) / sr

    blocos = []
    for i, (t, ac) in enumerate(lista):
        fim = lista[i + 1][0] if i + 1 < len(lista) else duracao
        if blocos and blocos[-1][2] == ac:
            blocos[-1][1] = fim
        else:
            blocos.append([t, fim, ac])
    notas, nomes = [], []
    for ini, fim, ac in blocos:
        if ac is None:
            continue
        nome, raiz, int3 = ac
        base = 48 + raiz                     # tríade perto do dó central
        for n in (base, base + int3, base + 7):
            notas.append((ini, fim, n))
        nomes.append(nome)
    return bpm, notas, nomes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--instrumental")
    ap.add_argument("--saida", required=True)
    a = ap.parse_args()
    print("lendo a melodia da voz...", flush=True)
    mel = melodia(a.vocal)
    bpm, ac, nomes = 120.0, [], []
    if a.instrumental:
        print("lendo o andamento e os acordes...", flush=True)
        bpm, ac, nomes = acordes(a.instrumental)
    gravar(a.saida, bpm, mel, ac)
    print("ACORDES " + " ".join(nomes[:64]), flush=True)
    print("MIDI ok: %d notas, %d acordes, %.0f BPM" % (len(mel), len(nomes), bpm), flush=True)


if __name__ == "__main__":
    main()
