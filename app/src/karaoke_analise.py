"""Análise para o karaokê: tom da música e atraso da letra sincronizada.

Roda no sep-env. Imprime uma linha "ANALISE {json}":
  {"tom": {"nota": "A", "modo": "menor", "nome": "Lá menor", "confianca": 0.8} ou null,
   "atraso": segundos a somar nos tempos da letra, "atraso_confianca": 0 a 1}

--instrumental  instrumental (com ou sem coro): dele sai o tom
--vocal         voz principal separada: dela sai onde a pessoa começa a cantar cada frase
--tempos        JSON com a lista de inícios das linhas da letra, em segundos

O tom vem do perfil de Krumhansl comparado com o croma da música inteira. O atraso existe porque a letra
vem de outra fonte (LRCLIB) e o vídeo pode ter introdução ou corte diferentes: testa deslocamentos de -20 s a
+20 s e fica com o que mais põe início de linha logo depois de um silêncio e logo antes de voz.
"""
import argparse
import json

import numpy as np

NOTAS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOMES = ["Dó", "Dó#", "Ré", "Ré#", "Mi", "Fá", "Fá#", "Sol", "Sol#", "Lá", "Lá#", "Si"]
MAIOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MENOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


# perfis de Temperley-Kostka-Payne: erram menos que os de Krumhansl em música popular; os dois votam
MAIOR_T = np.array([0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400])
MENOR_T = np.array([0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330])


def _norm(v):
    v = np.asarray(v, dtype=float)
    s = v.sum()
    return v / s if s > 0 else v


def perfil_instrumental(arquivo):
    import librosa

    y, sr = librosa.load(arquivo, sr=22050, mono=True)
    if len(y) < sr * 5:
        return None
    y = librosa.effects.harmonic(y, margin=2.0)   # bateria fora: ela suja o croma
    croma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=2048, bins_per_octave=36)
    peso = croma.sum(axis=0)                       # trecho quase mudo não decide o tom
    return _norm((croma * peso).sum(axis=1))


def perfil_melodia(arquivo_melodia):
    """Quanto tempo a voz original passa em cada nota (dó a si), da melodia já medida."""
    try:
        with open(arquivo_melodia, "r", encoding="utf-8") as f:
            midi = np.asarray(json.load(f)["midi"], dtype=float)
    except (OSError, ValueError, KeyError):
        return None
    midi = midi[midi > 0]
    if len(midi) < 200:
        return None
    classe = np.round(midi).astype(int) % 12
    return _norm(np.bincount(classe, minlength=12))


def candidatos(perfil):
    out = []
    for modo, perfis in (("maior", (MAIOR, MAIOR_T)), ("menor", (MENOR, MENOR_T))):
        for n in range(12):
            r = np.mean([np.corrcoef(perfil, np.roll(p, n))[0, 1] for p in perfis])
            out.append((float(r), n, modo))
    return sorted(out, reverse=True)


def tom(arquivo, arquivo_melodia=None):
    inst = perfil_instrumental(arquivo)
    if inst is None:
        return None
    mel = perfil_melodia(arquivo_melodia) if arquivo_melodia else None
    perfil = inst if mel is None else _norm(inst + 0.6 * mel)
    lista = candidatos(perfil)
    r, n, modo = lista[0]
    # o segundo que não seja o relativo (mesmas notas) diz se a escolha foi apertada
    relativo = ((n + 9) % 12, "menor") if modo == "maior" else ((n + 3) % 12, "maior")
    rival = next(x for x in lista[1:] if (x[1], x[2]) != relativo)
    rn, rm = relativo
    out = {"nota": NOTAS[n], "modo": modo, "nome": "%s %s" % (NOMES[n], modo),
           "relativo": "%s %s" % (NOMES[rn], rm),
           "confianca": round(max(0.0, min(1.0, (r - rival[0]) * 8)), 2)}
    if mel is not None:
        # instrumental e voz apontam para escalas diferentes (não só o relativo): avisa e guarda a outra opção
        maior_de = lambda x: x[1] if x[2] == "maior" else (x[1] + 3) % 12
        so_inst = candidatos(inst)[0]
        so_voz = candidatos(mel)[0]
        if maior_de(so_inst) != maior_de(so_voz):
            outro = so_inst if maior_de(so_inst) != maior_de(lista[0]) else so_voz
            out["confianca"] = min(out["confianca"], 0.4)
            out["outra"] = {"nota": NOTAS[outro[1]], "modo": outro[2], "nome": "%s %s" % (NOMES[outro[1]], outro[2])}
    return out


