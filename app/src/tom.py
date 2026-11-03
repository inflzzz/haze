"""Mede a altura (tom) de um vocal e a altura natural de um modelo de voz do Applio.

Roda no ambiente sep-env. Imprime uma linha que começa com "TOM " seguida de JSON:
  {"vocal": {"p10":..,"p50":..,"p90":..,"centro":..}, "modelo": {...} ou null, "frases": [[ini, fim, hz], ...]}

O "centro" é a altura mediana da voz, em Hz.
A altura do modelo vem das curvas de tom que o Applio guardou no treino (logs/<nome>/f0_voiced); só leitura.
Com --frases a música inteira é medida e cada frase (trecho cantado entre duas pausas) sai com início, fim
em segundos e a altura mediana dela.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

HOP = 512
SR = 16000
PAUSA = 0.45       # pausa que separa duas frases, em segundos
FRASE_MINIMA = 0.4


def resumo(hz):
    hz = hz[np.isfinite(hz) & (hz > 50) & (hz < 1100)]
    if len(hz) < 50:
        return None
    p10, p50, p90 = (float(np.percentile(hz, p)) for p in (10, 50, 90))
    # centro = mediana: não se abala com os erros de oitava que o medidor comete em chiado e respiração
    return {"p10": round(p10, 1), "p50": round(p50, 1), "p90": round(p90, 1), "centro": round(p50, 1)}


def curva(arquivo, inteira, limite=150.0):
    import librosa

    inicio, duracao = 0.0, None
    if not inteira:
        total = librosa.get_duration(path=arquivo)
        inicio = max(0.0, (total - limite) / 2)  # música longa: mede os 150 s do meio
        duracao = limite
    y, sr = librosa.load(arquivo, sr=SR, mono=True, offset=inicio, duration=duracao)
    f0, voz, _ = librosa.pyin(y, fmin=65, fmax=800, sr=sr, frame_length=1024, hop_length=HOP)
    return f0, voz


def frases_de(f0, voz):
    t = np.arange(len(f0)) * HOP / SR
    trechos, ini, ult = [], None, None
    for i, v in enumerate(voz):
        if not v:
            continue
        if ini is None:
            ini = i
        elif t[i] - t[ult] > PAUSA:
            trechos.append((ini, ult))
            ini = i
        ult = i
    if ini is not None:
        trechos.append((ini, ult))
    saida = []
    for a, b in trechos:
        hz = f0[a:b + 1][voz[a:b + 1]]
        if t[b] - t[a] < FRASE_MINIMA or len(hz) < 8:
            continue
        saida.append([round(float(t[a]), 2), round(float(t[b]) + HOP / SR, 2), round(float(np.median(hz)), 1)])
    return saida


def altura_do_modelo(pasta, maximo=800):
    arquivos = sorted(glob.glob(os.path.join(pasta, "*.npy")))[:maximo]
    if not arquivos:
        return None
    return resumo(np.concatenate([np.load(a).astype(np.float64).ravel() for a in arquivos]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--treino", default="")
    ap.add_argument("--frases", action="store_true")
    a = ap.parse_args()
    modelo = altura_do_modelo(a.treino) if a.treino and os.path.isdir(a.treino) else None
    f0, voz = curva(a.vocal, a.frases)
    res = {"vocal": resumo(f0[voz]), "modelo": modelo}
    if a.frases:
        res["frases"] = frases_de(f0, voz)
    sys.stdout.write("TOM " + json.dumps(res) + "\n")


if __name__ == "__main__":
    main()
