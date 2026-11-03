"""Fala com a voz clonada (Chatterbox). Roda no ambiente clone-env.

Ouve uma gravação curta da pessoa (5 a 20 s) e lê o texto com a voz e o jeito de falar dela.
Inglês usa o modelo original (o melhor em inglês); os outros idiomas usam o multilíngue.

python clonar.py --texto arquivo.txt --referencia voz.wav --lingua en --saida fala.wav
"""
import argparse
import os
import re
import sys


def frases(texto, limite=250):
    """Quebra o texto em trechos curtos: o modelo se perde em trechos longos."""
    partes = []
    for bloco in re.split(r'\n\s*\n|\n', texto):
        bloco = bloco.strip()
        if not bloco:
            continue
        atual = ''
        for f in re.split(r'(?<=[.!?…;])\s+', bloco):
            if atual and len(atual) + len(f) + 1 > limite:
                partes.append(atual)
                atual = f
            else:
                atual = (atual + ' ' + f).strip()
            while len(atual) > limite:
                corte = atual.rfind(',', 0, limite)
                if corte < limite // 3:
                    corte = atual.rfind(' ', 0, limite)
                if corte <= 0:
                    corte = limite
                partes.append(atual[:corte + 1].strip())
                atual = atual[corte + 1:].strip()
        if atual:
            partes.append(atual)
    return partes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--texto', required=True)
    ap.add_argument('--referencia', required=True)
    ap.add_argument('--lingua', default='en')
    ap.add_argument('--saida', required=True)
    ap.add_argument('--exagero', type=float, default=0.5)   # emoção: 0.25 calmo, 0.5 normal, 1.0 bem expressivo
    ap.add_argument('--cfg', type=float, default=0.5)       # mais baixo = fala mais lenta e cuidadosa
    ap.add_argument('--semente', type=int, default=0)
    ap.add_argument('--modelos', help='pasta onde os modelos ficam guardados')
    a = ap.parse_args()

    if a.modelos:
        os.environ['HF_HOME'] = a.modelos
    import numpy as np
    import soundfile as sf
    import torch

    texto = open(a.texto, encoding='utf-8').read()
    trechos = frases(texto)
    if not trechos:
        sys.exit('texto vazio')
    if not os.path.exists(a.referencia):
        sys.exit('gravação de referência não encontrada: ' + a.referencia)

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('carregando o modelo (' + dev + ')...', flush=True)
    if a.lingua == 'en':
        from chatterbox.tts import ChatterboxTTS
        modelo = ChatterboxTTS.from_pretrained(device=dev)
        gerar = lambda t: modelo.generate(t, audio_prompt_path=a.referencia, exaggeration=a.exagero, cfg_weight=a.cfg)
    else:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        modelo = ChatterboxMultilingualTTS.from_pretrained(device=dev)
        gerar = lambda t: modelo.generate(t, language_id=a.lingua, audio_prompt_path=a.referencia,
                                          exaggeration=a.exagero, cfg_weight=a.cfg)

    torch.manual_seed(a.semente)
    pedacos = []
    pausa = np.zeros(int(modelo.sr * 0.25), dtype=np.float32)
    for i, t in enumerate(trechos, 1):
        print('trecho %d/%d' % (i, len(trechos)), flush=True)
        with torch.inference_mode():
            wav = gerar(t)
        pedacos.append(wav.squeeze(0).detach().cpu().numpy().astype(np.float32))
        pedacos.append(pausa)
    audio = np.concatenate(pedacos[:-1])
    pico = float(np.max(np.abs(audio))) or 1.0
    if pico > 0.99:
        audio = audio / pico * 0.99
    sf.write(a.saida, audio, modelo.sr)
    print('ok', a.saida, flush=True)


if __name__ == '__main__':
    main()
