"""Leitor de texto local (Kokoro). Roda no ambiente tts-env, sem internet.

Listar as vozes:   python falar.py --modelo M --vozes V --listar
Ler um texto:      python falar.py --modelo M --vozes V --texto arquivo.txt --voz pm_alex --velocidade 1.0 --saida fala.wav
"""
import argparse
import json
import sys

# idioma que o leitor usa para pronunciar, pela primeira letra do nome da voz
IDIOMAS = {
    "p": ("pt-br", "Português"), "a": ("en-us", "Inglês (EUA)"), "b": ("en-gb", "Inglês (Reino Unido)"),
    "e": ("es", "Espanhol"), "f": ("fr-fr", "Francês"), "i": ("it", "Italiano"),
    "j": ("ja", "Japonês"), "z": ("cmn", "Chinês"), "h": ("hi", "Hindi"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modelo", required=True)
    ap.add_argument("--vozes", required=True)
    ap.add_argument("--listar", action="store_true")
    ap.add_argument("--texto")
    ap.add_argument("--voz", default="pm_alex")
    ap.add_argument("--velocidade", type=float, default=1.0)
    ap.add_argument("--saida")
    a = ap.parse_args()

    from kokoro_onnx import Kokoro

    k = Kokoro(a.modelo, a.vozes)
    if a.listar:
        lista = []
        for nome in sorted(k.get_voices()):
            cod, idioma = IDIOMAS.get(nome[0], ("en-us", "Outro"))
            genero = {"f": "feminina", "m": "masculina"}.get(nome[1:2], "")
            lista.append({"id": nome, "idioma": idioma, "genero": genero, "apelido": nome.split("_", 1)[-1].capitalize()})
        sys.stdout.write(json.dumps(lista, ensure_ascii=True))
        return

    import soundfile as sf

    with open(a.texto, "r", encoding="utf-8") as f:
        texto = f.read().strip()
    if not texto:
        sys.exit("texto vazio")
    cod = IDIOMAS.get(a.voz[0], ("en-us", ""))[0]
    velocidade = min(2.0, max(0.5, a.velocidade))
    amostras, taxa = k.create(texto, voice=a.voz, speed=velocidade, lang=cod)
    sf.write(a.saida, amostras, taxa)
    print(f"ok {len(amostras) / taxa:.1f}s {taxa}Hz")


if __name__ == "__main__":
    main()
