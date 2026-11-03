"""Acabamento da voz trocada, usando o vocal de origem como guia.

Roda no ambiente sep-env.  python acabamento.py --guia vocal.wav --alvo voz.wav [--pausas] [--volume]

--pausas  onde o vocal de origem está em silêncio, a voz trocada também fica: some o chiado que o
          conversor deixa entre as frases.
--volume  deixa a voz trocada com o mesmo volume do vocal de origem (medido só onde há canto), para
          ela chegar na mixagem no mesmo nível que a voz original tinha contra o instrumental.

O arquivo --alvo é regravado no lugar.
"""
import argparse
import os

import numpy as np
import soundfile as sf

QUADRO = 0.02      # segundos por quadro de medição
LIMIAR_DB = 45.0   # quanto abaixo do volume cheio ainda conta como canto
ANTES = 0.12       # folga antes de cada trecho cantado (ataque de consoante, respiração)
DEPOIS = 0.30      # folga depois (cauda da nota)
PAUSA_MINIMA = 0.25
TRANSICAO = 0.04


def quadros_rms(x, sr):
    n = max(1, int(sr * QUADRO))
    total = len(x) // n
    if total < 5:
        return np.zeros(0), n
    q = x[: total * n].reshape(total, n)
    return np.sqrt(np.mean(q * q, axis=1) + 1e-12), n


def trechos_cantados(rms):
    db = 20 * np.log10(rms + 1e-9)
    cheio = np.percentile(db, 95)
    ativo = db > (cheio - LIMIAR_DB)
    antes, depois = int(ANTES / QUADRO), int(DEPOIS / QUADRO)
    largo = ativo.copy()
    for i in np.flatnonzero(ativo):
        largo[max(0, i - antes): i + depois + 1] = True
    # pausa curta demais não vale a pena cortar
    minimo = int(PAUSA_MINIMA / QUADRO)
    i = 0
    while i < len(largo):
        if not largo[i]:
            j = i
            while j < len(largo) and not largo[j]:
                j += 1
            if j - i < minimo and i > 0 and j < len(largo):
                largo[i:j] = True
            i = j
        else:
            i += 1
    return ativo, largo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--guia", required=True)
    ap.add_argument("--alvo", required=True)
    ap.add_argument("--pausas", action="store_true")
    ap.add_argument("--volume", action="store_true")
    a = ap.parse_args()

    guia, sr_g = sf.read(a.guia, dtype="float32", always_2d=True)
    alvo, sr_a = sf.read(a.alvo, dtype="float32", always_2d=True)
    rms_g, _ = quadros_rms(guia.mean(axis=1), sr_g)
    if len(rms_g) == 0 or len(alvo) < sr_a // 2:
        print("ok nada a fazer (audio curto)")
        return
    ativo, largo = trechos_cantados(rms_g)
    if ativo.mean() < 0.03:
        print("ok nada a fazer (guia quase todo em silencio)")
        return

    # a voz trocada tem a mesma duração do guia; cada amostra dela consulta o quadro do guia no mesmo ponto
    n = len(alvo)
    pos = np.minimum((np.arange(n) / n * len(largo)).astype(np.int64), len(largo) - 1)

    ganho_db = 0.0
    if a.volume:
        mono = alvo.mean(axis=1)
        canta = ativo[pos]
        if canta.sum() > sr_a:
            v_alvo = float(np.sqrt(np.mean(mono[canta] ** 2) + 1e-12))
            v_guia = float(np.sqrt(np.mean(rms_g[ativo] ** 2) + 1e-12))
            ganho = float(np.clip(v_guia / v_alvo, 0.25, 4.0))
            alvo = alvo * ganho
            ganho_db = 20 * np.log10(ganho)

    mudo = 0.0
    if a.pausas:
        porta = largo[pos].astype(np.float32)
        k = max(1, int(TRANSICAO * sr_a))
        porta = np.convolve(porta, np.ones(k, dtype=np.float32) / k, mode="same")  # rampa curta em cada borda
        alvo = alvo * porta[:, None]
        mudo = 100.0 * float(1.0 - largo.mean())

    pico = float(np.max(np.abs(alvo))) if len(alvo) else 0.0
    if pico > 0.98:
        alvo = alvo * (0.98 / pico)

    tmp = a.alvo + ".tmp.wav"
    sf.write(tmp, alvo, sr_a, subtype="PCM_16")
    os.replace(tmp, a.alvo)
    print(f"ok ganho {ganho_db:+.1f} dB, pausas {mudo:.0f}% do tempo")


if __name__ == "__main__":
    main()
