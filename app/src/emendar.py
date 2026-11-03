"""Monta uma faixa de voz com pedaços de várias versões da mesma conversão (tons diferentes).

Roda no ambiente sep-env.  python emendar.py --plano plano.json
plano.json: {"saida": "final.wav", "partes": [{"arquivo": "a.wav", "ini": 0, "fim": 20.4}, ...]}
"ini" e "fim" em segundos; "fim" nulo vai até o final. Os cortes caem em pausas da voz e cada emenda
tem uma transição curta, para não estalar.
"""
import argparse
import json

import numpy as np
import soundfile as sf

TRANSICAO = 0.04  # segundos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plano", required=True)
    a = ap.parse_args()
    with open(a.plano, "r", encoding="utf-8") as f:
        plano = json.load(f)

    faixas = {}
    for parte in plano["partes"]:
        arq = parte["arquivo"]
        if arq in faixas:
            continue
        dados, sr = sf.read(arq, dtype="float32", always_2d=True)
        faixas[arq] = (dados, sr)

    # modelos de voz diferentes podem sair em taxas diferentes (40 kHz e 48 kHz): tudo vai para a maior
    taxa = max(sr for _, sr in faixas.values())
    for arq, (dados, sr) in list(faixas.items()):
        if sr != taxa:
            from math import gcd
            from scipy.signal import resample_poly
            g = gcd(int(taxa), int(sr))
            dados = resample_poly(dados, int(taxa) // g, int(sr) // g, axis=0).astype(np.float32)
        faixas[arq] = dados

    total = max(len(d) for d in faixas.values())
    canais = max(d.shape[1] for d in faixas.values())
    saida = np.zeros((total, canais), dtype=np.float32)
    meia = int(TRANSICAO * taxa / 2)

    for parte in plano["partes"]:
        dados = faixas[parte["arquivo"]]
        if dados.shape[1] < canais:
            dados = np.repeat(dados, canais, axis=1)
        ini = int(round(float(parte["ini"]) * taxa))
        fim = total if parte.get("fim") is None else int(round(float(parte["fim"]) * taxa))
        ini, fim = max(0, ini), min(total, fim)
        # peso 1 dentro do pedaço, com rampa de entrada e de saída em volta de cada corte
        peso = np.zeros(total, dtype=np.float32)
        a0, a1 = max(0, ini - meia), min(total, ini + meia)
        b0, b1 = max(0, fim - meia), min(total, fim + meia)
        peso[a1:b0] = 1.0
        if ini > 0 and a1 > a0:
            peso[a0:a1] = np.linspace(0.0, 1.0, a1 - a0, endpoint=False, dtype=np.float32)
        else:
            peso[a0:a1] = 1.0
        if fim < total and b1 > b0:
            peso[b0:b1] = np.linspace(1.0, 0.0, b1 - b0, endpoint=False, dtype=np.float32)
        else:
            peso[b0:b1] = 1.0
        n = min(total, len(dados))
        saida[:n] += dados[:n] * peso[:n, None]

    sf.write(plano["saida"], np.clip(saida, -1.0, 1.0), taxa, subtype="PCM_16")
    print(f"ok {total / taxa:.1f}s {len(plano['partes'])} partes")


if __name__ == "__main__":
    main()