def atraso(vocal, tempos):
    import librosa

    if len(tempos) < 4:
        return 0.0, 0.0
    sr = 16000
    y, _ = librosa.load(vocal, sr=sr, mono=True)
    passo = 160   # 10 ms
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=passo)[0]
    db = 20 * np.log10(np.maximum(rms, 1e-6))
    teto = np.percentile(db, 95)
    voz = (db > max(teto - 30, -55)).astype(np.float32)
    acum = np.concatenate([[0.0], np.cumsum(voz)])
    n = len(voz)

    def media(ini, fim):
        ini = np.clip(ini, 0, n)
        fim = np.clip(fim, 0, n)
        tam = np.maximum(fim - ini, 1)
        return (acum[fim] - acum[ini]) / tam

    t = np.round(np.asarray(tempos, dtype=float) * 100).astype(int)
    melhor = (-1e9, 0)
    notas = {}
    for d in range(-2000, 2001, 5):   # -20 s a +20 s, de 5 em 5 centésimos
        k = t + d
        dentro = (k > 0) & (k < n - 60)
        if dentro.sum() < len(t) * 0.7:
            continue
        k = k[dentro]
        depois = media(k, k + 60)    # 0,6 s de voz depois do início da linha
        antes = media(k - 35, k - 5)  # silêncio (respiração) logo antes
        nota = float((depois - antes).mean())
        notas[d] = nota
        if nota > melhor[0]:
            melhor = (nota, d)
    if not notas:
        return 0.0, 0.0
    zero = notas.get(0, -1)
    nota, d = melhor
    # só troca o atraso se a melhora for clara; senão confia na letra como veio
    if d != 0 and nota - zero < 0.08:
        d, nota = 0, zero
    return d / 100.0, round(max(0.0, min(1.0, nota)), 2)


def melodia(vocal, saida):
    """Nota da voz original a cada 20 ms (MIDI com uma casa; 0 = ninguém cantando). Serve de régua na tela."""
    import librosa
    from scipy.ndimage import median_filter

    sr, passo = 16000, 320
    y, _ = librosa.load(vocal, sr=sr, mono=True)
    f0 = librosa.yin(y, fmin=70, fmax=1000, sr=sr, frame_length=1024, hop_length=passo)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=passo)[0]
    n = min(len(f0), len(rms))
    f0, rms = f0[:n], rms[:n]
    db = 20 * np.log10(np.maximum(rms, 1e-6))
    voz = db > max(np.percentile(db, 95) - 25, -50)
    midi = 69 + 12 * np.log2(np.maximum(f0, 1) / 440.0)
    midi = median_filter(midi, size=5)   # tira os pulos de oitava de um quadro só
    midi[~voz] = 0
    # pedaços de voz curtos demais (consoante, respiração) não viram nota
    i = 0
    while i < n:
        if midi[i] > 0:
            j = i
            while j < n and midi[j] > 0:
                j += 1
            if j - i < 5:
                midi[i:j] = 0
            i = j
        else:
            i += 1
    with open(saida, "w", encoding="utf-8") as f:
        json.dump({"passo": passo / sr, "midi": [round(float(x), 1) for x in midi]}, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instrumental")
    ap.add_argument("--vocal")
    ap.add_argument("--tempos")
    ap.add_argument("--melodia", help="arquivo .json onde gravar a melodia da voz (--vocal)")
    a = ap.parse_args()
    if a.vocal and a.melodia:
        try:
            melodia(a.vocal, a.melodia)
        except Exception as erro:
            print("melodia falhou:", erro, flush=True)
    out = {"tom": None, "atraso": 0.0, "atraso_confianca": 0.0}
    if a.instrumental:
        try:
            out["tom"] = tom(a.instrumental, a.melodia)
        except Exception as erro:
            print("tom falhou:", erro, flush=True)
    if a.vocal and a.tempos:
        try:
            with open(a.tempos, "r", encoding="utf-8") as f:
                tempos = json.load(f)
            out["atraso"], out["atraso_confianca"] = atraso(a.vocal, tempos)
        except Exception as erro:
            print("atraso falhou:", erro, flush=True)
    print("ANALISE " + json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
